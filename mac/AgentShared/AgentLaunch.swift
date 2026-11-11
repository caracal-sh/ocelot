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

    /// Subagents (omp's `task` tool, the one built-in the sidebar agent keeps): at most this many run at once, none spawns
    /// another, and the bundled agents (scout, designer, reviewer…: all have shell, file and web tools) are disabled, so the only
    /// agent a spawn can name is `subagentDefinition`. Keep in sync with editor/e2e/agent-sandbox.mjs.
    static let subagentConcurrency = 4
    static let bundledAgentsOff = ["scout", "designer", "reviewer", "security-reviewer", "librarian", "sonic"]

    /// Overlay `config.yml`: MCP tools exposed directly (no `xd://` devices), blocking subagents (the sidebar's turn waits for
    /// them), only the Ocelot server, and the default model (the private agent dir has no user settings).
    static func configOverlay(defaultModel: String? = nil, thinkingLevel: String? = nil, extraDisabled: [String] = []) -> String {
        var text = "tools:\n  xdev: false\nasync:\n  enabled: false\ntask:\n  maxConcurrency: \(subagentConcurrency)\n  maxRecursionDepth: 1\n  disabledAgents:\n"
            + bundledAgentsOff.map { "    - \($0)\n" }.joined()
            + "disabledProviders:\n" + (disabledProviders + extraDisabled).map { "  - \($0)\n" }.joined()
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

    /// Only the MCP tools and `task` (omp's subagent spawner; its subagents get the MCP tools and nothing else, see
    /// `subagentDefinition`): no other built-in tools, skills, rules, context files or extensions. The session lives in
    /// `sessionDirectory` (one directory per conversation, `AgentConversationPaths`); `resume` continues the session already
    /// there (`--continue`) instead of starting one. Mirrored by `ompArgs` in editor/e2e/omp-runner.mjs.
    static func ompArguments(configFile: String, systemPromptFile: String, model: String?, thinking: String?, sessionDirectory: String, resume: Bool) -> [String] {
        var args = ["--mode", "rpc", "--session-dir", sessionDirectory]
        if resume { args.append("--continue") }
        args += [
            "--tools", "task", "--no-skills", "--no-rules",
            "--no-context-files", "--no-extensions", "--no-lsp", "--no-title",
            "--config", configFile, "--system-prompt", systemPromptFile,
        ]
        if let model, !model.isEmpty { args += ["--model", model] }
        if let thinking, !thinking.isEmpty { args += ["--thinking", thinking] }
        return args
    }

    /// Where the subagent definition lives, relative to the agent's working directory (omp's project-level agents, which win over bundled ones of the same name).
    static let subagentDefinitionPath = ".omp/agents/task.md"

    /// The one agent a spawn can name: `task` (replaces omp's bundled agent of that name). `tools: yield` is its whole built-in
    /// tool list (`yield` ends the run); omp adds every connected MCP tool, i.e. Ocelot's, through the parent's connection. No
    /// `model` or `thinkingLevel`: it runs on the sidebar's model and effort. No `spawns`: it spawns nothing.
    /// Keep in sync with SUBAGENT_DEFINITION in editor/e2e/agent-sandbox.mjs.
    static let subagentDefinition = """
    ---
    name: task
    description: Builds one self-contained part of an Ocelot design (one artboard or screen) with the ocelot design tools, then reports what it made.
    tools: yield
    ---
    You are one of several design agents building the same Ocelot document at the same time, each on its own part. The person watches the canvas; every change you make through the ocelot tools appears live.

    You have only the ocelot design tools and yield: no shell, no files, no web. Follow the Ocelot MCP server instructions, read the guide topics your assignment names (the design guide once), and use the token and theme names it gives you instead of inventing colors and fonts.

    Work in one artboard only: the one your assignment hands you by id, else the one you create first with create_artboard, named exactly as your agent id (the name after "Your id is" in your instructions). Never edit, move or delete another artboard, the theme or the design system. begin_edit on your artboard before your first write and end_edit when you are done. Settle the brief in your reasoning, start building early, one visual group per write, and look with get_screenshot at the end.

    Do not ask the person questions; decide yourself. Finish with yield: the artboard's name and id and, in one sentence, what it holds. No headings, no lists.
    """

    /// Writes `subagentDefinition` under `directory` (the agent's working directory).
    static func writeSubagentDefinition(in directory: URL) throws {
        let file = directory.appendingPathComponent(subagentDefinitionPath)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try subagentDefinition.write(to: file, atomically: true, encoding: .utf8)
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
