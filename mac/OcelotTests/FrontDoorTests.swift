import XCTest
@testable import Ocelot

/// Run directory, token migration, project ids and "which window opens this file".
/// `InstanceDirectory` & co. are also compiled into this bundle (the container runtime tests need them), so
/// the types handed to app APIs are module-qualified.
@MainActor
final class FrontDoorTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-frontdoor-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func runDirectory() -> Ocelot.InstanceDirectory { Ocelot.InstanceDirectory(url: dir.appendingPathComponent("run", isDirectory: true)) }

    private func defaults() -> UserDefaults {
        let suite = TestDefaults.name("front-door")
        let d = UserDefaults(suiteName: suite)!
        addTeardownBlock { TestDefaults.remove(suite) }
        return d
    }

    // MARK: Discovery files

    func testPublishWritesPrivateFilesAndLivenessPrunesStaleOnes() throws {
        let run = runDirectory()
        let record = Ocelot.InstanceRecord(instance: "app-test", kind: .app, pid: Int(getpid()), started: "2026-11-09T00:00:00Z", http: "http://127.0.0.1:1", projects: [Ocelot.RunProject(id: "p1", name: "Pricing", path: "/tmp/Pricing.ocelot", windowId: "w1")])
        try run.publish(record)
        try run.writeToken("tok", instance: "app-test")
        func mode(_ url: URL) -> Int { ((try? FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions]) as? Int) ?? -1 }
        XCTAssertEqual(mode(run.url), 0o700)
        XCTAssertEqual(mode(run.recordURL("app-test")), 0o600)
        XCTAssertEqual(mode(run.tokenURL("app-test")), 0o600)
        XCTAssertEqual(run.readToken(instance: "app-test"), "tok")
        // Port 1 does not answer: the entry is stale, dropped, and the app's token file is kept.
        XCTAssertTrue(run.liveInstances().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: run.recordURL("app-test").path))
        XCTAssertEqual(run.readToken(instance: "app-test"), "tok")
    }

    func testLiveInstanceIsListedAndRejectsBadInstanceNames() throws {
        let run = runDirectory()
        let server = MCPHTTPServer(port: 0) { _, _ in HTTPResponseMessage(status: 200) }
        let ready = expectation(description: "listening")
        server.onStateChange = { if case .running = $0 { ready.fulfill() } }
        server.start()
        wait(for: [ready], timeout: 5)
        defer { server.stop() }
        guard case .running(let port) = server.state else { return XCTFail("not running") }
        try run.publish(Ocelot.InstanceRecord(instance: "headless-1", kind: .headless, pid: Int(getpid()), started: "2026-11-09T00:00:00Z", http: "http://127.0.0.1:\(port)", projects: []))
        XCTAssertEqual(run.liveInstances().map(\.instance), ["headless-1"])
        XCTAssertThrowsError(try run.writeToken("x", instance: "../escape"))
        XCTAssertNil(run.readToken(instance: "../escape"))
    }

    func testProjectMatching() {
        let projects = [Ocelot.RunProject(id: "3f2a9c10-aaaa", name: "Pricing Page"), Ocelot.RunProject(id: "77bd0000-bbbb", name: "Docs")]
        XCTAssertEqual(Ocelot.InstanceDirectory.match("3f2a", in: projects)?.name, "Pricing Page")
        XCTAssertEqual(Ocelot.InstanceDirectory.match("pricing-page", in: projects)?.id, "3f2a9c10-aaaa")
        XCTAssertEqual(Ocelot.InstanceDirectory.match("DOCS", in: projects)?.id, "77bd0000-bbbb")
        XCTAssertNil(Ocelot.InstanceDirectory.match("zzz", in: projects))
        XCTAssertNil(Ocelot.InstanceDirectory.match("3f", in: projects), "prefixes need 4+ characters")
    }

    func testKnownProjectsKeepTheNewestEntryPerPathAndId() {
        let known = KnownProjects(file: dir.appendingPathComponent("projects.json"))
        known.record(RunProject(id: "a", name: "A", path: "/x/A.ocelot"))
        known.record(RunProject(id: "b", name: "B", path: "/x/B.ocelot"))
        known.record(RunProject(id: "a2", name: "A", path: "/x/A.ocelot")) // same file, new id
        known.record(RunProject(id: "u", name: "Untitled", path: nil)) // untitled: not remembered
        XCTAssertEqual(known.all().map(\.id), ["a2", "b"])
        XCTAssertEqual(known.entry(matching: "b")?.path, "/x/B.ocelot")
    }

    // MARK: Token file and migration

    func testMasterTokenMigratesFromUserDefaultsToTheTokenFile() throws {
        let d = defaults()
        let legacy = String(repeating: "ab", count: 32)
        d.set(legacy, forKey: "mcp.token")
        let run = runDirectory()
        let service = MCPService(defaults: d, runDirectory: run, instance: "app-test", registry: EditorRegistry())
        XCTAssertEqual(service.token, legacy, "configured HTTP clients keep working")
        XCTAssertNil(run.readToken(instance: "app-test"), "nothing is written before start()")
        service.start()
        defer { service.stop() }
        XCTAssertEqual(run.readToken(instance: "app-test"), legacy)
        XCTAssertNil(d.string(forKey: "mcp.token"), "the token no longer lives in UserDefaults")
        // A new service reads the file, not the defaults.
        let again = MCPService(defaults: defaults(), runDirectory: run, instance: "app-test", registry: EditorRegistry())
        XCTAssertEqual(again.token, legacy)
        service.regenerateToken()
        XCTAssertNotEqual(service.token, legacy)
        XCTAssertEqual(run.readToken(instance: "app-test"), service.token)
        XCTAssertNotNil(service.tokens.authorize("Bearer \(service.token)"))
        XCTAssertNil(service.tokens.authorize("Bearer \(legacy)"))
    }

    func testIssueAndRevokeScopedTokens() {
        let service = MCPService(defaults: defaults(), runDirectory: runDirectory(), instance: "app-test", registry: EditorRegistry())
        let t = service.issueToken(scope: .window("W1"), readOnly: false, ttl: nil)
        XCTAssertEqual(service.tokens.authorize("Bearer \(t)")?.scope, .window("W1"))
        service.revokeToken(t)
        XCTAssertNil(service.tokens.authorize("Bearer \(t)"))
        let a = service.issueToken(scope: .window("W1"), readOnly: true, ttl: .seconds(60))
        let b = service.issueToken(scope: .project("P"), readOnly: false, ttl: nil)
        service.revokeTokens(scope: .window("W1"))
        XCTAssertNil(service.tokens.authorize("Bearer \(a)"))
        XCTAssertNotNil(service.tokens.authorize("Bearer \(b)"))
    }

    func testServiceBindsAndPublishesItsDiscoveryFile() async throws {
        let run = runDirectory()
        let service = MCPService(defaults: defaults(), runDirectory: run, instance: "app-test", registry: EditorRegistry())
        service.start()
        defer { service.stop() }
        for _ in 0..<100 { if case .running = service.state { break }; try await Task.sleep(for: .milliseconds(50)) }
        guard case .running(let port) = service.state else { return XCTFail("not running: \(service.state)") }
        let records = run.liveInstances()
        XCTAssertEqual(records.first?.instance, "app-test")
        XCTAssertEqual(records.first?.http, "http://127.0.0.1:\(port)")
        XCTAssertEqual(records.first?.kind, .app)
        service.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: run.recordURL("app-test").path), "clean exit removes the record")
        XCTAssertNotNil(run.readToken(instance: "app-test"), "the app's master token survives")
    }

    // MARK: Project ids and opening files

    /// A document session whose editor answers the project-id calls like editor/src/host/editorMethods.ts.
    private func session(projectId: String = "proj-1", loads: LoadLog? = nil, ready: Bool = true) -> DocumentSession {
        let client = EditorClient { json in
            let req = try JSONDecoder().decode(BridgeRequestEnvelope.self, from: Data(json.utf8))
            let result: JSONValue
            switch req.method {
            case EditorMethods.GetProjectInfo.name: result = .object(["projectId": .string(projectId), "name": .string("Doc")])
            case EditorMethods.RegenerateProjectId.name: result = .object(["projectId": .string("regenerated"), "name": .string("Doc")])
            case EditorMethods.LoadDocument.name:
                await loads?.record("load")
                result = .object([:])
            default: result = .object([:])
            }
            return BridgeCoding.string(BridgeResponseEnvelope(v: 1, id: req.id, ok: true, result: result, error: nil))
        }
        return DocumentSession(editor: { client }, isEditorReady: ready)
    }

    actor LoadLog {
        private(set) var events: [String] = []
        func record(_ e: String) { events.append(e) }
    }

    private func makePackage(named name: String) throws -> URL {
        let url = dir.appendingPathComponent("\(name).ocelot")
        let file = DocumentFile(format: "ocelot", version: 1, name: name, savedAt: "2026-11-09T00:00:00Z", yjs: "AAAA", tree: .object([:]), projectId: "proj-from-file")
        try DocumentPackage.write(file, to: url)
        return url
    }

    func testProjectIdRoundTripsThroughThePackage() throws {
        let url = try makePackage(named: "A")
        XCTAssertEqual(try DocumentPackage.read(from: url).projectId, "proj-from-file")
        let json = String(decoding: try DocumentPackage.encode(DocumentFile(format: "ocelot", version: 1, name: "n", savedAt: "s", yjs: "y", tree: .null)), as: UTF8.self)
        XCTAssertFalse(json.contains("projectId"), "documents without an id stay readable by older builds")
    }

    func testSessionReportsItsProjectAndRegeneratesDuplicates() async {
        let s = session()
        await s.refreshProjectInfo()
        XCTAssertEqual(s.projectId, "proj-1")
        XCTAssertEqual(s.runProject(windowId: "w")?.id, "proj-1")
        let copy = session()
        copy.projectIdInUse = { $0 == "proj-1" }
        await copy.refreshProjectInfo()
        XCTAssertEqual(copy.projectId, "regenerated", "a copied package opened next to its original gets its own id")
    }

    func testOpenBeforeTheEditorLoadedWaitsInsteadOfFailing() async throws {
        let log = LoadLog()
        let s = session(loads: log, ready: false)
        let url = try makePackage(named: "Queued")
        await s.open(url) // `onOpenURL` fires before the page loaded
        XCTAssertNil(s.fileURL)
        let early = await log.events
        XCTAssertEqual(early, [], "nothing is sent to an editor that is not there yet")
        XCTAssertTrue(s.shows(url), "a second open of the same file is recognised while it is queued")
        XCTAssertFalse(s.isEmptyUntitled)
        await s.editorDidLoad()
        XCTAssertEqual(s.fileURL, url)
        let late = await log.events
        XCTAssertEqual(late, ["load"])
        XCTAssertEqual(s.projectId, "proj-1")
        // After a reload the endpoint is gone again until the page has loaded.
        s.editorWillLoad()
        let other = try makePackage(named: "Other")
        await s.open(other)
        XCTAssertEqual(s.fileURL, url)
        await s.editorDidLoad()
        XCTAssertEqual(s.fileURL, other)
    }

    func testRouteReusesWindowsInsteadOfPilingThemUp() async throws {
        let url = try makePackage(named: "Doc")
        let existing = session(), emptyOther = session(), anotherEmpty = session()
        await existing.open(url)
        let fresh = try makePackage(named: "Fresh")
        // Already shown (or being opened) somewhere: focus that window, whoever asked.
        XCTAssertEqual(DocumentOpener.route(url: url, sessions: [existing, emptyOther]), .focus(index: 0))
        XCTAssertEqual(DocumentOpener.route(url: url, sessions: [emptyOther, existing], preferred: 0), .focus(index: 1))
        // An empty untitled window takes it: the one the request came from first, else the most recent.
        XCTAssertEqual(DocumentOpener.route(url: fresh, sessions: [existing, emptyOther, anotherEmpty]), .load(index: 2))
        XCTAssertEqual(DocumentOpener.route(url: fresh, sessions: [existing, emptyOther, anotherEmpty], preferred: 1), .load(index: 1))
        // A window with content is never replaced, even when it is the one File > Open… was used in.
        XCTAssertEqual(DocumentOpener.route(url: fresh, sessions: [existing], preferred: 0), .newWindow)
        // A request that is still waiting for the editor page counts as showing the file.
        let queued = session(ready: false)
        await queued.open(fresh)
        XCTAssertEqual(DocumentOpener.route(url: fresh, sessions: [queued]), .focus(index: 0))
    }

    /// The four states an outside request (Finder, `open -a`, `ocelot open`) can meet. It used to reach SwiftUI's scene
    /// routing, which gave it to Home: nothing opened, and with only Home on screen the app quit.
    func testOutsideOpenReachesADocumentWindowInEveryAppState() async throws {
        let url = try makePackage(named: "Outside")
        let empty = session()
        let other = try makePackage(named: "Busy")
        let busy = session()
        await busy.open(other)

        // (a) App not running yet: the request arrives before SwiftUI can open windows. It is queued, and exactly one
        // editor window opens when the opener exists; a later install does not open it again.
        let launching = HomeCoordinator()
        XCTAssertEqual(DocumentOpener.route(url: url, sessions: []), .newWindow)
        launching.start(.open(url))
        XCTAssertTrue(launching.isOpening(url))
        var cold: [String] = []
        launching.install { cold.append($0) }
        launching.install { cold.append($0) }
        XCTAssertEqual(cold, [HomeCoordinator.editorWindowID])

        // (b) Only Home is open: a new editor window, right now.
        let homeOnly = HomeCoordinator()
        var homeOpened: [String] = []
        homeOnly.install { homeOpened.append($0) }
        XCTAssertEqual(DocumentOpener.route(url: url, sessions: []), .newWindow)
        homeOnly.start(.open(url))
        XCTAssertEqual(homeOpened, [HomeCoordinator.editorWindowID])
        XCTAssertTrue(homeOnly.isOpening(url), "a repeated request while that window is being created does not open another")

        // (c) Home in front plus an editor with a document: still a new window; the document is not replaced.
        XCTAssertEqual(DocumentOpener.route(url: url, sessions: [busy]), .newWindow)
        // ... and an untitled editor next to Home takes the file instead of piling up a window.
        XCTAssertEqual(DocumentOpener.route(url: url, sessions: [busy, empty]), .load(index: 1))

        // (d) Only an editor window: a busy one gets a sibling, the same file is focused.
        XCTAssertEqual(DocumentOpener.route(url: url, sessions: [busy]), .newWindow)
        XCTAssertEqual(DocumentOpener.route(url: other, sessions: [busy]), .focus(index: 0))
    }

    func testOpenDocumentsEventCarriesTheFiles() {
        func event(_ urls: [URL]) -> NSAppleEventDescriptor {
            let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEOpenDocuments), targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
            let list = NSAppleEventDescriptor.list()
            for (index, url) in urls.enumerated() { list.insert(NSAppleEventDescriptor(fileURL: url), at: index + 1) }
            event.setParam(list, forKeyword: keyDirectObject)
            return event
        }
        let a = URL(fileURLWithPath: "/tmp/A.ocelot"), b = URL(fileURLWithPath: "/tmp/B.atelier")
        XCTAssertEqual(AppDelegate.fileURLs(in: event([a])), [a])
        XCTAssertEqual(AppDelegate.fileURLs(in: event([a, b])), [a, b])
        XCTAssertEqual(AppDelegate.fileURLs(in: event([])), [])
    }

    func testExternalWritersAreFoundByPathOrProjectId() {
        let container = Ocelot.InstanceRecord(instance: "abc", kind: .container, started: "x", http: "http://127.0.0.1:1", projects: [Ocelot.RunProject(id: "proj-9", name: "Docs", path: "/p/Docs.ocelot")])
        let app = Ocelot.InstanceRecord(instance: "app", kind: .app, started: "x", http: "http://127.0.0.1:2", projects: [Ocelot.RunProject(id: "proj-1", name: "Other", path: "/p/Other.ocelot")])
        let records = [app, container]
        XCTAssertEqual(DocumentOpener.externalWriter(for: URL(fileURLWithPath: "/p/Docs.ocelot"), records: records, packageProjectId: nil)?.record.instance, "abc")
        XCTAssertEqual(DocumentOpener.externalWriter(for: URL(fileURLWithPath: "/copy/Docs.ocelot"), records: records, packageProjectId: "proj-9")?.record.instance, "abc", "same project id inside the package")
        XCTAssertNil(DocumentOpener.externalWriter(for: URL(fileURLWithPath: "/p/Other.ocelot"), records: records, packageProjectId: "proj-1"), "windows of the app are handled by the window plan")
        XCTAssertNil(DocumentOpener.externalWriter(for: URL(fileURLWithPath: "/p/New.ocelot"), records: records, packageProjectId: nil))
    }

    // MARK: Client configs

    func testClientConfigsLaunchTheStdioProxy() {
        let claude = MCPClientConfig.render(.claude, command: "ocelot", project: "p-1", projectName: "Pricing Page")
        XCTAssertEqual(claude, "claude mcp add ocelot-pricing-page -- ocelot mcp --project p-1")
        XCTAssertTrue(MCPClientConfig.render(.claude, command: "/Applications/My App/ocelot", project: nil).contains("'/Applications/My App/ocelot'"))
        XCTAssertEqual(MCPClientConfig.renderGeneric(command: "ocelot", project: "p-1", projectName: "Pricing Page"), "Add an MCP server named ocelot-pricing-page that runs (stdio):\nocelot mcp --project p-1")
        let codex = MCPClientConfig.render(.codex, command: "ocelot", project: "p-1")
        XCTAssertTrue(codex.contains("[mcp_servers.ocelot]"))
        XCTAssertTrue(codex.contains(#"args = ["mcp", "--project", "p-1"]"#))
        for client in [MCPClientKind.cursor, .omp] {
            let text = MCPClientConfig.render(client, command: "ocelot", project: "p-1")
            let body = text.drop { $0 != "{" }
            let json = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any]
            let server = ((json?["mcpServers"] as? [String: Any])?["ocelot"]) as? [String: Any]
            XCTAssertEqual(server?["command"] as? String, "ocelot")
            XCTAssertEqual(server?["args"] as? [String], ["mcp", "--project", "p-1"])
            XCTAssertEqual(server?["type"] as? String, client == .omp ? "stdio" : nil)
        }
    }

    func testCLIInstallerLinksIntoTheInstallDirectory() throws {
        let bundled = dir.appendingPathComponent("Ocelot.app/Contents/Helpers/ocelot")
        try FileManager.default.createDirectory(at: bundled.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\n".write(to: bundled, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bundled.path)
        let home = dir.appendingPathComponent("home")
        let installer = CLIInstaller(bundled: bundled, installDirectory: home.appendingPathComponent(".local/bin"), home: home, shell: "/bin/zsh")
        XCTAssertEqual(installer.status, .notInstalled)
        XCTAssertEqual(installer.commandForConfigs, bundled.path)
        let zshrc = home.appendingPathComponent(".zshrc")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try "alias ll='ls -l'".write(to: zshrc, atomically: true, encoding: .utf8)
        XCTAssertEqual(try installer.install(), zshrc, "adds the directory to the zsh startup file")
        XCTAssertEqual(installer.status, .installed)
        XCTAssertEqual(installer.commandForConfigs, "ocelot")
        XCTAssertNil(try installer.install(), "idempotent: the PATH line is added once")
        XCTAssertEqual(try String(contentsOf: zshrc, encoding: .utf8), "alias ll='ls -l'\n\n\(CLIInstaller.pathMarker)\nexport PATH=\"$HOME/.local/bin:$PATH\"\n")
        try installer.uninstall()
        XCTAssertEqual(installer.status, .notInstalled)
        try Data().write(to: installer.link)
        XCTAssertThrowsError(try installer.install(), "never replaces a regular file")
    }

    func testCLIInstallerLeavesAnExistingPathAloneAndWritesFishSyntax() throws {
        let bundled = dir.appendingPathComponent("Ocelot.app/Contents/Helpers/ocelot")
        try FileManager.default.createDirectory(at: bundled.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\n".write(to: bundled, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bundled.path)
        let bashHome = dir.appendingPathComponent("bash-home")
        try FileManager.default.createDirectory(at: bashHome, withIntermediateDirectories: true)
        try ". \"$HOME/.local/bin/env\"\n".write(to: bashHome.appendingPathComponent(".profile"), atomically: true, encoding: .utf8)
        XCTAssertNil(try CLIInstaller(bundled: bundled, home: bashHome, shell: "/bin/bash").install(), "another installer already put ~/.local/bin on PATH")
        XCTAssertFalse(FileManager.default.fileExists(atPath: bashHome.appendingPathComponent(".bash_profile").path))

        let fishHome = dir.appendingPathComponent("fish-home")
        let fish = CLIInstaller(bundled: bundled, home: fishHome, shell: "/opt/homebrew/bin/fish")
        let file = try XCTUnwrap(try fish.install())
        XCTAssertEqual(file.lastPathComponent, "ocelot.fish")
        XCTAssertTrue(try String(contentsOf: file, encoding: .utf8).contains("fish_add_path -g \"$HOME/.local/bin\""))
    }
}
