import Foundation

/// The agent service's per-process scratch: `sessions/<sessionId>/` in the service's container. Holds a private copy of the
/// conversation's omp session files (`conversation/`, what `--session-dir` points at) and where it came from (`origin.json`).
/// Pure file logic, shared so the app's tests exercise it.
///
/// The container is shared by every process the service runs (the App Sandbox is per service, not per process): each process
/// gets its own owner-only folder by name, and it goes as soon as the app has stored the process's session files, but an agent
/// running in another window could read it meanwhile: a limit of the per-service App Sandbox.
enum AgentScratch {
    static let conversationFolder = "conversation"
    static let originFile = "origin.json"

    static func isSessionId(_ id: String) -> Bool {
        id.range(of: #"^[A-Za-z0-9-]{1,64}$"#, options: .regularExpression) != nil
    }

    /// `<home>/Library/Application Support/OcelotAgent/sessions`, with `home` the service's own container.
    static func root(home: String) -> URL {
        URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/OcelotAgent/sessions", isDirectory: true)
    }

    struct Origin: Codable, Equatable {
        var projectId: String
        var conversationId: String
    }

    /// Puts the conversation's session files and their origin into `folder`'s scratch (the folder itself is made by the caller).
    static func fill(folder: URL, projectId: String, conversationId: String, sessionFiles: Data) throws {
        try AgentSessionArchive.unpack(sessionFiles, into: folder.appendingPathComponent(conversationFolder, isDirectory: true))
        try JSONEncoder().encode(Origin(projectId: projectId, conversationId: conversationId)).write(to: folder.appendingPathComponent(originFile), options: .atomic)
    }

    /// Scratch folders of processes that are not running, read from disk (a crashed service instance knows nothing of them).
    /// A folder without a readable origin belongs to an older build or a start that never finished: there is nothing to give
    /// back, so it is removed.
    static func leftovers(root: URL, running: Set<String>) -> [AgentScratchInfo] {
        let fm = FileManager.default
        var infos: [AgentScratchInfo] = []
        for name in ((try? fm.contentsOfDirectory(atPath: root.path)) ?? []).sorted() where isSessionId(name) && !running.contains(name) {
            let folder = root.appendingPathComponent(name, isDirectory: true)
            guard let data = try? Data(contentsOf: folder.appendingPathComponent(originFile)),
                  let origin = try? JSONDecoder().decode(Origin.self, from: data),
                  AgentConversationPaths.isValidProjectId(origin.projectId), AgentConversationPaths.isValidConversationId(origin.conversationId) else {
                try? fm.removeItem(at: folder)
                continue
            }
            let modified = AgentSessionArchive.newestModification(of: folder.appendingPathComponent(conversationFolder, isDirectory: true))
            infos.append(AgentScratchInfo(sessionId: name, projectId: origin.projectId, conversationId: origin.conversationId, modified: modified?.timeIntervalSince1970))
        }
        return infos
    }
}
