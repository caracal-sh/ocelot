import XCTest
@testable import Ocelot

@MainActor
final class BridgeTests: XCTestCase {
    private lazy var session = DocumentSession(editor: { nil })

    private func makeHost() -> HostEndpoint {
        let host = HostEndpoint()
        HostMethodHandlers.register(on: host, session: session)
        return host
    }

    func testDocumentChangedMarksSessionDirty() async throws {
        let request = #"{"v":1,"id":"x","method":"host.documentChanged","params":{"name":"Pricing","revision":3}}"#
        let response = try decodeResponse(await makeHost().dispatch(request))
        XCTAssertTrue(response.ok)
        XCTAssertTrue(session.isDirty)
        XCTAssertEqual(session.title, "Pricing — Edited")
    }

    private func decodeResponse(_ json: String) throws -> BridgeResponseEnvelope {
        try JSONDecoder().decode(BridgeResponseEnvelope.self, from: Data(json.utf8))
    }

    // Exactly what the TS RpcClient sends (see editor/src/bridge/rpc.ts).
    func testHostPingFromEditorEnvelope() async throws {
        let request = #"{"v":1,"id":"ed-abc-1","method":"host.ping","params":{"message":"hi"}}"#
        let response = try decodeResponse(await makeHost().dispatch(request))
        XCTAssertTrue(response.ok)
        XCTAssertEqual(response.id, "ed-abc-1")
        let result = try BridgeCoding.decode(PingResult.self, from: XCTUnwrap(response.result))
        XCTAssertEqual(result.message, "hi")
        XCTAssertEqual(result.from, "swift")
    }

    func testUnknownMethodListsKnownMethods() async throws {
        let request = #"{"v":1,"id":"x","method":"host.nope","params":{}}"#
        let response = try decodeResponse(await makeHost().dispatch(request))
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.error?.code, .unknownMethod)
        XCTAssertTrue(response.error?.message.contains("host.ping") ?? false)
    }

    func testInvalidParams() async throws {
        let request = #"{"v":1,"id":"x","method":"host.ping","params":{"message":42}}"#
        let response = try decodeResponse(await makeHost().dispatch(request))
        XCTAssertEqual(response.error?.code, .invalidParams)
    }

    func testMalformedRequestStillAnswers() async throws {
        let response = try decodeResponse(await makeHost().dispatch("{nope"))
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.error?.code, .invalidParams)
    }

    func testEditorClientRoundTrip() async throws {
        // Fake editor: answers editor.ping like editor/src/host/editorMethods.ts.
        let client = EditorClient { json in
            let req = try JSONDecoder().decode(BridgeRequestEnvelope.self, from: Data(json.utf8))
            let params = try BridgeCoding.decode(PingParams.self, from: req.params ?? .null)
            let result = PingResult(message: params.message, from: "editor", version: "test", receivedAt: 0)
            return BridgeCoding.string(BridgeResponseEnvelope(v: 1, id: req.id, ok: true, result: try BridgeCoding.encode(result), error: nil))
        }
        let result = try await client.call(EditorMethods.Ping.self, PingParams(message: "yo"))
        XCTAssertEqual(result, PingResult(message: "yo", from: "editor", version: "test", receivedAt: 0))
    }

    func testEditorClientPropagatesRemoteError() async {
        let client = EditorClient { json in
            let req = try JSONDecoder().decode(BridgeRequestEnvelope.self, from: Data(json.utf8))
            // Exactly what the TS RpcServer returns on a thrown BridgeError.
            return #"{"v":1,"id":"\#(req.id)","ok":false,"error":{"code":"invalid_params","message":"bad","data":{"field":"message"}}}"#
        }
        do {
            _ = try await client.call(EditorMethods.Ping.self, PingParams(message: ""))
            XCTFail("expected failure")
        } catch let f as BridgeFailure {
            XCTAssertEqual(f, BridgeFailure(.invalidParams, "bad", data: .object(["field": .string("message")])))
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testEditorClientTimesOut() async {
        let client = EditorClient { _ in
            try await Task.sleep(for: .seconds(5))
            return ""
        }
        let start = ContinuousClock.now
        do {
            _ = try await client.call(EditorMethods.Ping.self, PingParams(message: ""), timeout: .milliseconds(100))
            XCTFail("expected timeout")
        } catch let f as BridgeFailure {
            XCTAssertEqual(f.code, .timeout)
            XCTAssertLessThan(ContinuousClock.now - start, .seconds(2))
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testEditorClientMapsTransportFailure() async {
        struct Gone: Error {}
        let client = EditorClient { _ in throw Gone() }
        do {
            _ = try await client.call(EditorMethods.Ping.self, PingParams(message: ""))
            XCTFail("expected failure")
        } catch let f as BridgeFailure {
            XCTAssertEqual(f.code, .hostUnavailable)
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testJSONValueRoundTrip() throws {
        let value: JSONValue = .object(["a": .array([.number(1), .bool(true), .null, .string("x")])])
        let data = try JSONEncoder().encode(value)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: data), value)
    }
}

final class SchemeHandlerTests: XCTestCase {
    func testResolveStaysInsideRoot() {
        let root = URL(fileURLWithPath: "/tmp/ocelot-dist", isDirectory: true)
        XCTAssertEqual(EditorSchemeHandler.resolve(path: "/", in: root)?.lastPathComponent, "index.html")
        XCTAssertEqual(EditorSchemeHandler.resolve(path: "/assets/app.js", in: root)?.path, "/tmp/ocelot-dist/assets/app.js")
        XCTAssertNil(EditorSchemeHandler.resolve(path: "/../etc/passwd", in: root))
        XCTAssertNil(EditorSchemeHandler.resolve(path: "/%2E%2E/etc/passwd", in: root))
    }

    func testMimeTypes() {
        XCTAssertEqual(EditorSchemeHandler.mimeType(for: URL(fileURLWithPath: "a.js")), "text/javascript; charset=utf-8")
        XCTAssertEqual(EditorSchemeHandler.mimeType(for: URL(fileURLWithPath: "a.css")), "text/css; charset=utf-8")
    }
}
