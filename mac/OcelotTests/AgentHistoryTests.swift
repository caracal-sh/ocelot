import XCTest
@testable import Ocelot

/// The saved sidebar conversations: owner-only storage per project, outside the document. editor/e2e/agent-history.test.mjs
/// covers the same layout for the headless host.
final class AgentHistoryTests: XCTestCase {
    private var root: URL!
    private var store: AgentHistoryStore!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-history-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = AgentHistoryStore(root: root)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func mode(_ url: URL) throws -> Int {
        (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    func testListsNothingForAProjectThatNeverChatted() throws {
        XCTAssertEqual(try store.list(projectId: "p1"), [])
        XCTAssertNil(try store.read(projectId: "p1", id: "c1").text)
    }

    func testStoresSummaryAndTranscriptPerConversationAndPerProject() throws {
        try store.write(projectId: "p1", id: "c1", meta: "{\"title\":\"One\"}", transcript: "{\"items\":[1]}")
        try store.write(projectId: "p1", id: "c2", meta: "{\"title\":\"Two\"}", transcript: "{\"items\":[2]}")
        try store.write(projectId: "p2", id: "c3", meta: "{\"title\":\"Other\"}", transcript: "{}")
        XCTAssertEqual(try store.list(projectId: "p1"), [AgentHistoryEntry(id: "c1", meta: "{\"title\":\"One\"}"), AgentHistoryEntry(id: "c2", meta: "{\"title\":\"Two\"}")])
        XCTAssertEqual(try store.read(projectId: "p1", id: "c1").text, "{\"items\":[1]}")
    }

    func testKeepsTheTranscriptWhenOnlyTheSummaryChanges() throws {
        try store.write(projectId: "p1", id: "c1", meta: "{\"title\":\"A\"}", transcript: "{\"items\":[1]}")
        try store.write(projectId: "p1", id: "c1", meta: "{\"title\":\"B\"}", transcript: nil)
        XCTAssertEqual(try store.read(projectId: "p1", id: "c1").text, "{\"items\":[1]}")
        XCTAssertEqual(try store.list(projectId: "p1").first?.meta, "{\"title\":\"B\"}")
    }

    func testEverythingIsOwnerOnly() throws {
        try store.write(projectId: "p1", id: "c1", meta: "{}", transcript: "{}")
        let session = try store.sessionDirectory(projectId: "p1", conversationId: "c1")
        let history = root.resolvingSymlinksInPath().appendingPathComponent("history/p1")
        XCTAssertEqual(try mode(history), 0o700)
        XCTAssertEqual(try mode(history.appendingPathComponent("c1.meta.json")), 0o600)
        XCTAssertEqual(try mode(history.appendingPathComponent("c1.transcript.json")), 0o600)
        XCTAssertEqual(try mode(session), 0o700)
        XCTAssertEqual(try mode(session.deletingLastPathComponent()), 0o700) // the project's folder under conversations/
    }

    /// The agent gets the conversation directory and nothing that holds transcripts.
    func testSessionDirectoryIsOneConversationFolderApartFromTheTranscripts() throws {
        let session = try store.sessionDirectory(projectId: "p1", conversationId: "c1")
        let base = root.resolvingSymlinksInPath().path
        XCTAssertEqual(session.path, "\(base)/conversations/p1/c1")
        XCTAssertTrue(AgentConversationPaths.isSessionDirectory(session.path, agentFolder: base))
        XCTAssertFalse(session.path.hasPrefix("\(base)/history"))
    }

    func testDeleteRemovesSummaryTranscriptAndSessionOfThatConversationOnly() throws {
        try store.write(projectId: "p1", id: "c1", meta: "{}", transcript: "{}")
        try store.write(projectId: "p1", id: "c2", meta: "{}", transcript: "{}")
        let s1 = try store.sessionDirectory(projectId: "p1", conversationId: "c1")
        let s2 = try store.sessionDirectory(projectId: "p1", conversationId: "c2")
        try "x".write(to: s1.appendingPathComponent("a.jsonl"), atomically: true, encoding: .utf8)
        try "y".write(to: s2.appendingPathComponent("b.jsonl"), atomically: true, encoding: .utf8)
        try store.remove(projectId: "p1", id: "c1")
        XCTAssertEqual(try store.list(projectId: "p1").map(\.id), ["c2"])
        XCTAssertNil(try store.read(projectId: "p1", id: "c1").text)
        XCTAssertFalse(FileManager.default.fileExists(atPath: s1.path))
        XCTAssertEqual(try String(contentsOf: s2.appendingPathComponent("b.jsonl"), encoding: .utf8), "y")
        XCTAssertNoThrow(try store.remove(projectId: "p1", id: "c1")) // already gone
    }

    func testRefusesIdsThatArePaths() {
        for bad in ["../x", "a/b", "", "a.b", String(repeating: "x", count: 65)] {
            XCTAssertThrowsError(try store.write(projectId: "p1", id: bad, meta: "{}", transcript: "{}"), bad)
            XCTAssertThrowsError(try store.remove(projectId: "p1", id: bad), bad)
            XCTAssertThrowsError(try store.sessionDirectory(projectId: "p1", conversationId: bad), bad)
            XCTAssertThrowsError(try store.list(projectId: bad), bad)
        }
        XCTAssertThrowsError(try store.read(projectId: "..", id: "c1"))
    }

    func testRefusesAnOversizedSummary() {
        XCTAssertThrowsError(try store.write(projectId: "p1", id: "c1", meta: String(repeating: "x", count: AgentHistoryStore.maxMetaBytes + 1), transcript: "{}"))
    }

    func testListSkipsStrayFiles() throws {
        try store.write(projectId: "p1", id: "c1", meta: "{}", transcript: "{}")
        let dir = root.resolvingSymlinksInPath().appendingPathComponent("history/p1")
        try "x".write(to: dir.appendingPathComponent("stray.txt"), atomically: true, encoding: .utf8)
        try "{}".write(to: dir.appendingPathComponent("bad id.meta.json"), atomically: true, encoding: .utf8)
        XCTAssertEqual(try store.list(projectId: "p1").map(\.id), ["c1"])
    }
}
