import Darwin
import Foundation
import os

/// A loopback model gateway the host can hand scoped tokens of out. The agent gets its own token
/// from `AgentRunner`; other host-side callers (image generation) use this API. Tokens are
/// SHA-256-hashed into the gateway's `--clients` file and never leave the process otherwise.
final class AuthGatewayEndpoint: Sendable {
    /// Loopback base URL, e.g. `http://127.0.0.1:PORT`.
    let url: URL
    private let gateway: AuthGateway

    fileprivate init(url: URL, gateway: AuthGateway) {
        self.url = url
        self.gateway = gateway
    }

    /// A bearer token for this gateway. `models` nil grants every served model (`provider/id` or `provider/*` entries);
    /// `ttl` revokes it automatically. Waits until the gateway admits it (it re-reads its clients file every 10 s).
    func mintClientToken(models: [String]? = nil, ttl: Duration? = nil) async throws -> String {
        try await gateway.mintHostToken(models: models, ttl: ttl)
    }

    func revoke(_ token: String) async {
        await gateway.revokeToken(token)
    }
}

/// Supervises `omp auth-broker serve` (holds the user's real credentials) and
/// `omp auth-gateway serve --clients=<file>` on loopback: started on first use, restarted with
/// backoff, stopped on quit. Both run under a `/bin/sh` wrapper that kills them when the app dies,
/// even by SIGKILL. Mirrors editor/e2e/agent-gateway.mjs.
@MainActor
final class AuthGateway {
    static let shared = AuthGateway()

    enum State: Equatable, Sendable {
        case idle, starting, restarting
        case running(port: Int)
        case failed(String)
    }

    private(set) var state: State = .idle {
        didSet { AgentIsolationModel.shared.gateway = state }
    }

    private let log = Logger(subsystem: "sh.caracal.ocelot", category: "agent")
    private var loop: Task<Void, Never>?
    private var handles: [SupervisedChild] = []
    private var stopping = false
    private var port = 0
    private var adminToken = ""
    private var clients: [String: Entry] = [:]
    private var grant: [String] = []
    private let spareCount = 3
    private let instance = "\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString.prefix(6).lowercased())"
    private var flushChain: Task<Void, Error>?

    private struct Entry {
        var token: String
        var models: [String]?
        var spare: Bool
    }

    /// Starts the broker and gateway if needed and returns the endpoint for host-side callers.
    func ensureRunning() async throws -> AuthGatewayEndpoint {
        try await start()
        return AuthGatewayEndpoint(url: URL(string: baseURL)!, gateway: self)
    }

    var baseURL: String { "http://127.0.0.1:\(port)" }

    func start() async throws {
        if stopping { throw BridgeFailure(.hostUnavailable, "Ocelot is shutting down.") }
        if case .failed = state {
            state = .idle
            loop = nil
        }
        if loop == nil {
            guard let cli = await OmpLocator.shared.cli() else {
                throw BridgeFailure(.hostUnavailable, "omp was not found. Install it with \"bun install -g @oh-my-pi/pi-coding-agent\".")
            }
            if loop == nil { loop = Task { await self.supervise(cli) } }
        }
        let deadline = Date().addingTimeInterval(80)
        while true {
            switch state {
            case .running: return
            case .failed(let message): throw BridgeFailure(.hostUnavailable, message)
            default:
                if Date() > deadline {
                    throw BridgeFailure(.hostUnavailable, "The agent gateway is taking too long to start. Run \"omp auth-gateway status\" in a terminal, then try again.")
                }
                try await Task.sleep(for: .milliseconds(50))
            }
        }
    }

    /// Chat model ids the gateway serves (listed with its own token; the agent never sees it).
    func servedModelIds() async throws -> [String] {
        try await start()
        guard let url = URL(string: "\(baseURL)/v1/models"),
              let (status, data) = await Http.get(url, bearer: adminToken, timeout: 15), status == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = object["data"] as? [[String: Any]]
        else { throw BridgeFailure(.hostUnavailable, "The agent gateway refused the model list. Restart Ocelot.") }
        return list.filter { ($0["kind"] as? String ?? "chat") == "chat" }.compactMap { $0["id"] as? String }
    }

    /// The models new agent tokens may call (the picker's list). Rebuilds the spare pool when it changes.
    func setGrant(_ selectors: [String]) {
        let next = selectors.sorted()
        guard next != grant else { return }
        grant = next
        clients = clients.filter { !$0.value.spare }
        topUp()
    }

    /// Resolves once the gateway admits the spare tokens, so the first `mintAgentClient` does not wait for the 10 s reload.
    func spareReady() async throws {
        if let spare = clients.values.first(where: \.spare) { try await waitAdmitted(spare.token) }
    }

    /// A client token for one agent process, from the pre-minted spares when there is one.
    func mintAgentClient() async throws -> (name: String, token: String) {
        guard !grant.isEmpty else { throw BridgeFailure(.hostUnavailable, "The agent model list is not ready. Open the sidebar and check again.") }
        let name: String
        if let spare = clients.first(where: { $0.value.spare })?.key {
            clients[spare]?.spare = false
            name = spare
        } else {
            name = "ocelot-\(Self.randomHex(4))"
            clients[name] = Entry(token: Self.randomHex(32), models: grant, spare: false)
            try await flush()
        }
        topUp()
        let token = clients[name]!.token
        try await waitAdmitted(token)
        return (name, token)
    }

    func revokeClient(_ name: String) async {
        if clients.removeValue(forKey: name) != nil { try? await flush() }
    }

    fileprivate func mintHostToken(models: [String]?, ttl: Duration?) async throws -> String {
        try await start()
        let name = "ocelot-host-\(Self.randomHex(4))"
        let token = Self.randomHex(32)
        clients[name] = Entry(token: token, models: models, spare: false)
        try await flush()
        try await waitAdmitted(token)
        if let ttl {
            Task { [weak self] in
                try? await Task.sleep(for: ttl)
                await self?.revokeToken(token)
            }
        }
        return token
    }

    fileprivate func revokeToken(_ token: String) async {
        if let name = clients.first(where: { $0.value.token == token })?.key { await revokeClient(name) }
    }

    /// Stops the broker and gateway (app quit). Synchronous: SIGTERM now, the wrapper escalates.
    func stop() {
        stopping = true
        loop?.cancel()
        loop = nil
        killChildren()
        if let url = clientsURL { try? FileManager.default.removeItem(at: url) }
        state = .idle
    }

    // MARK: - Supervision

    private func supervise(_ cli: OmpCLI) async {
        var attempts = 0
        var backoff = 0.5
        state = .starting
        while !stopping, !Task.isCancelled {
            let started = Date()
            var failure = ""
            do {
                try await launch(cli)
                if stopping { break } // stop() ran mid-launch: the tail below kills what was spawned
                state = .running(port: port)
                // Wait until either child exits.
                let (exits, signal) = AsyncStream<Void>.makeStream()
                for handle in handles { Task { await handle.waitForExit(); signal.yield() } }
                for await _ in exits { break }
                if stopping { break }
                let dead = handles.first { !$0.isRunning }
                failure = "exited: \(dead?.tail.split(separator: "\n").suffix(3).joined(separator: " | ") ?? "")"
            } catch {
                failure = (error as? BridgeFailure)?.message ?? error.localizedDescription
            }
            if stopping { break }
            let message = "The agent gateway stopped: \(failure)"
            log.error("\(message, privacy: .public)")
            killChildren()
            attempts = Date().timeIntervalSince(started) > 60 ? 1 : attempts + 1
            if attempts >= 5 {
                state = .failed("\(message) Check that omp is signed in (\"omp login\") and run \"omp auth-gateway status\".")
                loop = nil
                return
            }
            state = .restarting
            try? await Task.sleep(for: .seconds(backoff))
            backoff = min(backoff * 2, 10)
        }
        killChildren() // anything launch spawned after stop() killed the previous set
    }

    private func launch(_ cli: OmpCLI) async throws {
        let home = try Self.homeURL()
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        GatewayClientFiles.removeStale(in: home)
        try await flush()
        let brokerPort = try Http.freePort()
        port = try Http.freePort()
        let brokerURL = "http://127.0.0.1:\(brokerPort)"

        guard let tokenOutput = await cli.capture(["auth-broker", "token", "--json"], timeout: 30), tokenOutput.status == 0,
              let object = try? JSONSerialization.jsonObject(with: Data(tokenOutput.stdout.utf8)) as? [String: Any],
              let brokerToken = object["token"] as? String
        else { throw BridgeFailure(.hostUnavailable, "omp could not provide its credential broker token. Run \"omp auth-broker status\".") }

        try assertNotStopping()
        let broker = try SupervisedChild.spawn(cli.path, ["auth-broker", "serve", "--bind", "127.0.0.1:\(brokerPort)"], environment: cli.environment)
        handles = [broker]
        try await Self.waitHealthy("\(brokerURL)/v1/healthz", broker, "The credential broker")

        var env = cli.environment
        env["HOME"] = home.path
        env["OMP_AUTH_BROKER_URL"] = brokerURL
        env["OMP_AUTH_BROKER_TOKEN"] = brokerToken
        guard let clientsURL else { throw BridgeFailure(.internal, "No gateway clients file.") }
        try assertNotStopping()
        let gateway = try SupervisedChild.spawn(cli.path, ["auth-gateway", "serve", "--bind", "127.0.0.1:\(port)", "--clients=\(clientsURL.path)"], environment: env)
        handles = [broker, gateway]
        try await Self.waitHealthy("http://127.0.0.1:\(port)/healthz", gateway, "The model gateway")
        let tokenFile = home.appendingPathComponent(".omp/auth-gateway.token")
        adminToken = ((try? String(contentsOf: tokenFile, encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        log.info("agent gateway on 127.0.0.1:\(self.port) (broker \(brokerPort))")
    }

    /// `launch` awaits steps that ignore task cancellation (the token capture); never spawn after `stop()`.
    private func assertNotStopping() throws {
        if stopping || Task.isCancelled { throw BridgeFailure(.hostUnavailable, "Ocelot is shutting down.") }
    }

    private func killChildren() {
        let dying = handles
        handles = []
        for handle in dying { handle.terminate() }
    }

    private static func waitHealthy(_ url: String, _ child: SupervisedChild, _ what: String) async throws {
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if !child.isRunning {
                throw BridgeFailure(.hostUnavailable, "\(what) exited at startup: \(child.tail.split(separator: "\n").suffix(3).joined(separator: " | "))")
            }
            if let target = URL(string: url), let (status, _) = await Http.get(target, bearer: nil, timeout: 1.5), status == 200 { return }
            try await Task.sleep(for: .milliseconds(150))
        }
        throw BridgeFailure(.hostUnavailable, "\(what) did not become ready within 30 s.")
    }

    // MARK: - Clients file

    nonisolated private static func homeURL() throws -> URL {
        try OmpCLI.agentDirectory().appendingPathComponent("gateway-home", isDirectory: true)
    }

    /// Removes the clients files (and half-written `.tmp` files) of Ocelots that are no longer running; a killed app never
    /// reaches `stop()`. Never touches a live one. Runs at app launch and before every gateway start.
    nonisolated static func removeStaleClientFiles() {
        guard let home = try? homeURL() else { return }
        GatewayClientFiles.removeStale(in: home)
    }

    private var clientsURL: URL? {
        (try? Self.homeURL())?.appendingPathComponent("clients-\(instance).json")
    }

    private func topUp() {
        guard !grant.isEmpty else { return }
        var spares = clients.values.filter(\.spare).count
        while spares < spareCount {
            clients["ocelot-spare-\(Self.randomHex(4))"] = Entry(token: Self.randomHex(32), models: grant, spare: true)
            spares += 1
        }
        Task { try? await flush() }
    }

    /// Writes the clients file atomically (the gateway must never read half a file); writes are serialized.
    private func flush() async throws {
        guard let url = clientsURL else { return }
        let list = clients.map { AgentLaunch.Client(name: $0.key, token: $0.value.token, models: $0.value.models) }
        let previous = flushChain
        let write = Task.detached {
            _ = try? await previous?.value
            let body = try AgentLaunch.clientsFile(list)
            let tmp = url.appendingPathExtension("tmp")
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try body.write(to: tmp, options: [])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmp.path)
            _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        }
        flushChain = write
        try await write.value
    }

    private func waitAdmitted(_ token: String) async throws {
        let deadline = Date().addingTimeInterval(40) // the gateway re-reads its clients file every 10 s
        guard let url = URL(string: "\(baseURL)/v1/models") else { return }
        while Date() < deadline {
            if let (status, _) = await Http.get(url, bearer: token, timeout: 3), status == 200 { return }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw BridgeFailure(.hostUnavailable, "The agent gateway did not admit the new agent token. Try again in a moment.")
    }

    nonisolated private static func randomHex(_ bytes: Int) -> String {
        (0..<bytes).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }
}

/// The gateway's `clients-<pid>-<id>.json` files: one per running Ocelot, named after its pid.
enum GatewayClientFiles {
    /// The pid in `clients-<pid>-<id>.json` or `clients-<pid>-<id>.json.tmp`; nil for any other name.
    static func pid(ofFileNamed name: String) -> pid_t? {
        guard name.hasPrefix("clients-"), name.hasSuffix(".json") || name.hasSuffix(".json.tmp") else { return nil }
        let parts = name.dropFirst("clients-".count).split(separator: "-", maxSplits: 1)
        guard parts.count == 2, let pid = pid_t(parts[0]), pid > 0 else { return nil }
        return pid
    }

    /// Whether a process with this pid exists (EPERM: it exists and belongs to someone else).
    static func isRunning(_ pid: pid_t) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    /// Deletes the files in `directory` whose pid is not running. Returns the removed names.
    @discardableResult
    static func removeStale(in directory: URL, isRunning: (pid_t) -> Bool = GatewayClientFiles.isRunning) -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        var removed: [String] = []
        for name in names.sorted() {
            guard let pid = pid(ofFileNamed: name), !isRunning(pid) else { continue }
            if (try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))) != nil { removed.append(name) }
        }
        return removed
    }
}

// MARK: - Child processes and HTTP

/// A command run under the `/bin/sh` wrapper that kills it when this process dies: the app holds the
/// wrapper's stdin pipe, so EOF means the app is gone (even after SIGKILL). A signal interrupts `wait`, so the
/// wrapper keeps waiting until the command has really exited: its exit means "stopped". The delayed `kill -9`
/// backstops are cancelled once the command is gone, so they never hit a recycled pid. Same script as
/// `SUPERVISED_WRAPPER` in editor/e2e/agent-sandbox.mjs.
final class SupervisedChild: @unchecked Sendable {
    static let wrapper = """
    exec 3<&0
    "$@" 3<&- & p=$!
    ( while IFS= read -r _ <&3; do :; done; kill $p 2>/dev/null; sleep 3; kill -9 $p 2>/dev/null ) & w=$!
    k=
    trap 'kill $p 2>/dev/null; ( sleep 3; kill -9 $p 2>/dev/null ) >/dev/null 2>&1 & k=$!' TERM INT HUP
    wait $p; rc=$?
    while kill -0 $p 2>/dev/null; do wait $p; rc=$?; done
    kill $w $k 2>/dev/null
    exit $rc
    """

    private let process: Process
    private let stdin: Pipe
    private let lock = NSLock()
    private var output = Data()
    private var exited = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    private init(process: Process, stdin: Pipe) {
        self.process = process
        self.stdin = stdin
    }

    static func spawn(_ command: String, _ args: [String], environment: [String: String]) throws -> SupervisedChild {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", wrapper, "sh", command] + args
        process.environment = environment
        let stdin = Pipe(), out = Pipe()
        process.standardInput = stdin
        process.standardOutput = out
        process.standardError = out
        let child = SupervisedChild(process: process, stdin: stdin)
        out.fileHandleForReading.readabilityHandler = { [weak child] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { child?.append(data) }
        }
        process.terminationHandler = { [weak child] _ in child?.markExited() }
        do { try process.run() } catch {
            throw BridgeFailure(.internal, "Could not start \(command): \(error.localizedDescription)")
        }
        return child
    }

    var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !exited
    }

    var tail: String {
        lock.lock()
        defer { lock.unlock() }
        return String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func waitForExit() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            if exited {
                lock.unlock()
                continuation.resume()
            } else {
                waiters.append(continuation)
                lock.unlock()
            }
        }
    }

    /// EOF on the wrapper's stdin makes it kill its command; SIGTERM covers a wrapper stuck elsewhere.
    func terminate() {
        try? stdin.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
    }

    private func append(_ data: Data) {
        lock.lock()
        output.append(data)
        if output.count > 4000 { output = output.suffix(4000) }
        lock.unlock()
    }

    private func markExited() {
        lock.lock()
        exited = true
        let pending = waiters
        waiters = []
        lock.unlock()
        for waiter in pending { waiter.resume() }
    }
}

enum Http {
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:] // loopback only: never through a system proxy
        config.timeoutIntervalForRequest = 15
        return URLSession(configuration: config)
    }()

    static func get(_ url: URL, bearer: String?, timeout: TimeInterval) async -> (Int, Data)? {
        var request = URLRequest(url: url, timeoutInterval: timeout)
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        guard let (data, response) = try? await session.data(for: request), let http = response as? HTTPURLResponse else { return nil }
        return (http.statusCode, data)
    }

    /// A free loopback port. Small race between close and the child's bind; the supervisor retries.
    static func freePort() throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw BridgeFailure(.internal, "Could not open a socket to pick a gateway port.") }
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = 0
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { throw BridgeFailure(.internal, "Could not reserve a loopback port for the agent gateway.") }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard named == 0 else { throw BridgeFailure(.internal, "Could not read the reserved loopback port.") }
        return Int(UInt16(bigEndian: address.sin_port))
    }
}
