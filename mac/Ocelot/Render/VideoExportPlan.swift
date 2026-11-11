import CoreGraphics
import Foundation

/// The pure parts of video export (`VideoExportService`): codecs, the pixel-size rule, which worker captures which frame,
/// the reorder buffer in front of the encoder. No WebKit, no AVFoundation: unit-tested in `VideoExportPlanTests`.

enum VideoCodec: String, Sendable, CaseIterable {
    case h264
    case hevc
    case prores4444
    case hevcAlpha = "hevc-alpha"
    case gif

    var fileExtension: String {
        switch self {
        case .h264, .hevc: "mp4"
        case .prores4444, .hevcAlpha: "mov"
        case .gif: "gif"
        }
    }

    /// The only codecs whose output keeps the page's transparency (GIF has 1-bit alpha at best: not supported).
    var carriesAlpha: Bool { self == .prores4444 || self == .hevcAlpha }

    /// Average bit rate for H.264 / HEVC. UI content (sharp text, flat colour) needs more bits per pixel than footage.
    func averageBitRate(width: Int, height: Int, fps: Int) -> Int {
        let bitsPerPixel: Double = self == .hevc || self == .hevcAlpha ? 0.12 : 0.2
        return max(2_000_000, Int(Double(width * height * fps) * bitsPerPixel))
    }
}

/// How a composition's pixels map to a WKWebView: the page is laid out at the composition's CSS size and the snapshot has
/// exactly `outWidth` × `outHeight` pixels, whatever the screen's backing scale. WKWebView snapshot cost grows with the
/// output pixels, so a 1080p video is a 960-point view at `pageZoom` 0.5 on a 2x display, never a 2x render scaled down.
struct VideoGeometry: Equatable, Sendable {
    let cssWidth: Double
    let cssHeight: Double
    /// Output size in pixels, always even (H.264/HEVC chroma subsampling).
    let outWidth: Int
    let outHeight: Int
    let backingScale: Double

    init(cssWidth: Double, cssHeight: Double, outWidth: Int, outHeight: Int, backingScale: Double) {
        self.cssWidth = cssWidth
        self.cssHeight = cssHeight
        self.outWidth = Self.even(outWidth)
        self.outHeight = Self.even(outHeight)
        self.backingScale = max(1, backingScale)
    }

    /// Rounds up to the next even number, at least 2.
    static func even(_ n: Int) -> Int { max(2, n + (n & 1)) }

    /// The view's size in points: `outPx / backingScale`.
    var viewSize: CGSize { CGSize(width: Double(outWidth) / backingScale, height: Double(outHeight) / backingScale) }

    /// WKWebView.pageZoom that makes `cssWidth` CSS pixels fill the view.
    var pageZoom: Double { viewSize.width / cssWidth }
}

/// Which frames a worker steps and which it captures. Every worker steps every frame from 0 (stateful layers such as
/// three.js loops must see each step in order), but captures only the frames of its residue class: stepping without a
/// snapshot costs 1-2 ms, a snapshot costs ~80 ms at 1080p, so interleaving the steps is nearly free.
struct FrameSchedule: Equatable, Sendable {
    let workers: Int
    /// First captured frame (absolute index: its time is `startFrame / fps`).
    let startFrame: Int
    let frameCount: Int

    init(workers: Int, startFrame: Int, frameCount: Int) {
        precondition(workers >= 1 && startFrame >= 0 && frameCount >= 0)
        self.workers = min(workers, max(1, frameCount))
        self.startFrame = startFrame
        self.frameCount = frameCount
    }

    /// Steps `0..<stepCount` are executed by every worker.
    var stepCount: Int { startFrame + frameCount }

    /// The output position of an absolute frame, or nil when the frame is stepped but not part of the output.
    func outputIndex(step: Int) -> Int? {
        let k = step - startFrame
        return k >= 0 && k < frameCount ? k : nil
    }

    /// Does `worker` snapshot this step?
    func captures(step: Int, worker: Int) -> Bool {
        guard let k = outputIndex(step: step) else { return false }
        return k % workers == worker
    }

    /// The absolute steps `worker` snapshots, ascending.
    func capturedSteps(worker: Int) -> [Int] {
        stride(from: startFrame + worker, to: stepCount, by: workers).map { $0 }
    }

    /// 4 workers on a 10-core Mac (6 gave +14% in the spike, at 50% more memory), fewer on small machines or short clips.
    static func defaultWorkers(cores: Int, frameCount: Int) -> Int {
        max(1, min(4, cores / 2, frameCount))
    }

    /// Frames a worker may run ahead of the oldest frame the encoder still waits for.
    var window: Int { workers * 3 }
}

/// Frame time in milliseconds. Integer frame numbers are the only clock: `i * 1000 / fps`, never accumulated.
func videoFrameTimeMs(frame: Int, fps: Int) -> Double { Double(frame) * 1000.0 / Double(fps) }

/// Frames arrive from the workers in any order; the encoder wants them in order.
struct ReorderBuffer<Element> {
    private var pending: [Int: Element] = [:]
    private(set) var next = 0

    var pendingCount: Int { pending.count }

    /// Stores one frame and returns every frame that is now in sequence (possibly none), in order.
    mutating func insert(_ index: Int, _ element: Element) -> [Element] {
        precondition(index >= next && pending[index] == nil, "frame \(index) was delivered twice")
        pending[index] = element
        var ready: [Element] = []
        while let e = pending.removeValue(forKey: next) {
            ready.append(e)
            next += 1
        }
        return ready
    }
}

/// Preview frames for the agent: a spread across the clip, away from the first frame (often just the background).
func videoPreviewIndices(frameCount: Int, count: Int) -> [Int] {
    guard frameCount > 0, count > 0 else { return [] }
    if count == 1 { return [frameCount / 2] }
    let fractions = (0..<count).map { 0.15 + 0.70 * Double($0) / Double(count - 1) }
    var seen = Set<Int>()
    return fractions.map { min(frameCount - 1, Int(Double(frameCount) * $0)) }.filter { seen.insert($0).inserted }
}
