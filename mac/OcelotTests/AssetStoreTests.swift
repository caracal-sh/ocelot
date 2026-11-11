import XCTest
@testable import Ocelot

final class AssetStoreTests: XCTestCase {
    private var dir: URL!
    private var package: URL!
    private var root: AssetRoot!
    private var store: AssetStore!

    override func setUpWithError() throws {
        dir = try makeTempDirectory()
        package = dir.appendingPathComponent("Doc.ocelot")
        root = AssetRoot(package)
        store = AssetStore(root: root)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private var assetsDir: URL { package.appendingPathComponent("assets") }

    func testImportHashesSniffsAndWritesFileAndManifest() async throws {
        let png = TestImages.png(width: 3, height: 2)
        let record = try await store.importData(png, AssetMetadata(name: "dot", prompt: "a dot", provider: "fal", model: "x"))
        XCTAssertEqual(record.id, AssetPackage.sha256Hex(png))
        XCTAssertEqual(record.id.count, 64)
        XCTAssertEqual(record.ext, "png")
        XCTAssertEqual(record.mime, "image/png")
        XCTAssertEqual(record.bytes, png.count)
        XCTAssertEqual(record.width, 3)
        XCTAssertEqual(record.height, 2)
        XCTAssertEqual(record.kind, "upload")
        XCTAssertEqual(record.prompt, "a dot")
        XCTAssertEqual(try Data(contentsOf: assetsDir.appendingPathComponent("\(record.id).png")), png)
        // ISO 8601 with milliseconds
        XCTAssertNotNil(ISO8601DateFormatter().date(from: String(record.created.prefix(19)) + "Z"))

        let manifest = try JSONDecoder().decode(AssetManifest.self, from: Data(contentsOf: assetsDir.appendingPathComponent("manifest.json")))
        XCTAssertEqual(manifest.version, 1)
        XCTAssertEqual(manifest.assets, [record])
    }

    func testIdenticalBytesImportOnceAndFirstRecordWins() async throws {
        let png = TestImages.png()
        let first = try await store.importData(png, AssetMetadata(name: "first", kind: "generated", prompt: "one"))
        let second = try await store.importData(png, AssetMetadata(name: "second", kind: "upload"))
        XCTAssertEqual(first, second)
        XCTAssertEqual(second.name, "first")
        let list = try await store.list()
        XCTAssertEqual(list.count, 1)
        let files = try FileManager.default.contentsOfDirectory(atPath: assetsDir.path).filter { $0 != "manifest.json" }
        XCTAssertEqual(files.count, 1)
    }

    func testManifestRoundTripsThroughANewStoreWithAllMetadata() async throws {
        let meta = AssetMetadata(
            name: "hero", kind: "edited", prompt: "make it blue", provider: "codex", model: "chatgpt-image", seed: 42,
            sources: ["a", "b"], params: .object(["aspect": .string("16:9"), "n": .number(2)])
        )
        let record = try await store.importData(TestImages.png(red: 10), meta)
        let jpeg = try await store.importData(TestImages.jpeg())

        let reopened = AssetStore(root: AssetRoot(package))
        let list = try await reopened.list()
        XCTAssertEqual(list, [record, jpeg].sorted { $0.created < $1.created })
        let found = try XCTUnwrap(list.first { $0.id == record.id })
        XCTAssertEqual(found.seed, 42)
        XCTAssertEqual(found.sources, ["a", "b"])
        XCTAssertEqual(found.params, .object(["aspect": .string("16:9"), "n": .number(2)]))
        XCTAssertEqual(jpeg.ext, "jpg")
        XCTAssertEqual(jpeg.width, 5)
    }

    func testReadReturnsBytesAndRefusesUnknownOrMalformedIds() async throws {
        let png = TestImages.png()
        let record = try await store.importData(png)
        let read = try await store.read(record.id)
        XCTAssertEqual(read.data, png)
        XCTAssertEqual(read.record, record)

        for bad in ["nope", String(repeating: "0", count: 64), "../../etc/passwd", record.id.uppercased()] {
            do {
                _ = try await store.read(bad)
                XCTFail("expected failure for \(bad)")
            } catch let failure as BridgeFailure {
                XCTAssertEqual(failure.code, .invalidParams)
                XCTAssertTrue(failure.message.contains("list_assets"), failure.message)
            }
        }
    }

    func testDeleteRemovesFilesAndEntries() async throws {
        let a = try await store.importData(TestImages.png(red: 1))
        let b = try await store.importData(TestImages.png(red: 2))
        let remaining = try await store.delete([a.id, "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"])
        XCTAssertEqual(remaining.map(\.id), [b.id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: assetsDir.appendingPathComponent("\(a.id).png").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: assetsDir.appendingPathComponent("\(b.id).png").path))
        let reopened = try await AssetStore(root: AssetRoot(package)).list()
        XCTAssertEqual(reopened.map(\.id), [b.id])
    }

    func testRejectsNonImagesEmptyDataAndUnknownKinds() async throws {
        for data in [Data(), Data("hello world".utf8), Data(repeating: 7, count: 100)] {
            do {
                _ = try await store.importData(data)
                XCTFail("expected a failure")
            } catch let failure as BridgeFailure {
                XCTAssertEqual(failure.code, .invalidParams)
            }
        }
        do {
            _ = try await store.importData(TestImages.png(), AssetMetadata(kind: "screenshot"))
            XCTFail("expected a failure")
        } catch let failure as BridgeFailure {
            XCTAssertTrue(failure.message.contains("background_removed"))
        }
        let list = try await store.list()
        XCTAssertTrue(list.isEmpty)
    }

    func testSniffingCoversEveryFormatAndSVGSize() async throws {
        XCTAssertEqual(ImageSniffer.sniff(TestImages.png()), ImageSniffer.png)
        XCTAssertEqual(ImageSniffer.sniff(TestImages.jpeg()), ImageSniffer.jpeg)
        XCTAssertEqual(ImageSniffer.sniff(TestImages.gifHeader), ImageSniffer.gif)
        XCTAssertEqual(ImageSniffer.sniff(TestImages.webpHeader), ImageSniffer.webp)
        XCTAssertEqual(ImageSniffer.sniff(TestImages.avifHeader), ImageSniffer.avif)
        XCTAssertEqual(ImageSniffer.sniff(TestImages.svg), ImageSniffer.svg)
        XCTAssertNil(ImageSniffer.sniff(Data("<html><body>hi</body></html>".utf8)))
        XCTAssertNil(ImageSniffer.sniff(Data("plain text".utf8)))

        let svg = try await store.importData(TestImages.svg)
        XCTAssertEqual(svg.ext, "svg")
        XCTAssertEqual(svg.mime, "image/svg+xml")
        XCTAssertEqual(svg.width, 120)
        XCTAssertEqual(svg.height, 80)
        let viewBox = try await store.importData(TestImages.svgViewBoxOnly)
        XCTAssertEqual(viewBox.width, 24)
        XCTAssertEqual(viewBox.height, 16)
        let unsized = try await store.importData(Data("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"50%\"></svg>".utf8))
        XCTAssertNil(unsized.width)
        XCTAssertNil(unsized.height)
    }

    func testMissingManifestIsRebuiltFromFilesAndCorruptOneIsMovedAside() async throws {
        let record = try await store.importData(TestImages.png())
        let manifest = assetsDir.appendingPathComponent("manifest.json")
        try FileManager.default.removeItem(at: manifest)
        let rebuilt = try await AssetStore(root: AssetRoot(package)).list()
        XCTAssertEqual(rebuilt.map(\.id), [record.id])
        XCTAssertEqual(rebuilt.first?.width, 3)

        try Data("{ not json".utf8).write(to: manifest)
        let afterCorrupt = try await AssetStore(root: AssetRoot(package)).list()
        XCTAssertEqual(afterCorrupt.map(\.id), [record.id])
        XCTAssertTrue(FileManager.default.fileExists(atPath: assetsDir.appendingPathComponent("manifest.corrupt.json").path))
    }

    // MARK: Untrusted manifests

    private func record(_ id: String, ext: String, mime: String = "image/png") -> AssetRecord {
        AssetRecord(id: id, ext: ext, mime: mime, bytes: 3, created: "2026-11-09T00:00:00.000Z", kind: "upload")
    }

    func testManifestRecordsThatNameFilesOutsideAssetsAreDroppedAndNeverReadOrDeleted() async throws {
        let secret = dir.appendingPathComponent("secret.txt")
        try Data("secret".utf8).write(to: secret)
        let id = String(repeating: "a", count: 64)
        // `assets/<id>.x/` is a real directory, so `<id>.x/../../../secret.txt` resolves to the file outside the package.
        try FileManager.default.createDirectory(at: assetsDir.appendingPathComponent("\(id).x"), withIntermediateDirectories: true)
        let traversing = record(id, ext: "x/../../../secret.txt")
        let badId = record("../../secret", ext: "png")
        let upper = record(String(repeating: "A", count: 64), ext: "png")
        let weird = record(String(repeating: "b", count: 64), ext: "exe")
        try AssetPackage.saveManifest([traversing, badId, upper, weird], in: assetsDir)

        let listed = try await store.list()
        XCTAssertEqual(listed, [])
        for bad in [id, badId.id, upper.id, weird.id] {
            do { _ = try await store.read(bad); XCTFail("read must refuse \(bad)") } catch is BridgeFailure {}
            do { _ = try await store.fileURL(bad); XCTFail("fileURL must refuse \(bad)") } catch is BridgeFailure {}
        }
        _ = try await store.delete([id, badId.id])
        XCTAssertEqual(try Data(contentsOf: secret), Data("secret".utf8))
        XCTAssertNil(AssetPackage.fileURL(for: traversing, in: assetsDir))
    }

    func testManifestMimeIsDerivedFromTheExtensionAndDuplicateIdsCollapse() async throws {
        let png = try await store.importData(TestImages.png())
        var forged = png
        forged.mime = "text/html"
        try AssetPackage.saveManifest([forged, forged], in: assetsDir)
        let list = try await AssetStore(root: AssetRoot(package)).list()
        XCTAssertEqual(list.map(\.mime), ["image/png"])
    }

    func testSymlinkedAssetFilesAreNotFollowedByReadDeleteOrAdopt() async throws {
        let secret = dir.appendingPathComponent("secret.txt")
        try Data("secret".utf8).write(to: secret)
        let id = String(repeating: "c", count: 64)
        try FileManager.default.createDirectory(at: assetsDir, withIntermediateDirectories: true)
        let link = assetsDir.appendingPathComponent("\(id).png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: secret)
        try AssetPackage.saveManifest([record(id, ext: "png")], in: assetsDir)

        do { _ = try await store.read(id); XCTFail("read must not follow a symlink") } catch let failure as BridgeFailure {
            XCTAssertEqual(failure.code, .internal)
        }
        do { _ = try await store.fileURL(id); XCTFail("fileURL must not follow a symlink") } catch is BridgeFailure {}

        let saved = dir.appendingPathComponent("Saved.ocelot")
        try await AssetStore(root: AssetRoot(saved)).adopt(from: package)
        XCTAssertFalse(FileManager.default.fileExists(atPath: saved.appendingPathComponent("assets/\(id).png").path))

        _ = try await store.delete([id])
        XCTAssertEqual(try Data(contentsOf: secret), Data("secret".utf8), "the target of the link stays")
        XCTAssertNil(try? FileManager.default.destinationOfSymbolicLink(atPath: link.path), "the link itself is removed")
    }

    func testStoreFollowsTheWindowsPackageAndAdoptCopiesAssetsOnSaveAs() async throws {
        // Untitled: images live in the recovery package; Save As moves the window to a new package.
        let recovery = dir.appendingPathComponent("Untitled-1.ocelot")
        let rootBox = AssetRoot(recovery)
        let untitled = AssetStore(root: rootBox)
        let png = TestImages.png(red: 5)
        let record = try await untitled.importData(png, AssetMetadata(name: "kept", kind: "generated"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: recovery.appendingPathComponent("assets/\(record.id).png").path))
        XCTAssertFalse(DocumentPackage.hasDocument(at: recovery), "assets alone must not make a recovery package look like a document")

        let saved = dir.appendingPathComponent("Saved.ocelot")
        // The destination already holds an unrelated asset: the merge keeps both.
        let existing = try await AssetStore(root: AssetRoot(saved)).importData(TestImages.png(red: 99))
        rootBox.set(saved)
        try await untitled.adopt(from: recovery)

        let list = try await untitled.list()
        XCTAssertEqual(Set(list.map(\.id)), [record.id, existing.id])
        XCTAssertEqual(list.first { $0.id == record.id }?.name, "kept")
        XCTAssertEqual(try Data(contentsOf: saved.appendingPathComponent("assets/\(record.id).png")), png)
        // Importing now lands in the saved package.
        let later = try await untitled.importData(TestImages.png(red: 77))
        XCTAssertTrue(FileManager.default.fileExists(atPath: saved.appendingPathComponent("assets/\(later.id).png").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: recovery.appendingPathComponent("assets/\(later.id).png").path))
    }

    func testSavingTheDocumentKeepsAssetsWithoutTouchingThem() async throws {
        let record = try await store.importData(TestImages.png())
        let file = DocumentFile(format: "ocelot", version: 1, name: "X", savedAt: "2026-11-09T00:00:00.000Z", yjs: "AAAA", tree: .object([:]))
        // The package exists with assets only (recovery shape): the first save adds document.json beside them.
        XCTAssertFalse(DocumentPackage.hasDocument(at: package))
        try DocumentPackage.write(file, to: package)
        XCTAssertTrue(DocumentPackage.hasDocument(at: package))
        XCTAssertEqual(try DocumentPackage.read(from: package), file)
        let assetFile = assetsDir.appendingPathComponent("\(record.id).png")
        let before = try FileManager.default.attributesOfItem(atPath: assetFile.path)[.systemFileNumber] as? Int
        try DocumentPackage.write(file, to: package)
        let after = try FileManager.default.attributesOfItem(atPath: assetFile.path)[.systemFileNumber] as? Int
        XCTAssertEqual(before, after, "saving must not rewrite or replace asset files")
        let list = try await store.list()
        XCTAssertEqual(list.map(\.id), [record.id])
    }

    // MARK: Export

    func testExportRefusesAbsoluteAndTraversingPaths() throws {
        for bad in ["/etc/passwd", "../x.html", "a/../../x.html", "~/x", "a\\b", "", "./", "assets/../../../x"] {
            XCTAssertThrowsError(try ExportWriter.validatePath(bad), "should refuse \(bad)") { error in
                XCTAssertEqual((error as? BridgeFailure)?.code, .invalidParams)
            }
        }
        XCTAssertEqual(try ExportWriter.validatePath("./assets//logo.png"), "assets/logo.png")
        for bad in ["", "..", ".", "a/b", "a\\b", "x:y"] {
            XCTAssertThrowsError(try ExportWriter.validateName(bad), "should refuse name \(bad)")
        }
        XCTAssertThrowsError(try ExportWriter.validate([ExportFile(path: "a.html", text: "x", assetId: String(repeating: "a", count: 64))]))
        XCTAssertThrowsError(try ExportWriter.validate([ExportFile(path: "a.html")]))
        XCTAssertThrowsError(try ExportWriter.validate([ExportFile(path: "a.png", assetId: "../../secret")]))
        XCTAssertThrowsError(try ExportWriter.validate([ExportFile(path: "a.html", text: "1"), ExportFile(path: "A.html", text: "2")]))
    }

    func testExportWritesTextAndCopiesAssetsBelowTheNamedFolder() async throws {
        let png = TestImages.png()
        let record = try await store.importData(png)
        let files = try ExportWriter.validate([
            ExportFile(path: "index.html", text: "<img src=\"./assets/\(record.id).png\">"),
            ExportFile(path: "assets/\(record.id).png", assetId: record.id),
        ])
        let chosen = dir.appendingPathComponent("chosen")
        try FileManager.default.createDirectory(at: chosen, withIntermediateDirectories: true)
        let url = try await store.fileURL(record.id)
        let folder = try ExportWriter.write(into: chosen, name: "landing", files: files, assetFiles: [record.id: url])
        XCTAssertEqual(folder.lastPathComponent, "landing")
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("assets/\(record.id).png")), png)
        XCTAssertTrue(try String(contentsOf: folder.appendingPathComponent("index.html"), encoding: .utf8).contains(record.id))
        // Exporting again replaces files in place.
        _ = try ExportWriter.write(into: chosen, name: "landing", files: files, assetFiles: [record.id: url])
    }

    func testExportCopiesBundledFontsFromTheFontsFolderOnly() throws {
        let fonts = dir.appendingPathComponent("fonts")
        try FileManager.default.createDirectory(at: fonts, withIntermediateDirectories: true)
        try Data([1, 2, 3]).write(to: fonts.appendingPathComponent("Inter-Variable.woff2"))
        try Data("OFL".utf8).write(to: fonts.appendingPathComponent("Inter-OFL.txt"))
        let files = try ExportWriter.validate([
            ExportFile(path: "fonts/Inter-Variable.woff2", font: "Inter-Variable.woff2"),
            ExportFile(path: "fonts/Inter-OFL.txt", font: "Inter-OFL.txt"),
        ])
        let chosen = dir.appendingPathComponent("chosen")
        try FileManager.default.createDirectory(at: chosen, withIntermediateDirectories: true)
        let folder = try ExportWriter.write(into: chosen, name: "themed", files: files, assetFiles: [:], fontsRoot: fonts)
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("fonts/Inter-Variable.woff2")), Data([1, 2, 3]))
        XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("fonts/Inter-OFL.txt"), encoding: .utf8), "OFL")
        for bad in ["../secret.woff2", "a/b.woff2", "Inter.ttf", "..woff2", ".hidden.woff2", ""] {
            XCTAssertThrowsError(try ExportWriter.validate([ExportFile(path: "f.woff2", font: bad)]), "should refuse \(bad)")
        }
        XCTAssertThrowsError(try ExportWriter.validate([ExportFile(path: "f.woff2", text: "x", font: "Inter-Variable.woff2")]))
        let missing = try ExportWriter.validate([ExportFile(path: "fonts/Nope.woff2", font: "Nope.woff2")])
        XCTAssertThrowsError(try ExportWriter.write(into: chosen, name: "themed2", files: missing, assetFiles: [:], fontsRoot: fonts))
        XCTAssertThrowsError(try ExportWriter.write(into: chosen, name: "themed3", files: files, assetFiles: [:], fontsRoot: nil))
    }

    func testExportWritesBase64FilesAsBytes() throws {
        let png = TestImages.png()
        let files = try ExportWriter.validate([
            ExportFile(path: "screens/home@2x.png", base64: png.base64EncodedString()),
            ExportFile(path: "HANDOFF.md", text: "# Handoff"),
        ])
        let chosen = dir.appendingPathComponent("chosen")
        try FileManager.default.createDirectory(at: chosen, withIntermediateDirectories: true)
        let folder = try ExportWriter.write(into: chosen, name: "handoff", files: files, assetFiles: [:])
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("screens/home@2x.png")), png)
        XCTAssertThrowsError(try ExportWriter.validate([ExportFile(path: "a.png", base64: "***")]))
        XCTAssertThrowsError(try ExportWriter.validate([ExportFile(path: "a.png", text: "x", base64: png.base64EncodedString())]))
    }

    func testExportWritesIntoAFolderUnderTmp() throws {
        // The save panel can hand back /private/tmp/…; Foundation's `standardizedFileURL`
        // drops the /private prefix for a folder that exists and keeps it for a file that does not exist yet.
        let chosen = URL(fileURLWithPath: "/private/tmp/ocelot-export-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: chosen, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: chosen) }
        let png = TestImages.png()
        let files = try ExportWriter.validate([ExportFile(path: "HANDOFF.md", text: "# hi"), ExportFile(path: "screens/home@2x.png", base64: png.base64EncodedString())])
        let folder = try ExportWriter.write(into: chosen, name: "handoff", files: files, assetFiles: [:])
        XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("HANDOFF.md"), encoding: .utf8), "# hi")
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("screens/home@2x.png")), png)
    }

    func testExportRefusesToWriteThroughASymlinkOutOfTheFolder() throws {
        let chosen = dir.appendingPathComponent("chosen")
        let outside = dir.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let folder = chosen.appendingPathComponent("site")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: folder.appendingPathComponent("link"), withDestinationURL: outside)
        let files = try ExportWriter.validate([ExportFile(path: "link/pwned.html", text: "x")])
        XCTAssertThrowsError(try ExportWriter.write(into: chosen, name: "site", files: files, assetFiles: [:])) { error in
            XCTAssertEqual((error as? BridgeFailure)?.code, .invalidParams)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("pwned.html").path))
    }

    func testBridgeBase64DecodingAcceptsDataURLs() {
        let png = TestImages.png()
        XCTAssertEqual(AssetBridge.decodeBase64(png.base64EncodedString()), png)
        XCTAssertEqual(AssetBridge.decodeBase64("data:image/png;base64," + png.base64EncodedString()), png)
        XCTAssertNil(AssetBridge.decodeBase64("***"))
    }

    @MainActor
    func testSessionStoreFollowsItsRecoveryPackageAndLeavesNoDocumentBehind() async throws {
        let session = DocumentSession(editor: { nil }, isEditorReady: true)
        let package = session.packageURL
        defer { try? FileManager.default.removeItem(at: package) }
        let record = try await session.assets.importData(TestImages.png(red: 42))
        XCTAssertTrue(FileManager.default.fileExists(atPath: package.appendingPathComponent("assets/\(record.id).png").path))
        XCTAssertTrue(package.path.contains("Recovery/Untitled-"))
        XCTAssertFalse(DocumentPackage.hasDocument(at: package))
    }
}
