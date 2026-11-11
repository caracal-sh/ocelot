import Foundation

/// One ordered stream of output events from an agent process, consumed on the main actor.
enum AgentChunk: Sendable {
    case stdout(Data)
    case stderr(Data)
    case stdoutClosed
    case exit(Int32)
}

/// A running agent process, wherever it lives (sandboxed XPC service or a child of the app).
@MainActor
protocol AgentProcessHandle: AnyObject {
    var isRunning: Bool { get }
    func write(_ line: Data) throws
    /// Closes omp's stdin: it drains and exits on EOF.
    func closeInput()
    func terminate()
}

/// Unconfined mode: omp as a child of the app with the user's own environment (explicit opt-in in Settings).
@MainActor
final class LocalAgentProcess: AgentProcessHandle {
    private let process: Process
    private let stdin: FileHandle

    private init(process: Process, stdin: FileHandle) {
        self.process = process
        self.stdin = stdin
    }

    static func spawn(_ cli: OmpCLI, arguments: [String], directory: URL, sink: AsyncStream<AgentChunk>.Continuation) throws -> LocalAgentProcess {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: cli.path)
        process.arguments = arguments
        process.environment = cli.environment
        process.currentDirectoryURL = directory
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                sink.yield(.stdoutClosed)
            } else {
                sink.yield(.stdout(data))
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { sink.yield(.stderr(data)) }
        }
        process.terminationHandler = { p in sink.yield(.exit(p.terminationStatus)) }
        do {
            try process.run()
        } catch {
            sink.finish()
            throw BridgeFailure(.internal, "Could not start omp at \(cli.path): \(error.localizedDescription)")
        }
        return LocalAgentProcess(process: process, stdin: stdin.fileHandleForWriting)
    }

    var isRunning: Bool { process.isRunning }

    func write(_ line: Data) throws { try stdin.write(contentsOf: line) }

    func closeInput() { try? stdin.close() }

    func terminate() { if process.isRunning { process.terminate() } }
}

/// Confined mode: omp runs inside the sandboxed XPC service; this is the app's view of one session.
@MainActor
final class XPCAgentProcess: AgentProcessHandle {
    private let sessionId: String
    private let connection: AgentServiceConnection
    private(set) var isRunning = true

    fileprivate init(sessionId: String, connection: AgentServiceConnection) {
        self.sessionId = sessionId
        self.connection = connection
    }

    static func start(_ request: AgentServiceStart, sink: AsyncStream<AgentChunk>.Continuation) async throws -> XPCAgentProcess {
        let connection = AgentServiceConnection.shared
        connection.register(sessionId: request.sessionId, sink: sink)
        do {
            let payload = try JSONEncoder().encode(request)
            try await connection.start(payload)
        } catch {
            connection.unregister(sessionId: request.sessionId)
            sink.finish()
            throw error
        }
        return XPCAgentProcess(sessionId: request.sessionId, connection: connection)
    }

    func write(_ line: Data) throws { connection.send(sessionId: sessionId, line: line) }

    func closeInput() { connection.stop(sessionId: sessionId) }

    func terminate() {
        isRunning = false
        connection.stop(sessionId: sessionId)
    }
}

/// The app's single connection to the sandboxed agent service, and the callback object the service talks to.
final class AgentServiceConnection: NSObject, OcelotAgentClientProtocol, @unchecked Sendable {
    static let shared = AgentServiceConnection()

    private let lock = NSLock()
    private var connection: NSXPCConnection?
    private var sinks: [String: AsyncStream<AgentChunk>.Continuation] = [:]

    func register(sessionId: String, sink: AsyncStream<AgentChunk>.Continuation) {
        lock.lock()
        sinks[sessionId] = sink
        lock.unlock()
    }

    func unregister(sessionId: String) {
        lock.lock()
        sinks[sessionId] = nil
        lock.unlock()
    }

    private func proxy(onError: @escaping @Sendable (Error) -> Void) -> OcelotAgentServiceProtocol? {
        lock.lock()
        let existing = connection
        lock.unlock()
        let live = existing ?? makeConnection()
        return live.remoteObjectProxyWithErrorHandler(onError) as? OcelotAgentServiceProtocol
    }

    private func makeConnection() -> NSXPCConnection {
        let connection = NSXPCConnection(serviceName: AgentService.name)
        connection.remoteObjectInterface = NSXPCInterface(with: OcelotAgentServiceProtocol.self)
        connection.exportedInterface = NSXPCInterface(with: OcelotAgentClientProtocol.self)
        connection.exportedObject = self
        // Refuse a service that is not ours (bundled services are app-scoped already; this also pins the identity).
        connection.setCodeSigningRequirement("identifier \"\(AgentService.name)\"")
        connection.invalidationHandler = { [weak self] in self?.connectionEnded("The agent sandbox service stopped.") }
        connection.interruptionHandler = { [weak self] in self?.connectionEnded("The agent sandbox service stopped unexpectedly.") }
        connection.resume()
        lock.lock()
        self.connection = connection
        lock.unlock()
        return connection
    }

    /// The service died or was invalidated: its omp processes are gone; finish every session.
    private func connectionEnded(_ message: String) {
        lock.lock()
        let pending = sinks
        sinks = [:]
        connection = nil
        lock.unlock()
        Self.finish(pending.values, message: message)
    }

    /// Ends every consumer's stream the way a dying service does, so `AgentRunner` reaches its tail
    /// (revoke the window MCP token and the gateway client token, publish `done`).
    private static func finish(_ sinks: some Sequence<AsyncStream<AgentChunk>.Continuation>, message: String) {
        for sink in sinks {
            sink.yield(.stderr(Data(message.utf8)))
            sink.yield(.stdoutClosed)
            sink.yield(.exit(-1))
            sink.finish()
        }
    }

    func start(_ payload: Data) async throws {
        let message: String? = try await withCheckedThrowingContinuation { continuation in
            guard let proxy = proxy(onError: { continuation.resume(throwing: BridgeFailure(.hostUnavailable, Self.unavailable($0))) }) else {
                continuation.resume(throwing: BridgeFailure(.hostUnavailable, Self.unavailable(nil)))
                return
            }
            proxy.start(payload) { continuation.resume(returning: $0) }
        }
        if let message { throw BridgeFailure(.hostUnavailable, message) }
    }

    func send(sessionId: String, line: Data) {
        proxy(onError: { _ in })?.send(sessionId: sessionId, line: line)
    }

    func stop(sessionId: String) {
        proxy(onError: { _ in })?.stop(sessionId: sessionId)
    }

    /// `userFolders`: also probe the user's Documents and Application Support. Off under XCTest, where the unsigned Debug service
    /// is not confined, so reading them would only make macOS ask the user for consent.
    func selfTest(userFolders: Bool = !AppEnvironment.underTest) async throws -> [AgentProbeResult] {
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            guard let proxy = proxy(onError: { continuation.resume(throwing: BridgeFailure(.hostUnavailable, Self.unavailable($0))) }) else {
                continuation.resume(throwing: BridgeFailure(.hostUnavailable, Self.unavailable(nil)))
                return
            }
            proxy.selfTest(userFolders: userFolders) { continuation.resume(returning: $0) }
        }
        return try JSONDecoder().decode([AgentProbeResult].self, from: data)
    }

    /// Ends the connection: the service kills every omp it owns.
    func shutdown() {
        lock.lock()
        let live = connection
        connection = nil
        let pending = sinks
        sinks = [:]
        lock.unlock()
        Self.finish(pending.values, message: "The agent was stopped.")
        live?.invalidate()
    }

    private static func unavailable(_ error: Error?) -> String {
        let detail = error.map { " (\($0.localizedDescription))" } ?? ""
        return "The agent sandbox service is not available\(detail). Reinstall Ocelot, or turn on \"Run agent unconfined\" in Settings > Agent."
    }

    // MARK: OcelotAgentClientProtocol

    func output(sessionId: String, data: Data) {
        lock.lock()
        let sink = sinks[sessionId]
        lock.unlock()
        sink?.yield(.stdout(data))
    }

    func exited(sessionId: String, status: Int32, stderr: String) {
        lock.lock()
        let sink = sinks.removeValue(forKey: sessionId)
        lock.unlock()
        guard let sink else { return }
        sink.yield(.stderr(Data(stderr.utf8)))
        sink.yield(.stdoutClosed)
        sink.yield(.exit(status))
    }
}
