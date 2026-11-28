import CoreGraphics
import CoreText
import Foundation
import ImageIO
import PDFKit
import XCTest
@testable import Ocelot

/// PDFs built in memory with Core Graphics (the tests do not depend on files in the repo).
enum TestPdf {
    struct Page {
        var text: String?
        var size = CGSize(width: 612, height: 792)
        /// `/Rotate`, set through PDFKit after the PDF is drawn.
        var rotation = 0
        /// A black 100×100 square at the page's top-left corner before rotation.
        var cornerMark = false

        init(text: String?, size: CGSize = CGSize(width: 612, height: 792), rotation: Int = 0, cornerMark: Bool = false) {
            self.text = text
            self.size = size
            self.rotation = rotation
            self.cornerMark = cornerMark
        }
    }

    static func make(pages: [Page], password: String? = nil) -> Data {
        let data = NSMutableData()
        let consumer = CGDataConsumer(data: data as CFMutableData)!
        var aux: [String: Any] = [:]
        if let password {
            aux[kCGPDFContextUserPassword as String] = password
            aux[kCGPDFContextOwnerPassword as String] = password
        }
        var first = CGRect(origin: .zero, size: pages.first?.size ?? CGSize(width: 612, height: 792))
        let context = CGContext(consumer: consumer, mediaBox: &first, aux as CFDictionary)!
        for page in pages {
            var box = CGRect(origin: .zero, size: page.size)
            context.beginPage(mediaBox: &box)
            if page.cornerMark {
                context.setFillColor(CGColor(gray: 0, alpha: 1))
                context.fill(CGRect(x: 0, y: page.size.height - 100, width: 100, height: 100))
            }
            if let text = page.text {
                let font = CTFontCreateWithName("Helvetica" as CFString, 40, nil)
                let attributed = NSAttributedString(string: text, attributes: [
                    NSAttributedString.Key(kCTFontAttributeName as String): font,
                    NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true,
                ])
                context.textPosition = CGPoint(x: 72, y: page.size.height / 2)
                CTLineDraw(CTLineCreateWithAttributedString(attributed), context)
            }
            context.endPage()
        }
        context.closePDF()
        let bytes = data as Data
        guard pages.contains(where: { $0.rotation != 0 }), let document = PDFDocument(data: bytes) else { return bytes }
        for (index, page) in pages.enumerated() { document.page(at: index)?.rotation = page.rotation }
        return document.dataRepresentation() ?? bytes
    }
}

final class PdfReaderTests: XCTestCase {
    private func read(_ data: Data, maxPictures: Int = 8, maxEdge: Int = 1000) throws -> PdfContent {
        try PdfReader.read(ReadPdfParams(dataBase64: data.base64EncodedString(), maxPictures: maxPictures, maxEdge: maxEdge))
    }

    /// RGBA pixels, top row first, of a picture's JPEG.
    private func pixels(_ picture: PdfPicture) throws -> (width: Int, height: Int, rgba: [UInt8]) {
        let bytes = try XCTUnwrap(Data(base64Encoded: picture.dataBase64))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        var rgba = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        rgba.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return (image.width, image.height, rgba)
    }

    private func isWhite(_ p: (width: Int, height: Int, rgba: [UInt8]), x: Int, y: Int) -> Bool {
        let i = (y * p.width + x) * 4
        return p.rgba[i] > 245 && p.rgba[i + 1] > 245 && p.rgba[i + 2] > 245
    }

    private func isDark(_ p: (width: Int, height: Int, rgba: [UInt8]), x: Int, y: Int) -> Bool {
        let i = (y * p.width + x) * 4
        return p.rgba[i] < 90 && p.rgba[i + 1] < 90 && p.rgba[i + 2] < 90
    }

    private func hasDarkPixel(_ p: (width: Int, height: Int, rgba: [UInt8])) -> Bool {
        (0..<(p.width * p.height)).contains { p.rgba[$0 * 4] < 100 }
    }

    // MARK: Text and pictures

    func testReadsTheTextOfEveryPageAndPicturesOfTheFirstOnes() throws {
        let data = TestPdf.make(pages: [TestPdf.Page(text: "Brix Editions 1A2B3C"), TestPdf.Page(text: nil), TestPdf.Page(text: "Colophon")])
        let content = try read(data, maxPictures: 2, maxEdge: 1000)
        XCTAssertEqual(content.pageCount, 3)
        XCTAssertEqual(content.pages, ["Brix Editions 1A2B3C", "", "Colophon"])
        XCTAssertEqual(content.pictures.map(\.page), [1, 2])
        for picture in content.pictures {
            XCTAssertEqual(picture.mimeType, "image/jpeg")
            XCTAssertEqual(max(picture.width, picture.height), 1000)
            XCTAssertEqual(picture.height, 1000)
            XCTAssertEqual(picture.width, Int((612.0 * 1000 / 792).rounded()))
            let decoded = try pixels(picture)
            XCTAssertEqual(decoded.width, picture.width)
            XCTAssertEqual(decoded.height, picture.height)
            // Opaque white background in every corner.
            for (x, y) in [(0, 0), (decoded.width - 1, 0), (0, decoded.height - 1), (decoded.width - 1, decoded.height - 1)] {
                XCTAssertTrue(isWhite(decoded, x: x, y: y), "corner \(x),\(y) of page \(picture.page)")
            }
        }
        // The text is drawn on page 1 and the empty page stays blank.
        XCTAssertTrue(hasDarkPixel(try pixels(content.pictures[0])))
        XCTAssertFalse(hasDarkPixel(try pixels(content.pictures[1])))
    }

    func testNoPicturesWhenNoneAreWantedAndEveryTextIsStillRead() throws {
        let data = TestPdf.make(pages: [TestPdf.Page(text: "One"), TestPdf.Page(text: "Two")])
        let content = try read(data, maxPictures: 0)
        XCTAssertEqual(content.pages, ["One", "Two"])
        XCTAssertTrue(content.pictures.isEmpty)
    }

    func testPicturesAreCappedAtThePageCountAndTheRequestIsClamped() throws {
        let data = TestPdf.make(pages: [TestPdf.Page(text: "One"), TestPdf.Page(text: "Two")])
        let content = try read(data, maxPictures: 99, maxEdge: 10)
        XCTAssertEqual(content.pictures.map(\.page), [1, 2])
        // maxEdge 10 is raised to the 256 px floor.
        XCTAssertEqual(content.pictures.map { max($0.width, $0.height) }, [256, 256])
    }

    func testATinyPageIsNotBlownUpBeyondTwiceItsSize() throws {
        let data = TestPdf.make(pages: [TestPdf.Page(text: nil, size: CGSize(width: 100, height: 50))])
        let picture = try XCTUnwrap(try read(data, maxPictures: 1, maxEdge: 2000).pictures.first)
        XCTAssertEqual(picture.width, 200)
        XCTAssertEqual(picture.height, 100)
    }

    // MARK: Orientation

    func testALandscapePageGivesALandscapePicture() throws {
        let data = TestPdf.make(pages: [TestPdf.Page(text: "Wide", size: CGSize(width: 792, height: 612))])
        let picture = try XCTUnwrap(try read(data, maxPictures: 1).pictures.first)
        XCTAssertEqual(picture.width, 1000)
        XCTAssertEqual(picture.height, Int((612.0 * 1000 / 792).rounded()))
    }

    func testARotatedPageIsDrawnTurned() throws {
        let data = TestPdf.make(pages: [
            TestPdf.Page(text: "Turned", rotation: 90, cornerMark: true),
            TestPdf.Page(text: nil, rotation: 0, cornerMark: true),
        ])
        let content = try read(data, maxPictures: 2)
        let turned = content.pictures[0]
        // A portrait page turned by 90 degrees is landscape.
        XCTAssertEqual(turned.width, 1000)
        XCTAssertEqual(turned.height, Int((612.0 * 1000 / 792).rounded()))
        // The mark was at the top-left of the unturned page: a clockwise quarter turn carries it to the top-right.
        let decoded = try pixels(turned)
        XCTAssertTrue(isDark(decoded, x: decoded.width - 20, y: 20))
        XCTAssertTrue(isWhite(decoded, x: 20, y: 20))
        let upright = try pixels(content.pictures[1])
        XCTAssertTrue(isDark(upright, x: 20, y: 20))
        XCTAssertTrue(isWhite(upright, x: upright.width - 20, y: 20))
    }

    // MARK: Refusals

    func testAPasswordProtectedPDFSaysWhatToDo() throws {
        let data = TestPdf.make(pages: [TestPdf.Page(text: "Secret")], password: "pw")
        XCTAssertThrowsError(try read(data)) { XCTAssertEqual($0 as? PdfReader.Failure, PdfReader.locked) }
        XCTAssertEqual(PdfReader.locked.message, "This PDF is protected with a password. Open it in Preview, export a copy without the password, and attach that.")
    }

    func testBytesThatAreNotAPDFSayWhatToDo() throws {
        XCTAssertThrowsError(try read(Data("just some text".utf8))) { XCTAssertEqual($0 as? PdfReader.Failure, PdfReader.notAPdf) }
        XCTAssertEqual(PdfReader.notAPdf.message, "This file is not a PDF or it is damaged. Open it in Preview, export it as PDF again, and attach the copy.")
    }

    func testInvalidBase64IsRefused() {
        let params = ReadPdfParams(dataBase64: "***not base64***", maxPictures: 1, maxEdge: 1000)
        XCTAssertThrowsError(try PdfReader.read(params)) { XCTAssertEqual($0 as? PdfReader.Failure, PdfReader.notBase64) }
        XCTAssertEqual(PdfReader.notBase64.message, "The PDF could not be read. Attach it again.")
    }

    // MARK: Time

    func testReadingTwentyPagesWithEightPicturesIsQuick() throws {
        let data = TestPdf.make(pages: (1...20).map { TestPdf.Page(text: "Page \($0)") })
        let start = ContinuousClock.now
        let content = try read(data, maxPictures: 8, maxEdge: 1600)
        let elapsed = ContinuousClock.now - start
        print("PdfReader: 20 pages, 8 pictures at 1600 px in \(elapsed)")
        XCTAssertEqual(content.pageCount, 20)
        XCTAssertEqual(content.pages.last, "Page 20")
        XCTAssertEqual(content.pictures.count, 8)
        XCTAssertLessThan(elapsed, .seconds(10))
    }
}
