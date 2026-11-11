import AppKit
import AVFoundation
import ImageIO
import XCTest
@testable import Ocelot

/// Frame scheduling, the pixel-size rule and the reorder buffer: pure logic, no WebKit.
final class VideoExportPlanTests: XCTestCase {
    func testPixelSizeRuleOnA2xDisplay() {
        let g = VideoGeometry(cssWidth: 1920, cssHeight: 1080, outWidth: 1920, outHeight: 1080, backingScale: 2)
        XCTAssertEqual(g.viewSize, CGSize(width: 960, height: 540), "a 1080p video is a 960 pt view on a 2x display")
        XCTAssertEqual(g.pageZoom, 0.5, accuracy: 1e-9, "the CSS layout stays 1920 px wide")
    }

    func testPixelSizeRuleOnA1xDisplay() {
        let g = VideoGeometry(cssWidth: 1920, cssHeight: 1080, outWidth: 3840, outHeight: 2160, backingScale: 1)
        XCTAssertEqual(g.viewSize, CGSize(width: 3840, height: 2160))
        XCTAssertEqual(g.pageZoom, 2, accuracy: 1e-9)
    }

    func testOutputSizeIsEven() {
        let g = VideoGeometry(cssWidth: 1000, cssHeight: 563, outWidth: 1279, outHeight: 719, backingScale: 2)
        XCTAssertEqual(g.outWidth, 1280)
        XCTAssertEqual(g.outHeight, 720)
        XCTAssertEqual(VideoGeometry.even(1), 2)
        XCTAssertEqual(VideoGeometry.even(0), 2)
        XCTAssertEqual(VideoGeometry.even(1080), 1080)
    }

    func testBackingScaleBelowOneIsTreatedAsOne() {
        XCTAssertEqual(VideoGeometry(cssWidth: 100, cssHeight: 100, outWidth: 100, outHeight: 100, backingScale: 0).backingScale, 1)
    }

    func testEveryWorkerStepsEveryFrameButCapturesItsOwn() {
        let s = FrameSchedule(workers: 4, startFrame: 0, frameCount: 10)
        XCTAssertEqual(s.stepCount, 10)
        for step in 0..<10 {
            let owners = (0..<4).filter { s.captures(step: step, worker: $0) }
            XCTAssertEqual(owners, [step % 4], "frame \(step) has exactly one owner")
        }
        XCTAssertEqual(s.capturedSteps(worker: 1), [1, 5, 9])
        XCTAssertEqual(s.capturedSteps(worker: 3), [3, 7])
    }

    func testRangeStartStepsFromZeroButCapturesFromTheRange() {
        let s = FrameSchedule(workers: 3, startFrame: 30, frameCount: 7)
        XCTAssertEqual(s.stepCount, 37, "stateful layers need the frames before the range")
        XCTAssertNil(s.outputIndex(step: 29))
        XCTAssertEqual(s.outputIndex(step: 30), 0)
        XCTAssertEqual(s.outputIndex(step: 36), 6)
        XCTAssertNil(s.outputIndex(step: 37))
        XCTAssertFalse((0..<3).contains { s.captures(step: 12, worker: $0) })
        XCTAssertEqual(s.capturedSteps(worker: 0), [30, 33, 36])
        let all = (0..<3).flatMap { s.capturedSteps(worker: $0) }.sorted()
        XCTAssertEqual(all, Array(30..<37), "together the workers cover the range exactly once")
    }

    func testWorkerCount() {
        XCTAssertEqual(FrameSchedule.defaultWorkers(cores: 10, frameCount: 300), 4)
        XCTAssertEqual(FrameSchedule.defaultWorkers(cores: 4, frameCount: 300), 2)
        XCTAssertEqual(FrameSchedule.defaultWorkers(cores: 1, frameCount: 300), 1)
        XCTAssertEqual(FrameSchedule.defaultWorkers(cores: 16, frameCount: 2), 2)
        XCTAssertEqual(FrameSchedule(workers: 4, startFrame: 0, frameCount: 2).workers, 2, "never more workers than frames")
    }

    func testFrameTimeIsAFunctionOfTheFrameNumber() {
        XCTAssertEqual(videoFrameTimeMs(frame: 0, fps: 30), 0)
        XCTAssertEqual(videoFrameTimeMs(frame: 3, fps: 30), 100, accuracy: 1e-9)
        XCTAssertEqual(videoFrameTimeMs(frame: 59, fps: 60), 983.3333333333334, accuracy: 1e-9)
    }

    func testReorderBufferReleasesInOrder() {
        var b = ReorderBuffer<String>()
        XCTAssertEqual(b.insert(2, "c"), [])
        XCTAssertEqual(b.insert(1, "b"), [])
        XCTAssertEqual(b.pendingCount, 2)
        XCTAssertEqual(b.insert(0, "a"), ["a", "b", "c"])
        XCTAssertEqual(b.next, 3)
        XCTAssertEqual(b.insert(4, "e"), [])
        XCTAssertEqual(b.insert(3, "d"), ["d", "e"])
        XCTAssertEqual(b.pendingCount, 0)
    }

    func testPreviewIndicesSpreadAndStayInRange() {
        XCTAssertEqual(videoPreviewIndices(frameCount: 300, count: 3), [45, 150, 255])
        XCTAssertEqual(videoPreviewIndices(frameCount: 1, count: 3), [0])
        XCTAssertEqual(videoPreviewIndices(frameCount: 10, count: 1), [5])
        XCTAssertEqual(videoPreviewIndices(frameCount: 0, count: 3), [])
    }

    func testCodecs() {
        XCTAssertEqual(VideoCodec.hevcAlpha.rawValue, "hevc-alpha")
        XCTAssertEqual(VideoCodec.h264.fileExtension, "mp4")
        XCTAssertEqual(VideoCodec.prores4444.fileExtension, "mov")
        XCTAssertTrue(VideoCodec.hevcAlpha.carriesAlpha)
        XCTAssertFalse(VideoCodec.h264.carriesAlpha)
        XCTAssertGreaterThanOrEqual(VideoCodec.h264.averageBitRate(width: 1920, height: 1080, fps: 30), 12_000_000)
        XCTAssertGreaterThanOrEqual(VideoCodec.hevc.averageBitRate(width: 64, height: 64, fps: 1), 2_000_000)
    }

    @MainActor
    func testValidationExplainsWhatToDo() throws {
        func params(_ edit: (inout VideoExportParams) -> Void = { _ in }) -> VideoExportParams {
            var p = VideoExportParams(
                runId: "run-1", destination: "exports", suggestedName: "clip.mp4", codec: "h264", width: 320, height: 180, outWidth: 320, outHeight: 180,
                fps: 30, startFrame: 0, frameCount: 30, alpha: false, entry: "index.html", files: [VideoFile(path: "index.html", mime: "text/html", text: "x")]
            )
            edit(&p)
            return p
        }
        XCTAssertNoThrow(try VideoExportService.validate(params()))
        XCTAssertThrowsError(try VideoExportService.validate(params { $0.codec = "vp9" })) { XCTAssertTrue("\($0)".contains("codec must be")) }
        XCTAssertThrowsError(try VideoExportService.validate(params { $0.suggestedName = "clip.mov" })) { XCTAssertTrue("\($0)".contains("not a valid export file name")) }
        XCTAssertThrowsError(try VideoExportService.validate(params { $0.frameCount = 0 })) { XCTAssertTrue("\($0)".contains("no frames")) }
        XCTAssertThrowsError(try VideoExportService.validate(params { $0.entry = "stage.html" })) { XCTAssertTrue("\($0)".contains("stage page")) }
        XCTAssertThrowsError(try VideoExportService.validate(params { $0.runId = "a/b" })) { XCTAssertTrue("\($0)".contains("runId")) }
        XCTAssertThrowsError(try VideoExportService.validate(params { $0.codec = "gif"; $0.suggestedName = "a.gif"; $0.frameCount = 601 })) { XCTAssertTrue("\($0)".contains("GIF")) }
    }
}

/// Real WebKit rendering and real encoders on a tiny composition: a red box moving across a 320×180 page.
@MainActor
final class VideoExportServiceTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-video-test-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// A stage with the `__ocelotExport` contract: the box's x is a pure function of the time it is asked for.
    private let stage = """
    <!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}
    body{background:var(--bg,#fff)}#b{position:absolute;top:60px;width:40px;height:40px;background:#e33}</style></head>
    <body><div id="b"></div><script>
    window.__ocelotExport = { fps: 30, ready: async () => { await document.fonts.ready; },
      seek: async (t) => { document.getElementById('b').style.left = (t / 5) + 'px'; } };
    </script></body></html>
    """

    private func params(codec: String, name: String, frames: Int = 30, alpha: Bool = false, size: (Int, Int) = (320, 180), previews: Int? = nil) -> VideoExportParams {
        let html = alpha ? stage.replacingOccurrences(of: "background:var(--bg,#fff)", with: "background:transparent") : stage
        return VideoExportParams(
            runId: "test-\(UUID().uuidString.prefix(8))", destination: "exports", suggestedName: name, codec: codec, width: 320, height: 180,
            outWidth: size.0, outHeight: size.1, fps: 30, startFrame: 0, frameCount: frames, alpha: alpha, entry: "index.html",
            files: [VideoFile(path: "index.html", mime: "text/html; charset=utf-8", text: html)], previews: previews
        )
    }

    private func service(workers: Int? = nil, onProgress: (@MainActor (ExportProgressParams) -> Void)? = nil) -> VideoExportService {
        VideoExportService(VideoExportEnvironment(
            exportsFolder: { [folder = folder!] in
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                return folder
            },
            chooseFile: { _, _ in nil },
            progress: { onProgress?($0) },
            workers: workers
        ))
    }

    func testH264HasExpectedDurationRateCodecAndBT709Tags() async throws {
        let result = try await service().run(params(codec: "h264", name: "clip.mp4"))
        let url = URL(fileURLWithPath: result.files[0].path)
        XCTAssertEqual(result.frameHashes.count, 30)
        XCTAssertEqual(Set(result.frameHashes).count, 30, "the box moves every frame")
        XCTAssertEqual(result.previews.count, 3)

        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        XCTAssertEqual(duration, 1.0, accuracy: 0.05)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let rate = try await track.load(.nominalFrameRate)
        let size = try await track.load(.naturalSize)
        XCTAssertEqual(rate, 30, accuracy: 0.5)
        XCTAssertEqual(size, CGSize(width: 320, height: 180))
        let formats = try await track.load(.formatDescriptions)
        let format = try XCTUnwrap(formats.first)
        XCTAssertEqual(CMFormatDescriptionGetMediaSubType(format), kCMVideoCodecType_H264)
        let ext = CMFormatDescriptionGetExtensions(format) as? [String: Any] ?? [:]
        XCTAssertEqual(ext[kCVImageBufferColorPrimariesKey as String] as? String, kCVImageBufferColorPrimaries_ITU_R_709_2 as String)
        XCTAssertEqual(ext[kCVImageBufferTransferFunctionKey as String] as? String, kCVImageBufferTransferFunction_ITU_R_709_2 as String)
        XCTAssertEqual(ext[kCVImageBufferYCbCrMatrixKey as String] as? String, kCVImageBufferYCbCrMatrix_ITU_R_709_2 as String)
    }

    func testTwoRunsGiveIdenticalFrameHashes() async throws {
        let a = try await service(workers: 3).run(params(codec: "h264", name: "a.mp4"))
        let b = try await service(workers: 1).run(params(codec: "h264", name: "b.mp4"))
        XCTAssertEqual(a.frameHashes, b.frameHashes, "worker count must not change a single pixel")
        XCTAssertEqual(a.workers, 3)
        XCTAssertEqual(b.workers, 1)
    }

    func testRangeRendersOnlyTheRequestedFramesAtTheirTimes() async throws {
        let full = try await service().run(params(codec: "h264", name: "full.mp4"))
        var p = params(codec: "h264", name: "range.mp4", frames: 10)
        p.startFrame = 10
        let range = try await service().run(p)
        XCTAssertEqual(range.frameHashes, Array(full.frameHashes[10..<20]))
    }

    func testHEVCWithAlphaReportsAlpha() async throws {
        let result = try await service().run(params(codec: "hevc-alpha", name: "alpha.mov", frames: 12, alpha: true))
        let asset = AVURLAsset(url: URL(fileURLWithPath: result.files[0].path))
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let formats = try await track.load(.formatDescriptions)
        let format = try XCTUnwrap(formats.first)
        let ext = CMFormatDescriptionGetExtensions(format) as? [String: Any] ?? [:]
        XCTAssertEqual(ext["ContainsAlphaChannel"] as? Bool, true)
        XCTAssertEqual(CMFormatDescriptionGetMediaSubType(format), kCMVideoCodecType_HEVC, "hvc1 with an alpha channel extension")
    }

    func testProRes4444ReportsAlpha() async throws {
        let result = try await service().run(params(codec: "prores4444", name: "alpha.mov", frames: 6, alpha: true))
        let asset = AVURLAsset(url: URL(fileURLWithPath: result.files[0].path))
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let formats = try await track.load(.formatDescriptions)
        let format = try XCTUnwrap(formats.first)
        XCTAssertEqual(CMFormatDescriptionGetMediaSubType(format), kCMVideoCodecType_AppleProRes4444)
        let ext = CMFormatDescriptionGetExtensions(format) as? [String: Any] ?? [:]
        XCTAssertEqual(ext["ContainsAlphaChannel"] as? Bool, true)
    }

    func testGIFOpensWithOneImagePerFrame() async throws {
        let result = try await service().run(params(codec: "gif", name: "clip.gif", frames: 10, size: (160, 90)))
        let url = URL(fileURLWithPath: result.files[0].path)
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        XCTAssertEqual(CGImageSourceGetCount(source), 10)
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertEqual(image.width, 160)
        XCTAssertEqual(image.height, 90)
    }

    /// Lets the progress callback reach the service it belongs to.
    private final class ServiceHolder {
        var service: VideoExportService?
    }

    func testCancelLeavesNoFile() async throws {
        let holder = ServiceHolder()
        let p = params(codec: "h264", name: "never.mp4", frames: 600)
        let svc = service(onProgress: { [runId = p.runId] _ in holder.service?.cancel(runId: runId) })
        holder.service = svc
        let result = try await svc.run(p)
        XCTAssertEqual(result.cancelled, true)
        XCTAssertTrue(result.files.isEmpty)
        let left = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        XCTAssertEqual(left, [], "a cancelled export writes nothing")
    }

    func testBrokenCompositionFailsWithAMessage() async throws {
        var p = params(codec: "h264", name: "bad.mp4")
        p.files = [VideoFile(path: "index.html", mime: "text/html", text: "<!doctype html><body>no runtime</body>")]
        do {
            _ = try await service().run(p)
            XCTFail("expected a failure")
        } catch {
            XCTAssertTrue("\(error)".contains("__ocelotExport"), "\(error)")
        }
        XCTAssertEqual((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [], [])
    }
}

/// Renders a composition dumped by `editor/e2e/video-export.test.mjs` (`OCELOT_VIDEO_DUMP=/dir`): the real stage page, real artboard documents with
/// CSS, GSAP and three.js layers. Skipped unless `TEST_RUNNER_OCELOT_VIDEO_PARAMS=/path/params.json` is set; the result goes to
/// `TEST_RUNNER_OCELOT_VIDEO_RESULT` (default /tmp/ocelot-video-result.json).
@MainActor
final class VideoExportFixtureTests: XCTestCase {
    func testRenderCompositionFromEnvironment() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let path = env["OCELOT_VIDEO_PARAMS"], !path.isEmpty else { throw XCTSkip("set TEST_RUNNER_OCELOT_VIDEO_PARAMS to render a dumped composition") }
        let params = try JSONDecoder().decode(VideoExportParams.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-video-fixture", isDirectory: true)
        try? FileManager.default.removeItem(at: folder)
        let service = VideoExportService(VideoExportEnvironment(
            exportsFolder: { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true); return folder },
            chooseFile: { _, _ in nil }, progress: { _ in }, workers: env["OCELOT_VIDEO_WORKERS"].flatMap(Int.init)
        ))
        let result = try await service.run(params)
        let out = env["OCELOT_VIDEO_RESULT"] ?? "/tmp/ocelot-video-result.json"
        try JSONEncoder().encode(result).write(to: URL(fileURLWithPath: out))
        // Keep the file for ffprobe.
        if let file = result.files.first { try? FileManager.default.removeItem(atPath: "/tmp/\(file.name)"); try FileManager.default.copyItem(atPath: file.path, toPath: "/tmp/\(file.name)") }
        print("VIDEO \(result.files.first?.name ?? "-") frames=\(result.frameHashes.count) workers=\(result.workers) seconds=\(Double(result.elapsedMs) / 1000) fps=\(result.renderFps)")
        XCTAssertEqual(result.frameHashes.count, params.frameCount)
    }
}
