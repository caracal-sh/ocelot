import Foundation
import ImageIO

/// Identifies image bytes by their magic numbers (never by file name) and reads pixel sizes.
enum ImageSniffer {
    struct Kind: Sendable, Equatable {
        let ext: String
        let mime: String
    }

    static let png = Kind(ext: "png", mime: "image/png")
    static let jpeg = Kind(ext: "jpg", mime: "image/jpeg")
    static let webp = Kind(ext: "webp", mime: "image/webp")
    static let gif = Kind(ext: "gif", mime: "image/gif")
    static let avif = Kind(ext: "avif", mime: "image/avif")
    static let svg = Kind(ext: "svg", mime: "image/svg+xml")

    static let supportedExtensions = ["png", "jpg", "webp", "gif", "svg", "avif"]

    static func mime(forExtension ext: String) -> String? {
        [png, jpeg, webp, gif, avif, svg].first { $0.ext == ext }?.mime
    }

    /// PNG, JPEG, WebP, GIF, AVIF or SVG; nil for anything else.
    static func sniff(_ data: Data) -> Kind? {
        let b = [UInt8](data.prefix(32))
        guard b.count >= 4 else { return nil }
        if b.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return png }
        if b.starts(with: [0xFF, 0xD8, 0xFF]) { return jpeg }
        if b.starts(with: Array("GIF8".utf8)) { return gif }
        if b.count >= 12, b.starts(with: Array("RIFF".utf8)), Array(b[8..<12]) == Array("WEBP".utf8) { return webp }
        if b.count >= 12, Array(b[4..<8]) == Array("ftyp".utf8) {
            // ISO-BMFF: major brand avif/avis, or avif among the compatible brands.
            let head = String(decoding: data.prefix(64), as: UTF8.self)
            let brand = String(decoding: b[8..<12], as: UTF8.self)
            if brand == "avif" || brand == "avis" || head.contains("avif") || head.contains("avis") { return avif }
            return nil
        }
        return isSVG(data) ? svg : nil
    }

    private static func isSVG(_ data: Data) -> Bool {
        var head = data.prefix(4096)
        if head.starts(with: [0xEF, 0xBB, 0xBF]) { head = head.dropFirst(3) }
        guard let text = String(data: head, encoding: .utf8) ?? String(data: head, encoding: .isoLatin1) else { return false }
        let trimmed = text.drop { $0.isWhitespace }
        guard trimmed.hasPrefix("<") else { return false }
        return text.range(of: "<svg", options: [.caseInsensitive]) != nil
    }

    /// Whether the image carries transparency; nil when it cannot be told. PNG: colour type 4/6, or a `tRNS`
    /// chunk; other formats: ImageIO's `HasAlpha`.
    static func hasAlpha(_ data: Data) -> Bool? {
        let bytes = [UInt8](data.prefix(64 * 1024))
        if bytes.count >= 33, bytes.starts(with: [0x89, 0x50, 0x4E, 0x47]) {
            let colorType = bytes[25]
            if colorType == 4 || colorType == 6 { return true }
            // Walk chunks until IDAT: tRNS must precede it.
            var offset = 8
            while offset + 8 <= bytes.count {
                let length = Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16 | Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
                let type = String(decoding: bytes[(offset + 4)..<(offset + 8)], as: UTF8.self)
                if type == "tRNS" { return true }
                if type == "IDAT" || type == "IEND" { return false }
                offset += 12 + length
            }
            return false
        }
        if sniff(data) == jpeg { return false }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let alpha = props[kCGImagePropertyHasAlpha] as? Bool
        else { return nil }
        return alpha
    }

    /// Pixel size via ImageIO (bitmap formats) or the SVG root attributes (best effort). Nil when unknown.
    static func pixelSize(of data: Data, kind: Kind) -> (width: Int, height: Int)? {
        if kind == svg { return svgSize(data) }
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, options),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [CFString: Any],
              let w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              w > 0, h > 0
        else { return nil }
        return (w, h)
    }

    /// `width`/`height` on the root element (px or unitless), else the `viewBox` extent.
    static func svgSize(_ data: Data) -> (width: Int, height: Int)? {
        let head = data.prefix(16 * 1024)
        guard let text = String(data: head, encoding: .utf8) ?? String(data: head, encoding: .isoLatin1),
              let open = text.range(of: "<svg", options: .caseInsensitive),
              let close = text[open.lowerBound...].firstIndex(of: ">")
        else { return nil }
        let tag = String(text[open.lowerBound..<close])
        func attribute(_ name: String) -> String? {
            guard let regex = try? NSRegularExpression(pattern: "\\s\(name)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", options: [.caseInsensitive]),
                  let match = regex.firstMatch(in: tag, range: NSRange(tag.startIndex..., in: tag))
            else { return nil }
            for group in 1...2 {
                if let r = Range(match.range(at: group), in: tag) { return String(tag[r]) }
            }
            return nil
        }
        func length(_ raw: String?) -> Int? {
            guard var s = raw?.trimmingCharacters(in: .whitespaces).lowercased(), !s.isEmpty, !s.hasSuffix("%") else { return nil }
            if s.hasSuffix("px") { s.removeLast(2) }
            guard let v = Double(s), v > 0, v.isFinite else { return nil }
            return max(1, Int(v.rounded()))
        }
        if let w = length(attribute("width")), let h = length(attribute("height")) { return (w, h) }
        if let box = attribute("viewBox") {
            let parts = box.split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
            if parts.count == 4, parts[2] > 0, parts[3] > 0 { return (max(1, Int(parts[2].rounded())), max(1, Int(parts[3].rounded()))) }
        }
        return nil
    }
}
