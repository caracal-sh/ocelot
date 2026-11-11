import XCTest
@testable import Ocelot

/// A provider whose behaviour the test scripts.
private final class FakeProvider: ImageProvider, @unchecked Sendable {
    let id: String
    let label = "Fake"
    let models: [ImageModelInfo]
    private let lock = NSLock()
    private var _requests: [ImageRequest] = []
    var behavior: @Sendable (ImageRequest, @escaping ImageProgressHandler) async throws -> [GeneratedImage]
    /// Runs inside `status()`: stands in for the slow provider checks that precede a generation.
    var beforeStatus: (@Sendable () async -> Void)?

    init(id: String = "fake", models: [ImageModelInfo], behavior: @escaping @Sendable (ImageRequest, @escaping ImageProgressHandler) async throws -> [GeneratedImage]) {
        self.id = id
        self.models = models
        self.behavior = behavior
    }

    var requests: [ImageRequest] { lock.lock(); defer { lock.unlock() }; return _requests }

    func status() async -> ImageProviderInfo {
        await beforeStatus?()
        return ImageProviderInfo(id: id, label: label, status: "ready", detail: "ok", models: models, keyStored: nil, setup: nil)
    }

    func warnings(for request: ImageRequest) -> [String] { request.quality == nil ? [] : ["quality ignored by Fake"] }

    func generate(_ request: ImageRequest, progress: @escaping ImageProgressHandler) async throws -> [GeneratedImage] {
        lock.withLock { _requests.append(request) }
        return try await behavior(request, progress)
    }
}

@MainActor
final class ImageServiceTests: XCTestCase {
    private var dir: URL!
    private var store: AssetStore!
    private var defaults: UserDefaults!
    private let suite = TestDefaults.name("image-service")

    override func setUpWithError() throws {
        dir = try makeTempDirectory()
        store = AssetStore(root: AssetRoot(dir.appendingPathComponent("Doc.ocelot")))
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
        TestDefaults.remove(suite)
    }

    private func model(_ name: String, _ capabilities: [String], maxN: Int? = 4, available: Bool = true) -> ImageModelInfo {
        ImageModelInfo(
            id: "fake:\(name)", provider: "fake", model: name, label: name, capabilities: capabilities, aspects: ImageAspects.all, maxN: maxN,
            cost: nil, note: nil, available: available, unavailableReason: available ? nil : "No key."
        )
    }

    private struct Harness {
        let service: ImageService
        let provider: FakeProvider
        let hub: ImageProviderHub
        let calls: Calls
    }

    final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [ImageProgressParams] = []
        private var changed = 0
        func add(_ p: ImageProgressParams) { lock.lock(); all.append(p); lock.unlock() }
        func addProvidersChanged() { lock.lock(); changed += 1; lock.unlock() }
        var progress: [ImageProgressParams] { lock.lock(); defer { lock.unlock() }; return all }
        var providersChanged: Int { lock.lock(); defer { lock.unlock() }; return changed }
    }

    private func harness(
        models: [ImageModelInfo]? = nil,
        document: @escaping () -> DocumentBinding? = { nil },
        behavior: @escaping @Sendable (ImageRequest, @escaping ImageProgressHandler) async throws -> [GeneratedImage] = { request, _ in
            (0..<request.n).map { GeneratedImage(data: TestImages.png(red: UInt8(10 + $0)), seed: 99) }
        }
    ) -> Harness {
        let provider = FakeProvider(models: models ?? [
            model("draw", ["generate", "seed", "references"]),
            model("editor", ["edit"]),
            model("plain", ["generate"]),
            model("cutout", ["remove_background"], maxN: 1),
            model("cropper", ["remove_background", "crop_to_subject"], maxN: 1),
            model("locked", ["generate"], available: false),
        ], behavior: behavior)
        let hub = ImageProviderHub(providers: [provider], defaults: defaults, cacheTTL: .seconds(30))
        let calls = Calls()
        let client = EditorClient(transport: { json in
            let request = try JSONDecoder().decode(BridgeRequestEnvelope.self, from: Data(json.utf8))
            if request.method == EditorMethods.ImageProgress.name, let params = request.params {
                calls.add(try BridgeCoding.decode(ImageProgressParams.self, from: params))
            }
            if request.method == EditorMethods.ImageProvidersChanged.name { calls.addProvidersChanged() }
            return BridgeCoding.string(BridgeResponseEnvelope(v: BridgeSchema.version, id: request.id, ok: true, result: .object([:]), error: nil))
        })
        let service = ImageService(store: store, hub: hub, editor: { client }, document: document)
        return Harness(service: service, provider: provider, hub: hub, calls: calls)
    }

    private func params(
        id: String = UUID().uuidString, op: String = "generate", model: String = "fake:draw", prompt: String = "a red fox", n: Int = 1,
        references: [String]? = nil, background: String = "auto", aspect: String? = nil, size: String? = nil, quality: String? = nil, seed: Int? = nil, mask: String? = nil, crop: Bool? = nil
    ) -> ImageGenerateParams {
        ImageGenerateParams(
            requestId: id, operation: op, model: model, prompt: prompt, aspect: aspect, size: size, n: n, background: background,
            quality: quality, seed: seed, references: references, mask: mask, cropToSubject: crop
        )
    }

    private func expectFailure<T>(_ code: BridgeErrorCode, contains text: String, _ operation: () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await operation()
            XCTFail("expected a failure containing \"\(text)\"", file: file, line: line)
        } catch let failure as BridgeFailure {
            XCTAssertEqual(failure.code, code, failure.message, file: file, line: line)
            XCTAssertTrue(failure.message.contains(text), "\"\(failure.message)\" should contain \"\(text)\"", file: file, line: line)
        } catch {
            XCTFail("unexpected error \(error)", file: file, line: line)
        }
    }

    // MARK: Happy path

    func testGenerateStoresAssetsWithFullMetadataAndReportsProgress() async throws {
        let h = harness(behavior: { request, progress in
            progress(ImageProgressUpdate(stage: "running", message: "drawing", fraction: 0.5))
            return (0..<request.n).map { var image = GeneratedImage(data: TestImages.png(width: 7, height: 5, red: UInt8(30 + $0)), seed: 123); image.revisedPrompt = "a red fox, detailed"; return image }
        })
        let result = try await h.service.generate(params(id: "req-1", n: 2, background: "opaque", aspect: "3:2", quality: "high", seed: 5))

        XCTAssertEqual(result.assets.count, 2)
        XCTAssertEqual(result.warnings, ["quality ignored by Fake"])
        let first = result.assets[0]
        XCTAssertEqual(first.kind, "generated")
        XCTAssertEqual(first.prompt, "a red fox")
        XCTAssertEqual(first.provider, "fake")
        XCTAssertEqual(first.model, "draw")
        XCTAssertEqual(first.seed, 123)
        XCTAssertEqual(first.width, 7)
        XCTAssertNil(first.sources)
        guard case .object(let p)? = first.params else { return XCTFail("params missing") }
        XCTAssertEqual(p["aspect"], .string("3:2"))
        XCTAssertEqual(p["size"], .string("7x5"))
        XCTAssertEqual(p["quality"], .string("high"))
        XCTAssertEqual(p["revisedPrompt"], .string("a red fox, detailed"))
        XCTAssertEqual(p["background"], .string("opaque"))
        let stored = try await store.list()
        XCTAssertEqual(stored.count, 2)

        let request = try XCTUnwrap(h.provider.requests.first)
        XCTAssertEqual(request.model, "draw", "providers get the provider-local id")
        XCTAssertEqual(request.seed, 5)

        // Progress reaches the editor with the request id; the final stage is "saving".
        try await waitUntil("progress events") { h.calls.progress.contains { $0.stage == "saving" } }
        let events = h.calls.progress
        XCTAssertTrue(events.allSatisfy { $0.requestId == "req-1" })
        XCTAssertTrue(events.contains { $0.stage == "running" && $0.message == "drawing" && $0.fraction == 0.5 })
    }

    func testEditRecordsSourcesAndKind() async throws {
        let source = try await store.importData(TestImages.png(red: 1), AssetMetadata(name: "src"))
        let h = harness()
        let result = try await h.service.generate(params(op: "edit", model: "fake:editor", prompt: "make it blue", references: [source.id]))
        XCTAssertEqual(result.assets.first?.kind, "edited")
        XCTAssertEqual(result.assets.first?.sources, [source.id])
        XCTAssertEqual(h.provider.requests.first?.references.first?.id, source.id)
        XCTAssertEqual(h.provider.requests.first?.references.first?.mime, "image/png")
    }

    func testRemoveBackgroundNeedsNoPromptAndMarksKind() async throws {
        let source = try await store.importData(TestImages.png(red: 3))
        let h = harness()
        let result = try await h.service.generate(params(op: "remove_background", model: "fake:cutout", prompt: "", references: [source.id]))
        XCTAssertEqual(result.assets.first?.kind, "background_removed")
        XCTAssertNil(result.assets.first?.prompt)
    }

    func testCapabilityWarningsForUnsupportedFields() async throws {
        let source = try await store.importData(TestImages.png(red: 8))
        let mask = try await store.importData(TestImages.png(red: 9))
        let h = harness()
        let result = try await h.service.generate(params(background: "transparent", seed: nil))
        XCTAssertTrue(result.warnings.contains { $0.contains("remove_background") }, "\(result.warnings)")
        let edited = try await h.service.generate(params(op: "edit", model: "fake:editor", references: [source.id], seed: 3, mask: mask.id))
        XCTAssertTrue(edited.warnings.contains { $0.contains("does not support masks") })
        XCTAssertTrue(edited.warnings.contains { $0.contains("has no seed") })
        XCTAssertNil(h.provider.requests.last?.seed)
    }

    func testIdenticalResultsDedupeAndShortReturnsWarn() async throws {
        let png = TestImages.png(red: 55)
        let h = harness(behavior: { _, _ in [GeneratedImage(data: png), GeneratedImage(data: png)] })
        let result = try await h.service.generate(params(n: 3))
        XCTAssertEqual(result.assets.count, 1)
        XCTAssertTrue(result.warnings.contains { $0.contains("returned 1 of the 3") } || result.warnings.contains { $0.contains("of the 3") }, "\(result.warnings)")
    }

    func testCropToSubjectIsRoutedOnlyToModelsThatCanCropAndRecordedInTheManifest() async throws {
        let source = try await store.importData(TestImages.png(red: 4))
        let h = harness()
        let cropped = try await h.service.generate(params(op: "remove_background", model: "fake:cropper", prompt: "", references: [source.id], crop: true))
        XCTAssertEqual(h.provider.requests.last?.cropToSubject, true)
        guard case .object(let p)? = cropped.assets.first?.params else { return XCTFail("params missing") }
        XCTAssertEqual(p["cropToSubject"], .bool(true))
        XCTAssertFalse(cropped.warnings.contains { $0.contains("cannot crop") })

        let plain = try await h.service.generate(params(op: "remove_background", model: "fake:cutout", prompt: "", references: [source.id], crop: true))
        XCTAssertEqual(h.provider.requests.last?.cropToSubject, false)
        XCTAssertTrue(plain.warnings.contains { $0.contains("cannot crop to the subject") }, "\(plain.warnings)")
        let notRequested = try await h.service.generate(params(op: "remove_background", model: "fake:cropper", prompt: "", references: [source.id]))
        XCTAssertEqual(h.provider.requests.last?.cropToSubject, false)
        XCTAssertNotNil(notRequested.assets.first)
    }

    func testProviderResultWarningsReachTheCaller() async throws {
        let h = harness(behavior: { _, _ in
            var image = GeneratedImage(data: TestImages.png(red: 31))
            image.warnings = ["no transparency came back"]
            return [image]
        })
        let result = try await h.service.generate(params())
        XCTAssertEqual(result.warnings, ["no transparency came back"])
    }

    // MARK: Apple Vision through the service

    func testVisionModelIsListedAndRoutedForBackgroundRemoval() async throws {
        let hub = ImageProviderHub(providers: [VisionImageProvider(), FakeProvider(models: [], behavior: { _, _ in [] })], defaults: defaults)
        let list = await hub.list()
        XCTAssertEqual(list.providers.first?.id, "vision")
        XCTAssertTrue(list.providers.flatMap(\.models).contains { $0.id == "vision:foreground-mask" })

        let source = try await store.importData(VisionImageProviderTests.subjectPhoto(), AssetMetadata(name: "photo"))
        let service = ImageService(store: store, hub: hub, editor: { nil })
        do {
            let result = try await service.generate(params(op: "remove_background", model: "vision:foreground-mask", prompt: "", references: [source.id], crop: false))
            let asset = try XCTUnwrap(result.assets.first)
            XCTAssertEqual(asset.kind, "background_removed")
            XCTAssertEqual(asset.provider, "vision")
            XCTAssertEqual(asset.model, "foreground-mask")
            XCTAssertEqual(asset.sources, [source.id])
            XCTAssertEqual(asset.ext, "png")
            guard case .object(let p)? = asset.params else { return XCTFail("params missing") }
            XCTAssertEqual(p["cropToSubject"], .bool(false))
            XCTAssertEqual(p["onDevice"], .bool(true))
            let stored = try await store.list()
            XCTAssertEqual(stored.first { $0.id == asset.id }?.sources, [source.id])
        } catch let failure as BridgeFailure where failure.message.contains("found no foreground subject") {
            throw XCTSkip("Vision does not see a subject in the synthetic drawing: \(failure.message)")
        }
    }

    func testVisionRefusesGenerateAndEditAtTheService() async throws {
        let hub = ImageProviderHub(providers: [VisionImageProvider()], defaults: defaults)
        let service = ImageService(store: store, hub: hub, editor: { nil })
        let source = try await store.importData(TestImages.png(red: 6))
        await expectFailure(.invalidParams, contains: "Apple Vision only removes backgrounds") {
            try await service.generate(params(model: "vision:foreground-mask"))
        }
        await expectFailure(.invalidParams, contains: "Apple Vision only removes backgrounds") {
            try await service.generate(params(op: "edit", model: "vision:foreground-mask", references: [source.id]))
        }
    }

    // MARK: Validation

    func testCapabilityErrorsSayWhatToPick() async throws {
        let h = harness()
        await expectFailure(.invalidParams, contains: "cannot edit images; pick one with the edit capability — list_image_models shows them") {
            try await h.service.generate(params(op: "edit", model: "fake:draw", references: [String(repeating: "a", count: 64)]))
        }
        await expectFailure(.invalidParams, contains: "cannot generate images") {
            try await h.service.generate(params(model: "fake:editor"))
        }
        await expectFailure(.invalidParams, contains: "cannot remove backgrounds") {
            try await h.service.generate(params(op: "remove_background", model: "fake:draw", references: [String(repeating: "a", count: 64)]))
        }
        XCTAssertTrue(h.provider.requests.isEmpty)
    }

    func testParameterValidation() async throws {
        let h = harness()
        let source = try await store.importData(TestImages.png(red: 2))
        await expectFailure(.invalidParams, contains: "between 1 and 4") { try await h.service.generate(params(n: 5)) }
        await expectFailure(.invalidParams, contains: "between 1 and 4") { try await h.service.generate(params(n: 0)) }
        await expectFailure(.invalidParams, contains: "Unknown operation") { try await h.service.generate(params(op: "paint")) }
        await expectFailure(.invalidParams, contains: "prompt is empty") { try await h.service.generate(params(prompt: "  ")) }
        await expectFailure(.invalidParams, contains: "needs the asset id") { try await h.service.generate(params(op: "edit", model: "fake:editor", references: [])) }
        await expectFailure(.invalidParams, contains: "needs the asset id") { try await h.service.generate(params(op: "remove_background", model: "fake:cutout", prompt: "", references: nil)) }
        await expectFailure(.invalidParams, contains: "list_assets") { try await h.service.generate(params(op: "edit", model: "fake:editor", references: [String(repeating: "0", count: 64)])) }
        await expectFailure(.invalidParams, contains: "size must look like") { try await h.service.generate(params(size: "big")) }
        await expectFailure(.invalidParams, contains: "aspect") { try await h.service.generate(params(aspect: "7:5")) }
        await expectFailure(.invalidParams, contains: "at most 1 images") { try await h.service.generate(params(op: "remove_background", model: "fake:cutout", prompt: "", n: 2, references: [source.id])) }
        await expectFailure(.invalidParams, contains: "not a model id") { try await h.service.generate(params(model: "nonsense")) }
        await expectFailure(.invalidParams, contains: "Unknown image provider") { try await h.service.generate(params(model: "zzz:model")) }
        await expectFailure(.invalidParams, contains: "has no model") { try await h.service.generate(params(model: "fake:missing")) }
        await expectFailure(.hostUnavailable, contains: "No key.") { try await h.service.generate(params(model: "fake:locked")) }
        // Generate with references needs the references capability.
        await expectFailure(.invalidParams, contains: "reference images") {
            try await h.service.generate(params(model: "fake:plain", references: [source.id]))
        }
        XCTAssertTrue(h.provider.requests.isEmpty)
    }

    func testSVGReferencesAreRefused() async throws {
        let svg = try await store.importData(TestImages.svg)
        let h = harness()
        await expectFailure(.invalidParams, contains: "SVG") { try await h.service.generate(params(op: "edit", model: "fake:editor", references: [svg.id])) }
    }

    // MARK: Cancellation and failures

    func testCancelByRequestIdStopsTheProviderAndReportsCancelled() async throws {
        let started = ProviderStarted()
        let h = harness(behavior: { _, _ in
            started.set()
            try await Task.sleep(for: .seconds(60))
            return []
        })
        let service = h.service
        let call = Task { @MainActor in try await service.generate(self.params(id: "slow")) }
        try await waitUntil("the provider to start") { started.value }
        h.service.cancel(requestId: "slow")
        do {
            _ = try await call.value
            XCTFail("expected cancellation")
        } catch let failure as BridgeFailure {
            XCTAssertEqual(failure.code, .cancelled)
        }
        // Unknown ids are ignored, and the id is free again afterwards.
        h.service.cancel(requestId: "nope")
        h.provider.behavior = { _, _ in [GeneratedImage(data: TestImages.png(red: 66))] }
        let again = try await h.service.generate(params(id: "slow"))
        XCTAssertEqual(again.assets.count, 1)
    }

    func testDuplicateRequestIdsAreRefusedWhileRunning() async throws {
        let started = ProviderStarted()
        let h = harness(behavior: { _, _ in
            started.set()
            try await Task.sleep(for: .seconds(60))
            return []
        })
        let service = h.service
        let first = Task { @MainActor in try await service.generate(self.params(id: "dup")) }
        try await waitUntil("the provider to start") { started.value }
        await expectFailure(.invalidParams, contains: "already running") { try await h.service.generate(params(id: "dup")) }
        h.service.cancel(requestId: "dup")
        _ = try? await first.value
    }

    func testProviderFailureKeepsItsActionableMessage() async throws {
        let h = harness(behavior: { _, _ in throw ImageFailure("fal rejected the key. Update it in Assets → Providers.") })
        await expectFailure(.internal, contains: "Update it in Assets → Providers.") { try await h.service.generate(params()) }
    }

    func testPartialResultsAreKeptAndReportedAsWarning() async throws {
        let h = harness(behavior: { _, _ in
            throw ImagePartialResult(images: [GeneratedImage(data: TestImages.png(red: 77))], underlying: ImageFailure("usage limit reached"))
        })
        let result = try await h.service.generate(params(n: 2))
        XCTAssertEqual(result.assets.count, 1)
        XCTAssertTrue(result.warnings.contains { $0.contains("Only 1 of 2") && $0.contains("usage limit reached") }, "\(result.warnings)")
    }

    func testCancelledAfterPartialResultKeepsTheFinishedImages() async throws {
        let h = harness(behavior: { _, _ in
            throw ImagePartialResult(images: [GeneratedImage(data: TestImages.png(red: 78))], underlying: CancellationError())
        })
        do {
            _ = try await h.service.generate(params(n: 2))
            XCTFail("expected cancellation")
        } catch let failure as BridgeFailure {
            XCTAssertEqual(failure.code, .cancelled)
            XCTAssertTrue(failure.message.contains("kept in the asset library"))
        }
        let kept = try await store.list()
        XCTAssertEqual(kept.count, 1)
    }

    func testCancelBeforeTheProviderChecksFinishStopsTheRequest() async throws {
        let h = harness()
        h.provider.beforeStatus = { try? await Task.sleep(for: .milliseconds(400)) } // "Starting…" in the UI
        let service = h.service
        let call = Task { @MainActor in try await service.generate(self.params(id: "early")) }
        try await Task.sleep(for: .milliseconds(60))
        service.cancel(requestId: "early") // arrives before the request reached the provider
        do {
            _ = try await call.value
            XCTFail("expected cancellation")
        } catch let failure as BridgeFailure {
            XCTAssertEqual(failure.code, .cancelled)
        }
        XCTAssertTrue(h.provider.requests.isEmpty, "a cancelled request must never reach (and bill) the provider")
        h.provider.beforeStatus = nil
        _ = try await service.generate(params(id: "early")) // the id is free again
    }

    func testDuplicateIdsAreRefusedWhileTheFirstIsStillValidating() async throws {
        let h = harness()
        h.provider.beforeStatus = { try? await Task.sleep(for: .milliseconds(300)) }
        let service = h.service
        let first = Task { @MainActor in try await service.generate(self.params(id: "dup2")) }
        try await Task.sleep(for: .milliseconds(50))
        await expectFailure(.invalidParams, contains: "already running") { try await service.generate(params(id: "dup2")) }
        _ = try await first.value
    }

    // MARK: Documents

    private final class Binding: @unchecked Sendable {
        private let lock = NSLock()
        private var _value: DocumentBinding
        init(_ value: DocumentBinding) { _value = value }
        var value: DocumentBinding { get { lock.withLock { _value } } set { lock.withLock { _value = newValue } } }
    }

    private func savedPackage(_ name: String) throws -> URL {
        let url = dir.appendingPathComponent("\(name).ocelot")
        try DocumentPackage.write(DocumentFile(format: "ocelot", version: 2, name: name, savedAt: "2026-11-09T00:00:00Z", yjs: "AAAA", tree: .object([:])), to: url)
        return url
    }

    func testResultsOfAJobGoToTheDocumentItWasStartedFor() async throws {
        let origin = try savedPackage("A")
        let current = Binding(DocumentBinding(epoch: UUID(), package: origin))
        let openNow = dir.appendingPathComponent("Doc.ocelot")
        let h = harness(document: { current.value }, behavior: { _, _ in
            // The window opens another document while the provider is working.
            current.value = DocumentBinding(epoch: UUID(), package: openNow)
            return [GeneratedImage(data: TestImages.png(red: 91))]
        })
        let result = try await h.service.generate(params())
        XCTAssertEqual(result.assets.count, 1)
        let inOrigin = try await AssetStore(root: AssetRoot(origin)).list()
        XCTAssertEqual(inOrigin.map(\.id), result.assets.map(\.id), "the image lands in the document that asked for it")
        let inCurrent = try await store.list()
        XCTAssertTrue(inCurrent.isEmpty, "never in the document that is open now")
    }

    func testResultsAreDroppedWhenTheirDocumentIsGone() async throws {
        let gone = dir.appendingPathComponent("Gone.ocelot") // never saved: no document to hold the image
        let current = Binding(DocumentBinding(epoch: UUID(), package: gone))
        let openNow = dir.appendingPathComponent("Doc.ocelot")
        let h = harness(document: { current.value }, behavior: { _, _ in
            current.value = DocumentBinding(epoch: UUID(), package: openNow)
            return [GeneratedImage(data: TestImages.png(red: 92))]
        })
        await expectFailure(.cancelled, contains: "document changed") { try await h.service.generate(params()) }
        let inCurrent = try await store.list()
        XCTAssertTrue(inCurrent.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: gone.path))
    }

    func testCancelAllStopsEveryRunningJob() async throws {
        let started = ProviderStarted()
        let h = harness(behavior: { _, _ in
            started.set()
            try await Task.sleep(for: .seconds(60))
            return []
        })
        let service = h.service
        let call = Task { @MainActor in try await service.generate(self.params(id: "doc-switch")) }
        try await waitUntil("the provider to start") { started.value }
        service.cancelAll()
        do {
            _ = try await call.value
            XCTFail("expected cancellation")
        } catch let failure as BridgeFailure {
            XCTAssertEqual(failure.code, .cancelled)
        }
    }

    // MARK: Hub

    func testProvidersAreCachedForAWhileAndInvalidatedByKeyChanges() async throws {
        let counting = CountingProvider()
        let hub = ImageProviderHub(providers: [counting], defaults: defaults, cacheTTL: .seconds(30))
        _ = await hub.list()
        _ = await hub.list()
        XCTAssertEqual(counting.calls, 1)
        _ = await hub.list(force: true)
        XCTAssertEqual(counting.calls, 2)
        hub.invalidate()
        _ = await hub.list()
        XCTAssertEqual(counting.calls, 3)
    }

    func testDefaultModelPersistsAndIsValidated() async throws {
        let h = harness()
        var list = try await h.hub.setDefault("fake:draw")
        XCTAssertEqual(list.defaultModel, "fake:draw")
        XCTAssertEqual(defaults.string(forKey: ImageProviderHub.defaultModelKey), "fake:draw")
        let reloaded = ImageProviderHub(providers: [h.provider], defaults: defaults)
        XCTAssertEqual(reloaded.defaultModel, "fake:draw")
        list = try await h.hub.setDefault(nil)
        XCTAssertNil(list.defaultModel)
        await expectFailure(.invalidParams, contains: "not a model id") { try await h.hub.setDefault("bogus") }
        await expectFailure(.invalidParams, contains: "not a model id") { try await h.hub.setDefault("zzz:x") }
    }

    func testSetKeyOnlyAcceptsFalAndNeverEchoesTheKey() async throws {
        let account = "fal-\(UUID().uuidString)"
        let keychain = FalKeychain(service: "sh.caracal.ocelot.tests", account: account)
        defer { keychain.delete() }
        let fal = FalImageProvider(keyProvider: { keychain.read() }, session: StubURLProtocol.session())
        let hub = ImageProviderHub(providers: [fal], defaults: defaults, falKeychain: keychain)

        await expectFailure(.invalidParams, contains: "Only the fal provider") { try await hub.setKey(provider: "omp", key: "x") }
        await expectFailure(.invalidParams, contains: "key is empty") { try await hub.setKey(provider: "fal", key: "   ") }

        let before = await hub.list()
        XCTAssertEqual(before.providers.first?.keyStored, false)
        do {
            let after = try await hub.setKey(provider: "fal", key: "  fal-secret-key  ")
            XCTAssertEqual(after.providers.first?.keyStored, true)
            let encoded = String(decoding: try JSONEncoder().encode(after), as: UTF8.self)
            XCTAssertFalse(encoded.contains("fal-secret-key"))
            XCTAssertEqual(keychain.read(), "fal-secret-key")
            let removed = try await hub.setKey(provider: "fal", key: nil)
            XCTAssertEqual(removed.providers.first?.keyStored, false)
        } catch let failure as BridgeFailure where failure.message.contains("Keychain") {
            throw XCTSkip("Keychain not writable in this environment: \(failure.message)")
        }
    }

    // MARK: Rejected credentials and change notifications

    private func rejectionHarness(id: String = "fake", models: [ImageModelInfo]? = nil) -> Harness {
        let h = harness(models: models, behavior: { _, _ in
            throw ImageFailure("fake rejected the credential. Run `fake login` in a terminal, then try again.", credentialRejected: true)
        })
        return h
    }

    func testRejectedCredentialMarksTheProviderUnavailableUntilAForcedRefresh() async throws {
        let h = rejectionHarness()
        var notified = 0
        let observation = h.hub.addObserver { notified += 1 }

        await expectFailure(.internal, contains: "rejected the credential") { try await h.service.generate(params()) }
        XCTAssertEqual(notified, 1)

        let marked = await h.hub.list()
        let provider = try XCTUnwrap(marked.providers.first)
        XCTAssertEqual(provider.status, "needs_setup")
        XCTAssertTrue(provider.detail.contains("fake login"), provider.detail)
        XCTAssertFalse(provider.models.isEmpty)
        XCTAssertTrue(provider.models.allSatisfy { !$0.available && $0.unavailableReason?.contains("fake login") == true })

        // The next request fails fast, without reaching the provider again.
        let before = h.provider.requests.count
        await expectFailure(.hostUnavailable, contains: "is not available") { try await h.service.generate(params()) }
        XCTAssertEqual(h.provider.requests.count, before)

        let refreshed = await h.hub.list(force: true)
        XCTAssertEqual(refreshed.providers.first?.status, "ready")
        XCTAssertTrue(refreshed.providers.first?.models.filter { $0.id != "fake:locked" }.allSatisfy(\.available) == true)
        XCTAssertEqual(notified, 2, "clearing the rejection tells the observers too")
        withExtendedLifetime(observation) {}
    }

    func testInvalidateClearsARejectedCredential() async throws {
        let h = rejectionHarness()
        await expectFailure(.internal, contains: "rejected the credential") { try await h.service.generate(params()) }
        let marked = await h.hub.list()
        XCTAssertEqual(marked.providers.first?.status, "needs_setup")
        h.hub.invalidate()
        let cleared = await h.hub.list()
        XCTAssertEqual(cleared.providers.first?.status, "ready")
    }

    func testFailuresThatAreNotCredentialRejectionsDoNotMarkTheProvider() async throws {
        let h = harness(behavior: { _, _ in throw ImageFailure("fake is rate limiting you.") })
        await expectFailure(.internal, contains: "rate limiting") { try await h.service.generate(params()) }
        let list = await h.hub.list()
        XCTAssertEqual(list.providers.first?.status, "ready")
        XCTAssertTrue(list.providers.first?.models.first { $0.id == "fake:draw" }?.available == true)
    }

    func testRejectedCredentialInAPartialResultStillMarksTheProvider() async throws {
        let h = harness(behavior: { _, _ in
            throw ImagePartialResult(
                images: [GeneratedImage(data: TestImages.png(red: 31))],
                underlying: ImageFailure("fake rejected the credential. Run `fake login`.", credentialRejected: true)
            )
        })
        let result = try await h.service.generate(params(n: 2))
        XCTAssertEqual(result.assets.count, 1)
        let list = await h.hub.list()
        XCTAssertEqual(list.providers.first?.status, "needs_setup")
    }

    func testOmpRejectionIsScopedToTheRejectingVendor() async throws {
        func omp(_ selector: String) -> ImageModelInfo {
            ImageModelInfo(
                id: "omp:\(selector)", provider: "omp", model: selector, label: selector, capabilities: ["generate"], aspects: nil, maxN: 4,
                cost: nil, note: nil, available: true, unavailableReason: nil
            )
        }
        let provider = FakeProvider(id: "omp", models: [omp("openrouter/a"), omp("openrouter/b/c"), omp("openai/d")], behavior: { _, _ in [] })
        let hub = ImageProviderHub(providers: [provider], defaults: defaults)
        XCTAssertEqual(ImageProviderHub.rejectionScope(provider: "omp", modelId: "omp:openrouter/b/c"), "omp:openrouter/")
        XCTAssertEqual(ImageProviderHub.rejectionScope(provider: "omp", modelId: "omp:loose"), "omp")
        XCTAssertEqual(ImageProviderHub.rejectionScope(provider: "fal", modelId: "fal:fal-ai/flux/dev"), "fal")

        hub.markRejected(provider: "omp", reason: "openrouter rejected the credential. Run `omp login openrouter`.", modelId: "omp:openrouter/a")
        let listed = await hub.list()
        let info = try XCTUnwrap(listed.providers.first)
        XCTAssertEqual(info.status, "ready", "the other vendors still work")
        XCTAssertEqual(info.models.map(\.available), [false, false, true])
        XCTAssertEqual(info.models.first?.unavailableReason, "openrouter rejected the credential. Run `omp login openrouter`.")
    }

    func testHubNotifiesObserversOfEveryChangeAndForgetsReleasedOnes() async throws {
        let h = harness()
        var count = 0
        var observation: ImageProviderObservation? = h.hub.addObserver { count += 1 }
        _ = try await h.hub.setDefault("fake:draw")
        XCTAssertEqual(count, 1)
        _ = try await h.hub.setDefault(nil)
        XCTAssertEqual(count, 2)
        h.hub.invalidate()
        XCTAssertEqual(count, 3)
        h.hub.markRejected(provider: "fake", reason: "x")
        XCTAssertEqual(count, 4)
        h.hub.markRejected(provider: "fake", reason: "x")
        XCTAssertEqual(count, 4, "an unchanged rejection is not a change")

        observation?.cancel()
        h.hub.notifyChanged()
        XCTAssertEqual(count, 4)

        var other = 0
        observation = h.hub.addObserver { other += 1 }
        observation = nil
        h.hub.notifyChanged()
        XCTAssertEqual(other, 0, "a released observation is not called")
    }

    func testHubChangesTellTheEditorToRefreshItsProviders() async throws {
        let h = harness()
        _ = try await h.hub.setDefault("fake:plain")
        try await waitUntil("editor told about the default change") { h.calls.providersChanged >= 1 }
        h.hub.markRejected(provider: "fake", reason: "rejected")
        try await waitUntil("editor told about the rejection") { h.calls.providersChanged >= 2 }
    }

    final class ProviderStarted: @unchecked Sendable {
        private let lock = NSLock()
        private var flag = false
        func set() { lock.lock(); flag = true; lock.unlock() }
        var value: Bool { lock.lock(); defer { lock.unlock() }; return flag }
    }

    private final class CountingProvider: ImageProvider, @unchecked Sendable {
        let id = "count"
        let label = "Count"
        private let lock = NSLock()
        private var n = 0
        var calls: Int { lock.lock(); defer { lock.unlock() }; return n }
        func status() async -> ImageProviderInfo {
            lock.withLock { n += 1 }
            return ImageProviderInfo(id: id, label: label, status: "ready", detail: "", models: [], keyStored: nil, setup: nil)
        }
        func generate(_ request: ImageRequest, progress: @escaping ImageProgressHandler) async throws -> [GeneratedImage] { [] }
    }
}
