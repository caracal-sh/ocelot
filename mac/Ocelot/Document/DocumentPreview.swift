import AppKit
import Foundation

/// Turns the editor's first-artboard render into the small `preview.png` kept in the package.
@MainActor
enum DocumentPreview {
    /// `png` (the artboard at 1x) scaled down to fit `maxSide` px on its longer side; smaller images stay as rendered.
    static func thumbnail(from png: Data, maxSide: Int = DocumentPackage.previewMaxSide) -> Data? {
        guard let rep = NSBitmapImageRep(data: png), rep.pixelsWide > 0, rep.pixelsHigh > 0 else { return nil }
        let width = rep.pixelsWide, height = rep.pixelsHigh
        guard max(width, height) > maxSide else { return png }
        let scale = Double(maxSide) / Double(max(width, height))
        let image = NSImage(size: NSSize(width: width, height: height))
        image.addRepresentation(rep)
        return OffscreenRenderer.pngData(
            image,
            pixelsWide: max(1, Int((Double(width) * scale).rounded())),
            pixelsHigh: max(1, Int((Double(height) * scale).rounded()))
        )
    }
}
