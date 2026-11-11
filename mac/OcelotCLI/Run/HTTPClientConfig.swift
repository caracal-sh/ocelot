import Foundation

/// HTTP (Streamable) client configs that talk straight to an endpoint with a bearer token. `ocelot run` prints these next to
/// the stdio configs from `MCPClientConfig` (mac/Shared), which resolve the project through Ocelot.
struct HTTPClientConfig: Sendable, Equatable {
    /// Server name as the client will list it, e.g. `ocelot-acme`.
    var name: String
    var url: String
    var token: String
    /// File holding the token (0600), so clients that can read a command (omp) never embed the secret. Nil for a
    /// scoped token minted in the app's memory: it has no file, so omp's config embeds it.
    var tokenFile: String?

    var claudeCode: String {
        "claude mcp add --transport http \(name) \(url) --header \"Authorization: Bearer \(token)\""
    }

    /// Fragment for `~/.codex/config.toml`.
    var codex: String {
        """
        [mcp_servers.\(name.replacingOccurrences(of: ".", with: "_"))]
        url = "\(url)"
        http_headers = { Authorization = "Bearer \(token)" }
        """
    }

    /// `.omp/mcp.json` (project) or `~/.omp/agent/mcp.json`; the header is a `!command` so rotation never breaks the config.
    var omp: String {
        let command = tokenFile.map { "!printf 'Bearer %s' \"$(cat '\($0)')\"" } ?? "Bearer \(token)"
        let header = Self.jsonString(command)
        return """
        {
          "mcpServers": {
            "\(name)": {
              "type": "http",
              "url": "\(url)",
              "headers": { "Authorization": \(header) }
            }
          }
        }
        """
    }

    private static func jsonString(_ value: String) -> String {
        guard let data = try? JSONEncoder().encode(value), let text = String(data: data, encoding: .utf8) else { return "\"\"" }
        return text.replacingOccurrences(of: "\\/", with: "/")
    }
}
