import XCTest
@testable import Ocelot

final class DocumentPackageTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func sample(name: String = "Pricing") -> DocumentFile {
        DocumentFile(
            format: "ocelot", version: 1, name: name, savedAt: "2026-11-08T00:00:00.000Z",
            yjs: "AAAA", tree: .object(["artboards": .array([.string("n_1")])])
        )
    }

    func testWriteThenReadRoundTrips() throws {
        let url = dir.appendingPathComponent("Pricing.ocelot")
        try DocumentPackage.write(sample(), to: url)
        var isDir: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir))
        XCTAssertTrue(isDir.boolValue, "package must be a directory")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.appendingPathComponent("document.json").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.appendingPathComponent("assets").path))
        XCTAssertEqual(try DocumentPackage.read(from: url), sample())
    }

    func testCurrentPageIdRoundTrips() throws {
        let url = dir.appendingPathComponent("Pages.ocelot")
        var file = sample()
        file.version = 2
        file.currentPageId = "p_k3j9x2a1"
        try DocumentPackage.write(file, to: url)
        XCTAssertEqual(try DocumentPackage.read(from: url).currentPageId, "p_k3j9x2a1")
        // A file saved before pages has none.
        XCTAssertNil(try { try DocumentPackage.write(sample(), to: url); return try DocumentPackage.read(from: url).currentPageId }())
    }

    func testOverwriteKeepsAssets() throws {
        let url = dir.appendingPathComponent("A.ocelot")
        try DocumentPackage.write(sample(), to: url)
        let asset = url.appendingPathComponent("assets/logo.png")
        try Data([1, 2, 3]).write(to: asset)
        try DocumentPackage.write(sample(name: "B"), to: url)
        XCTAssertEqual(try Data(contentsOf: asset), Data([1, 2, 3]))
        XCTAssertEqual(try DocumentPackage.read(from: url).name, "B")
    }

    func testJSONIsReadableAndStable() throws {
        let json = String(decoding: try DocumentPackage.encode(sample()), as: UTF8.self)
        XCTAssertTrue(json.contains("\n"), "pretty printed for diffs")
        XCTAssertLessThan(json.range(of: "\"format\"")!.lowerBound, json.range(of: "\"name\"")!.lowerBound, "sorted keys")
    }

    func testReadingAFolderWithoutDocumentJSONExplainsTheProblem() throws {
        let url = dir.appendingPathComponent("Empty.ocelot")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        XCTAssertThrowsError(try DocumentPackage.read(from: url)) { error in
            XCTAssertTrue(error.localizedDescription.contains("not an Ocelot document"))
        }
    }
}
