import XCTest
@testable import Ocelot

/// The sandboxed agent never reads `Agent/conversations/`: its conversation's session files are copied into its private scratch
/// before it starts and back after every turn; a copy a crash left behind is recovered. All against temporary directories.
final class AgentSessionCopyTests: XCTestCase {
    private var root: URL!
    private var store: AgentHistoryStore!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        root = fm.temporaryDirectory.appendingPathComponent("ocelot-session-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        store = AgentHistoryStore(root: root)
    }

    override func tearDownWithError() throws {
        try? fm.removeItem(at: root)
    }

    private func put(_ text: String, at url: URL, modified: Date? = nil) throws {
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
        if let modified { try fm.setAttributes([.modificationDate: modified], ofItemAtPath: url.path) }
    }

    private func read(_ url: URL) -> String? { try? String(contentsOf: url, encoding: .utf8) }

    private func mode(_ url: URL) throws -> Int {
        (try fm.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    // MARK: Archive

    func testArchiveRoundTripsFilesFoldersAndModificationTimes() throws {
        let source = root.appendingPathComponent("src")
        let when = Date(timeIntervalSince1970: 1_700_000_000)
        try put("one", at: source.appendingPathComponent("a.jsonl"), modified: when)
        try put("two", at: source.appendingPathComponent("blobs/deep/b.bin"), modified: when)
        try put("", at: source.appendingPathComponent("empty"))
        let archive = try AgentSessionArchive.pack(directory: source)

        let target = root.appendingPathComponent("dst")
        try AgentSessionArchive.unpack(archive, into: target)
        XCTAssertEqual(read(target.appendingPathComponent("a.jsonl")), "one")
        XCTAssertEqual(read(target.appendingPathComponent("blobs/deep/b.bin")), "two")
        XCTAssertEqual(read(target.appendingPathComponent("empty")), "")
        let modified = try XCTUnwrap(fm.attributesOfItem(atPath: target.appendingPathComponent("a.jsonl").path)[.modificationDate] as? Date)
        XCTAssertEqual(modified.timeIntervalSince1970, when.timeIntervalSince1970, accuracy: 1)
        XCTAssertEqual(try mode(target), 0o700)
        XCTAssertEqual(try mode(target.appendingPathComponent("blobs/deep")), 0o700)
        XCTAssertEqual(try mode(target.appendingPathComponent("a.jsonl")), 0o600)
    }

    func testPackingAMissingOrEmptyDirectoryGivesAnArchiveOfNothing() throws {
        for name in ["missing", "empty"] {
            let dir = root.appendingPathComponent(name)
            if name == "empty" { try fm.createDirectory(at: dir, withIntermediateDirectories: true) }
            let archive = try AgentSessionArchive.pack(directory: dir)
            let target = root.appendingPathComponent("out-\(name)")
            try AgentSessionArchive.unpack(archive, into: target)
            XCTAssertEqual(try fm.contentsOfDirectory(atPath: target.path), [])
        }
        let target = root.appendingPathComponent("from-nothing")
        try AgentSessionArchive.unpack(Data(), into: target) // a new conversation hands over no files
        XCTAssertTrue(fm.fileExists(atPath: target.path))
    }

    func testSymlinksAreNotPacked() throws {
        let source = root.appendingPathComponent("src")
        try put("real", at: source.appendingPathComponent("a"))
        try fm.createSymbolicLink(at: source.appendingPathComponent("link"), withDestinationURL: root)
        let target = root.appendingPathComponent("dst")
        try AgentSessionArchive.unpack(try AgentSessionArchive.pack(directory: source), into: target)
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: target.path), ["a"])
    }

    /// An archive from outside (the service's reply, a damaged one) can only ever write below the folder it is unpacked into.
    func testUnpackRefusesPathsThatLeaveTheFolderAndCutShortArchives() throws {
        func archive(path: String) -> Data {
            var data = Data("OSA1".utf8)
            func u32(_ v: UInt32) { withUnsafeBytes(of: v.bigEndian) { data.append(contentsOf: $0) } }
            func u64(_ v: UInt64) { withUnsafeBytes(of: v.bigEndian) { data.append(contentsOf: $0) } }
            u32(1)
            u32(UInt32(path.utf8.count))
            data.append(Data(path.utf8))
            u64(0)
            u64(1)
            data.append(0x61)
            return data
        }
        for bad in ["../escape", "/etc/passwd", "a/../../escape", "a//b", "./a", ""] {
            let target = root.appendingPathComponent("t-\(UUID().uuidString)")
            XCTAssertThrowsError(try AgentSessionArchive.unpack(archive(path: bad), into: target), bad)
            XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("escape").path), bad)
        }
        let target = root.appendingPathComponent("ok")
        XCTAssertNoThrow(try AgentSessionArchive.unpack(archive(path: "a/b"), into: target))
        XCTAssertThrowsError(try AgentSessionArchive.unpack(archive(path: "a").dropLast(), into: root.appendingPathComponent("cut")))
        XCTAssertThrowsError(try AgentSessionArchive.unpack(Data("nope".utf8), into: root.appendingPathComponent("magic")))
    }

    func testReplaceSwapsTheWholeFolderAndKeepsTheOldOneWhenTheArchiveIsBad() throws {
        let dir = root.appendingPathComponent("conv")
        try put("old", at: dir.appendingPathComponent("old.jsonl"))
        let source = root.appendingPathComponent("src")
        try put("new", at: source.appendingPathComponent("new.jsonl"))
        let archive = try AgentSessionArchive.pack(directory: source)

        XCTAssertThrowsError(try AgentSessionArchive.replace(directory: dir, withArchive: archive.dropLast(3)))
        XCTAssertEqual(read(dir.appendingPathComponent("old.jsonl")), "old", "a bad copy leaves the stored one alone")
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: root.path).filter { $0.hasPrefix(".incoming-") }, [], "and no staging folder is left")

        try AgentSessionArchive.replace(directory: dir, withArchive: archive)
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: dir.path), ["new.jsonl"])
        XCTAssertEqual(try mode(dir), 0o700)
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: root.path).filter { $0.hasPrefix(".incoming-") }, [])
    }

    // MARK: Copy-in, copy-out

    func testACopyOfTheStoredSessionGoesInAndTheAgentsWorkComesBack() throws {
        let stored = try store.sessionDirectory(projectId: "p1", conversationId: "c1")
        try put("turn 1", at: stored.appendingPathComponent("session.jsonl"))
        try put("other", at: try store.sessionDirectory(projectId: "p1", conversationId: "c2").appendingPathComponent("session.jsonl"))

        // The service: its own scratch, filled from the archive.
        let scratch = root.appendingPathComponent("scratch/s1")
        try fm.createDirectory(at: scratch, withIntermediateDirectories: true)
        try AgentScratch.fill(folder: scratch, projectId: "p1", conversationId: "c1", sessionFiles: try store.packSession(projectId: "p1", conversationId: "c1"))
        let copy = scratch.appendingPathComponent(AgentScratch.conversationFolder)
        XCTAssertEqual(read(copy.appendingPathComponent("session.jsonl")), "turn 1")
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: copy.path), ["session.jsonl"], "only this conversation's files are handed over")

        // omp works on the copy; the app takes it home.
        try put("turn 1\nturn 2", at: copy.appendingPathComponent("session.jsonl"))
        try put("x", at: copy.appendingPathComponent("extra.json"))
        XCTAssertTrue(try store.restoreSession(projectId: "p1", conversationId: "c1", archive: try AgentSessionArchive.pack(directory: copy)))
        XCTAssertEqual(read(stored.appendingPathComponent("session.jsonl")), "turn 1\nturn 2")
        XCTAssertEqual(read(stored.appendingPathComponent("extra.json")), "x")
        XCTAssertEqual(read(store.root.resolvingSymlinksInPath().appendingPathComponent("conversations/p1/c2/session.jsonl")), "other")
    }

    func testALateCopyOfADeletedConversationIsNotWrittenBack() throws {
        _ = try store.sessionDirectory(projectId: "p1", conversationId: "c1")
        try store.remove(projectId: "p1", id: "c1")
        let source = root.appendingPathComponent("src")
        try put("late", at: source.appendingPathComponent("session.jsonl"))
        XCTAssertFalse(try store.restoreSession(projectId: "p1", conversationId: "c1", archive: try AgentSessionArchive.pack(directory: source)))
        XCTAssertFalse(store.hasSession(projectId: "p1", conversationId: "c1"))
    }

    // MARK: AgentSessionSync

    @MainActor
    func testSyncCopiesAfterATurnCoalescesTurnsThatEndMeanwhileAndStoresAtTheEnd() async throws {
        let log = Recorder()
        let gate = Gate()
        let sync = AgentSessionSync(
            fetch: { await log.add("fetch"); await gate.wait(); return Data("a".utf8) },
            store: { _ in await log.add("store"); return true },
            discard: { await log.add("discard") }
        )
        sync.turnEnded()
        for _ in 0..<200 where await log.events.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        sync.turnEnded() // while the first copy is in flight: one more copy, however many turns end meanwhile
        sync.turnEnded()
        sync.turnEnded()
        await gate.open()
        let ok = await sync.finish()
        XCTAssertTrue(ok)
        let events = await log.events
        XCTAssertEqual(events.filter { $0 == "fetch" }.count, 3, "the turn's copy, one for the turns that ended during it, the final one: \(events)")
        XCTAssertEqual(events.last, "discard", "the scratch goes only after the final copy was stored")
        XCTAssertEqual(events.filter { $0 == "discard" }.count, 1)
        XCTAssertEqual(sync.copies, 3)
    }

    @MainActor
    func testSyncKeepsTheScratchWhenTheFinalCopyFails() async {
        let log = Recorder()
        let sync = AgentSessionSync(
            fetch: { throw BridgeFailure(.hostUnavailable, "service gone") },
            store: { _ in true },
            discard: { await log.add("discard") }
        )
        let ok = await sync.finish()
        XCTAssertFalse(ok)
        let events = await log.events
        XCTAssertEqual(events, [], "left for the recovery on the next start")
    }

    // MARK: Recovery

    private func leftover(_ id: String, _ project: String, _ conversation: String, modified: Date?) -> AgentScratchInfo {
        AgentScratchInfo(sessionId: id, projectId: project, conversationId: conversation, modified: modified?.timeIntervalSince1970)
    }

    private func archive(_ text: String) throws -> Data {
        let dir = root.appendingPathComponent("a-\(UUID().uuidString)")
        try put(text, at: dir.appendingPathComponent("session.jsonl"))
        return try AgentSessionArchive.pack(directory: dir)
    }

    func testRecoveryStoresACopyNewerThanTheStoredOneAndDeletesEveryCopy() async throws {
        let now = Date()
        let stored1 = try store.sessionDirectory(projectId: "p1", conversationId: "c1")
        try put("stored, old", at: stored1.appendingPathComponent("session.jsonl"), modified: now.addingTimeInterval(-100))
        let stored2 = try store.sessionDirectory(projectId: "p1", conversationId: "c2")
        try put("stored, current", at: stored2.appendingPathComponent("session.jsonl"), modified: now)
        _ = try store.sessionDirectory(projectId: "p1", conversationId: "c3")
        try put("scratch of a deleted conversation", at: root.appendingPathComponent("unused"))

        let discarded = Recorder()
        let archives = ["s1": try archive("scratch, newer"), "s2": try archive("scratch, older"), "s3": try archive("scratch, first turn"), "s4": try archive("scratch, deleted")]
        let restored = await AgentScratchRecovery.run(
            leftovers: [
                leftover("s1", "p1", "c1", modified: now),
                leftover("s2", "p1", "c2", modified: now.addingTimeInterval(-50)),
                leftover("s3", "p1", "c3", modified: now), // the conversation had no session file yet
                leftover("s4", "p1", "gone", modified: now), // deleted since
            ],
            store: store,
            fetch: { archives[$0] },
            discard: { await discarded.add($0) }
        )
        XCTAssertEqual(restored.map(\.sessionId), ["s1", "s3"])
        XCTAssertEqual(read(stored1.appendingPathComponent("session.jsonl")), "scratch, newer")
        XCTAssertEqual(read(stored2.appendingPathComponent("session.jsonl")), "stored, current", "a stale scratch never replaces newer stored files")
        XCTAssertEqual(read(stored1.deletingLastPathComponent().appendingPathComponent("c3/session.jsonl")), "scratch, first turn")
        XCTAssertFalse(store.hasSession(projectId: "p1", conversationId: "gone"), "a deleted conversation stays deleted")
        let events = await discarded.events
        XCTAssertEqual(Set(events), ["s1", "s2", "s3", "s4"])
    }

    func testRecoveryKeepsACopyItCouldNotRead() async throws {
        let now = Date()
        _ = try store.sessionDirectory(projectId: "p1", conversationId: "c1")
        let discarded = Recorder()
        let restored = await AgentScratchRecovery.run(leftovers: [leftover("s1", "p1", "c1", modified: now)], store: store, fetch: { _ in throw BridgeFailure(.hostUnavailable, "gone") }, discard: { await discarded.add($0) })
        XCTAssertEqual(restored, [])
        let events = await discarded.events
        XCTAssertEqual(events, [], "stays for the next connection")
    }

    func testRecoveryRefusesIdsThatArePaths() async throws {
        let discarded = Recorder()
        let restored = await AgentScratchRecovery.run(leftovers: [leftover("s1", "..", "c1", modified: Date())], store: store, fetch: { _ in nil }, discard: { await discarded.add($0) })
        XCTAssertEqual(restored, [])
        let events = await discarded.events
        XCTAssertEqual(events, ["s1"])
    }

    // MARK: The service's scratch on disk

    func testScratchListsWhatIsNotRunningAndSweepsFoldersWithoutAnOrigin() throws {
        let scratch = root.appendingPathComponent("sessions")
        let a = scratch.appendingPathComponent("aaa"), b = scratch.appendingPathComponent("bbb"), old = scratch.appendingPathComponent("old-build")
        for folder in [a, b] { try fm.createDirectory(at: folder, withIntermediateDirectories: true) }
        try put("x", at: old.appendingPathComponent("config.yml"))
        let when = Date(timeIntervalSince1970: 1_700_000_000)
        let source = root.appendingPathComponent("src")
        try put("s", at: source.appendingPathComponent("session.jsonl"), modified: when)
        try AgentScratch.fill(folder: a, projectId: "p1", conversationId: "c1", sessionFiles: try AgentSessionArchive.pack(directory: source))
        try AgentScratch.fill(folder: b, projectId: "p1", conversationId: "c2", sessionFiles: Data())

        let found = AgentScratch.leftovers(root: scratch, running: ["bbb"])
        XCTAssertEqual(found.map(\.sessionId), ["aaa"], "a running process's scratch is not a leftover")
        XCTAssertEqual(found.first?.projectId, "p1")
        XCTAssertEqual(found.first?.conversationId, "c1")
        XCTAssertEqual(try XCTUnwrap(found.first?.modified), when.timeIntervalSince1970, accuracy: 1)
        XCTAssertFalse(fm.fileExists(atPath: old.path), "a folder with no origin has nothing to give back")
        XCTAssertTrue(fm.fileExists(atPath: b.path))
    }

    // MARK: Delete while stopping

    @MainActor
    func testWaitingForAConversationEndsWhenItsLastProcessEnds() async {
        let activity = ConversationActivity()
        let key = ConversationKey(projectId: "p1", conversationId: "c1")
        let other = ConversationKey(projectId: "p1", conversationId: "c2")
        activity.begin(key, processId: "a", terminate: {})
        activity.begin(other, processId: "b", terminate: {})
        let idle = Task { @MainActor in await activity.waitUntilIdle(key, timeout: .seconds(5)) }
        try? await Task.sleep(for: .milliseconds(50))
        activity.end(processId: "b") // another conversation's process does not release it
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(activity.isActive(key))
        activity.end(processId: "a")
        let released = await idle.value
        XCTAssertTrue(released)
        XCTAssertFalse(activity.isActive(key))
    }

    @MainActor
    func testWaitingForAConversationGivesUpAfterTheTimeoutAndCanTerminateIt() async {
        let activity = ConversationActivity()
        let key = ConversationKey(projectId: "p1", conversationId: "c1")
        var terminated = false
        activity.begin(key, processId: "a", terminate: { terminated = true })
        let released = await activity.waitUntilIdle(key, timeout: .milliseconds(100))
        XCTAssertFalse(released)
        activity.terminate(key)
        XCTAssertTrue(terminated)
    }
}

private actor Recorder {
    private(set) var events: [String] = []
    func add(_ event: String) { events.append(event) }
}

private actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() {
        isOpen = true
        for waiter in waiters { waiter.resume() }
        waiters = []
    }
}
