import Foundation

/// One parsed HTTP/1.1 request.
struct HTTPRequestMessage: Sendable, Equatable {
    var method: String
    var path: String
    var version: String
    /// Header names lowercased.
    var headers: [String: String]
    var body: Data

    func header(_ name: String) -> String? { headers[name.lowercased()] }

    var keepAlive: Bool {
        let connection = header("connection")?.lowercased()
        if version == "HTTP/1.0" { return connection == "keep-alive" }
        return connection != "close"
    }
}

/// Incremental HTTP/1.1 request parser (Content-Length and chunked bodies).
/// Pure value type so it can be unit-tested without sockets.
struct HTTPRequestParser {
    enum Failure: Error, Equatable {
        case malformed(String)
        case headersTooLarge
        case bodyTooLarge
    }

    static let maxHeaderBytes = 32 * 1024
    static let maxBodyBytes = 32 * 1024 * 1024
    /// Raw bytes held for one request: headers, the body and chunk framing (a body sent as 1-byte chunks is
    /// six times its size on the wire). A peer cannot make the parser buffer more than this.
    static let maxBufferedBytes = maxHeaderBytes + 2 * maxBodyBytes
    /// A chunk-size line (hex digits and extensions) longer than this is not HTTP.
    static let maxChunkLineBytes = 1024

    private var buffer = Data()

    mutating func append(_ data: Data) { buffer.append(data) }

    /// Returns the next complete request, nil if more bytes are needed.
    mutating func next() throws(Failure) -> HTTPRequestMessage? {
        if buffer.count > Self.maxBufferedBytes { throw .bodyTooLarge }
        guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
            if buffer.count > Self.maxHeaderBytes { throw .headersTooLarge }
            return nil
        }
        guard let head = String(data: buffer[buffer.startIndex..<headerEnd.lowerBound], encoding: .utf8) else {
            throw .malformed("Headers are not UTF-8.")
        }
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
        guard requestLine.count == 3 else { throw .malformed("Bad request line.") }
        var headers: [String: String] = [:]
        for line in lines where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { throw .malformed("Bad header line.") }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = headers[name].map { "\($0), \(value)" } ?? value
        }
        let bodyStart = headerEnd.upperBound
        var body = Data()
        var consumedEnd = bodyStart

        if headers["transfer-encoding"]?.lowercased().contains("chunked") == true {
            var cursor = bodyStart
            while true {
                guard let lineEnd = buffer[cursor...].range(of: Data("\r\n".utf8)) else {
                    if buffer.endIndex - cursor > Self.maxChunkLineBytes { throw .malformed("Bad chunk size.") }
                    return nil
                }
                let sizeText = String(decoding: buffer[cursor..<lineEnd.lowerBound], as: UTF8.self)
                    .split(separator: ";", omittingEmptySubsequences: false).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
                // Hex digits only: `Int(_:radix:)` would also take "-5" and "+5". More than 8 digits is
                // past anything the body limit allows, so it is rejected before it can overflow.
                guard !sizeText.isEmpty, sizeText.utf8.count <= 8,
                      sizeText.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x46) || ($0 >= 0x61 && $0 <= 0x66) }),
                      let size = Int(sizeText, radix: 16) else { throw .malformed("Bad chunk size.") }
                if size > Self.maxBodyBytes - body.count { throw .bodyTooLarge }
                let dataStart = lineEnd.upperBound
                if size == 0 {
                    // Skip optional trailers up to the final CRLF.
                    guard let end = buffer[dataStart...].range(of: Data("\r\n".utf8)) else { return nil }
                    if end.lowerBound == dataStart {
                        consumedEnd = end.upperBound
                    } else {
                        guard let trailerEnd = buffer[dataStart...].range(of: Data("\r\n\r\n".utf8)) else { return nil }
                        consumedEnd = trailerEnd.upperBound
                    }
                    break
                }
                let dataEnd = dataStart + size
                guard buffer.endIndex >= dataEnd + 2 else { return nil }
                guard buffer[dataEnd] == 0x0D, buffer[dataEnd + 1] == 0x0A else { throw .malformed("Chunk is not followed by CRLF.") }
                body.append(buffer[dataStart..<dataEnd])
                cursor = dataEnd + 2
            }
        } else {
            let lengthText = headers["content-length"] ?? "0"
            guard !lengthText.isEmpty, lengthText.utf8.count <= 10, lengthText.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }),
                  let length = Int(lengthText) else { throw .malformed("Bad Content-Length.") }
            if length > Self.maxBodyBytes { throw .bodyTooLarge }
            guard buffer.endIndex - bodyStart >= length else { return nil }
            body = Data(buffer[bodyStart..<(bodyStart + length)])
            consumedEnd = bodyStart + length
        }

        buffer = Data(buffer[consumedEnd...])
        let target = String(requestLine[1])
        let path = target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? target
        return HTTPRequestMessage(method: String(requestLine[0]).uppercased(), path: path, version: String(requestLine[2]), headers: headers, body: body)
    }
}

struct HTTPResponseMessage: Sendable, Equatable {
    var status: Int
    var headers: [String: String] = [:]
    var body: Data = Data()

    static func json(_ status: Int, _ body: String, headers: [String: String] = [:]) -> Self {
        HTTPResponseMessage(status: status, headers: ["Content-Type": "application/json"].merging(headers) { $1 }, body: Data(body.utf8))
    }

    /// JSON-RPC error body (id null) with an HTTP status; messages tell the client what to do.
    static func rpcError(_ status: Int, _ message: String, headers: [String: String] = [:]) -> Self {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let escaped = String(decoding: (try? encoder.encode(message)) ?? Data("\"error\"".utf8), as: UTF8.self)
        return .json(status, #"{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":\#(escaped)}}"#, headers: headers)
    }

    func serialized(keepAlive: Bool) -> Data {
        var head = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
        var all = headers
        all["Content-Length"] = String(body.count)
        all["Connection"] = keepAlive ? "keep-alive" : "close"
        all["Cache-Control"] = "no-store"
        for (k, v) in all.sorted(by: { $0.key < $1.key }) { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        var data = Data(head.utf8)
        data.append(body)
        return data
    }

    static func reason(_ status: Int) -> String {
        switch status {
        case 200: "OK"
        case 202: "Accepted"
        case 204: "No Content"
        case 400: "Bad Request"
        case 401: "Unauthorized"
        case 403: "Forbidden"
        case 404: "Not Found"
        case 405: "Method Not Allowed"
        case 413: "Payload Too Large"
        case 415: "Unsupported Media Type"
        case 421: "Misdirected Request"
        case 502: "Bad Gateway"
        case 503: "Service Unavailable"
        default: "Status"
        }
    }
}

/// Security and protocol checks for the local MCP endpoint, before the body reaches the editor.
enum MCPRequestValidator {
    enum Validation: Equatable {
        case reject(HTTPResponseMessage)
        case accept(route: MCPRoute, grant: MCPGrant)
    }

    static let unauthorizedMessage = "Missing, wrong or expired token. In Ocelot, click \"Copy MCP config\" in the toolbar and re-run the copied command, or configure your client with `ocelot mcp-config` (the stdio proxy needs no token)."

    /// DNS-rebinding protection: only loopback host names and origins.
    static func checkLocal(_ req: HTTPRequestMessage, port: Int) -> HTTPResponseMessage? {
        if let host = req.header("host"), !isLoopbackHost(host, port: port) {
            return .rpcError(421, "Requests must be addressed to 127.0.0.1:\(port) or localhost:\(port).")
        }
        if let origin = req.header("origin"), !isLoopbackOrigin(origin) {
            return .rpcError(403, "Requests from web pages are not allowed (origin \(origin)).")
        }
        return nil
    }

    /// Rejects the request with an error response, or accepts it with its route and the token's grant.
    static func validate(_ req: HTTPRequestMessage, port: Int, tokens: MCPTokenStore) -> Validation {
        guard let route = MCPRoute.parse(path: req.path) else {
            return .reject(.rpcError(404, "Not found. Ocelot MCP endpoints are /mcp, /mcp/p/<projectId>, /mcp/w/<windowId> and /mcp/app (app tools). Run `ocelot ls` for project ids."))
        }
        if let rejection = checkLocal(req, port: port) { return .reject(rejection) }
        guard let grant = tokens.authorize(req.header("authorization")) else {
            return .reject(.rpcError(401, unauthorizedMessage, headers: ["WWW-Authenticate": "Bearer"]))
        }
        switch req.method {
        case "POST":
            if let type = req.header("content-type"), !type.lowercased().contains("application/json") {
                return .reject(.rpcError(415, "Content-Type must be application/json."))
            }
            return .accept(route: route, grant: grant)
        case "DELETE":
            return .accept(route: route, grant: grant)
        case "GET":
            return .reject(.rpcError(405, "This server does not offer an SSE stream. Send JSON-RPC messages with POST.", headers: ["Allow": "POST, DELETE"]))
        default:
            return .reject(.rpcError(405, "Use POST.", headers: ["Allow": "POST, DELETE"]))
        }
    }

    static func isLoopbackHost(_ host: String, port: Int) -> Bool {
        let h = host.lowercased()
        return ["127.0.0.1", "localhost", "[::1]"].contains { h == $0 || h == "\($0):\(port)" }
    }

    static func isLoopbackOrigin(_ origin: String) -> Bool {
        guard let url = URL(string: origin), let host = url.host?.lowercased() else { return false }
        return ["http", "https"].contains(url.scheme ?? "") && ["127.0.0.1", "localhost", "::1"].contains(host)
    }

    static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        var diff = x.count ^ y.count
        for i in 0..<max(x.count, y.count) {
            diff |= Int((i < x.count ? x[i] : 0) ^ (i < y.count ? y[i] : 0))
        }
        return diff == 0
    }
}
