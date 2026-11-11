import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// `ocelot serve <path.ocelot>`: the headless host (`editor/e2e/headless-host.mjs`, Node + Chromium) without a container.
/// Runs in the foreground, registers a `headless` record in the run directory and removes it on exit.
enum OcelotServeCommand {
    static let usage = """
    Usage: ocelot serve <path.ocelot> [--create] [--port N] [--idle-stop-min N] [--json]

    Serves one project over MCP from a headless Chromium on this Mac (no container, no app window).
    Needs Node 22+ and a built editor (cd editor && bun run build). Press Ctrl-C to stop; the document is saved on every edit.
    Set OCELOT_REPO to the Ocelot checkout if `ocelot` is not run from inside it.
    """

    struct Options: Equatable {
        var path = ""
        var create = false
        var port = 0
        var idleStopMinutes = 0
        var json = false
    }

    static func parse(_ arguments: [String]) throws -> Options {
        var options = Options()
        var positional: [String] = []
        var index = 0
        func value(_ flag: String) throws -> String {
            index += 1
            guard index < arguments.count else { throw ContainerError.usage("\(flag) needs a value.\n\(usage)") }
            return arguments[index]
        }
        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--create": options.create = true
            case "--json": options.json = true
            case "--port":
                guard let port = Int(try value(argument)), (0...65535).contains(port) else { throw ContainerError.usage("--port takes 0-65535 (0 picks a free port).") }
                options.port = port
            case "--idle-stop-min":
                guard let minutes = Int(try value(argument)), minutes >= 0 else { throw ContainerError.usage("--idle-stop-min takes whole minutes (0 disables).") }
                options.idleStopMinutes = minutes
            case "-h", "--help": throw ContainerError.usage(usage)
            default:
                if argument.hasPrefix("-") { throw ContainerError.usage("Unknown option \(argument).\n\(usage)") }
                positional.append(argument)
            }
            index += 1
        }
        guard positional.count == 1 else { throw ContainerError.usage(usage) }
        options.path = positional[0]
        return options
    }

    /// Finds `editor/e2e/headless-host.mjs`: `OCELOT_HEADLESS_HOST` (the script itself), `OCELOT_REPO`, then every ancestor of
    /// the binary and of the working directory.
    static func locateHostScript(environment: [String: String], startingPoints: [String]) -> String? {
        let relative = "editor/e2e/headless-host.mjs"
        if let explicit = environment["OCELOT_HEADLESS_HOST"], FileManager.default.fileExists(atPath: explicit) { return explicit }
        var candidates: [String] = []
        if let repo = environment["OCELOT_REPO"] { candidates.append(repo) }
        for start in startingPoints {
            var url = URL(fileURLWithPath: start).standardized
            for _ in 0..<12 {
                candidates.append(url.path)
                let parent = url.deletingLastPathComponent()
                if parent.path == url.path { break }
                url = parent
            }
        }
        return candidates.map { "\($0)/\(relative)" }.first { FileManager.default.fileExists(atPath: $0) }
    }

    /// `OCELOT_NODE`, then PATH and the usual install locations, then nvm (newest first).
    static func locateNode(environment: [String: String], detector: BackendDetector = BackendDetector()) -> String? {
        if let explicit = environment["OCELOT_NODE"], FileManager.default.isExecutableFile(atPath: explicit) { return explicit }
        if let found = detector.find("node") { return found }
        let home = environment["HOME"] ?? NSHomeDirectory()
        let nvm = "\(home)/.nvm/versions/node"
        let versions = ((try? FileManager.default.contentsOfDirectory(atPath: nvm)) ?? []).sorted { $0.compare($1, options: .numeric) == .orderedDescending }
        return versions.map { "\(nvm)/\($0)/bin/node" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static func run(_ arguments: [String], runner: ContainerRunner = ContainerRunner(), output: RunOutput = .standard) -> Int32 {
        do {
            let options = try parse(arguments)
            return try serve(options, runner: runner, output: output)
        } catch let error as ContainerError {
            if case .usage(let text) = error { output.err(text); return 2 }
            output.err("ocelot serve: \(error.localizedDescription)")
            return 1
        } catch {
            output.err("ocelot serve: \(error.localizedDescription)")
            return 1
        }
    }

    private static func serve(_ options: Options, runner: ContainerRunner, output: RunOutput) throws -> Int32 {
        let environment = ProcessInfo.processInfo.environment
        let path = canonicalPath((options.path as NSString).expandingTildeInPath)
        try runner.validatePackage(path: path, create: options.create)

        guard let script = locateHostScript(environment: environment, startingPoints: [CommandLine.arguments.first ?? "", FileManager.default.currentDirectoryPath]) else {
            throw ContainerError.commandFailed("ocelot serve", "cannot find editor/e2e/headless-host.mjs. Run `ocelot serve` from the Ocelot checkout or set OCELOT_REPO=<path to the checkout>.")
        }
        guard FileManager.default.fileExists(atPath: URL(fileURLWithPath: script).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("dist/index.html").path) else {
            throw ContainerError.commandFailed("ocelot serve", "the editor is not built. Run `cd \(URL(fileURLWithPath: script).deletingLastPathComponent().deletingLastPathComponent().path) && bun install --frozen-lockfile && bun run build`, then rerun.")
        }
        guard let node = locateNode(environment: environment) else {
            throw ContainerError.commandFailed("ocelot serve", "Node 22+ was not found. Install it (brew install node) or set OCELOT_NODE=<path to node>.")
        }

        // Single writer: a window, another headless host or a running container may already own this package.
        var runtime: ContainerRuntime?
        if runner.allRecords().contains(where: { $0.kind == .container && $0.projects.contains { $0.path.map(canonicalPath) == path } }) {
            runtime = (try? runner.detector.detect()).map { ContainerRuntime(backend: $0, runner: runner.runner) }
        }
        try runner.runDirectory.prepare()
        try runner.enforceSingleWriter(path: path, projectId: ContainerRunner.readProjectId(packagePath: path), runtime: runtime)

        let token = runner.makeToken()
        var hostEnvironment = environment
        hostEnvironment["OCELOT_PROJECT_TOKEN"] = token
        var hostArguments = [script, "--doc", path, "--port", "\(options.port)", "--token-env", "OCELOT_PROJECT_TOKEN", "--no-discovery"]
        if options.idleStopMinutes > 0 { hostArguments += ["--idle-stop-min", "\(options.idleStopMinutes)"] }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = hostArguments
        process.environment = hostEnvironment
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.standardError
        let stdout = Pipe()
        process.standardOutput = stdout
        let ready = ReadyLine()
        stdout.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; ready.finish(); return }
            ready.append(data)
        }
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in ready.finish(); exited.signal() }
        do { try process.run() } catch {
            throw ContainerError.commandFailed("node \(URL(fileURLWithPath: script).lastPathComponent)", "could not start \(node): \(error.localizedDescription)")
        }

        // Forward Ctrl-C / SIGTERM to the host so it saves the document before exiting.
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        let sources = [SIGINT, SIGTERM].map { number -> DispatchSourceSignal in
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { if process.isRunning { kill(process.processIdentifier, SIGTERM) } }
            source.resume()
            return source
        }
        defer { sources.forEach { $0.cancel() } }

        guard let url = ready.wait(timeout: 120), let port = URL(string: url)?.port else {
            if process.isRunning { process.terminate() }
            _ = exited.wait(timeout: .now() + 5)
            throw ContainerError.commandFailed("ocelot serve", "the headless host did not start (see its output above). Check that `bun run build` has run in editor/ and that Chromium is installed (`bunx playwright install chromium`).")
        }
        guard let health = runner.probe.probe(port: port), let projectId = health.projectId ?? ContainerRunner.readProjectId(packagePath: path) else {
            if process.isRunning { process.terminate() }
            _ = exited.wait(timeout: .now() + 5)
            throw ContainerError.commandFailed("ocelot serve", "the host started but did not report a project id. Rebuild the editor (cd editor && bun run build) and rerun.")
        }
        let projectName = ContainerRunner.readProjectName(packagePath: path) ?? URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
        let instance = "headless-\(process.processIdentifier)"
        try runner.runDirectory.writeToken(token, instance: instance)
        try runner.runDirectory.publish(InstanceRecord(
            instance: instance, kind: .headless, pid: Int(process.processIdentifier), started: ISO8601DateFormatter().string(from: runner.now()),
            http: "http://127.0.0.1:\(port)", projects: [RunProject(id: projectId, name: projectName, path: path, windowId: nil)]
        ))
        defer { runner.runDirectory.remove(instance: instance) }

        let tokenFile = runner.runDirectory.tokenURL(instance).path
        if options.json {
            let object: [String: Any] = ["instance": instance, "pid": Int(process.processIdentifier), "projectId": projectId, "name": projectName,
                                         "path": path, "url": "http://127.0.0.1:\(port)/mcp", "token": token, "tokenFile": tokenFile]
            let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
            output.out(String(decoding: data, as: UTF8.self))
        } else {
            var lines = [
                "\"\(projectName)\" is served by a headless host (pid \(process.processIdentifier)).",
                "  project id   \(projectId)",
                "  package      \(path)",
                "  endpoint     http://127.0.0.1:\(port)/mcp   (loopback only; token in \(tokenFile))",
            ]
            lines += OcelotRunCommands.connectLines(projectId: projectId, projectName: projectName, url: "http://127.0.0.1:\(port)/mcp", token: token, tokenFile: tokenFile,
                                                     command: CLICommand.forRunningTool(), httpVia: "straight to the host")
            lines += ["", "Press Ctrl-C to stop (the document is saved on every edit)."]
            output.out(lines.joined(separator: "\n"))
        }

        exited.wait()
        return process.terminationStatus
    }

    /// Collects the host's stdout and extracts the readiness line (`{"url":"http://127.0.0.1:<port>/mcp","ready":true}`).
    private final class ReadyLine: @unchecked Sendable {
        private let lock = NSLock()
        private let semaphore = DispatchSemaphore(value: 0)
        private var buffer = ""
        private var url: String?
        private var signalled = false

        func append(_ data: Data) {
            lock.lock(); defer { lock.unlock() }
            buffer += String(decoding: data, as: UTF8.self)
            guard url == nil else { return }
            for line in buffer.split(separator: "\n") {
                guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], let found = object["url"] as? String else { continue }
                url = found
                signal()
                return
            }
        }

        func finish() {
            lock.lock(); defer { lock.unlock() }
            signal()
        }

        private func signal() {
            if !signalled { signalled = true; semaphore.signal() }
        }

        func wait(timeout: TimeInterval) -> String? {
            _ = semaphore.wait(timeout: .now() + timeout)
            lock.lock(); defer { lock.unlock() }
            return url
        }
    }
}
