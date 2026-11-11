import XCTest
@testable import Ocelot

/// Records the app tool calls it gets and answers from a script.
@MainActor
final class FakeAppControl: AppControl {
    var calls: [(tool: String, arguments: [String: Any], client: String?)] = []
    var reply: Any = ["ok": true]
    var failure: AppToolError?

    func call(tool: String, arguments: [String: Any], client: String?) async throws -> Any {
        calls.append((tool, arguments, client))
        if let failure { throw failure }
        return reply
    }
}

@MainActor
final class AppToolServerTests: XCTestCase {
    private let control = FakeAppControl()
    private lazy var server = AppToolServer(control: control)

    private func rpc(_ method: String, id: Int = 1, params: [String: Any] = [:]) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": id, "method": method, "params": params]), as: UTF8.self)
    }

    private func object(_ text: String?) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data((text ?? "{}").utf8))) as? [String: Any] ?? [:]
    }

    func testInitializeNamesTheServerAndPointsAtTheTools() async {
        let reply = object(await server.handle(body: rpc("initialize", params: ["protocolVersion": "2025-06-18"]), client: "claude-code", readOnly: false))
        let result = reply["result"] as? [String: Any]
        XCTAssertEqual(result?["protocolVersion"] as? String, "2025-06-18")
        XCTAssertTrue((result?["instructions"] as? String ?? "").contains("open_project"))
        let notification = await server.handle(body: #"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, client: nil, readOnly: false)
        XCTAssertNil(notification)
    }

    func testToolsListHasTheAppToolsAndAReadOnlyConnectionSeesOnlyReaders() async {
        let all = ((object(await server.handle(body: rpc("tools/list"), client: nil, readOnly: false))["result"] as? [String: Any])?["tools"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
        for name in ["list_projects", "open_project", "new_project", "close_project", "save_project", "save_project_as", "open_home", "list_windows", "focus_window", "arrange_windows", "get_app_settings", "set_app_settings", "check_for_updates", "get_app_info", "quit_app"] {
            XCTAssertTrue(all.contains(name), name)
        }
        let readOnly = ((object(await server.handle(body: rpc("tools/list"), client: nil, readOnly: true))["result"] as? [String: Any])?["tools"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
        XCTAssertTrue(readOnly.contains("list_projects"))
        XCTAssertFalse(readOnly.contains("open_project"))
        XCTAssertFalse(readOnly.contains("quit_app"))
        let refused = object(await server.handle(body: rpc("tools/call", params: ["name": "quit_app", "arguments": [:]]), client: nil, readOnly: true))
        XCTAssertEqual((refused["result"] as? [String: Any])?["isError"] as? Bool, true)
        XCTAssertTrue(control.calls.isEmpty, "a read-only connection never reaches a changing tool")
    }

    func testToolCallsReachTheControlWithArgumentsAndClient() async {
        control.reply = ["project_id": "P1", "name": "Acme"]
        let reply = object(await server.handle(body: rpc("tools/call", params: ["name": "open_project", "arguments": ["project": "Acme"]]), client: "codex", readOnly: false))
        XCTAssertEqual(control.calls.last?.tool, "open_project")
        XCTAssertEqual(control.calls.last?.arguments["project"] as? String, "Acme")
        XCTAssertEqual(control.calls.last?.client, "codex")
        let content = ((reply["result"] as? [String: Any])?["content"] as? [[String: Any]])?.first?["text"] as? String
        XCTAssertEqual(object(content)["project_id"] as? String, "P1")
    }

    func testToolErrorsAreResultsTheAgentCanReadAndUnknownToolsAreProtocolErrors() async {
        control.failure = AppToolError("Call save_project_as first.")
        let failed = object(await server.handle(body: rpc("tools/call", params: ["name": "close_project"]), client: nil, readOnly: false))
        let result = failed["result"] as? [String: Any]
        XCTAssertEqual(result?["isError"] as? Bool, true)
        XCTAssertEqual(((result?["content"] as? [[String: Any]])?.first?["text"]) as? String, "Call save_project_as first.")
        let unknown = object(await server.handle(body: rpc("tools/call", id: 2, params: ["name": "write_html"]), client: nil, readOnly: false))
        XCTAssertEqual((unknown["error"] as? [String: Any])?["code"] as? Int, -32602, "document tools are not served here")
        XCTAssertTrue(((unknown["error"] as? [String: Any])?["message"] as? String ?? "").contains("/mcp/p/"))
        let garbage = object(await server.handle(body: "nope", client: nil, readOnly: false))
        XCTAssertEqual((garbage["error"] as? [String: Any])?["code"] as? Int, -32700)
    }

    func testBatchesAnswerEveryRequest() async throws {
        let batch = "[\(rpc("ping", id: 1)),\(rpc("ping", id: 2)),{\"jsonrpc\":\"2.0\",\"method\":\"notifications/x\"}]"
        let reply = await server.handle(body: batch, client: nil, readOnly: false)
        let text = try XCTUnwrap(reply)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [Any])?.count, 2)
    }

    func testAppToolNamesNeverCollideWithTheDocumentTools() {
        // The stdio proxy lists both in one flat list and routes by name.
        let documentNames = Set(AppToolData.tools.compactMap { $0["name"] as? String })
        XCTAssertEqual(documentNames.count, AppToolData.tools.count)
    }

    func testClientLabelsReadLikeTheEditorBadges() {
        XCTAssertEqual(AppActivity.label(for: "claude-code"), "Claude Code")
        XCTAssertEqual(AppActivity.label(for: "codex-mcp-client"), "Codex")
        XCTAssertEqual(AppActivity.label(for: "cursor"), "Cursor")
        XCTAssertEqual(AppActivity.label(for: "my_tool/1.2"), "My Tool")
        XCTAssertEqual(AppActivity.label(for: nil), "An agent")
    }
}

/// The settings guard: agents read everything, change only the non-security settings.
@MainActor
final class AppSettingsGuardTests: XCTestCase {
    private var automatic: Bool? = true
    private var imageDefault: String?
    private var cli = false
    private var calls: [String] = []

    private lazy var settings = AppSettings(hooks: AppSettingsHooks(
        automaticChecks: { self.automatic },
        setAutomaticChecks: { self.automatic = $0; self.calls.append("updates") },
        imageModels: { [
            .init(id: "fal-ai/flux/dev", label: "Flux dev", provider: "fal", available: true, reason: nil),
            .init(id: "gpt-image", label: "GPT Image", provider: "codex", available: false, reason: "Sign in with codex login"),
        ] },
        imageDefault: { self.imageDefault },
        setImageDefault: { self.imageDefault = $0; self.calls.append("image") },
        falKeyStored: { true },
        cliInstalled: { self.cli },
        cliDetail: { nil },
        setCLIInstalled: { self.cli = $0; self.calls.append("cli") },
        unconfined: { false },
        mcpPort: { 7420 },
        mcpRunning: { true }
    ))

    private func message(_ work: () async throws -> Any) async -> String? {
        do { _ = try await work(); return nil } catch let error as AppToolError { return error.message } catch { return "\(error)" }
    }

    func testEverySecuritySettingIsRefusedWhateverTheValueAndSaysWhereToChangeIt() async {
        for (key, value) in [("agent.unconfined", true as Any), ("agent.unconfined", "yes"), ("mcp.port", 9999), ("mcp.token", "x"), ("images.fal_key", "sk-123"), ("images.fal_key", NSNull())] {
            let text = await message { try await settings.apply([key: value]) }
            XCTAssertNotNil(text, key)
            XCTAssertTrue(text?.contains("security setting") == true, key)
            XCTAssertTrue(text?.contains("never change") == true, key)
            XCTAssertTrue(text?.contains("Settings") == true, "\(key): names the place")
        }
        XCTAssertTrue(calls.isEmpty)
    }

    func testOneSecurityKeyStopsTheWholeCall() async {
        let text = await message { try await settings.apply(["updates.automatic_checks": false, "agent.unconfined": true]) }
        XCTAssertTrue(text?.contains("agent.unconfined") == true)
        XCTAssertEqual(automatic, true, "all or nothing: the allowed key did not change either")
        XCTAssertTrue(calls.isEmpty)
    }

    func testAllowedSettingsChangeAndReportFromTo() async throws {
        let result = try await settings.apply(["updates.automatic_checks": false, "images.default_model": "fal-ai/flux/dev", "cli.installed": true])
        XCTAssertEqual(automatic, false)
        XCTAssertEqual(imageDefault, "fal-ai/flux/dev")
        XCTAssertTrue(cli)
        let changed = try XCTUnwrap(result["changed"] as? [String: Any])
        XCTAssertEqual(Set(changed.keys), ["updates.automatic_checks", "images.default_model", "cli.installed"])
        _ = try await settings.apply(["images.default_model": NSNull()])
        XCTAssertNil(imageDefault, "null is automatic")
    }

    func testBadKeysAndValuesChangeNothingAndSayWhatIsValid() async {
        var text = await message { try await settings.apply(["updates.automatic_checks": "no"]) }
        XCTAssertTrue(text?.contains("true or false") == true)
        text = await message { try await settings.apply(["theme.color": "dark"]) }
        XCTAssertTrue(text?.contains("Unknown setting") == true)
        XCTAssertTrue(text?.contains("updates.automatic_checks") == true, "lists the keys that may change")
        text = await message { try await settings.apply(["images.default_model": "gpt-image"]) }
        XCTAssertTrue(text?.contains("not available") == true)
        XCTAssertTrue(text?.contains("fal-ai/flux/dev") == true, "names what is available")
        text = await message { try await settings.apply([:]) }
        XCTAssertNotNil(text)
        XCTAssertTrue(calls.isEmpty)
    }

    func testUpdateChecksCannotBeSwitchedInABuildWithoutAFeed() async {
        automatic = nil
        let text = await message { try await settings.apply(["updates.automatic_checks": true]) }
        XCTAssertTrue(text?.contains("no update feed") == true)
    }

    func testSnapshotShowsEverythingRedactedAndMarksWhatIsWritable() async throws {
        let snapshot = await settings.snapshot()
        let rows = try XCTUnwrap(snapshot["settings"] as? [[String: Any]])
        func row(_ key: String) -> [String: Any]? { rows.first { $0["key"] as? String == key } }
        XCTAssertEqual(row("mcp.token")?["value"] as? String, "(redacted)")
        XCTAssertEqual(row("mcp.token")?["writable"] as? Bool, false)
        XCTAssertEqual(row("agent.unconfined")?["value"] as? Bool, false, "security settings are readable")
        XCTAssertEqual(row("agent.unconfined")?["writable"] as? Bool, false)
        XCTAssertEqual(row("mcp.port")?["value"] as? Int, 7420)
        XCTAssertFalse((row("images.fal_key")?["value"] as? String ?? "").contains("sk-"))
        XCTAssertEqual(row("updates.automatic_checks")?["writable"] as? Bool, true)
        XCTAssertEqual(row("images.default_model")?["writable"] as? Bool, true)
        let details = try XCTUnwrap(snapshot["details"] as? [String: Any])
        XCTAssertEqual((details["image_models"] as? [[String: Any]])?.count, 2)
    }
}

@MainActor
final class LiveAppControlTests: XCTestCase {
    func testPackagePathsMustBeAbsoluteAndGetTheExtension() throws {
        XCTAssertEqual(try LiveAppControl.packageURL("/tmp/Acme").lastPathComponent, "Acme.ocelot")
        XCTAssertEqual(try LiveAppControl.packageURL("/tmp/Acme.ocelot").lastPathComponent, "Acme.ocelot")
        XCTAssertEqual(try LiveAppControl.packageURL("/tmp/Old.atelier").lastPathComponent, "Old.atelier")
        XCTAssertEqual(try LiveAppControl.packageURL("~/Designs/X").path, NSHomeDirectory() + "/Designs/X.ocelot")
        XCTAssertThrowsError(try LiveAppControl.packageURL("relative/Acme")) { XCTAssertTrue("\($0)".contains("absolute")) }
    }

    func testWindowFramesRoundTripBetweenAppKitAndTopLeftCoordinates() throws {
        let frame = NSRect(x: 100, y: 200, width: 800, height: 600)
        let top = LiveAppControl.topLeftFrame(frame)
        let back = LiveAppControl.appKitFrame(x: try XCTUnwrap(top["x"]), y: try XCTUnwrap(top["y"]), width: try XCTUnwrap(top["width"]), height: try XCTUnwrap(top["height"]))
        XCTAssertEqual(back.origin.x, frame.origin.x, accuracy: 1)
        XCTAssertEqual(back.origin.y, frame.origin.y, accuracy: 1)
    }
}
