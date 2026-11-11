import AppKit
import PDFKit
import XCTest
@testable import Ocelot

/// `host.exportRun` with a tiny two-artboard document: real WebKit rendering, real files in a temp folder.
@MainActor
final class ExportServiceTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-export-test-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func page(width: Int, height: Int, color: String, text: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden}
        [data-ocelot-root]{position:relative;width:100%;height:100%;background:\(color);font:24px Helvetica,Arial,sans-serif}
        </style></head><body><div data-ocelot-root data-node-id="ab">
          <div data-node-id="box" style="position:absolute;left:20px;top:10px;width:40px;height:30px;background:#ff0000">\(text)</div>
        </div></body></html>
        """
    }

    private struct Recorder {
        var progress: [ExportProgressParams] = []
        var copied: [Data] = []
        var asked: [String] = []
    }

    private func service(
        recorder: Box<Recorder> = Box(Recorder()),
        file: URL? = nil, chosenFolder: URL? = nil, onProgress: (@MainActor (ExportProgressParams) -> Void)? = nil
    ) -> ExportService {
        ExportService(ExportEnvironment(
            renderer: OffscreenRenderer.shared,
            exportsFolder: { [folder = folder!] in
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                return folder
            },
            chooseFile: { name, _ in recorder.value.asked.append(name); return file },
            chooseFolder: { message in recorder.value.asked.append(message); return chosenFolder },
            copyPNG: { recorder.value.copied.append($0) },
            progress: { recorder.value.progress.append($0); onProgress?($0) }
        ))
    }

    final class Box<T> {
        var value: T
        init(_ value: T) { self.value = value }
    }

    private func item(_ file: String, w: Double = 200, h: Double = 100, color: String = "#00ff00", node: String? = nil, transparent: Bool? = nil, text: String = "", notes: String? = nil) -> ExportItem {
        ExportItem(file: file, html: page(width: Int(w), height: Int(h), color: color, text: text), width: w, height: h, nodeId: node, transparent: transparent, notes: notes)
    }

    private func params(kind: String = "png", scale: Double = 2, destination: String = "exports", name: String = "Doc.pdf", previews: Int? = nil, runId: String = "run", items: [ExportItem]) -> ExportRunParams {
        ExportRunParams(runId: runId, kind: kind, scale: scale, destination: destination, suggestedName: name, previews: previews, items: items)
    }

    private func pixel(_ url: URL, x: Int, y: Int) throws -> NSColor {
        let rep = try XCTUnwrap(NSBitmapImageRep(data: try Data(contentsOf: url)))
        return try XCTUnwrap(rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB))
    }

    // MARK: Images

    func testPNGAt2xWritesOneFilePerItemWithPreviews() async throws {
        let recorder = Box(Recorder())
        let result = try await service(recorder: recorder).run(params(previews: 2, items: [
            item("Page 1 — Home@2x.png", w: 200, h: 100),
            item("Page 1 — Pricing@2x.png", w: 120, h: 80, color: "#0000ff"),
        ]))
        XCTAssertEqual(result.files.map(\.name), ["Page 1 — Home@2x.png", "Page 1 — Pricing@2x.png"])
        XCTAssertEqual(result.files.map(\.width), [400, 240])
        XCTAssertEqual(result.files.map(\.height), [200, 160])
        XCTAssertEqual(result.folder, folder.path)
        for f in result.files {
            XCTAssertTrue(FileManager.default.fileExists(atPath: f.path), f.path)
            XCTAssertNotNil(f.preview, "previews were requested")
            XCTAssertGreaterThan(f.bytes, 100)
        }
        let green = try pixel(folder.appendingPathComponent("Page 1 — Home@2x.png"), x: 300, y: 150)
        XCTAssertGreaterThan(green.greenComponent, 0.8)
        let blue = try pixel(folder.appendingPathComponent("Page 1 — Pricing@2x.png"), x: 200, y: 120)
        XCTAssertGreaterThan(blue.blueComponent, 0.8)
        XCTAssertEqual(recorder.value.progress.last?.done, 2, "progress reports the finished run")
        XCTAssertTrue(recorder.value.progress.contains { $0.message.contains("Rendering 1 of 2") })
    }

    func testJPGIsFlattenedOnWhite() async throws {
        let transparentPage = item("T.jpg", color: "transparent")
        let result = try await service().run(params(kind: "jpg", scale: 1, items: [transparentPage]))
        let url = folder.appendingPathComponent("T.jpg")
        let data = try Data(contentsOf: url)
        XCTAssertEqual(Array(data.prefix(2)), [0xFF, 0xD8], "JPEG magic")
        XCTAssertEqual(result.files.first?.width, 200)
        let c = try pixel(url, x: 150, y: 80)
        XCTAssertGreaterThan(c.redComponent, 0.9, "transparent areas become white, not black")
        XCTAssertGreaterThan(c.blueComponent, 0.9)
    }

    func testTransparentPNGKeepsAlphaOutsideTheNode() async throws {
        _ = try await service().run(params(scale: 1, items: [
            ExportItem(
                file: "Box.png",
                html: """
                <!doctype html><html><head><style>html,body{margin:0;height:100%}[data-ocelot-root]{width:100%;height:100%;background:#00ff00}
                [data-ocelot-root],[data-ocelot-root] *{visibility:hidden}[data-node-id="box"],[data-node-id="box"] *{visibility:visible}</style></head>
                <body><div data-ocelot-root data-node-id="ab"><div data-node-id="box" style="position:absolute;left:20px;top:10px;width:40px;height:30px;background:#ff0000"></div></div></body></html>
                """,
                width: 200, height: 100, nodeId: nil, transparent: true
            ),
        ]))
        let url = folder.appendingPathComponent("Box.png")
        let outside = try pixel(url, x: 150, y: 80)
        XCTAssertEqual(outside.alphaComponent, 0, accuracy: 0.01, "page background is not painted")
        let inside = try pixel(url, x: 30, y: 20)
        XCTAssertEqual(inside.alphaComponent, 1, accuracy: 0.01)
        XCTAssertGreaterThan(inside.redComponent, 0.8)
    }

    func testNonTransparentRenderAfterTransparentOneIsOpaqueAgain() async throws {
        _ = try await service().run(params(scale: 1, items: [item("A.png", color: "transparent", transparent: true)]))
        _ = try await service().run(params(scale: 1, items: [item("B.png", color: "transparent")]))
        XCTAssertEqual(try pixel(folder.appendingPathComponent("A.png"), x: 100, y: 50).alphaComponent, 0, accuracy: 0.01)
        XCTAssertEqual(try pixel(folder.appendingPathComponent("B.png"), x: 100, y: 50).alphaComponent, 1, accuracy: 0.01, "white page background is back")
    }

    // MARK: PDF

    func testPDFHasOnePagePerItemInOrderAtCSSSizeWithRealText() async throws {
        let result = try await service().run(params(kind: "pdf", name: "Doc.pdf", items: [
            item("a", w: 300, h: 200, text: "First"),
            item("b", w: 120, h: 400, color: "#ccccff", text: "Second"),
            item("c", w: 200, h: 100, text: "Third"),
        ]))
        let file = try XCTUnwrap(result.files.first)
        XCTAssertEqual(file.name, "Doc.pdf")
        XCTAssertEqual(file.pages, 3)
        let pdf = try XCTUnwrap(PDFDocument(url: URL(fileURLWithPath: file.path)))
        XCTAssertEqual(pdf.pageCount, 3)
        let sizes = (0..<3).map { pdf.page(at: $0)!.bounds(for: .mediaBox).size }
        XCTAssertEqual(sizes[0].width, 300, accuracy: 1); XCTAssertEqual(sizes[0].height, 200, accuracy: 1)
        XCTAssertEqual(sizes[1].width, 120, accuracy: 1); XCTAssertEqual(sizes[1].height, 400, accuracy: 1)
        XCTAssertEqual(sizes[2].width, 200, accuracy: 1); XCTAssertEqual(sizes[2].height, 100, accuracy: 1)
        XCTAssertTrue(pdf.page(at: 0)!.string?.contains("First") == true, "text stays text (vector): \(pdf.page(at: 0)!.string ?? "nil")")
        XCTAssertTrue(pdf.page(at: 1)!.string?.contains("Second") == true)
        XCTAssertTrue(pdf.page(at: 2)!.string?.contains("Third") == true)
    }

    func testPDFPreviewIsFirstPage() async throws {
        let result = try await service().run(params(kind: "pdf", previews: 1, items: [item("a", w: 300, h: 200)]))
        XCTAssertNotNil(result.files.first?.preview)
    }

    func testPDFCarriesSpeakerNotesAsAnnotationsAndKeepsThePageCount() async throws {
        let result = try await service().run(params(kind: "pdf", name: "Deck.pdf", items: [
            item("a", text: "One", notes: "Open with the problem."),
            item("b", text: "Two"),
            item("c", text: "Three", notes: "Ask for the intro."),
        ]))
        let file = try XCTUnwrap(result.files.first)
        XCTAssertEqual(file.pages, 3, "notes are annotations, never extra pages")
        let pdf = try XCTUnwrap(PDFDocument(url: URL(fileURLWithPath: file.path)))
        XCTAssertEqual(pdf.pageCount, 3)
        func notes(_ index: Int) -> [String] {
            pdf.page(at: index)!.annotations.filter { $0.type == "Text" }.compactMap(\.contents)
        }
        XCTAssertEqual(notes(0), ["Open with the problem."])
        XCTAssertEqual(notes(1), [])
        XCTAssertEqual(notes(2), ["Ask for the intro."])
        XCTAssertFalse(pdf.page(at: 0)!.annotations.first!.shouldPrint, "the note icon is not printed")
    }

    // MARK: Binary files (PPTX)

    private func fileParams(name: String = "Pitch.pptx", bytes: Data = Data("PK\u{3}\u{4}-pptx".utf8), destination: String = "exports", runId: String = "w") -> ExportWriteFileParams {
        ExportWriteFileParams(name: name, dataBase64: bytes.base64EncodedString(), destination: destination, runId: runId, width: 1920, height: 1080, pages: 8)
    }

    func testWriteFileWritesTheDecodedBytesToTheExportsFolder() async throws {
        let bytes = Data((0..<4096).map { UInt8($0 % 251) })
        let result = try await service().writeFile(fileParams(bytes: bytes))
        let file = try XCTUnwrap(result.files.first)
        XCTAssertEqual(file.name, "Pitch.pptx")
        XCTAssertEqual(file.bytes, bytes.count)
        XCTAssertEqual([file.width, file.height, file.pages ?? 0], [1920, 1080, 8])
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: file.path)), bytes)
        XCTAssertEqual(result.folder, folder.path)
    }

    func testWriteFileUsesTheSavePanelNameAndReportsCancel() async throws {
        let recorder = Box(Recorder())
        let chosen = folder.appendingPathComponent("Chosen.pptx")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let result = try await service(recorder: recorder, file: chosen).writeFile(fileParams(destination: "panel"))
        XCTAssertEqual(recorder.value.asked, ["Pitch.pptx"])
        XCTAssertEqual(result.files.first?.name, "Chosen.pptx")
        XCTAssertTrue(FileManager.default.fileExists(atPath: chosen.path))
        let cancelled = try await service(file: nil).writeFile(fileParams(destination: "panel"))
        XCTAssertEqual(cancelled.cancelled, true)
        XCTAssertTrue(cancelled.files.isEmpty)
    }

    func testWriteFileRefusesBadInputWithAnActionableMessage() async {
        func failure(_ p: ExportWriteFileParams) async -> String {
            do {
                _ = try await service().writeFile(p)
                return "no error"
            } catch let error as BridgeFailure {
                return error.message
            } catch {
                return "\(error)"
            }
        }
        let messages = [
            await failure(fileParams(name: "x.exe")),
            await failure(fileParams(name: "../evil.pptx")),
            await failure(ExportWriteFileParams(name: "Empty.pptx", dataBase64: "", destination: "exports", runId: "w")),
            await failure(ExportWriteFileParams(name: "Odd.pptx", dataBase64: "!!!not base64!!!", destination: "exports", runId: "w")),
            await failure(fileParams(destination: "clipboard")),
        ]
        XCTAssertTrue(messages[0].contains(".pptx"), messages[0])
        XCTAssertTrue(messages[1].contains("not a valid export file name"), messages[1])
        XCTAssertTrue(messages[2].contains("base64"), messages[2])
        XCTAssertTrue(messages[3].contains("base64"), messages[3])
        XCTAssertTrue(messages[4].contains("\"panel\" or \"exports\""), messages[4])
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("Pitch.pptx").path))
    }

    // MARK: Destinations

    func testPanelWithOneImageUsesTheSavePanelAndItsChosenName() async throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let chosen = folder.appendingPathComponent("My choice.png")
        let recorder = Box(Recorder())
        let result = try await service(recorder: recorder, file: chosen).run(params(scale: 1, destination: "panel", items: [item("Page 1 — Home.png")]))
        XCTAssertEqual(recorder.value.asked, ["Page 1 — Home.png"])
        XCTAssertEqual(result.files.first?.path, chosen.path)
        XCTAssertTrue(FileManager.default.fileExists(atPath: chosen.path))
    }

    func testPanelWithSeveralImagesAsksForAFolderAndNeverOverwrites() async throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("keep me".utf8).write(to: folder.appendingPathComponent("A.png"))
        let result = try await service(chosenFolder: folder).run(params(scale: 1, destination: "panel", items: [item("A.png"), item("B.png")]))
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("A.png")), Data("keep me".utf8))
        XCTAssertEqual(result.files.map(\.name), ["A 2.png", "B.png"])
        XCTAssertEqual(result.warnings?.count, 1)
    }

    func testCancelledPanelWritesNothingAndReportsCancelled() async throws {
        let result = try await service().run(params(destination: "panel", items: [item("A.png"), item("B.png")]))
        XCTAssertEqual(result.cancelled, true)
        XCTAssertTrue(result.files.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    }

    func testCancelDuringARunLeavesNoFiles() async throws {
        var svc: ExportService!
        svc = service(onProgress: { p in if p.done == 1 { svc.cancel(runId: p.runId) } })
        let result = try await svc.run(params(scale: 1, items: [item("A.png"), item("B.png"), item("C.png")]))
        XCTAssertEqual(result.cancelled, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("A.png").path), "files are written after rendering, so a cancelled run leaves nothing")
    }

    func testClipboardCopiesPNGBytes() async throws {
        let recorder = Box(Recorder())
        let result = try await service(recorder: recorder).run(params(scale: 2, destination: "clipboard", items: [item("Copy.png", node: "box")]))
        XCTAssertEqual(result.copied, true)
        XCTAssertTrue(result.files.isEmpty)
        let data = try XCTUnwrap(recorder.value.copied.first)
        let rep = try XCTUnwrap(NSBitmapImageRep(data: data))
        XCTAssertEqual(rep.pixelsWide, 80, "the node (40×30) at 2×")
        XCTAssertEqual(rep.pixelsHigh, 60)
    }

    // MARK: Validation

    private func expectFailure(_ text: String, _ p: ExportRunParams, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await service().run(p)
            XCTFail("expected a failure containing \"\(text)\"", file: file, line: line)
        } catch let failure as BridgeFailure {
            XCTAssertEqual(failure.code, .invalidParams, failure.message, file: file, line: line)
            XCTAssertTrue(failure.message.contains(text), "\"\(failure.message)\" should contain \"\(text)\"", file: file, line: line)
        } catch {
            XCTFail("unexpected error \(error)", file: file, line: line)
        }
    }

    func testRejectsBadInputWithAnActionableMessage() async {
        await expectFailure("kind must be", params(kind: "gif", items: [item("a.png")]))
        await expectFailure("Nothing to export", params(items: []))
        await expectFailure("scale must be", params(scale: 4, items: [item("a.png")]))
        await expectFailure("not a valid export file name", params(items: [item("../a.png")]))
        await expectFailure("not a valid export file name", params(items: [item("a.jpg")]))
        await expectFailure("not a valid export file name", params(items: [item(".hidden.png")]))
        await expectFailure("Two files are both named", params(items: [item("a.png"), item("a.png")]))
        await expectFailure("Use a lower scale", params(scale: 3, items: [item("big.png", w: 4000, h: 100)]))
        await expectFailure("destination must be", params(destination: "elsewhere", items: [item("a.png")]))
        await expectFailure("not a valid export file name", params(kind: "pdf", name: "../x.pdf", items: [item("a")]))
    }

    func testFreeURLCountsUp() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let base = folder.appendingPathComponent("A.png")
        XCTAssertEqual(ExportService.freeURL(base).lastPathComponent, "A.png")
        try Data().write(to: base)
        XCTAssertEqual(ExportService.freeURL(base).lastPathComponent, "A 2.png")
        try Data().write(to: folder.appendingPathComponent("A 2.png"))
        XCTAssertEqual(ExportService.freeURL(base).lastPathComponent, "A 3.png")
    }
}
