import Foundation

/// `ocelot mcp`: a stdio MCP server that forwards to the running app.
///
/// - `initialize`, `ping` and `tools/list` are answered from the generated manifests, so agents see the tools (and
///   Ocelot's instructions) even when the app is closed. The list is flat: the app tools (`list_projects`, `open_project`,
///   `new_project`, settings, windows...) next to the document tools. Their names never collide (a TS test enforces it).
/// - The first `tools/call` resolves the endpoint (starting the app and opening a known project if needed),
///   initializes an upstream session as the same client, and forwards. After an app restart the next call
///   re-initializes transparently. App tools go to the app endpoint (`/mcp/app`), which needs no open project and
///   starts the app without one; document tools go to the project (or key window) endpoint.
/// - Not pinned (no `--project`/`--window`): the document tools follow the project the agent opened or created last
///   (`open_project`, `new_project`), instead of whatever window happens to be key.
final class StdioProxy {
    private let target: Target
    /// Document endpoint; the argument is the project the agent opened last (nil = the configured target).
    private let resolve: (_ openedProject: String?) throws -> Endpoint
    /// App endpoint (`/mcp/app`); starts the app without opening a project.
    private let resolveApp: (() throws -> Endpoint)?
    private var connection: MCPConnection?
    private var appConnection: MCPConnection?
    /// The project the agent opened or created through the app tools, while the proxy is not pinned.
    private var openedProject: String?
    private var clientInfo: [String: Any]?
    private var protocolVersion: String?
    private let write: (Data) -> Void

    /// `resolve` finds (and if needed starts) the endpoint; `write` receives one JSON line per message.
    init(target: Target, resolve: @escaping (_ openedProject: String?) throws -> Endpoint, resolveApp: (() throws -> Endpoint)? = nil, write: @escaping (Data) -> Void) {
        self.target = target
        self.resolve = resolve
        self.resolveApp = resolveApp
        self.write = write
    }

    /// Whether `--project`/`--window` pinned the document tools: then they stay there, whatever the agent opens.
    private var isPinned: Bool { target.project != nil || target.window != nil }

    /// Handles one line from the client.
    func handle(line: String) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let parsed = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8)) else {
            reply(id: NSNull(), error: -32700, message: "Request is not valid JSON.")
            return
        }
        if let batch = parsed as? [Any] {
            for item in batch { handle(message: item) }
        } else {
            handle(message: parsed)
        }
    }

    func close() {
        connection?.close()
        appConnection?.close()
    }

    private func handle(message: Any) {
        guard let object = message as? [String: Any], let method = object["method"] as? String else { return } // responses/garbage
        guard let id = object["id"] else { return } // notifications are not forwarded; the upstream session gets its own
        let params = object["params"] as? [String: Any] ?? [:]
        switch method {
        case "initialize":
            clientInfo = params["clientInfo"] as? [String: Any]
            protocolVersion = params["protocolVersion"] as? String
            reply(id: id, result: ToolManifestData.initializeResult(requested: protocolVersion))
        case "ping":
            reply(id: id, result: [String: Any]())
        case "tools/list":
            reply(id: id, result: ["tools": ToolManifestData.tools + AppToolData.tools])
        case "tools/call":
            forwardToolCall(id: id, object: object, params: params)
        default:
            reply(id: id, error: -32601, message: "Method \"\(method)\" is not supported. This server implements initialize, ping, tools/list and tools/call.")
        }
    }

    private func forwardToolCall(id: Any, object: [String: Any], params: [String: Any]) {
        let name = params["name"] as? String ?? ""
        let isApp = AppToolData.hasTool(name)
        guard isApp || ToolManifestData.hasTool(name) else {
            reply(id: id, error: -32602, message: "Unknown tool \"\(name)\". Call tools/list for available tools.")
            return
        }
        do {
            let conn = isApp ? try ensureAppConnection() : try ensureConnection()
            guard let upstream = try conn.send(JSON.encode(object)) else {
                reply(id: id, error: -32603, message: "Ocelot sent no answer to \(name).")
                return
            }
            if upstream.status != 200 {
                // Gateway errors (bad scope, unknown project, ...) carry the next step in their message.
                toolFailure(id: id, MCPConnection.rpcMessage(upstream.body) ?? "Ocelot answered HTTP \(upstream.status).")
                return
            }
            // One line per message: re-serialize in case the server pretty-printed.
            if let json = try? JSONSerialization.jsonObject(with: upstream.body) {
                if isApp { followAppResult(tool: name, reply: json) }
                write(JSON.encode(json))
            } else {
                toolFailure(id: id, "Ocelot sent an unreadable answer.")
            }
        } catch let error as CLIError {
            toolFailure(id: id, error.message)
        } catch {
            toolFailure(id: id, error.localizedDescription)
        }
    }

    /// After `open_project` / `new_project` / `duplicate_project` the document tools follow that project (not pinned); after
    /// `close_project` and `quit_app` they go back to whatever is key.
    private func followAppResult(tool: String, reply: Any) {
        guard !isPinned else { return }
        let result = (reply as? [String: Any])?["result"] as? [String: Any]
        guard result?["isError"] as? Bool != true else { return }
        switch tool {
        case "open_project", "new_project", "duplicate_project":
            let text = ((result?["content"] as? [[String: Any]])?.first?["text"]) as? String ?? ""
            guard let projectId = JSON.object(Data(text.utf8))?["project_id"] as? String, !projectId.isEmpty, projectId != openedProject else { return }
            openedProject = projectId
            connection?.close()
            connection = nil
        case "close_project", "quit_app":
            guard openedProject != nil else { return }
            openedProject = nil
            connection?.close()
            connection = nil
        default:
            break
        }
    }

    private func ensureConnection() throws -> MCPConnection {
        if let connection { return connection }
        let conn = MCPConnection(endpoint: try resolve(openedProject), clientInfo: clientInfo, protocolVersion: protocolVersion, reconnect: { [weak self] in
            guard let self else { throw CLIError(message: "Ocelot's proxy ended.") }
            return try self.resolve(self.openedProject)
        })
        try conn.initialize()
        connection = conn
        return conn
    }

    private func ensureAppConnection() throws -> MCPConnection {
        if let appConnection { return appConnection }
        guard let resolveApp else { throw CLIError(message: "This proxy has no app endpoint. Run `ocelot mcp` against the Ocelot app.") }
        let conn = MCPConnection(endpoint: try resolveApp(), clientInfo: clientInfo, protocolVersion: protocolVersion, reconnect: resolveApp)
        try conn.initialize()
        appConnection = conn
        return conn
    }

    // MARK: Replies

    private func reply(id: Any, result: Any) {
        write(JSON.encode(["jsonrpc": "2.0", "id": id, "result": result]))
    }

    private func reply(id: Any, error code: Int, message: String) {
        write(JSON.encode(["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message]]))
    }

    /// A tool-level error the agent can read and act on (instead of a protocol error it may just retry).
    private func toolFailure(id: Any, _ message: String) {
        reply(id: id, result: ["isError": true, "content": [["type": "text", "text": message]]])
    }
}
