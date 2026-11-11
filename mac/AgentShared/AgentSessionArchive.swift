import Foundation

/// One conversation's omp session directory as a single `Data`: how it crosses between the app (which owns the stored
/// copy under `Agent/conversations/`) and the sandboxed agent service (whose private scratch holds the copy omp works on).
/// The service cannot read `conversations/`, so nothing but this archive ever moves between them, over XPC.
///
/// Regular files only (omp writes nothing else there), paths relative to the directory, modification times kept: recovery
/// after a crash compares them. Layout, all big-endian: `"OSA1"`, u32 file count, then per file u32 path length, path (UTF-8,
/// `/`-separated), u64 modification time (the bit pattern of seconds since 1970 as a Double), u64 size, bytes.
enum AgentSessionArchive {
    struct Failure: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }

    private static let magic = Data("OSA1".utf8)
    private static let maxDepth = 8
    private static let maxPathBytes = 512

    /// Every regular file below `directory` (symlinks and anything else are left out), packed. A missing directory packs as empty.
    static func pack(directory: URL) throws -> Data {
        var entries: [(path: String, url: URL, modified: Date)] = []
        try collect(directory.resolvingSymlinksInPath(), prefix: "", into: &entries)
        entries.sort { $0.path < $1.path }
        var out = magic
        out.append(UInt32(entries.count))
        for entry in entries {
            let path = Data(entry.path.utf8)
            let bytes = try Data(contentsOf: entry.url)
            out.append(UInt32(path.count))
            out.append(path)
            out.append(entry.modified.timeIntervalSince1970.bitPattern)
            out.append(UInt64(bytes.count))
            out.append(bytes)
        }
        return out
    }

    /// Regular files below `directory` (symlinks and anything else skipped), by relative path.
    private static func collect(_ directory: URL, prefix: String, into entries: inout [(path: String, url: URL, modified: Date)]) throws {
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey]
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names.sorted() {
            let url = directory.appendingPathComponent(name)
            let values = try url.resourceValues(forKeys: keys)
            guard values.isSymbolicLink != true else { continue }
            if values.isDirectory == true {
                try collect(url, prefix: "\(prefix)\(name)/", into: &entries)
            } else if values.isRegularFile == true {
                entries.append(("\(prefix)\(name)", url, values.contentModificationDate ?? Date()))
            }
        }
    }

    /// Writes the archive's files into `directory` (created, owner-only, with every parent it needs). Refuses a path that
    /// is absolute or climbs out (`..`), so a damaged or forged archive can only ever write below `directory`.
    static func unpack(_ archive: Data, into directory: URL) throws {
        let fm = FileManager.default
        try makeDirectory(directory)
        if archive.isEmpty { return }
        var cursor = Cursor(data: archive)
        guard try cursor.take(4) == magic else { throw Failure("The conversation's session files are not in a format this version of Ocelot reads.") }
        let count = try cursor.u32()
        for _ in 0..<count {
            let pathLength = Int(try cursor.u32())
            guard pathLength > 0, pathLength <= maxPathBytes, let path = String(data: try cursor.take(pathLength), encoding: .utf8) else {
                throw Failure("A session file in the archive has an unreadable name.")
            }
            let modified = Date(timeIntervalSince1970: Double(bitPattern: try cursor.u64()))
            let size = Int(clamping: try cursor.u64())
            let bytes = try cursor.take(size)
            let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard parts.count <= maxDepth, !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." || $0.contains("\0") }) else {
                throw Failure("A session file in the archive has a name that leaves its folder (\(path)).")
            }
            var parent = directory
            for part in parts.dropLast() {
                parent.appendPathComponent(part, isDirectory: true)
                try makeDirectory(parent)
            }
            let file = parent.appendingPathComponent(parts[parts.count - 1])
            try Data(bytes).write(to: file, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o600, .modificationDate: modified], ofItemAtPath: file.path)
        }
        guard cursor.isAtEnd else { throw Failure("The conversation's session archive has trailing bytes.") }
    }

    /// Replaces `directory` with the archive's files in one step: unpacked next to it, then swapped in, so a crash leaves
    /// the old copy or the new one, never half of each. The parent must exist.
    static func replace(directory: URL, withArchive archive: Data) throws {
        let fm = FileManager.default
        let parent = directory.deletingLastPathComponent()
        let prefix = ".incoming-\(directory.lastPathComponent)-"
        // A crash can leave a staging folder of this conversation behind (copies of one conversation never overlap).
        for name in (try? fm.contentsOfDirectory(atPath: parent.path)) ?? [] where name.hasPrefix(prefix) {
            try? fm.removeItem(at: parent.appendingPathComponent(name))
        }
        let staging = parent.appendingPathComponent("\(prefix)\(UUID().uuidString)", isDirectory: true)
        do {
            try unpack(archive, into: staging)
            if fm.fileExists(atPath: directory.path) {
                _ = try fm.replaceItemAt(directory, withItemAt: staging)
            } else {
                try fm.moveItem(at: staging, to: directory)
            }
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path) // a replaced folder may keep the old one's mode
        } catch {
            try? fm.removeItem(at: staging)
            throw error
        }
    }

    /// The newest modification time of any file below `directory`; nil when there is none.
    static func newestModification(of directory: URL) -> Date? {
        var entries: [(path: String, url: URL, modified: Date)] = []
        try? collect(directory.resolvingSymlinksInPath(), prefix: "", into: &entries)
        return entries.map(\.modified).max()
    }

    private static func makeDirectory(_ url: URL) throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: url.path) { return }
        try fm.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }

    private struct Cursor {
        let data: Data
        var offset = 0

        init(data: Data) { self.data = data }

        var isAtEnd: Bool { offset == data.count }

        mutating func take(_ count: Int) throws -> Data {
            guard count >= 0, count <= data.count - offset else { throw Failure("The conversation's session archive is cut short.") }
            let start = data.startIndex + offset
            offset += count
            return data[start..<(start + count)]
        }

        mutating func u32() throws -> UInt32 { try take(4).reduce(0) { $0 << 8 | UInt32($1) } }
        mutating func u64() throws -> UInt64 { try take(8).reduce(0) { $0 << 8 | UInt64($1) } }
    }
}

private extension Data {
    mutating func append(_ value: UInt32) { Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) } }
    mutating func append(_ value: UInt64) { Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) } }
}
