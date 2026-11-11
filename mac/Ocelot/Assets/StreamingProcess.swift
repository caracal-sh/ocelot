import Foundation

/// Runs one subprocess to completion, delivering stdout line by line. Cancelling the calling task kills it
/// (SIGTERM, then SIGKILL after two seconds). Blocking pipe reads happen on dispatch threads, never on the
/// cooperative pool or the main actor.
enum StreamingProcess {
    struct Config: Sendable {
        var executable: String
        var arguments: [String]
        var environment: [String: String]
        var directory: URL?
        /// Killed and reported as `timedOut` after this long.
        var timeout: TimeInterval
    }

    struct Result: Sendable {
        var status: Int32
        /// Last ~4 KB of stderr.
        var stderr: String
        var timedOut: Bool
    }

    static func run(_ config: Config, onLine: @escaping @Sendable (String) -> Void) async throws -> Result {
        let box = Box()
        let result = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Result, any Error>) in
                box.start(config, onLine: onLine) { continuation.resume(with: $0) }
            }
        } onCancel: {
            box.cancel()
        }
        try Task.checkCancellation()
        return result
    }

    private final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private let process = Process()
        private var cancelled = false
        private var timedOut = false
        private var stderrTail = Data()
        private var lineBuffer = Data()

        func cancel() {
            lock.lock()
            cancelled = true
            let running = process.isRunning
            lock.unlock()
            // `kill` walks the process tree with pgrep and waits for it: not on the caller's thread (the main actor).
            if running { DispatchQueue.global(qos: .userInitiated).async { self.kill() } }
        }

        /// SIGTERM to the process and its descendants (a shell or tool it spawned would otherwise keep the
        /// pipes open), SIGKILL to what survives two seconds later.
        private func kill() {
            let pid = process.processIdentifier
            let tree = Self.descendants(of: pid)
            process.terminate()
            for child in tree { Darwin.kill(child, SIGTERM) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [process] in
                if process.isRunning { Darwin.kill(pid, SIGKILL) }
                for child in tree { Darwin.kill(child, SIGKILL) }
            }
        }

        private static func descendants(of pid: Int32) -> [Int32] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
            p.arguments = ["-P", String(pid)]
            let out = Pipe()
            p.standardOutput = out
            p.standardError = FileHandle.nullDevice
            p.standardInput = FileHandle.nullDevice
            guard (try? p.run()) != nil else { return [] }
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            let children = String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { Int32($0) }
            return children + children.flatMap { descendants(of: $0) }
        }

        func start(
            _ config: Config,
            onLine: @escaping @Sendable (String) -> Void,
            completion: @escaping @Sendable (Swift.Result<Result, any Error>) -> Void
        ) {
            lock.lock()
            if cancelled {
                lock.unlock()
                completion(.failure(CancellationError()))
                return
            }
            process.executableURL = URL(fileURLWithPath: config.executable)
            process.arguments = config.arguments
            process.environment = config.environment
            process.currentDirectoryURL = config.directory
            let out = Pipe(), err = Pipe()
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = out
            process.standardError = err

            let exited = DispatchGroup()
            let readers = DispatchGroup()
            exited.enter()
            process.terminationHandler = { _ in exited.leave() }
            do {
                try process.run()
            } catch {
                lock.unlock()
                completion(.failure(ImageFailure("Could not start \(config.executable): \(error.localizedDescription)")))
                return
            }
            lock.unlock()

            readers.enter()
            DispatchQueue.global().async { [self] in
                let handle = out.fileHandleForReading
                while let data = try? handle.read(upToCount: 65536), !data.isEmpty { consume(data, onLine: onLine) }
                flush(onLine: onLine)
                readers.leave()
            }
            readers.enter()
            DispatchQueue.global().async { [self] in
                let handle = err.fileHandleForReading
                while let data = try? handle.read(upToCount: 65536), !data.isEmpty {
                    lock.lock()
                    stderrTail.append(data)
                    if stderrTail.count > 4000 { stderrTail = stderrTail.suffix(4000) }
                    lock.unlock()
                }
                readers.leave()
            }
            let deadline = DispatchWorkItem { [self] in
                lock.lock()
                let running = process.isRunning
                if running { timedOut = true }
                lock.unlock()
                if running { kill() }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + config.timeout, execute: deadline)
            exited.notify(queue: .global()) { [self] in
                // Output is normally drained at once; an orphaned grandchild holding the pipe must not stall us.
                _ = readers.wait(timeout: .now() + 1)
                deadline.cancel()
                lock.lock()
                let result = Result(
                    status: process.terminationStatus,
                    stderr: String(decoding: stderrTail, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines),
                    timedOut: timedOut
                )
                let wasCancelled = cancelled
                lock.unlock()
                completion(wasCancelled ? .failure(CancellationError()) : .success(result))
            }
        }

        private func consume(_ data: Data, onLine: @Sendable (String) -> Void) {
            lock.lock()
            lineBuffer.append(data)
            var lines: [String] = []
            while let newline = lineBuffer.firstIndex(of: 0x0A) {
                lines.append(String(decoding: lineBuffer[lineBuffer.startIndex..<newline], as: UTF8.self))
                lineBuffer = Data(lineBuffer[lineBuffer.index(after: newline)...])
            }
            lock.unlock()
            for line in lines { onLine(line) }
        }

        private func flush(onLine: @Sendable (String) -> Void) {
            lock.lock()
            let rest = String(decoding: lineBuffer, as: UTF8.self)
            lineBuffer = Data()
            lock.unlock()
            if !rest.isEmpty { onLine(rest) }
        }
    }
}
