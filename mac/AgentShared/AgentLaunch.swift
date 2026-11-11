import CryptoKit
import Foundation

/// Files and command line of one confined agent process. Pure functions, shared by the app
/// and the sandboxed XPC service, mirrored by editor/e2e/agent-sandbox.mjs (headless host);
/// keep the two in sync.
enum AgentLaunch {
    /// Environment variable that carries the gateway client token into the agent. `models.yml` names it, never holds the value.
    static let gatewayTokenEnv = "OCELOT_GATEWAY_TOKEN"
    /// Environment variable that carries the agent's window-scoped MCP token. The confined `.mcp.json` names it, never holds the value.
    static let mcpTokenEnv = "OCELOT_MCP_TOKEN"

    /// Every omp discovery source that can contribute MCP servers, tools, hooks or settings,
    /// except `mcp-json` (the root `.mcp.json` written per conversation). `native` carries the
    /// user's `~/.omp/agent/mcp.json`, `agent-plugins` installed plugins (e.g. a Cloudflare
    /// MCP). A denylist, so the editor also checks the loaded tools before every prompt.
    /// Keep in sync with editor/e2e/omp-runner.mjs.
    static let disabledProviders = [
        "native", "omp-plugins", "agent-plugins", "claude", "claude-plugins", "codex",
        "gemini", "opencode", "cursor", "windsurf", "vscode", "cline", "github",
    ]

    /// Model providers the confined agent must not load. `apple` is omp's on-device model: it unpacks and loads a dylib
    /// at startup, which a sandboxed process cannot do (files it writes are quarantined), and the gateway does not serve it.
    static let confinedModelProvidersOff = ["apple"]

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
        init(_ message: String) { self.message = message }
    }

    /// One scoped gateway client: the gateway stores only the token's SHA-256 and its model grant.
    struct Client: Sendable, Equatable {
        var name: String
        var token: String
        /// nil = every model the gateway serves.
        var models: [String]?
    }

    /// Overlay `config.yml`: MCP tools exposed directly (no `xd://` devices), only the Ocelot server,
    /// and the default model (the private agent dir has no user settings).
    static func configOverlay(defaultModel: String? = nil, thinkingLevel: String? = nil, extraDisabled: [String] = []) -> String {
        var text = "tools:\n  xdev: false\ndisabledProviders:\n" + (disabledProviders + extraDisabled).map { "  - \($0)\n" }.joined()
        if let defaultModel, !defaultModel.isEmpty { text += "modelRoles:\n  default: \(quoted(defaultModel))\n" }
        if let thinkingLevel, !thinkingLevel.isEmpty { text += "defaultThinkingLevel: \(quoted(thinkingLevel))\n" }
        return text
    }

    /// `models.yml` for the agent dir: every listed provider goes to the gateway over pi-native.
    static func modelsYml(baseURL: String, providers: [String]) throws -> String {
        guard baseURL.range(of: #"^http://(127\.0\.0\.1|localhost|\[::1\]):\d+$"#, options: .regularExpression) != nil else {
            throw Failure("The agent gateway must be on loopback, got \"\(baseURL)\". Restart Ocelot.")
        }
        let ids = Set(providers).filter { $0.range(of: #"^[a-z0-9][a-z0-9._-]*$"#, options: .regularExpression) != nil }.sorted()
        guard !ids.isEmpty else { throw Failure("No model provider is served by the gateway. Sign in with \"omp login\", then check again.") }
        return "providers:\n" + ids.map {
            "  \($0):\n    transport: pi-native\n    baseUrl: \(baseURL)\n    apiKey: \(gatewayTokenEnv)\n"
        }.joined()
    }

    /// The `--clients` file for `omp auth-gateway serve`: `{ name: { tokenSha256, models? } }`, never raw tokens.
    static func clientsFile(_ clients: [Client]) throws -> Data {
        var object: [String: [String: Any]] = [:]
        for client in clients {
            guard client.name.range(of: #"^[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil else {
                throw Failure("Invalid gateway client name \"\(client.name)\".")
            }
            var entry: [String: Any] = ["tokenSha256": sha256Hex(client.token)]
            if let models = client.models { entry["models"] = models }
            object[client.name] = entry
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    }

    static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Only the MCP tools: no built-in tools, skills, rules, context files or extensions.
    static func ompArguments(configFile: String, systemPromptFile: String, model: String?, thinking: String?) -> [String] {
        var args = [
            "--mode", "rpc", "--no-session", "--no-tools", "--no-skills", "--no-rules",
            "--no-context-files", "--no-extensions", "--no-lsp", "--no-title",
            "--config", configFile, "--system-prompt", systemPromptFile,
        ]
        if let model, !model.isEmpty { args += ["--model", model] }
        if let thinking, !thinking.isEmpty { args += ["--thinking", thinking] }
        return args
    }

    /// Root `.mcp.json` (omp's `mcp-json` source): the Ocelot endpoint only. With the literal token (unconfined mode).
    static func mcpConfig(url: String, token: String) throws -> Data {
        try mcpConfig(url: url, authorization: "Bearer \(token)")
    }

    /// The confined variant: the header names `${OCELOT_MCP_TOKEN}` (omp expands it from its environment), so
    /// the file holds no secret. Every session's files are readable by every other session in the sandbox;
    /// the token travels in the process environment instead, like the gateway token.
    static func confinedMCPConfig(url: String) throws -> Data {
        try mcpConfig(url: url, authorization: "Bearer ${\(mcpTokenEnv)}")
    }

    private static func mcpConfig(url: String, authorization: String) throws -> Data {
        let config: [String: Any] = ["mcpServers": ["ocelot": [
            "type": "http", "url": url, "headers": ["Authorization": authorization], "timeout": 620_000,
        ] as [String: Any]]]
        return try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    }

    /// The model omp starts with when the sidebar has none selected.
    static func defaultSelector(userDefault: String?, selectors: [String]) -> String {
        if let userDefault, let base = userDefault.split(separator: ":").first, selectors.contains(String(base)) { return userDefault }
        return selectors.first { $0.hasPrefix("anthropic/") } ?? selectors.first ?? ""
    }

    /// Environment of the confined omp: nothing inherited from the host.
    static func confinedEnvironment(home: String, agentDir: String, temporaryDirectory: String, token: String, mcpToken: String) -> [String: String] {
        [
            "HOME": home, "PI_CODING_AGENT_DIR": agentDir, "TMPDIR": temporaryDirectory,
            "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8", gatewayTokenEnv: token, mcpTokenEnv: mcpToken,
        ]
    }

    /// A YAML-safe quoted scalar (JSON strings are valid YAML).
    private static func quoted(_ value: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes // model selectors are "provider/id"
        let data = (try? encoder.encode([value])) ?? Data("[\"\"]".utf8)
        let text = String(decoding: data, as: UTF8.self)
        return String(text.dropFirst().dropLast())
    }
}
