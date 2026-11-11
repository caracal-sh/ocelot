import XCTest
@testable import Ocelot

/// "Verify isolation" must report a leak, not hang on it: the probe's output is read while it runs and a stuck probe is killed.
final class ProbeProcessTests: XCTestCase {
    func testOutputLargerThanAPipeBufferDoesNotBlockTheProbe() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("probe-\(UUID().uuidString)")
        try Data(repeating: 0x61, count: 4 * 1024 * 1024).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let started = Date()
        let outcome = ProbeProcess.exec("/bin/cat", [file.path], timeout: 20)
        XCTAssertEqual(outcome.status, 0)
        XCTAssertFalse(outcome.timedOut)
        XCTAssertLessThan(Date().timeIntervalSince(started), 10, "the old waitUntilExit-then-read order never returned")
        XCTAssertEqual(outcome.stdout.utf8.count, 64 * 1024, "the capture is capped, the rest is drained")
    }

    func testEndlessOutputIsKilledAtTheTimeoutAndNotCountedAsDenied() {
        let started = Date()
        let outcome = ProbeProcess.exec("/usr/bin/yes", [], timeout: 1)
        XCTAssertTrue(outcome.timedOut)
        XCTAssertLessThan(Date().timeIntervalSince(started), 8)
        let result = ProbeProcess.result(label: "leak", outcome: outcome, shouldSucceed: false, timeout: 1)
        XCTAssertFalse(result.ok, "a read that never ended was not denied")
        XCTAssertTrue(result.detail.contains("not denied"))
    }

    func testDeniedAndReadableProbesMapToResults() {
        let denied = ProbeProcess.exec("/bin/cat", ["/nonexistent-\(UUID().uuidString)"], timeout: 10)
        XCTAssertNotEqual(denied.status, 0)
        XCTAssertTrue(ProbeProcess.result(label: "x", outcome: denied, shouldSucceed: false, timeout: 10).ok)
        XCTAssertFalse(ProbeProcess.result(label: "x", outcome: denied, shouldSucceed: true, timeout: 10).ok)
        let readable = ProbeProcess.exec("/bin/echo", ["hi"], timeout: 10)
        XCTAssertEqual(readable.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "hi")
        XCTAssertTrue(ProbeProcess.result(label: "x", outcome: readable, shouldSucceed: true, timeout: 10).ok)
        XCTAssertFalse(ProbeProcess.result(label: "x", outcome: readable, shouldSucceed: false, timeout: 10).ok)
    }

    @MainActor
    func testShutdownFinishesEveryStreamSoTheRunnerRevokesItsTokens() async {
        let connection = AgentServiceConnection()
        let (stream, sink) = AsyncStream.makeStream(of: AgentChunk.self)
        connection.register(sessionId: "s1", sink: sink)
        connection.shutdown()
        var sawStdoutClosed = false
        var exit: Int32?
        for await chunk in stream {
            if case .stdoutClosed = chunk { sawStdoutClosed = true }
            if case .exit(let code) = chunk { exit = code }
        }
        XCTAssertTrue(sawStdoutClosed)
        XCTAssertEqual(exit, -1, "the consumer reached its tail: it ended instead of hanging forever")
    }

    /// Settings > Agent > Verify isolation against the real bundled XPC service (the tests are hosted by the app):
    /// it must answer instead of hanging on a leak. Whether each probe is denied is not asserted here: Xcode signs
    /// test-hosted debug builds with extra read access (`/`), so the probes only pass in a Release/dev-signed build
    /// (see "Verify isolation" in Settings > Agent). Skipped when the service cannot be reached. The test host leaves out the
    /// probes that list ~/Documents and ~/Library/Application Support: reading them from an unconfined Debug build makes macOS
    /// ask the user for consent ("Ocelot wants to access your Documents folder").
    func testVerifyIsolationAnswersInsteadOfHangingOnTheRealService() async throws {
        enum Outcome { case results([AgentProbeResult]), failure(String), timedOut }
        let outcome = await withTaskGroup(of: Outcome.self) { group -> Outcome in
            group.addTask {
                do { return .results(try await AgentServiceConnection.shared.selfTest()) } catch { return .failure("\(error)") }
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(90))
                return .timedOut
            }
            let first = await group.next() ?? .timedOut
            group.cancelAll()
            return first
        }
        switch outcome {
        case .failure(let message): throw XCTSkip("The sandboxed agent service is not available here: \(message)")
        case .timedOut: XCTFail("Verify isolation did not answer within 90 s")
        case .results(let results):
            XCTAssertEqual(results.count, 3, "own container, omp credentials and ~/.ssh; the user-folder probes are off under XCTest")
            XCTAssertFalse(results.contains { $0.label.contains("Documents") })
        }
        AgentServiceConnection.shared.shutdown()
    }

    func testStopsThatArriveWhileAnAgentIsStartingAreNotLost() {
        var starts = PendingStarts()
        starts.begin("p1", window: "w1")
        starts.begin("p2", window: "w2")
        starts.cancel("p1")
        starts.cancel("unknown")
        starts.cancelWindow("w2")
        XCTAssertTrue(starts.finish("p1"))
        XCTAssertTrue(starts.finish("p2"))
        XCTAssertFalse(starts.finish("p1"), "the mark is consumed")
        starts.begin("p3", window: "w1")
        starts.cancelAll()
        XCTAssertTrue(starts.finish("p3"))
        starts.begin("p4", window: "w1")
        XCTAssertFalse(starts.finish("p4"))
    }
}
