import AppKit
import XCTest
@testable import Ocelot

final class HTTPParserTests: XCTestCase {
    func testParsesContentLengthRequestsAndKeepsLeftovers() throws {
        var p = HTTPRequestParser()
        let body = #"{"jsonrpc":"2.0","id":1,"method":"ping"}"#
        let raw = "POST /mcp?x=1 HTTP/1.1\r\nHost: 127.0.0.1:7420\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)GET /mcp HTTP/1.1\r\n\r\n"
        p.append(Data(raw.utf8))
        let first = try XCTUnwrap(try p.next())
        XCTAssertEqual(first.method, "POST")
        XCTAssertEqual(first.path, "/mcp")
        XCTAssertEqual(first.header("content-type"), "application/json")
        XCTAssertEqual(String(decoding: first.body, as: UTF8.self), body)
        XCTAssertTrue(first.keepAlive)
        let second = try XCTUnwrap(try p.next())
        XCTAssertEqual(second.method, "GET")
        XCTAssertNil(try p.next())
    }

    func testWaitsForTheWholeBody() throws {
        var p = HTTPRequestParser()
        p.append(Data("POST /mcp HTTP/1.1\r\nContent-Length: 10\r\n\r\n12345".utf8))
        XCTAssertNil(try p.next())
        p.append(Data("67890".utf8))
        XCTAssertEqual(try p.next()?.body, Data("1234567890".utf8))
    }

    func testChunkedBody() throws {
        var p = HTTPRequestParser()
        p.append(Data("POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n".utf8))
        XCTAssertEqual(try p.next()?.body, Data("hello world".utf8))
    }

    func testRejectsGarbage() {
        var p = HTTPRequestParser()
        p.append(Data("NOPE\r\n\r\n".utf8))
        XCTAssertThrowsError(try p.next())
    }

    private func chunked(_ sizeLine: String, then tail: String = "") -> HTTPRequestParser {
        var p = HTTPRequestParser()
        p.append(Data("POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n\(sizeLine)\r\n\(tail)".utf8))
        return p
    }

    func testRejectsNegativeOverflowingAndOversizedChunkSizesWithoutTrapping() {
        for line in ["-5", "+5", "7fffffffffffffff", "ffffffffffffffff", "10000000000000000", "ffffffff", "02000001", "zz", "", ";ext", "0x10", " ", "５"] {
            var p = chunked(line, then: "hello\r\n")
            XCTAssertThrowsError(try p.next(), "chunk size \(line.debugDescription)") { error in
                XCTAssertTrue(error is HTTPRequestParser.Failure)
            }
        }
        var big = chunked("2000000")  // exactly maxBodyBytes: waits for data instead of failing
        XCTAssertNil(try big.next())
        var over = chunked("2000001")
        XCTAssertThrowsError(try over.next()) { XCTAssertEqual($0 as? HTTPRequestParser.Failure, .bodyTooLarge) }
    }

    func testChunkSizesCountAgainstTheBodyLimitAcrossChunks() {
        var p = chunked("1000000", then: String(repeating: "a", count: 0x1000000) + "\r\n1000001\r\n")
        XCTAssertThrowsError(try p.next()) { XCTAssertEqual($0 as? HTTPRequestParser.Failure, .bodyTooLarge) }
    }

    func testRejectsChunksWithoutTheirTrailingCRLFAndRunawaySizeLines() {
        var p = chunked("5", then: "helloXX0\r\n\r\n")
        XCTAssertThrowsError(try p.next())
        var line = HTTPRequestParser()
        line.append(Data("POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n".utf8))
        line.append(Data(repeating: 0x31, count: 2048))
        XCTAssertThrowsError(try line.next())
    }

    func testParserNeverBuffersMoreThanItsCapAndRejectsBadContentLength() {
        var p = HTTPRequestParser()
        p.append(Data("POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n".utf8))
        p.append(Data(repeating: 0x30, count: HTTPRequestParser.maxBufferedBytes))
        XCTAssertThrowsError(try p.next())
        for length in ["-1", "+3", "99999999999999999999", "0x10", "1e3", ""] {
            var q = HTTPRequestParser()
            q.append(Data("POST /mcp HTTP/1.1\r\nContent-Length: \(length)\r\n\r\nabc".utf8))
            XCTAssertThrowsError(try q.next(), "Content-Length \(length.debugDescription)")
        }
    }

    func testRandomBytesNeverTrapTheParser() {
        var rng = SystemRandomNumberGenerator()
        let pieces = ["POST /mcp HTTP/1.1\r\n", "Transfer-Encoding: chunked\r\n", "Content-Length: ", "\r\n", "\r\n\r\n", "-", "7fffffffffffffff", "ffffffff", "0", ";", "a", "5\r\nhello\r\n", "99999999999999999999"]
        for _ in 0..<2000 {
            var p = HTTPRequestParser()
            var raw = "POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"
            for _ in 0..<Int.random(in: 1...8, using: &rng) { raw += pieces.randomElement(using: &rng)! }
            p.append(Data(raw.utf8))
            for _ in 0..<3 { _ = try? p.next() }
        }
    }
}

final class MCPRequestValidatorTests: XCTestCase {
    private func req(_ method: String = "POST", path: String = "/mcp", headers: [String: String] = [:]) -> HTTPRequestMessage {
        var h = ["host": "127.0.0.1:7420", "authorization": "Bearer secret", "content-type": "application/json"]
        for (k, v) in headers { h[k.lowercased()] = v }
        return HTTPRequestMessage(method: method, path: path, version: "HTTP/1.1", headers: h, body: Data())
    }

    private let tokens = MCPTokenStore(master: "secret")

    private func status(_ r: HTTPRequestMessage) -> Int? {
        if case .reject(let response) = MCPRequestValidator.validate(r, port: 7420, tokens: tokens) { return response.status }
        return nil
    }

    func testAcceptsAValidRequestOnEveryRoute() {
        for path in ["/mcp", "/mcp/p/3f2a-uuid", "/mcp/w/ABC-123"] { XCTAssertNil(status(req(path: path)), path) }
        XCTAssertNil(status(req(headers: ["Host": "localhost:7420", "Origin": "http://localhost:7420"])))
    }

    func testRejectsWrongTokenWithActionableMessage() {
        guard case .reject(let r) = MCPRequestValidator.validate(req(headers: ["Authorization": "Bearer nope"]), port: 7420, tokens: tokens) else { return XCTFail("accepted") }
        XCTAssertEqual(r.status, 401)
        XCTAssertTrue(String(decoding: r.body, as: UTF8.self).contains("Copy MCP config"))
        XCTAssertEqual(status(req(headers: ["Authorization": ""])), 401)
    }

    func testRejectsForeignOriginsAndHosts() {
        XCTAssertEqual(status(req(headers: ["Origin": "https://evil.example"])), 403)
        XCTAssertEqual(status(req(headers: ["Host": "evil.example:7420"])), 421)
    }

    func testMethodsAndPaths() {
        XCTAssertEqual(status(req("GET")), 405)
        XCTAssertNil(status(req("DELETE")))
        XCTAssertEqual(status(req(path: "/other")), 404)
        XCTAssertEqual(status(req(path: "/mcp/p/a/b")), 404)
        XCTAssertEqual(status(req(path: "/mcp/x/a")), 404)
        XCTAssertEqual(status(req(headers: ["Content-Type": "text/plain"])), 415)
    }

    func testRouteParsing() {
        XCTAssertEqual(MCPRoute.parse(path: "/mcp"), .keyWindow)
        XCTAssertEqual(MCPRoute.parse(path: "/mcp/"), .keyWindow)
        XCTAssertEqual(MCPRoute.parse(path: "/mcp/p/abc-1"), .project("abc-1"))
        XCTAssertEqual(MCPRoute.parse(path: "/mcp/w/W1"), .window("W1"))
        XCTAssertNil(MCPRoute.parse(path: "/mcp/p/"))
        XCTAssertNil(MCPRoute.parse(path: "/mcp/p/a%2Fb"))
        XCTAssertEqual(MCPRoute.project("x").path, "/mcp/p/x")
        XCTAssertEqual(MCPRoute.parse(path: "/mcp/app"), .app)
        XCTAssertEqual(MCPRoute.parse(path: "/mcp/app/"), .app)
        XCTAssertEqual(MCPRoute.app.path, "/mcp/app")
        XCTAssertNil(MCPRoute.parse(path: "/mcp/apps"))
    }
}

@MainActor
final class MCPHTTPServerLiveTests: XCTestCase {
    func testServesJSONRPCOverLoopback() async throws {
        let backend = FakeBackend()
        let gateway = MCPGateway(tokens: MCPTokenStore(master: "t0ken"), backend: backend)
        let server = MCPHTTPServer(port: 0) { request, port in await gateway.handle(request, port: port) }
        let ready = expectation(description: "listening")
        server.onStateChange = { if case .running = $0 { ready.fulfill() } }
        server.start()
        await fulfillment(of: [ready], timeout: 5)
        guard case .running(let port) = server.state else { return XCTFail("not running: \(server.state)") }
        defer { server.stop() }

        func post(_ body: String, path: String = "/mcp", token: String = "t0ken") async throws -> (Int, String) {
            var r = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
            r.httpMethod = "POST"
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            r.httpBody = Data(body.utf8)
            let (data, resp) = try await URLSession.shared.data(for: r)
            return ((resp as! HTTPURLResponse).statusCode, String(decoding: data, as: UTF8.self))
        }

        let (status, text) = try await post(#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
        XCTAssertEqual(status, 200)
        XCTAssertTrue(text.contains(#""ok":true"#))
        // Keep-alive: a second request works too, notifications get 202.
        let (status2, _) = try await post(#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, path: "/mcp/p/P1")
        XCTAssertEqual(status2, 202)
        let (status3, _) = try await post("{}", token: "wrong")
        XCTAssertEqual(status3, 401)
        XCTAssertEqual(backend.forwarded.count, 2, "unauthorized requests never reach the editor")
    }
}

/// Spike + regression test: an offscreen WKWebView renders and snapshots real pixels.
@MainActor
final class OffscreenRendererTests: XCTestCase {
    private let html = """
    <!doctype html><html><head><style>html,body{margin:0;height:100%;overflow:hidden}[data-ocelot-root]{position:relative;width:100%;height:100%}</style></head>
    <body><div data-ocelot-root data-node-id="ab" style="background:#00ff00">
      <div data-node-id="box" style="position:absolute;left:20px;top:10px;width:40px;height:30px;background:#ff0000"></div>
      <div style="position:absolute;top:150px;height:400px;width:10px"></div>
    </div></body></html>
    """

    private func pixel(_ png: String, x: Int, y: Int) throws -> (r: Int, g: Int, b: Int) {
        let data = try XCTUnwrap(Data(base64Encoded: png))
        let rep = try XCTUnwrap(NSBitmapImageRep(data: data))
        let c = try XCTUnwrap(rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB))
        return (Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    }

    func testArtboardSnapshotAt1xAnd2x() async throws {
        let r1 = try await OffscreenRenderer.shared.render(SnapshotRequest(html: html, width: 200, height: 100, scale: 1, nodeId: nil))
        XCTAssertEqual(r1.width, 200)
        XCTAssertEqual(r1.height, 100)
        XCTAssertEqual(r1.contentHeight, 550, accuracy: 1, "overflowing content is measured")
        let bg = try pixel(r1.png, x: 150, y: 80)
        XCTAssertGreaterThan(bg.g, 200, "background should be green, got \(bg)")
        XCTAssertLessThan(bg.r, 60)
        let red = try pixel(r1.png, x: 30, y: 20)
        XCTAssertGreaterThan(red.r, 200, "box should be red, got \(red)")

        let r2 = try await OffscreenRenderer.shared.render(SnapshotRequest(html: html, width: 200, height: 100, scale: 2, nodeId: nil))
        XCTAssertEqual(r2.width, 400)
        XCTAssertEqual(r2.height, 200)
        let red2 = try pixel(r2.png, x: 60, y: 40)
        XCTAssertGreaterThan(red2.r, 200, "2x box should be red, got \(red2)")
    }

    func testNodeCrop() async throws {
        let r = try await OffscreenRenderer.shared.render(SnapshotRequest(html: html, width: 200, height: 100, scale: 2, nodeId: "box"))
        XCTAssertEqual(r.width, 80)
        XCTAssertEqual(r.height, 60)
        let c = try pixel(r.png, x: 40, y: 30)
        XCTAssertGreaterThan(c.r, 200)
        XCTAssertLessThan(c.g, 60)
    }

    func testMissingNodeExplainsItself() async {
        do {
            _ = try await OffscreenRenderer.shared.render(SnapshotRequest(html: html, width: 200, height: 100, scale: 1, nodeId: "nope"))
            XCTFail("expected failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("not rendered"), "\(error)")
        }
    }
}
