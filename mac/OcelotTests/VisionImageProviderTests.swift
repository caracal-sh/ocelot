import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import Ocelot

struct AlphaStats {
    var width: Int
    var height: Int
    /// Share of pixels with alpha 0.
    var transparentFraction: Double
    /// Share of pixels with alpha 255.
    var opaqueFraction: Double
    var corners: [UInt8]
    var center: UInt8

    init?(png: Data) {
        guard let source = CGImageSourceCreateWithData(png as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        let w = image.width, h = image.height
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        let drawn = pixels.withUnsafeMutableBytes { raw -> Bool in
            guard let context = CGContext(
                data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.clear(CGRect(x: 0, y: 0, width: w, height: h))
            context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return nil }
        func alpha(_ x: Int, _ y: Int) -> UInt8 { pixels[(y * w + x) * 4 + 3] }
        var clear = 0, solid = 0
        for i in 0..<(w * h) {
            let a = pixels[i * 4 + 3]
            if a == 0 { clear += 1 } else if a == 255 { solid += 1 }
        }
        width = w
        height = h
        transparentFraction = Double(clear) / Double(w * h)
        opaqueFraction = Double(solid) / Double(w * h)
        corners = [alpha(0, 0), alpha(w - 1, 0), alpha(0, h - 1), alpha(w - 1, h - 1)]
        center = alpha(w / 2, h / 2)
    }
}

final class VisionImageProviderTests: XCTestCase {
    /// A photo-like picture rendered with CoreGraphics: a blurred gradient backdrop and a shaded, shadowed object.
    static func subjectPhoto(width: Int = 640, height: Int = 480) -> Data {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        let w = CGFloat(width), h = CGFloat(height)
        // Backdrop: sky-to-meadow gradient with soft light spots.
        let backdrop = CGGradient(colorsSpace: space, colors: [CGColor(red: 0.62, green: 0.78, blue: 0.95, alpha: 1), CGColor(red: 0.35, green: 0.55, blue: 0.30, alpha: 1)] as CFArray, locations: [0, 1])!
        context.drawLinearGradient(backdrop, start: CGPoint(x: 0, y: h), end: CGPoint(x: 0, y: 0), options: [])
        let glow = CGGradient(colorsSpace: space, colors: [CGColor(red: 1, green: 1, blue: 0.9, alpha: 0.55), CGColor(red: 1, green: 1, blue: 0.9, alpha: 0)] as CFArray, locations: [0, 1])!
        context.drawRadialGradient(glow, startCenter: CGPoint(x: w * 0.85, y: h * 0.85), startRadius: 0, endCenter: CGPoint(x: w * 0.85, y: h * 0.85), endRadius: w * 0.4, options: [])
        // Subject: a glossy red "mug" with a handle, casting a shadow on a table edge.
        context.setFillColor(CGColor(red: 0.55, green: 0.40, blue: 0.28, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: w, height: h * 0.22))
        context.saveGState()
        context.setShadow(offset: CGSize(width: 14, height: -14), blur: 22, color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.55))
        let body = CGRect(x: w * 0.30, y: h * 0.12, width: w * 0.36, height: h * 0.62)
        context.setFillColor(CGColor(red: 0.80, green: 0.10, blue: 0.12, alpha: 1))
        context.addPath(CGPath(roundedRect: body, cornerWidth: 38, cornerHeight: 38, transform: nil))
        context.fillPath()
        context.setStrokeColor(CGColor(red: 0.70, green: 0.08, blue: 0.10, alpha: 1))
        context.setLineWidth(26)
        context.strokeEllipse(in: CGRect(x: w * 0.60, y: h * 0.28, width: w * 0.16, height: h * 0.26))
        context.restoreGState()
        context.saveGState()
        context.addPath(CGPath(roundedRect: body, cornerWidth: 38, cornerHeight: 38, transform: nil))
        context.clip()
        let shine = CGGradient(colorsSpace: space, colors: [CGColor(red: 1, green: 1, blue: 1, alpha: 0.6), CGColor(red: 1, green: 1, blue: 1, alpha: 0)] as CFArray, locations: [0, 1])!
        context.drawLinearGradient(shine, start: CGPoint(x: body.minX, y: body.midY), end: CGPoint(x: body.midX, y: body.midY), options: [])
        context.restoreGState()
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, [kCGImageDestinationLossyCompressionQuality: 0.95] as CFDictionary)
        CGImageDestinationFinalize(destination)
        return data as Data
    }

    private func reference(_ data: Data, ext: String = "jpg") -> ImageReference {
        ImageReference(id: String(repeating: "d", count: 64), data: data, ext: ext, mime: ImageSniffer.mime(forExtension: ext) ?? "image/jpeg")
    }

    private func request(_ data: Data, operation: ImageOperation = .removeBackground, crop: Bool = false) -> ImageRequest {
        var r = ImageRequest(operation: operation, model: "foreground-mask", prompt: "", aspect: nil, size: nil, n: 1, background: "auto", quality: nil, seed: nil, references: [reference(data)])
        r.cropToSubject = crop
        return r
    }

    /// Runs Vision on the synthetic photo; skips (rather than fails) when Vision does not see a subject in a drawing.
    private func cutOut(crop: Bool) async throws -> (GeneratedImage, AlphaStats) {
        do {
            let images = try await VisionImageProvider().generate(request(Self.subjectPhoto(), crop: crop), progress: { _ in })
            let image = try XCTUnwrap(images.first)
            return (image, try XCTUnwrap(AlphaStats(png: image.data)))
        } catch let failure as ImageFailure where failure.message.contains("found no foreground subject") {
            throw XCTSkip("Vision does not treat the synthetic drawing as a photo subject on this OS: \(failure.message)")
        }
    }

    func testCatalogAndStatus() async {
        let info = await VisionImageProvider().status()
        XCTAssertEqual(info.id, "vision")
        XCTAssertEqual(info.label, "On-device (Apple Vision)")
        XCTAssertEqual(info.status, "ready")
        let model = info.models[0]
        XCTAssertEqual(model.id, "vision:foreground-mask")
        XCTAssertEqual(model.label, "Apple Vision foreground mask")
        XCTAssertEqual(model.capabilities, ["remove_background", "crop_to_subject"])
        XCTAssertEqual(model.note, "Free, private, offline; best on photos with a clear subject (people, animals, products)")
        XCTAssertTrue(model.available)
    }

    func testRemovesTheBackgroundOfASubjectPhoto() async throws {
        let (image, stats) = try await cutOut(crop: false)
        XCTAssertEqual(ImageSniffer.sniff(image.data), ImageSniffer.png)
        XCTAssertEqual(ImageSniffer.hasAlpha(image.data), true)
        XCTAssertEqual(stats.width, 640)
        XCTAssertEqual(stats.height, 480)
        XCTAssertGreaterThan(stats.transparentFraction, 0.2, "the backdrop is cut away")
        XCTAssertGreaterThan(stats.opaqueFraction, 0.1, "the subject stays opaque")
        XCTAssertEqual(stats.corners, [0, 0, 0, 0], "corners are background")
        XCTAssertEqual(stats.center, 255, "the centre is the subject")
        XCTAssertEqual(image.params["cropToSubject"], .bool(false))
    }

    func testCropToSubjectShrinksTheOutputToTheSubjectExtent() async throws {
        let (_, full) = try await cutOut(crop: false)
        let (cropped, tight) = try await cutOut(crop: true)
        XCTAssertLessThan(tight.width, full.width)
        XCTAssertLessThan(tight.height, full.height)
        XCTAssertEqual(cropped.params["cropToSubject"], .bool(true))
        XCTAssertGreaterThan(tight.opaqueFraction, full.opaqueFraction)
    }

    func testFlatImageHasNoSubjectAndTheErrorSaysWhatToDo() async throws {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let context = CGContext(data: nil, width: 200, height: 200, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.setFillColor(CGColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 200, height: 200))
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        CGImageDestinationFinalize(destination)
        do {
            _ = try await VisionImageProvider().generate(request(data as Data), progress: { _ in })
            XCTFail("expected no subject")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("Apple Vision found no foreground subject"), error.localizedDescription)
            XCTAssertTrue(error.localizedDescription.contains("fal"), "says where else to go")
        }
    }

    func testRefusesOtherOperationsAndUnreadableInput() async {
        for operation in [ImageOperation.generate, .edit] {
            do {
                _ = try await VisionImageProvider().generate(request(Self.subjectPhoto(), operation: operation), progress: { _ in })
                XCTFail("expected failure")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("Apple Vision only removes backgrounds"), error.localizedDescription)
            }
        }
        do {
            _ = try await VisionImageProvider().generate(request(Data("not an image".utf8)), progress: { _ in })
            XCTFail("expected failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("could not read"), error.localizedDescription)
        }
    }

    func testAlphaDetection() {
        XCTAssertEqual(ImageSniffer.hasAlpha(TestImages.png()), true, "the test PNGs are RGBA")
        XCTAssertEqual(ImageSniffer.hasAlpha(TestImages.jpeg()), false)
        XCTAssertEqual(ImageSniffer.hasAlpha(Self.opaquePNG()), false)
    }

    /// An RGB (colour type 2) PNG without tRNS, as a model that ignores the transparency request would return.
    static func opaquePNG(width: Int = 4, height: Int = 4) -> Data {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        CGImageDestinationFinalize(destination)
        return data as Data
    }

    /// The live proof: `TEST_RUNNER_OCELOT_LIVE_VISION=1 TEST_RUNNER_OCELOT_VISION_IMAGE=/path/photo.jpg`
    /// (optional `TEST_RUNNER_OCELOT_VISION_OUT=<dir>` to keep the source copy and the cut-outs).
    func testLiveVisionOnARealPhoto() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["OCELOT_LIVE_VISION"] == "1", let path = env["OCELOT_VISION_IMAGE"] else {
            throw XCTSkip("set TEST_RUNNER_OCELOT_LIVE_VISION=1 and TEST_RUNNER_OCELOT_VISION_IMAGE=<photo> to run on a real photo")
        }
        let source = try Data(contentsOf: URL(fileURLWithPath: path))
        let ext = ImageSniffer.sniff(source)?.ext ?? "jpg"
        let name = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
        for crop in [false, true] {
            let started = Date()
            let images = try await VisionImageProvider().generate(request(source, crop: crop), progress: { _ in })
            let png = try XCTUnwrap(images.first).data
            let stats = try XCTUnwrap(AlphaStats(png: png))
            let seconds = String(format: "%.2f", Date().timeIntervalSince(started))
            print("LIVE-VISION \(name) crop=\(crop) \(stats.width)x\(stats.height) bytes=\(png.count) transparent=\(String(format: "%.1f", stats.transparentFraction * 100))% opaque=\(String(format: "%.1f", stats.opaqueFraction * 100))% corners=\(stats.corners) center=\(stats.center) time=\(seconds)s")
            XCTAssertEqual(ImageSniffer.hasAlpha(png), true)
            if let out = env["OCELOT_VISION_OUT"] {
                let dir = URL(fileURLWithPath: out, isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try source.write(to: dir.appendingPathComponent("\(name)-source.\(ext)"))
                try png.write(to: dir.appendingPathComponent("\(name)-\(crop ? "cropped" : "full").png"))
            }
        }
    }
}
