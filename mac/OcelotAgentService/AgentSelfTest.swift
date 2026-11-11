import Darwin
import Foundation

/// Proof from inside the sandbox: child processes (like omp) inherit the service's sandbox, so
/// `/bin/cat` and `/bin/ls` stand in for them. Run from Settings > Agent > Verify isolation.
enum AgentSelfTest {
    /// A probe that has not finished by then counts as "not denied": a denied read fails at once.
    static let probeTimeout: TimeInterval = 10

    static func run(userFolders: Bool = true, timeout: TimeInterval = probeTimeout) -> [AgentProbeResult] {
        let realHome = realHomeDirectory()
        let ownHome = NSHomeDirectory()
        let secretName = "selftest-\(UUID().uuidString)"
        // A file the service itself can write: reading it must work, proving a denial is not just a broken probe.
        let own = URL(fileURLWithPath: ownHome).appendingPathComponent(secretName)
        try? "ok".write(to: own, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: own) }

        var probes: [(String, String, [String], Bool)] = [
            ("Read its own container", "/bin/cat", [own.path], true),
            ("Read ~/.omp/agent/agent.db (your omp credentials)", "/bin/cat", ["\(realHome)/.omp/agent/agent.db"], false),
            ("List ~/.ssh", "/bin/ls", ["\(realHome)/.ssh"], false),
        ]
        if userFolders {
            probes += [
                ("List ~/Documents", "/bin/ls", ["\(realHome)/Documents"], false),
                ("List ~/Library/Application Support (other apps' data)", "/bin/ls", ["\(realHome)/Library/Application Support"], false),
                ("List Ocelot's agent folder (the saved transcripts of your chats, gateway files)", "/bin/ls", ["\(realHome)/Library/Application Support/Ocelot/Agent"], false),
            ]
        }
        let results = probes.map { label, command, args, shouldSucceed -> AgentProbeResult in
            return ProbeProcess.result(label: label, outcome: ProbeProcess.exec(command, args, timeout: timeout), shouldSucceed: shouldSucceed, timeout: timeout)
        }
        return results
    }

    /// The account's real home (the process's `$HOME` is its container).
    static func realHomeDirectory() -> String {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { return String(cString: dir) }
        return NSHomeDirectory()
    }
}
