import XCTest
@testable import Ocelot

/// The folder of the person's own slash commands: what the host lists for the editor. editor/e2e/headless-host.mjs lists the same way.
final class AgentCommandFolderTests: XCTestCase {
    private var root: URL!
    private var folder: AgentCommandFolder!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-commands-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        folder = AgentCommandFolder(url: root.appendingPathComponent("Commands", isDirectory: true))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func put(_ name: String, _ text: String = "Do it.", in directory: URL? = nil) throws {
        let dir = directory ?? folder.url
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(text.utf8).write(to: dir.appendingPathComponent(name))
    }

    private func names() throws -> [String] { try folder.list().files.map(\.name) }

    func testAMissingFolderHasNoFilesAndIsNotCreatedByListing() throws {
        let listed = try folder.list()
        XCTAssertEqual(listed.files, [])
        XCTAssertEqual(listed.folder, folder.url.path)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.url.path))
    }

    func testListsMarkdownFilesSortedByNameWithTheirText() throws {
        try put("zebra.md", "Z")
        try put("brand-check.md", "---\ndescription: Check the brand\n---\nCheck $ARGUMENTS")
        try put("Alpha.MD", "A")
        XCTAssertEqual(try folder.list().files, [
            AgentCommandFile(name: "Alpha.MD", text: "A"),
            AgentCommandFile(name: "brand-check.md", text: "---\ndescription: Check the brand\n---\nCheck $ARGUMENTS"),
            AgentCommandFile(name: "zebra.md", text: "Z"),
        ])
    }

    func testSkipsOtherFilesHiddenFilesAndSubfolders() throws {
        try put("keep.md")
        try put("notes.txt")
        try put("readme")
        try put(".hidden.md")
        try put("nested.md", in: folder.url.appendingPathComponent("sub", isDirectory: true))
        try FileManager.default.createDirectory(at: folder.url.appendingPathComponent("folder.md", isDirectory: true), withIntermediateDirectories: true)
        XCTAssertEqual(try names(), ["keep.md"])
    }

    func testSkipsFilesOverTheSizeLimitAndKeepsOnesAtIt() throws {
        try put("exact.md", String(repeating: "a", count: AgentCommandFolder.maxFileBytes))
        try put("big.md", String(repeating: "a", count: AgentCommandFolder.maxFileBytes + 1))
        XCTAssertEqual(try names(), ["exact.md"])
    }

    func testSkipsFilesThatAreNotUTF8() throws {
        try put("good.md", "héllo")
        try FileManager.default.createDirectory(at: folder.url, withIntermediateDirectories: true)
        try Data([0x68, 0xFF, 0xFE, 0x69]).write(to: folder.url.appendingPathComponent("bad.md"))
        XCTAssertEqual(try folder.list().files, [AgentCommandFile(name: "good.md", text: "héllo")])
    }

    func testListsAtMostTwoHundredFiles() throws {
        for i in 0..<(AgentCommandFolder.maxFiles + 5) { try put(String(format: "c%03d.md", i)) }
        let listed = try names()
        XCTAssertEqual(listed.count, AgentCommandFolder.maxFiles)
        XCTAssertEqual(listed.first, "c000.md")
        XCTAssertEqual(listed.last, "c199.md")
    }

    func testASymlinkCountsOnlyWhenItPointsAtARegularFile() throws {
        try put("target.md", "real", in: root.appendingPathComponent("elsewhere", isDirectory: true))
        try put("plain.md")
        let fm = FileManager.default
        try fm.createSymbolicLink(at: folder.url.appendingPathComponent("linked.md"), withDestinationURL: root.appendingPathComponent("elsewhere/target.md"))
        try fm.createSymbolicLink(at: folder.url.appendingPathComponent("dir.md"), withDestinationURL: root.appendingPathComponent("elsewhere", isDirectory: true))
        try fm.createSymbolicLink(at: folder.url.appendingPathComponent("dangling.md"), withDestinationURL: root.appendingPathComponent("nothing.md"))
        XCTAssertEqual(try folder.list().files, [AgentCommandFile(name: "linked.md", text: "real"), AgentCommandFile(name: "plain.md", text: "Do it.")])
    }

    func testCreateMakesTheFolderWorldReadableAndKeepsAnExistingOne() throws {
        try folder.create()
        var isDirectory: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.url.path, isDirectory: &isDirectory))
        XCTAssertTrue(isDirectory.boolValue)
        let mode = (try FileManager.default.attributesOfItem(atPath: folder.url.path)[.posixPermissions] as? NSNumber)?.intValue
        XCTAssertEqual(mode, 0o755)
        try put("keep.md")
        try folder.create()
        XCTAssertEqual(try names(), ["keep.md"])
    }

    func testCommandNamesAreTheValidFileNamesWithoutTheExtension() throws {
        try put("brand-check.md")
        try put("review2.md")
        try put("Mixed.md")
        try put("2fast.md")
        try put("has space.md")
        try put("under_score.md")
        XCTAssertEqual(try folder.commandNames(), ["brand-check", "review2"])
    }

    func testTheStandardFolderIsInApplicationSupport() {
        XCTAssertTrue(AgentCommandFolder.standard().url.path.hasSuffix("/Library/Application Support/Ocelot/Commands"))
    }
}
