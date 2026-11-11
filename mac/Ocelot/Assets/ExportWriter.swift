import Foundation

/// `host.exportSave`: validates an export file list and writes it below `<chosen folder>/<name>/`.
/// Pure file logic (the folder picker lives in `AssetBridge`), so path safety is unit-testable.
enum ExportWriter {
    struct File: Sendable, Equatable {
        enum Content: Sendable, Equatable {
            case text(String)
            case asset(String)
            case font(String)
            case data(Data)
        }

        let path: String
        let content: Content
    }

    /// A single folder name: no separators, no `.`/`..`.
    static func validateName(_ name: String) throws -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let bad = trimmed.isEmpty || trimmed == "." || trimmed == ".." || trimmed.count > 120
            || trimmed.contains("/") || trimmed.contains("\\") || trimmed.contains(":") || trimmed.contains("\0")
        guard !bad else {
            throw BridgeFailure(.invalidParams, "The export name \"\(name)\" is not a valid folder name. Use a plain name without slashes, for example \"landing-page\".")
        }
        return trimmed
    }

    /// A relative path that stays inside the export folder; returns it normalized (no `.`/empty parts).
    static func validatePath(_ path: String) throws -> String {
        func reject(_ why: String) -> BridgeFailure {
            BridgeFailure(.invalidParams, "Export file path \"\(path)\" \(why). Use relative paths like \"index.html\" or \"assets/<id>.png\".")
        }
        guard !path.isEmpty else { throw reject("is empty") }
        guard !path.hasPrefix("/"), !path.hasPrefix("~") else { throw reject("is absolute") }
        guard !path.contains("\\"), !path.contains("\0"), !path.contains(":") else { throw reject("contains characters that are not allowed") }
        var parts: [Substring] = []
        for part in path.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." { throw reject("climbs out of the export folder (..)") }
            parts.append(part)
        }
        guard !parts.isEmpty else { throw reject("names no file") }
        return parts.joined(separator: "/")
    }

    /// A file name inside the bundled fonts folder: no separators, only font files and their licence texts.
    static func isBundledFontName(_ name: String) -> Bool {
        guard name.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]*\\.(woff2|txt)$", options: .regularExpression) != nil else { return false }
        return !name.contains("..")
    }

    static func validate(_ files: [ExportFile]) throws -> [File] {
        var seen = Set<String>()
        var out: [File] = []
        for file in files {
            let path = try validatePath(file.path)
            guard seen.insert(path.lowercased()).inserted else {
                throw BridgeFailure(.invalidParams, "Export file path \"\(path)\" appears twice. Each file needs its own path.")
            }
            switch (file.text, file.assetId, file.font, file.base64) {
            case (let text?, nil, nil, nil):
                out.append(File(path: path, content: .text(text)))
            case (nil, nil, nil, let encoded?):
                guard let data = Data(base64Encoded: encoded, options: .ignoreUnknownCharacters) else {
                    throw BridgeFailure(.invalidParams, "Export file \"\(path)\": `base64` is not valid base64. Send the file's bytes as standard base64 (no data: prefix).")
                }
                out.append(File(path: path, content: .data(data)))
            case (nil, let id?, nil, nil):
                guard AssetPackage.isValidId(id) else {
                    throw BridgeFailure(.invalidParams, "\"\(id)\" is not an asset id (64 hex characters). list_assets shows the ids in this document.")
                }
                out.append(File(path: path, content: .asset(id)))
            case (nil, nil, let font?, nil):
                guard isBundledFontName(font) else {
                    throw BridgeFailure(.invalidParams, "\"\(font)\" is not a bundled font file name (letters, digits, `.`, `-`, `_`; .woff2 or .txt). list_fonts shows the bundled families.")
                }
                out.append(File(path: path, content: .font(font)))
            default:
                throw BridgeFailure(.invalidParams, "Export file \"\(path)\" needs exactly one of `text`, `assetId`, `font` or `base64`.")
            }
        }
        return out
    }

    /// Writes the files below `<chosen>/<name>/` and returns that folder. `assetFiles` maps asset id -> source file; `fontsRoot` is the
    /// folder of bundled fonts (`dist/fonts`) that `font` files are copied from.
    /// Existing files at the same paths are replaced. Blocking: call off the main actor.
    static func write(into chosen: URL, name: String, files: [File], assetFiles: [String: URL], fontsRoot: URL? = nil) throws -> URL {
        let fm = FileManager.default
        let root = chosen.appendingPathComponent(try validateName(name), isDirectory: true)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let realRoot = root.resolvingSymlinksInPath().path + "/"
        for file in files {
            // `validatePath` refused absolute paths and `..`, so the path stays below `root` textually. The symlink check below compares
            // resolved paths on both sides: `standardizedFileURL` resolves /tmp and /var for an existing root but not for a file that does not exist yet.
            let target = root.appendingPathComponent(try validatePath(file.path))
            let parent = target.deletingLastPathComponent()
            try fm.createDirectory(at: parent, withIntermediateDirectories: true)
            // A symlink inside the folder must not redirect the write elsewhere.
            guard parent.resolvingSymlinksInPath().path.appending("/").hasPrefix(realRoot) else {
                throw BridgeFailure(.invalidParams, "Export file path \"\(file.path)\" goes through a link that leaves the export folder. Remove the link or export elsewhere.")
            }
            var isDirectory: ObjCBool = false
            if fm.fileExists(atPath: target.path, isDirectory: &isDirectory) {
                if isDirectory.boolValue {
                    throw BridgeFailure(.invalidParams, "\"\(file.path)\" already exists as a folder in the export destination. Pick another export name.")
                }
                try fm.removeItem(at: target)
            }
            switch file.content {
            case .text(let text):
                try Data(text.utf8).write(to: target)
            case .data(let data):
                try data.write(to: target)
            case .asset(let id):
                guard let source = assetFiles[id] else {
                    throw BridgeFailure(.invalidParams, "Unknown asset \"\(id)\" in the export. list_assets shows the asset ids in this document.")
                }
                try fm.copyItem(at: source, to: target)
            case .font(let name):
                guard let fontsRoot else {
                    throw BridgeFailure(.invalidParams, "The export lists the bundled font \"\(name)\", but this build has no bundled fonts folder. Rebuild the app with `make build`.")
                }
                let source = fontsRoot.appendingPathComponent(name)
                guard fm.fileExists(atPath: source.path) else {
                    throw BridgeFailure(.invalidParams, "\"\(name)\" is not a bundled font file. list_fonts shows the bundled families.")
                }
                try fm.copyItem(at: source, to: target)
            }
        }
        return root
    }
}
