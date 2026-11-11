import Foundation

/// MCP client configs that launch `ocelot mcp` (stdio). Shared by `ocelot mcp-config` and Settings > "Copy for …".
enum MCPClientKind: String, CaseIterable, Sendable {
    case claude, codex, cursor, omp

    var displayName: String {
        switch self {
        case .claude: "Claude Code"
        case .codex: "Codex"
        case .cursor: "Cursor"
        case .omp: "omp"
        }
    }
}

enum MCPClientConfig {
    /// Server name in client configs: `ocelot`, or `ocelot-<slug>` when pinned to one project.
    static func serverName(projectName: String?) -> String {
        guard let projectName else { return "ocelot" }
        return "ocelot-\(InstanceDirectory.slug(projectName))"
    }

    /// `command` is `ocelot` when it is on PATH, otherwise the absolute path of the binary.
    static func render(_ client: MCPClientKind, command: String, project: String?, projectName: String? = nil, window: String? = nil) -> String {
        let name = serverName(projectName: projectName)
        var args = ["mcp"]
        if let project { args += ["--project", project] }
        if let window { args += ["--window", window] }
        switch client {
        case .claude:
            return "claude mcp add \(name) -- \(([shellQuote(command)] + args.map(shellQuote)).joined(separator: " "))"
        case .codex:
            return """
            # ~/.codex/config.toml
            [mcp_servers.\(name)]
            command = \(tomlString(command))
            args = [\(args.map(tomlString).joined(separator: ", "))]
            """
        case .cursor:
            return "// .cursor/mcp.json (or ~/.cursor/mcp.json)\n" + json(name: name, command: command, args: args, typed: false)
        case .omp:
            return "// .omp/mcp.json (or ~/.omp/agent/mcp.json)\n" + json(name: name, command: command, args: args, typed: true)
        }
    }

    /// For a client without a kind of its own ("Other" in the handoff popover): the one stdio server every MCP client can run.
    static func renderGeneric(command: String, project: String?, projectName: String? = nil, window: String? = nil) -> String {
        var args = ["mcp"]
        if let project { args += ["--project", project] }
        if let window { args += ["--window", window] }
        let line = ([shellQuote(command)] + args.map(shellQuote)).joined(separator: " ")
        return "Add an MCP server named \(serverName(projectName: projectName)) that runs (stdio):\n\(line)"
    }

    private static func json(name: String, command: String, args: [String], typed: Bool) -> String {
        var server: [String: Any] = ["command": command, "args": args]
        if typed { server["type"] = "stdio" }
        let object: [String: Any] = ["mcpServers": [name: server]]
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    static func shellQuote(_ s: String) -> String {
        if !s.isEmpty && s.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "-_./:=@".contains($0)) }) { return s }
        return "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func tomlString(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}
