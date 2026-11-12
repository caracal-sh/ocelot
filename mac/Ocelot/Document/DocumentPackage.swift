import Foundation
import UniformTypeIdentifiers

extension UTType {
    /// `.ocelot` document package (a directory Finder shows as one file).
    static let ocelotDocument = UTType(exportedAs: "sh.caracal.ocelot.document", conformingTo: .package)
    /// `.atelier` package written by the app's earlier releases: same layout, declared as an imported type so it still opens.
    static let legacyAtelierDocument = UTType(importedAs: "com.caracal.atelier.document", conformingTo: .package)
}

/// Reads and writes the `.ocelot` package (and `.atelier`, the same package under its old name; see `DocumentExtension`):
///
///     Name.ocelot/
///       document.json   DocumentFile (Yjs state + readable tree)
///       assets/         content-addressed images + manifest.json
///       preview.png     thumbnail of the first artboard (Home window); optional, rewritten on save, never read by the editor
enum DocumentPackage {
    /// What Open… and drops accept: new documents and legacy `.atelier` packages.
    static let openableTypes: [UTType] = [.ocelotDocument, .legacyAtelierDocument]
    static let documentFileName = "document.json"
    static let assetsDirectoryName = "assets"
    static let previewFileName = "preview.png"
    /// Longest side of the thumbnail kept (px): twice what Home draws, so it stays sharp on Retina.
    static let previewMaxSide = 640

    enum Failure: LocalizedError {
        case missingDocumentJSON(URL)
        case unreadable(URL, String)

        var errorDescription: String? {
            switch self {
            case .missingDocumentJSON(let url):
                "\(url.lastPathComponent) is not an Ocelot document (no document.json inside)."
            case .unreadable(let url, let reason):
                "Could not read \(url.lastPathComponent): \(reason)"
            }
        }
    }

    static func encode(_ file: DocumentFile) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(file)
    }

    /// Writes `document.json` (atomically) into the package, leaving everything else in it, notably `assets/`,
    /// untouched: images can be hundreds of megabytes and must never be read just to save the document.
    static func write(_ file: DocumentFile, to url: URL) throws {
        let data = try encode(file)
        let fm = FileManager.default
        var isDirectory: ObjCBool = false
        if fm.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue {
            try fm.removeItem(at: url) // a plain file where the package should be
        }
        if !fm.fileExists(atPath: url.path) {
            // New package: assemble it beside the target and move it into place so it appears complete.
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let staging = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString.prefix(8)).tmp", isDirectory: true)
            try fm.createDirectory(at: staging.appendingPathComponent(assetsDirectoryName, isDirectory: true), withIntermediateDirectories: true)
            try data.write(to: staging.appendingPathComponent(documentFileName))
            do { try fm.moveItem(at: staging, to: url) } catch {
                try? fm.removeItem(at: staging)
                throw error
            }
            return
        }
        try fm.createDirectory(at: url.appendingPathComponent(assetsDirectoryName, isDirectory: true), withIntermediateDirectories: true)
        try data.write(to: url.appendingPathComponent(documentFileName), options: [.atomic])
    }

    static func previewURL(in package: URL) -> URL {
        package.appendingPathComponent(previewFileName)
    }

    /// Writes `preview.png` into an existing package (atomically), or removes it when `png` is nil (the
    /// document no longer has an artboard to show). Does nothing when the package is gone: a thumbnail
    /// must never resurrect a deleted document.
    static func writePreview(_ png: Data?, to package: URL) throws {
        guard hasDocument(at: package) else { return }
        let url = previewURL(in: package)
        guard let png else {
            try? FileManager.default.removeItem(at: url)
            return
        }
        try png.write(to: url, options: [.atomic])
    }

    /// Whether `url` is a package someone saved a document into (an assets-only recovery folder is not one).
    static func hasDocument(at url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.appendingPathComponent(documentFileName).path)
    }

    /// Whether the document holds any artboard (what a person would miss): the readable `tree.artboards` list.
    static func hasArtboards(_ file: DocumentFile) -> Bool { hasArtboards(tree: file.tree) }

    static func hasArtboards(tree: JSONValue) -> Bool {
        guard case .object(let fields) = tree, case .array(let artboards)? = fields["artboards"] else { return false }
        return !artboards.isEmpty
    }

    static func read(from url: URL) throws -> DocumentFile {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw Failure.unreadable(url, "the file does not exist")
        }
        guard isDirectory.boolValue, hasDocument(at: url) else { throw Failure.missingDocumentJSON(url) }
        let data: Data
        do {
            data = try Data(contentsOf: url.appendingPathComponent(documentFileName))
        } catch {
            throw Failure.unreadable(url, error.localizedDescription)
        }
        do {
            return try JSONDecoder().decode(DocumentFile.self, from: data)
        } catch {
            throw Failure.unreadable(url, String(describing: error))
        }
    }
}
