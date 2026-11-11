import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The encoding half of video export: BGRA pixel buffers in frame order → a movie file (AVAssetWriter) or an animated GIF
/// (ImageIO). The capture half is `VideoExportService`.

struct VideoEncodingError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

/// One captured frame, handed from a capture worker to the pipeline. CGImage is immutable and thread-safe.
struct CapturedFrame: @unchecked Sendable {
    let index: Int
    let image: CGImage
}

/// An encoder-ready frame. CVPixelBuffer is a reference type that is only mutated before it is handed over.
struct VideoFrame: @unchecked Sendable {
    let index: Int
    let pixelBuffer: CVPixelBuffer
}

/// Where ordered frames go. `append` is called from one task, in frame order.
protocol VideoFrameSink: AnyObject, Sendable {
    func append(_ frame: VideoFrame) async throws
    /// Finalizes the file. After this the file at the sink's URL is complete.
    func finish() async throws
    /// Abandons the file (the caller deletes it).
    func cancel()
}

// MARK: Pixel buffers

/// BGRA buffers tagged BT.709, recycled between frames.
final class VideoPixelBufferPool: @unchecked Sendable {
    private var pool: CVPixelBufferPool?
    let width: Int
    let height: Int

    init(width: Int, height: Int) throws {
        self.width = width
        self.height = height
        let attributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey: width,
            kCVPixelBufferHeightKey: height,
            kCVPixelBufferIOSurfacePropertiesKey: [String: Any](),
            kCVPixelBufferMetalCompatibilityKey: true,
        ]
        var created: CVPixelBufferPool?
        guard CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &created) == kCVReturnSuccess, let created else {
            throw VideoEncodingError(message: "Could not allocate video frame buffers for \(width)×\(height). Lower the resolution (preset 1080p or 720p) and try again.")
        }
        pool = created
    }

    func makeBuffer() throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        guard let pool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let buffer else {
            throw VideoEncodingError(message: "Out of memory while allocating a video frame. Close other apps or lower the resolution, then try again.")
        }
        CVBufferSetAttachment(buffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(buffer, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(buffer, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
        return buffer
    }

    /// Draws `image` over the whole buffer (colour-converted to sRGB, premultiplied BGRA), replacing what was there.
    static func fill(_ buffer: CVPixelBuffer, from image: CGImage) throws {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer), let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(
                data: base, width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer), bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { throw VideoEncodingError(message: "Could not draw a frame into the encoder's buffer. Try again.") }
        ctx.setBlendMode(.copy)
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: ctx.width, height: ctx.height))
    }

    /// SHA-256 of the visible pixels (row padding excluded), first 8 bytes as hex: the frame's identity for determinism checks.
    static func hash(_ buffer: CVPixelBuffer) -> String {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return "" }
        let rowBytes = CVPixelBufferGetWidth(buffer) * 4
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        var hasher = SHA256()
        for row in 0..<CVPixelBufferGetHeight(buffer) {
            hasher.update(bufferPointer: UnsafeRawBufferPointer(start: base + row * stride, count: rowBytes))
        }
        return hasher.finalize().prefix(8).map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: AVAssetWriter

/// H.264 / HEVC (`.mp4`), ProRes 4444 and HEVC with alpha (`.mov`), BT.709 tagged, 1 frame = 1/fps.
final class AssetWriterSink: VideoFrameSink, @unchecked Sendable {
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let fps: Int32

    init(url: URL, codec: VideoCodec, width: Int, height: Int, fps: Int) throws {
        precondition(codec != .gif)
        self.fps = Int32(fps)
        writer = try AVAssetWriter(outputURL: url, fileType: codec.fileExtension == "mp4" ? .mp4 : .mov)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: Self.outputSettings(codec: codec, width: width, height: height, fps: fps))
        input.expectsMediaDataInRealTime = false
        adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height]
        )
        guard writer.canAdd(input) else {
            throw VideoEncodingError(message: "This Mac cannot encode \(codec.rawValue) at \(width)×\(height). Pick H.264 or a smaller preset.")
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw VideoEncodingError(message: "Could not start writing the video: \(writer.error?.localizedDescription ?? "unknown error"). Check the destination folder and try again.")
        }
        writer.startSession(atSourceTime: .zero)
    }

    static func outputSettings(codec: VideoCodec, width: Int, height: Int, fps: Int) -> [String: Any] {
        var settings: [String: Any] = [
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ]
        switch codec {
        case .h264:
            settings[AVVideoCodecKey] = AVVideoCodecType.h264
            settings[AVVideoCompressionPropertiesKey] = [
                AVVideoAverageBitRateKey: codec.averageBitRate(width: width, height: height, fps: fps),
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalKey: fps * 2,
            ]
        case .hevc, .hevcAlpha:
            settings[AVVideoCodecKey] = codec == .hevc ? AVVideoCodecType.hevc : AVVideoCodecType.hevcWithAlpha
            settings[AVVideoCompressionPropertiesKey] = [
                AVVideoAverageBitRateKey: codec.averageBitRate(width: width, height: height, fps: fps),
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalKey: fps * 2,
            ]
        case .prores4444:
            settings[AVVideoCodecKey] = AVVideoCodecType.proRes4444
        case .gif:
            preconditionFailure("GIF has its own sink")
        }
        return settings
    }

    func append(_ frame: VideoFrame) async throws {
        while !input.isReadyForMoreMediaData {
            if writer.status == .failed { throw failure() }
            try await Task.sleep(for: .milliseconds(2))
        }
        guard adaptor.append(frame.pixelBuffer, withPresentationTime: CMTime(value: CMTimeValue(frame.index), timescale: fps)) else { throw failure() }
    }

    func finish() async throws {
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw failure() }
    }

    func cancel() {
        if writer.status == .writing { writer.cancelWriting() }
    }

    private func failure() -> VideoEncodingError {
        VideoEncodingError(message: "The video encoder stopped: \(writer.error?.localizedDescription ?? "unknown error"). Try H.264, a smaller preset, or another destination folder.")
    }
}

// MARK: GIF

/// Animated GIF through ImageIO (no ffmpeg in the app): global loop, one delay per frame.
final class GIFSink: VideoFrameSink, @unchecked Sendable {
    private let destination: CGImageDestination
    private let delay: Double
    private let width: Int
    private let height: Int

    init(url: URL, width: Int, height: Int, fps: Int) throws {
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.gif.identifier as CFString, Int.max, nil) else {
            throw VideoEncodingError(message: "Could not create the GIF at \(url.path). Check the destination folder and try again.")
        }
        self.destination = destination
        self.width = width
        self.height = height
        delay = 1.0 / Double(fps)
        CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
    }

    func append(_ frame: VideoFrame) async throws {
        let buffer = frame.pixelBuffer
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw VideoEncodingError(message: "A frame had no pixels. Try again.") }
        // ImageIO keeps the image until the GIF is finalized: copy out of the recycled buffer.
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        let data = Data(bytes: base, count: stride * height)
        guard let provider = CGDataProvider(data: data as CFData), let space = CGColorSpace(name: CGColorSpace.sRGB),
              let image = CGImage(
                width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: stride, space: space,
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
        else { throw VideoEncodingError(message: "Could not read a frame for the GIF. Try again.") }
        let props = [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay, kCGImagePropertyGIFUnclampedDelayTime: delay]]
        CGImageDestinationAddImage(destination, image, props as CFDictionary)
    }

    func finish() async throws {
        guard CGImageDestinationFinalize(destination) else {
            throw VideoEncodingError(message: "ImageIO could not write the GIF. Try a shorter clip or a smaller size (GIF 960).")
        }
    }

    func cancel() {}
}
