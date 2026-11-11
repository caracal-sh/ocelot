import Foundation

/// A subscription to `ImageProviderHub` changes. The hub holds it weakly: keep it alive for as long as the
/// handler should run (a window's image service owns one), or call `cancel()` to stop early.
@MainActor
final class ImageProviderObservation {
    fileprivate var handler: (@MainActor () -> Void)?
    init(_ handler: @escaping @MainActor () -> Void) { self.handler = handler }
    func cancel() { handler = nil }
}

/// The providers, their (cached) status and the persisted default model. Shared by every window.
@MainActor
final class ImageProviderHub {
    static let shared = ImageProviderHub(
        providers: [VisionImageProvider(), OmpImageProvider.live(), CodexImageProvider(), FalImageProvider()]
    )

    static let defaultModelKey = "ocelot.image.defaultModel"

    let providers: [any ImageProvider]
    let falKeychain: FalKeychain
    private let defaults: UserDefaults
    private let ttl: Duration
    private var cached: (infos: [ImageProviderInfo], at: ContinuousClock.Instant)?
    private var loading: Task<[ImageProviderInfo], Never>?
    private var generation = 0
    /// Providers whose credential was refused during a generation, with the reason. Cleared by a forced refresh.
    private var rejected: [String: String] = [:]
    private var observers: [WeakObservation] = []

    private struct WeakObservation {
        weak var observation: ImageProviderObservation?
    }

    init(providers: [any ImageProvider], defaults: UserDefaults = .standard, falKeychain: FalKeychain = .standard, cacheTTL: Duration = .seconds(30)) {
        self.providers = providers
        self.defaults = defaults
        self.falKeychain = falKeychain
        self.ttl = cacheTTL
    }

    func provider(_ id: String) -> (any ImageProvider)? { providers.first { $0.id == id } }

    var defaultModel: String? {
        get { defaults.string(forKey: Self.defaultModelKey) }
        set {
            if let newValue { defaults.set(newValue, forKey: Self.defaultModelKey) } else { defaults.removeObject(forKey: Self.defaultModelKey) }
        }
    }

    /// Runs `handler` (on the main actor) whenever provider status, keys or the default model change, from any
    /// window or the Settings window. The caller must retain the returned observation.
    func addObserver(_ handler: @escaping @MainActor () -> Void) -> ImageProviderObservation {
        let observation = ImageProviderObservation(handler)
        observers.removeAll { $0.observation?.handler == nil }
        observers.append(WeakObservation(observation: observation))
        return observation
    }

    func notifyChanged() {
        observers.removeAll { $0.observation?.handler == nil }
        for handler in observers.compactMap({ $0.observation?.handler }) { handler() }
    }

    /// A provider refused its credential while generating (see `ImageFailure.credentialRejected`): until the next
    /// forced refresh or `invalidate()`, report its models as unavailable with `reason`. omp routes to several
    /// vendors with their own logins, so for omp only the rejecting vendor's models (`omp:<vendor>/…`, taken from
    /// `modelId`) are marked; every other provider is marked as a whole.
    func markRejected(provider: String, reason: String, modelId: String? = nil) {
        guard self.provider(provider) != nil else { return }
        let scope = Self.rejectionScope(provider: provider, modelId: modelId)
        guard rejected[scope] != reason else { return }
        rejected[scope] = reason
        notifyChanged()
    }

    /// The provider id, or `omp:<vendor>/` for an omp model id such as `omp:openrouter/google/gemini-image`.
    static func rejectionScope(provider: String, modelId: String?) -> String {
        guard provider == "omp", let modelId, modelId.hasPrefix("omp:") else { return provider }
        let selector = modelId.dropFirst(4)
        guard let slash = selector.firstIndex(of: "/"), slash != selector.startIndex else { return provider }
        return "omp:\(selector[..<slash])/"
    }

    /// Provider status and catalogs; reused for ~30 s unless `force` (which also forgets rejected credentials).
    func infos(force: Bool = false) async -> [ImageProviderInfo] {
        let cleared = force && !rejected.isEmpty
        if force { rejected = [:] }
        let infos = await loadInfos(force: force)
        if cleared { notifyChanged() }
        return applyingRejections(infos)
    }

    private func applyingRejections(_ infos: [ImageProviderInfo]) -> [ImageProviderInfo] {
        guard !rejected.isEmpty else { return infos }
        return infos.map { info in
            var info = info
            let wholeProvider = rejected[info.id]
            if let wholeProvider {
                if info.status == "ready" { info.status = "needs_setup" }
                info.detail = wholeProvider
            }
            info.models = info.models.map { model in
                guard let reason = wholeProvider ?? rejected.first(where: { $0.key.hasSuffix("/") && model.id.hasPrefix($0.key) })?.value else { return model }
                var model = model
                model.available = false
                model.unavailableReason = reason
                return model
            }
            return info
        }
    }

    private func loadInfos(force: Bool) async -> [ImageProviderInfo] {
        if !force, let cached, ContinuousClock.now - cached.at < ttl { return cached.infos }
        if !force, let loading { return await loading.value }
        generation += 1
        let mine = generation
        let providers = providers
        let task = Task { () -> [ImageProviderInfo] in
            await withTaskGroup(of: (Int, ImageProviderInfo).self) { group in
                for (index, provider) in providers.enumerated() {
                    group.addTask { (index, await provider.status()) }
                }
                var results: [(Int, ImageProviderInfo)] = []
                for await result in group { results.append(result) }
                return results.sorted { $0.0 < $1.0 }.map(\.1)
            }
        }
        loading = task
        let infos = await task.value
        // A newer forced refresh may have started while this one ran: keep the newest answer.
        if mine == generation {
            cached = (infos, ContinuousClock.now)
            loading = nil
        }
        return infos
    }

    func list(force: Bool = false) async -> ImageProviderList {
        ImageProviderList(providers: await infos(force: force), defaultModel: defaultModel)
    }

    /// Drops the cached statuses and rejected credentials; the next `infos()` asks every provider again.
    func invalidate() {
        reset()
        notifyChanged()
    }

    private func reset() {
        cached = nil
        loading = nil
        rejected = [:]
        generation += 1
    }

    /// `host.imageSetKey`: Keychain write/delete, then a fresh provider list. The key is never returned.
    func setKey(provider: String, key: String?) async throws -> ImageProviderList {
        guard provider == "fal" else {
            throw BridgeFailure(.invalidParams, "Only the fal provider takes a key. omp uses your `omp login`, Codex uses `codex login`.")
        }
        if let key {
            let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                throw BridgeFailure(.invalidParams, "The fal key is empty. Paste the key from fal.ai/dashboard/keys, or omit `key` to remove the stored one.")
            }
            do { try falKeychain.write(trimmed) } catch { throw BridgeFailure(.internal, error.localizedDescription) }
        } else {
            falKeychain.delete()
        }
        reset()
        let list = await list(force: true)
        notifyChanged()
        return list
    }

    /// `host.imageSetDefault`
    func setDefault(_ model: String?) async throws -> ImageProviderList {
        if let model {
            let provider = model.split(separator: ":", maxSplits: 1).first.map(String.init) ?? ""
            guard model.contains(":"), self.provider(provider) != nil else {
                throw BridgeFailure(.invalidParams, "\"\(model)\" is not a model id. Use <provider>:<model> as listed by list_image_models (providers: \(providers.map(\.id).joined(separator: ", "))).")
            }
        }
        defaultModel = model
        notifyChanged()
        return await list()
    }
}

/// One window's image generation: validates a request against the model catalog, runs the provider, stores the
/// results as assets and reports progress to the editor. Tracks in-flight requests so they can be cancelled.
@MainActor
final class ImageService {
    static let maxReferences = 8

    private let store: AssetStore
    private let hub: ImageProviderHub
    private let editor: () -> EditorClient?
    /// Which document (and package) this window shows now; a job remembers it from the moment it is requested.
    private let document: () -> DocumentBinding?
    private var inflight: [String: Task<ImageGenerateResult, any Error>] = [:]
    /// Tells this window's editor to refresh its provider list when the hub changes (Settings, another window, a
    /// rejected credential). Released with the service, i.e. with the window.
    private var providerObservation: ImageProviderObservation?

    init(store: AssetStore, hub: ImageProviderHub = .shared, editor: @escaping () -> EditorClient?, document: @escaping () -> DocumentBinding? = { nil }) {
        self.store = store
        self.hub = hub
        self.editor = editor
        self.document = document
        providerObservation = hub.addObserver { [weak self] in self?.notifyEditorProvidersChanged() }
    }

    /// The editor answers by calling `host.imageProviders` (which does not notify), so this cannot loop.
    private func notifyEditorProvidersChanged() {
        guard let client = editor() else { return }
        Task { _ = try? await client.call(EditorMethods.ImageProvidersChanged.self, Empty()) }
    }

    func providers() async -> ImageProviderList { await hub.list() }

    /// Aborts a running generation (kills the subprocess, aborts fetches, cancels the fal job). Unknown ids are ignored.
    func cancel(requestId: String) {
        inflight[requestId]?.cancel()
    }

    /// The window's document was replaced: nothing started for the old one should keep running (and being billed).
    func cancelAll() {
        for task in inflight.values { task.cancel() }
    }

    func generate(_ params: ImageGenerateParams) async throws -> ImageGenerateResult {
        let requestId = params.requestId
        guard inflight[requestId] == nil else {
            throw BridgeFailure(.invalidParams, "A generation with requestId \"\(requestId)\" is already running. Use a fresh requestId per call.")
        }
        // Registered before the first suspension: the UI offers Cancel while the request is still being validated
        // (provider status checks can take seconds), and that Cancel must reach it.
        let origin = document()
        let task = Task { () throws -> ImageGenerateResult in
            do {
                var plan = try await self.prepare(params)
                plan.origin = origin
                try Task.checkCancellation()
                return try await self.execute(plan)
            } catch is CancellationError {
                throw BridgeFailure(.cancelled, "Generation cancelled.")
            }
        }
        inflight[requestId] = task
        defer { inflight[requestId] = nil }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    // MARK: Validation

    struct Plan: Sendable {
        var params: ImageGenerateParams
        var provider: any ImageProvider
        var model: ImageModelInfo
        var request: ImageRequest
        var warnings: [String]
        /// The document the request was made for.
        var origin: DocumentBinding?
    }

    func prepare(_ params: ImageGenerateParams) async throws -> Plan {
        guard let operation = ImageOperation(rawValue: params.operation) else {
            throw BridgeFailure(.invalidParams, "Unknown operation \"\(params.operation)\". Use generate, edit or remove_background.")
        }
        guard (1...4).contains(params.n) else {
            throw BridgeFailure(.invalidParams, "n must be between 1 and 4 (got \(params.n)). Call again for more images.")
        }
        let prompt = params.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if prompt.isEmpty, operation != .removeBackground {
            throw BridgeFailure(.invalidParams, "The prompt is empty. Describe the image to \(operation == .edit ? "make from the reference" : "generate").")
        }
        guard ["auto", "transparent", "opaque"].contains(params.background) else {
            throw BridgeFailure(.invalidParams, "background must be auto, transparent or opaque (got \"\(params.background)\").")
        }
        if let quality = params.quality, !["low", "medium", "high"].contains(quality) {
            throw BridgeFailure(.invalidParams, "quality must be low, medium or high (got \"\(quality)\").")
        }
        if let aspect = params.aspect, !ImageAspects.all.contains(aspect) {
            throw BridgeFailure(.invalidParams, "aspect \"\(aspect)\" is not supported. Use one of \(ImageAspects.all.joined(separator: ", ")).")
        }
        let size = try Self.parseSize(params.size)

        // Model and capabilities.
        let (provider, info, providerInfo) = try await resolve(params.model)
        guard info.available else {
            let setup = providerInfo?.setup.map { " \($0)" } ?? ""
            throw BridgeFailure(.hostUnavailable, "\(info.id) is not available: \(info.unavailableReason ?? providerInfo?.detail ?? "the provider is not ready").\(setup)")
        }
        guard info.capabilities.contains(operation.capability) else {
            let hint = provider.rejectionHint(for: operation).map { " (\($0))" } ?? ""
            throw BridgeFailure(.invalidParams, "Model \(info.id) cannot \(operation.verb)\(hint); pick one with the \(operation.capability) capability — list_image_models shows them.")
        }
        if let maxN = info.maxN, params.n > maxN {
            throw BridgeFailure(.invalidParams, "Model \(info.id) returns at most \(maxN) images per call (n was \(params.n)).")
        }
        if let aspect = params.aspect, let aspects = info.aspects, !aspects.contains(aspect) {
            throw BridgeFailure(.invalidParams, "Model \(info.id) does not support aspect \(aspect). Use one of \(aspects.joined(separator: ", ")).")
        }

        // References and mask.
        let referenceIds = params.references ?? []
        if operation != .generate, referenceIds.isEmpty {
            throw BridgeFailure(.invalidParams, "Operation \(operation.rawValue) needs the asset id of the source image in `references` (list_assets shows ids).")
        }
        if !referenceIds.isEmpty, operation == .generate, !info.capabilities.contains("references") {
            throw BridgeFailure(.invalidParams, "Model \(info.id) cannot use reference images for generate. Use the edit operation with an edit-capable model, or pick a model with the references capability — list_image_models shows them.")
        }
        guard referenceIds.count <= Self.maxReferences else {
            throw BridgeFailure(.invalidParams, "At most \(Self.maxReferences) reference images are allowed (got \(referenceIds.count)).")
        }
        var references: [ImageReference] = []
        for id in referenceIds {
            let (record, data) = try await store.read(id)
            guard record.ext != "svg" else {
                throw BridgeFailure(.invalidParams, "Asset \(id) is an SVG and cannot be a reference image. Use a PNG, JPEG or WebP asset.")
            }
            references.append(ImageReference(id: id, data: data, ext: record.ext, mime: record.mime))
        }
        if let mask = params.mask { _ = try await store.record(mask) }

        // Notes about request fields this model cannot honour.
        var warnings: [String] = []
        if params.mask != nil, !info.capabilities.contains("mask") {
            warnings.append("\(info.id) does not support masks; the mask was ignored and the whole image may change.")
        }
        if params.background == "transparent", !info.capabilities.contains("transparent"), operation != .removeBackground {
            warnings.append("\(info.id) cannot produce real transparency; the result has an opaque background. Run remove_background on it (fal:fal-ai/birefnet/v2) to cut it out.")
        }
        if params.seed != nil, !info.capabilities.contains("seed") {
            warnings.append("\(info.id) has no seed; it was ignored.")
        }
        if params.cropToSubject == true, !info.capabilities.contains("crop_to_subject") {
            warnings.append("\(info.id) cannot crop to the subject; cropToSubject was ignored.")
        }
        var request = ImageRequest(
            operation: operation, model: info.model, prompt: prompt, aspect: params.aspect, size: size, n: params.n,
            background: params.background, quality: params.quality,
            seed: info.capabilities.contains("seed") ? params.seed : nil, references: references
        )
        request.cropToSubject = params.cropToSubject == true && info.capabilities.contains("crop_to_subject")
        warnings += provider.warnings(for: request)
        return Plan(params: params, provider: provider, model: info, request: request, warnings: warnings)
    }

    private func resolve(_ modelId: String) async throws -> (any ImageProvider, ImageModelInfo, ImageProviderInfo?) {
        let parts = modelId.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, !parts[1].isEmpty else {
            throw BridgeFailure(.invalidParams, "\"\(modelId)\" is not a model id. Use <provider>:<model>, for example codex:chatgpt-image or fal:fal-ai/flux/dev; list_image_models shows what is available.")
        }
        guard let provider = hub.provider(parts[0]) else {
            throw BridgeFailure(.invalidParams, "Unknown image provider \"\(parts[0])\". Providers: \(hub.providers.map(\.id).joined(separator: ", ")); list_image_models shows their models.")
        }
        let infos = await hub.infos()
        let providerInfo = infos.first { $0.id == provider.id }
        if let model = providerInfo?.models.first(where: { $0.id == modelId }) { return (provider, model, providerInfo) }
        if let custom = provider.customModel(parts[1]) { return (provider, custom, providerInfo) }
        let known = (providerInfo?.models.prefix(6).map(\.id).joined(separator: ", ")).map { $0.isEmpty ? "" : " Examples: \($0)." } ?? ""
        throw BridgeFailure(.invalidParams, "\(provider.label) has no model \"\(parts[1])\".\(known) list_image_models shows the full catalog.")
    }

    static func parseSize(_ raw: String?) throws -> (width: Int, height: Int)? {
        guard let raw else { return nil }
        let parts = raw.lowercased().split(separator: "x").compactMap { Int($0) }
        guard parts.count == 2, (16...8192).contains(parts[0]), (16...8192).contains(parts[1]) else {
            throw BridgeFailure(.invalidParams, "size must look like \"1024x768\" with each side between 16 and 8192 (got \"\(raw)\").")
        }
        return (parts[0], parts[1])
    }

    // MARK: Execution

    private func execute(_ plan: Plan) async throws -> ImageGenerateResult {
        let started = ContinuousClock.now
        let requestId = plan.params.requestId
        let (events, sink) = AsyncStream<ImageProgressUpdate>.makeStream()
        let editor = editor
        Task { @MainActor in
            for await update in events {
                guard let client = editor() else { continue }
                _ = try? await client.call(
                    EditorMethods.ImageProgress.self,
                    ImageProgressParams(requestId: requestId, stage: update.stage, message: update.message, fraction: update.fraction)
                )
            }
        }
        defer { sink.finish() }

        var warnings = plan.warnings
        var images: [GeneratedImage] = []
        var interruption: (any Error)?
        do {
            images = try await plan.provider.generate(plan.request) { sink.yield($0) }
        } catch let partial as ImagePartialResult {
            images = partial.images
            interruption = partial.underlying
            noteRejectedCredential(partial.underlying, plan: plan)
        } catch {
            noteRejectedCredential(error, plan: plan)
            throw Self.bridgeError(error, model: plan.model.id)
        }

        sink.yield(ImageProgressUpdate(stage: "saving", message: "Saving to the asset library…", fraction: nil))
        let records = try await save(Array(images.prefix(plan.params.n)), plan: plan, into: try destination(for: plan, hasImages: !images.isEmpty))
        for note in images.flatMap(\.warnings) where !warnings.contains(note) { warnings.append(note) }

        if let interruption {
            if interruption is CancellationError || Task.isCancelled {
                let kept = records.isEmpty ? "" : " \(records.count) finished image\(records.count == 1 ? " was" : "s were") kept in the asset library."
                throw BridgeFailure(.cancelled, "Generation cancelled.\(kept)")
            }
            let reason = Self.bridgeError(interruption, model: plan.model.id).message
            warnings.append("Only \(records.count) of \(plan.params.n) images finished: \(reason)")
        } else if records.count < plan.params.n, plan.request.operation != .removeBackground {
            warnings.append("\(plan.model.id) returned \(records.count) of the \(plan.params.n) requested images.")
        }
        if Task.isCancelled {
            throw BridgeFailure(.cancelled, "Generation cancelled. \(records.count) finished image\(records.count == 1 ? " was" : "s were") kept in the asset library.")
        }
        let elapsed = ContinuousClock.now - started
        let ms = Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000)
        return ImageGenerateResult(assets: records, warnings: warnings, elapsedMs: ms)
    }

    /// The library the results belong to: this window's, unless its document was replaced while the job ran. Then
    /// they go to the package the job was started for (still on disk), never into the document that is open now.
    private func destination(for plan: Plan, hasImages: Bool) throws -> AssetStore {
        guard let origin = plan.origin, let now = document(), origin.epoch != now.epoch else { return store }
        guard DocumentPackage.hasDocument(at: origin.package) else {
            if !hasImages { return store }
            throw BridgeFailure(.cancelled, "The document changed while this image was generating, so it was not added to the new one.")
        }
        return AssetStore(root: AssetRoot(origin.package))
    }

    private func save(_ images: [GeneratedImage], plan: Plan, into store: AssetStore) async throws -> [AssetRecord] {
        var records: [AssetRecord] = []
        let request = plan.request
        for image in images {
            var params: [String: JSONValue] = image.params
            params["operation"] = .string(request.operation.rawValue)
            params["background"] = .string(request.background)
            if let aspect = request.aspect { params["aspect"] = .string(aspect) }
            if request.cropToSubject { params["cropToSubject"] = .bool(true) }
            if let quality = request.quality { params["quality"] = .string(quality) }
            if let revised = image.revisedPrompt { params["revisedPrompt"] = .string(revised) }
            if let kind = ImageSniffer.sniff(image.data), let size = ImageSniffer.pixelSize(of: image.data, kind: kind) {
                params["size"] = .string("\(size.width)x\(size.height)")
            }
            if let requested = request.size { params["requestedSize"] = .string("\(requested.width)x\(requested.height)") }
            let prompt = request.prompt
            var meta = AssetMetadata(
                name: prompt.isEmpty ? nil : String(prompt.prefix(60)), kind: request.operation.assetKind, prompt: prompt.isEmpty ? nil : prompt,
                provider: plan.provider.id, model: request.model, seed: image.seed ?? request.seed,
                sources: request.references.map(\.id), params: .object(params)
            )
            if request.operation == .removeBackground, prompt.isEmpty { meta.name = nil }
            do {
                let record = try await store.importData(image.data, meta)
                if !records.contains(where: { $0.id == record.id }) { records.append(record) }
            } catch {
                throw BridgeFailure(.internal, "The image was generated but could not be saved: \(error.localizedDescription)")
            }
        }
        return records
    }

    /// A provider that refused its credential stays unavailable (in every window's list) until a forced refresh,
    /// so the next request fails fast with the sign-in step instead of billing another doomed attempt.
    private func noteRejectedCredential(_ error: any Error, plan: Plan) {
        guard let failure = error as? ImageFailure, failure.credentialRejected else { return }
        hub.markRejected(provider: plan.provider.id, reason: failure.message, modelId: plan.model.id)
    }

    /// Provider failures already carry a next step; keep them, mapping only the code.
    static func bridgeError(_ error: any Error, model: String) -> BridgeFailure {
        if let failure = error as? BridgeFailure { return failure }
        if error is CancellationError { return BridgeFailure(.cancelled, "Generation cancelled.") }
        if let failure = error as? ImageFailure { return BridgeFailure(.internal, failure.message) }
        return BridgeFailure(.internal, "\(model) failed: \(error.localizedDescription). Try again, or pick another model (list_image_models).")
    }
}
