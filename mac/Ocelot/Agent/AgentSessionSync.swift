import Foundation
import os

/// How the sandboxed agent gets its conversation's omp session without ever seeing the saved conversations.
///
/// The app owns `Agent/conversations/<projectId>/<conversationId>/`. Before the agent starts, that one directory is packed
/// (`AgentHistoryStore.packSession`) and handed to the service, which unpacks it into the process's private scratch; omp works on
/// the copy (`--session-dir`). After every completed turn and when the process has exited, the app fetches the copy back
/// (`AgentSessionSync`) and swaps it in as the stored one. A copy a crash left behind is recovered on the next connection to the
/// service (`AgentScratchRecovery`), when it is newer than the stored one.

/// One conversation of one project (document).
struct ConversationKey: Hashable, Sendable {
    let projectId: String
    let conversationId: String
}

/// Which agent processes run for which conversation, from before the start until their session files are stored. Starting the
/// next process of a conversation (it copies the stored files in) and deleting a conversation both wait for the idle moment:
/// copying in too early would hand over a stale session, and deleting too early leaves a stray session file in a deleted folder.
@MainActor
final class ConversationActivity {
    private struct Live {
        let key: ConversationKey
        let terminate: @MainActor () -> Void
    }

    private var live: [String: Live] = [:]
    private var waiters: [UUID: (key: ConversationKey, continuation: CheckedContinuation<Bool, Never>)] = [:]
    private(set) var deleted: Set<ConversationKey> = []

    func begin(_ key: ConversationKey, processId: String, terminate: @escaping @MainActor () -> Void) {
        live[processId] = Live(key: key, terminate: terminate)
    }

    /// The process is over and its session files are stored (or given up on).
    func end(processId: String) {
        guard let ended = live.removeValue(forKey: processId) else { return }
        guard !isActive(ended.key) else { return }
        for (id, waiter) in waiters where waiter.key == ended.key {
            waiters[id] = nil
            waiter.continuation.resume(returning: true)
        }
    }

    func isActive(_ key: ConversationKey) -> Bool {
        live.values.contains { $0.key == key }
    }

    /// Stops the conversation's processes the hard way.
    func terminate(_ key: ConversationKey) {
        for process in live.values where process.key == key { process.terminate() }
    }

    func markDeleted(_ key: ConversationKey) { deleted.insert(key) }

    /// Forgets a deletion once nothing runs for the conversation any more (a conversation id is never reused).
    func settle(_ key: ConversationKey) {
        if !isActive(key) { deleted.remove(key) }
    }

    /// True once no process runs for the conversation; false when `timeout` passes first.
    func waitUntilIdle(_ key: ConversationKey, timeout: Duration) async -> Bool {
        guard isActive(key) else { return true }
        let id = UUID()
        return await withCheckedContinuation { continuation in
            waiters[id] = (key, continuation)
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: timeout)
                guard let waiter = self?.waiters.removeValue(forKey: id) else { return }
                waiter.continuation.resume(returning: false)
            }
        }
    }
}

/// Copies one process's session files from the agent's scratch back into the stored conversation: after every completed turn
/// (`turnEnded`, coalesced: a copy in flight picks up the turn that ended meanwhile) and once more when the process is gone
/// (`finish`). A copy that fails leaves the scratch where it is; the next one, or the recovery on the next start, takes it.
@MainActor
final class AgentSessionSync {
    private let fetch: @Sendable () async throws -> Data?
    private let store: @Sendable (Data) async throws -> Bool
    private let discard: @Sendable () async -> Void
    private let log = Logger(subsystem: "sh.caracal.ocelot", category: "agent")
    private var inFlight: Task<Void, Never>?
    private var again = false
    private(set) var copies = 0

    /// `fetch`: the scratch as an archive; `store`: swap it in as the conversation's stored session (false when the conversation
    /// was deleted); `discard`: remove the scratch.
    init(fetch: @escaping @Sendable () async throws -> Data?, store: @escaping @Sendable (Data) async throws -> Bool, discard: @escaping @Sendable () async -> Void) {
        self.fetch = fetch
        self.store = store
        self.discard = discard
    }

    /// A turn ended in the agent (`agent_end`): bring the session files home without waiting for the process to exit.
    func turnEnded() {
        if inFlight != nil {
            again = true
            return
        }
        inFlight = Task { @MainActor [weak self] in
            repeat {
                guard let self else { return }
                self.again = false
                do { try await self.copy() } catch { self.log.error("session copy failed: \(error.localizedDescription, privacy: .public)") }
            } while self?.again == true
            self?.inFlight = nil
        }
    }

    /// The process is gone: the last copy, then the scratch is removed. When the copy fails nothing is removed, so the files
    /// are recovered later. Returns whether the session files are safely stored.
    @discardableResult
    func finish() async -> Bool {
        await inFlight?.value
        do {
            try await copy()
            await discard()
            return true
        } catch {
            log.error("final session copy failed, kept for recovery: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private func copy() async throws {
        guard let archive = try await fetch() else { return }
        _ = try await store(archive)
        copies += 1
    }
}

/// Takes home the session copies a crash left in the service's scratch: the app or the service died mid-turn, or an exit was
/// never collected. Each is stored when the conversation still exists and the copy is newer than the stored one (the stored one
/// is current when the app only quit after the last copy), then removed; a copy that cannot be read stays for the next try.
enum AgentScratchRecovery {
    /// The sessions that were restored.
    @discardableResult
    static func run(
        leftovers: [AgentScratchInfo],
        store: AgentHistoryStore,
        fetch: (String) async throws -> Data?,
        discard: (String) async -> Void
    ) async -> [AgentScratchInfo] {
        var restored: [AgentScratchInfo] = []
        for info in leftovers {
            guard AgentConversationPaths.isValidProjectId(info.projectId), AgentConversationPaths.isValidConversationId(info.conversationId),
                  store.hasSession(projectId: info.projectId, conversationId: info.conversationId) else {
                await discard(info.sessionId) // the conversation was deleted (or the folder is not one of ours): nothing to give back
                continue
            }
            let stored = store.sessionModified(projectId: info.projectId, conversationId: info.conversationId)
            let newer = info.modified.map { copy in stored.map { copy > $0.timeIntervalSince1970 } ?? true } ?? false
            if newer {
                guard let archive = try? await fetch(info.sessionId),
                      (try? store.restoreSession(projectId: info.projectId, conversationId: info.conversationId, archive: archive)) == true else { continue }
                restored.append(info)
            }
            await discard(info.sessionId)
        }
        return restored
    }
}
