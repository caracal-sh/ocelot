import Foundation

/// Where the sidebar agent's conversations live on disk, shared by the app, which creates, copies and deletes them. Mirrors editor/e2e/agent-history.mjs.
///
/// Under the agent folder (`~/Library/Application Support/Ocelot/Agent`):
///
///     conversations/<projectId>/<conversationId>/   omp's session files (`--session-dir`, `--continue`): the model's memory.
///                                                   The sandboxed agent never reaches this folder: it works on a private
///                                                   copy in its scratch, which the app copies in before the start and out
///                                                   after every turn (`AgentSessionArchive`).
///     history/<projectId>/<id>.meta.json            what the sidebar lists
///     history/<projectId>/<id>.transcript.json      what the sidebar shows again (the person's private chat: the agent
///                                                   cannot reach it)
///
/// Owner-only (0700 directories, 0600 files), outside the document package, which gets shared.
enum AgentConversationPaths {
    static let conversationsFolder = "conversations"
    static let historyFolder = "history"

    /// Project ids are UUIDs, conversation ids are made by the editor; anything else could be a path.
    static func isValidProjectId(_ id: String) -> Bool {
        id.range(of: #"^[A-Za-z0-9_-]{1,64}$"#, options: .regularExpression) != nil
    }

    static func isValidConversationId(_ id: String) -> Bool {
        id.range(of: #"^[A-Za-z0-9-]{1,64}$"#, options: .regularExpression) != nil
    }

    /// `<agentFolder>/conversations/<projectId>/<conversationId>`, or nil for ids that are not plain names.
    static func sessionDirectory(agentFolder: String, projectId: String, conversationId: String) -> String? {
        guard isValidProjectId(projectId), isValidConversationId(conversationId) else { return nil }
        return "\(agentFolder)/\(conversationsFolder)/\(projectId)/\(conversationId)"
    }
}
