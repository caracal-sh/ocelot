import AppKit
import Foundation

/// How to get omp onto this Mac. omp needs the bun runtime (`engines.bun`), so the plan is always "have bun,
/// then `bun install -g`": with bun it is one command; with only npm, npm installs bun first; with neither,
/// bun's official installer does. Runs in Terminal so the user sees (and can stop) everything that happens.
struct OmpInstallPlan: Sendable, Equatable {
    /// What was found on this Mac: "bun", "npm" or "none".
    let installer: String
    /// Shown in the setup panel and run by Terminal.
    let command: String
    /// The login shell's PATH, so Terminal finds the same bun/npm.
    let path: String
}

enum OmpInstaller {
    static let package = "@oh-my-pi/pi-coding-agent"

    /// Blocking (starts the login shell): call off the main actor.
    static func plan() -> OmpInstallPlan {
        let env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var path = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        var bun: String?
        var npm: String?

        let shell = env["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        let marker = "__OCELOT__"
        if let probe = OmpCLI.runSync(shell, ["-l", "-i", "-c", #"printf '\#(marker)%s\n\#(marker)%s\n\#(marker)%s\n' "$PATH" "$(command -v bun)" "$(command -v npm)""#], env: env, timeout: 5) {
            let values = probe.split(separator: "\n", omittingEmptySubsequences: false).filter { $0.hasPrefix(marker) }.map { String($0.dropFirst(marker.count)) }
            if values.count == 3 {
                if !values[0].isEmpty { path = values[0] }
                if values[1].hasPrefix("/") { bun = values[1] }
                if values[2].hasPrefix("/") { npm = values[2] }
            }
        }
        let fm = FileManager.default
        if bun == nil { bun = ["\(home)/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].first(where: fm.isExecutableFile(atPath:)) }
        if npm == nil { npm = ["/opt/homebrew/bin/npm", "/usr/local/bin/npm"].first(where: fm.isExecutableFile(atPath:)) }
        return plan(bun: bun != nil, npm: npm != nil, path: path)
    }

    static func plan(bun: Bool, npm: Bool, path: String) -> OmpInstallPlan {
        let install = "bun install -g \(package)"
        if bun { return OmpInstallPlan(installer: "bun", command: install, path: path) }
        if npm { return OmpInstallPlan(installer: "npm", command: "npm install -g bun && \(install)", path: path) }
        return OmpInstallPlan(installer: "none", command: "curl -fsSL https://bun.sh/install | bash && ~/.bun/bin/bun install -g \(package)", path: path)
    }

    /// Opens Terminal running the plan. The script ends with a line telling the user to return to Ocelot,
    /// which notices the finished install by itself.
    @MainActor
    static func openInTerminal(_ plan: OmpInstallPlan) throws {
        let script = try OmpCLI.agentDirectory().appendingPathComponent("Install omp.command")
        let body = """
        #!/bin/zsh
        export PATH=\(shellQuote(plan.path)):$HOME/.bun/bin
        echo 'Installing omp (the agent Ocelot runs)…'
        echo '$ \(plan.command)'
        echo
        if \(plan.command); then
          echo
          echo 'omp is installed. Go back to Ocelot; it continues on its own.'
        else
          echo
          echo 'The install failed (see above). Fix the error and run it again, or go back to Ocelot and click Check again.'
        fi

        """
        try body.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        guard NSWorkspace.shared.open(script) else {
            throw BridgeFailure(.internal, "Could not open Terminal. Copy the install command from the Ocelot panel, run it in a terminal, then click Check again.")
        }
    }

    private static func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
}
