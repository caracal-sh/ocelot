import AppKit
import Foundation
import os

/// Host side of the agent sidebar: finds the user's omp CLI, reports its models, and runs one
/// long-lived `omp --mode rpc` process per window conversation, wired to that window's MCP endpoint.
/// The editor builds the RPC commands and parses the event stream; this class only starts/stops the
/// process, writes allowlisted command lines to stdin and forwards stdout lines (`editor.agentEvent`).
/// Mirrors editor/e2e/omp-runner.mjs (the headless host).
///
/// Confinement (default): omp runs inside the sandboxed XPC service (`OcelotAgentService`) with no
/// access to the user's files or `~/.omp`; model calls go through `omp auth-gateway` on loopback with a
/// scoped client token, and the MCP endpoint is reached with a window-scoped token. "Run agent
/// unconfined" (Settings > Agent, off by default) is the only other mode; there is no silent fallback.
@MainActor
final class AgentRunner {
    static let shared = AgentRunner()

    private let log = Logger(subsystem: "sh.caracal.ocelot", category: "agent")
    /// processId -> running process. At most one per window.
    private var processes: [String: Running] = [:]
    private var prepared: Prepared?
    /// Starts still awaiting omp/the XPC service: a stop that arrives meanwhile must not be lost.
    private var pendingStarts = PendingStarts()

    private struct Running {
        let handle: any AgentProcessHandle
        let windowId: String
    }

    /// What `status()` worked out for confined starts: the picker's models, the default model and effort.
    private struct Prepared {
        let selectors: [String]
        let defaultModel: String
        let thinking: String
    }

    /// RPC commands the sidebar may send. Everything else (bash, login, session files…) is refused.
    static let allowedCommands: Set<String> = [
        "negotiate_protocol", "set_event_filter", "get_state", "prompt", "abort",
        "set_model", "set_thinking_level", "get_available_thinking_levels",
        // Messages queued or steering while the agent works: take one back, steer with it now, stop and take them all back.
        "remove_queued_message", "promote_queued_message", "abort_and_restore_queue",
    ]

    private var isolation: AgentIsolationModel { .shared }

    func register(on host: HostEndpoint, windowId: String, bridge: WebBridge) {
        host.register(HostMethods.AgentStatus.self) { [weak self] _ in
            guard let self else { throw BridgeFailure(.hostUnavailable, "Ocelot is shutting down.") }
            return await self.status()
        }
        host.register(HostMethods.AgentLogin.self) { [weak self] _ in
            guard let self else { throw BridgeFailure(.hostUnavailable, "Ocelot is shutting down.") }
            try await self.openLoginInTerminal()
            return await self.status()
        }
        host.register(HostMethods.AgentInstall.self) { [weak self] _ in
            guard let self else { throw BridgeFailure(.hostUnavailable, "Ocelot is shutting down.") }
            try OmpInstaller.openInTerminal(await self.installPlan())
            return await self.status()
        }
        host.register(HostMethods.AgentStart.self) { [weak self, weak bridge] params in
            guard let self, let bridge else { throw BridgeFailure(.hostUnavailable, "The editor window is closed.") }
            do {
                try await self.start(params, windowId: windowId, bridge: bridge)
            } catch {
                self.isolation.lastError = (error as? BridgeFailure)?.message ?? error.localizedDescription
                throw error
            }
            return Empty()
        }
        host.register(HostMethods.AgentSend.self) { [weak self] params in
            try self?.send(params)
            return Empty()
        }
        host.register(HostMethods.AgentStop.self) { [weak self] params in
            self?.stop(params.processId)
            return Empty()
        }
        // The sidebar's saved conversations: the host only stores them (summary and transcript are the editor's own JSON).
        host.register(HostMethods.AgentHistoryList.self) { [weak self] params in
            guard let self else { throw BridgeFailure(.hostUnavailable, "Ocelot is shutting down.") }
            return AgentHistoryEntries(entries: try await self.history { try $0.list(projectId: params.projectId) })
        }
        host.register(HostMethods.AgentHistoryRead.self) { [weak self] params in
            guard let self else { throw BridgeFailure(.hostUnavailable, "Ocelot is shutting down.") }
            return try await self.history { try $0.read(projectId: params.projectId, id: params.id) }
        }
        host.register(HostMethods.AgentHistoryWrite.self) { [weak self] params in
            guard let self else { throw BridgeFailure(.hostUnavailable, "Ocelot is shutting down.") }
            try await self.history { try $0.write(projectId: params.projectId, id: params.id, meta: params.meta, transcript: params.transcript) }
            return Empty()
        }
        host.register(HostMethods.AgentHistoryDelete.self) { [weak self] params in
            guard let self else { throw BridgeFailure(.hostUnavailable, "Ocelot is shutting down.") }
            try await self.history { try $0.remove(projectId: params.projectId, id: params.id) }
            return Empty()
        }
    }

    /// Runs file work on the saved conversations off the main actor (transcripts can be megabytes).
    private func history<T: Sendable>(_ work: @escaping @Sendable (AgentHistoryStore) throws -> T) async throws -> T {
        let store = AgentHistoryStore(root: try OmpCLI.agentDirectory())
        return try await Task.detached { try work(store) }.value
    }

    /// Stops every agent, the sandbox service connection and the credential path (app quit, or the
    /// isolation setting changed). omp would otherwise outlive the app.
    func terminateAll(includingGateway: Bool = false) {
        for running in processes.values {
            running.handle.closeInput()
            running.handle.terminate()
        }
        processes.removeAll()
        pendingStarts.cancelAll()
        AgentServiceConnection.shared.shutdown()
        if includingGateway { AuthGateway.shared.stop() }
    }

    /// Stops the agent of a window that closed.
    func stopWindow(_ windowId: String) {
        pendingStarts.cancelWindow(windowId)
        for (id, running) in processes where running.windowId == windowId { stop(id) }
    }

    // MARK: - Status and sign-in

    /// bun/npm detection starts the login shell, so it runs off the main actor.
    private func installPlan() async -> OmpInstallPlan {
        await Task.detached { OmpInstaller.plan() }.value
    }

    private func status() async -> AgentInfo {
        // The unit-test host must not run the user's login shell, omp, or the broker and gateway behind them.
        guard !AppEnvironment.underTest else {
            return AgentInfo(available: false, loggedIn: false, error: "The agent is switched off while Ocelot runs its unit tests.")
        }
        guard let cli = await OmpLocator.shared.cli() else {
            let plan = await installPlan()
            return AgentInfo(available: false, loggedIn: false, error: "omp was not found. Install it with \"bun install -g @oh-my-pi/pi-coding-agent\" (or set OCELOT_OMP_PATH), then check again.",
                             installer: plan.installer, installCommand: plan.command)
        }
        guard let version = await cli.capture(["--version"], timeout: 15), version.status == 0 else {
            OmpLocator.shared.forget()
            let plan = await installPlan()
            return AgentInfo(available: false, loggedIn: false, path: cli.path, error: "omp at \(cli.path) is installed but did not run.",
                             installer: plan.installer, installCommand: plan.command)
        }
        var models: JSONValue?
        if let listed = await cli.capture(["models", "--json"], timeout: 60),
           let data = listed.stdout.data(using: .utf8),
           let value = try? JSONDecoder().decode(JSONValue.self, from: data) {
            models = value
        }
        let v = version.stdout.split(whereSeparator: \.isWhitespace).last.map(String.init)
        if isolation.unconfined {
            var count = 0
            if case .object(let object)? = models, case .array(let list)? = object["models"] { count = list.count }
            return AgentInfo(available: true, loggedIn: count > 0, version: v, path: cli.path, models: models, isolation: "unconfined",
                             warning: "The agent runs unconfined (you turned confinement off in Settings > Agent): it can read your files and your omp credentials.")
        }
        do {
            let (picker, info) = try await prepare(cli: cli, hostModels: models)
            isolation.lastError = nil
            return AgentInfo(available: true, loggedIn: !picker.selectors.isEmpty, version: v, path: cli.path, models: info, isolation: "sandboxed", gatewayPort: gatewayPort)
        } catch {
            let message = (error as? BridgeFailure)?.message ?? error.localizedDescription
            isolation.lastError = message
            return AgentInfo(available: false, loggedIn: false, version: v, path: cli.path, error: message, isolation: "sandboxed")
        }
    }

    private var gatewayPort: Int? {
        if case .running(let port) = AuthGateway.shared.state { return port }
        return nil
    }

    /// Starts the gateway and works out which models the confined agent may use.
    private func prepare(cli: OmpCLI, hostModels: JSONValue?) async throws -> (Prepared, JSONValue) {
        // Unpack omp's helper dylib for the sandbox once per omp version (the first time takes a few seconds).
        _ = try await cli.prepareAgentTemporaryDirectory(version: await Self.version(cli))
        let gateway = AuthGateway.shared
        let served = try await gateway.servedModelIds()
        let selectors = AgentModels.pickerSelectors(hostModels: hostModels, served: served)
        gateway.setGrant(selectors)
        try await gateway.spareReady() // the first message must not wait for the gateway's 10 s clients reload
        var userDefault: String?
        if let roles = await cli.capture(["config", "get", "modelRoles", "--json"], timeout: 15),
           let object = try? JSONSerialization.jsonObject(with: Data(roles.stdout.utf8)) as? [String: Any],
           let value = object["value"] as? [String: Any] {
            userDefault = value["default"] as? String
        }
        var level = ""
        if let out = await cli.capture(["config", "get", "defaultThinkingLevel", "--json"], timeout: 15),
           let object = try? JSONSerialization.jsonObject(with: Data(out.stdout.utf8)) as? [String: Any] {
            level = object["value"] as? String ?? ""
        }
        let picker = Prepared(selectors: selectors, defaultModel: AgentLaunch.defaultSelector(userDefault: userDefault, selectors: selectors), thinking: level)
        prepared = picker
        return (picker, AgentModels.filter(hostModels, selectors: selectors))
    }

    /// `omp login` is interactive (browser OAuth, provider picker), so it runs in Terminal.
    private func openLoginInTerminal() async throws {
        guard let cli = await OmpLocator.shared.cli() else {
            throw BridgeFailure(.hostUnavailable, "omp was not found. Install it with \"bun install -g @oh-my-pi/pi-coding-agent\".")
        }
        let script = try OmpCLI.agentDirectory().appendingPathComponent("Sign in to omp.command")
        let path = cli.environment["PATH"] ?? ""
        let body = "#!/bin/zsh\nexport PATH=\(Self.shellQuote(path))\n\(Self.shellQuote(cli.path)) login\necho\necho 'Signed in? Go back to Ocelot and click Check again.'\n"
        try body.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        guard NSWorkspace.shared.open(script) else {
            throw BridgeFailure(.internal, "Could not open Terminal. Run \"omp login\" in a terminal, then click Check again.")
        }
    }

    // MARK: - Processes

    private func start(_ params: AgentStartParams, windowId: String, bridge: WebBridge) async throws {
        // One conversation per window: a new start replaces the window's previous process.
        pendingStarts.cancelWindow(windowId)
        pendingStarts.begin(params.processId, window: windowId)
        var settled = false
        defer { if !settled { _ = pendingStarts.finish(params.processId) } }
        for (id, running) in processes where running.windowId == windowId { stop(id) }
        guard let cli = await OmpLocator.shared.cli() else {
            throw BridgeFailure(.hostUnavailable, "omp was not found. Install it with \"bun install -g @oh-my-pi/pi-coding-agent\".")
        }
        // The conversation's own session directory (omp's memory of it); created before anything else starts.
        let sessionDirectory = try await history { try $0.sessionDirectory(projectId: params.projectId, conversationId: params.conversationId) }
        let resume = params.resume ?? false
        let mcp = MCPService.shared
        guard mcp.statusForEditor.running else {
            throw BridgeFailure(.hostUnavailable, "The MCP server is not running (\(mcp.statusForEditor.error ?? "stopped")). Check Ocelot > Settings.")
        }

        // The agent reaches this window only: a window-scoped token, never the master token.
        let mcpToken = mcp.issueToken(scope: .window(windowId), readOnly: false, ttl: nil)
        let mcpConfig = try AgentLaunch.mcpConfig(url: mcp.url(for: .window(windowId)), token: mcpToken)
        var gatewayClient: String?
        let processId = params.processId
        let (chunks, sink) = AsyncStream.makeStream(of: AgentChunk.self)
        let handle: any AgentProcessHandle
        var cleanupDirectory: URL?
        do {
            if isolation.unconfined {
                let dir = try OmpCLI.agentDirectory().appendingPathComponent(windowId, isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let overlay = dir.appendingPathComponent("config.yml")
                let prompt = dir.appendingPathComponent("system-prompt.md")
                try mcpConfig.write(to: dir.appendingPathComponent(".mcp.json"))
                try AgentLaunch.configOverlay().write(to: overlay, atomically: true, encoding: .utf8)
                try params.systemPrompt.write(to: prompt, atomically: true, encoding: .utf8)
                let args = AgentLaunch.ompArguments(configFile: overlay.path, systemPromptFile: prompt.path, model: params.model, thinking: params.thinking, sessionDirectory: sessionDirectory.path, resume: resume)
                handle = try LocalAgentProcess.spawn(cli, arguments: args, directory: dir, sink: sink)
                cleanupDirectory = dir
            } else {
                let picker: Prepared
                if let prepared { picker = prepared } else {
                    let hostModels = await Self.hostModels(cli)
                    picker = try await prepare(cli: cli, hostModels: hostModels).0
                }
                guard !picker.selectors.isEmpty else {
                    throw BridgeFailure(.hostUnavailable, "No model is available to the agent. Sign in with \"omp login\", then check again.")
                }
                let tmp = try await cli.prepareAgentTemporaryDirectory(version: await Self.version(cli))
                let gateway = AuthGateway.shared
                try await gateway.start()
                let client = try await gateway.mintAgentClient()
                gatewayClient = client.name
                let request = AgentServiceStart(
                    sessionId: processId, ompPath: cli.resolvedPath, systemPrompt: params.systemPrompt,
                    model: params.model, thinking: params.thinking,
                    mcpConfig: String(decoding: try AgentLaunch.confinedMCPConfig(url: mcp.url(for: .window(windowId))), as: UTF8.self),
                    modelsYml: try AgentLaunch.modelsYml(baseURL: gateway.baseURL, providers: AgentModels.providers(picker.selectors)),
                    overlay: AgentLaunch.configOverlay(defaultModel: picker.defaultModel, thinkingLevel: picker.thinking, extraDisabled: AgentLaunch.confinedModelProvidersOff),
                    gatewayToken: client.token, mcpToken: mcpToken, temporaryDirectory: tmp.path,
                    sessionDirectory: sessionDirectory.resolvingSymlinksInPath().path, resume: resume)
                handle = try await XPCAgentProcess.start(request, sink: sink)
            }
        } catch {
            mcp.revokeToken(mcpToken)
            if let gatewayClient { await AuthGateway.shared.revokeClient(gatewayClient) }
            sink.finish()
            throw error
        }
        isolation.lastError = nil
        processes[processId] = Running(handle: handle, windowId: windowId)
        settled = true
        let stopRequested = pendingStarts.finish(processId)
        log.info("agent \(processId, privacy: .public) started (\(self.isolation.unconfined ? "unconfined" : "sandboxed", privacy: .public))")

        Task { @MainActor [weak self, weak bridge] in
            var buffer = Data()
            var errTail = Data()
            var stdoutClosed = false
            var exitCode: Int32?
            for await chunk in chunks {
                switch chunk {
                case .stdout(let data):
                    buffer.append(data)
                    let lines = Self.takeLines(&buffer)
                    if !lines.isEmpty {
                        guard let bridge else { handle.terminate(); continue }
                        await Self.deliver(bridge, AgentEventParams(processId: processId, lines: lines, done: false))
                    }
                case .stderr(let data):
                    errTail.append(data)
                    if errTail.count > 4000 { errTail = errTail.suffix(4000) }
                case .stdoutClosed:
                    stdoutClosed = true
                case .exit(let code):
                    exitCode = code
                }
                if stdoutClosed, let code = exitCode {
                    let rest = String(decoding: buffer, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                    let done = AgentEventParams(processId: processId, lines: rest.isEmpty ? [] : [rest], done: true, exitCode: Int(code), stderr: String(decoding: errTail, as: UTF8.self))
                    if let bridge { await Self.deliver(bridge, done) }
                    sink.finish()
                }
            }
            // The conversation is over: its credentials die with it.
            MCPService.shared.revokeToken(mcpToken)
            if let gatewayClient { await AuthGateway.shared.revokeClient(gatewayClient) }
            if let cleanupDirectory { try? FileManager.default.removeItem(at: cleanupDirectory.appendingPathComponent(".mcp.json")) }
            self?.processes[processId] = nil
            self?.log.info("agent \(processId, privacy: .public) exited")
        }
        // A stop that arrived while omp was starting: end it now; the task above revokes the credentials.
        if stopRequested { stop(processId) }
    }

    private func send(_ params: AgentSendParams) throws {
        guard let running = processes[params.processId], running.handle.isRunning else {
            throw BridgeFailure(.hostUnavailable, "The agent process is not running. Send your message again to restart it.")
        }
        guard case .object(let command) = params.command, case .string(let type)? = command["type"] else {
            throw BridgeFailure(.invalidParams, "An agent command must be a JSON object with a \"type\".")
        }
        guard Self.allowedCommands.contains(type) else {
            throw BridgeFailure(.invalidParams, "The agent sidebar may not send \"\(type)\" commands.")
        }
        var line = try JSONEncoder().encode(params.command)
        line.append(UInt8(ascii: "\n"))
        do {
            try running.handle.write(line)
        } catch {
            throw BridgeFailure(.hostUnavailable, "Could not reach the agent process: \(error.localizedDescription). Start a new chat.")
        }
    }

    private func stop(_ processId: String) {
        pendingStarts.cancel(processId)
        guard let running = processes.removeValue(forKey: processId) else { return }
        running.handle.closeInput() // omp drains and exits on EOF
        let handle = running.handle
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            if handle.isRunning { handle.terminate() }
        }
    }

    private static func version(_ cli: OmpCLI) async -> String {
        (await cli.capture(["--version"], timeout: 15))?.stdout.split(whereSeparator: { $0.isWhitespace || $0 == "/" }).last.map(String.init) ?? "unknown"
    }

    private static func hostModels(_ cli: OmpCLI) async -> JSONValue? {
        guard let listed = await cli.capture(["models", "--json"], timeout: 60) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: Data(listed.stdout.utf8))
    }

    private static func deliver(_ bridge: WebBridge, _ event: AgentEventParams) async {
        _ = try? await bridge.editor.call(EditorMethods.AgentEvent.self, event, timeout: .seconds(10))
    }

    /// Removes complete lines from `buffer`; the incomplete tail stays.
    nonisolated static func takeLines(_ buffer: inout Data) -> [String] {
        guard let last = buffer.lastIndex(of: UInt8(ascii: "\n")) else { return [] }
        let complete = buffer[buffer.startIndex..<last]
        buffer = Data(buffer[buffer.index(after: last)...])
        return complete.split(separator: UInt8(ascii: "\n"))
            .map { String(decoding: $0, as: UTF8.self) }
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    nonisolated private static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

/// Agent starts in flight (they await omp's location, the gateway and the XPC service). A stop or a window
/// close that arrives meanwhile finds no process to stop, so it is recorded here and honoured when the start ends.
struct PendingStarts {
    private var windows: [String: String] = [:]
    private var cancelled: Set<String> = []

    mutating func begin(_ processId: String, window: String) { windows[processId] = window }

    /// Marks a start in flight as stopped; no-op for ids that are not starting.
    mutating func cancel(_ processId: String) {
        if windows[processId] != nil { cancelled.insert(processId) }
    }

    mutating func cancelWindow(_ window: String) {
        for (id, w) in windows where w == window { cancelled.insert(id) }
    }

    mutating func cancelAll() { cancelled.formUnion(windows.keys) }

    /// The start ended (registered or failed). True when a stop arrived while it was running.
    mutating func finish(_ processId: String) -> Bool {
        windows[processId] = nil
        return cancelled.remove(processId) != nil
    }
}
