import Foundation
import os

/// Whether this Mac can read Ocelot's private releases, and why not. Shown in Settings > Updates.
enum UpdateAccess: Equatable, Sendable {
    /// Nothing known yet (no check has run, or the local checks pass and GitHub has not been asked).
    case unknown
    case checking
    case ready
    case ghMissing
    case notSignedIn
    case noAccess
    case unreachable(String)

    /// What to do next for the private repo `repo`, or nil when there is nothing to fix.
    func message(repo: String) -> String? {
        switch self {
        case .unknown, .checking, .ready: nil
        case .ghMissing: "Install the GitHub CLI (`brew install gh`), then run `gh auth login` with an account that can see \(repo)."
        case .notSignedIn: "Run `gh auth login` with an account that can see \(repo)."
        case .noAccess: "Your GitHub account has no access to \(repo). Ask the owner to add you, or sign in with another account (`gh auth login`)."
        case .unreachable(let why): "Couldn't reach GitHub (\(why)). Check your connection and try again."
        }
    }

    /// A shell command that fixes it, offered as "Copy command".
    var fixCommand: String? {
        switch self {
        case .ghMissing: "brew install gh && gh auth login"
        case .notSignedIn, .noAccess: "gh auth login"
        default: nil
        }
    }
}

/// How the updater proves to GitHub that this user may read a private releases repo (`UpdateConfig.needsAuth`): the
/// token of the user's own GitHub CLI session (`gh auth token`), read for each check, held in memory for that check
/// only. It is never logged, written to disk, or handed to the editor, the agent or the MCP server. A public repo
/// (`needsAuth == false`) never gets here: no token is read and none is sent.
enum GitHubUpdateAuth {
    static let acceptBinary = "application/octet-stream"

    enum TokenResult: Equatable, Sendable {
        case token(String)
        case ghMissing
        case notSignedIn
    }

    struct Preflight: Sendable {
        let access: UpdateAccess
        /// Present only when `access == .ready`.
        let token: String?
    }

    static func authorization(token: String) -> String { "Bearer \(token)" }

    /// Headers for a download request (the release asset API wants `Accept: application/octet-stream`, and answers JSON
    /// otherwise). A public repo needs none: nil, so no token is ever attached.
    static func downloadHeaders(config: UpdateConfig, token: String?) -> [String: String]? {
        guard config.needsAuth, let token else { return nil }
        return ["Authorization": authorization(token: token), "Accept": acceptBinary]
    }

    /// Headers for the appcast request. A public repo: nil.
    static func feedHeaders(config: UpdateConfig, token: String?) -> [String: String]? {
        guard config.needsAuth, let token else { return nil }
        return ["Authorization": authorization(token: token)]
    }

    // MARK: Token

    private static let cachedGH = OSAllocatedUnfairLock<String?>(initialState: nil)

    /// The `gh` binary: `OCELOT_GH_PATH`, then what the user's login shell resolves (GUI apps start with a minimal
    /// PATH, like omp, see `OmpCLI.locate`), then the usual install places. Remembered after the first hit.
    /// Blocking (it may start the login shell): call off the main actor.
    static func locateGH(environment env: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        if let explicit = env["OCELOT_GH_PATH"], !explicit.isEmpty, FileManager.default.isExecutableFile(atPath: explicit) { return explicit }
        if let cached = cachedGH.withLock({ $0 }), FileManager.default.isExecutableFile(atPath: cached) { return cached }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var candidates: [String] = []
        let shell = env["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        let marker = "__OCELOT__"
        if let probe = OmpCLI.runSync(shell, ["-l", "-i", "-c", #"printf '\#(marker)%s\n' "$(command -v gh)""#], env: env, timeout: 5) {
            let values = probe.split(separator: "\n").filter { $0.hasPrefix(marker) }.map { String($0.dropFirst(marker.count)) }
            if let path = values.first, path.hasPrefix("/") { candidates.append(path) }
        }
        candidates += ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "\(home)/.local/bin/gh", "/usr/bin/gh"]
        let found = candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
        cachedGH.withLock { $0 = found }
        return found
    }

    /// `gh auth token --hostname github.com`, else `GH_TOKEN` / `GITHUB_TOKEN`. Blocking: call off the main actor.
    static func readToken(environment env: [String: String] = ProcessInfo.processInfo.environment) -> TokenResult {
        let gh = locateGH(environment: env)
        if let gh {
            var childEnv = env
            let dir = (gh as NSString).deletingLastPathComponent
            childEnv["PATH"] = [dir, env["PATH"] ?? "", "/usr/bin:/bin"].filter { !$0.isEmpty }.joined(separator: ":")
            childEnv["GH_PROMPT_DISABLED"] = "1"
            if let out = OmpCLI.runSync(gh, ["auth", "token", "--hostname", "github.com"], env: childEnv, timeout: 10) {
                let token = out.trimmingCharacters(in: .whitespacesAndNewlines)
                if !token.isEmpty { return .token(token) }
            }
        }
        for name in ["GH_TOKEN", "GITHUB_TOKEN"] {
            if let value = env[name]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty { return .token(value) }
        }
        // A token that only the user's shell profile exports (GH_TOKEN in ~/.zshrc) is invisible to a GUI app:
        // ask the login shell, like locateGH does for PATH.
        if let gh {
            let shell = env["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
            let marker = "__OCELOT_TOKEN__"
            var shellEnv = env
            shellEnv["OCELOT_GH_BIN"] = gh
            if let out = OmpCLI.runSync(shell, ["-l", "-i", "-c", #"printf '\#(marker)%s\n' "$("$OCELOT_GH_BIN" auth token --hostname github.com 2>/dev/null)""#], env: shellEnv, timeout: 10),
               let line = out.split(separator: "\n").first(where: { $0.hasPrefix(marker) }) {
                let token = String(line.dropFirst(marker.count)).trimmingCharacters(in: .whitespacesAndNewlines)
                if !token.isEmpty { return .token(token) }
            }
        }
        return gh == nil ? .ghMissing : .notSignedIn
    }

    // MARK: Reachability

    /// What an HTTP status from `GET /repos/<owner>/<name>` means.
    static func access(forStatus status: Int) -> UpdateAccess {
        switch status {
        case 200: .ready
        case 401: .notSignedIn // the token is expired or revoked
        case 403, 404: .noAccess // GitHub answers 404 for a private repo the token cannot see
        default: .unreachable("GitHub answered HTTP \(status)")
        }
    }

    /// For a private repo: the token (see `readToken`) plus, when `checkRepo`, a cheap authenticated `GET /repos/<owner>/<name>`
    /// so Sparkle is only started when it can succeed. For a public repo: `.ready` at once, without reading a token or
    /// contacting GitHub. Blocking on the process part: call from a detached task.
    static func preflight(config: UpdateConfig, checkRepo: Bool, environment env: [String: String] = ProcessInfo.processInfo.environment) async -> Preflight {
        guard config.needsAuth else { return Preflight(access: .ready, token: nil) }
        let token: String
        switch readToken(environment: env) {
        case .ghMissing: return Preflight(access: .ghMissing, token: nil)
        case .notSignedIn: return Preflight(access: .notSignedIn, token: nil)
        case .token(let t): token = t
        }
        guard checkRepo else { return Preflight(access: .ready, token: token) }

        var request = URLRequest(url: config.repoURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 15)
        request.setValue(authorization(token: token), forHTTPHeaderField: "Authorization")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Ocelot-Updater", forHTTPHeaderField: "User-Agent")
        do {
            let (_, response) = try await URLSession(configuration: .ephemeral).data(for: request)
            guard let http = response as? HTTPURLResponse else { return Preflight(access: .unreachable("no HTTP response"), token: nil) }
            let result = access(forStatus: http.statusCode)
            return Preflight(access: result, token: result == .ready ? token : nil)
        } catch {
            return Preflight(access: .unreachable((error as? URLError)?.localizedDescription ?? error.localizedDescription), token: nil)
        }
    }
}
