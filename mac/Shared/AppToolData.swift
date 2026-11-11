import Foundation

/// The app-scope tools (`AppToolManifest.gen.swift`, generated from editor/src/mcp/appTools.ts) parsed once: served by the
/// app at `/mcp/app` and by the headless host, listed by `ocelot mcp` next to the document tools.
enum AppToolData {
    nonisolated(unsafe) private static let root: [String: Any] = {
        (try? JSONSerialization.jsonObject(with: Data(AppToolManifest.json.utf8))) as? [String: Any] ?? [:]
    }()
    static let protocolVersions: [String] = root["protocolVersions"] as? [String] ?? ["2025-06-18"]
    nonisolated(unsafe) static let serverInfo: [String: Any] = root["serverInfo"] as? [String: Any] ?? ["name": "ocelot"]
    static let instructions: String = root["instructions"] as? String ?? ""
    nonisolated(unsafe) static let tools: [[String: Any]] = root["tools"] as? [[String: Any]] ?? []
    nonisolated(unsafe) static let settings: [[String: Any]] = root["settings"] as? [[String: Any]] ?? []
    static let securityHint: String = root["securityHint"] as? String ?? "Ask the person to change it themselves in Ocelot > Settings."

    /// The `initialize` result of the app endpoint, for the protocol version the client asked for.
    static func initializeResult(requested: String?) -> [String: Any] {
        [
            "protocolVersion": requested.flatMap { protocolVersions.contains($0) ? $0 : nil } ?? protocolVersions.first ?? "2025-06-18",
            "capabilities": ["tools": ["listChanged": false]],
            "serverInfo": serverInfo,
            "instructions": instructions,
        ]
    }

    static func hasTool(_ name: String) -> Bool { tools.contains { $0["name"] as? String == name } }

    static func isReadOnly(_ name: String) -> Bool {
        ((tools.first { $0["name"] as? String == name }?["annotations"] as? [String: Any])?["readOnlyHint"] as? Bool) ?? false
    }

    static func setting(_ key: String) -> [String: Any]? { settings.first { $0["key"] as? String == key } }

    static func isSecurity(_ key: String) -> Bool { setting(key)?["security"] as? Bool == true }

    /// The refusal for a write to a security setting (mirrors `securityRefusal` in appTools.ts).
    static func securityRefusal(_ key: String) -> String {
        let place = (setting(key)?["where"] as? String).map { " (\($0))" } ?? ""
        return "\"\(key)\" is a security setting\(place): agents may read it but never change it. \(securityHint)"
    }
}
