import Foundation
#if canImport(Darwin)
import Darwin
#endif

struct RunOptions: Sendable, Equatable {
    var path: String
    var create = false
    var image: String = "ocelot-headless:dev"
    var cpus = "2"
    var memory = "2g"
    var idleStopMinutes = 30
    var runtime: ContainerRuntimeKind?
    /// Print the container's own endpoint instead of the Mac front door's `/mcp/p/<id>`.
    var direct = false
    var json = false
    var healthTimeout: TimeInterval = 60
}

struct RunResult: Sendable, Equatable {
    var instance: String
    var containerName: String
    var containerId: String
    var runtime: ContainerRuntimeKind
    var image: String
    var projectId: String
    var projectName: String
    var packagePath: String
    /// The container's own endpoint (loopback, published port) with its token.
    var directURL: String
    var token: String
    var tokenFile: String
    /// `/mcp/p/<id>` on a live Ocelot app instance, with a token limited to this project minted by that app.
    /// Nil when no app is running (or it would not mint one): the app's master token is never printed.
    var frontDoorURL: String?
    var frontDoorToken: String?
    /// Always nil today: the scoped token lives in the app's memory and has no file.
    var frontDoorTokenFile: String?
    var idleStopMinutes: Int
}

protocol HealthProbing: Sendable {
    /// GET /healthz on the published port. Returns the reported project id on success.
    func probe(port: Int) -> HealthzReply?
}

struct HealthzReply: Sendable, Equatable {
    var projectId: String?
}

/// Real probe: a short loopback HTTP request.
struct HTTPHealthProbe: HealthProbing {
    func probe(port: Int) -> HealthzReply? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/healthz") else { return nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 2
        configuration.connectionProxyDictionary = [:] // loopback must never go through a proxy
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        let box = ResultBox()
        let done = DispatchSemaphore(value: 0)
        session.dataTask(with: url) { data, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                box.set(HealthzReply(projectId: object?["projectId"] as? String))
            }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 4)
        return box.value
    }

    private final class ResultBox: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: HealthzReply?
        var value: HealthzReply? { lock.lock(); defer { lock.unlock() }; return stored }
        func set(_ reply: HealthzReply) { lock.lock(); stored = reply; lock.unlock() }
    }
}

/// Canonical form used to compare package paths (symlinks, `..`, trailing slash).
func canonicalPath(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().standardized.path
}

/// `ocelot run` / `ocelot stop`: start and stop the project container and keep the run-dir entry truthful.
struct ContainerRunner: Sendable {
    var detector = BackendDetector()
    var runner: CommandRunning = ProcessRunner()
    var runDirectory = InstanceDirectory.standard
    var probe: HealthProbing = HTTPHealthProbe()
    var allocatePort: @Sendable () throws -> Int = { try PortAllocator.freeLoopbackPort() }
    var makeToken: @Sendable () -> String = { TokenGenerator.hex(bytes: 32) }
    var sleep: @Sendable (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }
    var now: @Sendable () -> Date = { Date() }
    /// Asks a running app (with its master token, from the run directory) for a token limited to one project.
    var mintFrontDoorToken: @Sendable (InstanceRecord, String, InstanceDirectory) -> String? = { app, projectId, directory in
        guard let master = directory.readToken(instance: app.instance), let url = URL(string: app.http + "/ocelot/v1/tokens"),
              let body = try? JSONSerialization.data(withJSONObject: ["scope": "project", "id": projectId]) else { return nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:] // loopback must never go through a proxy
        configuration.timeoutIntervalForRequest = 5
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("Bearer \(master)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        final class Box: @unchecked Sendable { var token: String? }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { data, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == 200,
               let object = data.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) {
                box.token = object["token"] as? String
            }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 6)
        return box.token
    }

    // MARK: run

    func run(_ options: RunOptions) throws -> RunResult {
        let path = canonicalPath((options.path as NSString).expandingTildeInPath)
        try validatePackage(path: path, create: options.create)

        let backend = try detector.detect(preferred: options.runtime)
        let runtime = ContainerRuntime(backend: backend, runner: runner)
        guard try runtime.imageExists(options.image) else { throw ContainerError.imageMissing(options.image, backend.kind) }

        try runDirectory.prepare()
        reapStale(runtime: runtime)

        let knownId = Self.readProjectId(packagePath: path)
        try enforceSingleWriter(path: path, projectId: knownId, runtime: runtime)

        let hash = Self.shortHash(path)
        let instance = "container-\(hash)"
        let containerName = "ocelot-\(hash)"
        // A stopped leftover with this name (idle stop, crash) is safe to replace; a running one is caught above.
        if runtime.exists(containerName) { runtime.remove(containerName) }

        let token = makeToken()
        let envFile = runDirectory.url.appendingPathComponent(".\(instance).env")
        try InstanceDirectory.writeAtomically(Data("OCELOT_PROJECT_TOKEN=\(token)\n".utf8), to: envFile)
        defer { try? FileManager.default.removeItem(at: envFile) }

        var spec = ContainerRunSpec(
            instance: instance, containerName: containerName, image: options.image, packagePath: path,
            hostPort: 0, cpus: options.cpus, memory: options.memory, idleStopMinutes: options.idleStopMinutes,
            envFile: envFile.path
        )
        var containerId: String?
        var lastFailure: ContainerError?
        for _ in 0..<3 {
            spec.hostPort = try allocatePort()
            do {
                containerId = try runtime.start(spec)
                break
            } catch let error as ContainerError {
                lastFailure = error
                // The allocated port can be taken between allocation and publish; any other failure will fail again.
                runtime.remove(containerName)
                guard case .startFailed(let detail) = error, detail.localizedCaseInsensitiveContains("port") else { throw error }
            }
        }
        guard let startedId = containerId else { throw lastFailure ?? ContainerError.startFailed("unknown error") }

        // Wait for /healthz; bail with the container's own output if it dies first.
        let deadline = now().addingTimeInterval(options.healthTimeout)
        var reply: HealthzReply?
        while now() < deadline {
            reply = probe.probe(port: spec.hostPort)
            if reply != nil { break }
            if !runtime.isRunning(containerName) { break }
            sleep(0.25)
        }
        guard let health = reply else {
            let output = runtime.logs(containerName)
            runtime.remove(containerName)
            throw ContainerError.notHealthy(output.isEmpty ? "(no output)" : output)
        }

        // The host persists the id into document.json on first start, so reading it again is the fallback for older builds.
        guard let projectId = health.projectId ?? Self.readProjectId(packagePath: path) else {
            let output = runtime.logs(containerName)
            runtime.remove(containerName)
            throw ContainerError.notHealthy("The editor reported no project id (is the image older than this CLI? rebuild with `make container`).\n\(output)")
        }
        let projectName = Self.readProjectName(packagePath: path)
            ?? URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent

        // Token first, then the record: a reader that sees the record can always read the token.
        try runDirectory.writeToken(token, instance: instance)
        try runDirectory.publish(InstanceRecord(
            instance: instance, kind: .container, pid: nil, containerId: startedId, runtime: backend.kind.rawValue,
            started: ISO8601DateFormatter().string(from: now()), http: "http://127.0.0.1:\(spec.hostPort)", socket: nil,
            projects: [RunProject(id: projectId, name: projectName, path: path, windowId: nil)]
        ))

        // The front door needs a token limited to this project (`/ocelot/v1/tokens`), never the app's master token.
        let frontDoor = liveAppInstance()
        let frontDoorToken = frontDoor.flatMap { mintFrontDoorToken($0, projectId, runDirectory) }
        let reachableFrontDoor = frontDoorToken == nil ? nil : frontDoor
        return RunResult(
            instance: instance, containerName: containerName, containerId: startedId, runtime: backend.kind, image: options.image,
            projectId: projectId, projectName: projectName, packagePath: path,
            directURL: "http://127.0.0.1:\(spec.hostPort)/mcp", token: token, tokenFile: runDirectory.tokenURL(instance).path,
            frontDoorURL: reachableFrontDoor.map { "\($0.http)/mcp/p/\(projectId)" },
            frontDoorToken: frontDoorToken,
            frontDoorTokenFile: nil,
            idleStopMinutes: options.idleStopMinutes
        )
    }

    // MARK: stop

    /// Stops containers matching `target` (project id, unique id prefix, name or slug, instance, container id, or package path). Returns the stopped instances.
    @discardableResult
    func stop(target: String, runtimeOverride: ContainerRuntimeKind? = nil) throws -> [InstanceRecord] {
        let matches = Self.matchContainerEntries(allRecords(), target: target)
        guard !matches.isEmpty else { throw ContainerError.noSuchContainer(target) }
        return try stop(entries: matches, runtimeOverride: runtimeOverride)
    }

    @discardableResult
    func stopAll(runtimeOverride: ContainerRuntimeKind? = nil) throws -> [InstanceRecord] {
        try stop(entries: allRecords().filter { $0.kind == .container }, runtimeOverride: runtimeOverride)
    }

    private func stop(entries: [InstanceRecord], runtimeOverride: ContainerRuntimeKind?) throws -> [InstanceRecord] {
        var stopped: [InstanceRecord] = []
        for entry in entries {
            let kind = runtimeOverride ?? entry.runtime.flatMap(ContainerRuntimeKind.init(rawValue:))
            let backend = try detector.detect(preferred: kind)
            let runtime = ContainerRuntime(backend: backend, runner: runner)
            let name = entry.containerId ?? "ocelot-\(entry.instance.dropFirst("container-".count))"
            try runtime.stopAndRemove(name)
            // Entries are keyed by instance; the container name is derived from the same hash.
            runtime.remove("ocelot-\(entry.instance.dropFirst("container-".count))")
            runDirectory.remove(instance: entry.instance)
            stopped.append(entry)
        }
        return stopped
    }

    static func matchContainerEntries(_ entries: [InstanceRecord], target: String) -> [InstanceRecord] {
        let containers = entries.filter { $0.kind == .container }
        let wanted = target.trimmingCharacters(in: .whitespaces)
        guard !wanted.isEmpty else { return [] }
        let canonical = canonicalPath((wanted as NSString).expandingTildeInPath)
        let exact = containers.filter { entry in
            entry.instance == wanted || entry.containerId == wanted || entry.projects.contains { $0.id == wanted || $0.path.map(canonicalPath) == canonical }
        }
        if !exact.isEmpty { return exact }
        // Id prefix, project name or slug: the same resolution `ocelot ls`/`call` use.
        let projects = containers.flatMap(\.projects)
        if let project = InstanceDirectory.match(wanted, in: projects) { return containers.filter { $0.projects.contains(project) } }
        guard wanted.count >= 4 else { return [] }
        return containers.filter { $0.containerId?.hasPrefix(wanted) ?? false }
    }

    // MARK: single writer, staleness

    /// Refuses when the package is already hosted by a live window, headless host or container. `runtime` is nil when no
    /// container runtime is reachable (then container entries cannot be verified and are skipped).
    func enforceSingleWriter(path: String, projectId: String?, runtime: ContainerRuntime?) throws {
        for entry in allRecords() {
            guard let project = entry.projects.first(where: { $0.path.map(canonicalPath) == path || (projectId != nil && $0.id == projectId) }) else { continue }
            switch entry.kind {
            case .container:
                let name = entry.containerId ?? ""
                guard !name.isEmpty, runtime?.isRunning(name) == true else { continue }
                throw ContainerError.alreadyHosted(
                    project: "\"\(project.name)\"", where: "container \(entry.instance)",
                    hint: "Stop it with `ocelot stop \(project.id)` first, or connect to it (see `ocelot ls`)."
                )
            case .app, .headless:
                guard InstanceDirectory.isLive(entry), let pid = entry.pid else { continue }
                let place = entry.kind == .app ? "an Ocelot window" : "a headless host (pid \(pid))"
                let hint = entry.kind == .app
                    ? "Use that window, close the project there, or point the agent at /mcp/p/\(project.id) on the app."
                    : "Stop that host (`kill \(pid)`) or connect to it (see `ocelot ls`)."
                throw ContainerError.alreadyHosted(project: "\"\(project.name)\"", where: place, hint: hint)
            }
        }
    }

    /// Removes entries (and their stopped containers) whose container is gone, plus stopped leftovers Docker still lists.
    func reapStale(runtime: ContainerRuntime) {
        for entry in allRecords() where entry.kind == .container && entry.runtime == runtime.backend.kind.rawValue {
            if let id = entry.containerId, runtime.isRunning(id) { continue }
            if let id = entry.containerId { runtime.remove(id) }
            runDirectory.remove(instance: entry.instance)
        }
        for name in runtime.exitedOcelotContainers() { runtime.remove(name) }
    }

    /// Every record on disk, live or not (`InstanceDirectory.liveInstances` prunes dead ones; stop and reap must see them).
    func allRecords() -> [InstanceRecord] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: runDirectory.url.path) else { return [] }
        return names.filter { $0.hasSuffix(".json") && !$0.hasPrefix(".") }.sorted().compactMap { name in
            guard let data = try? Data(contentsOf: runDirectory.url.appendingPathComponent(name)) else { return nil }
            return try? JSONDecoder().decode(InstanceRecord.self, from: data)
        }
    }

    func liveAppInstance() -> InstanceRecord? {
        allRecords()
            .filter { $0.kind == .app && InstanceDirectory.isLive($0) }
            .max { $0.started < $1.started }
    }

    // MARK: package helpers

    func validatePackage(path: String, create: Bool) throws {
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
        if !exists {
            guard create, path.hasSuffix(".\(DocumentExtension.current)") else { throw ContainerError.notAnOcelotPackage(path) }
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
            return
        }
        let hasDocument = FileManager.default.fileExists(atPath: path + "/document.json")
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
        // An existing empty directory is accepted with --create (the host writes document.json on first start).
        guard isDirectory.boolValue, DocumentExtension.matches(path: path), hasDocument || (create && entries.isEmpty) else {
            throw ContainerError.notAnOcelotPackage(path)
        }
    }

    static func readDocumentObject(packagePath: String) -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: packagePath + "/document.json") else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    static func readProjectId(packagePath: String) -> String? {
        (readDocumentObject(packagePath: packagePath)?["projectId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    }

    static func readProjectName(packagePath: String) -> String? {
        // A new document is called "Untitled"; the package's file name is the better label then.
        (readDocumentObject(packagePath: packagePath)?["name"] as? String).flatMap { $0.isEmpty || $0 == "Untitled" ? nil : $0 }
    }

    /// 8 hex chars of FNV-1a over the canonical path: stable instance and container names per package.
    static func shortHash(_ text: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return String(String(hash, radix: 16).prefix(8)).padding(toLength: 8, withPad: "0", startingAt: 0)
    }
}

enum TokenGenerator {
    static func hex(bytes: Int) -> String {
        var generator = SystemRandomNumberGenerator()
        return (0..<bytes).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &generator)) }.joined()
    }
}

enum PortAllocator {
    /// Asks the kernel for a free loopback port. Racy by nature; `ContainerRunner` retries when publishing fails.
    static func freeLoopbackPort() throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ContainerError.startFailed("could not open a socket to find a free port (\(String(cString: strerror(errno))))") }
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = 0
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { throw ContainerError.startFailed("could not reserve a loopback port (\(String(cString: strerror(errno))))") }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard named == 0 else { throw ContainerError.startFailed("could not read the reserved port (\(String(cString: strerror(errno))))") }
        return Int(UInt16(bigEndian: address.sin_port))
    }
}
