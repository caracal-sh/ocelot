import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import Ocelot

/// Canned HTTP for provider tests: every request through a session using this protocol class is answered by
/// `StubURLProtocol.router`, and recorded.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    struct Reply {
        var status = 200
        var headers: [String: String] = [:]
        var body = Data()
        var chunk = 64 * 1024
        /// Deliver the headers but never the body (a stalled response).
        var stall = false

        static func json(_ object: Any, status: Int = 200) -> Reply {
            Reply(status: status, headers: ["Content-Type": "application/json"], body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
        }
    }

    struct Recorded: Sendable {
        var method: String
        var url: URL
        var headers: [String: String]
        var body: Data

        var json: [String: Any]? { (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] }
    }

    final class Router: @unchecked Sendable {
        private let lock = NSLock()
        private var _handler: ((Recorded) -> Reply)?
        private var _requests: [Recorded] = []

        var handler: ((Recorded) -> Reply)? {
            get { lock.lock(); defer { lock.unlock() }; return _handler }
            set { lock.lock(); _handler = newValue; lock.unlock() }
        }

        var requests: [Recorded] { lock.lock(); defer { lock.unlock() }; return _requests }

        func record(_ r: Recorded) { lock.lock(); _requests.append(r); lock.unlock() }

        func reset() { lock.lock(); _handler = nil; _requests = []; lock.unlock() }
    }

    static let router = Router()

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 16 * 1024)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                body.append(buffer, count: n)
            }
            stream.close()
        }
        var headers: [String: String] = [:]
        for (k, v) in request.allHTTPHeaderFields ?? [:] { headers[k] = v }
        let recorded = Recorded(method: request.httpMethod ?? "GET", url: request.url!, headers: headers, body: body)
        Self.router.record(recorded)
        let reply = Self.router.handler?(recorded) ?? Reply(status: 599, body: Data("no stub".utf8))
        var responseHeaders = reply.headers
        if !reply.stall, responseHeaders["Content-Length"] == nil, responseHeaders["X-Chunked"] == nil { responseHeaders["Content-Length"] = String(reply.body.count) }
        responseHeaders["X-Chunked"] = nil
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: responseHeaders)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if reply.stall { return }
        var offset = 0
        while offset < reply.body.count {
            let end = min(reply.body.count, offset + reply.chunk)
            client?.urlProtocol(self, didLoad: reply.body.subdata(in: offset..<end))
            offset = end
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

enum TestImages {
    /// A real PNG of the given size (solid color), encoded by ImageIO.
    static func png(width: Int = 3, height: Int = 2, red: UInt8 = 200) -> Data {
        encode(width: width, height: height, red: red, type: UTType.png)
    }

    static func jpeg(width: Int = 5, height: Int = 4) -> Data {
        encode(width: width, height: height, red: 90, type: UTType.jpeg)
    }

    private static func encode(width: Int, height: Int, red: UInt8, type: UTType) -> Data {
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for i in 0..<(width * height) {
            pixels[i * 4] = red
            pixels[i * 4 + 1] = UInt8(i % 256)
            pixels[i * 4 + 2] = 40
            pixels[i * 4 + 3] = 255
        }
        let context = pixels.withUnsafeMutableBytes {
            CGContext(
                data: $0.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        }
        let image = context!.makeImage()!
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, image, nil)
        CGImageDestinationFinalize(destination)
        return data as Data
    }

    static let svg = Data(#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="120px" height="80" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>"#.utf8)
    static let svgViewBoxOnly = Data(#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"></svg>"#.utf8)
    static let gifHeader = Data("GIF89a".utf8) + Data(repeating: 0, count: 20)
    static let webpHeader = Data("RIFF".utf8) + Data([0, 0, 0, 0]) + Data("WEBPVP8 ".utf8) + Data(repeating: 0, count: 8)
    static let avifHeader = Data([0, 0, 0, 24]) + Data("ftypavif".utf8) + Data([0, 0, 0, 0]) + Data("mif1avif".utf8)
}

func makeTempDirectory(_ name: String = "ocelot-assets-tests") throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

/// Awaits `condition` becoming true (polling), failing the test after `timeout`.
func waitUntil(timeout: TimeInterval = 5, _ message: String = "condition", _ condition: @Sendable () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > deadline { XCTFail("Timed out waiting for \(message)"); return }
        try await Task.sleep(for: .milliseconds(20))
    }
}
