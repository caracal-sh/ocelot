import AppKit
import XCTest
@testable import Ocelot

/// The Home prompt's attachments: what is accepted, the limits (the same as the editor's), the wire form, paste, and the hand-off
/// to the new document's agent chat.
@MainActor
final class HomeAttachmentsTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = try makeTempDirectory("ocelot-home-attachments")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func write(_ name: String, _ data: Data) throws -> URL {
        let url = dir.appendingPathComponent(name)
        try data.write(to: url)
        return url
    }

    // MARK: Types

    func testClassifiesTheSupportedImagesAndTexts() {
        for name in ["a.png", "a.JPG", "a.jpeg", "a.webp", "a.gif", "a.heic", "a.heif"] {
            XCTAssertEqual(HomeAttachment.classify(name: name)?.kind, .image, name)
        }
        for name in ["a.txt", "a.md", "a.csv", "a.json", "a.html", "a.css", "a.svg"] {
            XCTAssertEqual(HomeAttachment.classify(name: name)?.kind, .text, name)
        }
        for name in ["a.pdf", "a.zip", "a.mov", "a"] { XCTAssertNil(HomeAttachment.classify(name: name), name) }
    }

    func testAnUnsupportedFileBecomesAChipWithAnErrorThatNamesWhatIsSupported() throws {
        let item = HomeAttachment.file(try write("spec.pdf", Data("%PDF".utf8)))
        let error = try XCTUnwrap(item.error)
        XCTAssertTrue(error.contains("“spec.pdf” cannot be attached"), error)
        XCTAssertTrue(error.contains("PNG, JPEG, WebP, GIF, HEIC"), error)
        XCTAssertTrue(error.contains(".txt, .md, .csv, .json, .html, .css, .svg"), error)
    }

    func testATextFileIsReadForItsLineCount() throws {
        let item = HomeAttachment.file(try write("brief.txt", Data("Code word: kumquat\r\nsecond\r\n".utf8)))
        XCTAssertNil(item.error)
        XCTAssertEqual(item.kind, .text)
        XCTAssertEqual(item.text, "Code word: kumquat\nsecond\n")
        XCTAssertEqual(item.lines, 2)
        XCTAssertEqual(item.meta, "2 lines")
    }

    func testBinaryAndNonUTF8TextsAreRefused() throws {
        XCTAssertTrue(try XCTUnwrap(HomeAttachment.file(try write("a.txt", Data([0x61, 0x00, 0x62]))).error).contains("not a text file"))
        XCTAssertTrue(try XCTUnwrap(HomeAttachment.file(try write("b.txt", Data([0x63, 0x61, 0x66, 0xE9]))).error).contains("not UTF-8"))
    }

    func testAnImageIsKeptAsAFileAndReadOnlyWhenStartIsPressed() throws {
        let png = try write("shot.png", TestImages.png())
        let item = HomeAttachment.file(png)
        XCTAssertNil(item.error)
        XCTAssertEqual(item.content, .file(png))
        let payload = try item.payload()
        XCTAssertEqual(payload.kind, "image")
        XCTAssertEqual(payload.mimeType, "image/png")
        XCTAssertEqual(payload.dataBase64, TestImages.png().base64EncodedString())
        XCTAssertNil(payload.text)
    }

    func testAnImageThatVanishedBeforeStartSaysWhatToDo() throws {
        let png = try write("gone.png", TestImages.png())
        let item = HomeAttachment.file(png)
        try FileManager.default.removeItem(at: png)
        XCTAssertThrowsError(try item.payload()) { XCTAssertTrue($0.localizedDescription.contains("press Start again"), $0.localizedDescription) }
    }

    func testATextPayloadCarriesTheTextNotBase64() throws {
        let payload = try HomeAttachment.file(try write("brief.md", Data("# Brief".utf8))).payload()
        XCTAssertEqual(payload, StartAttachment(kind: "text", name: "brief.md", mimeType: "text/markdown", dataBase64: nil, text: "# Brief"))
    }

    // MARK: Limits

    private func text(_ name: String, _ count: Int) -> HomeAttachment {
        HomeAttachment.text(name: name, mimeType: "text/plain", data: Data(String(repeating: "x", count: count).utf8))
    }

    func testAFileOver200000CharactersIsFlaggedBeforeSending() {
        let big = text("big.txt", HomeAttachment.maxTextCharacters + 1)
        let ok = text("ok.txt", HomeAttachment.maxTextCharacters)
        let errors = HomeAttachment.errors(for: [big, ok])
        XCTAssertEqual(errors.count, 1)
        let message = errors[big.id] ?? ""
        XCTAssertTrue(message.contains("200,001 characters") && message.contains("Split it into parts or shorten it"), message)
    }

    func testTheFileThatTakesTheTotalPast400000IsFlagged() {
        let a = text("a.txt", HomeAttachment.maxTextCharacters)
        let b = text("b.txt", HomeAttachment.maxTextCharacters)
        let c = text("c.txt", 1)
        let errors = HomeAttachment.errors(for: [a, b, c])
        XCTAssertEqual(Set(errors.keys), [c.id])
        XCTAssertTrue(errors[c.id]?.contains("400,000 characters together") == true)
        XCTAssertTrue(HomeAttachment.errors(for: [a, b]).isEmpty)
    }

    func testTenImagesAreAllowedAndTheEleventhIsFlagged() throws {
        let png = try write("i.png", TestImages.png())
        let items = (0...HomeAttachment.maxImages).map { _ in HomeAttachment.file(png) }
        XCTAssertEqual(Set(HomeAttachment.errors(for: items).keys), [items.last!.id])
    }

    func testAChipsOwnErrorCountsAsAnError() throws {
        let bad = HomeAttachment.file(try write("x.zip", Data()))
        XCTAssertEqual(HomeAttachment.errors(for: [bad])[bad.id], bad.error)
    }

    // MARK: Paste

    private func pasteboard() -> NSPasteboard {
        let pb = NSPasteboard(name: NSPasteboard.Name("ocelot-test-\(UUID().uuidString)"))
        pb.clearContents()
        return pb
    }

    func testPasteThresholdsAre1500CharactersOr30Lines() {
        XCTAssertFalse(HomePaste.isLong(String(repeating: "x", count: 1500)))
        XCTAssertTrue(HomePaste.isLong(String(repeating: "x", count: 1501)))
        XCTAssertFalse(HomePaste.isLong(Array(repeating: "a", count: 30).joined(separator: "\n")))
        XCTAssertTrue(HomePaste.isLong(Array(repeating: "a", count: 31).joined(separator: "\n")))
        XCTAssertFalse(HomePaste.isLong("a sentence"))
    }

    func testPasteReadsAnImageAsPNG() throws {
        let pb = pasteboard()
        pb.setData(TestImages.png(), forType: .png)
        XCTAssertEqual(HomePaste.read(from: pb), .image(TestImages.png()))
        let tiffOnly = pasteboard()
        tiffOnly.setData(try XCTUnwrap(NSBitmapImageRep(data: TestImages.png())?.tiffRepresentation), forType: .tiff)
        guard case .image(let data)? = HomePaste.read(from: tiffOnly) else { return XCTFail("a TIFF image should be read") }
        XCTAssertEqual(Array(data.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
    }

    func testPasteTurnsLongTextIntoAChipAndLeavesShortTextToTheField() {
        let long = pasteboard()
        let text = Array(repeating: "line", count: 40).joined(separator: "\n")
        long.setString(text, forType: .string)
        XCTAssertEqual(HomePaste.read(from: long), .longText(text))
        let short = pasteboard()
        short.setString("hello", forType: .string)
        XCTAssertNil(HomePaste.read(from: short))
    }

    func testPastePrefersFilesOverTheirIcons() throws {
        let url = try write("a.txt", Data("x".utf8))
        let pb = pasteboard()
        pb.writeObjects([url as NSURL])
        pb.setData(TestImages.png(), forType: .png)
        XCTAssertEqual(HomePaste.read(from: pb), .files([url]))
    }

    func testPastedChipsAreNumbered() {
        let first = HomeAttachment.pastedText("x", among: [])
        let second = HomeAttachment.pastedText("y", among: [first])
        XCTAssertEqual([first.name, second.name], ["Pasted text", "Pasted text 2"])
        XCTAssertTrue(first.pasted)
        XCTAssertEqual(HomeAttachment.pastedImage(Data([1]), among: []).name, "Pasted image.png")
    }

    // MARK: Hand-off to the new document

    /// `editor.startWithPrompt` receives the prompt and the files once the new window's editor is up.
    func testTheNewDocumentStartsTheAgentWithThePromptAndTheFiles() async throws {
        setenv("OCELOT_RECOVERY_DIR", dir.appendingPathComponent("Recovery").path, 1)
        defer { unsetenv("OCELOT_RECOVERY_DIR") }
        final class Box: @unchecked Sendable { var params: JSONValue? }
        let box = Box()
        let client = EditorClient { json in
            let req = try JSONDecoder().decode(BridgeRequestEnvelope.self, from: Data(json.utf8))
            if req.method == EditorMethods.StartWithPrompt.name { box.params = req.params }
            let result: JSONValue = req.method == EditorMethods.StartWithPrompt.name ? .object(["started": .bool(true)]) : .object([:])
            return BridgeCoding.string(BridgeResponseEnvelope(v: BridgeSchema.version, id: req.id, ok: true, result: result, error: nil))
        }
        let session = DocumentSession(editor: { client })
        let files = [StartAttachment(kind: "text", name: "brief.txt", mimeType: "text/plain", text: "Code word: kumquat")]
        session.prepareFresh(prompt: "  Design a page  ", attachments: files)
        await session.editorDidLoad()
        for _ in 0..<100 where box.params == nil { try await Task.sleep(for: .milliseconds(20)) }
        let params = try BridgeCoding.decode(StartWithPromptParams.self, from: try XCTUnwrap(box.params))
        XCTAssertEqual(params.prompt, "Design a page")
        XCTAssertEqual(params.attachments, files)
    }
}
