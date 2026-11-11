import XCTest
@testable import Ocelot

/// How the updater gets its GitHub token and what it tells the user when it cannot (Settings > Updates), for a private repo.
/// The public-repo path (no token, no preflight) is in `UpdateConfigTests`.
final class UpdateAccessTests: XCTestCase {
    private func fakeGH(_ body: String) throws -> String {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("fake-gh-\(UUID().uuidString)")
        try "#!/bin/sh\n\(body)\n".write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url.path
    }

    func testStatusMapsToActionableStates() {
        XCTAssertEqual(GitHubUpdateAuth.access(forStatus: 200), .ready)
        XCTAssertEqual(GitHubUpdateAuth.access(forStatus: 401), .notSignedIn)
        XCTAssertEqual(GitHubUpdateAuth.access(forStatus: 403), .noAccess)
        XCTAssertEqual(GitHubUpdateAuth.access(forStatus: 404), .noAccess)
        XCTAssertEqual(GitHubUpdateAuth.access(forStatus: 502), .unreachable("GitHub answered HTTP 502"))
    }

    func testMessagesNameTheNextStep() {
        let repo = "acme/widgets"
        XCTAssertTrue(UpdateAccess.ghMissing.message(repo: repo)?.contains("`brew install gh`") ?? false)
        XCTAssertTrue(UpdateAccess.notSignedIn.message(repo: repo)?.contains("`gh auth login`") ?? false)
        XCTAssertEqual(UpdateAccess.noAccess.message(repo: repo)?.hasPrefix("Your GitHub account has no access to acme/widgets"), true)
        XCTAssertNil(UpdateAccess.ready.message(repo: repo))
        XCTAssertNil(UpdateAccess.unknown.message(repo: repo))
        XCTAssertEqual(UpdateAccess.notSignedIn.fixCommand, "gh auth login")
    }

    func testTokenComesFromGhFirst() throws {
        let gh = try fakeGH(#"[ "$1 $2 $3 $4" = "auth token --hostname github.com" ] && echo "gho_from_gh" || exit 2"#)
        XCTAssertEqual(GitHubUpdateAuth.readToken(environment: ["OCELOT_GH_PATH": gh, "GITHUB_TOKEN": "from_env"]), .token("gho_from_gh"))
    }

    func testTokenFallsBackToEnvironmentWhenGhIsSignedOut() throws {
        let gh = try fakeGH("exit 1")
        XCTAssertEqual(GitHubUpdateAuth.readToken(environment: ["OCELOT_GH_PATH": gh, "GH_TOKEN": " from_env \n"]), .token("from_env"))
    }

    func testSignedOutGhWithoutEnvironmentTokenIsNotSignedIn() throws {
        let gh = try fakeGH("exit 1")
        XCTAssertEqual(GitHubUpdateAuth.readToken(environment: ["OCELOT_GH_PATH": gh]), .notSignedIn)
    }

    func testPrivateHeadersCarryTokenAndAccept() throws {
        let config = try XCTUnwrap(UpdateConfig(repo: "acme/widgets", needsAuth: true))
        XCTAssertEqual(GitHubUpdateAuth.authorization(token: "t"), "Bearer t")
        XCTAssertEqual(GitHubUpdateAuth.acceptBinary, "application/octet-stream")
        XCTAssertEqual(GitHubUpdateAuth.feedHeaders(config: config, token: "t"), ["Authorization": "Bearer t"])
        XCTAssertEqual(GitHubUpdateAuth.downloadHeaders(config: config, token: "t"), ["Authorization": "Bearer t", "Accept": "application/octet-stream"])
        XCTAssertNil(GitHubUpdateAuth.feedHeaders(config: config, token: nil))
        XCTAssertNil(GitHubUpdateAuth.downloadHeaders(config: config, token: nil))
    }

    @MainActor
    func testFeedOverrideOnlyHonoursLoopback() {
        let key = UpdateService.feedOverrideKey
        let defaults = UserDefaults.standard
        let previous = defaults.string(forKey: key)
        defer { if let previous { defaults.set(previous, forKey: key) } else { defaults.removeObject(forKey: key) } }
        defaults.set("http://127.0.0.1:8080/appcast.xml", forKey: key)
        XCTAssertEqual(UpdateService.feedOverride?.absoluteString, "http://127.0.0.1:8080/appcast.xml")
        defaults.set("https://evil.example.com/appcast.xml", forKey: key)
        XCTAssertNil(UpdateService.feedOverride, "the GitHub token must never go to a non-loopback override")
        defaults.set("http://127.0.0.1.evil.example.com/appcast.xml", forKey: key)
        XCTAssertNil(UpdateService.feedOverride)
        defaults.removeObject(forKey: key)
        XCTAssertNil(UpdateService.feedOverride)
    }
}
