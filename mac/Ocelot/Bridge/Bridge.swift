import Foundation
import os

/// Error that crosses the bridge as `{ code, message, data? }`.
/// Messages should tell the caller what to do next.
struct BridgeFailure: Error, Sendable, Equatable, CustomStringConvertible {
    var code: BridgeErrorCode
    var message: String
    var data: JSONValue?

    init(_ code: BridgeErrorCode, _ message: String, data: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }

    var description: String { "\(code.rawValue): \(message)" }
}

extension BridgeFailure: LocalizedError {
    /// Without this, `localizedDescription` is "BridgeFailure error 1" and hides the message.
    var errorDescription: String? { message }
}

// MARK: - Envelopes (wire format, mirrors BridgeRequest/BridgeResponse in schema.gen.ts)

struct BridgeRequestEnvelope: Codable, Sendable {
    var v: Int
    var id: String
    var method: String
    var params: JSONValue?
}

struct BridgeErrorPayload: Codable, Sendable, Equatable {
    var code: BridgeErrorCode
    var message: String
    var data: JSONValue?
}

struct BridgeResponseEnvelope: Codable, Sendable {
    var v: Int
    var id: String
    var ok: Bool
    var result: JSONValue?
    var error: BridgeErrorPayload?
}

enum BridgeCoding {
    static func encode(_ value: some Encodable) throws -> JSONValue {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    static func decode<T: Decodable>(_ type: T.Type, from value: JSONValue) throws -> T {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(T.self, from: data)
    }

    static func string(_ value: some Encodable) -> String {
        guard let data = try? JSONEncoder().encode(value), let s = String(data: data, encoding: .utf8) else {
            return #"{"v":1,"id":"","ok":false,"error":{"code":"internal","message":"Failed to encode bridge message."}}"#
        }
        return s
    }
}

// MARK: - Host endpoint: methods the editor calls on Swift

/// Dispatches serialized requests from the editor to registered Swift handlers.
/// Always answers with a serialized response envelope; never throws.
@MainActor
final class HostEndpoint {
    typealias RawHandler = @MainActor @Sendable (JSONValue) async throws -> JSONValue

    private var handlers: [String: RawHandler] = [:]
    private let log = Logger(subsystem: "sh.caracal.ocelot", category: "bridge")

    func register<M: BridgeMethod>(_: M.Type, _ handler: @escaping @MainActor @Sendable (M.Params) async throws -> M.Result) {
        handlers[M.name] = { raw in
            let params: M.Params
            do {
                params = try BridgeCoding.decode(M.Params.self, from: raw)
            } catch {
                throw BridgeFailure(.invalidParams, "Invalid params for \(M.name): \(String(describing: error)). Check the shape against bridge/schema.json.")
            }
            return try BridgeCoding.encode(try await handler(params))
        }
    }

    var registeredMethods: [String] { handlers.keys.sorted() }

    func dispatch(_ requestJSON: String) async -> String {
        var id = ""
        do {
            guard let data = requestJSON.data(using: .utf8),
                  let request = try? JSONDecoder().decode(BridgeRequestEnvelope.self, from: data)
            else {
                throw BridgeFailure(.invalidParams, "Request was not a valid bridge envelope.")
            }
            id = request.id
            guard let handler = handlers[request.method] else {
                throw BridgeFailure(.unknownMethod, "Unknown host method \"\(request.method)\". Known methods: \(registeredMethods.joined(separator: ", ")).")
            }
            let result = try await handler(request.params ?? .object([:]))
            return BridgeCoding.string(BridgeResponseEnvelope(v: BridgeSchema.version, id: id, ok: true, result: result, error: nil))
        } catch let failure as BridgeFailure {
            return BridgeCoding.string(errorEnvelope(id: id, failure))
        } catch {
            log.error("host handler failed: \(error.localizedDescription, privacy: .public)")
            return BridgeCoding.string(errorEnvelope(id: id, BridgeFailure(.internal, error.localizedDescription)))
        }
    }

    private func errorEnvelope(id: String, _ f: BridgeFailure) -> BridgeResponseEnvelope {
        BridgeResponseEnvelope(
            v: BridgeSchema.version, id: id, ok: false, result: nil,
            error: BridgeErrorPayload(code: f.code, message: f.message, data: f.data)
        )
    }
}

// MARK: - Editor client: Swift calls methods implemented in TS

/// Sends one serialized request to the editor and returns the serialized response.
typealias EditorTransport = @MainActor @Sendable (String) async throws -> String

@MainActor
final class EditorClient {
    private let transport: EditorTransport
    private var counter = 0
    let defaultTimeout: Duration

    init(defaultTimeout: Duration = .seconds(10), transport: @escaping EditorTransport) {
        self.transport = transport
        self.defaultTimeout = defaultTimeout
    }

    func call<M: BridgeMethod>(_: M.Type, _ params: M.Params, timeout: Duration? = nil) async throws -> M.Result {
        counter += 1
        let id = "sw-\(counter)"
        let request = BridgeRequestEnvelope(v: BridgeSchema.version, id: id, method: M.name, params: try BridgeCoding.encode(params))
        let requestJSON = BridgeCoding.string(request)
        let limit = timeout ?? defaultTimeout

        let responseJSON = try await Self.withTimeout(limit, method: M.name) { [transport] in
            do {
                return try await transport(requestJSON)
            } catch let f as BridgeFailure {
                throw f
            } catch {
                throw BridgeFailure(.hostUnavailable, "Could not reach the editor for \"\(M.name)\": \(error.localizedDescription). Is the editor page loaded?")
            }
        }

        guard let data = responseJSON.data(using: .utf8),
              let response = try? JSONDecoder().decode(BridgeResponseEnvelope.self, from: data)
        else {
            throw BridgeFailure(.internal, "Editor returned an invalid response for \"\(M.name)\".")
        }
        guard response.id == id else {
            throw BridgeFailure(.internal, "Editor response id mismatch for \"\(M.name)\" (expected \(id), got \(response.id)).")
        }
        if response.ok {
            do {
                return try BridgeCoding.decode(M.Result.self, from: response.result ?? .object([:]))
            } catch {
                throw BridgeFailure(.internal, "Editor result for \"\(M.name)\" did not match the schema: \(String(describing: error)).")
            }
        }
        let e = response.error ?? BridgeErrorPayload(code: .internal, message: "Unknown editor error.", data: nil)
        throw BridgeFailure(e.code, e.message, data: e.data)
    }

    /// Races `operation` against a timer. The loser is ignored (WebKit calls cannot be cancelled).
    static func withTimeout<T: Sendable>(
        _ limit: Duration,
        method: String,
        _ operation: @escaping @MainActor @Sendable () async throws -> T
    ) async throws -> T {
        let gate = OnceGate<T>()
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T, any Error>) in
            gate.continuation = cont
            Task { @MainActor in
                do { gate.finish(.success(try await operation())) } catch { gate.finish(.failure(error)) }
            }
            Task { @MainActor in
                try? await Task.sleep(for: limit)
                gate.finish(.failure(BridgeFailure(.timeout, "\"\(method)\" did not answer within \(limit). The editor may be busy or reloading; retry.")))
            }
        }
    }
}

/// Resumes a continuation exactly once. MainActor-isolated, so no locking needed.
@MainActor
private final class OnceGate<T: Sendable> {
    var continuation: CheckedContinuation<T, any Error>?

    func finish(_ result: Result<T, any Error>) {
        guard let c = continuation else { return }
        continuation = nil
        c.resume(with: result)
    }
}
