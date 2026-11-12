import AppKit
import Foundation

/// One remembered document. The app is not sandboxed, so a plain (not security-scoped) bookmark is enough:
/// it follows the package when it is renamed or moved in Finder; `path` is the fallback when it goes stale.
struct RecentEntry: Codable, Equatable, Sendable {
    var path: String
    var bookmark: Data?
    var lastOpened: Date
}

/// The ordered, bounded list behind the Home window and File > Open Recent. Pure value logic: the store below
/// owns persistence and file-system access.
struct RecentList: Equatable, Sendable {
    /// How many documents Home remembers.
    static let limit = 24

    var entries: [RecentEntry] = []

    /// Moves (or inserts) `entry` to the front, replacing any earlier entry for the same file, and trims to `limit`.
    mutating func note(_ entry: RecentEntry) {
        let key = Self.key(entry.path)
        entries.removeAll { Self.key($0.path) == key }
        entries.insert(entry, at: 0)
        if entries.count > Self.limit { entries.removeLast(entries.count - Self.limit) }
    }

    mutating func remove(path: String) {
        let key = Self.key(path)
        entries.removeAll { Self.key($0.path) == key }
    }

    /// Resolves every entry (`resolve` returns where its file is now, or nil when it is gone) and keeps the
    /// survivors in order, de-duplicated, with moved files re-pointed at their new path. Capped at `limit`.
    func pruned(resolve: (RecentEntry) -> URL?) -> RecentList {
        var seen = Set<String>()
        var kept: [RecentEntry] = []
        for entry in entries {
            guard let url = resolve(entry) else { continue }
            var updated = entry
            updated.path = url.path
            guard seen.insert(Self.key(url.path)).inserted else { continue }
            kept.append(updated)
        }
        return RecentList(entries: Array(kept.prefix(Self.limit)))
    }

    private static func key(_ path: String) -> String {
        URL(fileURLWithPath: path).standardizedFileURL.path
    }
}

/// A recent document as Home shows it.
struct RecentDocument: Identifiable, Equatable, Sendable {
    let url: URL
    /// When the document was last opened or saved; for an unsaved one, when its recovery copy was last written.
    let lastOpened: Date
    /// `preview.png` inside the package when the document has been saved with one.
    let previewURL: URL?
    /// Modification time of the preview: changes when the thumbnail is rewritten, so views reload it.
    let previewStamp: Date?
    /// An untitled document that only exists as a recovery package (`url` points into the Recovery folder). Saving it
    /// anywhere moves it out of this state; removing it deletes the only copy.
    var isUnsaved = false
    /// An unsaved document's own name (it has no file name).
    var unsavedName: String?

    var id: String { url.path }
    var name: String { unsavedName ?? url.deletingPathExtension().lastPathComponent }
    /// The containing folder's name ("Home" for the home folder itself).
    var folder: String {
        if isUnsaved { return "Unsaved" }
        let parent = url.deletingLastPathComponent()
        if parent.path == NSHomeDirectory() { return "Home" }
        return parent.lastPathComponent
    }

    /// File > Open Recent: unsaved documents all look alike by name, so they carry their date.
    var menuTitle: String {
        isUnsaved ? "\(name) (unsaved, \(lastOpened.formatted(date: .abbreviated, time: .shortened)))" : name
    }
}

/// Persistent recents: recorded when a document is opened, saved or saved as. Home reads `items`.
///
/// `items` also holds the unsaved documents: every untitled document with a recovery package that has an artboard
/// (`UnsavedScanner`), flagged `isUnsaved`. They are not part of the persistent list: they are found on disk each time
/// (`reload`), so they show up whatever happened to the window that held them, and they leave the list when the document
/// is saved (its recovery package is deleted) or deleted.
@MainActor
final class RecentDocuments: ObservableObject {
    static let shared = RecentDocuments(defaults: RecentDocuments.sharedDefaults)

    /// Unit tests run inside the app: keep them out of the real preferences and the system recents. A path as the
    /// suite name keeps the plist in the temporary folder, not in ~/Library/Preferences.
    private static let underTest = AppEnvironment.underTest
    private static var sharedDefaults: UserDefaults {
        underTest ? UserDefaults(suiteName: FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-tests-recents").path) ?? .standard : .standard
    }

    private static let defaultsKey = "ocelot.recentDocuments"

    @Published private(set) var items: [RecentDocument] = []

    private let defaults: UserDefaults
    private let notifySystem: Bool
    private let recoveryDirectory: () -> URL
    private var list = RecentList()
    private var scanner = UnsavedScanner()
    private var unsaved: [RecentDocument] = []

    /// `recoveryDirectory` is where untitled documents autosave (tests point it at a temporary folder).
    init(defaults: UserDefaults, notifySystem: Bool? = nil, recoveryDirectory: (() -> URL)? = nil) {
        self.defaults = defaults
        self.notifySystem = notifySystem ?? !Self.underTest
        self.recoveryDirectory = recoveryDirectory ?? { DocumentSession.recoveryDirectory }
        reload()
    }

    /// How many recent documents have a file (what Clear Menu forgets); unsaved documents stay listed.
    var savedCount: Int { list.entries.count }

    /// Re-reads the list from disk, drops documents that no longer exist, finds the unsaved documents and updates
    /// `items`. Cheap: the list holds at most `RecentList.limit` entries and recovery packages are read again only when
    /// their `document.json` changed.
    func reload() {
        let stored = Self.decode(defaults.data(forKey: Self.defaultsKey))
        let pruned = stored.pruned(resolve: Self.resolve)
        if pruned != stored { persist(pruned) }
        list = pruned
        unsaved = scanner.scan(in: recoveryDirectory()).map(Self.document)
        publish()
    }

    /// Records `url` as just used (open, save, save as).
    func note(_ url: URL, date: Date = Date()) {
        let url = url.standardizedFileURL
        var next = list
        next.note(RecentEntry(path: url.path, bookmark: try? url.bookmarkData(), lastOpened: date))
        persist(next)
        list = next
        publish()
        if notifySystem { NSDocumentController.shared.noteNewRecentDocumentURL(url) }
    }

    /// Forgets a saved document (the file stays). An unsaved document is not forgotten this way: it has no other copy,
    /// so only `discardUnsaved` removes it.
    func remove(_ url: URL) {
        var next = list
        next.remove(path: url.standardizedFileURL.path)
        persist(next)
        list = next
        publish()
    }

    /// File > Open Recent > Clear Menu: forgets every recent document that has a file (the files stay). Unsaved documents
    /// stay: their recovery package is the only copy.
    func clear() {
        list = RecentList()
        persist(list)
        publish()
        if notifySystem { NSDocumentController.shared.clearRecentDocuments(nil) }
    }

    /// Deletes an unsaved document's recovery package, the only copy of it. Callers ask the person first. False when `url`
    /// is not a recovery package (a saved document is never deleted from here).
    @discardableResult
    func discardUnsaved(_ url: URL) -> Bool {
        guard UnsavedScanner.isPackage(url, in: recoveryDirectory()) else { return false }
        try? FileManager.default.removeItem(at: url)
        reload()
        return true
    }

    // MARK: Internals

    /// Saved and unsaved documents by date, newest first (a tie keeps the saved one first).
    private func publish() {
        let directory = recoveryDirectory()
        let saved = list.entries
            .map(Self.document)
            .filter { !UnsavedScanner.isPackage($0.url, in: directory) } // a recovery package opened by path is listed as unsaved, not as a file
        let merged = (saved + unsaved).enumerated()
            .sorted { ($0.element.lastOpened, $1.offset) > ($1.element.lastOpened, $0.offset) }
            .map(\.element)
        if merged != items { items = merged }
    }

    private func persist(_ list: RecentList) {
        defaults.set(try? JSONEncoder().encode(list.entries), forKey: Self.defaultsKey)
    }

    private static func decode(_ data: Data?) -> RecentList {
        guard let data, let entries = try? JSONDecoder().decode([RecentEntry].self, from: data) else { return RecentList() }
        return RecentList(entries: entries)
    }

    /// Where the entry's document is now: via its bookmark (follows renames and moves), else its path; nil when
    /// no package with a `document.json` is there (a document on an unmounted volume is kept).
    nonisolated static func resolve(_ entry: RecentEntry) -> URL? {
        if let bookmark = entry.bookmark {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: bookmark, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale),
               DocumentPackage.hasDocument(at: url) {
                return url.standardizedFileURL
            }
        }
        let url = URL(fileURLWithPath: entry.path).standardizedFileURL
        if DocumentPackage.hasDocument(at: url) { return url }
        // A document on a disk that is not attached right now is not gone: keep it until the disk is back.
        return isOnUnmountedVolume(url.path) ? url : nil
    }

    /// Whether `path` lies on an external volume (`/Volumes/<name>/…`) that is not mounted.
    nonisolated static func isOnUnmountedVolume(_ path: String) -> Bool {
        let parts = URL(fileURLWithPath: path).standardizedFileURL.pathComponents
        guard parts.count > 3, parts[1] == "Volumes" else { return false }
        return !FileManager.default.fileExists(atPath: "/Volumes/\(parts[2])")
    }

    private static func document(_ entry: RecentEntry) -> RecentDocument {
        let url = URL(fileURLWithPath: entry.path)
        let preview = DocumentPackage.previewURL(in: url)
        let stamp = (try? preview.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
        return RecentDocument(url: url, lastOpened: entry.lastOpened, previewURL: stamp == nil ? nil : preview, previewStamp: stamp)
    }

    private static func document(_ unsaved: UnsavedDocument) -> RecentDocument {
        RecentDocument(url: unsaved.url, lastOpened: unsaved.date, previewURL: unsaved.previewURL, previewStamp: unsaved.previewStamp, isUnsaved: true, unsavedName: unsaved.name)
    }
}
