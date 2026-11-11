import Foundation
import Network
import os

/// Minimal HTTP/1.1 server on 127.0.0.1 for the MCP endpoint (Streamable HTTP,
/// JSON responses only). Transport only: every request goes to `responder`
/// (`MCPGateway.handle`: validation, routing, sessions, proxying).
///
/// Everything runs on the main queue / main actor: request volume is tiny and
/// the editor it forwards to lives on the main actor anyway.
@MainActor
final class MCPHTTPServer {
    enum State: Equatable {
        case stopped
        case starting
        case running(port: Int)
        case failed(String)
    }

    /// Answers one parsed request. The Int is the port the server is listening on (for Host checks).
    typealias Responder = @MainActor (_ request: HTTPRequestMessage, _ port: Int) async -> HTTPResponseMessage

    private(set) var state: State = .stopped { didSet { onStateChange?(state) } }
    var onStateChange: (@MainActor (State) -> Void)?

    private let requestedPort: Int
    private let responder: Responder
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: HTTPConnection] = [:]
    private let log = Logger(subsystem: "sh.caracal.ocelot", category: "mcp")

    /// `port` 0 picks a free port.
    init(port: Int, responder: @escaping Responder) {
        self.requestedPort = port
        self.responder = responder
    }

    var port: Int {
        if case .running(let p) = state { return p }
        return requestedPort
    }

    func start() {
        guard listener == nil else { return }
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            guard let nwPort = requestedPort == 0 ? NWEndpoint.Port.any : NWEndpoint.Port(rawValue: UInt16(clamping: requestedPort)) else {
                state = .failed("Invalid port \(requestedPort).")
                return
            }
            // Bind to loopback only: never reachable from the network.
            params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: nwPort)
            let listener = try NWListener(using: params)
            self.listener = listener
            state = .starting
            listener.stateUpdateHandler = { [weak self] newState in
                MainActor.assumeIsolated { self?.listenerStateChanged(newState) }
            }
            listener.newConnectionHandler = { [weak self] connection in
                MainActor.assumeIsolated { self?.accept(connection) }
            }
            listener.start(queue: .main)
        } catch {
            state = .failed("Could not start the MCP server: \(error.localizedDescription)")
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        for c in connections.values { c.close() }
        connections.removeAll()
        state = .stopped
    }

    private func listenerStateChanged(_ newState: NWListener.State) {
        switch newState {
        case .ready:
            let p = Int(listener?.port?.rawValue ?? UInt16(requestedPort))
            state = .running(port: p)
            log.info("MCP server listening on 127.0.0.1:\(p)")
        case .failed(let error):
            let message: String
            if case .posix(let code) = error, code == .EADDRINUSE {
                message = "Port \(requestedPort) is already in use (is another Ocelot running?). Choose another port in Settings."
            } else {
                message = "MCP server stopped: \(error.localizedDescription)"
            }
            state = .failed(message)
            log.error("\(message, privacy: .public)")
            listener?.cancel()
            listener = nil
        case .cancelled:
            if case .running = state { state = .stopped }
        default:
            break
        }
    }

    private func accept(_ nw: NWConnection) {
        let connection = HTTPConnection(connection: nw) { [weak self] request in
            guard let self else { return .rpcError(503, "Ocelot is shutting down.") }
            return await self.respond(to: request)
        }
        let id = ObjectIdentifier(connection)
        connection.onClose = { [weak self] in self?.connections.removeValue(forKey: id) }
        connections[id] = connection
        connection.start()
    }

    private func respond(to request: HTTPRequestMessage) async -> HTTPResponseMessage {
        await responder(request, port)
    }
}

/// One TCP connection: parses requests sequentially (keep-alive) and writes responses.
@MainActor
private final class HTTPConnection {
    typealias Responder = @MainActor (HTTPRequestMessage) async -> HTTPResponseMessage

    private let connection: NWConnection
    private let responder: Responder
    private var parser = HTTPRequestParser()
    private var busy = false
    private var closed = false
    var onClose: (@MainActor () -> Void)?

    init(connection: NWConnection, responder: @escaping Responder) {
        self.connection = connection
        self.responder = responder
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                switch state {
                case .failed, .cancelled: self?.close()
                default: break
                }
            }
        }
        connection.start(queue: .main)
        receive()
    }

    func close() {
        guard !closed else { return }
        closed = true
        connection.cancel()
        onClose?()
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
            MainActor.assumeIsolated {
                guard let self, !self.closed else { return }
                if let data, !data.isEmpty { self.parser.append(data) }
                self.processBuffered()
                if isComplete || error != nil {
                    if !self.busy { self.close() }
                    return
                }
                self.receive()
            }
        }
    }

    private func processBuffered() {
        guard !busy, !closed else { return }
        let request: HTTPRequestMessage?
        do {
            request = try parser.next()
        } catch {
            let response: HTTPResponseMessage = switch error {
            case .bodyTooLarge: .rpcError(413, "Request body too large.")
            case .headersTooLarge: .rpcError(413, "Request headers too large.")
            case .malformed(let why): .rpcError(400, "Malformed HTTP request: \(why)")
            }
            send(response, keepAlive: false)
            return
        }
        guard let request else { return }
        busy = true
        Task { @MainActor in
            let response = await self.responder(request)
            self.busy = false
            self.send(response, keepAlive: request.keepAlive)
            if request.keepAlive { self.processBuffered() }
        }
    }

    private func send(_ response: HTTPResponseMessage, keepAlive: Bool) {
        guard !closed else { return }
        connection.send(content: response.serialized(keepAlive: keepAlive), completion: .contentProcessed { [weak self] _ in
            MainActor.assumeIsolated {
                if !keepAlive { self?.close() }
            }
        })
    }
}
