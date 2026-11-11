import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

/// On-device background removal with Apple Vision's foreground instance mask: free, private, offline.
/// Only the `remove_background` operation; the source image never leaves the Mac.
struct VisionImageProvider: ImageProvider {
    let id = "vision"
    let label = "On-device (Apple Vision)"
    static let modelId = "foreground-mask"

    private var model: ImageModelInfo {
        ImageModelInfo(
            id: "vision:\(Self.modelId)", provider: "vision", model: Self.modelId, label: "Apple Vision foreground mask",
            capabilities: ["remove_background", "crop_to_subject"], aspects: nil, maxN: 1, cost: "Free",
            note: "Free, private, offline; best on photos with a clear subject (people, animals, products)",
            available: true, unavailableReason: nil
        )
    }

    func status() async -> ImageProviderInfo {
        ImageProviderInfo(
            id: id, label: label, status: "ready", detail: "Runs on this Mac: no account, key or network.",
            models: [model], keyStored: nil, setup: nil
        )
    }

    func rejectionHint(for operation: ImageOperation) -> String? {
        operation == .removeBackground ? nil : "Apple Vision only removes backgrounds"
    }

    func warnings(for request: ImageRequest) -> [String] {
        request.n > 1 ? ["Background removal returns one image; n was ignored."] : []
    }

    func generate(_ request: ImageRequest, progress: @escaping ImageProgressHandler) async throws -> [GeneratedImage] {
        guard request.operation == .removeBackground else {
            throw ImageFailure("Apple Vision only removes backgrounds. Use operation remove_background with a source image, or pick another model for generate and edit (list_image_models).")
        }
        guard let source = request.references.first else {
            throw ImageFailure("Apple Vision needs the source image in `references`.")
        }
        progress(ImageProgressUpdate(stage: "running", message: "Finding the subject with Apple Vision…", fraction: nil))
        let crop = request.cropToSubject
        let data = source.data
        let output = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Output, any Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(with: Result { try Self.removeBackground(from: data, crop: crop) })
            }
        }
        try Task.checkCancellation()
        var image = GeneratedImage(data: output.png)
        image.params["cropToSubject"] = .bool(crop)
        image.params["foregroundInstances"] = .number(Double(output.instances))
        image.params["onDevice"] = .bool(true)
        return [image]
    }

    struct Output: Sendable {
        var png: Data
        var instances: Int
    }

    /// The whole job, synchronous: decode (EXIF orientation applied), Vision mask, PNG with alpha.
    static func removeBackground(from data: Data, crop: Bool) throws -> Output {
        guard let cgImage = decode(data) else {
            throw ImageFailure("Apple Vision could not read the source image. Use a PNG, JPEG, WebP or HEIC image.")
        }
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        let request = VNGenerateForegroundInstanceMaskRequest()
        do {
            try handler.perform([request])
        } catch {
            throw ImageFailure("Apple Vision could not analyse the image (\(error.localizedDescription)). Try another image, or pass provider fal / a fal key (fal:fal-ai/birefnet/v2).")
        }
        guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
            throw ImageFailure("Apple Vision found no foreground subject in this image. Try a photo with a clear subject (a person, animal or product), or pass provider fal with a fal key (fal:fal-ai/birefnet/v2 or fal:fal-ai/bria/background/remove).")
        }
        let buffer: CVPixelBuffer
        do {
            buffer = try observation.generateMaskedImage(ofInstances: observation.allInstances, from: handler, croppedToInstancesExtent: crop)
        } catch {
            throw ImageFailure("Apple Vision found a subject but could not cut it out (\(error.localizedDescription)). Try another image, or pass provider fal with a fal key.")
        }
        let ciImage = CIImage(cvPixelBuffer: buffer)
        let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        let context = CIContext(options: [.workingColorSpace: space])
        guard let masked = context.createCGImage(ciImage, from: ciImage.extent, format: .RGBA8, colorSpace: space) else {
            throw ImageFailure("Could not render the cut-out image. Try again with a smaller image.")
        }
        let png = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(png, UTType.png.identifier as CFString, 1, nil) else {
            throw ImageFailure("Could not encode the cut-out as PNG.")
        }
        CGImageDestinationAddImage(destination, masked, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw ImageFailure("Could not encode the cut-out as PNG.")
        }
        return Output(png: png as Data, instances: observation.allInstances.count)
    }

    /// Full-resolution CGImage with the EXIF orientation applied.
    static func decode(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(w, h),
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}
