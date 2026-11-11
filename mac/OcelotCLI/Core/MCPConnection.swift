import Foundation

/// A client session on one MCP endpoint: initializes, keeps the `Mcp-Session-Id`, and re-initializes
/// (re-resolving the endpoint, which may start the app) when the host went away, rotated its token or forgot the session.
final class MCPConnection {
    struct Reply {
        var status: Int
        var body: Data
    }

    private(set) var endpoint: Endpoint
    private(set) var sessionId: String?
    private var initialized = false
    private let clientInfo: [String: Any]
    private let protocolVersion: String
    private let reconnect: (() throws -> Endpoint)?

    /// `reconnect` is called when the host is unreachable or rejects the session/token; nil = fail instead.
    init(endpoint: Endpoint, clientInfo: [String: Any]? = nil, protocolVersion: String? = nil, reconnect: (() throws -> Endpoint)? = nil) {
        self.endpoint = endpoint
        self.clientInfo = clientInfo ?? ["name": "ocelot-cli", "version": CLIInfo.version]
        self.protocolVersion = protocolVersion ?? ToolManifestData.protocolVersions.first ?? "2025-06-18"
        self.reconnect = reconnect
    }

    // MARK: Protocol

    func initialize() throws {
        sessionId = nil
        initialized = false
        let params: [String: Any] = ["protocolVersion": protocolVersion, "capabilities": [String: Any](), "clientInfo": clientInfo]
        let body = JSON.encode(["jsonrpc": "2.0", "id": "ocelot-init", "method": "initialize", "params": params])
        do {
            let reply = try post(body, sessionId: nil)
            guard reply.status == 200 else { throw Self.failure(reply, endpoint: endpoint) }
            _ = try post(JSON.encode(["jsonrpc": "2.0", "method": "notifications/initialized"]), sessionId: sessionId)
            initialized = true
        } catch let failure as ConnectionFailure {
            throw CLIError(message: "Could not reach Ocelot at \(endpoint.instance.http): \(failure.message). Is it running? Try `ocelot ls`.")
        }
    }

    /// Sends one JSON-RPC body (request or notification). Retries once through `reconnect` when the host
    /// went away, the token changed or the session ended. nil = accepted with no body (notification).
    func send(_ body: Data) throws -> Reply? {
        if !initialized { try initialize() }
        var retried = false
        while true {
            do {
                return try sendOnce(body)
            } catch let failure as ConnectionFailure {
                guard reconnect != nil, !retried else {
                    throw CLIError(message: "Could not reach Ocelot at \(endpoint.instance.http): \(failure.message). Is it running? Try `ocelot ls`.")
                }
                retried = true
                try refresh()
            } catch let lost as SessionLost {
                guard reconnect != nil, !retried else { throw CLIError(message: lost.message) }
                retried = true
                try refresh()
            }
        }
    }

    private struct SessionLost: Error { var message: String }

    private func sendOnce(_ body: Data) throws -> Reply? {
        let reply = try post(body, sessionId: sessionId)
        if reply.status == 404 || reply.status == 401 {
            let why = Self.rpcMessage(reply.body) ?? "HTTP \(reply.status)"
            // 404 on a pinned URL can also mean the project is gone; `refresh` re-resolves and reports that.
            throw SessionLost(message: why)
        }
        if reply.status == 202 { return nil }
        return Reply(status: reply.status, body: reply.body)
    }

    private func refresh() throws {
        guard let reconnect else { return }
        endpoint = try reconnect()
        try initialize()
    }

    private func post(_ body: Data, sessionId: String?) throws -> Reply {
        var headers = [
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": "Bearer \(endpoint.token)",
        ]
        if let sessionId { headers[MCPHeader.session] = sessionId }
        let http = try HTTP.request("POST", endpoint.url, headers: headers, body: body)
        if let sid = http.headers[MCPHeader.session.lowercased()] { self.sessionId = sid }
        return Reply(status: http.status, body: http.body)
    }

    func close() {
        guard let sessionId else { return }
        _ = try? HTTP.request("DELETE", endpoint.url, headers: ["Authorization": "Bearer \(endpoint.token)", MCPHeader.session: sessionId], timeout: 3)
        self.sessionId = nil
        initialized = false
    }

    // MARK: Helpers

    /// `error.message` of a JSON-RPC error body.
    static func rpcMessage(_ body: Data) -> String? {
        ((JSON.object(body)?["error"]) as? [String: Any])?["message"] as? String
    }

    private static func failure(_ reply: Reply, endpoint: Endpoint) -> CLIError {
        CLIError(message: rpcMessage(reply.body) ?? "Ocelot answered HTTP \(reply.status) at \(endpoint.url.absoluteString).")
    }

    // MARK: Tool calls

    struct ToolResult {
        var isError: Bool
        var content: [[String: Any]]
        var text: String { content.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n") }
    }

    func callTool(_ name: String, arguments: [String: Any]) throws -> ToolResult {
        let request: [String: Any] = ["jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": ["name": name, "arguments": arguments]]
        guard let reply = try send(JSON.encode(request)) else { throw CLIError(message: "Ocelot sent no answer to \(name).") }
        guard let object = JSON.object(reply.body) else { throw CLIError(message: "Ocelot sent an unreadable answer to \(name).") }
        if let error = object["error"] as? [String: Any] {
            throw CLIError(message: (error["message"] as? String) ?? "\(name) failed.")
        }
        if reply.status != 200 { throw Self.failure(reply, endpoint: endpoint) }
        guard let result = object["result"] as? [String: Any] else { throw CLIError(message: "Ocelot answered \(name) without a result.") }
        return ToolResult(isError: result["isError"] as? Bool == true, content: result["content"] as? [[String: Any]] ?? [])
    }
}
