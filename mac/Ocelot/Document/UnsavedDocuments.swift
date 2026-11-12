import Foundation

/// An untitled document that exists only as a recovery package (`Recovery/Untitled-<uuid>.ocelot`): the person never
/// saved it, so Home lists it as "Unsaved" until they do.
struct UnsavedDocument: Equatable, Sendable {
    let url: URL
    /// The document's own name ("Untitled" when it has none).
    let name: String
    /// When the package was last written (its `savedAt`, else the file's modification time).
    let date: Date
    /// `preview.png` in the package when an autosave wrote one.
    let previewURL: URL?
    let previewStamp: Date?
}

/// Finds the recovery packages worth showing in Home. Reading a `document.json` can mean megabytes of Yjs state, so what
/// a package says is remembered until its `document.json` changes: a Home refresh costs one directory listing and a stat per package.
struct UnsavedScanner {
    private struct Summary: Decodable {
        var name: String?
        var savedAt: String?
        var tree: JSONValue?
    }

    private struct Remembered {
        var stamp: Date
        /// Nil when the package holds nothing worth listing (no artboard) or cannot be read.
        var document: UnsavedDocument?
    }

    private var remembered: [String: Remembered] = [:]

    /// Every package in `directory` that holds an artboard, newest first. A package with a `document.json` and no artboard
    /// is a blank window's autosave: nothing a person would miss, so it is not listed (`DocumentSession.windowWillClose` drops those).
    mutating func scan(in directory: URL) -> [UnsavedDocument] {
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else {
            remembered.removeAll()
            return []
        }
        var found: [UnsavedDocument] = []
        var seen = Set<String>()
        for url in items where DocumentExtension.matches(url) {
            let file = url.appendingPathComponent(DocumentPackage.documentFileName)
            guard let stamp = Self.modified(file) else { continue }
            let key = url.standardizedFileURL.path
            seen.insert(key)
            if let known = remembered[key], known.stamp == stamp {
                if let document = known.document { found.append(Self.refreshPreview(document)) }
                continue
            }
            let document = Self.summarize(url, file: file, stamp: stamp)
            remembered[key] = Remembered(stamp: stamp, document: document)
            if let document { found.append(document) }
        }
        remembered = remembered.filter { seen.contains($0.key) }
        return found.sorted { $0.date > $1.date }
    }

    /// Whether `url` is a package directly inside `directory` (the recovery folder).
    static func isPackage(_ url: URL, in directory: URL) -> Bool {
        guard DocumentExtension.matches(url) else { return false }
        let parent = url.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL.path
        return parent == directory.resolvingSymlinksInPath().standardizedFileURL.path
    }

    // MARK: Internals

    private static func summarize(_ url: URL, file: URL, stamp: Date) -> UnsavedDocument? {
        guard let data = try? Data(contentsOf: file),
              let summary = try? JSONDecoder().decode(Summary.self, from: data),
              let tree = summary.tree, DocumentPackage.hasArtboards(tree: tree)
        else { return nil }
        let name = summary.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let preview = DocumentPackage.previewURL(in: url)
        let previewStamp = modified(preview)
        return UnsavedDocument(
            url: url.standardizedFileURL,
            name: name.isEmpty ? "Untitled" : name,
            date: summary.savedAt.flatMap(parseDate) ?? stamp,
            previewURL: previewStamp == nil ? nil : preview,
            previewStamp: previewStamp
        )
    }

    /// The thumbnail is rewritten without touching `document.json`: look at it again every time.
    private static func refreshPreview(_ document: UnsavedDocument) -> UnsavedDocument {
        let preview = DocumentPackage.previewURL(in: document.url)
        let stamp = modified(preview)
        return UnsavedDocument(url: document.url, name: document.name, date: document.date, previewURL: stamp == nil ? nil : preview, previewStamp: stamp)
    }

    private static func modified(_ url: URL) -> Date? {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
    }

    /// `savedAt` is an ISO 8601 string from the editor (`toISOString()`: with milliseconds).
    private static func parseDate(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }
}
