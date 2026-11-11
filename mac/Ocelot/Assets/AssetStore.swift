import Foundation

/// What a caller knows about an image when it is stored.
struct AssetMetadata: Sendable {
    var name: String?
    var kind: String = "upload"
    var prompt: String?
    var provider: String?
    var model: String?
    var seed: Int?
    var sources: [String]?
    var params: JSONValue?
}

/// Content-addressed image store for one document window: `<package>/assets/<sha256>.<ext>` plus an atomic
/// `manifest.json`. An actor so every manifest read-modify-write is serialized and file IO stays off the main
/// thread; the package it works in follows the window (`AssetRoot`) and is resolved at the start of each call.
actor AssetStore {
    static let kinds: Set<String> = ["generated", "edited", "background_removed", "upload"]

    private let root: AssetRoot
    private var cachedDirectory: URL?
    private var cachedStamp: Date?
    private var cache: [AssetRecord] = []

    init(root: AssetRoot) { self.root = root }

    // MARK: Reads

    func list() throws -> [AssetRecord] { try load().records }

    func record(_ id: String) throws -> AssetRecord {
        let (records, _) = try load()
        guard AssetPackage.isValidId(id), let record = records.first(where: { $0.id == id }) else { throw Self.unknown(id) }
        return record
    }

    /// Record and bytes of one asset (the whole file: callers are the bridge and the providers' reference inputs).
    func read(_ id: String) throws -> (record: AssetRecord, data: Data) {
        let (records, directory) = try load()
        guard AssetPackage.isValidId(id), let record = records.first(where: { $0.id == id }) else { throw Self.unknown(id) }
        guard let url = AssetPackage.fileURL(for: record, in: directory), let data = try? Data(contentsOf: url) else {
            throw Self.missingFile(id)
        }
        return (record, data)
    }

    /// The asset's file, for copying into an export folder.
    func fileURL(_ id: String) throws -> URL {
        let (records, directory) = try load()
        guard AssetPackage.isValidId(id), let record = records.first(where: { $0.id == id }) else { throw Self.unknown(id) }
        guard let url = AssetPackage.fileURL(for: record, in: directory), FileManager.default.fileExists(atPath: url.path) else {
            throw Self.missingFile(id)
        }
        return url
    }

    // MARK: Writes

    /// Hashes, sniffs and stores `data`. Identical bytes import once: the existing record wins.
    func importData(_ data: Data, _ meta: AssetMetadata = AssetMetadata()) throws -> AssetRecord {
        guard !data.isEmpty else {
            throw BridgeFailure(.invalidParams, "The image data is empty. Pass the base64 of a PNG, JPEG, WebP, GIF, AVIF or SVG file.")
        }
        guard data.count <= AssetPackage.maxImportBytes else {
            throw BridgeFailure(.invalidParams, "The image is \(data.count / 1_048_576) MB; the limit is \(AssetPackage.maxImportBytes / 1_048_576) MB. Downscale or recompress it first.")
        }
        guard let kind = ImageSniffer.sniff(data) else {
            throw BridgeFailure(.invalidParams, "The data is not a supported image. Use PNG, JPEG, WebP, GIF, AVIF or SVG.")
        }
        guard AssetStore.kinds.contains(meta.kind) else {
            throw BridgeFailure(.invalidParams, "Unknown asset kind \"\(meta.kind)\". Use generated, edited, background_removed or upload.")
        }
        let (records, directory) = try load()
        let id = AssetPackage.sha256Hex(data)
        let fm = FileManager.default
        if let existing = records.first(where: { $0.id == id }) {
            guard let existingFile = AssetPackage.fileURL(for: existing, in: directory) else { throw Self.missingFile(id) }
            if !fm.fileExists(atPath: existingFile.path) { try data.write(to: existingFile, options: [.atomic]) }
            return existing
        }
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let size = ImageSniffer.pixelSize(of: data, kind: kind)
        let record = AssetRecord(
            id: id, ext: kind.ext, mime: kind.mime, bytes: data.count, width: size?.width, height: size?.height,
            created: AssetPackage.timestamp(), kind: meta.kind, name: meta.name, prompt: meta.prompt,
            provider: meta.provider, model: meta.model, seed: meta.seed,
            sources: (meta.sources?.isEmpty ?? true) ? nil : meta.sources, params: meta.params
        )
        guard let file = AssetPackage.fileURL(for: record, in: directory) else { throw Self.missingFile(id) }
        try data.write(to: file, options: [.atomic])
        try store(records + [record], in: directory)
        return record
    }

    /// Removes files and manifest entries; unknown ids are ignored. Returns the remaining manifest.
    func delete(_ ids: [String]) throws -> [AssetRecord] {
        let (records, directory) = try load()
        let doomed = Set(ids.filter(AssetPackage.isValidId))
        let removed = records.filter { doomed.contains($0.id) }
        guard !removed.isEmpty else { return records }
        let remaining = records.filter { !doomed.contains($0.id) }
        try store(remaining, in: directory)
        // `removeItem` unlinks a symlink instead of following it, and the name is `<64 hex>.<known ext>` (the
        // manifest was sanitized on load), so this can only ever remove files directly inside `assets/`.
        for record in removed { try? FileManager.default.removeItem(at: directory.appendingPathComponent(AssetPackage.fileName(for: record))) }
        return remaining
    }

    /// Save As / recovery -> saved: brings the assets of `oldPackage` into the current package.
    func adopt(from oldPackage: URL) throws {
        try AssetPackage.merge(from: oldPackage, to: root.url)
        cachedDirectory = nil
    }

    // MARK: Internals

    private func load() throws -> (records: [AssetRecord], directory: URL) {
        let directory = AssetPackage.assetsDirectory(of: root.url)
        let stamp = Self.manifestStamp(directory)
        if cachedDirectory == directory, cachedStamp == stamp { return (cache, directory) }
        let records = try AssetPackage.loadManifest(in: directory)
        cache = records
        cachedDirectory = directory
        cachedStamp = stamp
        return (records, directory)
    }

    private func store(_ records: [AssetRecord], in directory: URL) throws {
        try AssetPackage.saveManifest(records, in: directory)
        cache = records.sorted { $0.created < $1.created }
        cachedDirectory = directory
        cachedStamp = Self.manifestStamp(directory)
    }

    private static func manifestStamp(_ directory: URL) -> Date? {
        try? AssetPackage.manifestURL(in: directory).resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
    }

    private static func unknown(_ id: String) -> BridgeFailure {
        BridgeFailure(.invalidParams, "Unknown asset \"\(id)\". Call list_assets to see the asset ids in this document.")
    }

    private static func missingFile(_ id: String) -> BridgeFailure {
        BridgeFailure(.internal, "The file for asset \(id) is missing from the document's assets folder, or is not a plain file inside it. Remove the asset in the Assets panel and import or generate the image again.")
    }
}
