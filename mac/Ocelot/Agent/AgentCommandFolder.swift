import AppKit
import Foundation

/// The folder of the person's own sidebar slash commands: `~/Library/Application Support/Ocelot/Commands/`, one Markdown
/// file per command. The editor parses the files (format: editor/src/agent); the host only lists, creates and shows the folder.
/// Mirrored by `listCommandFiles` in editor/e2e/headless-host.mjs.
struct AgentCommandFolder: Sendable {
    static let maxFiles = 200
    static let maxFileBytes = 64 * 1024

    let url: URL

    /// The app's real Application Support, the same base the agent history uses.
    static func standard() -> AgentCommandFolder {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return AgentCommandFolder(url: base.appendingPathComponent("Ocelot/Commands", isDirectory: true))
    }

    private var fm: FileManager { .default }

    /// The top-level regular `*.md` files (case-insensitive, not hidden; a symlink counts only when it points at a regular file),
    /// at most `maxFiles`, each at most `maxFileBytes` and valid UTF-8 (others are skipped), sorted by name.
    /// A missing folder has no files.
    func list() throws -> AgentCommandFiles {
        guard fm.fileExists(atPath: url.path) else { return AgentCommandFiles(folder: url.path, files: []) }
        let names: [String]
        do {
            names = try fm.contentsOfDirectory(atPath: url.path)
        } catch {
            throw BridgeFailure(.internal, "Could not read the commands folder \(url.path): \(error.localizedDescription). Check that Ocelot may read it, or use Settings > Agent > Open Folder to show it.")
        }
        var files: [AgentCommandFile] = []
        for name in names.filter({ !$0.hasPrefix(".") && $0.lowercased().hasSuffix(".md") }).sorted() {
            if files.count >= Self.maxFiles { break }
            guard let text = Self.readCommand(url.appendingPathComponent(name)) else { continue }
            files.append(AgentCommandFile(name: name, text: text))
        }
        return AgentCommandFiles(folder: url.path, files: files)
    }

    /// The command names the person's files make (`brand-check.md` is `brand-check`): the files whose names are valid command
    /// names (lowercase letters, digits and dashes, starting with a letter).
    func commandNames() throws -> [String] {
        try list().files.compactMap { file in
            let name = String(file.name.dropLast(3))
            let bytes = Array(name.utf8)
            let lower: ClosedRange<UInt8> = 0x61...0x7A, digit: ClosedRange<UInt8> = 0x30...0x39
            guard let first = bytes.first, lower.contains(first), bytes.allSatisfy({ lower.contains($0) || digit.contains($0) || $0 == 0x2D })
            else { return nil }
            return name
        }
    }

    /// Creates the folder (0755) when missing.
    func create() throws {
        do {
            try fm.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        } catch {
            throw BridgeFailure(.internal, "Could not create the commands folder \(url.path): \(error.localizedDescription). Create it yourself in Finder, then try again.")
        }
    }

    /// Creates the folder when missing and shows it in Finder.
    @MainActor
    func reveal() throws {
        try create()
        NSWorkspace.shared.open(url)
    }

    private static func readCommand(_ file: URL) -> String? {
        // The target of a symlink must be a regular file (never a folder, a device or a pipe).
        let target = file.resolvingSymlinksInPath()
        guard let values = try? target.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true, let size = values.fileSize, size <= maxFileBytes,
              let data = try? Data(contentsOf: target), data.count <= maxFileBytes
        else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
