import XCTest
@testable import Ocelot

/// The omp gateway adapter against a stub gateway (URLProtocol), including the upstream error mapping.
final class OmpImageProviderTests: XCTestCase {
    private let selector = "openrouter/google/gemini-3-pro-image"

    override func setUp() { StubURLProtocol.router.reset() }
    override func tearDown() { StubURLProtocol.router.reset() }

    private final class TokenLog: @unchecked Sendable {
        private let lock = NSLock()
        private var _minted: [[String]] = []
        private var _revoked: [String] = []
        func minted(_ models: [String]) { lock.lock(); _minted.append(models); lock.unlock() }
        func revoked(_ token: String) { lock.lock(); _revoked.append(token); lock.unlock() }
        var mintedModels: [[String]] { lock.lock(); defer { lock.unlock() }; return _minted }
        var revokedTokens: [String] { lock.lock(); defer { lock.unlock() }; return _revoked }
    }

    private func provider(log: TokenLog = TokenLog(), catalog: OmpCatalogResult = .notInstalled) -> OmpImageProvider {
        OmpImageProvider(
            connect: {
                OmpGatewayConnection(
                    url: URL(string: "http://127.0.0.1:47321")!,
                    mintToken: { models in log.minted(models); return "tok-secret" },
                    revoke: { log.revoked($0) }
                )
            },
            catalog: { catalog },
            session: StubURLProtocol.session()
        )
    }

    private func request(_ operation: ImageOperation = .generate, n: Int = 1, aspect: String? = "16:9", size: (width: Int, height: Int)? = nil, references: [ImageReference] = []) -> ImageRequest {
        ImageRequest(operation: operation, model: selector, prompt: "a calm sea", aspect: aspect, size: size, n: n, background: "auto", quality: nil, seed: nil, references: references)
    }

    private func okBody(_ pngs: [Data], cost: Double? = 0.04) -> [String: Any] {
        var body: [String: Any] = ["created": 1_760_000_000, "data": pngs.map { ["b64_json": $0.base64EncodedString(), "revised_prompt": "a calm sea at dawn"] }]
        if let cost { body["usage"] = ["cost": cost] }
        return body
    }

    func testGenerationsRequestShapeTokenScopeAndRevocation() async throws {
        let png = TestImages.png(width: 6, height: 6)
        StubURLProtocol.router.handler = { _ in .json(self.okBody([png, png])) }
        let log = TokenLog()
        let images = try await provider(log: log).generate(request(n: 2), progress: { _ in })

        XCTAssertEqual(images.count, 2)
        XCTAssertEqual(images[0].data, png)
        XCTAssertEqual(images[0].revisedPrompt, "a calm sea at dawn")
        XCTAssertEqual(images[0].params["cost"], .number(0.02))

        let sent = try XCTUnwrap(StubURLProtocol.router.requests.first)
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.url.absoluteString, "http://127.0.0.1:47321/v1/images/generations")
        XCTAssertEqual(sent.headers["Authorization"], "Bearer tok-secret")
        let body = try XCTUnwrap(sent.json)
        XCTAssertEqual(body["model"] as? String, selector)
        XCTAssertEqual(body["prompt"] as? String, "a calm sea")
        XCTAssertEqual(body["n"] as? Int, 2)
        XCTAssertEqual(body["response_format"] as? String, "b64_json")
        XCTAssertEqual(body["aspect_ratio"] as? String, "16:9")
        XCTAssertNil(body["size"])
        XCTAssertNil(body["images"])

        XCTAssertEqual(log.mintedModels, [[selector]], "the token is limited to the one model")
        XCTAssertEqual(log.revokedTokens, ["tok-secret"])
    }

    func testExactSizeWinsOverAspectAndEditsGoToTheEditsEndpoint() async throws {
        StubURLProtocol.router.handler = { _ in .json(self.okBody([TestImages.png()])) }
        let reference = ImageReference(id: String(repeating: "c", count: 64), data: TestImages.png(), ext: "png", mime: "image/png")
        _ = try await provider().generate(request(.edit, aspect: "1:1", size: (1024, 768), references: [reference]), progress: { _ in })
        let sent = try XCTUnwrap(StubURLProtocol.router.requests.first)
        XCTAssertEqual(sent.url.path, "/v1/images/edits")
        let body = try XCTUnwrap(sent.json)
        XCTAssertEqual(body["size"] as? String, "1024x768")
        XCTAssertNil(body["aspect_ratio"])
        let images = try XCTUnwrap(body["images"] as? [String])
        XCTAssertEqual(images.count, 1)
        XCTAssertTrue(images[0].hasPrefix("data:image/png;base64,"))
    }

    func testUpstreamErrorsMapToActionableMessagesAndStillRevokeTheToken() async throws {
        let cases: [(Int, Data, String)] = [
            (401, Data(#"{"error":{"message":"User not found.","code":401}}"#.utf8), "omp login openrouter"),
            (402, Data(#"{"error":{"message":"Insufficient credits"}}"#.utf8), "out of credit"),
            (429, Data(#"{"error":"slow down"}"#.utf8), "rate limiting"),
            (503, Data("upstream down".utf8), "server error (503)"),
            (404, Data(#"{"message":"no such model"}"#.utf8), "not available"),
            (400, Data(#"{"error":{"message":"bad size"}}"#.utf8), "bad size"),
        ]
        for (status, body, expected) in cases {
            StubURLProtocol.router.reset()
            StubURLProtocol.router.handler = { _ in StubURLProtocol.Reply(status: status, headers: ["Content-Type": "application/json"], body: body) }
            let log = TokenLog()
            do {
                _ = try await provider(log: log).generate(request(), progress: { _ in })
                XCTFail("expected failure for \(status)")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains(expected), "\(status): \(error.localizedDescription)")
                XCTAssertFalse(error.localizedDescription.contains("tok-secret"))
            }
            XCTAssertEqual(log.revokedTokens, ["tok-secret"], "token revoked after \(status)")
        }
    }

    func testUnauthorizedMessageNamesTheUpstreamAndKeepsItsReason() {
        let message = OmpImageProvider.failureMessage(status: 401, body: Data(#"{"error":{"message":"User not found."}}"#.utf8), model: selector)
        XCTAssertTrue(message.contains("openrouter rejected the credential"), message)
        XCTAssertTrue(message.contains("User not found."))
        XCTAssertTrue(message.contains("`omp login openrouter`"))
    }

    func testEmptyAndMalformedAnswersAreErrors() async {
        for body in [Data(#"{"data":[]}"#.utf8), Data(#"{"nonsense":true}"#.utf8), Data(#"{"data":[{"url":"https://x/y.png"}]}"#.utf8)] {
            StubURLProtocol.router.handler = { _ in StubURLProtocol.Reply(headers: [:], body: body) }
            do {
                _ = try await provider().generate(request(), progress: { _ in })
                XCTFail("expected failure")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("pick another model") || error.localizedDescription.contains("Try again"), error.localizedDescription)
            }
        }
    }

    func testCancellingAbortsTheRequestAndRevokes() async throws {
        StubURLProtocol.router.handler = { _ in StubURLProtocol.Reply(stall: true) }
        let log = TokenLog()
        let omp = provider(log: log)
        let imageRequest = request()
        let work = Task { try await omp.generate(imageRequest, progress: { _ in }) }
        try await waitUntil("the request to reach the gateway") { !StubURLProtocol.router.requests.isEmpty }
        work.cancel()
        do {
            _ = try await work.value
            XCTFail("expected cancellation")
        } catch is CancellationError {
            // expected
        }
        XCTAssertEqual(log.revokedTokens, ["tok-secret"])
    }

    func testBackgroundRemovalRunsAsAnEditWithTheCutOutPrompt() async throws {
        let withAlpha = TestImages.png(width: 4, height: 4)
        StubURLProtocol.router.handler = { _ in .json(self.okBody([withAlpha])) }
        let reference = ImageReference(id: String(repeating: "e", count: 64), data: TestImages.png(), ext: "png", mime: "image/png")
        let images = try await provider().generate(request(.removeBackground, references: [reference]), progress: { _ in })
        XCTAssertEqual(images.count, 1)
        XCTAssertTrue(images[0].warnings.isEmpty, "a PNG with alpha needs no warning")
        let sent = try XCTUnwrap(StubURLProtocol.router.requests.first)
        XCTAssertEqual(sent.url.path, "/v1/images/edits")
        let body = try XCTUnwrap(sent.json)
        XCTAssertEqual(body["prompt"] as? String, "Remove the background of this image completely. Keep only the main subject, unchanged and sharp, on a fully transparent background (PNG with alpha). Do not add, restyle or crop anything.")
        XCTAssertEqual((body["images"] as? [String])?.count, 1)
    }

    func testOpaqueBackgroundRemovalResultWarnsInsteadOfFailing() async throws {
        let flat = VisionImageProviderTests.opaquePNG()
        StubURLProtocol.router.handler = { _ in .json(self.okBody([flat])) }
        let reference = ImageReference(id: String(repeating: "e", count: 64), data: TestImages.png(), ext: "png", mime: "image/png")
        let images = try await provider().generate(request(.removeBackground, references: [reference]), progress: { _ in })
        XCTAssertEqual(images.count, 1)
        XCTAssertEqual(images[0].data, flat)
        XCTAssertEqual(images[0].warnings, ["\(selector) returned an image without transparency, so the background was not removed. Use the on-device model (vision:foreground-mask) or fal:fal-ai/birefnet/v2."])
        // A plain edit never gets that warning.
        let edit = try await provider().generate(request(.edit, references: [reference]), progress: { _ in })
        XCTAssertTrue(edit[0].warnings.isEmpty)
    }

    func testBackgroundRemovalNeedsASourceImage() async {
        do {
            _ = try await provider().generate(request(.removeBackground), progress: { _ in })
            XCTFail("expected failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("references"), error.localizedDescription)
        }
    }

    // MARK: Catalog

    private let catalogJSON = Data("""
    {"models":[
     {"provider":"openai-codex","kind":"image","id":"gpt-image-2","selector":"openai-codex/gpt-image-2","name":"gpt-image-2","input":["text","image"],"cost":{"cacheRead":1.25,"cacheWrite":0,"input":5,"output":30},"pricingStatus":"fixed"},
     {"provider":"openai","kind":"image","id":"gpt-image-1","selector":"openai/gpt-image-1","name":"gpt-image-1","input":["text","image"],"cost":{"input":0,"output":0},"pricingStatus":"unknown"},
     {"provider":"openrouter","kind":"image","id":"google/gemini-3-pro-image","selector":"openrouter/google/gemini-3-pro-image","name":"google/gemini-3-pro-image","input":["text","image"],"cost":{"input":2,"output":12,"cacheRead":0.2,"cacheWrite":0.375},"pricingStatus":"fixed"},
     {"provider":"openrouter","kind":"image","id":"recraft/recraft-v4-vector","selector":"openrouter/recraft/recraft-v4-vector","name":"Recraft V4 Vector","input":["text"],"cost":{"input":0,"output":0},"pricingStatus":"unknown"}
    ]}
    """.utf8)

    func testCatalogDropsCarrierHostedProvidersAndDerivesCapabilities() async {
        let models = OmpImageProvider.parseCatalog(catalogJSON)
        XCTAssertEqual(models.map(\.id), ["omp:openrouter/google/gemini-3-pro-image", "omp:openrouter/recraft/recraft-v4-vector"])
        let gemini = models[0]
        XCTAssertEqual(gemini.provider, "omp")
        XCTAssertEqual(gemini.model, "openrouter/google/gemini-3-pro-image")
        XCTAssertEqual(gemini.capabilities, ["generate", "edit", "references", "remove_background"])
        XCTAssertEqual(gemini.note, "remove_background works via edit: asks the model to cut the subject out; many models return an opaque background")
        XCTAssertEqual(gemini.cost, "$2 in / $12 out per 1M tokens")
        XCTAssertEqual(gemini.maxN, 4)
        XCTAssertTrue(gemini.available)
        let recraft = models[1]
        XCTAssertEqual(recraft.capabilities, ["generate", "vector"], "text-only input models cannot edit")
        XCTAssertNil(recraft.cost)

        let status = await provider(catalog: .models(catalogJSON)).status()
        XCTAssertEqual(status.status, "ready")
        XCTAssertEqual(status.models.count, 2)
    }

    func testStatusExplainsMissingOmpAndEmptyCatalogs() async {
        let missing = await provider(catalog: .notInstalled).status()
        XCTAssertEqual(missing.status, "unavailable")
        XCTAssertTrue(missing.setup?.contains("omp login") == true)
        let failed = await provider(catalog: .failed("boom")).status()
        XCTAssertEqual(failed.status, "unavailable")
        XCTAssertTrue(failed.detail.contains("boom"))
        let empty = await provider(catalog: .models(Data(#"{"models":[{"provider":"openai","kind":"image","id":"x","selector":"openai/x","input":["text"]}]}"#.utf8))).status()
        XCTAssertEqual(empty.status, "needs_setup")
        XCTAssertTrue(empty.setup?.contains("omp login") == true)
    }

    /// Against the real omp and the host's auth gateway (`TEST_RUNNER_OCELOT_LIVE_OMP=1`). Without a valid
    /// provider credential the gateway's refusal must come back as an actionable message.
    @MainActor
    func testLiveOmpCatalogAndGatewayErrorMapping() async throws {
        guard ProcessInfo.processInfo.environment["OCELOT_LIVE_OMP"] == "1" else { throw XCTSkip("set TEST_RUNNER_OCELOT_LIVE_OMP=1 to run against the real omp") }
        let live = OmpImageProvider.live()
        let status = await live.status()
        XCTAssertEqual(status.status, "ready", status.detail)
        XCTAssertFalse(status.models.contains { $0.model.hasPrefix("openai-codex/") || $0.model.hasPrefix("openai/") })
        guard let model = status.models.first(where: { $0.model.hasPrefix("openrouter/") }) else { return }
        let imageRequest = ImageRequest(operation: .generate, model: model.model, prompt: "a blue square", aspect: "1:1", size: nil, n: 1, background: "auto", quality: nil, seed: nil, references: [])
        do {
            let images = try await live.generate(imageRequest, progress: { _ in })
            XCTAssertFalse(images.isEmpty)
        } catch {
            print("live omp generate failed with: \(error.localizedDescription)")
            XCTAssertTrue(error.localizedDescription.contains("omp login") || error.localizedDescription.contains("credit") || error.localizedDescription.contains("rate"), error.localizedDescription)
        }
    }
}
