import Foundation

/// Private storage of the sidebar agent's conversations, per project (document). The editor owns the formats: the host
/// stores an opaque summary and an opaque transcript per conversation, and creates and removes the directory omp keeps its
/// own session in (the model's memory). Layout and limits: `AgentConversationPaths`; mirrored by editor/e2e/agent-history.mjs.
///
/// Everything is owner-only and outside the document package. Nothing here is reachable from the sandboxed agent: it has no
/// entitlement for the agent folder, and works on a private copy of its own conversation's session files that the app puts in
/// before the start and takes out after every turn (`packSession` / `restoreSession`).
///
/// A transcript names its attachments and tool thumbnails by file (`history/<projectId>/<id>.files/<name>`, content-addressed by
/// the editor, so one image is stored once however often it is shown); they go with the conversation.
struct AgentHistoryStore: Sendable {
    static let maxMetaBytes = 64 * 1024
    static let maxTranscriptBytes = 64 * 1024 * 1024
    static let maxFileBytes = 16 * 1024 * 1024

    /// The agent folder (`~/Library/Application Support/Ocelot/Agent`).
    let root: URL

    private var fm: FileManager { .default }

    // MARK: Paths

    private func historyDirectory(_ projectId: String) throws -> URL {
        guard AgentConversationPaths.isValidProjectId(projectId) else { throw BridgeFailure(.invalidParams, "Invalid project id.") }
        return root.appendingPathComponent(AgentConversationPaths.historyFolder, isDirectory: true).appendingPathComponent(projectId, isDirectory: true)
    }

    private func checked(_ id: String) throws -> String {
        guard AgentConversationPaths.isValidConversationId(id) else { throw BridgeFailure(.invalidParams, "Invalid conversation id.") }
        return id
    }

    private func metaFile(_ projectId: String, _ id: String) throws -> URL {
        try historyDirectory(projectId).appendingPathComponent("\(checked(id)).meta.json")
    }

    private func transcriptFile(_ projectId: String, _ id: String) throws -> URL {
        try historyDirectory(projectId).appendingPathComponent("\(checked(id)).transcript.json")
    }

    /// `history/<projectId>/<id>.files/`: the images a transcript refers to.
    private func filesDirectory(_ projectId: String, _ id: String) throws -> URL {
        try historyDirectory(projectId).appendingPathComponent("\(checked(id)).files", isDirectory: true)
    }

    /// A file name the editor chose: letters, digits and dashes and an image extension, never a path.
    static func isValidFileName(_ name: String) -> Bool {
        name.range(of: #"^[A-Za-z0-9-]{1,96}\.(png|jpg)$"#, options: .regularExpression) != nil
    }

    /// `conversations/<projectId>/<id>`; symlink-free, because the sandbox matches real paths only.
    private func conversationDirectory(_ projectId: String, _ id: String) throws -> URL {
        guard let path = AgentConversationPaths.sessionDirectory(agentFolder: root.resolvingSymlinksInPath().path, projectId: projectId, conversationId: id) else {
            throw BridgeFailure(.invalidParams, "Invalid project or conversation id.")
        }
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    /// Creates a directory and every missing parent below the agent folder, each owner-only.
    private func ensureDirectory(_ url: URL) throws {
        let base = root.resolvingSymlinksInPath().path
        let target = url.resolvingSymlinksInPath().path
        guard target.hasPrefix(base + "/") else { throw BridgeFailure(.internal, "Refusing a conversation path outside the agent folder.") }
        var current = URL(fileURLWithPath: base, isDirectory: true)
        for part in target.dropFirst(base.count + 1).split(separator: "/") {
            current.appendPathComponent(String(part), isDirectory: true)
            if !fm.fileExists(atPath: current.path) {
                try fm.createDirectory(at: current, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            }
        }
    }

    // MARK: Operations

    /// The directory omp stores this conversation's session in; created owner-only.
    func sessionDirectory(projectId: String, conversationId: String) throws -> URL {
        let dir = try conversationDirectory(projectId, conversationId)
        try ensureDirectory(dir)
        return dir
    }

    /// Every conversation of the project with its summary text (the editor parses it); unreadable ones are left out.
    func list(projectId: String) throws -> [AgentHistoryEntry] {
        let dir = try historyDirectory(projectId)
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return [] }
        var entries: [AgentHistoryEntry] = []
        for name in names.sorted() where name.hasSuffix(".meta.json") {
            let id = String(name.dropLast(".meta.json".count))
            guard AgentConversationPaths.isValidConversationId(id),
                  let data = try? Data(contentsOf: dir.appendingPathComponent(name)),
                  let meta = String(data: data, encoding: .utf8) else { continue }
            entries.append(AgentHistoryEntry(id: id, meta: meta))
        }
        return entries
    }

    func read(projectId: String, id: String) throws -> AgentHistoryTranscript {
        let file = try transcriptFile(projectId, id)
        guard fm.fileExists(atPath: file.path) else { return AgentHistoryTranscript() }
        let data = try Data(contentsOf: file)
        guard let text = String(data: data, encoding: .utf8) else { throw BridgeFailure(.internal, "The saved conversation is not readable text. Delete it from the history.") }
        let directory = try filesDirectory(projectId, id)
        var files: [AgentHistoryFile] = []
        for name in ((try? fm.contentsOfDirectory(atPath: directory.path)) ?? []).sorted() where Self.isValidFileName(name) {
            guard let bytes = try? Data(contentsOf: directory.appendingPathComponent(name)) else { continue }
            files.append(AgentHistoryFile(name: name, dataBase64: bytes.base64EncodedString()))
        }
        return AgentHistoryTranscript(text: text, files: files.isEmpty ? nil : files)
    }

    func write(projectId: String, id: String, meta: String, transcript: String?, files: [AgentHistoryFile] = []) throws {
        guard meta.utf8.count <= Self.maxMetaBytes else { throw BridgeFailure(.invalidParams, "The conversation summary is too large to store.") }
        if let transcript, transcript.utf8.count > Self.maxTranscriptBytes {
            throw BridgeFailure(.invalidParams, "The conversation is too large to store. Start a new conversation.")
        }
        try ensureDirectory(historyDirectory(projectId))
        // Files first, then the transcript that names them, then the summary: nothing points at what was not written.
        if !files.isEmpty {
            let directory = try filesDirectory(projectId, id)
            try ensureDirectory(directory)
            for file in files {
                guard Self.isValidFileName(file.name) else { throw BridgeFailure(.invalidParams, "Invalid file name in the conversation: \(file.name).") }
                guard let bytes = Data(base64Encoded: file.dataBase64), bytes.count <= Self.maxFileBytes else {
                    throw BridgeFailure(.invalidParams, "An image of the conversation is not valid base64 or is too large to store.")
                }
                let target = directory.appendingPathComponent(file.name)
                if !fm.fileExists(atPath: target.path) { try writeFile(bytes, to: target) } // content-addressed: the same name is the same image
            }
        }
        if let transcript { try writeFile(Data(transcript.utf8), to: transcriptFile(projectId, id)) }
        try writeFile(Data(meta.utf8), to: metaFile(projectId, id))
    }

    /// Removes the conversation: summary, transcript, its image files and omp's session files.
    func remove(projectId: String, id: String) throws {
        for url in [try metaFile(projectId, id), try transcriptFile(projectId, id), try filesDirectory(projectId, id), try conversationDirectory(projectId, id)] where fm.fileExists(atPath: url.path) {
            try fm.removeItem(at: url)
        }
    }

    // MARK: Session files (copy-in / copy-out)

    /// The conversation's omp session files as an archive, for the agent's private scratch. Nothing in it for a new conversation.
    func packSession(projectId: String, conversationId: String) throws -> Data {
        try AgentSessionArchive.pack(directory: conversationDirectory(projectId, conversationId))
    }

    /// True when the conversation's session directory exists (it is made when an agent starts and goes with a delete).
    func hasSession(projectId: String, conversationId: String) -> Bool {
        guard let dir = try? conversationDirectory(projectId, conversationId) else { return false }
        return fm.fileExists(atPath: dir.path)
    }

    /// The newest modification time of the stored session files; nil when there are none.
    func sessionModified(projectId: String, conversationId: String) -> Date? {
        guard let dir = try? conversationDirectory(projectId, conversationId) else { return nil }
        return AgentSessionArchive.newestModification(of: dir)
    }

    /// Replaces the conversation's stored session files with the agent's copy, in one step. False (and nothing written) when the
    /// conversation was deleted meanwhile: a late copy must not bring a deleted conversation's files back.
    @discardableResult
    func restoreSession(projectId: String, conversationId: String, archive: Data) throws -> Bool {
        guard hasSession(projectId: projectId, conversationId: conversationId) else { return false }
        try AgentSessionArchive.replace(directory: conversationDirectory(projectId, conversationId), withArchive: archive)
        return true
    }

    private func writeFile(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
