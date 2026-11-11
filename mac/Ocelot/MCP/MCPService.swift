import AppKit
import Foundation
import os

/// App-wide MCP endpoint: settings (port), the master token (a `0600` file in the run directory), scoped
/// tokens, the HTTP server, the discovery file, and routing of requests to editor windows.
@MainActor
final class MCPService: ObservableObject {
    static let shared = MCPService()

    static let defaultPort = 7420
    private static let portKey = "mcp.port"
    /// The master token used to live here; it moves to `<instance>.token` once (see `start`).
    private static let legacyTokenKey = "mcp.token"

    @Published private(set) var state: MCPHTTPServer.State = .stopped
    @Published private(set) var port: Int
    @Published private(set) var token: String
    /// Projects open in this app, for Settings (kept in step with the discovery file).
    @Published private(set) var projects: [RunProject] = []

    /// `app` / `app-debug`; `<name>-<pid>` when another live process already holds that name (two builds at once).
    private(set) var instance: String
    let runDirectory: InstanceDirectory
    let tokens: MCPTokenStore
    private(set) var gateway: MCPGateway!
    private var backend: LiveMCPBackend!
    /// The app-scope tools served at `/mcp/app` (see `AppToolServer`).
    private(set) var appServer: AppToolServer!
    private(set) var appControl: LiveAppControl!
    private var server: MCPHTTPServer?
    private let defaults: UserDefaults
    private let known: KnownProjects
    private let started = Date()
    private var publishScheduled = false
    private let log = Logger(subsystem: "sh.caracal.ocelot", category: "mcp")

    /// Debug and Release builds can run side by side, so they get different instance names.
    #if DEBUG
    static let appInstanceName = "app-debug"
    #else
    static let appInstanceName = "app"
    #endif

    init(defaults: UserDefaults = .standard, runDirectory: InstanceDirectory = .standard, instance: String = MCPService.appInstanceName, registry: EditorRegistry? = nil) {
        self.defaults = defaults
        self.runDirectory = runDirectory
        self.instance = instance
        self.known = KnownProjects(runDirectory: runDirectory)
        let storedPort = defaults.integer(forKey: Self.portKey)
        self.port = (1024...65535).contains(storedPort) ? storedPort : Self.defaultPort
        // Read only; the file is written in `start()` so tests and previews never touch the real run directory.
        let initial = runDirectory.readToken(instance: instance)
            ?? defaults.string(forKey: Self.legacyTokenKey).flatMap { $0.count >= 32 ? $0 : nil }
            ?? MCPTokenStore.generate()
        self.token = initial
        self.tokens = MCPTokenStore(master: initial)
        let live = LiveMCPBackend(service: self, registry: registry ?? .shared)
        self.backend = live
        self.gateway = MCPGateway(tokens: tokens, backend: live)
        let control = LiveAppControl(service: self, registry: live.registry, known: known)
        self.appControl = control
        self.appServer = AppToolServer(control: control)
    }

    /// The port the server is actually bound to (the default port is skipped when another Ocelot holds it).
    var boundPort: Int {
        if case .running(let p) = state { return p }
        return port
    }

    var url: String { url(for: .keyWindow) }

    func url(for route: MCPRoute) -> String { "http://127.0.0.1:\(boundPort)\(route.path)" }

    /// Ready-to-paste HTTP command for Claude Code (master token; `ocelot mcp` needs none).
    func claudeHTTPCommand(route: MCPRoute = .keyWindow) -> String {
        #"claude mcp add --transport http ocelot \#(url(for: route)) --header "Authorization: Bearer \#(token)""#
    }

    /// stdio config command for Claude Code that goes through the `ocelot` CLI.
    func claudeCommand(project: RunProject?) -> String {
        MCPClientConfig.render(.claude, command: CLIInstaller().commandForConfigs, project: project?.id, projectName: project?.name)
    }

    var statusForEditor: McpStatus { status(for: nil) }

    func status(for project: RunProject?) -> McpStatus {
        let route: MCPRoute = project.map { MCPRoute.project($0.id) } ?? .keyWindow
        switch state {
        case .running:
            return McpStatus(url: url(for: route), token: token, command: claudeCommand(project: project), running: true, error: nil)
        case .failed(let message):
            return McpStatus(url: url(for: route), token: token, command: claudeCommand(project: project), running: false, error: message)
        case .starting, .stopped:
            return McpStatus(url: url(for: route), token: token, command: claudeCommand(project: project), running: false, error: "The MCP server is not running.")
        }
    }

    // MARK: Tokens

    /// A token limited to one window or project; kept in memory only. Use `/mcp/w/<id>` or `/mcp/p/<id>` with it.
    func issueToken(scope: MCPScope, readOnly: Bool, ttl: Duration?) -> String {
        tokens.issue(scope: scope, readOnly: readOnly, ttl: ttl)
    }

    func revokeToken(_ token: String) { tokens.revoke(token) }

    func revokeTokens(scope: MCPScope) { tokens.revokeAll(scope: scope) }

    /// Invalidates the old master token; configured HTTP clients must be updated (`ocelot mcp` clients are not affected).
    func regenerateToken() {
        token = MCPTokenStore.generate()
        tokens.setMaster(token)
        persistToken()
    }

    private func persistToken() {
        do { try runDirectory.writeToken(token, instance: instance) } catch { log.error("could not write token file: \(error.localizedDescription, privacy: .public)") }
    }

    // MARK: Lifecycle

    func start() {
        server?.stop()
        if let holder = runDirectory.liveInstances(prune: false).first(where: { $0.instance == instance }), let pid = holder.pid, pid != Int(getpid()) {
            // Another Ocelot (say Debug next to Release, or two checkouts) owns this name: use our own, with its own token.
            instance = "\(instance)-\(getpid())"
            token = MCPTokenStore.generate()
            tokens.setMaster(token)
            log.info("instance name taken by pid \(pid); using \(self.instance, privacy: .public)")
        }
        // One-time migration: the token moved from UserDefaults to the run directory, same value, so clients keep working.
        persistToken()
        defaults.removeObject(forKey: Self.legacyTokenKey)

        // Debug and Release both default to 7420. Clients find the port through the discovery file, so
        // an unpinned port steps aside for whoever holds it; a port the user chose is never changed.
        var requested = port
        if defaults.integer(forKey: Self.portKey) == 0, InstanceDirectory.tcpReachable(port: port, timeout: 0.2) { requested = 0 }

        let gateway = self.gateway!
        let server = MCPHTTPServer(port: requested) { request, port in await gateway.handle(request, port: port) }
        server.onStateChange = { [weak self] new in
            guard let self else { return }
            self.state = new
            if case .running = new { self.publishNow() }
        }
        self.server = server
        backend.registry.onChange = { [weak self] in self?.projectsDidChange() }
        backend.registry.onClose = { [weak self] id in
            self?.tokens.revokeAll(scope: .window(id))
            self?.gateway.dropSessions(window: id)
        }
        server.start()
    }

    func stop() {
        server?.stop()
        server = nil
        runDirectory.remove(instance: instance, keepToken: !instance.hasSuffix("-\(getpid())"))
    }

    func setPort(_ newPort: Int) {
        guard (1024...65535).contains(newPort), newPort != port || defaults.integer(forKey: Self.portKey) == 0 else { return }
        port = newPort
        defaults.set(newPort, forKey: Self.portKey)
        start()
    }

    // MARK: Discovery file

    /// Window/project changes arrive in bursts (load, rename, save as): coalesce into one write.
    func projectsDidChange() {
        guard !publishScheduled else { return }
        publishScheduled = true
        Task { @MainActor in
            self.publishScheduled = false
            self.publishNow()
        }
    }

    func publishNow() {
        let list = backend.registry.runProjects()
        if list != projects { projects = list }
        guard case .running(let p) = state else { return }
        for project in list { known.record(project) }
        let record = InstanceRecord(
            instance: instance, kind: .app, pid: Int(getpid()), containerId: nil, runtime: nil,
            started: ISO8601DateFormatter().string(from: started), http: "http://127.0.0.1:\(p)", socket: nil, projects: list
        )
        do { try runDirectory.publish(record) } catch { log.error("could not write discovery file: \(error.localizedDescription, privacy: .public)") }
    }
}

// MARK: - Live backend

/// Routes the gateway's requests to real editor windows, and to other instances found in the run directory.
@MainActor
final class LiveMCPBackend: MCPBackend {
    unowned let service: MCPService
    let registry: EditorRegistry

    init(service: MCPService, registry: EditorRegistry) {
        self.service = service
        self.registry = registry
    }

    private func info(_ c: EditorWebController) -> MCPWindowInfo { MCPWindowInfo(id: c.id, projectId: c.session.projectId) }

    func window(id: String) -> MCPWindowInfo? { registry.controller(id: id).map(info) }
    func window(forProject id: String) -> MCPWindowInfo? { registry.controller(forProject: id).map(info) }
    var keyWindow: MCPWindowInfo? { registry.active.map(info) }

    func forward(body: String, windowId: String, client: String?, readOnly: Bool) async throws -> String? {
        guard let controller = registry.controller(id: windowId) else {
            throw BridgeFailure(.hostUnavailable, "The Ocelot window this request was started from is closed. Start a new chat in an open window.")
        }
        let message = McpMessage(body: body, client: client, readOnly: readOnly ? true : nil)
        // A tool call may legitimately wait: wait_for_images blocks up to 600 s for background image jobs.
        return try await controller.bridge.editor.call(EditorMethods.McpHandle.self, message, timeout: .seconds(620)).body
    }

    func regenerateMasterToken() -> String {
        service.regenerateToken()
        return service.token
    }

    func callApp(body: String, client: String?, readOnly: Bool) async -> String? {
        await service.appServer.handle(body: body, client: client, readOnly: readOnly)
    }

    func remote(forProject id: String) -> MCPRemoteTarget? {
        let dir = service.runDirectory
        for record in dir.liveInstances() where record.instance != service.instance && record.projects.contains(where: { $0.id == id }) {
            guard let token = dir.readToken(instance: record.instance), let http = URL(string: record.http) else { continue }
            return MCPRemoteTarget(instance: record.instance, http: http, token: token)
        }
        return nil
    }

    /// The request sent to the instance that hosts the project: its master token plus the caller's limit. The
    /// target's gateway honours `X-Ocelot-Read-Only`, so a read-only scoped token stays read-only after the hop.
    static func upstreamRequest(for request: HTTPRequestMessage, to remote: MCPRemoteTarget, readOnly: Bool) -> URLRequest? {
        guard let url = URL(string: remote.http.absoluteString + request.path) else { return nil }
        var upstream = URLRequest(url: url, timeoutInterval: 620)
        upstream.httpMethod = request.method
        upstream.httpBody = request.body.isEmpty ? nil : request.body
        upstream.setValue("Bearer \(remote.token)", forHTTPHeaderField: "Authorization")
        for name in ["content-type", "accept", "mcp-protocol-version", MCPHeader.session.lowercased()] {
            if let v = request.header(name) { upstream.setValue(v, forHTTPHeaderField: name) }
        }
        if readOnly { upstream.setValue("1", forHTTPHeaderField: MCPHeader.readOnly) }
        return upstream
    }

    func proxy(_ request: HTTPRequestMessage, to remote: MCPRemoteTarget, readOnly: Bool) async -> HTTPResponseMessage {
        guard let upstream = Self.upstreamRequest(for: request, to: remote, readOnly: readOnly) else { return .rpcError(502, "Bad upstream URL.") }
        do {
            let (data, response) = try await URLSession.shared.data(for: upstream)
            guard let http = response as? HTTPURLResponse else { return .rpcError(502, "\(remote.instance) sent no HTTP response.") }
            var headers: [String: String] = [:]
            if let ct = http.value(forHTTPHeaderField: "Content-Type") { headers["Content-Type"] = ct }
            if let sid = http.value(forHTTPHeaderField: MCPHeader.session) { headers[MCPHeader.session] = sid }
            return HTTPResponseMessage(status: http.statusCode, headers: headers, body: data)
        } catch {
            return .rpcError(502, "Could not reach \(remote.instance) at \(remote.http.absoluteString): \(error.localizedDescription). It may have stopped; run `ocelot ls`.")
        }
    }
}

// MARK: - Registry

/// Tracks open editor windows so MCP requests go to the one the user is looking at (or the one they name).
@MainActor
final class EditorRegistry {
    static let shared = EditorRegistry()

    private var controllers: [WeakController] = []
    /// Called when windows open/close or a window's project identity changes.
    var onChange: (@MainActor () -> Void)?
    /// Called with a window id when that window closes.
    var onClose: (@MainActor (String) -> Void)?

    private struct WeakController {
        weak var value: EditorWebController?
    }

    func register(_ controller: EditorWebController) {
        controllers.removeAll { $0.value == nil || $0.value === controller }
        controllers.append(WeakController(value: controller))
        onChange?()
    }

    func unregister(id: String) {
        controllers.removeAll { $0.value == nil || $0.value?.id == id }
        onClose?(id)
        onChange?()
    }

    func markActive(_ controller: EditorWebController) {
        register(controller) // moves it to the end (most recent)
    }

    /// The key window's editor, else the most recently active one.
    var active: EditorWebController? {
        controllers.removeAll { $0.value == nil }
        if let key = controllers.first(where: { $0.value?.webView.window?.isKeyWindow == true })?.value { return key }
        return controllers.last?.value
    }

    var all: [EditorWebController] {
        controllers.removeAll { $0.value == nil }
        return controllers.compactMap(\.value)
    }

    func controller(id: String) -> EditorWebController? {
        controllers.first { $0.value?.id == id }?.value
    }

    /// The window that hosts a project (most recently active first).
    func controller(forProject id: String) -> EditorWebController? {
        all.reversed().first { $0.session.projectId == id }
    }

    /// The `projects` list of the discovery file: one entry per window whose project id is known.
    func runProjects() -> [RunProject] {
        all.compactMap { $0.session.runProject(windowId: $0.id) }
    }
}
