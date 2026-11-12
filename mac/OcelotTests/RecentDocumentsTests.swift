import AppKit
import XCTest
@testable import Ocelot

@MainActor
final class RecentDocumentsTests: XCTestCase {
    private var dir: URL!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-recents-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        suite = TestDefaults.name("recents")
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDownWithError() throws {
        TestDefaults.remove(suite)
        try? FileManager.default.removeItem(at: dir)
    }

    private func makePackage(_ name: String) throws -> URL {
        let url = dir.appendingPathComponent("\(name).ocelot")
        let file = DocumentFile(format: "ocelot", version: 1, name: name, savedAt: "2026-11-09T00:00:00.000Z", yjs: "AAAA", tree: .object([:]))
        try DocumentPackage.write(file, to: url)
        return url
    }

    private func store() -> RecentDocuments {
        let recovery = recoveryDir
        return RecentDocuments(defaults: defaults, notifySystem: false, recoveryDirectory: { recovery })
    }

    // MARK: RecentList

    func testNoteMovesToFrontAndDeduplicates() {
        var list = RecentList()
        let t = Date(timeIntervalSince1970: 0)
        list.note(RecentEntry(path: "/a/One.ocelot", bookmark: nil, lastOpened: t))
        list.note(RecentEntry(path: "/a/Two.ocelot", bookmark: nil, lastOpened: t))
        list.note(RecentEntry(path: "/a/../a/One.ocelot", bookmark: nil, lastOpened: t.addingTimeInterval(5)))
        XCTAssertEqual(list.entries.map(\.path), ["/a/../a/One.ocelot", "/a/Two.ocelot"])
        XCTAssertEqual(list.entries.first?.lastOpened, t.addingTimeInterval(5))
    }

    func testListKeepsTheNewest24() {
        var list = RecentList()
        for i in 0..<(RecentList.limit + 6) {
            list.note(RecentEntry(path: "/docs/Doc\(i).ocelot", bookmark: nil, lastOpened: Date(timeIntervalSince1970: Double(i))))
        }
        XCTAssertEqual(list.entries.count, 24)
        XCTAssertEqual(list.entries.first?.path, "/docs/Doc29.ocelot")
        XCTAssertEqual(list.entries.last?.path, "/docs/Doc6.ocelot")
    }

    func testPruningDropsMissingKeepsOrderAndRepointsMovedFiles() {
        let t = Date()
        let list = RecentList(entries: [
            RecentEntry(path: "/a/Gone.ocelot", bookmark: nil, lastOpened: t),
            RecentEntry(path: "/a/Old.ocelot", bookmark: nil, lastOpened: t),
            RecentEntry(path: "/a/Kept.ocelot", bookmark: nil, lastOpened: t),
            RecentEntry(path: "/a/Kept.ocelot", bookmark: nil, lastOpened: t),
        ])
        let pruned = list.pruned { entry in
            switch entry.path {
            case "/a/Gone.ocelot": nil
            case "/a/Old.ocelot": URL(fileURLWithPath: "/b/New.ocelot")
            default: URL(fileURLWithPath: entry.path)
            }
        }
        XCTAssertEqual(pruned.entries.map(\.path), ["/b/New.ocelot", "/a/Kept.ocelot"])
    }

    func testDocumentsOnAnUnmountedVolumeAreKeptButMissingOnesAreDropped() throws {
        let offline = RecentEntry(path: "/Volumes/OcelotNoSuchDisk-\(UUID().uuidString)/Work/Doc.ocelot", bookmark: nil, lastOpened: Date())
        XCTAssertEqual(RecentDocuments.resolve(offline)?.path, offline.path, "the disk may just be unplugged")
        let gone = RecentEntry(path: dir.appendingPathComponent("Gone.ocelot").path, bookmark: nil, lastOpened: Date())
        XCTAssertNil(RecentDocuments.resolve(gone), "a missing package on a mounted disk is dropped")
        XCTAssertFalse(RecentDocuments.isOnUnmountedVolume("/Volumes"), "no volume name, nothing to be unmounted")
    }

    // MARK: Store

    func testNotedDocumentsListNewestFirstAndSurviveRelaunch() throws {
        let one = try makePackage("One"), two = try makePackage("Two")
        let recents = store()
        recents.note(one, date: Date(timeIntervalSince1970: 100))
        recents.note(two, date: Date(timeIntervalSince1970: 200))
        XCTAssertEqual(recents.items.map(\.name), ["Two", "One"])
        XCTAssertEqual(store().items.map(\.name), ["Two", "One"], "a new store reads what the last one persisted")
        XCTAssertEqual(recents.items.first?.folder, dir.lastPathComponent)
    }

    func testLegacyAtelierDocumentsAreListedUnderTheirOwnPath() throws {
        let legacy = dir.appendingPathComponent("Old.atelier")
        try DocumentPackage.write(DocumentFile(format: "atelier", version: 2, name: "Old", savedAt: "2026-11-09T00:00:00Z", yjs: "AAAA", tree: .object([:])), to: legacy)
        let current = try makePackage("New")
        let recents = store()
        recents.note(legacy)
        recents.note(current)
        let reloaded = store()
        XCTAssertEqual(reloaded.items.map(\.name), ["New", "Old"])
        XCTAssertEqual(reloaded.items.last?.url.pathExtension, "atelier", "the entry keeps pointing at the .atelier file")
    }

    func testMissingDocumentsAreDroppedOnLoad() throws {
        let keep = try makePackage("Keep"), lose = try makePackage("Lose")
        let recents = store()
        recents.note(keep)
        recents.note(lose)
        try FileManager.default.removeItem(at: lose)
        XCTAssertEqual(store().items.map(\.name), ["Keep"])
        recents.reload()
        XCTAssertEqual(recents.items.map(\.name), ["Keep"])
    }

    func testAFolderWithoutDocumentJSONIsNotListed() throws {
        let bare = dir.appendingPathComponent("Bare.ocelot")
        try FileManager.default.createDirectory(at: bare, withIntermediateDirectories: true)
        let recents = store()
        recents.note(bare)
        XCTAssertEqual(store().items, [])
    }

    func testRenamedDocumentIsFoundThroughItsBookmark() throws {
        let original = try makePackage("Before")
        let recents = store()
        recents.note(original)
        let renamed = dir.appendingPathComponent("After.ocelot")
        try FileManager.default.moveItem(at: original, to: renamed)
        let reloaded = store()
        XCTAssertEqual(reloaded.items.map(\.name), ["After"])
        XCTAssertEqual(reloaded.items.first?.url.resolvingSymlinksInPath().path, renamed.resolvingSymlinksInPath().path)
    }

    func testRemoveAndClear() throws {
        let one = try makePackage("One"), two = try makePackage("Two")
        let recents = store()
        recents.note(one)
        recents.note(two)
        recents.remove(one)
        XCTAssertEqual(store().items.map(\.name), ["Two"])
        recents.clear()
        XCTAssertEqual(store().items, [])
    }

    func testRecentDocumentReportsItsPreview() throws {
        let url = try makePackage("WithPreview")
        let recents = store()
        recents.note(url)
        XCTAssertNil(recents.items.first?.previewURL)
        try DocumentPackage.writePreview(Data([0x89, 0x50]), to: url)
        recents.reload()
        XCTAssertEqual(recents.items.first?.previewURL?.lastPathComponent, "preview.png")
        XCTAssertNotNil(recents.items.first?.previewStamp)
    }

    // MARK: Unsaved documents (recovery packages)

    private var recoveryDir: URL { dir.appendingPathComponent("Recovery", isDirectory: true) }

    /// An untitled document's autosave: `Untitled-<uuid>.ocelot` in the recovery folder.
    @discardableResult
    private func makeRecovery(name: String = "Untitled", savedAt: String, artboards: [String] = ["board"]) throws -> URL {
        let url = recoveryDir.appendingPathComponent("Untitled-\(UUID().uuidString).ocelot", isDirectory: true)
        let file = DocumentFile(format: "ocelot", version: 2, name: name, savedAt: savedAt, yjs: "AAAA", tree: .object(["artboards": .array(artboards.map { .string($0) })]))
        try DocumentPackage.write(file, to: url)
        return url
    }

    func testEveryUntitledDocumentWithWorkIsListedAsUnsavedNewestFirstAmongTheOthers() throws {
        let saved = try makePackage("Saved")
        let older = try makeRecovery(name: "Older", savedAt: "2026-11-09T10:00:00.000Z")
        let newer = try makeRecovery(name: "", savedAt: "2026-11-09T12:00:00.000Z")
        try makeRecovery(name: "Blank", savedAt: "2026-11-09T13:00:00.000Z", artboards: [])
        let recents = store()
        recents.note(saved, date: ISO8601DateFormatter().date(from: "2026-11-09T11:00:00Z")!)

        XCTAssertEqual(recents.items.map(\.name), ["Untitled", "Saved", "Older"], "an empty document is not listed; the others sort by date, a missing name reads Untitled")
        XCTAssertEqual(recents.items.map(\.isUnsaved), [true, false, true])
        XCTAssertEqual(recents.items[0].url.resolvingSymlinksInPath().path, newer.resolvingSymlinksInPath().path)
        XCTAssertEqual(recents.items[2].url.resolvingSymlinksInPath().path, older.resolvingSymlinksInPath().path)
        XCTAssertEqual(recents.items[2].lastOpened.timeIntervalSince1970, 1_794_218_400, accuracy: 0.5, "the date is the document's savedAt (2026-11-09 10:00 UTC)")
        XCTAssertEqual(recents.items[0].folder, "Unsaved")
        XCTAssertEqual(recents.savedCount, 1)
        XCTAssertEqual(store().items.map(\.name), ["Untitled", "Saved", "Older"], "found on disk, so they survive a relaunch with no recents entry")
    }

    func testAnUnsavedDocumentShowsItsPreviewWhenOneExists() throws {
        let url = try makeRecovery(savedAt: "2026-11-09T10:00:00.000Z")
        let recents = store()
        XCTAssertNil(recents.items.first?.previewURL)
        try DocumentPackage.writePreview(Data([0x89, 0x50]), to: url)
        recents.reload()
        XCTAssertEqual(recents.items.first?.previewURL?.lastPathComponent, "preview.png")
    }

    func testReloadSeesAnAutosaveAfterTheFirstScan() throws {
        let recents = store()
        XCTAssertTrue(recents.items.isEmpty)
        let url = try makeRecovery(name: "First", savedAt: "2026-11-09T10:00:00.000Z")
        recents.reload()
        XCTAssertEqual(recents.items.map(\.name), ["First"])
        try DocumentPackage.write(DocumentFile(format: "ocelot", version: 2, name: "Renamed", savedAt: "2026-11-09T10:05:00.000Z", yjs: "BBBB", tree: .object(["artboards": .array([.string("a")])])), to: url)
        recents.reload()
        XCTAssertEqual(recents.items.map(\.name), ["Renamed"], "a changed document.json is read again")
    }

    func testClearMenuAndRemoveNeverTouchUnsavedDocuments() throws {
        let saved = try makePackage("Saved")
        let unsaved = try makeRecovery(name: "Work", savedAt: "2026-11-09T10:00:00.000Z")
        let recents = store()
        recents.note(saved)
        recents.clear()
        XCTAssertEqual(recents.items.map(\.name), ["Work"])
        XCTAssertEqual(recents.savedCount, 0)
        recents.remove(unsaved)
        XCTAssertEqual(recents.items.map(\.name), ["Work"], "forgetting is for saved documents; the recovery copy is the only copy")
        XCTAssertTrue(DocumentPackage.hasDocument(at: unsaved))
    }

    func testDiscardingAnUnsavedDocumentDeletesItsRecoveryPackageAndNothingElse() throws {
        let saved = try makePackage("Saved")
        let unsaved = try makeRecovery(name: "Work", savedAt: "2026-11-09T10:00:00.000Z")
        let recents = store()
        recents.note(saved)
        XCTAssertFalse(recents.discardUnsaved(saved), "a saved document is never deleted from here")
        XCTAssertTrue(DocumentPackage.hasDocument(at: saved))
        XCTAssertTrue(recents.discardUnsaved(unsaved))
        XCTAssertFalse(FileManager.default.fileExists(atPath: unsaved.path))
        XCTAssertEqual(recents.items.map(\.name), ["Saved"])
    }

    func testARecoveryPackageNotedAsAFileIsListedOnlyOnce() throws {
        let unsaved = try makeRecovery(name: "Work", savedAt: "2026-11-09T10:00:00.000Z")
        let recents = store()
        recents.note(unsaved) // an older build recorded recovery packages opened by path as files
        XCTAssertEqual(recents.items.map(\.isUnsaved), [true])
    }
}

@MainActor
final class DocumentPreviewTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-preview-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func package() throws -> URL {
        let url = dir.appendingPathComponent("P.ocelot")
        try DocumentPackage.write(DocumentFile(format: "ocelot", version: 1, name: "P", savedAt: "x", yjs: "AAAA", tree: .object([:])), to: url)
        return url
    }

    private func png(width: Int, height: Int) throws -> Data {
        let rep = try XCTUnwrap(NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        return try XCTUnwrap(rep.representation(using: .png, properties: [:]))
    }

    private func size(of data: Data) throws -> (Int, Int) {
        let rep = try XCTUnwrap(NSBitmapImageRep(data: data))
        return (rep.pixelsWide, rep.pixelsHigh)
    }

    func testWritePreviewPutsPreviewPNGInThePackageAndKeepsItAcrossSaves() throws {
        let url = try package()
        let data = try png(width: 40, height: 25)
        try DocumentPackage.writePreview(data, to: url)
        let preview = DocumentPackage.previewURL(in: url)
        XCTAssertEqual(preview.lastPathComponent, "preview.png")
        XCTAssertEqual(try Data(contentsOf: preview), data)
        // Saving the document again must not drop the thumbnail.
        try DocumentPackage.write(DocumentFile(format: "ocelot", version: 1, name: "P2", savedAt: "y", yjs: "AAAA", tree: .object([:])), to: url)
        XCTAssertEqual(try Data(contentsOf: preview), data)
        XCTAssertEqual(try DocumentPackage.read(from: url).name, "P2")
    }

    func testNilPreviewRemovesAStaleOne() throws {
        let url = try package()
        try DocumentPackage.writePreview(try png(width: 4, height: 4), to: url)
        try DocumentPackage.writePreview(nil, to: url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: DocumentPackage.previewURL(in: url).path))
    }

    func testPreviewDoesNotResurrectADeletedPackage() throws {
        let url = dir.appendingPathComponent("Gone.ocelot")
        try DocumentPackage.writePreview(try png(width: 4, height: 4), to: url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testThumbnailScalesTheLongSideDownToTheLimit() throws {
        let wide = try XCTUnwrap(DocumentPreview.thumbnail(from: try png(width: 1440, height: 900)))
        XCTAssertEqual(try size(of: wide).0, 640)
        XCTAssertEqual(try size(of: wide).1, 400)
        let tall = try XCTUnwrap(DocumentPreview.thumbnail(from: try png(width: 390, height: 2400)))
        XCTAssertEqual(try size(of: tall).1, 640)
        XCTAssertEqual(try size(of: tall).0, 104)
    }

    func testSmallImagesAreKeptAsRendered() throws {
        let small = try png(width: 320, height: 200)
        XCTAssertEqual(DocumentPreview.thumbnail(from: small), small)
        XCTAssertNil(DocumentPreview.thumbnail(from: Data([1, 2, 3])))
    }
}
