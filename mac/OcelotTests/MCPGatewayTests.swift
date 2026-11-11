import XCTest
@testable import Ocelot

/// Two windows (W1 -> project P1, W2 -> project P2), W2 is the key window; one remote project on another host.
@MainActor
final class FakeBackend: MCPBackend {
    var windows = [MCPWindowInfo(id: "W1", projectId: "P1"), MCPWindowInfo(id: "W2", projectId: "P2")]
    var keyId = "W2"
    var remotes: [String: MCPRemoteTarget] = ["R1": MCPRemoteTarget(instance: "headless-9", http: URL(string: "http://127.0.0.1:1")!, token: "remote-token")]
    var forwarded: [(body: String, windowId: String, client: String?, readOnly: Bool)] = []
    var proxied: [(path: String, remote: String, readOnly: Bool, session: String?)] = []
    var master = "regenerated"
    var appCalls: [(body: String, client: String?, readOnly: Bool)] = []

    func window(id: String) -> MCPWindowInfo? { windows.first { $0.id == id } }
    func window(forProject id: String) -> MCPWindowInfo? { windows.first { $0.projectId == id } }
    var keyWindow: MCPWindowInfo? { window(id: keyId) }
    func forward(body: String, windowId: String, client: String?, readOnly: Bool) async throws -> String? {
        forwarded.append((body, windowId, client, readOnly))
        if body.contains("notifications/") { return nil }
        return #"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#
    }
    func regenerateMasterToken() -> String { master }
    func callApp(body: String, client: String?, readOnly: Bool) async -> String? {
        appCalls.append((body, client, readOnly))
        if body.contains("notifications/") { return nil }
        return #"{"jsonrpc":"2.0","id":1,"result":{"app":true}}"#
    }
    func remote(forProject id: String) -> MCPRemoteTarget? { remotes[id] }
    func proxy(_ request: HTTPRequestMessage, to remote: MCPRemoteTarget, readOnly: Bool) async -> HTTPResponseMessage {
        proxied.append((request.path, remote.instance, readOnly, request.header(MCPHeader.session)))
        return .json(200, #"{"jsonrpc":"2.0","id":1,"result":{"proxied":true}}"#, headers: [MCPHeader.session: "upstream-session"])
    }
}

@MainActor
final class MCPGatewayTests: XCTestCase {
    private var backend = FakeBackend()
    private var tokens = MCPTokenStore(master: "master")
    private lazy var gateway = MCPGateway(tokens: tokens, backend: backend)

    private func request(_ method: String = "POST", path: String = "/mcp", body: String = #"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, token: String? = "master", session: String? = nil, headers: [String: String] = [:]) -> HTTPRequestMessage {
        var h = ["host": "127.0.0.1:7420", "content-type": "application/json"]
        if let token { h["authorization"] = "Bearer \(token)" }
        if let session { h["mcp-session-id"] = session }
        for (k, v) in headers { h[k.lowercased()] = v }
        return HTTPRequestMessage(method: method, path: path, version: "HTTP/1.1", headers: h, body: Data(body.utf8))
    }

    private func initialize(_ path: String = "/mcp", token: String = "master", client: String = "claude-code") async -> (HTTPResponseMessage, String?) {
        let body = #"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"\#(client)"}}}"#
        let r = await gateway.handle(request(path: path, body: body, token: token), port: 7420)
        return (r, r.headers[MCPHeader.session])
    }

    func testKeyWindowRouteGoesToTheKeyWindow() async {
        let r = await gateway.handle(request(), port: 7420)
        XCTAssertEqual(r.status, 200)
        XCTAssertEqual(backend.forwarded.last?.windowId, "W2")
    }

    func testProjectAndWindowRoutes() async {
        _ = await gateway.handle(request(path: "/mcp/p/P1"), port: 7420)
        XCTAssertEqual(backend.forwarded.last?.windowId, "W1")
        _ = await gateway.handle(request(path: "/mcp/w/W2"), port: 7420)
        XCTAssertEqual(backend.forwarded.last?.windowId, "W2")
        let unknown = await gateway.handle(request(path: "/mcp/p/nope"), port: 7420)
        XCTAssertEqual(unknown.status, 404)
        XCTAssertTrue(String(decoding: unknown.body, as: UTF8.self).contains("ocelot ls"))
        let closed = await gateway.handle(request(path: "/mcp/w/gone"), port: 7420)
        XCTAssertEqual(closed.status, 404)
    }

    func testLegacyWindowHeaderPinsLikeTheWindowRoute() async {
        _ = await gateway.handle(request(headers: [MCPHeader.window: "W1"]), port: 7420)
        XCTAssertEqual(backend.forwarded.last?.windowId, "W1")
    }

    func testSessionPinsTheKeyWindowAtInitialize() async {
        let (response, session) = await initialize()
        XCTAssertEqual(response.status, 200)
        let sid = try! XCTUnwrap(session)
        XCTAssertEqual(backend.forwarded.last?.client, "claude-code")
        backend.keyId = "W1" // the user switches windows
        _ = await gateway.handle(request(session: sid), port: 7420)
        XCTAssertEqual(backend.forwarded.last?.windowId, "W2", "the session stays on the window it was pinned to")
        XCTAssertEqual(backend.forwarded.last?.client, "claude-code")
        // A different URL for the same session is refused.
        let wrong = await gateway.handle(request("POST", path: "/mcp/p/P1", session: sid), port: 7420)
        XCTAssertEqual(wrong.status, 400)
    }

    func testUnknownSessionAndClosedWindowEndTheSession() async {
        let unknown = await gateway.handle(request(session: "nope"), port: 7420)
        XCTAssertEqual(unknown.status, 404)
        let (_, session) = await initialize("/mcp/w/W1")
        backend.windows.removeAll { $0.id == "W1" }
        let after = await gateway.handle(request(path: "/mcp/w/W1", session: session), port: 7420)
        XCTAssertEqual(after.status, 404, "a compliant client re-initializes on 404")
        XCTAssertNil(gateway.sessions[session!])
    }

    func testProjectSessionsFollowTheProjectAcrossWindows() async {
        let (_, session) = await initialize("/mcp/p/P1")
        backend.windows = [MCPWindowInfo(id: "W9", projectId: "P1")] // reopened in another window
        backend.keyId = "W9"
        _ = await gateway.handle(request(path: "/mcp/p/P1", session: session), port: 7420)
        XCTAssertEqual(backend.forwarded.last?.windowId, "W9")
    }

    func testWindowScopedTokenIsRefusedOnAnotherWindow() async {
        let token = tokens.issue(scope: .window("W1"), readOnly: false, ttl: nil)
        let ok = await gateway.handle(request(path: "/mcp/w/W1", token: token), port: 7420)
        XCTAssertEqual(ok.status, 200)
        let sameViaProject = await gateway.handle(request(path: "/mcp/p/P1", token: token), port: 7420)
        XCTAssertEqual(sameViaProject.status, 200, "W1 hosts P1")
        let other = await gateway.handle(request(path: "/mcp/w/W2", token: token), port: 7420)
        XCTAssertEqual(other.status, 403)
        XCTAssertTrue(String(decoding: other.body, as: UTF8.self).contains("/mcp/w/W1"))
        // `/mcp` follows the key window (W2): not this token's window.
        let key = await gateway.handle(request(token: token), port: 7420)
        XCTAssertEqual(key.status, 403)
        XCTAssertEqual(backend.forwarded.filter { $0.windowId == "W2" }.count, 0)
    }

    func testProjectScopedTokenAndRemoteProjects() async {
        let token = tokens.issue(scope: .project("R1"), readOnly: true, ttl: nil)
        let r = await gateway.handle(request(path: "/mcp/p/R1", token: token, session: "up"), port: 7420)
        XCTAssertEqual(r.status, 200)
        XCTAssertEqual(backend.proxied.last?.remote, "headless-9")
        XCTAssertEqual(backend.proxied.last?.readOnly, true, "the read-only limit travels with the proxied request")
        XCTAssertEqual(backend.proxied.last?.session, "up", "the upstream session id is relayed, not interpreted")
        XCTAssertEqual(r.headers[MCPHeader.session], "upstream-session")
        let other = await gateway.handle(request(path: "/mcp/p/P1", token: token), port: 7420)
        XCTAssertEqual(other.status, 403)
        let windowToken = tokens.issue(scope: .window("W1"), readOnly: false, ttl: nil)
        let refused = await gateway.handle(request(path: "/mcp/p/R1", token: windowToken), port: 7420)
        XCTAssertEqual(refused.status, 403, "a window token cannot reach a project hosted elsewhere")
        XCTAssertEqual(backend.forwarded.count, 0)
    }

    func testReadOnlyGrantReachesTheEditor() async {
        let token = tokens.issue(scope: .project("P1"), readOnly: true, ttl: nil)
        _ = await gateway.handle(request(path: "/mcp/p/P1", token: token), port: 7420)
        XCTAssertEqual(backend.forwarded.last?.readOnly, true)
        _ = await gateway.handle(request(path: "/mcp/p/P1"), port: 7420)
        XCTAssertEqual(backend.forwarded.last?.readOnly, false)
    }

    func testMasterTokenWithTheReadOnlyHeaderIsReadOnlyAndTheHeaderNeverWidens() async {
        // The receiving side of an app-to-app hop: master token plus the header the front door adds.
        _ = await gateway.handle(request(path: "/mcp/p/P1", headers: [MCPHeader.readOnly: "1"]), port: 7420)
        XCTAssertEqual(backend.forwarded.last?.readOnly, true)
        _ = await gateway.handle(request(path: "/mcp/p/P1", headers: [MCPHeader.readOnly: "0"]), port: 7420)
        XCTAssertEqual(backend.forwarded.last?.readOnly, false)
        let ro = tokens.issue(scope: .project("P1"), readOnly: true, ttl: nil)
        _ = await gateway.handle(request(path: "/mcp/p/P1", token: ro, headers: [MCPHeader.readOnly: "0"]), port: 7420)
        XCTAssertEqual(backend.forwarded.last?.readOnly, true, "a header cannot lift a token's own limit")
        _ = await gateway.handle(request(path: "/mcp/p/R1", headers: [MCPHeader.readOnly: "1"]), port: 7420)
        XCTAssertEqual(backend.proxied.last?.readOnly, true, "the limit survives a further hop")
    }

    func testProxyCarriesTheReadOnlyLimitToTheTargetInstance() {
        let remote = MCPRemoteTarget(instance: "app-2", http: URL(string: "http://127.0.0.1:7421")!, token: "remote-master")
        let body = #"{"jsonrpc":"2.0","id":1,"method":"tools/call"}"#
        let incoming = request(path: "/mcp/p/P9", body: body, token: "scoped", headers: [MCPHeader.readOnly: "0", "Accept": "application/json"])
        let limited = LiveMCPBackend.upstreamRequest(for: incoming, to: remote, readOnly: true)
        XCTAssertEqual(limited?.url?.absoluteString, "http://127.0.0.1:7421/mcp/p/P9")
        XCTAssertEqual(limited?.value(forHTTPHeaderField: "Authorization"), "Bearer remote-master", "the caller's token never leaves the app")
        XCTAssertEqual(limited?.value(forHTTPHeaderField: MCPHeader.readOnly), "1")
        XCTAssertEqual(limited?.httpBody, Data(body.utf8))
        // A caller-supplied header is not relayed; only the gateway's own decision is.
        let open = LiveMCPBackend.upstreamRequest(for: incoming, to: remote, readOnly: false)
        XCTAssertNil(open?.value(forHTTPHeaderField: MCPHeader.readOnly))
    }

    func testDeleteNeedsTheScopeOfTheSessionAndRelaysToRemoteProjects() async {
        let (_, session) = await initialize("/mcp/w/W1")
        let sid = session!
        let other = tokens.issue(scope: .window("W2"), readOnly: false, ttl: nil)
        let refused = await gateway.handle(request("DELETE", path: "/mcp/w/W1", token: other, session: sid), port: 7420)
        XCTAssertEqual(refused.status, 403)
        XCTAssertNotNil(gateway.sessions[sid], "another scope cannot end the session")
        let own = tokens.issue(scope: .window("W1"), readOnly: false, ttl: nil)
        let ended = await gateway.handle(request("DELETE", path: "/mcp/w/W1", token: own, session: sid), port: 7420)
        XCTAssertEqual(ended.status, 200)
        XCTAssertNil(gateway.sessions[sid])

        // A remote project's session: the DELETE is relayed (with the caller's limit) only to a token that may use it.
        let scoped = tokens.issue(scope: .project("P1"), readOnly: true, ttl: nil)
        let denied = await gateway.handle(request("DELETE", path: "/mcp/p/R1", token: scoped, session: "up"), port: 7420)
        XCTAssertEqual(denied.status, 403)
        XCTAssertTrue(backend.proxied.isEmpty, "no DELETE reaches the other instance with its master token")
        let remoteToken = tokens.issue(scope: .project("R1"), readOnly: true, ttl: nil)
        _ = await gateway.handle(request("DELETE", path: "/mcp/p/R1", token: remoteToken, session: "up"), port: 7420)
        XCTAssertEqual(backend.proxied.last?.readOnly, true)
    }

    func testAdminMintRefusesMistypedReadOnlyAndTTL() async throws {
        func mint(_ body: String) async -> (Int, [String: Any]) {
            let r = await gateway.handle(request(path: "/ocelot/v1/tokens", body: body), port: 7420)
            return (r.status, (try? JSONSerialization.jsonObject(with: r.body) as? [String: Any]) ?? [:])
        }
        for body in [
            #"{"scope":"project","id":"P1","readOnly":"true"}"#,
            #"{"scope":"project","id":"P1","readOnly":1}"#,
            #"{"scope":"project","id":"P1","ttlSeconds":"60"}"#,
            #"{"scope":"project","id":"P1","ttlSeconds":true}"#,
            #"{"scope":"project","id":"P1","ttlSeconds":0}"#,
            #"{"scope":"project","id":"P1","ttlSeconds":1e30}"#,
        ] {
            let (status, _) = await mint(body)
            XCTAssertEqual(status, 400, body)
        }
        let (ok, reply) = await mint(#"{"scope":"project","id":"P1","readOnly":false,"ttlSeconds":60}"#)
        XCTAssertEqual(ok, 200)
        XCTAssertNotNil(reply["expires"])
    }

    func testRevokedAndExpiredTokensAreRefused() async {
        var now = Date(timeIntervalSince1970: 1000)
        tokens = MCPTokenStore(master: "master", now: { now })
        gateway = MCPGateway(tokens: tokens, backend: backend)
        let short = tokens.issue(scope: .window("W1"), readOnly: false, ttl: .seconds(60))
        let revoked = tokens.issue(scope: .window("W1"), readOnly: false, ttl: nil)
        tokens.revoke(revoked)
        let gone = await gateway.handle(request(path: "/mcp/w/W1", token: revoked), port: 7420)
        XCTAssertEqual(gone.status, 401)
        let fresh = await gateway.handle(request(path: "/mcp/w/W1", token: short), port: 7420)
        XCTAssertEqual(fresh.status, 200)
        now = Date(timeIntervalSince1970: 1061)
        let expired = await gateway.handle(request(path: "/mcp/w/W1", token: short), port: 7420)
        XCTAssertEqual(expired.status, 401)
    }

    func testAdminAPIMintsAndRotatesForTheMasterTokenOnly() async throws {
        func admin(_ path: String, _ body: String, token: String = "master") async -> (Int, [String: Any]) {
            let r = await gateway.handle(request(path: path, body: body, token: token), port: 7420)
            return (r.status, (try? JSONSerialization.jsonObject(with: r.body) as? [String: Any]) ?? [:])
        }
        let (status, minted) = await admin("/ocelot/v1/tokens", #"{"scope":"project","id":"P1","readOnly":true,"ttlSeconds":3600}"#)
        XCTAssertEqual(status, 200)
        XCTAssertEqual(minted["url"] as? String, "http://127.0.0.1:7420/mcp/p/P1")
        let scoped = try XCTUnwrap(minted["token"] as? String)
        XCTAssertEqual(tokens.authorize("Bearer \(scoped)"), MCPGrant(scope: .project("P1"), readOnly: true))
        let (forbidden, _) = await admin("/ocelot/v1/tokens", #"{"scope":"project","id":"P1"}"#, token: scoped)
        XCTAssertEqual(forbidden, 403)
        let (bad, _) = await admin("/ocelot/v1/tokens", #"{"scope":"galaxy","id":"P1"}"#)
        XCTAssertEqual(bad, 400)
        let (rotated, reply) = await admin("/ocelot/v1/token/regenerate", "{}")
        XCTAssertEqual(rotated, 200)
        XCTAssertEqual(reply["token"] as? String, "regenerated")
        let (unauth, _) = await admin("/ocelot/v1/tokens", "{}", token: "wrong")
        XCTAssertEqual(unauth, 401)
    }

    func testDeleteEndsTheSession() async {
        let (_, session) = await initialize()
        let sid = session!
        let d = await gateway.handle(request("DELETE", session: sid), port: 7420)
        XCTAssertEqual(d.status, 200)
        XCTAssertNil(gateway.sessions[sid])
    }

    // MARK: App endpoint

    func testAppRouteIsAnsweredByTheAppAndNeverReachesAWindow() async {
        let (response, session) = await initialize("/mcp/app", client: "claude-code")
        XCTAssertEqual(response.status, 200)
        XCTAssertNotNil(session)
        XCTAssertEqual(backend.appCalls.last?.client, "claude-code")
        XCTAssertEqual(backend.forwarded.count, 0, "app tools run with no editor window involved")
        let call = await gateway.handle(request(path: "/mcp/app", session: session), port: 7420)
        XCTAssertEqual(call.status, 200)
        XCTAssertEqual(backend.appCalls.last?.client, "claude-code", "the session remembers who is calling")
        XCTAssertEqual(gateway.connectedClients.first?.client, "claude-code")
        XCTAssertEqual(gateway.connectedClients.first?.route, "/mcp/app")
    }

    func testAppRouteWorksWithNoWindowOpen() async {
        backend.windows = []
        let r = await gateway.handle(request(path: "/mcp/app"), port: 7420)
        XCTAssertEqual(r.status, 200, "listing and opening projects must not need an open project")
        let documents = await gateway.handle(request(path: "/mcp"), port: 7420)
        XCTAssertEqual(documents.status, 503)
        XCTAssertTrue(String(decoding: documents.body, as: UTF8.self).contains("open_project"), "the error says how to open a project")
    }

    func testScopedTokensCannotUseTheAppTools() async {
        let window = tokens.issue(scope: .window("W1"), readOnly: false, ttl: nil)
        let project = tokens.issue(scope: .project("P1"), readOnly: true, ttl: nil)
        for token in [window, project] {
            let r = await gateway.handle(request(path: "/mcp/app", token: token), port: 7420)
            XCTAssertEqual(r.status, 403)
            XCTAssertTrue(String(decoding: r.body, as: UTF8.self).contains("master token"))
        }
        let anonymous = await gateway.handle(request(path: "/mcp/app", token: nil), port: 7420)
        XCTAssertEqual(anonymous.status, 401)
        XCTAssertEqual(backend.appCalls.count, 0)
    }

    func testAppSessionsStayOnTheAppRoute() async {
        let (_, session) = await initialize("/mcp/app")
        let wrong = await gateway.handle(request(path: "/mcp/p/P1", session: session), port: 7420)
        XCTAssertEqual(wrong.status, 400)
        let (_, windowSession) = await initialize("/mcp/p/P1")
        let other = await gateway.handle(request(path: "/mcp/app", session: windowSession), port: 7420)
        XCTAssertEqual(other.status, 400)
        let unknown = await gateway.handle(request(path: "/mcp/app", session: "nope"), port: 7420)
        XCTAssertEqual(unknown.status, 404)
        _ = await gateway.handle(request("DELETE", path: "/mcp/app", session: session), port: 7420)
        XCTAssertNil(gateway.sessions[session!])
    }

    func testReadOnlyLimitReachesTheAppServer() async {
        _ = await gateway.handle(request(path: "/mcp/app", headers: [MCPHeader.readOnly: "1"]), port: 7420)
        XCTAssertEqual(backend.appCalls.last?.readOnly, true)
    }
}

final class MCPTokenStoreTests: XCTestCase {
    func testMasterAndScopedGrants() {
        let store = MCPTokenStore(master: "m")
        let t = store.issue(scope: .window("W"), readOnly: false, ttl: nil)
        XCTAssertEqual(store.authorize("Bearer m"), .master)
        XCTAssertEqual(store.authorize("Bearer \(t)")?.scope, .window("W"))
        XCTAssertNil(store.authorize("Bearer x"))
        XCTAssertNil(store.authorize("m"))
        store.revokeAll(scope: .window("W"))
        XCTAssertNil(store.authorize("Bearer \(t)"))
    }

    func testGrantPermits() {
        XCTAssertTrue(MCPGrant.master.permits(windowId: nil, projectId: nil))
        let w = MCPGrant(scope: .window("W1"), readOnly: false)
        XCTAssertTrue(w.permits(windowId: "W1", projectId: "P"))
        XCTAssertFalse(w.permits(windowId: "W2", projectId: "P"))
        XCTAssertFalse(w.permits(windowId: nil, projectId: "P"))
        let p = MCPGrant(scope: .project("P"), readOnly: true)
        XCTAssertTrue(p.permits(windowId: nil, projectId: "P"))
        XCTAssertFalse(p.permits(windowId: "W1", projectId: "Q"))
    }
}
