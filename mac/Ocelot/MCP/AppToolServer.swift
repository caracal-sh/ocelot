import Foundation

/// What the app endpoint's tools do. The live app implements it (`LiveAppControl`); tests fake it.
@MainActor
protocol AppControl: AnyObject {
    /// Runs one app tool. Returns a JSON value (dictionary, array or string); throws `AppToolError` with a message the agent can act on.
    func call(tool: String, arguments: [String: Any], client: String?) async throws -> Any
}

/// The JSON-RPC side of `/mcp/app`: `initialize`, `ping`, `tools/list`, `tools/call` over the generated app tool list
/// (`AppToolManifest`, from editor/src/mcp/appTools.ts). The host answers these itself; no editor window is involved, so the
/// tools work with no project open (and with the app just started). The behaviour of each tool is `AppControl`.
@MainActor
final class AppToolServer {
    private let control: AppControl

    init(control: AppControl) { self.control = control }

    /// Handles one POST body (a message or a batch). nil = nothing to answer (notifications only).
    func handle(body: String, client: String?, readOnly: Bool) async -> String? {
        guard let parsed = try? JSONSerialization.jsonObject(with: Data(body.utf8)) else {
            return Self.encode(Self.error(id: NSNull(), code: -32700, message: "Request body is not valid JSON."))
        }
        if let batch = parsed as? [Any] {
            var replies: [Any] = []
            for item in batch { if let reply = await handleOne(item, client: client, readOnly: readOnly) { replies.append(reply) } }
            return replies.isEmpty ? nil : Self.encode(replies)
        }
        return await handleOne(parsed, client: client, readOnly: readOnly).map(Self.encode)
    }

    private func handleOne(_ raw: Any, client: String?, readOnly: Bool) async -> [String: Any]? {
        guard let message = raw as? [String: Any], message["jsonrpc"] as? String == "2.0" else {
            return Self.error(id: NSNull(), code: -32600, message: "Expected a JSON-RPC 2.0 message.")
        }
        guard let method = message["method"] as? String else {
            return message["id"] == nil ? nil : Self.error(id: message["id"] ?? NSNull(), code: -32600, message: "Missing \"method\".")
        }
        guard let id = message["id"] else { return nil } // notifications/initialized, cancelled, ...
        let params = message["params"] as? [String: Any] ?? [:]
        switch method {
        case "initialize":
            return Self.result(id: id, AppToolData.initializeResult(requested: params["protocolVersion"] as? String))
        case "ping":
            return Self.result(id: id, [String: Any]())
        case "tools/list":
            let tools = AppToolData.tools.filter { !readOnly || AppToolData.isReadOnly($0["name"] as? String ?? "") }
            return Self.result(id: id, ["tools": tools])
        case "tools/call":
            guard let name = params["name"] as? String else { return Self.error(id: id, code: -32602, message: "tools/call needs params.name.") }
            guard AppToolData.hasTool(name) else {
                return Self.error(id: id, code: -32602, message: "Unknown app tool \"\(name)\". Call tools/list for the app tools; document tools (write_html, ...) live on a project URL (/mcp/p/<project_id>).")
            }
            if readOnly, !AppToolData.isReadOnly(name) {
                return Self.result(id: id, Self.failure("\"\(name)\" changes the app, but this connection is read-only. Use a read tool (list_projects, get_app_info, get_app_settings, list_windows) or ask the person for a read-write connection."))
            }
            let arguments = params["arguments"] as? [String: Any] ?? [:]
            do {
                let value = try await control.call(tool: name, arguments: arguments, client: client)
                return Self.result(id: id, ["content": [["type": "text", "text": Self.pretty(value)]]])
            } catch let error as AppToolError {
                return Self.result(id: id, Self.failure(error.message))
            } catch {
                return Self.result(id: id, Self.failure("\(name) failed: \(error.localizedDescription)"))
            }
        default:
            return Self.error(id: id, code: -32601, message: "Method \"\(method)\" is not supported. This server implements initialize, ping, tools/list and tools/call.")
        }
    }

    // MARK: JSON

    private static func result(id: Any, _ result: [String: Any]) -> [String: Any] { ["jsonrpc": "2.0", "id": id, "result": result] }

    private static func error(id: Any, code: Int, message: String) -> [String: Any] {
        ["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message]]
    }

    private static func failure(_ message: String) -> [String: Any] {
        ["isError": true, "content": [["type": "text", "text": message]]]
    }

    private static func encode(_ value: Any) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// Tool results are pretty JSON text (strings stay as they are).
    static func pretty(_ value: Any) -> String {
        if let string = value as? String { return string }
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) else { return "\(value)" }
        return String(decoding: data, as: UTF8.self)
    }
}
