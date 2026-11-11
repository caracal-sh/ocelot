import Foundation

/// Private storage of the sidebar agent's conversations, per project (document). The editor owns the formats: the host
/// stores an opaque summary and an opaque transcript per conversation, and creates and removes the directory omp keeps its
/// own session in (the model's memory). Layout and limits: `AgentConversationPaths`; mirrored by editor/e2e/agent-history.mjs.
///
/// Everything is owner-only and outside the document package. The transcripts are never reachable from the sandboxed agent:
/// its entitlement covers `conversations/` only.
struct AgentHistoryStore: Sendable {
    static let maxMetaBytes = 64 * 1024
    static let maxTranscriptBytes = 64 * 1024 * 1024

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
        return AgentHistoryTranscript(text: text)
    }

    func write(projectId: String, id: String, meta: String, transcript: String?) throws {
        guard meta.utf8.count <= Self.maxMetaBytes else { throw BridgeFailure(.invalidParams, "The conversation summary is too large to store.") }
        if let transcript, transcript.utf8.count > Self.maxTranscriptBytes {
            throw BridgeFailure(.invalidParams, "The conversation is too large to store. Start a new conversation.")
        }
        try ensureDirectory(historyDirectory(projectId))
        // The transcript first: a summary never points at a conversation that was not written.
        if let transcript { try writeFile(Data(transcript.utf8), to: transcriptFile(projectId, id)) }
        try writeFile(Data(meta.utf8), to: metaFile(projectId, id))
    }

    /// Removes the conversation: summary, transcript and omp's session files.
    func remove(projectId: String, id: String) throws {
        for url in [try metaFile(projectId, id), try transcriptFile(projectId, id), try conversationDirectory(projectId, id)] where fm.fileExists(atPath: url.path) {
            try fm.removeItem(at: url)
        }
    }

    private func writeFile(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
