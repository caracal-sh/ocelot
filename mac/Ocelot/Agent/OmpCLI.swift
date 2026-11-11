import Foundation

/// The user's omp install: where it is and the environment it needs (a GUI app starts with a minimal PATH).
struct OmpCLI: Sendable {
    let path: String
    let environment: [String: String]

    /// Absolute path with symlinks resolved. The sandbox grants access to real paths only.
    var resolvedPath: String { URL(fileURLWithPath: path).resolvingSymlinksInPath().path }

    struct Captured: Sendable {
        let status: Int32
        let stdout: String
    }

    /// Runs `omp <args>` to completion (or `timeout`) off the main actor.
    func capture(_ args: [String], timeout: TimeInterval, environment extra: [String: String] = [:]) async -> Captured? {
        let cli = self
        return await Task.detached {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: cli.path)
            p.arguments = args
            p.environment = cli.environment.merging(extra) { _, new in new }
            p.currentDirectoryURL = try? OmpCLI.agentDirectory()
            return OmpCLI.runProcess(p, timeout: timeout)
        }.value
    }

    /// The directory the sandboxed agent uses as TMPDIR. omp unpacks a small helper dylib (`omp-applefm-<hash>.dylib`) there and
    /// loads it at startup; files a sandboxed process writes are quarantined and Gatekeeper then refuses to load them. omp reuses
    /// an existing file, so the unsandboxed app unpacks it once per omp version (this method) and the sandbox only reads it.
    func prepareAgentTemporaryDirectory(version: String) async throws -> URL {
        let cli = self
        return try await Task.detached {
            let dir = try OmpCLI.agentDirectory().appendingPathComponent("tmp", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let marker = dir.appendingPathComponent("seeded-\(version)")
            if FileManager.default.fileExists(atPath: marker.path) { return dir }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: cli.path)
            p.arguments = ["--mode", "rpc", "--no-session", "--no-tools", "--no-skills", "--no-rules", "--no-context-files", "--no-extensions", "--no-lsp", "--no-title", "--model", "apple/on-device"]
            p.environment = cli.environment.merging(["TMPDIR": dir.path]) { _, new in new }
            p.currentDirectoryURL = dir
            let stdin = Pipe()
            p.standardInput = stdin
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try p.run()
            try? stdin.fileHandleForWriting.write(contentsOf: Data("{\"type\":\"prompt\",\"message\":\"hi\"}\n".utf8))
            let deadline = Date().addingTimeInterval(40)
            func unpacked() -> Bool { ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).contains { $0.hasPrefix("omp-applefm-") } }
            while Date() < deadline, !unpacked(), p.isRunning { try await Task.sleep(for: .milliseconds(200)) }
            try await Task.sleep(for: .milliseconds(500))
            try? stdin.fileHandleForWriting.close()
            if p.isRunning { p.terminate() }
            if unpacked() { try Data().write(to: marker) }
            return dir
        }.value
    }

    /// `~/Library/Application Support/Ocelot/Agent`: the gateway's home, sign-in script, unconfined working dirs.
    static func agentDirectory() throws -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let dir = base.appendingPathComponent("Ocelot/Agent", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// GUI apps start with a minimal PATH, so ask the user's login shell where
    /// `omp` is (and for its PATH, which omp's tools and MCP servers may need).
    static func locate() -> OmpCLI? {
        let env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var path = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        var candidates: [String] = []
        if let explicit = env["OCELOT_OMP_PATH"] { candidates.append(explicit) }

        let shell = env["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        let marker = "__OCELOT__"
        if let probe = runSync(shell, ["-l", "-i", "-c", #"printf '\#(marker)%s\n\#(marker)%s\n' "$PATH" "$(command -v omp)""#], env: env, timeout: 5) {
            let values = probe.split(separator: "\n").filter { $0.hasPrefix(marker) }.map { String($0.dropFirst(marker.count)) }
            if values.count == 2 {
                if !values[0].isEmpty { path = values[0] }
                if values[1].hasPrefix("/") { candidates.append(values[1]) }
            }
        }
        candidates += [
            "\(home)/.bun/bin/omp",
            "\(home)/.local/bin/omp",
            "/opt/homebrew/bin/omp",
            "/usr/local/bin/omp",
        ]
        guard let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { return nil }
        let dir = (found as NSString).deletingLastPathComponent
        var environment = env
        environment["PATH"] = ([dir] + path.split(separator: ":").map(String.init) + ["/opt/homebrew/bin", "/usr/local/bin"])
            .reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
            .joined(separator: ":")
        return OmpCLI(path: found, environment: environment)
    }

    static func runSync(_ path: String, _ args: [String], env: [String: String], timeout: TimeInterval) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.environment = env
        guard let r = runProcess(p, timeout: timeout), r.status == 0 else { return nil }
        return r.stdout
    }

    /// Runs to completion (or `timeout`) and returns stdout. Blocking: call off the main actor.
    private static func runProcess(_ p: Process, timeout: TimeInterval) -> Captured? {
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let deadline = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        deadline.cancel()
        return Captured(status: p.terminationStatus, stdout: String(decoding: data, as: UTF8.self))
    }
}

/// Finds omp once and remembers it until a check fails. Under XCTest it finds nothing: locating omp starts the user's
/// login shell, and everything behind it (the broker, the gateway, agent processes) is the user's own environment.
@MainActor
final class OmpLocator {
    static let shared = OmpLocator()
    private var cached: OmpCLI?

    func cli() async -> OmpCLI? {
        if AppEnvironment.underTest { return nil }
        if let cached { return cached }
        let found = await Task.detached { OmpCLI.locate() }.value
        cached = found
        return found
    }

    func forget() { cached = nil }
}
