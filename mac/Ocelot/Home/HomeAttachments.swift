import AppKit
import Foundation
import UniformTypeIdentifiers

/// An image or a text attached to the Home prompt. The model, the accepted types and the limits mirror the editor's
/// `agent/attachments.ts`, which normalizes whatever Start hands over (this side only shows chips and errors early).
/// Files are read when Start is pressed (images) or when they are added (texts, for the line count and the limits).
struct HomeAttachment: Identifiable, Equatable {
    enum Kind: String, Equatable { case image, text }
    enum Content: Equatable {
        case file(URL)
        case imageData(Data)
        case text(String)
    }

    let id: UUID
    var kind: Kind
    var name: String
    var mimeType: String
    /// Bytes of the file, the pasted image or the text (UTF-8).
    var size: Int
    var content: Content
    /// A long paste that became a chip automatically.
    var pasted = false
    /// Why this one cannot be sent.
    var error: String?

    // MARK: Limits (the editor enforces the same)

    static let maxImages = 10
    static let maxTextCharacters = 200_000
    static let maxTotalTextCharacters = 400_000
    static let maxSourceImageBytes = 50 * 1024 * 1024
    /// Pasted text beyond either threshold becomes a chip.
    static let pasteMinCharacters = 1500
    static let pasteMinLines = 30
    /// What the message says when there are attachments and no words.
    static let defaultPrompt = "Design from the attached files."
    static let supported = "Images (PNG, JPEG, WebP, GIF, HEIC) and text files (.txt, .md, .csv, .json, .html, .css, .svg)"

    private static let imageMimes = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif", "heic": "image/heic", "heif": "image/heif"]
    private static let textMimes = ["txt": "text/plain", "md": "text/markdown", "csv": "text/csv", "json": "application/json", "html": "text/html", "css": "text/css", "svg": "image/svg+xml"]

    /// File types for the open panel.
    static var openPanelTypes: [UTType] {
        (Array(imageMimes.keys) + Array(textMimes.keys)).compactMap { UTType(filenameExtension: $0) }
    }

    static func classify(name: String) -> (kind: Kind, mimeType: String)? {
        let ext = (name as NSString).pathExtension.lowercased()
        if let mime = imageMimes[ext] { return (.image, mime) }
        if let mime = textMimes[ext] { return (.text, mime) }
        return nil
    }

    // MARK: Making attachments (never throws: a file that cannot be used becomes a chip with an error)

    static func file(_ url: URL) -> HomeAttachment {
        let name = url.lastPathComponent
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard let (kind, mime) = classify(name: name) else {
            return refused(name, size: size, "“\(name)” cannot be attached. \(supported) are supported.")
        }
        switch kind {
        case .image:
            if size > maxSourceImageBytes {
                return refused(name, size: size, "“\(name)” is \(formatBytes(size)); images up to \(formatBytes(maxSourceImageBytes)) can be attached. Export a smaller copy and try again.")
            }
            return HomeAttachment(id: UUID(), kind: .image, name: name, mimeType: mime, size: size, content: .file(url))
        case .text:
            // A text over the limit is refused without reading all of it.
            if size > maxTextCharacters * 4 {
                return refused(name, size: size, tooLong(name, characters: size))
            }
            guard let data = try? Data(contentsOf: url) else {
                return refused(name, size: size, "Could not read “\(name)”. Check that the file still exists, then attach it again.")
            }
            return text(name: name, mimeType: mime, data: data)
        }
    }

    static func text(name: String, mimeType: String, data: Data) -> HomeAttachment {
        guard var string = String(data: data, encoding: .utf8) else {
            return refused(name, size: data.count, "“\(name)” is not UTF-8 text. Save it as UTF-8 and attach it again.")
        }
        if string.contains("\u{0}") {
            return refused(name, size: data.count, "“\(name)” is not a text file. \(supported) can be attached.")
        }
        if string.hasPrefix("\u{FEFF}") { string.removeFirst() }
        string = string.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        return HomeAttachment(id: UUID(), kind: .text, name: name, mimeType: mimeType, size: data.count, content: .text(string))
    }

    static func pastedImage(_ data: Data, among existing: [HomeAttachment]) -> HomeAttachment {
        let n = existing.filter { $0.name.hasPrefix("Pasted image") }.count
        return HomeAttachment(id: UUID(), kind: .image, name: n == 0 ? "Pasted image.png" : "Pasted image \(n + 1).png", mimeType: "image/png", size: data.count, content: .imageData(data))
    }

    static func pastedText(_ text: String, among existing: [HomeAttachment]) -> HomeAttachment {
        let n = existing.filter(\.pasted).count
        var a = HomeAttachment(id: UUID(), kind: .text, name: n == 0 ? "Pasted text" : "Pasted text \(n + 1)", mimeType: "text/plain", size: text.utf8.count, content: .text(text))
        a.pasted = true
        return a
    }

    private static func refused(_ name: String, size: Int, _ message: String) -> HomeAttachment {
        let kind = classify(name: name)
        return HomeAttachment(id: UUID(), kind: kind?.kind ?? .text, name: name, mimeType: kind?.mimeType ?? "", size: size, content: .text(""), error: message)
    }

    // MARK: Reading

    var text: String? {
        if case .text(let t) = content { return t }
        return nil
    }

    /// Lines of a text (a trailing newline does not start a new one); 0 for the empty text.
    var lines: Int {
        guard let text, !text.isEmpty else { return 0 }
        return (text.hasSuffix("\n") ? String(text.dropLast()) : text).components(separatedBy: "\n").count
    }

    /// The chip's second line: "1600 KB" for an image, "412 lines" for a text.
    var meta: String {
        if kind == .text, text != nil { return lines == 1 ? "1 line" : "\(lines) lines" }
        return Self.formatBytes(size)
    }

    /// The wire form of `StartWithPromptParams.attachments`: images as base64 of the original bytes (the editor downscales
    /// and re-encodes them with WebKit), texts as text. Reads the file; throws a sentence that says what to do.
    func payload() throws -> StartAttachment {
        switch content {
        case .file(let url):
            guard let data = try? Data(contentsOf: url) else {
                throw HomeAttachmentError.unreadable("Could not read “\(name)”. Check that the file still exists, then press Start again.")
            }
            return StartAttachment(kind: kind.rawValue, name: name, mimeType: mimeType, dataBase64: data.base64EncodedString())
        case .imageData(let data):
            return StartAttachment(kind: kind.rawValue, name: name, mimeType: mimeType, dataBase64: data.base64EncodedString())
        case .text(let text):
            return StartAttachment(kind: kind.rawValue, name: name, mimeType: mimeType, text: text)
        }
    }

    // MARK: Limits

    /// Per-chip problems: a chip's own error, then what the whole set exceeds (10 images, 200,000 characters a file,
    /// 400,000 in total). Empty: the set can be sent.
    static func errors(for items: [HomeAttachment]) -> [UUID: String] {
        var out: [UUID: String] = [:]
        var images = 0
        var total = 0
        for a in items {
            if let error = a.error {
                out[a.id] = error
                continue
            }
            if a.kind == .image {
                images += 1
                if images > maxImages { out[a.id] = "Only \(maxImages) images fit in one message. Remove this one and send it in the next message." }
                continue
            }
            let chars = a.text?.count ?? 0
            if chars > maxTextCharacters {
                out[a.id] = tooLong(a.name, characters: chars)
            } else if total + chars > maxTotalTextCharacters {
                out[a.id] = "Text attachments can have \(grouped(maxTotalTextCharacters)) characters together. Remove this one or shorten it."
            } else {
                total += chars
            }
        }
        return out
    }

    private static func tooLong(_ name: String, characters: Int) -> String {
        "“\(name)” has \(grouped(characters)) characters; one file can have \(grouped(maxTextCharacters)). Split it into parts or shorten it."
    }

    private static func grouped(_ n: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US_POSIX")
        f.usesGroupingSeparator = true
        f.groupingSeparator = ","
        f.groupingSize = 3
        return f.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    static func formatBytes(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return "\(Int((Double(bytes) / 1024).rounded())) KB" }
        return String(format: "%.1f MB", Double(bytes) / 1024 / 1024)
    }
}

enum HomeAttachmentError: LocalizedError {
    case unreadable(String)
    var errorDescription: String? {
        switch self { case .unreadable(let message): return message }
    }
}

/// What a paste into Home's prompt carries that should become chips instead of text.
enum HomePaste: Equatable {
    case files([URL])
    case image(Data)
    case longText(String)

    /// Files first (a file copied in Finder also carries its icon as an image), then an image, then text that is long
    /// enough; short text returns nil so the text field pastes it itself.
    static func read(from pasteboard: NSPasteboard) -> HomePaste? {
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return .files(urls)
        }
        if let png = pngData(from: pasteboard) { return .image(png) }
        if let text = pasteboard.string(forType: .string), isLong(text) { return .longText(text) }
        return nil
    }

    static func isLong(_ text: String) -> Bool {
        if text.count > HomeAttachment.pasteMinCharacters { return true }
        let trimmed = text.hasSuffix("\n") ? String(text.dropLast()) : text
        return trimmed.isEmpty ? false : trimmed.components(separatedBy: "\n").count > HomeAttachment.pasteMinLines
    }

    private static func pngData(from pasteboard: NSPasteboard) -> Data? {
        if let png = pasteboard.data(forType: .png) { return png }
        guard let tiff = pasteboard.data(forType: .tiff), let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }
}
