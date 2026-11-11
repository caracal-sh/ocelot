import XCTest
@testable import Ocelot

/// Where updates come from (build settings in Info.plist) and the public-repo path: plain URLs, no token, no preflight.
final class UpdateConfigTests: XCTestCase {
    private func fakeGH(marker: URL) throws -> String {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("fake-gh-\(UUID().uuidString)")
        try "#!/bin/sh\ntouch '\(marker.path)'\necho gho_from_fake_gh\n".write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url.path
    }

    // MARK: URL building

    func testURLsFollowTheRepoSlug() throws {
        let config = try XCTUnwrap(UpdateConfig(repo: "acme/ocelot-app", needsAuth: false))
        XCTAssertEqual(config.feedURL.absoluteString, "https://raw.githubusercontent.com/acme/ocelot-app/updates/appcast.xml")
        XCTAssertEqual(config.repoURL.absoluteString, "https://api.github.com/repos/acme/ocelot-app")
        XCTAssertEqual(config.releasesURL.absoluteString, "https://github.com/acme/ocelot-app/releases")
    }

    func testRepoMustBeOwnerSlashName() {
        for bad in ["", "ocelot", "a/b/c", "/ocelot", "acme/", "acme/oce lot", "acme/ocelot?x=1", "-acme/ocelot", "$(OCELOT_UPDATE_REPO)"] {
            XCTAssertNil(UpdateConfig(repo: bad, needsAuth: true), "\(bad) is not an owner/name slug")
        }
        XCTAssertNotNil(UpdateConfig(repo: "my-org/my.repo_1", needsAuth: true))
    }

    // MARK: Info.plist

    func testInfoDictionaryReadsRepoAndMode() {
        let publicConfig = UpdateConfig(info: [UpdateConfig.repoKey: "acme/ocelot", UpdateConfig.needsAuthKey: "NO"])
        XCTAssertEqual(publicConfig, UpdateConfig(repo: "acme/ocelot", needsAuth: false))
        let privateConfig = UpdateConfig(info: [UpdateConfig.repoKey: " acme/ocelot ", UpdateConfig.needsAuthKey: "YES"])
        XCTAssertEqual(privateConfig, UpdateConfig(repo: "acme/ocelot", needsAuth: true))
    }

    func testMissingOrUnrecognisedModeMeansPrivate() {
        // Private is the conservative reading: it can only make the app send the token to GitHub, never skip a check it needs.
        for value: Any? in [nil, "", "YES", "garbage", "$(OCELOT_UPDATE_NEEDS_AUTH)", 7] {
            XCTAssertTrue(UpdateConfig.parseNeedsAuth(value), "\(String(describing: value))")
        }
        for value: Any? in ["NO", "no", " No ", "false", "0", false] {
            XCTAssertFalse(UpdateConfig.parseNeedsAuth(value), "\(String(describing: value))")
        }
    }

    func testNoRepoInInfoMeansNoFeed() {
        XCTAssertNil(UpdateConfig(info: nil))
        XCTAssertNil(UpdateConfig(info: [UpdateConfig.needsAuthKey: "NO"]))
        XCTAssertNil(UpdateConfig(info: [UpdateConfig.repoKey: "$(OCELOT_UPDATE_REPO)"]))
    }

    func testThisBuildCarriesItsSettings() throws {
        // project.yml defines both build settings; the generated Info.plist must carry them.
        let info = try XCTUnwrap(Bundle(for: UpdateService.self).infoDictionary)
        XCTAssertNotNil(UpdateConfig(info: info), "Info.plist has no usable OcelotUpdateRepo")
        XCTAssertNotNil(info[UpdateConfig.needsAuthKey])
    }

    // MARK: The public-repo path

    func testPublicRepoSendsNoHeaders() throws {
        let config = try XCTUnwrap(UpdateConfig(repo: "acme/ocelot", needsAuth: false))
        XCTAssertNil(GitHubUpdateAuth.feedHeaders(config: config, token: "gho_leaked"))
        XCTAssertNil(GitHubUpdateAuth.downloadHeaders(config: config, token: "gho_leaked"), "a public download must not carry a token, nor the octet-stream Accept")
    }

    func testPublicPreflightIsReadyWithoutTouchingGhOrGitHub() async throws {
        let marker = FileManager.default.temporaryDirectory.appendingPathComponent("gh-ran-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: marker) }
        let gh = try fakeGH(marker: marker)
        let config = try XCTUnwrap(UpdateConfig(repo: "acme/ocelot", needsAuth: false))
        let result = await GitHubUpdateAuth.preflight(config: config, checkRepo: true, environment: ["OCELOT_GH_PATH": gh, "GH_TOKEN": "gho_env"])
        XCTAssertEqual(result.access, .ready)
        XCTAssertNil(result.token)
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path), "the public path must not run gh")
    }

    func testPrivatePreflightStillReadsTheToken() async throws {
        // With no network call (checkRepo: false) the private path returns the token gh printed.
        let marker = FileManager.default.temporaryDirectory.appendingPathComponent("gh-ran-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: marker) }
        let gh = try fakeGH(marker: marker)
        let config = try XCTUnwrap(UpdateConfig(repo: "acme/ocelot", needsAuth: true))
        let result = await GitHubUpdateAuth.preflight(config: config, checkRepo: false, environment: ["OCELOT_GH_PATH": gh])
        XCTAssertEqual(result.access, .ready)
        XCTAssertEqual(result.token, "gho_from_fake_gh")
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path))
    }
}
