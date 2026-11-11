import Foundation

/// Where this build gets its updates from and whether reading them needs the user's GitHub sign-in. Both are build
/// settings (`OCELOT_UPDATE_REPO`, `OCELOT_UPDATE_NEEDS_AUTH` in project.yml) that land in Info.plist, so the same source
/// builds for a private repo (token from the user's GitHub CLI) and for a public one (no token, no preflight).
struct UpdateConfig: Equatable, Sendable {
    static let repoKey = "OcelotUpdateRepo"
    static let needsAuthKey = "OcelotUpdateNeedsAuth"

    /// `owner/name` of the GitHub repo that hosts the releases and the `updates` branch.
    let repo: String
    /// The repo is private: every request carries the user's GitHub token and the DMG comes from the release-asset API.
    /// Public: plain URLs, no token, nothing asked of GitHub before Sparkle runs.
    let needsAuth: Bool

    /// nil when `repo` is not an `owner/name` slug.
    init?(repo: String, needsAuth: Bool) {
        guard repo.range(of: #"^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil else { return nil }
        self.repo = repo
        self.needsAuth = needsAuth
    }

    /// From Info.plist values. A missing or unrecognised "needs auth" value means private (the conservative reading:
    /// the token is only ever sent to GitHub); a missing or malformed repo means no update feed at all.
    init?(info: [String: Any]?) {
        let repo = (info?[Self.repoKey] as? String ?? "").trimmingCharacters(in: .whitespaces)
        self.init(repo: repo, needsAuth: Self.parseNeedsAuth(info?[Self.needsAuthKey]))
    }

    static func parseNeedsAuth(_ value: Any?) -> Bool {
        if let flag = value as? Bool { return flag }
        switch (value as? String)?.trimmingCharacters(in: .whitespaces).lowercased() {
        case "no", "false", "0": return false
        default: return true
        }
    }

    /// This build's configuration (nil: no usable repo in Info.plist, so no update feed).
    static let current = UpdateConfig(info: Bundle.main.infoDictionary)

    /// The appcast lives on the orphan `updates` branch. raw.githubusercontent.com serves a private
    /// repo's file to a bearer token whatever the Accept header is; the contents API would not, because Sparkle
    /// overrides `Accept` on the appcast request with `application/rss+xml` and the API then answers JSON.
    var feedURL: URL { URL(string: "https://raw.githubusercontent.com/\(repo)/updates/appcast.xml")! }
    /// `GET` this with the token to learn whether a private repo is readable. Unused for a public repo.
    var repoURL: URL { URL(string: "https://api.github.com/repos/\(repo)")! }
    var releasesURL: URL { URL(string: "https://github.com/\(repo)/releases")! }
}
