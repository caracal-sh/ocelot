import Foundation

/// The three operations of `host.imageGenerate`.
enum ImageOperation: String, Sendable {
    case generate
    case edit
    case removeBackground = "remove_background"

    /// The `ImageModelInfo.capabilities` entry a model needs for this operation.
    var capability: String { rawValue }

    /// The `AssetRecord.kind` of the results.
    var assetKind: String {
        switch self {
        case .generate: "generated"
        case .edit: "edited"
        case .removeBackground: "background_removed"
        }
    }

    var verb: String {
        switch self {
        case .generate: "generate images"
        case .edit: "edit images"
        case .removeBackground: "remove backgrounds"
        }
    }
}

/// A reference image, already read out of the asset store.
struct ImageReference: Sendable {
    let id: String
    let data: Data
    let ext: String
    let mime: String

    var dataURL: String { "data:\(mime);base64,\(data.base64EncodedString())" }
}

/// A validated generation request, as a provider sees it. `model` is the provider-local id
/// (the part after `<provider>:`).
struct ImageRequest: Sendable {
    var operation: ImageOperation
    var model: String
    var prompt: String
    var aspect: String?
    /// Exact pixels `(width, height)` when the caller asked for them.
    var size: (width: Int, height: Int)?
    var n: Int
    var background: String
    var quality: String?
    var seed: Int?
    var references: [ImageReference]
    /// `remove_background` on models with the `crop_to_subject` capability: shrink the result to the subject.
    var cropToSubject = false
}

struct GeneratedImage: Sendable {
    var data: Data
    var seed: Int?
    var revisedPrompt: String?
    /// Provider-specific facts worth keeping in `AssetRecord.params` (cost, content type, …).
    var params: [String: JSONValue] = [:]
    /// Notes about this particular result (e.g. the model ignored the request); the service reports them to the caller.
    var warnings: [String] = []
}

struct ImageProgressUpdate: Sendable, Equatable {
    /// `queued` | `running` | `downloading` | `saving`
    var stage: String
    var message: String
    var fraction: Double?
}

typealias ImageProgressHandler = @Sendable (ImageProgressUpdate) -> Void

/// A run that failed after some images were already produced: the service still stores them (they cost
/// money and time) and reports the failure as a warning.
struct ImagePartialResult: Error, Sendable {
    let images: [GeneratedImage]
    let underlying: any Error
}

/// One image route. Cancel by cancelling the task that runs `generate` (subprocesses are killed,
/// requests aborted, fal jobs cancelled).
protocol ImageProvider: Sendable {
    var id: String { get }
    var label: String { get }
    /// Status and model catalog. Cheap enough to call every ~30 s; never throws.
    func status() async -> ImageProviderInfo
    /// Provider-specific notes about request fields this route cannot honour (shown to the caller).
    func warnings(for request: ImageRequest) -> [String]
    /// Extra sentence for the "cannot <operation>" error when this route only does some operations.
    func rejectionHint(for operation: ImageOperation) -> String?
    /// A model the catalog does not list but the route accepts (fal: `fal:<any endpoint id>`).
    func customModel(_ model: String) -> ImageModelInfo?
    func generate(_ request: ImageRequest, progress: @escaping ImageProgressHandler) async throws -> [GeneratedImage]
}

extension ImageProvider {
    func warnings(for request: ImageRequest) -> [String] { [] }
    func customModel(_ model: String) -> ImageModelInfo? { nil }
    func rejectionHint(for operation: ImageOperation) -> String? { nil }
}

/// A failure with a message that already says what to do next.
struct ImageFailure: LocalizedError, Sendable {
    let message: String
    /// The provider refused the stored credential (HTTP 401/403, not signed in): the user must sign in again or
    /// replace the key. `ImageProviderHub.markRejected` turns this into "unavailable" until a refresh.
    let credentialRejected: Bool
    init(_ message: String, credentialRejected: Bool = false) {
        self.message = message
        self.credentialRejected = credentialRejected
    }
    var errorDescription: String? { message }
}

enum ImageAspects {
    static let all = ["1:1", "16:9", "3:2", "2:3", "4:3", "3:4", "9:16", "21:9", "4:5", "5:4"]

    /// `(w, h)` ratio of an `"A:B"` aspect.
    static func ratio(_ aspect: String) -> (Int, Int)? {
        let parts = aspect.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2, parts[0] > 0, parts[1] > 0 else { return nil }
        return (parts[0], parts[1])
    }

    /// Pixel size of `aspect` whose long side is `longSide`, rounded to a multiple of 16.
    static func pixels(aspect: String, longSide: Int) -> (width: Int, height: Int)? {
        guard let (w, h) = ratio(aspect) else { return nil }
        func snap(_ v: Double) -> Int { max(16, Int((v / 16).rounded()) * 16) }
        if w >= h { return (snap(Double(longSide)), snap(Double(longSide) * Double(h) / Double(w))) }
        return (snap(Double(longSide) * Double(w) / Double(h)), snap(Double(longSide)))
    }
}
