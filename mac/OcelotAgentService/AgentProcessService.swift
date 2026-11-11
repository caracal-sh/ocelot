import Darwin
import Foundation
import XPC

/// One app connection's agent processes. Runs inside the App Sandbox, so omp (a child) inherits it:
/// it can read its own container, the omp install directory the entitlements allow, and system
/// libraries; nothing of the user's home. Keeps an XPC transaction open while omp runs (otherwise
/// launchd may reap an "idle" service mid-conversation) and kills omp when the connection ends.
final class AgentProcessService: NSObject, OcelotAgentServiceProtocol, @unchecked Sendable {
    private struct Session {
        let process: Process
        let stdin: FileHandle
        let directory: URL
    }

    private let connection: NSXPCConnection
    private let lock = NSLock()
    private var sessions: [String: Session] = [:]

    init(connection: NSXPCConnection) {
        self.connection = connection
    }

    private var client: OcelotAgentClientProtocol? {
        connection.remoteObjectProxy as? OcelotAgentClientProtocol
    }

    // MARK: - OcelotAgentServiceProtocol

    func start(_ request: Data, reply: @escaping @Sendable (String?) -> Void) {
        do {
            let start = try JSONDecoder().decode(AgentServiceStart.self, from: request)
            try launch(start)
            reply(nil)
        } catch {
            reply((error as? AgentLaunch.Failure)?.message ?? error.localizedDescription)
        }
    }

    func send(sessionId: String, line: Data) {
        lock.lock()
        let session = sessions[sessionId]
        lock.unlock()
        try? session?.stdin.write(contentsOf: line)
    }

    func stop(sessionId: String) {
        lock.lock()
        let session = sessions[sessionId]
        lock.unlock()
        guard let session else { return }
        terminate(session)
    }

    func stopAll() {
        lock.lock()
        let all = Array(sessions.values)
        lock.unlock()
        for session in all { terminate(session) }
    }

    func selfTest(userFolders: Bool, reply: @escaping @Sendable (Data) -> Void) {
        // Off the connection's queue: a slow probe must not hold up `send`/`start` of running agents.
        DispatchQueue.global().async {
            let results = AgentSelfTest.run(userFolders: userFolders)
            reply((try? JSONEncoder().encode(results)) ?? Data("[]".utf8))
        }
    }

    // MARK: - Processes

    private func launch(_ start: AgentServiceStart) throws {
        guard start.sessionId.range(of: #"^[A-Za-z0-9-]{1,64}$"#, options: .regularExpression) != nil else {
            throw AgentLaunch.Failure("Invalid agent session id.")
        }
        let omp = start.ompPath
        guard omp.hasPrefix("/"), (omp as NSString).lastPathComponent == "omp" else {
            throw AgentLaunch.Failure("The sandboxed agent only runs omp. Reinstall omp, or turn on \"Run agent unconfined\" in Settings > Agent.")
        }
        guard access(omp, X_OK) == 0 else {
            throw AgentLaunch.Failure("The sandboxed agent cannot run omp at \(omp). Install omp under ~/.bun, ~/.local/bin, /opt/homebrew or /usr/local (for example \"bun install -g @oh-my-pi/pi-coding-agent\"), or turn on \"Run agent unconfined\" in Settings > Agent.")
        }
        lock.lock()
        let running = sessions[start.sessionId] != nil
        lock.unlock()
        if running { throw AgentLaunch.Failure("This agent session is already running.") }

        let home = NSHomeDirectory() // the service's container: omp's private ~/.omp (extracted natives, caches) lives here
        let sessionsRoot = URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/OcelotAgent/sessions", isDirectory: true)
        let directory = sessionsRoot.appendingPathComponent(start.sessionId, isDirectory: true)
        let agentDir = directory.appendingPathComponent("agent", isDirectory: true)
        // Owner-only, like the run directory: nothing a session writes is world-readable. (The sandbox is shared by
        // every session, so secrets never go to disk here: the MCP token is in omp's environment, not `.mcp.json`.)
        try FileManager.default.createDirectory(at: agentDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: sessionsRoot.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let configFile = directory.appendingPathComponent("config.yml")
        let promptFile = directory.appendingPathComponent("system-prompt.md")
        try start.modelsYml.write(to: agentDir.appendingPathComponent("models.yml"), atomically: true, encoding: .utf8)
        try start.overlay.write(to: configFile, atomically: true, encoding: .utf8)
        try start.systemPrompt.write(to: promptFile, atomically: true, encoding: .utf8)
        try start.mcpConfig.write(to: directory.appendingPathComponent(".mcp.json"), atomically: true, encoding: .utf8)

        try linkNatives(home: home)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: omp)
        process.arguments = AgentLaunch.ompArguments(configFile: configFile.path, systemPromptFile: promptFile.path, model: start.model, thinking: start.thinking)
        process.environment = AgentLaunch.confinedEnvironment(home: home, agentDir: agentDir.path, temporaryDirectory: try temporaryDirectory(start.temporaryDirectory), token: start.gatewayToken, mcpToken: start.mcpToken)
        process.currentDirectoryURL = directory
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        let sessionId = start.sessionId
        let drained = DispatchGroup()
        let stderrTail = TailBuffer(limit: 4000)
        drained.enter() // stdout EOF
        drained.enter() // stderr EOF
        drained.enter() // process exit
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                drained.leave()
            } else {
                self?.client?.output(sessionId: sessionId, data: data)
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                drained.leave()
            } else {
                stderrTail.append(data)
            }
        }
        process.terminationHandler = { _ in drained.leave() }
        drained.notify(queue: .global()) { [weak self] in
            // Whatever became of the service object, the transaction ends and the session's files go.
            defer { xpc_transaction_end() }
            try? FileManager.default.removeItem(at: directory)
            guard let self else { return }
            lock.lock()
            sessions.removeValue(forKey: sessionId)
            lock.unlock()
            client?.exited(sessionId: sessionId, status: process.terminationStatus, stderr: stderrTail.string)
        }

        xpc_transaction_begin()
        do {
            try process.run()
        } catch {
            xpc_transaction_end()
            try? FileManager.default.removeItem(at: directory)
            throw AgentLaunch.Failure("The sandboxed agent could not start omp: \(error.localizedDescription)")
        }
        lock.lock()
        sessions[sessionId] = Session(process: process, stdin: stdin.fileHandleForWriting, directory: directory)
        lock.unlock()
    }

    /// omp loads `<HOME>/.omp/natives/<version>/pi_natives.*.node`. A sandboxed process cannot extract it itself: files it
    /// writes are quarantined and Gatekeeper refuses to load unsigned code from them. The app (unsandboxed) already ran omp,
    /// which extracted the addon into the real `~/.omp/natives`; the entitlements make exactly that directory readable
    /// (not `~/.omp/agent`, where the credentials are), and the container's `.omp/natives` points at it.
    private func linkNatives(home: String) throws {
        let real = AgentSelfTest.realHomeDirectory() + "/.omp/natives"
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: real, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw AgentLaunch.Failure("omp has not unpacked its native addon yet. Run \"omp models\" once in a terminal, then try again.")
        }
        let dot = URL(fileURLWithPath: home).appendingPathComponent(".omp", isDirectory: true)
        try FileManager.default.createDirectory(at: dot, withIntermediateDirectories: true)
        let link = dot.appendingPathComponent("natives")
        if let current = try? FileManager.default.destinationOfSymbolicLink(atPath: link.path), current == real { return }
        try? FileManager.default.removeItem(at: link)
        try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: real)
    }

    /// The app's agent TMPDIR, only if it is where the entitlements allow writing.
    private func temporaryDirectory(_ requested: String) throws -> String {
        let allowed = AgentSelfTest.realHomeDirectory() + "/Library/Application Support/Ocelot/Agent/tmp"
        guard requested == allowed else { throw AgentLaunch.Failure("The agent temporary directory must be \(allowed).") }
        return requested
    }

    private func terminate(_ session: Session) {
        try? session.stdin.close() // omp drains and exits on EOF
        let process = session.process
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            if process.isRunning { process.terminate() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 4) {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }
}

/// Last `limit` bytes of a stream, safe to append from a readability handler.
private final class TailBuffer: @unchecked Sendable {
    private let limit: Int
    private let lock = NSLock()
    private var data = Data()

    init(limit: Int) { self.limit = limit }

    func append(_ chunk: Data) {
        lock.lock()
        data.append(chunk)
        if data.count > limit { data = data.suffix(limit) }
        lock.unlock()
    }

    var string: String {
        lock.lock()
        defer { lock.unlock() }
        return String(decoding: data, as: UTF8.self)
    }
}
