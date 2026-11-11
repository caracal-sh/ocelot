import CryptoKit
import Foundation
import os

/// The window's current package directory, readable from any thread. `DocumentSession` keeps it equal to
/// the saved document's `.ocelot` (or the untitled document's recovery package) so a store call always
/// resolves the root synchronously, with no suspension point between "which package" and "write the file".
final class AssetRoot: Sendable {
    private let lock: OSAllocatedUnfairLock<URL>

    init(_ url: URL) { lock = OSAllocatedUnfairLock(initialState: url) }

    var url: URL { lock.withLock { $0 } }

    func set(_ url: URL) { lock.withLock { $0 = url } }
}

/// `assets/manifest.json`: `{ "version": 1, "assets": AssetRecord[] }`.
struct AssetManifest: Codable, Sendable, Equatable {
    var version = 1
    var assets: [AssetRecord]
}

/// On-disk layout of `<package>/assets/`. Plain file IO, no state: call off the main actor.
enum AssetPackage {
    static let manifestName = "manifest.json"
    static let maxImportBytes = 100 * 1024 * 1024

    static func assetsDirectory(of package: URL) -> URL {
        package.appendingPathComponent(DocumentPackage.assetsDirectoryName, isDirectory: true)
    }

    static func manifestURL(in assets: URL) -> URL { assets.appendingPathComponent(manifestName) }

    /// The asset's file name, `<id>.<ext>`. Only call with a record that went through `sanitize`.
    static func fileName(for record: AssetRecord) -> String { "\(record.id).\(record.ext)" }

    /// The asset's file inside `assets`, or nil when the record is malformed or the file is a symlink or
    /// otherwise resolves outside the folder (a shared package is untrusted input).
    static func fileURL(for record: AssetRecord, in assets: URL) -> URL? {
        guard isValidId(record.id), isValidExtension(record.ext) else { return nil }
        let url = assets.appendingPathComponent(fileName(for: record))
        let fm = FileManager.default
        if (try? fm.destinationOfSymbolicLink(atPath: url.path)) != nil { return nil }
        let base = assets.resolvingSymlinksInPath().standardizedFileURL.path
        guard url.resolvingSymlinksInPath().standardizedFileURL.path.hasPrefix(base + "/") else { return nil }
        return url
    }

    /// An extension a stored asset can have (the formats `ImageSniffer` knows); anything else would let a
    /// manifest steer the file name.
    static func isValidExtension(_ ext: String) -> Bool { ImageSniffer.supportedExtensions.contains(ext) }

    /// Keeps the records whose `id` is a SHA-256 hex digest and whose `ext` is a supported image extension
    /// (first one wins per id) and derives `mime` from `ext`. The manifest of a package someone else made is
    /// never trusted to name files.
    static func sanitize(_ records: [AssetRecord]) -> [AssetRecord] {
        var seen = Set<String>()
        var clean: [AssetRecord] = []
        for var record in records {
            guard isValidId(record.id), let mime = ImageSniffer.mime(forExtension: record.ext), seen.insert(record.id).inserted else { continue }
            record.mime = mime
            clean.append(record)
        }
        return clean
    }

    /// Lowercase hex SHA-256, the only shape an asset id can have (so ids can never traverse paths).
    static func isValidId(_ id: String) -> Bool {
        id.utf8.count == 64 && id.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func timestamp(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    // MARK: Manifest

    /// Reads the manifest. A missing manifest is rebuilt from the files present; an unreadable one is moved
    /// aside (`manifest.corrupt.json`) and rebuilt, so a damaged manifest never strands the images.
    static func loadManifest(in assets: URL) throws -> [AssetRecord] {
        let url = manifestURL(in: assets)
        let fm = FileManager.default
        guard fm.fileExists(atPath: url.path) else { return rebuild(in: assets) }
        do {
            let data = try Data(contentsOf: url)
            return sanitize(try JSONDecoder().decode(AssetManifest.self, from: data).assets)
        } catch {
            let aside = assets.appendingPathComponent("manifest.corrupt.json")
            try? fm.removeItem(at: aside)
            try? fm.moveItem(at: url, to: aside)
            return rebuild(in: assets)
        }
    }

    static func saveManifest(_ records: [AssetRecord], in assets: URL) throws {
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(AssetManifest(assets: records.sorted { $0.created < $1.created }))
        try data.write(to: manifestURL(in: assets), options: [.atomic])
    }

    /// Records for `<64 hex>.<ext>` files already in the folder (used when the manifest is missing or damaged).
    private static func rebuild(in assets: URL) -> [AssetRecord] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: assets.path) else { return [] }
        var records: [AssetRecord] = []
        for name in names {
            let parts = name.split(separator: ".", omittingEmptySubsequences: false)
            guard parts.count == 2, isValidId(String(parts[0])), let mime = ImageSniffer.mime(forExtension: String(parts[1])) else { continue }
            let url = assets.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: url, options: .mappedIfSafe), ImageSniffer.sniff(data) != nil else { continue }
            let kind = ImageSniffer.sniff(data)
            let size = kind.flatMap { ImageSniffer.pixelSize(of: data, kind: $0) }
            let created = (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date()
            records.append(AssetRecord(
                id: String(parts[0]), ext: String(parts[1]), mime: mime, bytes: data.count,
                width: size?.width, height: size?.height, created: timestamp(created), kind: "upload"
            ))
        }
        return records.sorted { $0.created < $1.created }
    }

    // MARK: Package transitions

    /// Copies `old`'s assets into `new` (Save As, recovery -> saved): files the destination lacks are cloned
    /// (APFS copy-on-write, no data is read into memory) and the manifests are merged, destination entries first.
    static func merge(from old: URL, to new: URL) throws {
        let source = assetsDirectory(of: old)
        let destination = assetsDirectory(of: new)
        guard source.standardizedFileURL.path != destination.standardizedFileURL.path,
              FileManager.default.fileExists(atPath: source.path)
        else { return }
        let fm = FileManager.default
        try fm.createDirectory(at: destination, withIntermediateDirectories: true)
        var merged = try loadManifest(in: destination)
        let known = Set(merged.map(\.id))
        for record in try loadManifest(in: source) where !known.contains(record.id) {
            guard let from = fileURL(for: record, in: source), let to = fileURL(for: record, in: destination),
                  fm.fileExists(atPath: from.path) else { continue }
            if !fm.fileExists(atPath: to.path) { try fm.copyItem(at: from, to: to) }
            merged.append(record)
        }
        try saveManifest(merged, in: destination)
    }
}
