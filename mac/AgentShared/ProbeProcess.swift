import Darwin
import Foundation

/// Runs one read probe as a child process (it inherits the sandbox of the caller). Shared so the app's tests can exercise it.
enum ProbeProcess {
    /// The result of one probe: `ok` when it behaved as the confinement requires.
    static func result(label: String, outcome: Outcome, shouldSucceed: Bool, timeout: TimeInterval) -> AgentProbeResult {
        if outcome.timedOut {
            // A read that was still going after the timeout was not denied (a leaked file can be huge or endless).
            return AgentProbeResult(label: label, ok: false, detail: "no answer after \(Int(timeout)) s (not denied)")
        }
        let succeeded = outcome.status == 0
        return AgentProbeResult(label: label, ok: succeeded == shouldSucceed, detail: succeeded ? "readable" : (outcome.stderr.isEmpty ? "denied" : outcome.stderr))
    }

    struct Outcome: Sendable, Equatable {
        var status: Int32
        var stdout: String
        var stderr: String
        var timedOut = false
    }

    /// Runs a command and drains both pipes while it runs: a probe that leaks (`cat` of a big file) writes more
    /// than a pipe holds, and waiting for exit first would block forever. A command still running after
    /// `timeout` seconds is killed and reported as timed out.
    static func exec(_ command: String, _ args: [String], timeout: TimeInterval) -> Outcome {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command)
        process.arguments = args
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { return Outcome(status: -1, stdout: "", stderr: error.localizedDescription) }

        let readers = DispatchGroup()
        let stdout = Captured(limit: 64 * 1024), stderr = Captured(limit: 4000)
        for (handle, sink) in [(out.fileHandleForReading, stdout), (err.fileHandleForReading, stderr)] {
            readers.enter()
            DispatchQueue.global().async {
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty { break }
                    sink.append(chunk)
                }
                readers.leave()
            }
        }

        let pid = process.processIdentifier
        let timedOut = Flag()
        let hardKill = DispatchWorkItem { kill(pid, SIGKILL) }
        let watchdog = DispatchWorkItem {
            timedOut.set()
            kill(pid, SIGTERM)
            DispatchQueue.global().asyncAfter(deadline: .now() + 1, execute: hardKill)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)
        process.waitUntilExit()
        watchdog.cancel()
        hardKill.cancel()
        // A grandchild can keep a pipe open after the command exits; do not wait for it.
        _ = readers.wait(timeout: .now() + 2)
        return Outcome(status: process.terminationStatus, stdout: stdout.string, stderr: stderr.string.trimmingCharacters(in: .whitespacesAndNewlines), timedOut: timedOut.isSet)
    }
}

/// The first `limit` bytes of a stream, safe to append from a reader thread; the rest is read and dropped.
private final class Captured: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    private let limit: Int

    init(limit: Int) { self.limit = limit }

    func append(_ chunk: Data) {
        lock.lock()
        if data.count < limit { data.append(chunk.prefix(limit - data.count)) }
        lock.unlock()
    }

    var string: String {
        lock.lock()
        defer { lock.unlock() }
        return String(decoding: data, as: UTF8.self)
    }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    func set() { lock.lock(); value = true; lock.unlock() }

    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}
