import AppKit
import Foundation
import ImageIO
import PDFKit
import UniformTypeIdentifiers

/// What the export service needs from a renderer (`OffscreenRenderer` in the app, a fake in tests).
@MainActor
protocol ExportRendering {
    func render(_ req: SnapshotRequest) async throws -> SnapshotResult
    func renderPDF(html: String, width: Double, height: Double) async throws -> Data
}

extension OffscreenRenderer: ExportRendering {}

/// Everything `host.exportRun` touches outside the renderer, so tests can run the service without UI.
@MainActor
struct ExportEnvironment {
    var renderer: any ExportRendering
    /// `<package>/exports/` (or a temp folder while the document is untitled), created on demand.
    var exportsFolder: @MainActor () throws -> URL
    /// Save panel for one file. nil = cancelled.
    var chooseFile: @MainActor (_ suggestedName: String, _ ext: String) -> URL?
    /// Folder chooser for several files. nil = cancelled.
    var chooseFolder: @MainActor (_ message: String) -> URL?
    var copyPNG: @MainActor (Data) -> Void
    var progress: @MainActor (ExportProgressParams) -> Void
}

/// `host.exportRun`: renders artboards or nodes to PNG / JPG files, or all artboards to one multi-page PDF, and
/// writes them where the caller asked (a save panel / folder chooser, the document's export folder, or the pasteboard).
/// Rendering happens first and writing last, so a cancelled run leaves nothing behind.
@MainActor
final class ExportService {
    static let maxPixelSide = 8192
    static let maxItems = 500
    static let jpegQuality = 0.9
    static let previewSide = 480
    static let previewLimit = 6
    /// Files the editor builds itself and hands over as base64 (`host.exportWriteFile`).
    static let binaryExtensions: Set<String> = ["pptx"]
    static let maxFileBytes = 256 * 1_048_576
    static let maxFileBase64Bytes = maxFileBytes / 3 * 4 + 4

    private let env: ExportEnvironment
    private var cancelled: Set<String> = []

    init(_ env: ExportEnvironment) { self.env = env }

    func cancel(runId: String) { cancelled.insert(runId) }

    func run(_ params: ExportRunParams) async throws -> ExportRunResult {
        defer { cancelled.remove(params.runId) }
        let plan = try Self.validate(params)

        // Ask where to write before spending time rendering.
        let target: Target
        switch params.destination {
        case "clipboard":
            target = .clipboard
        case "exports":
            target = .folder(try env.exportsFolder(), overwrite: true)
        case "panel":
            if plan.isPDF || params.items.count == 1 {
                let name = plan.isPDF ? plan.pdfName : params.items[0].file
                guard let url = env.chooseFile(name, plan.ext) else { return ExportRunResult(files: [], cancelled: true) }
                target = .file(url)
            } else {
                guard let folder = env.chooseFolder("Choose where to save \(params.items.count) \(plan.ext.uppercased()) files.") else {
                    return ExportRunResult(files: [], cancelled: true)
                }
                target = .folder(folder, overwrite: false)
            }
        default:
            throw BridgeFailure(.invalidParams, "destination must be \"panel\", \"exports\" or \"clipboard\" (got \"\(params.destination)\").")
        }

        // Render everything into memory.
        var warnings: [String] = []
        var outputs: [Output] = []
        let total = params.items.count
        if plan.isPDF {
            var pages: [Data] = []
            for (i, item) in params.items.enumerated() {
                if isCancelled(params.runId) { return ExportRunResult(files: [], cancelled: true) }
                env.progress(ExportProgressParams(runId: params.runId, done: i, total: total, message: "Rendering page \(i + 1) of \(total)"))
                do {
                    pages.append(try await env.renderer.renderPDF(html: item.html, width: item.width, height: item.height))
                } catch {
                    throw BridgeFailure(.internal, "Could not render \(item.file) for the PDF: \(error.localizedDescription) Try again; if it keeps failing, export that artboard as PNG.")
                }
            }
            if isCancelled(params.runId) { return ExportRunResult(files: [], cancelled: true) }
            env.progress(ExportProgressParams(runId: params.runId, done: total, total: total, message: "Combining pages"))
            guard let merged = Self.mergePDF(pages, notes: params.items.map(\.notes)) else {
                throw BridgeFailure(.internal, "WebKit produced no PDF pages. Try again, or export PNG instead.")
            }
            outputs.append(Output(name: plan.pdfName, data: merged.data, width: merged.width, height: merged.height, pages: merged.count, thumbnailSource: .pdf(merged.document)))
        } else {
            for (i, item) in params.items.enumerated() {
                if isCancelled(params.runId) { return ExportRunResult(files: [], cancelled: true) }
                env.progress(ExportProgressParams(runId: params.runId, done: i, total: total, message: "Rendering \(i + 1) of \(total): \(item.file)"))
                let shot: SnapshotResult
                do {
                    shot = try await env.renderer.render(
                        SnapshotRequest(html: item.html, width: item.width, height: item.height, scale: params.scale, nodeId: item.nodeId, transparent: plan.ext == "png" && item.transparent == true)
                    )
                } catch {
                    throw BridgeFailure(.internal, "Could not render \(item.file): \(error.localizedDescription) Try again, or lower the scale.")
                }
                guard let png = Data(base64Encoded: shot.png) else {
                    throw BridgeFailure(.internal, "The renderer returned an unreadable image for \(item.file). Try again.")
                }
                let data: Data
                if plan.ext == "jpg" {
                    guard let jpeg = Self.jpegData(fromPNG: png, quality: Self.jpegQuality) else {
                        throw BridgeFailure(.internal, "Could not encode \(item.file) as JPEG. Export PNG instead.")
                    }
                    data = jpeg
                } else {
                    data = png
                }
                outputs.append(Output(name: item.file, data: data, width: shot.width, height: shot.height, pages: nil, thumbnailSource: .image(data)))
            }
        }
        if isCancelled(params.runId) { return ExportRunResult(files: [], cancelled: true) }
        env.progress(ExportProgressParams(runId: params.runId, done: total, total: total, message: "Saving"))

        switch target {
        case .clipboard:
            env.copyPNG(outputs[0].data)
            return ExportRunResult(files: [], copied: true)
        case .file(let url):
            try Self.write(outputs[0].data, to: url)
            return ExportRunResult(
                files: [file(for: outputs[0], at: url, preview: params.previews.map { $0 > 0 } ?? false)],
                folder: url.deletingLastPathComponent().path, warnings: warnings.isEmpty ? nil : warnings
            )
        case .folder(let folder, let overwrite):
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            var written: [ExportedFile] = []
            let previewCount = min(max(params.previews ?? 0, 0), Self.previewLimit)
            for (i, output) in outputs.enumerated() {
                let url = overwrite ? folder.appendingPathComponent(output.name) : Self.freeURL(folder.appendingPathComponent(output.name))
                if url.lastPathComponent != output.name { warnings.append("\(output.name) already exists in the folder; saved as \(url.lastPathComponent).") }
                try Self.write(output.data, to: url)
                written.append(file(for: output, at: url, preview: i < previewCount))
            }
            return ExportRunResult(files: written, folder: folder.path, warnings: warnings.isEmpty ? nil : warnings)
        }
    }

    /// `host.exportWriteFile`: the editor built the file itself (a PPTX) and hands over its bytes as base64. Written like a
    /// PDF: the save panel for `panel`, the document's export folder for `exports`.
    func writeFile(_ params: ExportWriteFileParams) async throws -> ExportRunResult {
        defer { cancelled.remove(params.runId) }
        let ext = (params.name as NSString).pathExtension.lowercased()
        guard Self.binaryExtensions.contains(ext) else {
            throw BridgeFailure(.invalidParams, "\"\(params.name)\" cannot be written here. host.exportWriteFile writes \(Self.binaryExtensions.sorted().map { ".\($0)" }.joined(separator: ", ")) files; name the file with one of those extensions.")
        }
        let name = try Self.validateFileName(params.name, ext: ext)
        guard params.dataBase64.utf8.count <= Self.maxFileBase64Bytes else {
            throw BridgeFailure(.invalidParams, "\(name) is larger than \(Self.maxFileBytes / 1_048_576) MB. Export fewer slides at a time, or use the image-only mode at a lower scale.")
        }
        guard let data = Data(base64Encoded: params.dataBase64), !data.isEmpty else {
            throw BridgeFailure(.invalidParams, "dataBase64 for \(name) is empty or is not valid base64. Send the file's bytes as one base64 string.")
        }
        let url: URL
        switch params.destination {
        case "exports":
            url = try env.exportsFolder().appendingPathComponent(name)
        case "panel":
            guard let chosen = env.chooseFile(name, ext) else { return ExportRunResult(files: [], cancelled: true) }
            url = chosen
        default:
            throw BridgeFailure(.invalidParams, "destination must be \"panel\" or \"exports\" for files (got \"\(params.destination)\").")
        }
        if isCancelled(params.runId) { return ExportRunResult(files: [], cancelled: true) }
        try Self.write(data, to: url)
        let written = ExportedFile(name: url.lastPathComponent, path: url.path, bytes: data.count, width: params.width ?? 0, height: params.height ?? 0, pages: params.pages, preview: nil)
        return ExportRunResult(files: [written], folder: url.deletingLastPathComponent().path)
    }

    // MARK: Plan

    private enum Target {
        case clipboard
        case file(URL)
        case folder(URL, overwrite: Bool)
    }

    private struct Plan {
        var ext: String
        var pdfName: String
        var isPDF: Bool { ext == "pdf" }
    }

    private struct Output {
        enum Source {
            case image(Data)
            case pdf(PDFDocument)
        }

        var name: String
        var data: Data
        var width: Int
        var height: Int
        var pages: Int?
        var thumbnailSource: Source
    }

    private func isCancelled(_ runId: String) -> Bool { cancelled.contains(runId) || Task.isCancelled }

    private static func validate(_ params: ExportRunParams) throws -> Plan {
        guard ["png", "jpg", "pdf"].contains(params.kind) else {
            throw BridgeFailure(.invalidParams, "kind must be \"png\", \"jpg\" or \"pdf\" (got \"\(params.kind)\").")
        }
        guard !params.items.isEmpty else {
            throw BridgeFailure(.invalidParams, "Nothing to export: items is empty. Select layers or artboards, or pick a page.")
        }
        guard params.items.count <= maxItems else {
            throw BridgeFailure(.invalidParams, "Too many items (\(params.items.count)); export at most \(maxItems) at a time. Split the export by page.")
        }
        guard params.scale >= 1, params.scale <= 3 else {
            throw BridgeFailure(.invalidParams, "scale must be between 1 and 3 (got \(params.scale)).")
        }
        let ext = params.kind
        var seen = Set<String>()
        for item in params.items {
            if params.kind != "pdf" {
                _ = try validateFileName(item.file, ext: ext)
                guard seen.insert(item.file).inserted else {
                    throw BridgeFailure(.invalidParams, "Two files are both named \"\(item.file)\". Give every item a unique name.")
                }
                guard item.width * params.scale <= Double(maxPixelSide), item.height * params.scale <= Double(maxPixelSide) else {
                    throw BridgeFailure(.invalidParams, "\(item.file) would be larger than \(maxPixelSide) px on a side at \(params.scale)×. Use a lower scale.")
                }
            }
            guard item.width >= 1, item.height >= 1 else {
                throw BridgeFailure(.invalidParams, "\(item.file) has no size. Export an artboard or a visible layer.")
            }
        }
        let pdfName = params.kind == "pdf" ? try validateFileName(params.suggestedName, ext: "pdf") : ""
        return Plan(ext: ext, pdfName: pdfName)
    }

    /// A single plain file name with the right extension: no folders, no hidden files.
    static func validateFileName(_ name: String, ext: String) throws -> String {
        let bad = name.isEmpty || name.count > 200 || name.hasPrefix(".") || name.contains("/") || name.contains("\\")
            || name.contains(":") || name.contains("\0") || name == "." || name == ".."
        guard !bad, name.lowercased().hasSuffix(".\(ext)"), name.count > ext.count + 1 else {
            throw BridgeFailure(.invalidParams, "\"\(name)\" is not a valid export file name. Use a plain name ending in .\(ext), without slashes or colons, for example \"Home@2x.\(ext)\".")
        }
        return name
    }

    // MARK: Files

    private func file(for output: Output, at url: URL, preview: Bool) -> ExportedFile {
        var thumbnail: String?
        if preview {
            switch output.thumbnailSource {
            case .image(let data): thumbnail = Self.thumbnailPNG(fromImage: data, maxSide: Self.previewSide)
            case .pdf(let document): thumbnail = Self.thumbnailPNG(fromPDF: document, maxSide: Self.previewSide)
            }
        }
        return ExportedFile(name: url.lastPathComponent, path: url.path, bytes: output.data.count, width: output.width, height: output.height, pages: output.pages, preview: thumbnail)
    }

    private static func write(_ data: Data, to url: URL) throws {
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            throw BridgeFailure(.internal, "Could not write \(url.path): \(error.localizedDescription). Choose another folder or check its permissions.")
        }
    }

    /// `name`, or `name 2`, `name 3`… when it exists (a chosen folder is never overwritten silently).
    static func freeURL(_ url: URL) -> URL {
        let fm = FileManager.default
        guard fm.fileExists(atPath: url.path) else { return url }
        let base = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        let dir = url.deletingLastPathComponent()
        var n = 2
        while true {
            let candidate = dir.appendingPathComponent("\(base) \(n)").appendingPathExtension(ext)
            if !fm.fileExists(atPath: candidate.path) { return candidate }
            n += 1
        }
    }

    // MARK: Encoding

    /// JPEG from PNG bytes, flattened onto white (JPEG has no alpha; transparent areas would turn black).
    static func jpegData(fromPNG png: Data, quality: Double) -> Data? {
        guard let source = CGImageSourceCreateWithData(png as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        let w = image.width, h = image.height
        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let flat = ctx.makeImage() else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, flat, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    /// One document from single-page PDFs, in the order given. Page sizes are kept. A page with speaker notes gets a
    /// "note" annotation at its top-left corner holding them (shown by Preview, Acrobat and PDFKit viewers; never printed).
    static func mergePDF(_ pages: [Data], notes: [String?] = []) -> (document: PDFDocument, data: Data, width: Int, height: Int, count: Int)? {
        let merged = PDFDocument()
        for (index, data) in pages.enumerated() {
            guard let page = PDFDocument(data: data)?.page(at: 0) else { return nil }
            merged.insert(page, at: merged.pageCount)
            if index < notes.count, let text = notes[index], !text.isEmpty { addNote(text, to: page) }
        }
        guard merged.pageCount > 0, let data = merged.dataRepresentation(), let first = merged.page(at: 0) else { return nil }
        let size = first.bounds(for: .mediaBox).size
        return (merged, data, Int(size.width.rounded()), Int(size.height.rounded()), merged.pageCount)
    }

    private static func addNote(_ text: String, to page: PDFPage) {
        let box = page.bounds(for: .mediaBox)
        let note = PDFAnnotation(bounds: CGRect(x: box.minX + 8, y: box.maxY - 32, width: 24, height: 24), forType: .text, withProperties: nil)
        note.contents = text
        note.userName = "Speaker notes"
        note.color = NSColor(calibratedRed: 1, green: 0.85, blue: 0.2, alpha: 1)
        note.shouldPrint = false
        page.addAnnotation(note)
    }

    static func thumbnailPNG(fromImage data: Data, maxSide: Int) -> String? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxSide,
        ]
        guard let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return pngBase64(thumb)
    }

    static func thumbnailPNG(fromPDF document: PDFDocument, maxSide: Int) -> String? {
        guard let page = document.page(at: 0) else { return nil }
        let size = page.bounds(for: .mediaBox).size
        let scale = min(1, CGFloat(maxSide) / max(size.width, size.height))
        let image = page.thumbnail(of: CGSize(width: size.width * scale, height: size.height * scale), for: .mediaBox)
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        return pngBase64(cg)
    }

    private static func pngBase64(_ image: CGImage) -> String? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, nil)
        return CGImageDestinationFinalize(dest) ? (out as Data).base64EncodedString() : nil
    }
}

/// `host.exportRun` / `host.exportCancel` for one editor window.
@MainActor
enum ExportBridge {
    static func register(on host: HostEndpoint, session: DocumentSession) {
        // Untitled documents have no package to put exports in: a per-window temp folder instead.
        let untitledExports = FileManager.default.temporaryDirectory
            .appendingPathComponent("ocelot-exports-\(UUID().uuidString)", isDirectory: true)
        let service = ExportService(
            ExportEnvironment(
                renderer: OffscreenRenderer.shared,
                exportsFolder: { [weak session] in
                    let folder = session?.fileURL?.appendingPathComponent("exports", isDirectory: true) ?? untitledExports
                    do {
                        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    } catch {
                        throw BridgeFailure(.internal, "Could not create the export folder \(folder.path): \(error.localizedDescription). Save the document somewhere writable first.")
                    }
                    return folder
                },
                chooseFile: { name, ext in
                    let panel = NSSavePanel()
                    panel.nameFieldStringValue = name
                    panel.canCreateDirectories = true
                    panel.isExtensionHidden = false
                    if let type = UTType(filenameExtension: ext) { panel.allowedContentTypes = [type] }
                    panel.prompt = "Export"
                    return panel.runModal() == .OK ? panel.url : nil
                },
                chooseFolder: { message in
                    let panel = NSOpenPanel()
                    panel.canChooseFiles = false
                    panel.canChooseDirectories = true
                    panel.canCreateDirectories = true
                    panel.allowsMultipleSelection = false
                    panel.message = message
                    panel.prompt = "Export Here"
                    return panel.runModal() == .OK ? panel.url : nil
                },
                copyPNG: { data in
                    let pasteboard = NSPasteboard.general
                    pasteboard.clearContents()
                    pasteboard.setData(data, forType: .png)
                },
                progress: { [weak session] params in
                    guard let client = session?.editorClient() else { return }
                    Task { @MainActor in _ = try? await client.call(EditorMethods.ExportProgress.self, params) }
                }
            )
        )
        host.register(HostMethods.ExportRun.self) { params in try await service.run(params) }
        host.register(HostMethods.ExportWriteFile.self) { params in try await service.writeFile(params) }
        host.register(HostMethods.ExportCancel.self) { params in
            service.cancel(runId: params.runId)
            return Empty()
        }
    }
}
