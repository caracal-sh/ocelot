import Foundation

struct HTTPReply {
    var status: Int
    /// Lowercased names.
    var headers: [String: String]
    var body: Data
}

/// A failure to talk to the host at all (nothing listening, timeout), as opposed to an HTTP error status.
struct ConnectionFailure: Error, CustomStringConvertible {
    var message: String
    var description: String { message }
}

enum HTTP {
    /// Blocking request on loopback (never through a proxy).
    static func request(_ method: String, _ url: URL, headers: [String: String] = [:], body: Data? = nil, timeout: TimeInterval = 650) throws -> HTTPReply {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        request.httpBody = body
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }

        final class Box: @unchecked Sendable { var result: Result<HTTPReply, ConnectionFailure>? }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { data, response, error in
            if let http = response as? HTTPURLResponse {
                var h: [String: String] = [:]
                for (k, v) in http.allHeaderFields { h[String(describing: k).lowercased()] = String(describing: v) }
                box.result = .success(HTTPReply(status: http.statusCode, headers: h, body: data ?? Data()))
            } else {
                box.result = .failure(ConnectionFailure(message: error?.localizedDescription ?? "no response"))
            }
            done.signal()
        }.resume()
        done.wait()
        switch box.result! {
        case .success(let reply): return reply
        case .failure(let failure): throw failure
        }
    }
}
