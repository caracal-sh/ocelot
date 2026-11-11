import Foundation
import Security

/// The fal.ai key in the macOS Keychain (generic password). Never logged, never sent to the editor.
struct FalKeychain: Sendable {
    static let service = "sh.caracal.ocelot.image-providers"
    static let account = "fal"
    static let standard = FalKeychain(service: service, account: account)

    let service: String
    let account: String

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    func read() -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        let key = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return key.isEmpty ? nil : key
    }

    func write(_ key: String) throws {
        let data = Data(key.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrLabel as String] = "Ocelot fal.ai key"
            let added = SecItemAdd(add as CFDictionary, nil)
            if added == errSecSuccess { return }
            throw ImageFailure("macOS refused to store the fal key in the Keychain (error \(added)). Unlock the login keychain in Keychain Access and try again.")
        }
        throw ImageFailure("macOS refused to update the fal key in the Keychain (error \(status)). Unlock the login keychain in Keychain Access and try again.")
    }

    func delete() {
        SecItemDelete(query as CFDictionary)
    }
}

/// How a fal endpoint is called.
struct FalEndpoint: Sendable, Equatable {
    enum Kind: Sendable, Equatable {
        /// `{ prompt, image_size, num_images?, seed? }`
        case textToImage
        /// `{ prompt, image_url, aspect_ratio?, num_images?, seed? }`
        case instructionEdit
        /// `{ image_url }`
        case removeBackground
        /// A user-typed endpoint id: input shape follows the requested operation.
        case freeText
    }

    var id: String
    var label: String
    var capabilities: [String]
    var kind: Kind
    var supportsNumImages = true
    var supportsSeed = true
    var cost: String?
    var note: String?

    static let curated: [FalEndpoint] = [
        FalEndpoint(
            id: "fal-ai/flux/schnell", label: "FLUX.1 schnell", capabilities: ["generate", "seed"], kind: .textToImage,
            cost: "About $0.003 per megapixel", note: "Fast and cheap: good for drafts and exploration."
        ),
        FalEndpoint(
            id: "fal-ai/flux/dev", label: "FLUX.1 dev", capabilities: ["generate", "seed"], kind: .textToImage,
            cost: "About $0.025 per megapixel", note: "Balanced quality and speed."
        ),
        FalEndpoint(
            id: "fal-ai/flux-pro/v1.1", label: "FLUX 1.1 pro", capabilities: ["generate", "seed"], kind: .textToImage,
            cost: "About $0.04 per megapixel", note: "Best photorealism."
        ),
        FalEndpoint(
            id: "fal-ai/recraft/v3/text-to-image", label: "Recraft V3", capabilities: ["generate", "vector"], kind: .textToImage,
            supportsNumImages: false, supportsSeed: false, cost: "About $0.04 per image",
            note: "Icons, illustration and vector style: put \"vector\" or \"illustration\" in the prompt to select that style."
        ),
        FalEndpoint(
            id: "fal-ai/ideogram/v3", label: "Ideogram V3", capabilities: ["generate", "text", "seed"], kind: .textToImage,
            cost: "About $0.06 per image", note: "Best at typography and text inside images."
        ),
        FalEndpoint(
            id: "fal-ai/flux-pro/kontext", label: "FLUX Kontext pro", capabilities: ["edit", "seed"], kind: .instructionEdit,
            cost: "About $0.04 per image", note: "Edits one reference image from an instruction; uses the first reference only."
        ),
        FalEndpoint(
            id: "fal-ai/bria/background/remove", label: "Bria RMBG 2.0", capabilities: ["remove_background"], kind: .removeBackground,
            supportsNumImages: false, supportsSeed: false, cost: nil, note: "Clean edges, commercially licensed."
        ),
        FalEndpoint(
            id: "fal-ai/birefnet/v2", label: "BiRefNet v2 (remove background)", capabilities: ["remove_background"], kind: .removeBackground,
            supportsNumImages: false, supportsSeed: false, cost: "Fractions of a cent", note: "Returns the reference image cut out on a transparent background."
        ),
    ]

    /// A catalog entry, or a free-text endpoint (`fal:<endpoint-id>`) that may do any operation.
    static func resolve(_ model: String) -> FalEndpoint? {
        if let known = curated.first(where: { $0.id == model }) { return known }
        guard isValidEndpointId(model) else { return nil }
        return FalEndpoint(
            id: model, label: model, capabilities: ["generate", "edit", "remove_background"], kind: .freeText,
            note: "Custom endpoint: called with prompt, image_size, num_images, seed and image_url."
        )
    }

    static func isValidEndpointId(_ id: String) -> Bool {
        guard !id.contains(".."), id.count <= 120 else { return false }
        return id.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9._-]+)+$"#, options: .regularExpression) != nil
    }
}

/// fal.ai queue API: submit, poll, fetch, download. Free text and curated endpoints.
struct FalImageProvider: ImageProvider {
    let id = "fal"
    let label = "fal.ai"

    static let queueBase = URL(string: "https://queue.fal.run")!
    static let allowedHostSuffixes = ["fal.media", "fal.run", "fal.ai"]
    static let maxDownloadBytes = 50 * 1024 * 1024

    let keyProvider: @Sendable () -> String?
    let session: URLSession
    let pollInterval: Duration
    let maxDownload: Int
    /// Give up waiting for one job after this long.
    let jobTimeout: Duration

    init(
        keyProvider: @escaping @Sendable () -> String? = { FalKeychain.standard.read() },
        session: URLSession = FalImageProvider.defaultSession,
        pollInterval: Duration = .seconds(1),
        maxDownload: Int = FalImageProvider.maxDownloadBytes,
        jobTimeout: Duration = .seconds(600)
    ) {
        self.keyProvider = keyProvider
        self.session = session
        self.pollInterval = pollInterval
        self.maxDownload = maxDownload
        self.jobTimeout = jobTimeout
    }

    static let defaultSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 900
        return URLSession(configuration: config)
    }()

    // MARK: Status

    func status() async -> ImageProviderInfo {
        let stored = keyProvider() != nil
        let models = FalEndpoint.curated.map { endpoint in
            ImageModelInfo(
                id: "fal:\(endpoint.id)", provider: "fal", model: endpoint.id, label: endpoint.label,
                capabilities: endpoint.capabilities, aspects: endpoint.kind == .removeBackground ? nil : ImageAspects.all,
                maxN: 4, cost: endpoint.cost, note: endpoint.note,
                available: stored, unavailableReason: stored ? nil : "No fal key stored."
            )
        }
        if stored {
            return ImageProviderInfo(
                id: id, label: label, status: "ready",
                detail: "fal key stored. Curated models below; any other fal endpoint works as fal:<endpoint-id>.",
                models: models, keyStored: true, setup: nil
            )
        }
        return ImageProviderInfo(
            id: id, label: label, status: "needs_setup", detail: "No fal.ai key is stored.",
            models: models, keyStored: false, setup: "Add your fal key in Assets → Providers."
        )
    }

    func customModel(_ model: String) -> ImageModelInfo? {
        guard let endpoint = FalEndpoint.resolve(model), endpoint.kind == .freeText else { return nil }
        let stored = keyProvider() != nil
        return ImageModelInfo(
            id: "fal:\(model)", provider: "fal", model: model, label: model, capabilities: endpoint.capabilities,
            aspects: ImageAspects.all, maxN: 4, cost: nil, note: endpoint.note,
            available: stored, unavailableReason: stored ? nil : "No fal key stored."
        )
    }

    func warnings(for request: ImageRequest) -> [String] {
        var notes: [String] = []
        let endpoint = FalEndpoint.resolve(request.model)
        if request.quality != nil { notes.append("fal endpoints have no quality setting; it was ignored.") }
        if Self.removesBackground(request, endpoint), request.n > 1 { notes.append("Background removal returns one image; n was ignored.") }
        if endpoint?.kind == .instructionEdit, request.references.count > 1 { notes.append("\(request.model) edits one image; only the first reference was used.") }
        if endpoint?.kind == .instructionEdit, request.size != nil { notes.append("\(request.model) takes an aspect ratio, not exact pixels; the size was ignored.") }
        if endpoint?.kind == .textToImage, !(endpoint?.supportsSeed ?? true), request.seed != nil { notes.append("\(request.model) has no seed; it was ignored.") }
        return notes
    }

    // MARK: Generate

    func generate(_ request: ImageRequest, progress: @escaping ImageProgressHandler) async throws -> [GeneratedImage] {
        guard let key = keyProvider(), !key.isEmpty else {
            throw ImageFailure("No fal.ai key is stored. Add your fal key in Assets → Providers, then try again.")
        }
        guard let endpoint = FalEndpoint.resolve(request.model) else {
            throw ImageFailure("\"\(request.model)\" is not a fal endpoint id. Use one from list_image_models, or a fal endpoint like fal:fal-ai/flux/dev.")
        }
        guard endpoint.capabilities.contains(request.operation.capability) else {
            throw ImageFailure("\(endpoint.id) cannot \(request.operation.verb). Pick a fal model with the \(request.operation.capability) capability (list_image_models).")
        }
        // Background removal yields one image whatever `n` says; endpoints without num_images run once per image.
        let runs = Self.removesBackground(request, endpoint) ? 1 : (endpoint.supportsNumImages ? 1 : request.n)
        var images: [GeneratedImage] = []
        for index in 0..<runs {
            do {
                try Task.checkCancellation()
                let prefix = runs > 1 ? "Image \(index + 1) of \(runs): " : ""
                images += try await runOnce(request, endpoint: endpoint, key: key, perRun: endpoint.supportsNumImages ? request.n : 1, prefix: prefix, progress: progress)
            } catch {
                if images.isEmpty { throw error }
                throw ImagePartialResult(images: images, underlying: error)
            }
        }
        return images
    }

    static func removesBackground(_ request: ImageRequest, _ endpoint: FalEndpoint?) -> Bool {
        endpoint?.kind == .removeBackground || request.operation == .removeBackground
    }

    /// The JSON body for one job.
    static func input(for request: ImageRequest, endpoint: FalEndpoint, count: Int) -> [String: Any] {
        var body: [String: Any] = [:]
        let imageURL = request.references.first?.dataURL
        switch endpoint.kind {
        case .removeBackground:
            body["image_url"] = imageURL
            return body
        case .freeText where request.operation == .removeBackground:
            body["image_url"] = imageURL
            return body
        case .instructionEdit:
            body["prompt"] = request.prompt
            body["image_url"] = imageURL
            if let aspect = request.aspect, ["21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"].contains(aspect) { body["aspect_ratio"] = aspect }
        case .textToImage, .freeText:
            body["prompt"] = request.prompt
            if endpoint.id == "fal-ai/recraft/v3/text-to-image", let style = recraftStyle(for: request.prompt) { body["style"] = style }
            if let size = imageSize(request) { body["image_size"] = size }
            if request.operation == .edit || (endpoint.kind == .freeText && !request.references.isEmpty) { body["image_url"] = imageURL }
        }
        if endpoint.supportsNumImages, endpoint.kind != .freeText || count > 1 { body["num_images"] = count }
        if endpoint.supportsSeed, let seed = request.seed { body["seed"] = seed }
        return body
    }

    static func recraftStyle(for prompt: String) -> String? {
        let p = prompt.lowercased()
        if p.contains("vector") || p.contains("svg") { return "vector_illustration" }
        if p.contains("illustration") || p.contains("icon") || p.contains("logo") { return "digital_illustration" }
        return nil
    }

    /// fal `image_size`: a preset name for the common aspects, else exact pixels.
    static func imageSize(_ request: ImageRequest) -> Any? {
        func clamp(_ v: Int) -> Int { min(4096, max(64, v)) }
        if let size = request.size { return ["width": clamp(size.width), "height": clamp(size.height)] }
        guard let aspect = request.aspect else { return nil }
        let presets = ["1:1": "square_hd", "16:9": "landscape_16_9", "4:3": "landscape_4_3", "9:16": "portrait_16_9", "3:4": "portrait_4_3"]
        if let preset = presets[aspect] { return preset }
        guard let px = ImageAspects.pixels(aspect: aspect, longSide: 1536) else { return nil }
        return ["width": px.width, "height": px.height]
    }

    private struct Job {
        var statusURL: URL
        var responseURL: URL
        var cancelURL: URL?
    }

    private func runOnce(
        _ request: ImageRequest, endpoint: FalEndpoint, key: String, perRun: Int, prefix: String, progress: @escaping ImageProgressHandler
    ) async throws -> [GeneratedImage] {
        let body = Self.input(for: request, endpoint: endpoint, count: perRun)
        guard let submitURL = URL(string: endpoint.id, relativeTo: Self.queueBase)?.absoluteURL else {
            throw ImageFailure("\"\(endpoint.id)\" is not a valid fal endpoint id.")
        }
        progress(ImageProgressUpdate(stage: "queued", message: "\(prefix)Submitting to fal…", fraction: nil))
        let submitted = try await send(method: "POST", url: submitURL, key: key, body: body, endpoint: endpoint.id)
        guard let object = submitted as? [String: Any],
              let statusString = object["status_url"] as? String, let statusURL = Self.falURL(statusString),
              let responseString = object["response_url"] as? String, let responseURL = Self.falURL(responseString)
        else { throw ImageFailure("fal did not accept the job for \(endpoint.id) (no status URL came back). Try again, or check the endpoint id at fal.ai/models.") }
        let cancelURL = (object["cancel_url"] as? String).flatMap(Self.falURL)
        let job = Job(statusURL: statusURL, responseURL: responseURL, cancelURL: cancelURL)

        return try await withTaskCancellationHandler {
            try await wait(for: job, key: key, endpoint: endpoint.id, prefix: prefix, progress: progress)
            let result = try await send(method: "GET", url: job.responseURL, key: key, body: nil, endpoint: endpoint.id)
            guard let result = result as? [String: Any] else {
                throw ImageFailure("fal returned an unreadable result for \(endpoint.id). Try again.")
            }
            progress(ImageProgressUpdate(stage: "downloading", message: "\(prefix)Downloading from fal…", fraction: nil))
            return try await download(result, endpoint: endpoint.id)
        } onCancel: {
            guard let cancelURL = job.cancelURL else { return }
            let session = session
            Task.detached {
                var cancel = URLRequest(url: cancelURL, timeoutInterval: 15)
                cancel.httpMethod = "PUT"
                cancel.setValue("Key \(key)", forHTTPHeaderField: "Authorization")
                _ = try? await session.data(for: cancel)
            }
        }
    }

    /// Polls until the job completes; throws when fal reports a failure.
    private func wait(for job: Job, key: String, endpoint: String, prefix: String, progress: @escaping ImageProgressHandler) async throws {
        var components = URLComponents(url: job.statusURL, resolvingAgainstBaseURL: false)
        let existing = components?.queryItems ?? []
        components?.queryItems = existing + [URLQueryItem(name: "logs", value: "1")]
        guard let pollURL = components?.url else { throw ImageFailure("fal returned a bad status URL. Try again.") }
        let started = ContinuousClock.now
        var failures = 0
        while true {
            try Task.checkCancellation()
            do {
                let status = try await send(method: "GET", url: pollURL, key: key, body: nil, endpoint: endpoint, polling: true) as? [String: Any]
                failures = 0
                switch status?["status"] as? String {
                case "COMPLETED":
                    if let error = status?["error"] {
                        let type = status?["error_type"] as? String
                        throw ImageFailure("fal could not run \(endpoint): \(Self.describe(error))\(type.map { " (\($0))" } ?? ""). Adjust the prompt or inputs, or pick another model (list_image_models).")
                    }
                    return
                case "IN_QUEUE":
                    let position = (status?["queue_position"] as? NSNumber)?.intValue
                    progress(ImageProgressUpdate(stage: "queued", message: "\(prefix)Waiting in fal's queue\(position.map { " (position \($0))" } ?? "")…", fraction: nil))
                default:
                    progress(ImageProgressUpdate(stage: "running", message: "\(prefix)fal is generating…", fraction: nil))
                }
            } catch let failure as ImageFailure {
                throw failure
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                failures += 1
                if failures >= 3 { throw ImageFailure("Lost contact with fal while waiting (\(error.localizedDescription)). Check your connection and try again.") }
            }
            if ContinuousClock.now - started > jobTimeout {
                throw ImageFailure("fal did not finish within \(jobTimeout.components.seconds / 60) minutes. Try again, or pick a faster model such as fal:fal-ai/flux/schnell.")
            }
            try await Task.sleep(for: pollInterval)
        }
    }

    // MARK: HTTP

    /// A URL fal returned, only if it is https on a fal host (the key is sent along with it).
    static func falURL(_ string: String) -> URL? {
        guard let url = URL(string: string), url.scheme == "https", isFalHost(url.host) else { return nil }
        return url
    }

    static func isFalHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return allowedHostSuffixes.contains { host == $0 || host.hasSuffix(".\($0)") }
    }

    /// JSON request to the queue API. Throws `ImageFailure` with a next step for non-2xx answers.
    private func send(method: String, url: URL, key: String, body: [String: Any]?, endpoint: String, polling: Bool = false) async throws -> Any {
        guard Self.isFalHost(url.host) else { throw ImageFailure("Refusing to send the fal key to \(url.host ?? "an unknown host").") }
        var http = URLRequest(url: url, timeoutInterval: 60)
        http.httpMethod = method
        http.setValue("Key \(key)", forHTTPHeaderField: "Authorization")
        http.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            http.setValue("application/json", forHTTPHeaderField: "Content-Type")
            http.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: http)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            if polling { throw error }
            throw ImageFailure("Could not reach fal (\(error.localizedDescription)). Check your connection and try again.")
        }
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw ImageFailure("fal sent an invalid response. Try again.") }
        guard (200..<300).contains(status) else {
            // Transient server trouble while polling is retried by the caller.
            if polling, (500...599).contains(status) { throw URLError(.badServerResponse) }
            throw ImageFailure(Self.failureMessage(status: status, body: data, endpoint: endpoint), credentialRejected: Self.rejectsCredential(status: status))
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) else {
            throw ImageFailure("fal returned something that is not JSON. Try again.")
        }
        return json
    }

    /// fal refuses the key itself (a 403 is a permission or credit problem for one endpoint, not a bad key).
    static func rejectsCredential(status: Int) -> Bool { status == 401 }

    static func failureMessage(status: Int, body: Data, endpoint: String) -> String {
        let detail = (try? JSONSerialization.jsonObject(with: body)).map { describe($0) } ?? ""
        let suffix = detail.isEmpty ? "" : " (\(detail))"
        let lower = detail.lowercased()
        switch status {
        case _ where rejectsCredential(status: status):
            return "fal rejected the key\(suffix). Update it in Assets → Providers."
        case 402:
            return "fal says the account is out of credit\(suffix). Top up at fal.ai/dashboard/billing, or pick another provider."
        case 403:
            if lower.contains("balance") || lower.contains("credit") || lower.contains("exhausted") {
                return "fal says the account is out of credit\(suffix). Top up at fal.ai/dashboard/billing, or pick another provider."
            }
            return "fal refused access\(suffix). Check the key in Assets → Providers has permission for \(endpoint)."
        case 404:
            return "fal does not know \(endpoint)\(suffix). Check the endpoint id at fal.ai/models, or pick a model from list_image_models."
        case 422:
            return "fal rejected the inputs for \(endpoint)\(suffix). Adjust the prompt, size or reference images, or pick another model."
        case 429:
            return "fal is rate limiting this key\(suffix). Wait a minute and retry."
        case 500...599:
            return "fal had a server error (\(status))\(suffix). Try again shortly."
        default:
            return "fal answered \(status)\(suffix). Try again, or check the endpoint id \(endpoint)."
        }
    }

    /// Flattens fal's error shapes (`detail` string/array, `error`, `message`) to one short sentence.
    static func describe(_ value: Any) -> String {
        func clip(_ s: String) -> String {
            let flat = s.replacingOccurrences(of: "\n", with: " ")
            return flat.count > 220 ? String(flat.prefix(220)) + "…" : flat
        }
        if let s = value as? String { return clip(s) }
        if let object = value as? [String: Any] {
            for key in ["detail", "error", "message", "msg"] {
                if let inner = object[key] { let text = describe(inner); if !text.isEmpty { return text } }
            }
            return ""
        }
        if let array = value as? [Any] {
            return clip(array.map { describe($0) }.filter { !$0.isEmpty }.joined(separator: "; "))
        }
        return ""
    }

    // MARK: Download

    /// `images[].url` / `image.url` -> verified image bytes.
    private func download(_ result: [String: Any], endpoint: String) async throws -> [GeneratedImage] {
        var entries: [[String: Any]] = []
        if let images = result["images"] as? [[String: Any]] { entries += images }
        if let image = result["image"] as? [String: Any] { entries.append(image) }
        let seed = (result["seed"] as? NSNumber)?.intValue
        guard !entries.isEmpty else {
            throw ImageFailure("\(endpoint) returned no images (the response had no images or image field). Try again, or pick another model.")
        }
        var out: [GeneratedImage] = []
        for entry in entries {
            guard let urlString = entry["url"] as? String else { continue }
            let data = try await fetch(urlString)
            guard ImageSniffer.sniff(data) != nil else {
                throw ImageFailure("What fal returned from \(endpoint) is not an image file. Try again.")
            }
            var image = GeneratedImage(data: data, seed: seed)
            if let type = entry["content_type"] as? String { image.params["contentType"] = .string(type) }
            out.append(image)
        }
        guard !out.isEmpty else { throw ImageFailure("\(endpoint) returned no downloadable images. Try again, or pick another model.") }
        return out
    }

    private func fetch(_ urlString: String) async throws -> Data {
        if urlString.hasPrefix("data:") {
            guard let comma = urlString.firstIndex(of: ","), let data = Data(base64Encoded: String(urlString[urlString.index(after: comma)...])) else {
                throw ImageFailure("fal returned an unreadable inline image. Try again.")
            }
            guard data.count <= maxDownload else { throw ImageFailure("The image fal returned is larger than \(maxDownload / 1_048_576) MB; Ocelot refused it.") }
            return data
        }
        guard let url = Self.falURL(urlString) else {
            throw ImageFailure("fal pointed to an image outside fal's own hosts (\(URL(string: urlString)?.host ?? "unknown")); Ocelot refused to download it.")
        }
        let download = Download(limit: maxDownload)
        let (data, response) = try await download.run(URLRequest(url: url, timeoutInterval: 120), configuration: session.configuration)
        if let status = response?.statusCode, !(200..<300).contains(status) {
            throw ImageFailure("Downloading the image from fal failed (HTTP \(status)). Try again.")
        }
        return data
    }

    /// One download on its own session: the size cap is enforced while bytes arrive (a 50 MB limit must not mean
    /// buffering a 5 GB answer first) and redirects must stay on fal hosts.
    private final class Download: NSObject, URLSessionDataDelegate, @unchecked Sendable {
        private let lock = NSLock()
        private let limit: Int
        private var buffer = Data()
        private var violation: ImageFailure?
        private var continuation: CheckedContinuation<(Data, HTTPURLResponse?), any Error>?
        private var response: HTTPURLResponse?
        private var task: URLSessionDataTask?
        private var session: URLSession?
        private var cancelled = false

        init(limit: Int) { self.limit = limit }

        func run(_ request: URLRequest, configuration: URLSessionConfiguration) async throws -> (Data, HTTPURLResponse?) {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(Data, HTTPURLResponse?), any Error>) in
                    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
                    let task = session.dataTask(with: request)
                    lock.lock()
                    self.continuation = continuation
                    self.session = session
                    self.task = task
                    let alreadyCancelled = cancelled
                    lock.unlock()
                    if alreadyCancelled { task.cancel() } else { task.resume() }
                }
            } onCancel: {
                lock.lock()
                cancelled = true
                let task = task
                lock.unlock()
                task?.cancel()
            }
        }

        private func fail(_ failure: ImageFailure) {
            lock.lock()
            if violation == nil { violation = failure }
            let task = task
            lock.unlock()
            task?.cancel()
        }

        private var tooLarge: ImageFailure {
            ImageFailure("The image fal returned is larger than \(limit / 1_048_576) MB; Ocelot refused it.")
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            lock.lock()
            self.response = response as? HTTPURLResponse
            lock.unlock()
            if response.expectedContentLength > Int64(limit) {
                fail(tooLarge)
                completionHandler(.cancel)
            } else {
                completionHandler(.allow)
            }
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            lock.lock()
            buffer.append(data)
            let over = buffer.count > limit
            lock.unlock()
            if over { fail(tooLarge) }
        }

        func urlSession(
            _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
        ) {
            if let url = request.url, url.scheme == "https", FalImageProvider.isFalHost(url.host) {
                completionHandler(request)
            } else {
                fail(ImageFailure("fal redirected the download to \(request.url?.host ?? "an unknown host"), which is not a fal host; Ocelot refused it."))
                completionHandler(nil)
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
            lock.lock()
            let continuation = self.continuation
            self.continuation = nil
            let data = buffer
            let response = self.response
            let violation = self.violation
            let wasCancelled = cancelled
            lock.unlock()
            session.finishTasksAndInvalidate()
            guard let continuation else { return }
            if let violation {
                continuation.resume(throwing: violation)
            } else if wasCancelled {
                continuation.resume(throwing: CancellationError())
            } else if let error {
                continuation.resume(throwing: ImageFailure("Downloading the image from fal failed (\(error.localizedDescription)). Try again."))
            } else {
                continuation.resume(returning: (data, response))
            }
        }
    }
}
