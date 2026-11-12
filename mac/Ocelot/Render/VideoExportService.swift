import AppKit
import AVFoundation
import Foundation
import ImageIO
import os
import UniformTypeIdentifiers
import WebKit

/// Everything `host.exportVideoRun` touches outside the renderer, so tests can run the service without UI.
@MainActor
struct VideoExportEnvironment {
    /// `<package>/exports/` (or a temp folder while the document is untitled), created on demand.
    var exportsFolder: @MainActor () throws -> URL
    /// Save panel for one file. nil = cancelled.
    var chooseFile: @MainActor (_ suggestedName: String, _ ext: String) -> URL?
    var progress: @MainActor (ExportProgressParams) -> Void
    /// Parallel capture views. nil: `FrameSchedule.defaultWorkers`.
    var workers: Int?
}

/// `host.exportVideoRun`: renders a composition (a stage page that shows the scenes and their transitions, see
/// `editor/src/export/videoStage.ts`) frame by frame and encodes it.
///
///   stage page `__ocelotExport.seek(t)` → `WKWebView.takeSnapshot` → CGImage → reorder buffer → pixel buffer → AVAssetWriter / ImageIO
///
/// N offscreen WKWebViews share the work: every one steps every frame, each snapshots every N-th. Swift stays thin: it
/// never looks inside the composition, it only asks the page for a time and takes the picture. Rendering happens into a
/// temp file that is moved to its destination last, so a cancelled or failed run leaves nothing behind.
@MainActor
final class VideoExportService {
    static let maxPixelSide = 8192
    static let maxFrames = 60 * 60 * 60
    static let maxGifFrames = 600
    static let maxGifSide = 1280
    static let previewSide = 480

    private let env: VideoExportEnvironment
    private var cancelled: Set<String> = []
    private let log = Logger(subsystem: "sh.caracal.ocelot", category: "video")

    init(_ env: VideoExportEnvironment) { self.env = env }

    func cancel(runId: String) { cancelled.insert(runId) }

    func run(_ params: VideoExportParams) async throws -> VideoExportResult {
        defer { cancelled.remove(params.runId) }
        let plan = try Self.validate(params)

        // Ask where to write before spending time rendering.
        let destination: URL
        switch params.destination {
        case "panel":
            guard let url = env.chooseFile(params.suggestedName, plan.codec.fileExtension) else {
                return VideoExportResult(files: [], cancelled: true, frameHashes: [], previews: [], elapsedMs: 0, renderFps: 0, workers: 0)
            }
            destination = url
        case "exports":
            destination = try env.exportsFolder().appendingPathComponent(params.suggestedName)
        default:
            throw BridgeFailure(.invalidParams, "destination must be \"panel\" or \"exports\" (got \"\(params.destination)\").")
        }

        let temp = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-video-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temp) }
        let tempFile = temp.appendingPathComponent("out.\(plan.codec.fileExtension)")

        let started = ContinuousClock.now
        let outcome: Rendered
        do {
            outcome = try await render(params, plan: plan, to: tempFile)
        } catch is CancellationError {
            return VideoExportResult(files: [], cancelled: true, frameHashes: [], previews: [], elapsedMs: 0, renderFps: 0, workers: 0)
        } catch let failure as BridgeFailure {
            throw failure
        } catch {
            throw BridgeFailure(.internal, error.localizedDescription)
        }
        if isCancelled(params.runId) {
            return VideoExportResult(files: [], cancelled: true, frameHashes: [], previews: [], elapsedMs: 0, renderFps: 0, workers: 0)
        }
        env.progress(ExportProgressParams(runId: params.runId, done: plan.frameCount, total: plan.frameCount, message: "Saving"))

        do {
            let fm = FileManager.default
            if fm.fileExists(atPath: destination.path) {
                _ = try fm.replaceItemAt(destination, withItemAt: tempFile)
            } else {
                try fm.moveItem(at: tempFile, to: destination)
            }
        } catch {
            throw BridgeFailure(.internal, "Could not write \(destination.path): \(error.localizedDescription). Choose another folder or check its permissions.")
        }
        let elapsed = started.duration(to: .now)
        let seconds = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
        let bytes = (try? destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let file = ExportedFile(
            name: destination.lastPathComponent, path: destination.path, bytes: bytes,
            width: plan.geometry.outWidth, height: plan.geometry.outHeight, pages: nil, preview: outcome.previews.first
        )
        log.info("video \(plan.codec.rawValue, privacy: .public) \(plan.frameCount) frames in \(seconds, format: .fixed(precision: 2)) s with \(outcome.workers) workers")
        return VideoExportResult(
            files: [file], folder: destination.deletingLastPathComponent().path, warnings: outcome.warnings.isEmpty ? nil : outcome.warnings,
            frameHashes: outcome.hashes, previews: outcome.previews, elapsedMs: Int(seconds * 1000),
            renderFps: seconds > 0 ? Double(plan.frameCount) / seconds : 0, workers: outcome.workers
        )
    }

    // MARK: Plan

    struct Plan {
        var codec: VideoCodec
        var geometry: VideoGeometry
        var fps: Int
        var startFrame: Int
        var frameCount: Int
    }

    private struct Rendered {
        var hashes: [String]
        var previews: [String]
        var workers: Int
        var warnings: [String]
    }

    private func isCancelled(_ runId: String) -> Bool { cancelled.contains(runId) || Task.isCancelled }

    static func validate(_ p: VideoExportParams) throws -> Plan {
        guard let codec = VideoCodec(rawValue: p.codec) else {
            throw BridgeFailure(.invalidParams, "codec must be one of \(VideoCodec.allCases.map(\.rawValue).joined(separator: ", ")) (got \"\(p.codec)\").")
        }
        guard !p.runId.isEmpty, p.runId.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." }) else {
            throw BridgeFailure(.invalidParams, "runId must be letters, digits, \"-\", \"_\" or \".\".")
        }
        _ = try ExportService.validateFileName(p.suggestedName, ext: codec.fileExtension)
        guard p.fps >= 1, p.fps <= 120 else { throw BridgeFailure(.invalidParams, "fps must be between 1 and 120 (got \(p.fps)).") }
        guard p.frameCount >= 1, p.startFrame >= 0, p.startFrame + p.frameCount <= maxFrames else {
            throw BridgeFailure(.invalidParams, "The video has no frames (or more than \(maxFrames)). Check the range and the scene durations.")
        }
        guard p.width >= 1, p.height >= 1, p.outWidth >= 2, p.outHeight >= 2,
              p.outWidth <= maxPixelSide, p.outHeight <= maxPixelSide
        else {
            throw BridgeFailure(.invalidParams, "Output size \(p.outWidth)×\(p.outHeight) is outside 2…\(maxPixelSide) px. Pick a smaller preset such as 1080p.")
        }
        if codec == .gif {
            guard p.frameCount <= maxGifFrames else {
                throw BridgeFailure(.invalidParams, "A GIF of \(p.frameCount) frames would be huge (limit \(maxGifFrames)). Use a shorter range, a lower fps, or export MP4.")
            }
            guard max(p.outWidth, p.outHeight) <= maxGifSide else {
                throw BridgeFailure(.invalidParams, "GIFs are limited to \(maxGifSide) px on the long side. Use the GIF 960 preset.")
            }
        }
        guard p.files.contains(where: { $0.path == p.entry }) else {
            throw BridgeFailure(.invalidParams, "The composition has no file \"\(p.entry)\". The editor must send the stage page as the entry.")
        }
        let geometry = VideoGeometry(cssWidth: p.width, cssHeight: p.height, outWidth: p.outWidth, outHeight: p.outHeight, backingScale: 1)
        return Plan(codec: codec, geometry: geometry, fps: p.fps, startFrame: p.startFrame, frameCount: p.frameCount)
    }

    // MARK: Render

    private func render(_ params: VideoExportParams, plan: Plan, to file: URL) async throws -> Rendered {
        let runId = params.runId
        let backing = VideoCaptureWorker.probeBackingScale()
        let geometry = VideoGeometry(
            cssWidth: params.width, cssHeight: params.height, outWidth: plan.geometry.outWidth, outHeight: plan.geometry.outHeight, backingScale: backing
        )
        let workerCount = env.workers ?? FrameSchedule.defaultWorkers(cores: ProcessInfo.processInfo.activeProcessorCount, frameCount: plan.frameCount)
        let schedule = FrameSchedule(workers: workerCount, startFrame: plan.startFrame, frameCount: plan.frameCount)

        let handler = try VideoCompositionSchemeHandler(runId: runId, files: params.files)
        let entry = URL(string: "\(VideoCompositionSchemeHandler.scheme)://\(runId)/\(params.entry)")!
        let alpha = params.alpha && plan.codec.carriesAlpha

        let sink: any VideoFrameSink
        do {
            sink = plan.codec == .gif
                ? try GIFSink(url: file, width: geometry.outWidth, height: geometry.outHeight, fps: plan.fps)
                : try AssetWriterSink(url: file, codec: plan.codec, width: geometry.outWidth, height: geometry.outHeight, fps: plan.fps)
        } catch {
            throw BridgeFailure(.internal, error.localizedDescription)
        }
        let pool = try VideoPixelBufferPool(width: geometry.outWidth, height: geometry.outHeight)
        let gate = FrameGate()
        let (stream, continuation) = AsyncStream<CapturedFrame>.makeStream(bufferingPolicy: .unbounded)
        let reporter = VideoProgressReporter(runId: runId, total: plan.frameCount, fps: plan.fps, progress: env.progress)
        let previewIndices = Set(videoPreviewIndices(frameCount: plan.frameCount, count: min(max(params.previews ?? 3, 0), 6)))
        let previews = PreviewCollector()
        let total = plan.frameCount

        let consumer = Task.detached { () throws -> [String] in
            var reorder = ReorderBuffer<CapturedFrame>()
            var hashes: [String] = []
            hashes.reserveCapacity(total)
            do {
                for await frame in stream {
                    for ready in reorder.insert(frame.index, frame) {
                        let buffer = try pool.makeBuffer()
                        try VideoPixelBufferPool.fill(buffer, from: ready.image)
                        hashes.append(VideoPixelBufferPool.hash(buffer))
                        try await sink.append(VideoFrame(index: ready.index, pixelBuffer: buffer))
                        await gate.advance(to: ready.index + 1)
                        await reporter.report(done: hashes.count)
                    }
                    try Task.checkCancellation()
                }
            } catch {
                await gate.fail(error)
                throw error
            }
            return hashes
        }

        var workers: [VideoCaptureWorker] = []
        var tasks: [Task<Void, any Error>] = []
        do {
            for _ in 0..<schedule.workers {
                workers.append(VideoCaptureWorker(geometry: geometry, alpha: alpha, handler: handler))
            }
            let fps = plan.fps
            let isCancelled: @MainActor @Sendable () -> Bool = { [weak self] in self?.cancelled.contains(runId) ?? true }
            for (id, worker) in workers.enumerated() {
                tasks.append(Task { @MainActor in
                    try await worker.capture(
                        id: id, schedule: schedule, fps: fps, entry: entry, gate: gate, isCancelled: isCancelled,
                        previewIndices: previewIndices, previews: previews, output: continuation
                    )
                })
            }
            try await withThrowingTaskGroup(of: Void.self) { [tasks] group in
                for task in tasks { group.addTask { try await task.value } }
                try await group.waitForAll()
            }
            continuation.finish()
            let hashes = try await consumer.value
            guard hashes.count == plan.frameCount else { throw CancellationError() }
            try await sink.finish()
            workers.forEach { $0.close() }
            return Rendered(hashes: hashes, previews: previews.sorted(), workers: schedule.workers, warnings: [])
        } catch {
            continuation.finish()
            consumer.cancel()
            await gate.fail(CancellationError())
            sink.cancel()
            workers.forEach { $0.close() }
            tasks.forEach { $0.cancel() }
            _ = try? await consumer.value
            if error is CancellationError { throw error }
            throw (error as? BridgeFailure) ?? BridgeFailure(.internal, "Rendering the video failed: \(error.localizedDescription) Try again, or export a shorter range at a lower preset.")
        }
    }

    /// PNG (base64) no larger than `maxSide` on its long side.
    nonisolated static func thumbnailPNG(_ image: CGImage, maxSide: Int) -> String? {
        let k = min(1, Double(maxSide) / Double(max(image.width, image.height)))
        let w = max(1, Int((Double(image.width) * k).rounded())), h = max(1, Int((Double(image.height) * k).rounded()))
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let small = ctx.makeImage() else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, small, nil)
        return CGImageDestinationFinalize(dest) ? (out as Data).base64EncodedString() : nil
    }
}

// MARK: Flow control

/// Keeps the workers from running far ahead of the encoder: frame `index` may be captured once fewer than `window`
/// frames sit between it and the oldest frame not yet written.
actor FrameGate {
    private var written = 0
    private var failure: (any Error)?
    private var waiters: [(threshold: Int, continuation: CheckedContinuation<Void, any Error>)] = []

    func waitUntil(index: Int, window: Int) async throws {
        if let failure { throw failure }
        if written > index - window { return }
        try await withCheckedThrowingContinuation { waiters.append((index - window, $0)) }
    }

    func advance(to written: Int) {
        self.written = written
        let (ready, rest) = waiters.reduce(into: ([CheckedContinuation<Void, any Error>](), [(threshold: Int, continuation: CheckedContinuation<Void, any Error>)]())) {
            if written > $1.threshold { $0.0.append($1.continuation) } else { $0.1.append($1) }
        }
        waiters = rest
        ready.forEach { $0.resume() }
    }

    func fail(_ error: any Error) {
        failure = error
        let all = waiters
        waiters = []
        all.forEach { $0.continuation.resume(throwing: error) }
    }
}

/// Progress for the editor: at most ~10 messages a second.
@MainActor
final class VideoProgressReporter {
    private let runId: String
    private let total: Int
    private let fps: Int
    private let progress: @MainActor (ExportProgressParams) -> Void
    private let started = ContinuousClock.now
    private var last = ContinuousClock.now

    init(runId: String, total: Int, fps: Int, progress: @escaping @MainActor (ExportProgressParams) -> Void) {
        self.runId = runId
        self.total = total
        self.fps = fps
        self.progress = progress
    }

    func report(done: Int) {
        let now = ContinuousClock.now
        guard done == total || now - last >= .milliseconds(100) else { return }
        last = now
        let elapsed = started.duration(to: now)
        let seconds = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
        let rate = seconds > 0.5 ? Double(done) / seconds : 0
        let eta = rate > 0 ? " · about \(Int((Double(total - done) / rate).rounded(.up))) s left" : ""
        progress(ExportProgressParams(runId: runId, done: done, total: total, message: "Rendering frame \(done) of \(total)\(eta)"))
    }
}

@MainActor
final class PreviewCollector {
    private var pngs: [Int: String] = [:]
    func add(index: Int, png: String) { pngs[index] = png }
    func sorted() -> [String] { pngs.keys.sorted().compactMap { pngs[$0] } }
}

// MARK: Composition files

/// Serves the composition (stage page, scene documents, assets) from memory at `ocelot-export://<runId>/<path>`. Nothing
/// else: no files on disk, no other run's data.
@MainActor
final class VideoCompositionSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "ocelot-export"

    private let runId: String
    private let files: [String: (data: Data, mime: String)]

    init(runId: String, files: [VideoFile]) throws {
        self.runId = runId.lowercased()
        var table: [String: (data: Data, mime: String)] = [:]
        for f in files {
            let data: Data
            if let text = f.text {
                data = Data(text.utf8)
            } else if let b64 = f.base64, let decoded = Data(base64Encoded: b64) {
                data = decoded
            } else {
                throw BridgeFailure(.invalidParams, "Composition file \"\(f.path)\" has neither text nor valid base64 data.")
            }
            table[f.path] = (data, f.mime)
        }
        self.files = table
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        let path = String((url.path.removingPercentEncoding ?? url.path).drop(while: { $0 == "/" }))
        let entry = url.host?.lowercased() == runId ? files[path] : nil
        let headers = [
            "Content-Type": entry?.mime ?? "text/plain",
            "Content-Length": String(entry?.data.count ?? 9),
            "Cache-Control": "no-store",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: entry == nil ? 404 : 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(entry?.data ?? Data("Not found".utf8))
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}

// MARK: Capture worker

/// One offscreen WKWebView showing the stage page. Built like `OffscreenRenderer.ensureWebView` (occlusion detection off,
/// an invisible `OffscreenWindow`) but sized by `VideoGeometry`.
@MainActor
final class VideoCaptureWorker: NSObject, WKNavigationDelegate {
    private let geometry: VideoGeometry
    private let window: OffscreenWindow
    private let webView: WKWebView
    private var loadContinuation: CheckedContinuation<Void, any Error>?
    private var crashed = false

    /// The backing scale an offscreen window gets (it follows the main display, so 1x on some Mac minis).
    static func probeBackingScale() -> Double {
        let probe = OffscreenWindow(size: NSSize(width: 16, height: 16))
        defer { probe.close() }
        return Double(probe.backingScaleFactor)
    }

    init(geometry: VideoGeometry, alpha: Bool, handler: VideoCompositionSchemeHandler) {
        self.geometry = geometry
        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = true
        config.setURLSchemeHandler(handler, forURLScheme: VideoCompositionSchemeHandler.scheme)
        // Code layers import the vendored libraries from ocelot://app/vendor/ (Release builds).
        config.setURLSchemeHandler(EditorSchemeHandler(root: EditorSource.bundleRoot), forURLScheme: EditorSource.scheme)
        let size = geometry.viewSize
        webView = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        if webView.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) {
            webView.setValue(false, forKey: "windowOcclusionDetectionEnabled")
        }
        webView.pageZoom = geometry.pageZoom
        if alpha { webView.setValue(false, forKey: "drawsBackground") }
        window = OffscreenWindow(size: size, transparentBackground: alpha)
        window.contentView = webView
        super.init()
        webView.navigationDelegate = self
        window.orderFrontRegardless()
    }

    /// Loads the stage, then steps every frame in order and snapshots the ones this worker owns.
    func capture(
        id: Int, schedule: FrameSchedule, fps: Int, entry: URL, gate: FrameGate, isCancelled: @MainActor @Sendable () -> Bool,
        previewIndices: Set<Int>, previews: PreviewCollector, output: AsyncStream<CapturedFrame>.Continuation
    ) async throws {
        try await load(entry)
        for step in 0..<schedule.stepCount {
            try Task.checkCancellation()
            if isCancelled() { throw CancellationError() }
            try await seek(ms: videoFrameTimeMs(frame: step, fps: fps))
            guard schedule.captures(step: step, worker: id), let k = schedule.outputIndex(step: step) else { continue }
            try await gate.waitUntil(index: k, window: schedule.window)
            let image = try await snapshot()
            if previewIndices.contains(k), let png = VideoExportService.thumbnailPNG(image, maxSide: VideoExportService.previewSide) {
                previews.add(index: k, png: png)
            }
            output.yield(CapturedFrame(index: k, image: image))
        }
    }

    func close() {
        webView.navigationDelegate = nil
        webView.stopLoading()
        window.contentView = nil
        window.close()
    }

    /// Loads the stage and waits for its `__ocelotExport.ready()` (fonts, images, code layers).
    func load(_ url: URL) async throws {
        try await EditorClient.withTimeout(.seconds(30), method: "video stage load") { @MainActor @Sendable in
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, any Error>) in
                self.loadContinuation = cont
                self.webView.load(URLRequest(url: url))
            }
        }
        try await call("""
        if (!window.__ocelotExport) throw new Error('The composition page has no __ocelotExport runtime.');
        await window.__ocelotExport.ready();
        return true;
        """, timeout: .seconds(60), what: "start")
    }

    func seek(ms: Double) async throws {
        try await call("await window.__ocelotExport.seek(t); return true;", arguments: ["t": ms], timeout: .seconds(60), what: "seek to \(Int(ms)) ms")
    }

    func snapshot() async throws -> CGImage {
        guard !crashed else { throw VideoEncodingError(message: "The page renderer crashed. Try again, or export a shorter range at a lower preset.") }
        let config = WKSnapshotConfiguration()
        config.rect = CGRect(origin: .zero, size: geometry.viewSize)
        config.snapshotWidth = NSNumber(value: Double(geometry.viewSize.width))
        config.afterScreenUpdates = true
        let webView = self.webView
        let image = try await EditorClient.withTimeout(.seconds(60), method: "video snapshot") { @MainActor @Sendable () -> SendableImage in
            SendableImage(image: try await webView.takeSnapshot(configuration: config))
        }.image
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw VideoEncodingError(message: "WebKit returned an empty snapshot. Try again.")
        }
        return cg
    }

    private struct SendableImage: @unchecked Sendable { let image: NSImage }

    private func call(_ js: String, arguments: [String: Any] = [:], timeout: Duration, what: String) async throws {
        guard !crashed else { throw VideoEncodingError(message: "The page renderer crashed. Try again, or export a shorter range at a lower preset.") }
        let webView = self.webView
        let args = SendableArguments(value: arguments)
        do {
            _ = try await EditorClient.withTimeout(timeout, method: "video \(what)") { @MainActor @Sendable () -> Bool in
                _ = try await webView.callAsyncJavaScript(js, arguments: args.value, contentWorld: .page)
                return true
            }
        } catch let failure as BridgeFailure {
            throw failure
        } catch {
            let ns = error as NSError
            let detail = (ns.userInfo["WKJavaScriptExceptionMessage"] as? String) ?? error.localizedDescription
            throw VideoEncodingError(message: "The composition failed to \(what): \(detail)")
        }
    }

    private struct SendableArguments: @unchecked Sendable { let value: [String: Any] }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finishLoad(.success(())) }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        finishLoad(.failure(VideoEncodingError(message: "Could not load the composition: \(error.localizedDescription)")))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        finishLoad(.failure(VideoEncodingError(message: "Could not load the composition: \(error.localizedDescription)")))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        crashed = true
        finishLoad(.failure(VideoEncodingError(message: "The page renderer crashed while loading. Try again, or export at a lower preset.")))
    }

    /// The stage and its scene frames load from the composition scheme; code layers are about:srcdoc. Nothing navigates anywhere else.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let scheme = navigationAction.request.url?.scheme
        if navigationAction.targetFrame?.isMainFrame == false { return scheme == "about" || scheme == VideoCompositionSchemeHandler.scheme ? .allow : .cancel }
        return navigationAction.navigationType == .other && scheme == VideoCompositionSchemeHandler.scheme ? .allow : .cancel
    }

    private func finishLoad(_ result: Result<Void, any Error>) {
        let c = loadContinuation
        loadContinuation = nil
        c?.resume(with: result)
    }
}

// MARK: Bridge

/// `host.exportVideoRun` / `host.exportVideoCancel` for one editor window.
@MainActor
enum VideoExportBridge {
    static func register(on host: HostEndpoint, session: DocumentSession) {
        let untitledExports = FileManager.default.temporaryDirectory
            .appendingPathComponent("ocelot-exports-\(UUID().uuidString)", isDirectory: true)
        let service = VideoExportService(
            VideoExportEnvironment(
                exportsFolder: { [weak session] in
                    let folder = session?.fileURL?.appendingPathComponent("exports", isDirectory: true) ?? untitledExports
                    do {
                        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    } catch {
                        throw BridgeFailure(.internal, "Could not create the export folder \(folder.path): \(error.localizedDescription). Save the document somewhere writable first.")
                    }
                    return folder
                },
                chooseFile: { name, ext in
                    let panel = NSSavePanel()
                    panel.nameFieldStringValue = name
                    panel.canCreateDirectories = true
                    panel.isExtensionHidden = false
                    if let type = UTType(filenameExtension: ext) { panel.allowedContentTypes = [type] }
                    panel.prompt = "Export"
                    return panel.runModal() == .OK ? panel.url : nil
                },
                progress: { [weak session] params in
                    guard let client = session?.editorClient() else { return }
                    Task { @MainActor in _ = try? await client.call(EditorMethods.ExportProgress.self, params) }
                },
                workers: nil
            )
        )
        host.register(HostMethods.ExportVideoRun.self) { params in try await service.run(params) }
        host.register(HostMethods.ExportVideoCancel.self) { params in
            service.cancel(runId: params.runId)
            return Empty()
        }
    }
}
