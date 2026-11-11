import XCTest
@testable import Ocelot

/// fal adapter against stubbed HTTP. The JSON below are fixtures written from the documented queue API shapes
/// (no fal key exists on the development machine); they are not recordings of live traffic.
final class FalImageProviderTests: XCTestCase {
    private let owner = "https://queue.fal.run/fal-ai/flux/requests/req-123"

    override func setUp() {
        StubURLProtocol.router.reset()
    }

    override func tearDown() {
        StubURLProtocol.router.reset()
    }

    private func provider(key: String? = "test-key", maxDownload: Int = 1_000_000, jobTimeout: Duration = .seconds(30)) -> FalImageProvider {
        FalImageProvider(
            keyProvider: { key }, session: StubURLProtocol.session(), pollInterval: .milliseconds(5),
            maxDownload: maxDownload, jobTimeout: jobTimeout
        )
    }

    private func request(
        _ operation: ImageOperation = .generate, model: String = "fal-ai/flux/dev", n: Int = 1, aspect: String? = nil,
        size: (width: Int, height: Int)? = nil, references: [ImageReference] = [], seed: Int? = nil, prompt: String = "a lighthouse"
    ) -> ImageRequest {
        ImageRequest(
            operation: operation, model: model, prompt: prompt, aspect: aspect, size: size, n: n, background: "auto",
            quality: nil, seed: seed, references: references
        )
    }

    private var submitFixture: [String: Any] {
        [
            "request_id": "req-123", "status": "IN_QUEUE", "queue_position": 0,
            "status_url": "\(owner)/status", "response_url": owner, "cancel_url": "\(owner)/cancel",
        ]
    }

    private func resultFixture(count: Int = 1, host: String = "v3.fal.media") -> [String: Any] {
        [
            "images": (0..<count).map { ["url": "https://\(host)/files/lighthouse-\($0).png", "width": 1024, "height": 768, "content_type": "image/png"] as [String: Any] },
            "seed": 4242, "has_nsfw_concepts": [false], "timings": ["inference": 1.2], "prompt": "a lighthouse",
        ]
    }

    /// A router answering the whole happy path; `onStatus` decides the status JSON per poll.
    private func install(
        png: Data = TestImages.png(),
        result: [String: Any]? = nil,
        status: @escaping (Int) -> [String: Any] = { $0 == 0 ? ["status": "IN_QUEUE", "queue_position": 2] : $0 == 1 ? ["status": "IN_PROGRESS", "logs": []] : ["status": "COMPLETED", "logs": []] }
    ) {
        let submit = submitFixture
        let resultJSON = result ?? resultFixture()
        let polls = Counter()
        StubURLProtocol.router.handler = { r in
            let path = r.url.path
            if r.method == "POST" { return .json(submit) }
            if r.method == "GET", path.hasSuffix("/status") { return .json(status(polls.next())) }
            if r.method == "GET", r.url.host == "queue.fal.run" { return .json(resultJSON) }
            if r.method == "GET", r.url.host?.hasSuffix("fal.media") == true { return StubURLProtocol.Reply(headers: ["Content-Type": "image/png"], body: png) }
            return StubURLProtocol.Reply(status: 404)
        }
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func next() -> Int { lock.lock(); defer { lock.unlock() }; defer { value += 1 }; return value }
    }

    private final class Updates: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [ImageProgressUpdate] = []
        func add(_ u: ImageProgressUpdate) { lock.lock(); all.append(u); lock.unlock() }
        var list: [ImageProgressUpdate] { lock.lock(); defer { lock.unlock() }; return all }
    }

    // MARK: Happy paths

    func testQueueSubmitPollFetchDownloadReturnsImageAndSeed() async throws {
        let png = TestImages.png(width: 4, height: 4)
        install(png: png)
        let updates = Updates()
        let images = try await provider().generate(request(n: 1, aspect: "16:9", seed: 7), progress: { updates.add($0) })

        XCTAssertEqual(images.count, 1)
        XCTAssertEqual(images[0].data, png)
        XCTAssertEqual(images[0].seed, 4242)

        let requests = StubURLProtocol.router.requests
        let submit = try XCTUnwrap(requests.first)
        XCTAssertEqual(submit.method, "POST")
        XCTAssertEqual(submit.url.absoluteString, "https://queue.fal.run/fal-ai/flux/dev")
        XCTAssertEqual(submit.headers["Authorization"], "Key test-key")
        let body = try XCTUnwrap(submit.json)
        XCTAssertEqual(body["prompt"] as? String, "a lighthouse")
        XCTAssertEqual(body["image_size"] as? String, "landscape_16_9")
        XCTAssertEqual(body["num_images"] as? Int, 1)
        XCTAssertEqual(body["seed"] as? Int, 7)

        // Status polls use the URL fal returned (owner/app only), with logs=1.
        let polls = requests.filter { $0.url.path.hasSuffix("/status") }
        XCTAssertEqual(polls.count, 3)
        XCTAssertEqual(polls[0].url.absoluteString, "\(owner)/status?logs=1")
        // The download is not sent the key.
        let download = try XCTUnwrap(requests.first { $0.url.host == "v3.fal.media" })
        XCTAssertNil(download.headers["Authorization"])

        let stages = updates.list.map(\.stage)
        XCTAssertTrue(stages.contains("queued"))
        XCTAssertTrue(stages.contains("running"))
        XCTAssertTrue(stages.contains("downloading"))
        XCTAssertTrue(updates.list.contains { $0.message.contains("position 2") })
    }

    func testMultipleImagesSingleJobSendsNumImages() async throws {
        install(result: resultFixture(count: 3))
        let images = try await provider().generate(request(n: 3, size: (800, 600)), progress: { _ in })
        XCTAssertEqual(images.count, 3)
        let body = try XCTUnwrap(StubURLProtocol.router.requests.first?.json)
        XCTAssertEqual(body["num_images"] as? Int, 3)
        let size = try XCTUnwrap(body["image_size"] as? [String: Int])
        XCTAssertEqual(size, ["width": 800, "height": 600])
    }

    func testEndpointWithoutNumImagesRunsOncePerImage() async throws {
        install()
        let images = try await provider().generate(request(model: "fal-ai/recraft/v3/text-to-image", n: 2, prompt: "a vector icon of a leaf"), progress: { _ in })
        XCTAssertEqual(images.count, 2)
        let posts = StubURLProtocol.router.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 2)
        XCTAssertNil(posts[0].json?["num_images"])
        XCTAssertEqual(posts[0].json?["style"] as? String, "vector_illustration")
    }

    func testKontextEditSendsReferenceAsDataURI() async throws {
        install()
        let reference = ImageReference(id: String(repeating: "a", count: 64), data: TestImages.png(), ext: "png", mime: "image/png")
        _ = try await provider().generate(
            request(.edit, model: "fal-ai/flux-pro/kontext", aspect: "3:4", references: [reference], prompt: "make it night"), progress: { _ in }
        )
        let body = try XCTUnwrap(StubURLProtocol.router.requests.first?.json)
        XCTAssertEqual(body["prompt"] as? String, "make it night")
        XCTAssertTrue((body["image_url"] as? String)?.hasPrefix("data:image/png;base64,") == true)
        XCTAssertEqual(body["aspect_ratio"] as? String, "3:4")
        XCTAssertNil(body["image_size"])
    }

    func testRemoveBackgroundUsesImageResultShape() async throws {
        let cutout = TestImages.png(width: 2, height: 2, red: 9)
        install(png: cutout, result: ["image": ["url": "https://v3.fal.media/files/cutout.png", "width": 2, "height": 2, "content_type": "image/png"]])
        let reference = ImageReference(id: String(repeating: "b", count: 64), data: TestImages.png(), ext: "png", mime: "image/png")
        let images = try await provider().generate(
            request(.removeBackground, model: "fal-ai/birefnet/v2", n: 3, references: [reference], prompt: ""), progress: { _ in }
        )
        XCTAssertEqual(images.map(\.data), [cutout])
        let posts = StubURLProtocol.router.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 1, "background removal ignores n")
        XCTAssertEqual(Set(try XCTUnwrap(posts[0].json).keys), ["image_url"])
    }

    func testBriaBackgroundRemovalIsCuratedAndSendsOnlyTheImage() async throws {
        let cutout = TestImages.png(width: 2, height: 2, red: 11)
        install(png: cutout, result: ["image": ["url": "https://v3.fal.media/files/bria.png", "content_type": "image/png"]])
        let catalog = await provider().status().models
        let bria = try XCTUnwrap(catalog.first { $0.id == "fal:fal-ai/bria/background/remove" })
        XCTAssertEqual(bria.label, "Bria RMBG 2.0")
        XCTAssertEqual(bria.capabilities, ["remove_background"])
        XCTAssertEqual(bria.note, "Clean edges, commercially licensed.")
        let reference = ImageReference(id: String(repeating: "b", count: 64), data: TestImages.png(), ext: "png", mime: "image/png")
        let images = try await provider().generate(request(.removeBackground, model: "fal-ai/bria/background/remove", references: [reference], prompt: ""), progress: { _ in })
        XCTAssertEqual(images.map(\.data), [cutout])
        let post = try XCTUnwrap(StubURLProtocol.router.requests.first { $0.method == "POST" })
        XCTAssertEqual(post.url.absoluteString, "https://queue.fal.run/fal-ai/bria/background/remove")
        XCTAssertEqual(Set(try XCTUnwrap(post.json).keys), ["image_url"])
    }

    func testFreeTextEndpointIsAcceptedAndRejectsBadIds() async throws {
        install()
        _ = try await provider().generate(request(model: "fal-ai/some/new-model", n: 1), progress: { _ in })
        XCTAssertEqual(StubURLProtocol.router.requests.first?.url.absoluteString, "https://queue.fal.run/fal-ai/some/new-model")
        XCTAssertEqual(provider().customModel("fal-ai/some/new-model")?.id, "fal:fal-ai/some/new-model")
        XCTAssertNil(provider().customModel("fal-ai/flux/dev"), "curated models are not custom")
        for bad in ["../etc", "fal-ai", "a b/c", "x/../y", "https://evil.example/x"] {
            XCTAssertNil(FalEndpoint.resolve(bad), bad)
        }
    }

    func testImageSizeMapping() {
        func size(aspect: String?, size: (width: Int, height: Int)? = nil) -> Any? {
            FalImageProvider.imageSize(request(aspect: aspect, size: size))
        }
        XCTAssertEqual(size(aspect: "1:1") as? String, "square_hd")
        XCTAssertEqual(size(aspect: "9:16") as? String, "portrait_16_9")
        XCTAssertEqual(size(aspect: "4:3") as? String, "landscape_4_3")
        XCTAssertEqual((size(aspect: "21:9") as? [String: Int])?["width"], 1536)
        XCTAssertEqual((size(aspect: "21:9") as? [String: Int])?["height"], 656)
        XCTAssertEqual((size(aspect: "1:1", size: (100_000, 10)) as? [String: Int]), ["width": 4096, "height": 64])
        XCTAssertNil(size(aspect: nil))
    }

    // MARK: Status

    func testStatusReportsKeyStoredAndModelAvailability() async {
        let ready = await provider(key: "k").status()
        XCTAssertEqual(ready.status, "ready")
        XCTAssertEqual(ready.keyStored, true)
        XCTAssertTrue(ready.models.allSatisfy(\.available))
        XCTAssertEqual(ready.models.map(\.model), FalEndpoint.curated.map(\.id))
        XCTAssertTrue(ready.models.contains { $0.model == "fal-ai/birefnet/v2" && $0.capabilities == ["remove_background"] })

        let missing = await provider(key: nil).status()
        XCTAssertEqual(missing.status, "needs_setup")
        XCTAssertEqual(missing.keyStored, false)
        XCTAssertEqual(missing.setup, "Add your fal key in Assets → Providers.")
        XCTAssertTrue(missing.models.allSatisfy { !$0.available && $0.unavailableReason != nil })
    }

    // MARK: Errors

    func testMissingKeyExplainsWhereToAddIt() async {
        do {
            _ = try await provider(key: nil).generate(request(), progress: { _ in })
            XCTFail("expected failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("Assets → Providers"), error.localizedDescription)
        }
        XCTAssertTrue(StubURLProtocol.router.requests.isEmpty)
    }

    func testSubmitErrorsMapToActionableMessages() async {
        let cases: [(Int, [String: Any], String)] = [
            (401, ["detail": "Invalid credentials"], "rejected the key"),
            (403, ["detail": "User is locked. Reason: Exhausted balance."], "out of credit"),
            (422, ["detail": [["loc": ["body", "prompt"], "msg": "field required", "type": "value_error.missing"]]], "field required"),
            (404, ["detail": "Not Found"], "fal.ai/models"),
            (429, ["detail": "Too many requests"], "rate limiting"),
        ]
        for (status, body, expected) in cases {
            StubURLProtocol.router.handler = { _ in .json(body, status: status) }
            do {
                _ = try await provider().generate(request(), progress: { _ in })
                XCTFail("expected failure for \(status)")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains(expected), "\(status): \(error.localizedDescription)")
                XCTAssertFalse(error.localizedDescription.contains("test-key"))
            }
        }
    }

    func testFailedJobReportsFalsError() async {
        install(status: { _ in ["status": "COMPLETED", "error": "Content policy violation", "error_type": "content_policy_violation"] })
        do {
            _ = try await provider().generate(request(), progress: { _ in })
            XCTFail("expected failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("Content policy violation"), error.localizedDescription)
            XCTAssertTrue(error.localizedDescription.contains("content_policy_violation"))
        }
    }

    func testRefusesImagesOutsideFalHosts() async {
        install(result: resultFixture(host: "evil.example"))
        do {
            _ = try await provider().generate(request(), progress: { _ in })
            XCTFail("expected failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("outside fal's own hosts"), error.localizedDescription)
        }
        XCTAssertFalse(StubURLProtocol.router.requests.contains { $0.url.host == "evil.example" })
    }

    func testRefusesStatusUrlsOnOtherHostsSoTheKeyNeverLeaks() async {
        StubURLProtocol.router.handler = { r in
            r.method == "POST"
                ? .json(["request_id": "r", "status_url": "https://evil.example/s", "response_url": "https://evil.example/r"])
                : StubURLProtocol.Reply(status: 404)
        }
        do {
            _ = try await provider().generate(request(), progress: { _ in })
            XCTFail("expected failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("did not accept the job"), error.localizedDescription)
        }
        XCTAssertFalse(StubURLProtocol.router.requests.contains { $0.url.host == "evil.example" })
    }

    func testRefusesNonImageAndOversizedDownloads() async {
        install(png: Data("<html>not an image</html>".utf8))
        do {
            _ = try await provider().generate(request(), progress: { _ in })
            XCTFail("expected failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("not an image"), error.localizedDescription)
        }

        // Declared length over the cap, and an undeclared (chunked) stream that grows past it.
        for declared in [true, false] {
            let big = TestImages.png(width: 300, height: 300) + Data(repeating: 1, count: 300_000)
            install(png: big)
            let inner = StubURLProtocol.router.handler!
            StubURLProtocol.router.handler = { r in
                var reply = inner(r)
                if r.url.host?.hasSuffix("fal.media") == true {
                    reply.chunk = 8 * 1024
                    if !declared { reply.headers["X-Chunked"] = "1" }
                }
                return reply
            }
            do {
                _ = try await provider(maxDownload: 100_000).generate(request(), progress: { _ in })
                XCTFail("expected failure (declared: \(declared))")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("larger than"), "declared \(declared): \(error.localizedDescription)")
            }
        }
    }

    func testPollingToleratesTransientServerErrors() async throws {
        let polls = Counter()
        let submit = submitFixture
        let result = resultFixture()
        let png = TestImages.png()
        StubURLProtocol.router.handler = { r in
            if r.method == "POST" { return .json(submit) }
            if r.url.path.hasSuffix("/status") {
                return polls.next() < 2 ? StubURLProtocol.Reply(status: 502) : .json(["status": "COMPLETED"])
            }
            if r.url.host == "queue.fal.run" { return .json(result) }
            return StubURLProtocol.Reply(headers: [:], body: png)
        }
        let images = try await provider().generate(request(), progress: { _ in })
        XCTAssertEqual(images.count, 1)
    }

    // MARK: Cancel

    func testCancellingTheTaskAbortsPollingAndCancelsTheJobOnFal() async throws {
        let submit = submitFixture
        StubURLProtocol.router.handler = { r in
            if r.method == "POST" { return .json(submit) }
            if r.method == "PUT" { return .json(["status": "CANCELLATION_REQUESTED"], status: 202) }
            return .json(["status": "IN_PROGRESS", "logs": []])
        }
        let fal = provider()
        let imageRequest = request()
        let work = Task { try await fal.generate(imageRequest, progress: { _ in }) }
        try await waitUntil("polling to begin") { StubURLProtocol.router.requests.contains { $0.url.path.hasSuffix("/status") } }
        work.cancel()
        do {
            _ = try await work.value
            XCTFail("expected cancellation")
        } catch is CancellationError {
            // expected
        }
        try await waitUntil("the cancel request") { StubURLProtocol.router.requests.contains { $0.method == "PUT" } }
        let cancel = try XCTUnwrap(StubURLProtocol.router.requests.first { $0.method == "PUT" })
        XCTAssertEqual(cancel.url.absoluteString, "\(owner)/cancel")
        XCTAssertEqual(cancel.headers["Authorization"], "Key test-key")
    }

    func testKeychainRoundTripWithPrivateAccount() throws {
        let keychain = FalKeychain(service: "sh.caracal.ocelot.tests", account: "fal-\(UUID().uuidString)")
        defer { keychain.delete() }
        do { try keychain.write("secret-1") } catch { throw XCTSkip("Keychain not writable in this environment: \(error)") }
        XCTAssertEqual(keychain.read(), "secret-1")
        try keychain.write("secret-2")
        XCTAssertEqual(keychain.read(), "secret-2")
        keychain.delete()
        XCTAssertNil(keychain.read())
    }
}
