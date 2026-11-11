import XCTest
@testable import Ocelot

/// The files and policies that keep the user's model credentials out of the sidebar agent's process.
/// editor/e2e/agent-sandbox.test.mjs covers the same functions for the headless host.
final class AgentLaunchTests: XCTestCase {
    func testModelsYmlRoutesProvidersThroughGatewayWithoutSecrets() throws {
        let yml = try AgentLaunch.modelsYml(baseURL: "http://127.0.0.1:14000", providers: ["openrouter", "anthropic", "anthropic"])
        XCTAssertEqual(
            yml,
            "providers:\n" +
                "  anthropic:\n    transport: pi-native\n    baseUrl: http://127.0.0.1:14000\n    apiKey: OCELOT_GATEWAY_TOKEN\n" +
                "  openrouter:\n    transport: pi-native\n    baseUrl: http://127.0.0.1:14000\n    apiKey: OCELOT_GATEWAY_TOKEN\n")
    }

    func testModelsYmlRefusesNonLoopbackAndUnusableProviders() {
        XCTAssertThrowsError(try AgentLaunch.modelsYml(baseURL: "http://example.com:4000", providers: ["anthropic"]))
        XCTAssertThrowsError(try AgentLaunch.modelsYml(baseURL: "http://127.0.0.1:4000", providers: ["bad id", "x: y"]))
    }

    func testClientsFileHoldsDigestsAndGrantsNeverTokens() throws {
        let data = try AgentLaunch.clientsFile([
            .init(name: "ocelot-ab12", token: "secret-token", models: ["anthropic/claude-haiku-4-5"]),
            .init(name: "ocelot-host-1", token: "other", models: nil),
        ])
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(text.contains("secret-token"))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: [String: Any]])
        XCTAssertEqual(object["ocelot-ab12"]?["tokenSha256"] as? String, AgentLaunch.sha256Hex("secret-token"))
        XCTAssertEqual(object["ocelot-ab12"]?["models"] as? [String], ["anthropic/claude-haiku-4-5"])
        XCTAssertNil(object["ocelot-host-1"]?["models"], "no models key = every served model")
        XCTAssertEqual(AgentLaunch.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    func testClientsFileRejectsUnsafeNames() {
        XCTAssertThrowsError(try AgentLaunch.clientsFile([.init(name: "a b", token: "t", models: [])]))
    }

    func testOverlayDisablesDiscoveryAndNamesTheDefaultModel() {
        let yml = AgentLaunch.configOverlay(defaultModel: "anthropic/a", thinkingLevel: "auto")
        XCTAssertTrue(yml.hasPrefix("tools:\n  xdev: false\n"))
        XCTAssertTrue(yml.contains("disabledProviders:\n  - native\n"))
        XCTAssertTrue(yml.contains("modelRoles:\n  default: \"anthropic/a\"\n"))
        XCTAssertTrue(yml.contains("defaultThinkingLevel: \"auto\""))
        XCTAssertFalse(AgentLaunch.configOverlay().contains("modelRoles"))
    }

    func testSubagentsAreCappedBlockingAndOnlyTheOcelotAgent() {
        let yml = AgentLaunch.configOverlay()
        XCTAssertTrue(yml.contains("async:\n  enabled: false\n"))
        XCTAssertTrue(yml.contains("task:\n  maxConcurrency: \(AgentLaunch.subagentConcurrency)\n  maxRecursionDepth: 1\n  disabledAgents:\n"))
        for agent in AgentLaunch.bundledAgentsOff { XCTAssertTrue(yml.contains("    - \(agent)\n"), agent) }
        XCTAssertTrue(AgentLaunch.subagentDefinition.contains("\nname: task\n"))
        XCTAssertTrue(AgentLaunch.subagentDefinition.contains("\ntools: yield\n"))
        XCTAssertFalse(AgentLaunch.subagentDefinition.contains("\nspawns:"))
        XCTAssertFalse(AgentLaunch.subagentDefinition.contains("\nmodel:"))
    }

    func testDefaultSelectorPrefersUserDefaultThenAnthropic() {
        XCTAssertEqual(AgentLaunch.defaultSelector(userDefault: "anthropic/b:auto", selectors: ["anthropic/a", "anthropic/b"]), "anthropic/b:auto")
        XCTAssertEqual(AgentLaunch.defaultSelector(userDefault: "openai/x", selectors: ["openrouter/z", "anthropic/a"]), "anthropic/a")
        XCTAssertEqual(AgentLaunch.defaultSelector(userDefault: nil, selectors: []), "")
    }

    func testConfinedEnvironmentInheritsNothingFromTheHost() {
        let env = AgentLaunch.confinedEnvironment(home: "/h", agentDir: "/h/a", temporaryDirectory: "/h/tmp", token: "t", mcpToken: "m")
        XCTAssertEqual(env, ["HOME": "/h", "PI_CODING_AGENT_DIR": "/h/a", "TMPDIR": "/h/tmp", "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8", "OCELOT_GATEWAY_TOKEN": "t", "OCELOT_MCP_TOKEN": "m"])
    }

    func testArgumentsExposeOnlyMCPToolsAndTask() {
        let args = AgentLaunch.ompArguments(configFile: "/c", systemPromptFile: "/p", model: "anthropic/a", thinking: "low", sessionDirectory: "/s/p1/c1", resume: false)
        XCTAssertFalse(args.contains("--no-tools"))
        XCTAssertEqual(args[args.firstIndex(of: "--tools")! + 1], "task")
        for flag in ["--no-skills", "--no-rules", "--no-context-files", "--no-extensions", "--no-lsp"] {
            XCTAssertTrue(args.contains(flag), flag)
        }
        XCTAssertEqual(args.suffix(4), ["--model", "anthropic/a", "--thinking", "low"])
    }

    /// The conversation's session lives in its own directory so it can be continued; `--no-session` would lose it.
    func testArgumentsKeepTheSessionInTheConversationDirectory() {
        let args = AgentLaunch.ompArguments(configFile: "/c", systemPromptFile: "/p", model: nil, thinking: nil, sessionDirectory: "/s/p1/c1", resume: false)
        XCTAssertFalse(args.contains("--no-session"))
        XCTAssertEqual(Array(args.prefix(4)), ["--mode", "rpc", "--session-dir", "/s/p1/c1"])
        XCTAssertFalse(args.contains("--continue"))
    }

    func testArgumentsContinueTheSessionOnlyWhenResuming() {
        let args = AgentLaunch.ompArguments(configFile: "/c", systemPromptFile: "/p", model: nil, thinking: nil, sessionDirectory: "/s/p1/c1", resume: true)
        XCTAssertEqual(Array(args.prefix(5)), ["--mode", "rpc", "--session-dir", "/s/p1/c1", "--continue"])
    }

    func testConversationPathsAreOnlyPlainNames() {
        let folder = "/home/d/Library/Application Support/Ocelot/Agent"
        XCTAssertEqual(AgentConversationPaths.sessionDirectory(agentFolder: folder, projectId: "p-1_a", conversationId: "c-1"), "\(folder)/conversations/p-1_a/c-1")
        for bad in ["", "..", "a/b", "a b", String(repeating: "x", count: 65)] {
            XCTAssertNil(AgentConversationPaths.sessionDirectory(agentFolder: folder, projectId: bad, conversationId: "c"), bad)
            XCTAssertNil(AgentConversationPaths.sessionDirectory(agentFolder: folder, projectId: "p", conversationId: bad), bad)
        }
        XCTAssertNil(AgentConversationPaths.sessionDirectory(agentFolder: folder, projectId: "p", conversationId: "a_b")) // underscores are project-id only
    }

    func testMCPConfigCarriesTheScopedTokenAndNoWindowHeader() throws {
        let data = try AgentLaunch.mcpConfig(url: "http://127.0.0.1:7420/mcp/w/w1", token: "scoped")
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(text.contains("Bearer scoped"))
        XCTAssertFalse(text.contains("X-Ocelot-Window"))
    }

    func testConfinedMCPConfigNamesTheTokenVariableAndHoldsNoSecret() throws {
        // Every session's files are readable by every other session in the shared sandbox, so the token lives in the environment.
        let text = String(decoding: try AgentLaunch.confinedMCPConfig(url: "http://127.0.0.1:7420/mcp/w/w1"), as: UTF8.self)
        XCTAssertTrue(text.contains("Bearer ${OCELOT_MCP_TOKEN}"))
        XCTAssertTrue(text.contains("http://127.0.0.1:7420/mcp/w/w1"))
        let env = AgentLaunch.confinedEnvironment(home: "/h", agentDir: "/h/a", temporaryDirectory: "/h/tmp", token: "gw", mcpToken: "scoped-secret")
        XCTAssertFalse(text.contains("scoped-secret"))
        XCTAssertEqual(env[AgentLaunch.mcpTokenEnv], "scoped-secret")
    }

    func testPickerKeepsChatModelsTheGatewayServes() throws {
        let host = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {"models":[{"selector":"anthropic/a","kind":"chat"},{"selector":"apple/on-device","kind":"chat"},{"selector":"openrouter/img","kind":"image"}]}
        """#.utf8))
        let selectors = AgentModels.pickerSelectors(hostModels: host, served: ["anthropic/a", "openrouter/img"])
        XCTAssertEqual(selectors, ["anthropic/a"])
        guard case .object(let filtered) = AgentModels.filter(host, selectors: selectors), case .array(let list)? = filtered["models"] else { return XCTFail("shape") }
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(AgentModels.providers(["openrouter/z", "anthropic/a", "anthropic/b"]), ["anthropic", "openrouter"])
    }

    @MainActor
    func testUnconfinedIsOffByDefaultAndPersisted() {
        let name = TestDefaults.name("agent-launch")
        let suite = UserDefaults(suiteName: name)!
        addTeardownBlock { TestDefaults.remove(name) }
        let model = AgentIsolationModel(defaults: suite)
        XCTAssertFalse(model.unconfined)
        XCTAssertEqual(model.mode, .sandboxed)
        model.unconfined = true
        XCTAssertTrue(suite.bool(forKey: AgentIsolationModel.unconfinedKey))
        XCTAssertEqual(AgentIsolationModel(defaults: suite).mode, .unconfined)
    }
}
