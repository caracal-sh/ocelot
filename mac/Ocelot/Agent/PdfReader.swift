import CoreGraphics
import Foundation
import ImageIO
import PDFKit
import UniformTypeIdentifiers

/// `host.readPdf`: the text of every page and a picture of the first few, read with PDFKit. The editor sends the PDF's bytes
/// (a chip in the agent sidebar, or a file from Home) and builds the agent's message from what comes back; the pictures are
/// only for the agent to look at and are not stored. CPU work: callers run it off the main actor, and a `PDFDocument` never
/// leaves the call that made it (it is not `Sendable`).
enum PdfReader {
    /// A sentence that says what to do next; it reaches the person as the chip's error.
    struct Failure: LocalizedError, Sendable, Equatable {
        let message: String
        var errorDescription: String? { message }
    }

    static let notAPdf = Failure(message: "This file is not a PDF or it is damaged. Open it in Preview, export it as PDF again, and attach the copy.")
    static let locked = Failure(message: "This PDF is protected with a password. Open it in Preview, export a copy without the password, and attach that.")
    static let noPages = Failure(message: "This PDF has no pages.")
    static let notBase64 = Failure(message: "The PDF could not be read. Attach it again.")

    /// The editor asks for at most this many page pictures, whatever its limit is.
    static let pictureLimit = 0...20
    static let edgeLimit = 256...2048
    static let jpegQuality = 0.85
    /// A page is never drawn larger than this multiple of its size in points (a tiny page is not blown up).
    static let maxScale: CGFloat = 2

    // MARK: Host method

    static func read(_ params: ReadPdfParams) throws -> PdfContent {
        guard let data = Data(base64Encoded: params.dataBase64) else { throw notBase64 }
        let document = try open(data: data)
        let pageCount = document.pageCount
        // Result types spelled out: Xcode 26's Swift cannot infer `autoreleasepool`'s generic result from these closures.
        let pages: [String] = (0..<pageCount).map { index in
            autoreleasepool { () -> String in (document.page(at: index)?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        let wanted = min(max(params.maxPictures, pictureLimit.lowerBound), pictureLimit.upperBound)
        let edge = min(max(params.maxEdge, edgeLimit.lowerBound), edgeLimit.upperBound)
        var pictures: [PdfPicture] = []
        for index in 0..<min(wanted, pageCount) {
            let picture: PdfPicture? = autoreleasepool { () -> PdfPicture? in
                guard let page = document.page(at: index) else { return nil }
                return Self.picture(of: page, number: index + 1, maxEdge: edge)
            }
            if let picture { pictures.append(picture) }
        }
        return PdfContent(pageCount: pageCount, pages: pages, pictures: pictures)
    }

    /// The page count of a PDF on disk, or the reason it cannot be attached (Home's chip).
    static func pageCount(of url: URL) throws -> Int {
        guard let document = PDFDocument(url: url) else { throw notAPdf }
        try check(document)
        return document.pageCount
    }

    private static func open(data: Data) throws -> PDFDocument {
        guard let document = PDFDocument(data: data) else { throw notAPdf }
        try check(document)
        return document
    }

    /// A password-protected PDF reports no pages until it is unlocked; one that only restricts printing or copying opens with
    /// the empty password.
    private static func check(_ document: PDFDocument) throws {
        if document.isLocked, !document.unlock(withPassword: "") { throw locked }
        if document.pageCount == 0 { throw noPages }
    }

    // MARK: Pictures

    /// The page's crop box with its rotation applied, on an opaque white sRGB background, as a JPEG whose long edge is `maxEdge`
    /// pixels (at most `maxScale` times the size in points).
    static func picture(of page: PDFPage, number: Int, maxEdge: Int) -> PdfPicture? {
        guard let ref = page.pageRef else { return nil }
        let box = ref.getBoxRect(.cropBox)
        // `/Rotate` turns the page by quarter turns; the drawing transform below applies it, so the size is the turned one.
        let quarter = ((ref.rotationAngle % 360) + 360) % 360 / 90
        let turned = quarter % 2 == 1
        let width = turned ? box.height : box.width
        let height = turned ? box.width : box.height
        guard width > 0, height > 0, width.isFinite, height.isFinite else { return nil }
        let scale = min(CGFloat(maxEdge) / max(width, height), maxScale)
        let pixelsWide = max(1, Int((width * scale).rounded()))
        let pixelsHigh = max(1, Int((height * scale).rounded()))

        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil, width: pixelsWide, height: pixelsHigh, bitsPerComponent: 8, bytesPerRow: 0,
                  space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        let target = CGRect(x: 0, y: 0, width: pixelsWide, height: pixelsHigh)
        context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        context.fill(target)
        context.interpolationQuality = .high
        // An explicit transform: `getDrawingTransform` never scales up and so left small pages in a corner. Points of the crop
        // box go to (0, 0)…(w, h), then turn clockwise by `/Rotate` (y up), then scale to pixels.
        let w = box.width, h = box.height
        let turn: CGAffineTransform = switch quarter {
        case 1: CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: w)
        case 2: CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: w, ty: h)
        case 3: CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: h, ty: 0)
        default: .identity
        }
        context.scaleBy(x: CGFloat(pixelsWide) / width, y: CGFloat(pixelsHigh) / height)
        context.concatenate(turn)
        context.translateBy(x: -box.minX, y: -box.minY)
        context.clip(to: box)
        context.drawPDFPage(ref)

        guard let image = context.makeImage() else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return PdfPicture(page: number, width: pixelsWide, height: pixelsHigh, mimeType: "image/jpeg", dataBase64: (out as Data).base64EncodedString())
    }
}
