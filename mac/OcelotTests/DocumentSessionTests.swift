import XCTest
@testable import Ocelot

/// Window close, app quit, recovery packages and interrupted opens of `DocumentSession`.
@MainActor
final class DocumentSessionTests: XCTestCase {
    private var dir: URL!
    private var recovery: URL!

    override func setUpWithError() throws {
        dir = try makeTempDirectory("ocelot-session-tests")
        recovery = dir.appendingPathComponent("Recovery", isDirectory: true)
        setenv("OCELOT_RECOVERY_DIR", recovery.path, 1)
    }

    override func tearDownWithError() throws {
        unsetenv("OCELOT_RECOVERY_DIR")
        try? FileManager.default.removeItem(at: dir)
    }

    /// What the fake editor answers; mutated by the tests like the person editing would.
    final class FakeEditor: @unchecked Sendable {
        private let lock = NSLock()
        private var _name = "Doc"
        private var _artboards: [String] = ["board"]
        private var _loading = false
        private var _yjs = "AAAA"
        private var _loads = 0
        var name: String { get { lock.withLock { _name } } set { lock.withLock { _name = newValue } } }
        var artboards: [String] { get { lock.withLock { _artboards } } set { lock.withLock { _artboards = newValue } } }
        /// The page is reloading: `editor.loadDocument` fails the way a missing endpoint does.
        var loading: Bool { get { lock.withLock { _loading } } set { lock.withLock { _loading = newValue } } }
        /// The document state: changes with every edit, like the real Yjs encoding.
        var yjs: String { get { lock.withLock { _yjs } } set { lock.withLock { _yjs = newValue } } }
        var loads: Int { lock.withLock { _loads } }
        func noteLoad() { lock.withLock { _loads += 1 } }
    }

    private func session(_ fake: FakeEditor, ready: Bool = true) -> DocumentSession {
        let client = EditorClient { json in
            let req = try JSONDecoder().decode(BridgeRequestEnvelope.self, from: Data(json.utf8))
            let result: JSONValue
            switch req.method {
            case EditorMethods.GetDocument.name:
                result = .object([
                    "format": .string("ocelot"), "version": .number(2), "name": .string(fake.name), "savedAt": .string("2026-11-09T00:00:00Z"),
                    "yjs": .string(fake.yjs), "tree": .object(["artboards": .array(fake.artboards.map { .string($0) })]),
                ])
            case EditorMethods.LoadDocument.name:
                if fake.loading { throw BridgeFailure(.hostUnavailable, WebBridge.pageLoadingMessage) }
                fake.noteLoad()
                result = .object([:])
            case EditorMethods.GetProjectInfo.name: result = .object(["projectId": .string("p"), "name": .string(fake.name)])
            case EditorMethods.RenderPreview.name:
                try await Task.sleep(for: .milliseconds(250))
                result = .object(["png": .string(TestImages.png().base64EncodedString())])
            default: result = .object([:])
            }
            return BridgeCoding.string(BridgeResponseEnvelope(v: BridgeSchema.version, id: req.id, ok: true, result: result, error: nil))
        }
        let s = DocumentSession(editor: { client }, isEditorReady: ready)
        s.autosaveDelay = .seconds(60) // only the close/quit flush can write in these tests
        return s
    }

    private func savedPackage(_ name: String) throws -> URL {
        let url = dir.appendingPathComponent("\(name).ocelot")
        try DocumentPackage.write(DocumentFile(format: "ocelot", version: 2, name: name, savedAt: "2026-11-09T00:00:00Z", yjs: "AAAA", tree: .object([:])), to: url)
        return url
    }

    private func recoveryPackages() -> [URL] {
        ((try? FileManager.default.contentsOfDirectory(at: recovery, includingPropertiesForKeys: nil)) ?? []).filter { $0.pathExtension == "ocelot" }
    }

    // MARK: Close and quit

    func testClosingTheWindowRightAfterAnEditKeepsTheEdit() async throws {
        let url = try savedPackage("Doc")
        let fake = FakeEditor()
        let s = session(fake)
        await s.open(url)
        fake.name = "Edited"
        s.editorReportedChange(name: "Edited") // the editor's 250 ms debounce fired, the 1.5 s autosave has not
        XCTAssertTrue(s.hasUnsavedEdits)
        XCTAssertEqual(try DocumentPackage.read(from: url).name, "Doc")

        await s.windowWillClose() // ⌘W

        XCTAssertEqual(try DocumentPackage.read(from: url).name, "Edited", "the edit survives a close right after it")
        // Reopening shows the edit.
        let again = session(FakeEditor())
        await again.open(url)
        XCTAssertEqual(try DocumentPackage.read(from: again.fileURL!).name, "Edited")
    }

    /// Documents saved while the app was called Atelier: opened, edited and saved back into the same `.atelier` package.
    func testALegacyAtelierPackageOpensAndKeepsSavingToTheSameFile() async throws {
        let url = dir.appendingPathComponent("Old.atelier")
        try DocumentPackage.write(DocumentFile(format: "atelier", version: 2, name: "Old", savedAt: "2026-11-09T00:00:00Z", yjs: "AAAA", tree: .object([:])), to: url)
        XCTAssertTrue(DocumentExtension.matches(url))
        XCTAssertTrue(DocumentPackage.openableTypes.contains(.legacyAtelierDocument))

        let fake = FakeEditor()
        let s = session(fake)
        await s.open(url)
        XCTAssertNil(s.lastError)
        XCTAssertEqual(s.fileURL?.lastPathComponent, "Old.atelier", "no silent rename on open")
        XCTAssertEqual(s.documentName, "Old")

        fake.name = "Old edited"
        s.editorReportedChange(name: "Old edited")
        await s.save()

        XCTAssertEqual(s.fileURL?.lastPathComponent, "Old.atelier", "no silent rename on save")
        XCTAssertEqual(try DocumentPackage.read(from: url).name, "Old edited", "the edit lands in the original package")
        let siblings = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0 != "Recovery" }
        XCTAssertEqual(siblings, ["Old.atelier"], "no .ocelot copy appears next to it")
    }

    func testAnAtelierEraRecoveryPackageIsStillAdopted() throws {
        try FileManager.default.createDirectory(at: recovery, withIntermediateDirectories: true)
        let legacy = recovery.appendingPathComponent("Untitled-\(UUID().uuidString).atelier", isDirectory: true)
        try DocumentPackage.write(DocumentFile(format: "atelier", version: 2, name: "Untitled", savedAt: "2026-11-09T00:00:00Z", yjs: "AAAA", tree: .object([:])), to: legacy)
        XCTAssertTrue(DocumentSession.hasUnclaimedRecoveryFile, "documents recovered from the old Application Support folder keep working")
    }

    func testQuitFlushesEveryWindow() async throws {
        let a = try savedPackage("A"), b = try savedPackage("B")
        let fakeA = FakeEditor(), fakeB = FakeEditor()
        let sa = session(fakeA), sb = session(fakeB)
        await sa.open(a)
        await sb.open(b)
        fakeA.name = "A2"; fakeB.name = "B2"
        sa.editorReportedChange(name: "A2")
        sb.editorReportedChange(name: "B2")

        await DocumentSession.flushAll([sa, sb])

        XCTAssertEqual(try DocumentPackage.read(from: a).name, "A2")
        XCTAssertEqual(try DocumentPackage.read(from: b).name, "B2")
        XCTAssertFalse(sa.hasUnsavedEdits)
    }

    func testClosingAnUntitledWindowKeepsItsWorkButNotAnEmptyDocument() async throws {
        let fake = FakeEditor()
        let withWork = session(fake)
        withWork.editorReportedChange(name: "Untitled")
        await withWork.windowWillClose()
        XCTAssertEqual(recoveryPackages().count, 1, "the only copy of unsaved work stays recoverable")

        let empty = FakeEditor()
        empty.artboards = []
        let blank = session(empty)
        blank.editorReportedChange(name: "Untitled")
        await blank.windowWillClose()
        XCTAssertEqual(recoveryPackages().count, 1, "an empty document leaves nothing behind (and does not skip Home at the next launch)")
    }

    func testAnotherWindowNeverAdoptsALiveWindowsRecoveryPackage() async throws {
        let first = session(FakeEditor())
        first.editorReportedChange(name: "Untitled")
        await first.flushPendingAutosave()
        XCTAssertEqual(recoveryPackages().count, 1)
        XCTAssertFalse(DocumentSession.hasUnclaimedRecoveryFile, "a window that is still open owns its recovery package")

        let second = session(FakeEditor(), ready: false) // ⌘N window: its first load looks for a recovery document
        await second.editorDidLoad()
        XCTAssertFalse(second.isDirty, "it started empty instead of adopting the other window's document")
    }

    // MARK: Unsaved documents (Home)

    /// An untitled document whose window closed: its recovery package is all that is left of it.
    private func closedUntitledDocument(named name: String) async throws -> URL {
        let fake = FakeEditor()
        fake.name = name
        let closed = session(fake)
        closed.editorReportedChange(name: name)
        await closed.windowWillClose()
        return try XCTUnwrap(recoveryPackages().first)
    }

    func testAnUnsavedDocumentFromHomeOpensAsUntitledAndKeepsAutosavingToItsRecoveryPackage() async throws {
        let package = try await closedUntitledDocument(named: "Pitch")
        XCTAssertTrue(DocumentSession.isRecoveryPackage(package))

        let fake = FakeEditor()
        let s = session(fake)
        XCTAssertFalse(s.shows(package))
        await s.open(package)

        XCTAssertNil(s.fileURL, "it stays untitled: there is no file to save to")
        XCTAssertEqual(s.packageURL.standardizedFileURL.path, package.standardizedFileURL.path)
        XCTAssertTrue(s.shows(package), "Home focuses this window instead of opening the document twice")
        XCTAssertEqual(s.documentName, "Pitch")
        XCTAssertFalse(s.isEmptyUntitled, "no later open may replace it")
        XCTAssertEqual(fake.loads, 1)

        fake.name = "Pitch v2"
        s.editorReportedChange(name: "Pitch v2")
        await s.windowWillClose() // ⌘W

        XCTAssertEqual(recoveryPackages().count, 1, "closing again keeps the same package and adds no copy")
        XCTAssertEqual(try DocumentPackage.read(from: package).name, "Pitch v2")
    }

    func testSavingAnOpenedUnsavedDocumentMovesItToARealFileAndDropsTheRecoveryCopy() async throws {
        let package = try await closedUntitledDocument(named: "Pitch")
        let s = session(FakeEditor())
        await s.open(package)

        let target = dir.appendingPathComponent("Pitch.ocelot")
        let saved = await s.saveAs(to: target)

        XCTAssertTrue(saved)
        XCTAssertEqual(s.fileURL?.lastPathComponent, "Pitch.ocelot")
        XCTAssertTrue(DocumentPackage.hasDocument(at: target))
        XCTAssertTrue(recoveryPackages().isEmpty, "the recovery copy goes once the document has a file")
    }

    func testAFailedOpenOfAnUnsavedDocumentLeavesTheWindowAsItWas() async throws {
        let package = try await closedUntitledDocument(named: "Pitch")
        try FileManager.default.removeItem(at: package.appendingPathComponent(DocumentPackage.documentFileName))
        let s = session(FakeEditor())
        let before = s.packageURL
        await s.open(package)
        XCTAssertNotNil(s.lastError)
        XCTAssertEqual(s.packageURL, before)
    }

    // MARK: Autosave coverage

    func testAnEditTheEditorHasNotReportedYetIsStillWrittenWhenTheWindowCloses() async throws {
        let url = try savedPackage("Doc")
        let fake = FakeEditor()
        let s = session(fake)
        await s.open(url)
        XCTAssertFalse(s.hasUnsavedEdits)

        fake.name = "Late edit"
        fake.yjs = "BBBB" // the editor's 250 ms debounce has not fired: the host was never told
        await s.windowWillClose()

        XCTAssertEqual(try DocumentPackage.read(from: url).name, "Late edit")
    }

    func testNothingIsWrittenOnCloseOrQuitWhenTheEditorHoldsWhatIsOnDisk() async throws {
        let url = try savedPackage("Doc")
        let fake = FakeEditor()
        let s = session(fake)
        await s.open(url)
        fake.name = "Not a change: same document state"
        await s.windowWillClose()
        await DocumentSession.flushAll([s])
        XCTAssertEqual(try DocumentPackage.read(from: url).name, "Doc")
    }

    func testQuitWritesAnEditNoWindowHasReportedYet() async throws {
        let url = try savedPackage("Doc")
        let fake = FakeEditor()
        let s = session(fake)
        await s.open(url)
        fake.name = "Late edit"
        fake.yjs = "BBBB"
        await DocumentSession.flushAll([s])
        XCTAssertEqual(try DocumentPackage.read(from: url).name, "Late edit")
    }

    func testAnUntitledDocumentDrawnJustBeforeTheWindowClosesIsKept() async throws {
        let s = session(FakeEditor()) // an artboard exists, the editor never reported a change
        await s.windowWillClose()
        XCTAssertEqual(recoveryPackages().count, 1)

        let empty = FakeEditor()
        empty.artboards = []
        let blank = session(empty)
        await blank.windowWillClose()
        XCTAssertEqual(recoveryPackages().count, 1, "an empty document still leaves nothing behind")
    }

    // MARK: Opening

    func testOpenInterruptedByAPageReloadIsRetriedAfterTheNextLoad() async throws {
        let url = try savedPackage("Retry")
        let fake = FakeEditor()
        let s = session(fake)
        fake.loading = true
        await s.open(url)
        XCTAssertNil(s.fileURL)
        XCTAssertNil(s.lastError, "a reload is not a failure to show")
        fake.loading = false
        await s.editorDidLoad()
        XCTAssertEqual(s.fileURL, url, "the file was not dropped")
        XCTAssertEqual(fake.loads, 1)
    }

    func testAThumbnailRenderedForOneDocumentIsNeverWrittenIntoAnother() async throws {
        let a = try savedPackage("A"), b = try savedPackage("B")
        let s = session(FakeEditor())
        await s.open(a)
        await s.save() // starts the (slow) thumbnail render for A
        await s.open(b) // the window now holds another document
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertFalse(FileManager.default.fileExists(atPath: DocumentPackage.previewURL(in: a).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: DocumentPackage.previewURL(in: b).path))
    }

    func testReplacingTheDocumentChangesItsBindingAndNotifies() async throws {
        let s = session(FakeEditor())
        var notified = 0
        s.onDocumentReplaced = { notified += 1 }
        let before = s.binding
        await s.open(try savedPackage("Other"))
        XCTAssertNotEqual(s.binding.epoch, before.epoch)
        XCTAssertEqual(notified, 1)
        let opened = s.binding
        XCTAssertEqual(opened.package, s.packageURL)
        await s.open(try savedPackage("Third"))
        XCTAssertNotEqual(s.binding.epoch, opened.epoch)
        XCTAssertEqual(notified, 2)
    }

    // MARK: Helper processes

    func testRunningAHelperDoesNotMissAFastExitNorStallOnChattyStderr() async throws {
        for _ in 0..<20 {
            let quick = try await DocumentOpener.run(URL(fileURLWithPath: "/usr/bin/true"), [])
            XCTAssertEqual(quick.status, 0)
        }
        let loud = try await DocumentOpener.run(URL(fileURLWithPath: "/bin/sh"), ["-c", "head -c 300000 /dev/zero | tr '\\0' x >&2; exit 3"])
        XCTAssertEqual(loud.status, 3)
        XCTAssertEqual(loud.stderr.count, 300_000, "stderr is drained while the process runs, so a full pipe cannot block it")
    }
}
