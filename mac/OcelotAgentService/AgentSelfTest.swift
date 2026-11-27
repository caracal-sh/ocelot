import Darwin
import Foundation

/// Proof from inside the sandbox: child processes (like omp) inherit the service's sandbox, so
/// `/bin/cat` and `/bin/ls` stand in for them. Run from Settings > Agent > Verify isolation.
enum AgentSelfTest {
    /// A probe that has not finished by then counts as "not denied": a denied read fails at once.
    static let probeTimeout: TimeInterval = 10

    static func run(userFolders: Bool = true, targets: [AgentProbeTarget] = [], timeout: TimeInterval = probeTimeout) -> [AgentProbeResult] {
        let realHome = realHomeDirectory()
        let ownHome = NSHomeDirectory()
        let secretName = "selftest-\(UUID().uuidString)"
        // A file the service itself can write: reading it must work, proving a denial is not just a broken probe.
        let own = URL(fileURLWithPath: ownHome).appendingPathComponent(secretName)
        try? "ok".write(to: own, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: own) }

        // (label, command, arguments, must succeed, PATH for a program the agent runs)
        var probes: [(String, String, [String], Bool, String?)] = [
            ("Read its own container", "/bin/cat", [own.path], true, nil),
            ("Read ~/.omp/agent/agent.db (your omp credentials)", "/bin/cat", ["\(realHome)/.omp/agent/agent.db"], false, nil),
            ("List ~/.ssh", "/bin/ls", ["\(realHome)/.ssh"], false, nil),
        ]
        // Programs the agent needs must start in here, through the same check a chat start makes and with the PATH the agent gets
        // (omp: a refused path, a sandbox that cannot read its install, or a script omp that cannot find bun, fails every chat).
        var refused: [AgentProbeResult] = []
        for target in targets {
            guard let args = target.run else { continue }
            if let command = target.command, let problem = OmpExecutable.problem(command: command, resolved: target.path) {
                refused.append(AgentProbeResult(label: target.label, ok: false, detail: "cannot run: \(problem)"))
                continue
            }
            probes.append((target.label, target.path, args, true, AgentLaunch.confinedPath(target.searchPath ?? [])))
        }
        if userFolders {
            probes += [
                ("List ~/Documents", "/bin/ls", ["\(realHome)/Documents"], false, nil),
                ("List ~/Library/Application Support (other apps' data)", "/bin/ls", ["\(realHome)/Library/Application Support"], false, nil),
                ("List Ocelot's agent folder (the saved transcripts of your chats, gateway files)", "/bin/ls", ["\(realHome)/Library/Application Support/Ocelot/Agent"], false, nil),
                ("List Ocelot's conversations (every chat's session files)", "/bin/ls", ["\(realHome)/Library/Application Support/Ocelot/Agent/conversations"], false, nil),
            ]
            // Paths the app made for the check, and others' conversations the agent must not reach (`ls` of a folder, `cat` of a file).
            for target in targets where target.run == nil {
                probes.append((target.label, target.list ? "/bin/ls" : "/bin/cat", [target.path], false, nil))
            }
        }
        let results = probes.map { label, command, args, shouldSucceed, path -> AgentProbeResult in
            let outcome = ProbeProcess.exec(command, args, timeout: timeout, path: path)
            var result = ProbeProcess.result(label: label, outcome: outcome, shouldSucceed: shouldSucceed, timeout: timeout)
            if path != nil {
                // A program run: say what it answered, not "readable".
                let answer = outcome.stdout.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n").first.map(String.init) ?? ""
                result.detail = result.ok ? "runs (\(answer.isEmpty ? "exit 0" : answer))" : "cannot run: \(result.detail)"
            }
            return result
        }
        return refused + results
    }

    /// The account's real home (the process's `$HOME` is its container).
    static func realHomeDirectory() -> String {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { return String(cString: dir) }
        return NSHomeDirectory()
    }
}
