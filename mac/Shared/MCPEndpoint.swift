import Foundation

/// What a request path pins: `/mcp` (the key window), `/mcp/p/<projectId>`, `/mcp/w/<windowId>`, or `/mcp/app` (the app's own tools:
/// projects, windows, settings; see `AppToolManifest`).
enum MCPRoute: Equatable, Sendable {
    case keyWindow
    case project(String)
    case window(String)
    /// App-scope tools (list_projects, open_project, ...); master token only.
    case app

    static let base = "/mcp"

    /// Ids are UUIDs or node-style slugs; anything else is not a route (404).
    static func isValidId(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 128 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "-_.".contains($0)) }
    }

    /// `path` without the query string.
    static func parse(path: String) -> MCPRoute? {
        var p = path
        while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
        if p == base { return .keyWindow }
        if p == base + "/app" { return .app }
        let parts = p.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 4, parts[0].isEmpty, parts[1] == "mcp", isValidId(parts[3]) else { return nil }
        switch parts[2] {
        case "p": return .project(parts[3])
        case "w": return .window(parts[3])
        default: return nil
        }
    }

    var path: String {
        switch self {
        case .keyWindow: Self.base
        case .project(let id): "\(Self.base)/p/\(id)"
        case .window(let id): "\(Self.base)/w/\(id)"
        case .app: "\(Self.base)/app"
        }
    }
}

/// Header names shared by hosts, the CLI and tests.
enum MCPHeader {
    static let session = "Mcp-Session-Id"
    /// Legacy window pin (the sidebar used to send it); `/mcp/w/<id>` replaces it.
    static let window = "X-Ocelot-Window"
    /// Set by the front door when proxying with an instance's master token: forward the caller's read-only limit.
    static let readOnly = "X-Ocelot-Read-Only"
}
