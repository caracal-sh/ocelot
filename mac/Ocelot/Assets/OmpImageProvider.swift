import Foundation

/// A running omp auth gateway and the means to hand out per-request tokens (see `AuthGateway`).
struct OmpGatewayConnection: Sendable {
    let url: URL
    /// A bearer token limited to `models` (omp selectors, `provider/id`).
    let mintToken: @Sendable (_ models: [String]) async throws -> String
    let revoke: @Sendable (_ token: String) async -> Void
}

enum OmpCatalogResult: Sendable {
    case notInstalled
    case failed(String)
    /// stdout of `omp models --json --kind image`
    case models(Data)
}

/// Image models from the user's signed-in omp providers, called through the omp auth gateway
/// (OpenAI Images wire format). The gateway token is limited to the one model and revoked afterwards.
struct OmpImageProvider: ImageProvider {
    let id = "omp"
    let label = "omp (your signed-in providers)"

    /// Providers whose models omp serves through a chat carrier: the gateway refuses them
    /// ("requires a hosted image carrier").
    static let carrierProviders: Set<String> = ["openai-codex", "openai"]

    let connect: @Sendable () async throws -> OmpGatewayConnection
    let catalog: @Sendable () async -> OmpCatalogResult
    let session: URLSession

    init(
        connect: @escaping @Sendable () async throws -> OmpGatewayConnection,
        catalog: @escaping @Sendable () async -> OmpCatalogResult,
        session: URLSession = OmpImageProvider.loopbackSession
    ) {
        self.connect = connect
        self.catalog = catalog
        self.session = session
    }

    /// Production wiring: the host's `AuthGateway` and the omp install found by `OmpLocator`.
    static func live() -> OmpImageProvider {
        OmpImageProvider(
            connect: {
                let endpoint = try await AuthGateway.shared.ensureRunning()
                return OmpGatewayConnection(
                    url: endpoint.url,
                    mintToken: { models in try await endpoint.mintClientToken(models: models, ttl: .seconds(1800)) },
                    revoke: { token in await endpoint.revoke(token) }
                )
            },
            catalog: {
                guard let cli = await OmpLocator.shared.cli() else { return .notInstalled }
                guard let result = await cli.capture(["models", "--json", "--kind", "image"], timeout: 30) else {
                    return .failed("`omp models` did not finish.")
                }
                guard result.status == 0 else { return .failed("`omp models` exited with status \(result.status).") }
                return .models(Data(result.stdout.utf8))
            }
        )
    }

    static let loopbackSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:] // loopback gateway: never through a system proxy
        config.timeoutIntervalForRequest = 900
        config.timeoutIntervalForResource = 1200
        return URLSession(configuration: config)
    }()

    static let removeBackgroundNote = "remove_background works via edit: asks the model to cut the subject out; many models return an opaque background"

    /// The instruction `remove_background` sends as an edit.
    static let removeBackgroundPrompt = "Remove the background of this image completely. Keep only the main subject, unchanged and sharp, on a fully transparent background (PNG with alpha). Do not add, restyle or crop anything."

    // MARK: Catalog

    func status() async -> ImageProviderInfo {
        switch await catalog() {
        case .notInstalled:
            return info(status: "unavailable", detail: "omp is not installed.", setup: "Install omp (`bun install -g @oh-my-pi/pi-coding-agent`), then run `omp login`.")
        case .failed(let reason):
            return info(status: "unavailable", detail: "omp could not list its image models: \(reason)", setup: "Run `omp models --kind image` in a terminal to see what is wrong.")
        case .models(let data):
            let models = Self.parseCatalog(data)
            if models.isEmpty {
                return info(
                    status: "needs_setup", detail: "None of your signed-in omp providers offers an image model.",
                    setup: "Run `omp login openrouter` (or another provider with image models), then refresh."
                )
            }
            return info(status: "ready", detail: "\(models.count) image models from your signed-in omp providers.", models: models)
        }
    }

    private func info(status: String, detail: String, setup: String? = nil, models: [ImageModelInfo] = []) -> ImageProviderInfo {
        ImageProviderInfo(id: id, label: label, status: status, detail: detail, models: models, keyStored: nil, setup: setup)
    }

    private struct Row: Decodable {
        var provider: String
        var id: String
        var selector: String?
        var name: String?
        var input: [String]?
        var cost: Cost?
        var pricingStatus: String?

        struct Cost: Decodable {
            var input: Double?
            var output: Double?
        }
    }

    private struct Rows: Decodable { var models: [Row] }

    /// `omp models --json --kind image` -> catalog entries (carrier-hosted providers removed).
    static func parseCatalog(_ data: Data) -> [ImageModelInfo] {
        guard let rows = try? JSONDecoder().decode(Rows.self, from: data) else { return [] }
        return rows.models
            .filter { !carrierProviders.contains($0.provider) }
            .map { row in
                let selector = row.selector ?? "\(row.provider)/\(row.id)"
                let acceptsImages = row.input?.contains("image") ?? false
                var capabilities = ["generate"]
                if acceptsImages { capabilities += ["edit", "references", "remove_background"] }
                if row.id.lowercased().contains("vector") { capabilities.append("vector") }
                var cost: String?
                if row.pricingStatus == "fixed", let input = row.cost?.input, let output = row.cost?.output, input + output > 0 {
                    cost = "$\(number(input)) in / $\(number(output)) out per 1M tokens"
                }
                return ImageModelInfo(
                    id: "omp:\(selector)", provider: "omp", model: selector,
                    label: "\(row.name ?? row.id) (\(row.provider))",
                    capabilities: capabilities, aspects: ImageAspects.all, maxN: 4, cost: cost,
                    note: acceptsImages ? Self.removeBackgroundNote : nil, available: true, unavailableReason: nil
                )
            }
            .sorted { $0.model < $1.model }
    }

    private static func number(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(format: "%.2f", v)
    }

    // MARK: Generate

    func warnings(for request: ImageRequest) -> [String] {
        var notes: [String] = []
        if request.quality != nil { notes.append("The omp gateway has no quality setting; it was ignored.") }
        if request.background != "auto", request.operation != .removeBackground { notes.append("The omp gateway has no background setting; \"\(request.background)\" was ignored (describe it in the prompt instead).") }
        return notes
    }

    func generate(_ request: ImageRequest, progress: @escaping ImageProgressHandler) async throws -> [GeneratedImage] {
        let removing = request.operation == .removeBackground
        guard !removing || !request.references.isEmpty else {
            throw ImageFailure("remove_background needs the source image in `references`.")
        }
        var request = request
        if removing { request.prompt = Self.removeBackgroundPrompt }
        progress(ImageProgressUpdate(stage: "queued", message: "Connecting to the omp gateway…", fraction: nil))
        let connection = try await connect()
        let token = try await connection.mintToken([request.model])
        let images: [GeneratedImage]
        do {
            progress(ImageProgressUpdate(stage: "running", message: "Waiting for \(request.model)…", fraction: nil))
            images = try await post(request, to: connection, token: token)
        } catch {
            await connection.revoke(token)
            throw error
        }
        await connection.revoke(token)
        guard removing else { return images }
        // A model that ignores the transparency request hands back a flat image: say so instead of failing.
        let note = "\(request.model) returned an image without transparency, so the background was not removed. Use the on-device model (vision:foreground-mask) or fal:fal-ai/birefnet/v2."
        return images.map { image in
            var image = image
            if ImageSniffer.hasAlpha(image.data) == false { image.warnings.append(note) }
            return image
        }
    }

    private func post(_ request: ImageRequest, to connection: OmpGatewayConnection, token: String) async throws -> [GeneratedImage] {
        var body: [String: Any] = [
            "model": request.model,
            "prompt": request.prompt,
            "n": request.n,
            "response_format": "b64_json",
        ]
        if let size = request.size {
            body["size"] = "\(size.width)x\(size.height)"
        } else if let aspect = request.aspect {
            body["aspect_ratio"] = aspect
        }
        let editing = !request.references.isEmpty
        if editing { body["images"] = request.references.map(\.dataURL) }

        let path = editing ? "/v1/images/edits" : "/v1/images/generations"
        guard let url = URL(string: path, relativeTo: connection.url)?.absoluteURL else {
            throw ImageFailure("The omp gateway URL is invalid. Restart Ocelot.")
        }
        var http = URLRequest(url: url, timeoutInterval: 900)
        http.httpMethod = "POST"
        http.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        http.setValue("application/json", forHTTPHeaderField: "Content-Type")
        http.httpBody = try JSONSerialization.data(withJSONObject: body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: http)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw ImageFailure("Could not reach the omp gateway (\(error.localizedDescription)). Restart Ocelot, or run `omp auth-gateway status` in a terminal.")
        }
        guard let status = (response as? HTTPURLResponse)?.statusCode else {
            throw ImageFailure("The omp gateway sent an invalid response. Try again.")
        }
        guard (200..<300).contains(status) else {
            throw ImageFailure(Self.failureMessage(status: status, body: data, model: request.model), credentialRejected: Self.rejectsCredential(status: status))
        }
        return try Self.parseImages(data, model: request.model)
    }

    /// OpenAI Images response: `{ data: [{ b64_json, revised_prompt? }], usage?: { cost } }`.
    static func parseImages(_ data: Data, model: String) throws -> [GeneratedImage] {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = object["data"] as? [[String: Any]]
        else { throw ImageFailure("The omp gateway answered with something other than an image list. Try again or pick another model.") }
        var cost: Double?
        if let usage = object["usage"] as? [String: Any] { cost = (usage["cost"] as? NSNumber)?.doubleValue }
        var images: [GeneratedImage] = []
        for item in items {
            guard let b64 = item["b64_json"] as? String, let bytes = Data(base64Encoded: b64, options: .ignoreUnknownCharacters), !bytes.isEmpty else { continue }
            var image = GeneratedImage(data: bytes)
            image.revisedPrompt = item["revised_prompt"] as? String
            if let cost { image.params["cost"] = .number(cost / Double(max(1, items.count))) }
            images.append(image)
        }
        guard !images.isEmpty else {
            throw ImageFailure("\(model) returned no image data. Try again, rephrase the prompt, or pick another model (list_image_models).")
        }
        return images
    }

    /// The upstream refused the credential: the user has to `omp login <provider>` again.
    static func rejectsCredential(status: Int) -> Bool { status == 401 || status == 403 }

    /// Maps upstream statuses to a message that says what to do. The gateway forwards the provider's status.
    static func failureMessage(status: Int, body: Data, model: String) -> String {
        let provider = model.split(separator: "/").first.map(String.init) ?? "the provider"
        let detail = upstreamMessage(body).map { " (\($0))" } ?? ""
        switch status {
        case _ where rejectsCredential(status: status):
            return "\(provider) rejected the credential\(detail). Run `omp login \(provider)` in a terminal, then try again."
        case 402:
            return "\(provider) says the account is out of credit\(detail). Add credit with the provider, or pick another model."
        case 404:
            return "\(model) is not available from \(provider)\(detail). Pick another model (list_image_models) or run `omp models --kind image`."
        case 400, 422:
            return "\(provider) refused the request\(detail). Check the prompt, size and reference images, or pick another model."
        case 429:
            return "\(provider) is rate limiting you\(detail). Wait a minute and retry, or pick another model."
        case 500...599:
            return "\(provider) had a server error (\(status))\(detail). Try again shortly, or pick another model."
        default:
            return "The omp gateway answered \(status)\(detail). Try again, or run `omp auth-gateway status`."
        }
    }

    private static func upstreamMessage(_ body: Data) -> String? {
        guard !body.isEmpty else { return nil }
        if let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            if let error = object["error"] as? [String: Any], let message = error["message"] as? String { return clip(message) }
            if let message = object["error"] as? String { return clip(message) }
            if let message = object["message"] as? String { return clip(message) }
            if let message = object["detail"] as? String { return clip(message) }
        }
        let text = String(decoding: body.prefix(300), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : clip(text)
    }

    private static func clip(_ text: String) -> String {
        let flat = text.replacingOccurrences(of: "\n", with: " ")
        return flat.count > 200 ? String(flat.prefix(200)) + "…" : flat
    }
}
