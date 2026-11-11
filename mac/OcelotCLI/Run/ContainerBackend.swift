import Foundation
#if canImport(Darwin)
import Darwin
#endif

// Container runtime detection and process plumbing for `ocelot run`.
// Foundation-only and self-contained: nothing here depends on the app or on other CLI code.

enum ContainerRuntimeKind: String, Sendable, Codable {
    /// Apple's `container` (one lightweight VM per container; macOS 26+, Apple silicon).
    case container
    case docker
}

struct ContainerBackend: Sendable, Equatable {
    var kind: ContainerRuntimeKind
    /// Absolute path of the CLI binary.
    var executable: String
}

/// Errors carry the remedy: every message says what to do next.
enum ContainerError: LocalizedError, Equatable {
    case noRuntime
    case dockerDaemonDown(String)
    case appleContainerNotStarted
    case runtimeUnavailable(ContainerRuntimeKind)
    case imageMissing(String, ContainerRuntimeKind)
    case notAnOcelotPackage(String)
    case alreadyHosted(project: String, where: String, hint: String)
    case startFailed(String)
    case notHealthy(String)
    case commandFailed(String, String)
    case timedOut(String)
    case noSuchContainer(String)
    case unsupportedPath(String)
    case usage(String)

    var errorDescription: String? {
        switch self {
        case .noRuntime:
            "No container runtime found. Install Docker (OrbStack, Docker Desktop or Colima) or Apple's `container` (macOS 26+, https://github.com/apple/container), then rerun. To run without a container use `ocelot serve <path.ocelot>`."
        case .dockerDaemonDown(let detail):
            "The Docker daemon is not running\(detail.isEmpty ? "" : " (\(detail))"). Start it (open Docker Desktop or OrbStack, or run `colima start`), wait until `docker info` succeeds, then rerun."
        case .appleContainerNotStarted:
            "Apple's `container` is installed but its system service is not running. Run `container system start`, then rerun."
        case .runtimeUnavailable(let kind):
            "The \(kind.rawValue) runtime you asked for (OCELOT_CONTAINER_RUNTIME or --runtime) is not available. Install it, start it, or drop the override so Ocelot picks one."
        case .imageMissing(let image, let kind):
            "The image \(image) is not available in \(kind.rawValue). Build it from the Ocelot repo with `make container` (or `scripts/build-container.sh`), or pass --image <ref> / set OCELOT_CONTAINER_IMAGE."
        case .notAnOcelotPackage(let path):
            "\(path) is not an Ocelot package (a directory ending in .ocelot, or .atelier from earlier releases, containing document.json). Pass an existing project, or add --create to start a new .ocelot one there."
        case .alreadyHosted(let project, let place, let hint):
            "\(project) is already open in \(place), and a project has exactly one writer. \(hint)"
        case .startFailed(let detail):
            "The container could not be started: \(detail)"
        case .notHealthy(let logs):
            "The container started but never became healthy within the timeout. It has been removed. Last output:\n\(logs)"
        case .commandFailed(let command, let detail):
            "`\(command)` failed: \(detail)"
        case .timedOut(let command):
            "`\(command)` did not finish in time. Check that the container runtime is responsive, then rerun."
        case .noSuchContainer(let target):
            "No Ocelot container matches \"\(target)\". Run `ocelot ls` to see running projects (kind \"container\")."
        case .unsupportedPath(let path):
            "Cannot bind-mount \(path): Apple's `container` mount syntax cannot carry a comma in the path. Move or rename the package."
        case .usage(let text):
            text
        }
    }
}

struct CommandResult: Sendable, Equatable {
    var status: Int32
    var stdout: String
    var stderr: String
    var succeeded: Bool { status == 0 }
    /// First non-empty line of stderr, then stdout: what to show a user.
    var summary: String {
        let text = stderr.isEmpty ? stdout : stderr
        return text.split(whereSeparator: \.isNewline).map(String.init).first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) ?? "exit status \(status)"
    }
}

protocol CommandRunning: Sendable {
    func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) throws -> CommandResult
}

/// Runs a child process to completion with a deadline. Output goes through temp files so a chatty child can never fill a pipe and deadlock.
struct ProcessRunner: CommandRunning {
    func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) throws -> CommandResult {
        let display = ([URL(fileURLWithPath: executable).lastPathComponent] + arguments.prefix(2)).joined(separator: " ")
        let directory = FileManager.default.temporaryDirectory
        let id = UUID().uuidString
        let outURL = directory.appendingPathComponent("ocelot-\(id).out")
        let errURL = directory.appendingPathComponent("ocelot-\(id).err")
        FileManager.default.createFile(atPath: outURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        FileManager.default.createFile(atPath: errURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        defer {
            try? FileManager.default.removeItem(at: outURL)
            try? FileManager.default.removeItem(at: errURL)
        }
        let outHandle = try FileHandle(forWritingTo: outURL)
        let errHandle = try FileHandle(forWritingTo: errURL)
        defer {
            try? outHandle.close()
            try? errHandle.close()
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = outHandle
        process.standardError = errHandle
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        do {
            try process.run()
        } catch {
            throw ContainerError.commandFailed(display, "could not launch \(executable): \(error.localizedDescription)")
        }
        if finished.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            _ = finished.wait(timeout: .now() + 2)
            throw ContainerError.timedOut(display)
        }
        let out = (try? String(contentsOf: outURL, encoding: .utf8)) ?? ""
        let err = (try? String(contentsOf: errURL, encoding: .utf8)) ?? ""
        return CommandResult(status: process.terminationStatus, stdout: out, stderr: err)
    }
}

/// Picks the runtime: Apple `container` when installed, supported and started, else Docker.
struct BackendDetector: Sendable {
    var runner: CommandRunning = ProcessRunner()
    var environment: [String: String] = ProcessInfo.processInfo.environment
    var osMajorVersion: Int = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
    var fileIsExecutable: @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }

    /// GUI-launched processes have a minimal PATH, so look in the usual install locations too.
    static func searchPaths(environment: [String: String], home: String) -> [String] {
        let fromPath = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
        let extra = [
            "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin",
            "\(home)/.orbstack/bin", "\(home)/.colima/bin", "\(home)/.rd/bin",
            "/Applications/Docker.app/Contents/Resources/bin",
        ]
        var seen = Set<String>()
        return (fromPath + extra).filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    func find(_ name: String) -> String? {
        let home = environment["HOME"] ?? NSHomeDirectory()
        for directory in Self.searchPaths(environment: environment, home: home) {
            let candidate = "\(directory)/\(name)"
            if fileIsExecutable(candidate) { return candidate }
        }
        return nil
    }

    func detect(preferred: ContainerRuntimeKind? = nil) throws -> ContainerBackend {
        let requested = preferred ?? environment["OCELOT_CONTAINER_RUNTIME"].flatMap(ContainerRuntimeKind.init(rawValue:))
        var appleNeedsStart = false

        if requested != .docker, osMajorVersion >= 26, let apple = find("container") {
            let status = try? runner.run(apple, ["system", "status"], timeout: 15)
            if status?.succeeded == true { return ContainerBackend(kind: .container, executable: apple) }
            appleNeedsStart = true
        }
        if requested != .container, let docker = find("docker") {
            let info = try runner.run(docker, ["info", "--format", "{{.ServerVersion}}"], timeout: 20)
            if info.succeeded { return ContainerBackend(kind: .docker, executable: docker) }
            // A Docker CLI with a stopped daemon is the common failure: say so rather than "not found".
            if !appleNeedsStart { throw ContainerError.dockerDaemonDown(info.summary) }
        }
        if appleNeedsStart { throw ContainerError.appleContainerNotStarted }
        if let requested { throw ContainerError.runtimeUnavailable(requested) }
        throw ContainerError.noRuntime
    }
}
