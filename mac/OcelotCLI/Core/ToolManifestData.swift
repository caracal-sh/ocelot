import Foundation

/// The generated tool manifest (`Generated/ToolManifest.gen.swift`) parsed once.
enum ToolManifestData {
    nonisolated(unsafe) private static let root: [String: Any] = JSON.object(Data(ToolManifest.json.utf8)) ?? [:]
    static let protocolVersions: [String] = root["protocolVersions"] as? [String] ?? ["2025-06-18"]
    nonisolated(unsafe) static let initialize: [String: Any] = root["initialize"] as? [String: Any] ?? [:]
    nonisolated(unsafe) static let tools: [[String: Any]] = root["tools"] as? [[String: Any]] ?? []

    /// `initialize` result for the protocol version a client asked for (falls back to the newest we support).
    static func initializeResult(requested: String?) -> [String: Any] {
        var result = initialize
        result["protocolVersion"] = requested.flatMap { protocolVersions.contains($0) ? $0 : nil } ?? protocolVersions.first ?? "2025-06-18"
        return result
    }

    static func hasTool(_ name: String) -> Bool { tools.contains { $0["name"] as? String == name } }
}
