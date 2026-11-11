import Foundation

/// An open editor window as the gateway sees it.
struct MCPWindowInfo: Equatable, Sendable {
    var id: String
    var projectId: String
}

/// Another live host (headless host, container) that serves a project this app does not host.
struct MCPRemoteTarget: Equatable, Sendable {
    var instance: String
    var http: URL
    var token: String
}

/// What the gateway needs from the app. Faked in tests.
@MainActor
protocol MCPBackend: AnyObject {
    func window(id: String) -> MCPWindowInfo?
    func window(forProject id: String) -> MCPWindowInfo?
    var keyWindow: MCPWindowInfo? { get }
    /// Runs one JSON-RPC body in a window's editor. nil = notification.
    func forward(body: String, windowId: String, client: String?, readOnly: Bool) async throws -> String?
    /// Replaces the master token and returns the new one.
    func regenerateMasterToken() -> String
    func remote(forProject id: String) -> MCPRemoteTarget?
    /// Relays the request to another instance (adding its token) and returns its response verbatim.
    func proxy(_ request: HTTPRequestMessage, to remote: MCPRemoteTarget, readOnly: Bool) async -> HTTPResponseMessage
    /// Runs one JSON-RPC body of the app endpoint (`/mcp/app`: projects, windows, settings). nil = notification.
    func callApp(body: String, client: String?, readOnly: Bool) async -> String?
}

/// Routing for `/mcp`, `/mcp/p/<projectId>`, `/mcp/w/<windowId>` and `/mcp/app`: authenticates, pins MCP sessions at
/// `initialize`, enforces token scopes and read-only grants, and proxies projects hosted elsewhere. `/mcp/app` serves the
/// app-scope tools (the host answers them itself; see `AppToolServer`) and needs the master token.
@MainActor
final class MCPGateway {
    struct Session {
        enum Pin: Equatable { case window(String), project(String), app }
        var route: MCPRoute
        var pin: Pin
        var client: String?
    }

    let tokens: MCPTokenStore
    private unowned let backend: MCPBackend
    private(set) var sessions: [String: Session] = [:]
    private var sessionOrder: [String] = []
    static let maxSessions = 256

    init(tokens: MCPTokenStore, backend: MCPBackend) {
        self.tokens = tokens
        self.backend = backend
    }

    func handle(_ request: HTTPRequestMessage, port: Int) async -> HTTPResponseMessage {
        if request.path.hasPrefix(Self.adminPrefix) { return admin(request, port: port) }
        let route: MCPRoute, grant: MCPGrant
        switch MCPRequestValidator.validate(request, port: port, tokens: tokens) {
        case .reject(let response): return response
        case .accept(let r, let g): (route, grant) = (r, g)
        }

        // The legacy `X-Ocelot-Window` header pins like /mcp/w/<id>.
        var effective = route
        if route == .keyWindow, let legacy = request.header(MCPHeader.window), MCPRoute.isValidId(legacy) { effective = .window(legacy) }

        let sessionId = request.header(MCPHeader.session)
        let message = Self.inspect(request.body)
        // A master caller (the app front door proxying a read-only scoped token to another instance) passes the
        // limit of the token it authenticated; the header can only restrict, and scoped tokens carry their own.
        let readOnly = grant.readOnly || (grant.scope == nil && request.header(MCPHeader.readOnly) == "1")

        if effective == .app { return await handleApp(request, grant: grant, readOnly: readOnly, message: message, sessionId: sessionId) }

        if request.method == "DELETE" {
            // Ending a session needs the same scope as using it: a token may only end sessions it could use.
            guard let sessionId else { return HTTPResponseMessage(status: 200) }
            let known = sessions[sessionId]
            guard let pin = known?.pin ?? Self.pin(for: effective) else { return HTTPResponseMessage(status: 200) }
            let (windowId, projectId) = scopeTarget(of: pin)
            guard grant.permits(windowId: windowId, projectId: projectId) else {
                return .rpcError(403, Self.scopeMessage(grant, requested: effective))
            }
            if known != nil { drop(sessionId) }
            if case .project(let id) = effective, backend.window(forProject: id) == nil, let remote = backend.remote(forProject: id) {
                return await backend.proxy(request, to: remote, readOnly: readOnly)
            }
            return HTTPResponseMessage(status: 200)
        }

        // Which session (if any) does this request belong to?
        var session: Session?
        if !message.isInitialize, let sessionId {
            if let known = sessions[sessionId] {
                guard known.route == effective else {
                    return .rpcError(400, "This MCP session is pinned to \(known.route.path). Send requests to that URL, or initialize a new session for \(effective.path).")
                }
                session = known
            } else if case .project(let id) = effective, backend.window(forProject: id) == nil, backend.remote(forProject: id) != nil {
                session = nil // a session of the instance that hosts the project; the proxy below relays it
            } else {
                return .rpcError(404, "Unknown or ended MCP session. Send a new initialize request to start one.")
            }
        }

        // Resolve where it goes.
        let pin = session?.pin ?? Self.pin(for: effective)
        var window: MCPWindowInfo?
        var remote: MCPRemoteTarget?
        var projectForScope: String?
        switch pin {
        case .window(let id)?:
            window = backend.window(id: id)
            projectForScope = window?.projectId
            if window == nil {
                if let sessionId { drop(sessionId) }
                return .rpcError(404, "The Ocelot window this request was sent to is closed. Reconnect to pin to an open window (run `ocelot ls`).")
            }
        case .app?:
            return .rpcError(500, "Internal routing error: an app session reached the document route.")
        case .project(let id)?:
            window = backend.window(forProject: id)
            projectForScope = id
            if window == nil {
                remote = backend.remote(forProject: id)
                if remote == nil {
                    if let sessionId, sessions[sessionId] != nil { drop(sessionId) }
                    return .rpcError(404, "No open project with id \(id). Run `ocelot ls` to see open projects or `ocelot open <path>` to open one.")
                }
            }
        case nil:
            // `/mcp` without a session: whatever window is key right now.
            guard let key = backend.keyWindow else {
                return .rpcError(503, "No project is open, so there is no document to edit. Open one with the app tools (open_project, or new_project to start one; POST them to /mcp/app, or use `ocelot mcp`, which lists both), or run `ocelot open <path>`.")
            }
            window = key
            projectForScope = key.projectId
        }

        guard grant.permits(windowId: window?.id, projectId: projectForScope) else {
            return .rpcError(403, Self.scopeMessage(grant, requested: effective))
        }

        if let remote { return await backend.proxy(request, to: remote, readOnly: readOnly) }
        guard let window else { return .rpcError(503, "No Ocelot window is open. Open a document window and retry.") }

        var headers: [String: String] = [:]
        var client = session?.client
        if message.isInitialize {
            client = message.clientName
            let id = UUID().uuidString
            // `/mcp` pins the window that was key at initialize; project and window routes pin their target.
            store(id, Session(route: effective, pin: Self.pin(for: effective) ?? .window(window.id), client: client))
            headers[MCPHeader.session] = id
        }

        do {
            guard let reply = try await backend.forward(body: String(decoding: request.body, as: UTF8.self), windowId: window.id, client: client, readOnly: readOnly) else {
                return HTTPResponseMessage(status: 202, headers: headers)
            }
            return .json(200, reply, headers: headers)
        } catch {
            if message.isInitialize, let id = headers[MCPHeader.session] { drop(id) }
            return .rpcError(503, "\(error)")
        }
    }

    // MARK: App endpoint (`/mcp/app`)

    /// The app tools act on the whole app (open and close projects, quit), so only the master token reaches them: a window or
    /// project token, such as the sidebar agent's, stays inside its document.
    private func handleApp(_ request: HTTPRequestMessage, grant: MCPGrant, readOnly: Bool, message: Inspected, sessionId: String?) async -> HTTPResponseMessage {
        guard grant.scope == nil else {
            return .rpcError(403, "The app tools (projects, windows, settings) need the master token; this token is limited to one document. Use its own URL (/mcp/w/<window> or /mcp/p/<project>), or configure the client with `ocelot mcp-config` (the stdio proxy needs no token).")
        }
        if request.method == "DELETE" {
            if let sessionId { drop(sessionId) }
            return HTTPResponseMessage(status: 200)
        }
        var headers: [String: String] = [:]
        var client: String?
        if message.isInitialize {
            client = message.clientName
            let id = UUID().uuidString
            store(id, Session(route: .app, pin: .app, client: client))
            headers[MCPHeader.session] = id
        } else if let sessionId {
            guard let known = sessions[sessionId] else {
                return .rpcError(404, "Unknown or ended MCP session. Send a new initialize request to start one.")
            }
            guard known.route == .app else {
                return .rpcError(400, "This MCP session is pinned to \(known.route.path). Send requests to that URL, or initialize a new session for /mcp/app.")
            }
            client = known.client
        }
        guard let reply = await backend.callApp(body: String(decoding: request.body, as: UTF8.self), client: client, readOnly: readOnly) else {
            return HTTPResponseMessage(status: 202, headers: headers)
        }
        return .json(200, reply, headers: headers)
    }

    /// Clients that initialized a session, newest first (for `get_app_info`): name and the URL they are pinned to.
    var connectedClients: [(client: String, route: String)] {
        sessionOrder.reversed().compactMap { id in
            guard let session = sessions[id], let client = session.client else { return nil }
            return (client, session.route.path)
        }
    }

    // MARK: Admin API (master token only; used by `ocelot token`)

    static let adminPrefix = "/ocelot/v1/"

    private func admin(_ request: HTTPRequestMessage, port: Int) -> HTTPResponseMessage {
        if let rejection = MCPRequestValidator.checkLocal(request, port: port) { return rejection }
        guard let grant = tokens.authorize(request.header("authorization")) else {
            return .rpcError(401, MCPRequestValidator.unauthorizedMessage, headers: ["WWW-Authenticate": "Bearer"])
        }
        guard grant == .master else { return .rpcError(403, "Only the master token may use the admin API. Run `ocelot token` for it.") }
        guard request.method == "POST" else { return .rpcError(405, "Use POST.", headers: ["Allow": "POST"]) }
        let body = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]) ?? [:]
        func ok(_ object: [String: Any]) -> HTTPResponseMessage {
            .json(200, String(decoding: (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8), as: UTF8.self))
        }
        switch request.path {
        case Self.adminPrefix + "tokens":
            guard let kind = body["scope"] as? String, let id = body["id"] as? String, MCPRoute.isValidId(id) else {
                return .rpcError(400, "Send {\"scope\": \"project\"|\"window\", \"id\": \"...\", \"readOnly\"?: bool, \"ttlSeconds\"?: number}.")
            }
            let scope: MCPScope, route: MCPRoute
            switch kind {
            case "project": (scope, route) = (.project(id), .project(id))
            case "window": (scope, route) = (.window(id), .window(id))
            default: return .rpcError(400, "scope must be \"project\" or \"window\".")
            }
            // Present keys must have the right type: `"readOnly":"true"` or `"ttlSeconds":"60"` must not
            // quietly mint a broader token.
            var readOnly = false
            if let raw = body["readOnly"], !(raw is NSNull) {
                guard let flag = Self.jsonBool(raw) else { return .rpcError(400, "readOnly must be true or false (a JSON boolean).") }
                readOnly = flag
            }
            var ttl: Duration?
            var seconds: Double?
            if let raw = body["ttlSeconds"], !(raw is NSNull) {
                guard let number = Self.jsonNumber(raw) else { return .rpcError(400, "ttlSeconds must be a number of seconds between 1 and 31536000.") }
                guard number >= 1, number <= 365 * 86400 else { return .rpcError(400, "ttlSeconds must be between 1 and 31536000.") }
                seconds = number
                ttl = .seconds(Int64(number))
            }
            let token = tokens.issue(scope: scope, readOnly: readOnly, ttl: ttl)
            var reply: [String: Any] = ["token": token, "scope": kind, "id": id, "readOnly": readOnly, "url": "http://127.0.0.1:\(port)\(route.path)"]
            if let seconds { reply["expires"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(seconds)) }
            return ok(reply)
        case Self.adminPrefix + "tokens/revoke":
            guard let token = body["token"] as? String else { return .rpcError(400, "Send {\"token\": \"...\"}.") }
            tokens.revoke(token)
            return ok(["revoked": true])
        case Self.adminPrefix + "token/regenerate":
            return ok(["token": backend.regenerateMasterToken()])
        default:
            return .rpcError(404, "Unknown admin endpoint \(request.path).")
        }
    }

    // MARK: Sessions

    private func store(_ id: String, _ session: Session) {
        sessions[id] = session
        sessionOrder.append(id)
        while sessionOrder.count > Self.maxSessions { sessions[sessionOrder.removeFirst()] = nil }
    }

    private func drop(_ id: String) {
        sessions[id] = nil
        sessionOrder.removeAll { $0 == id }
    }

    /// Ends every session pinned to a window (it closed) or token-less cleanup.
    func dropSessions(window id: String) {
        for (sid, s) in sessions where s.pin == .window(id) { drop(sid) }
    }

    // MARK: Helpers

    private static func pin(for route: MCPRoute) -> Session.Pin? {
        switch route {
        case .keyWindow, .app: nil
        case .project(let id): .project(id)
        case .window(let id): .window(id)
        }
    }

    private static func scopeMessage(_ grant: MCPGrant, requested route: MCPRoute) -> String {
        switch grant.scope {
        case .window(let id)?:
            "This token is limited to window \(id). Use /mcp/w/\(id), or ask for a token for the target (`ocelot token new --project <id>`)."
        case .project(let id)?:
            "This token is limited to project \(id). Use /mcp/p/\(id), or ask for a token for the target (`ocelot token new --project <id>`)."
        case nil:
            "Not allowed for \(route.path)."
        }
    }

    /// The window and project a pin names, for scope checks (the window of a project pin is whichever hosts it now).
    private func scopeTarget(of pin: Session.Pin) -> (windowId: String?, projectId: String?) {
        switch pin {
        case .window(let id): (id, backend.window(id: id)?.projectId)
        case .project(let id): (backend.window(forProject: id)?.id, id)
        case .app: (nil, nil)
        }
    }

    private static func jsonBool(_ value: Any) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    private static func jsonNumber(_ value: Any) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return number.doubleValue
    }

    struct Inspected {
        var isInitialize = false
        var clientName: String?
    }

    /// Looks at a request body for `initialize` (single message only) and the client's name.
    static func inspect(_ body: Data) -> Inspected {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any], object["method"] as? String == "initialize" else { return Inspected() }
        let params = object["params"] as? [String: Any]
        let info = params?["clientInfo"] as? [String: Any]
        return Inspected(isInitialize: true, clientName: (info?["name"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(80)) })
    }
}
