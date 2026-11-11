import XCTest
@testable import Ocelot

/// A provider with a scripted status; its models are all available unless `available` says otherwise.
private final class StubProvider: ImageProvider, @unchecked Sendable {
    let id: String
    let label: String
    private let lock = NSLock()
    private var _info: ImageProviderInfo

    init(id: String, label: String, status: String = "ready", models: [(name: String, available: Bool)]) {
        self.id = id
        self.label = label
        _info = ImageProviderInfo(
            id: id, label: label, status: status, detail: status == "ready" ? "ok" : "Not ready.",
            models: models.map {
                ImageModelInfo(
                    id: "\(id):\($0.name)", provider: id, model: $0.name, label: $0.name, capabilities: ["generate", "edit", "transparent"],
                    aspects: nil, maxN: 4, cost: nil, note: nil, available: $0.available, unavailableReason: $0.available ? nil : "\(label) is not set up."
                )
            },
            keyStored: nil, setup: nil
        )
    }

    var info: ImageProviderInfo {
        get { lock.withLock { _info } }
        set { lock.withLock { _info = newValue } }
    }

    func status() async -> ImageProviderInfo { info }
    func generate(_ request: ImageRequest, progress: @escaping ImageProgressHandler) async throws -> [GeneratedImage] { [] }
}

@MainActor
final class ImageSettingsModelTests: XCTestCase {
    private let suite = TestDefaults.name("image-settings")
    private var defaults: UserDefaults!
    private var ready: StubProvider!
    private var locked: StubProvider!
    private var hub: ImageProviderHub!

    override func setUp() async throws {
        defaults = UserDefaults(suiteName: suite)
        ready = StubProvider(id: "omp", label: "omp", models: [("a", true), ("b", true)])
        locked = StubProvider(id: "fal", label: "fal.ai", status: "needs_setup", models: [("flux", false)])
        hub = ImageProviderHub(providers: [ready, locked], defaults: defaults, cacheTTL: .seconds(30))
    }

    override func tearDown() async throws {
        TestDefaults.remove(suite)
    }

    private func loadedModel() async -> ImageSettingsModel {
        let model = ImageSettingsModel(hub: hub)
        await model.reload()
        return model
    }

    func testLoadsProvidersAndTheStoredDefault() async throws {
        defaults.set("omp:b", forKey: ImageProviderHub.defaultModelKey)
        let model = ImageSettingsModel(hub: hub)
        XCTAssertEqual(model.defaultModel, "omp:b", "known before the first load")
        await model.reload()
        XCTAssertEqual(model.providers.map(\.id), ["omp", "fal"])
        XCTAssertEqual(model.modelGroups.map(\.label), ["omp", "fal.ai"])
        XCTAssertEqual(model.selectionTag, "omp:b")
        XCTAssertNil(model.customDefault)
    }

    func testSelectingAModelPersistsThroughTheSharedKey() async throws {
        let model = await loadedModel()
        XCTAssertEqual(model.selectionTag, ImageSettingsModel.automaticTag)

        await model.select("omp:a")
        XCTAssertEqual(defaults.string(forKey: ImageProviderHub.defaultModelKey), "omp:a")
        XCTAssertEqual(hub.defaultModel, "omp:a")
        XCTAssertEqual(model.defaultModel, "omp:a")

        await model.select(ImageSettingsModel.automaticTag)
        XCTAssertNil(defaults.string(forKey: ImageProviderHub.defaultModelKey))
        XCTAssertNil(model.defaultModel)
    }

    func testUnavailableModelsAreNotSelectable() async throws {
        let model = await loadedModel()
        XCTAssertTrue(model.isSelectable(nil))
        XCTAssertTrue(model.isSelectable("omp:a"))
        XCTAssertFalse(model.isSelectable("fal:flux"))
        XCTAssertFalse(model.isSelectable("nope:nothing"))

        await model.select("omp:a")
        await model.select("fal:flux")
        XCTAssertEqual(model.defaultModel, "omp:a", "the refused choice leaves the default alone")
        XCTAssertEqual(defaults.string(forKey: ImageProviderHub.defaultModelKey), "omp:a")
        XCTAssertEqual(model.message, "fal:flux is not available: fal.ai is not set up.")
    }

    func testAChangeMadeThroughTheHubRefreshesTheModel() async throws {
        let model = await loadedModel()
        XCTAssertNil(model.defaultModel)

        // The editor's Assets > Providers dialog goes through the same hub.
        _ = try await hub.setDefault("omp:b")
        await model.pendingReload?.value
        XCTAssertEqual(model.defaultModel, "omp:b")

        // A provider turning ready elsewhere shows up after the hub is told.
        var info = locked.info
        info.status = "ready"
        info.models = info.models.map { var m = $0; m.available = true; m.unavailableReason = nil; return m }
        locked.info = info
        hub.invalidate()
        await model.pendingReload?.value
        XCTAssertEqual(model.providers.last?.status, "ready")
        XCTAssertTrue(model.isSelectable("fal:flux"))
    }

    func testARejectedCredentialShowsUpAndRefreshClearsIt() async throws {
        let model = await loadedModel()
        hub.markRejected(provider: "omp", reason: "omp rejected the credential. Run `omp login omp`.")
        await model.pendingReload?.value
        XCTAssertEqual(model.providers.first?.status, "needs_setup")
        XCTAssertFalse(model.isSelectable("omp:a"))

        await model.refresh()
        XCTAssertEqual(model.providers.first?.status, "ready")
        XCTAssertTrue(model.isSelectable("omp:a"))
        XCTAssertFalse(model.isRefreshing)
    }

    func testRefreshAsksEveryProviderAgain() async throws {
        let model = await loadedModel()
        var info = locked.info
        info.detail = "Changed outside the app."
        locked.info = info

        await model.reload()
        XCTAssertNotEqual(model.providers.last?.detail, "Changed outside the app.", "the cache is reused within its TTL")
        await model.refresh()
        XCTAssertEqual(model.providers.last?.detail, "Changed outside the app.")
    }

    func testADefaultOutsideTheCatalogStaysVisible() async throws {
        defaults.set("fal:fal-ai/custom", forKey: ImageProviderHub.defaultModelKey)
        let model = await loadedModel()
        XCTAssertEqual(model.customDefault, "fal:fal-ai/custom")
        XCTAssertEqual(model.selectionTag, "fal:fal-ai/custom")
    }

    func testFalKeyGoesThroughTheHub() async throws {
        let keychain = FalKeychain(service: "sh.caracal.ocelot.tests.settings", account: "fal-\(UUID().uuidString)")
        let hub = ImageProviderHub(providers: [FalImageProvider(keyProvider: { keychain.read() })], defaults: defaults, falKeychain: keychain)
        let model = ImageSettingsModel(hub: hub)
        await model.reload()
        XCTAssertEqual(model.providers.first?.keyStored, false)

        let stored = await model.setFalKey("  fal-secret  ")
        guard stored else {
            throw XCTSkip("Keychain not writable in this environment: \(model.message ?? "")")
        }
        defer { keychain.delete() }
        XCTAssertEqual(keychain.read(), "fal-secret")
        XCTAssertEqual(model.providers.first?.keyStored, true)
        XCTAssertNil(model.message)

        let removed = await model.setFalKey(nil)
        XCTAssertTrue(removed)
        XCTAssertNil(keychain.read())
        XCTAssertEqual(model.providers.first?.keyStored, false)

        let empty = await model.setFalKey("   ")
        XCTAssertFalse(empty)
        XCTAssertTrue(model.message?.contains("empty") == true, model.message ?? "")
    }

    func testCapabilityHint() {
        let image = ImageModelInfo(
            id: "x:y", provider: "x", model: "y", label: "y", capabilities: ["seed", "edit", "generate", "transparent"],
            aspects: nil, maxN: nil, cost: nil, note: nil, available: true, unavailableReason: nil
        )
        XCTAssertEqual(ImageSettingsModel.capabilityHint(image), "text, edit, transparent")
    }
}
