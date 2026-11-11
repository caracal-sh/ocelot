import Foundation
import XCTest

/// Unit tests for the `ocelot run` runtime (mac/OcelotCLI/Run). No Docker needed: commands go to a scripted fake.
final class FakeRunner: CommandRunning, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [[String]] = []
    private let handler: @Sendable ([String]) -> CommandResult
    init(_ handler: @escaping @Sendable ([String]) -> CommandResult) { self.handler = handler }
    var calls: [[String]] { lock.lock(); defer { lock.unlock() }; return recorded }
    func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) throws -> CommandResult {
        lock.lock(); recorded.append([URL(fileURLWithPath: executable).lastPathComponent] + arguments); lock.unlock()
        return handler(arguments)
    }
}

private func ok(_ out: String = "") -> CommandResult { CommandResult(status: 0, stdout: out, stderr: "") }
private func fail(_ err: String) -> CommandResult { CommandResult(status: 1, stdout: "", stderr: err) }

final class ContainerRuntimeTests: XCTestCase {
    private var temp: URL!

    override func setUpWithError() throws {
        temp = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-run-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    }

    override func tearDown() {
        listeners.forEach { close($0) }
        try? FileManager.default.removeItem(at: temp)
    }

    private func makePackage(named name: String = "Acme.ocelot", projectId: String? = "11111111-2222-3333-4444-555555555555") throws -> String {
        let dir = temp.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var object: [String: Any] = ["format": "ocelot", "version": 1, "name": "Acme site"]
        if let projectId { object["projectId"] = projectId }
        try JSONSerialization.data(withJSONObject: object).write(to: dir.appendingPathComponent("document.json"))
        return canonicalPath(dir.path)
    }

    private var listeners: [Int32] = []

    /// A live loopback listener, so `InstanceDirectory.isLive` sees an app/headless instance as reachable.
    private func listeningPort() throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(listen(fd, 4), 0)
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
        listeners.append(fd)
        return Int(UInt16(bigEndian: addr.sin_port))
    }

    private func put(_ dir: InstanceDirectory, _ record: InstanceRecord, token: String) throws {
        try dir.writeToken(token, instance: record.instance)
        try dir.publish(record)
    }

    private func records(_ dir: InstanceDirectory) -> [InstanceRecord] {
        var runner = ContainerRunner()
        runner.runDirectory = dir
        return runner.allRecords()
    }

    private func spec(path: String) -> ContainerRunSpec {
        ContainerRunSpec(instance: "container-abc", containerName: "ocelot-abc", image: "ocelot-headless:dev", packagePath: path, hostPort: 54321, envFile: "/run/.env")
    }

    // MARK: arguments

    func testDockerRunArgumentsAreLockedDown() throws {
        let args = try ContainerRuntime.runArguments(kind: .docker, spec: spec(path: "/Users/designer/Acme.ocelot"))
        XCTAssertEqual(args.first, "run")
        XCTAssertTrue(args.contains("--read-only"))
        XCTAssertEqual(args[args.firstIndex(of: "--tmpfs")! + 1], "/tmp")
        XCTAssertEqual(args[args.firstIndex(of: "--cap-drop")! + 1], "ALL")
        XCTAssertTrue(args.contains("no-new-privileges"))
        XCTAssertEqual(args[args.firstIndex(of: "-p")! + 1], "127.0.0.1:54321:7420", "published on loopback only")
        XCTAssertEqual(args.filter { $0 == "--mount" }.count, 1, "exactly one mount")
        XCTAssertEqual(args[args.firstIndex(of: "--mount")! + 1], "type=bind,source=/Users/designer/Acme.ocelot,target=/project")
        XCTAssertEqual(args[args.firstIndex(of: "--env-file")! + 1], "/run/.env")
        XCTAssertEqual(args.last, "ocelot-headless:dev")
        XCTAssertFalse(args.contains("--privileged"))
        XCTAssertFalse(args.contains("--ssh"))
        XCTAssertFalse(args.joined().contains("OCELOT_PROJECT_TOKEN"), "the token goes through --env-file, never the process list")
    }

    func testAppleContainerUsesItsDocumentedFlags() throws {
        let args = try ContainerRuntime.runArguments(kind: .container, spec: spec(path: "/Users/designer/Acme.ocelot"))
        XCTAssertEqual(args[args.firstIndex(of: "--cap-drop")! + 1], "ALL")
        XCTAssertFalse(args.contains("--security-opt"), "Docker-only flag")
        XCTAssertEqual(args[args.firstIndex(of: "--memory")! + 1], "2G")
        XCTAssertTrue(args.contains("--read-only"))
        XCTAssertTrue(args.contains("--init"))
    }

    func testMountQuotesCommasForDockerAndRejectsThemForApple() throws {
        XCTAssertEqual(try ContainerRuntime.mountArgument(kind: .docker, source: "/a,b/X.ocelot"), "type=bind,\"source=/a,b/X.ocelot\",target=/project")
        XCTAssertThrowsError(try ContainerRuntime.mountArgument(kind: .container, source: "/a,b/X.ocelot")) {
            XCTAssertEqual($0 as? ContainerError, .unsupportedPath("/a,b/X.ocelot"))
        }
    }

    // MARK: detection

    private func detector(osMajor: Int, binaries: Set<String>, handler: @escaping @Sendable ([String]) -> CommandResult, env: [String: String] = [:]) -> BackendDetector {
        BackendDetector(runner: FakeRunner(handler), environment: env.merging(["PATH": "/usr/local/bin", "HOME": "/Users/designer"]) { a, _ in a },
                        osMajorVersion: osMajor, fileIsExecutable: { binaries.contains($0) })
    }

    func testPrefersAppleContainerWhenStartedOnMacOS26() throws {
        let d = detector(osMajor: 26, binaries: ["/usr/local/bin/container", "/usr/local/bin/docker"], handler: { _ in ok("running") })
        XCTAssertEqual(try d.detect().kind, .container)
    }

    func testIgnoresAppleContainerBeforeMacOS26() throws {
        let d = detector(osMajor: 15, binaries: ["/usr/local/bin/container", "/usr/local/bin/docker"], handler: { _ in ok("29.8.2") })
        XCTAssertEqual(try d.detect().kind, .docker)
    }

    func testFallsBackToDockerWhenAppleServiceIsStopped() throws {
        let d = detector(osMajor: 26, binaries: ["/usr/local/bin/container", "/usr/local/bin/docker"], handler: { args in args.first == "system" ? fail("not running") : ok("29.8.2") })
        XCTAssertEqual(try d.detect().kind, .docker)
    }

    func testDockerDaemonDownSaysSo() {
        let d = detector(osMajor: 15, binaries: ["/usr/local/bin/docker"], handler: { _ in fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock") })
        XCTAssertThrowsError(try d.detect()) {
            guard case .dockerDaemonDown(let detail)? = $0 as? ContainerError else { return XCTFail("\($0)") }
            XCTAssertTrue(detail.contains("Cannot connect"))
            XCTAssertTrue(($0 as? LocalizedError)?.errorDescription?.contains("Start it") == true, "the message names the remedy")
        }
    }

    func testAppleInstalledButStoppedWithoutDockerAsksToStartIt() {
        let d = detector(osMajor: 26, binaries: ["/usr/local/bin/container"], handler: { _ in fail("not running") })
        XCTAssertThrowsError(try d.detect()) { XCTAssertEqual($0 as? ContainerError, .appleContainerNotStarted) }
    }

    func testNoRuntimeAndOverride() {
        XCTAssertThrowsError(try detector(osMajor: 26, binaries: [], handler: { _ in ok() }).detect()) { XCTAssertEqual($0 as? ContainerError, .noRuntime) }
        let d = detector(osMajor: 26, binaries: ["/usr/local/bin/container"], handler: { _ in ok() }, env: ["OCELOT_CONTAINER_RUNTIME": "docker"])
        XCTAssertThrowsError(try d.detect()) { XCTAssertEqual($0 as? ContainerError, .runtimeUnavailable(.docker)) }
    }

    // MARK: run / stop

    /// Scripted Docker: image present, container appears after `run`, stops after `stop`.
    private final class FakeDocker: @unchecked Sendable {
        private let lock = NSLock()
        private var running = false
        private var present = false
        var imageOK = true
        func handle(_ args: [String]) -> CommandResult {
            lock.lock(); defer { lock.unlock() }
            switch args.first ?? "" {
            case "info": return ok("29.8.2")
            case "image": return imageOK ? ok("sha256:abc") : fail("No such image")
            case "run": running = true; present = true; return ok("deadbeefcafe\n")
            case "inspect":
                guard present else { return fail("No such object") }
                return args.contains("{{.State.Running}}") ? ok(running ? "true\n" : "false\n") : ok("id\n")
            case "stop": running = false; return ok()
            case "rm": present = false; running = false; return ok()
            case "ps": return ok("")
            case "logs": return ok("[headless-host] boom\n")
            default: return fail("unexpected \(args)")
            }
        }
    }

    private func makeRunner(docker: FakeDocker, runDir: InstanceDirectory, health: HealthzReply? = HealthzReply(projectId: "11111111-2222-3333-4444-555555555555")) -> (ContainerRunner, FakeRunner) {
        let fake = FakeRunner { docker.handle($0) }
        var runner = ContainerRunner()
        runner.detector = BackendDetector(runner: fake, environment: ["PATH": "/usr/local/bin", "HOME": "/Users/designer"], osMajorVersion: 15, fileIsExecutable: { $0 == "/usr/local/bin/docker" })
        runner.runner = fake
        runner.runDirectory = runDir
        runner.probe = StubProbe(reply: health)
        runner.allocatePort = { 54321 }
        runner.makeToken = { "tok-0123" }
        runner.sleep = { _ in }
        return (runner, fake)
    }

    private struct StubProbe: HealthProbing {
        var reply: HealthzReply?
        func probe(port: Int) -> HealthzReply? { reply }
    }

    func testRunStartsContainerAndWritesDiscoveryEntry() throws {
        let path = try makePackage()
        let runDir = InstanceDirectory(url: temp.appendingPathComponent("run"))
        let (runner, fake) = makeRunner(docker: FakeDocker(), runDir: runDir)
        let result = try runner.run(RunOptions(path: path))

        XCTAssertEqual(result.projectId, "11111111-2222-3333-4444-555555555555")
        XCTAssertEqual(result.directURL, "http://127.0.0.1:54321/mcp")
        XCTAssertEqual(result.projectName, "Acme site")
        let entry = try XCTUnwrap(records(runDir).first)
        XCTAssertEqual(entry.kind, .container)
        XCTAssertEqual(entry.runtime, "docker")
        XCTAssertEqual(entry.containerId, "deadbeefcafe")
        XCTAssertNil(entry.pid)
        XCTAssertEqual(entry.http, "http://127.0.0.1:54321")
        XCTAssertEqual(entry.projects, [RunProject(id: "11111111-2222-3333-4444-555555555555", name: "Acme site", path: path, windowId: nil)])
        XCTAssertEqual(runDir.readToken(instance: entry.instance), "tok-0123")
        XCTAssertFalse(fake.calls.joined().contains("tok-0123"), "token never appears in a command line")

        // Permissions: directory 0700, files 0600, env file removed.
        let attrs = { (u: URL) in (try? FileManager.default.attributesOfItem(atPath: u.path)[.posixPermissions] as? Int) ?? -1 }
        XCTAssertEqual(attrs(runDir.url), 0o700)
        XCTAssertEqual(attrs(runDir.recordURL(entry.instance)), 0o600)
        XCTAssertEqual(attrs(runDir.tokenURL(entry.instance)), 0o600)
        XCTAssertFalse(FileManager.default.fileExists(atPath: runDir.url.appendingPathComponent(".\(entry.instance).env").path))
    }

    func testRunRefusesWhenAWindowHasTheProjectOpen() throws {
        let path = try makePackage()
        let runDir = InstanceDirectory(url: temp.appendingPathComponent("run"))
        try put(runDir, InstanceRecord(instance: "app-1", kind: .app, pid: Int(getpid()), started: "2026-11-09T00:00:00Z", http: "http://127.0.0.1:\(try listeningPort())",
                                        projects: [RunProject(id: "11111111-2222-3333-4444-555555555555", name: "Acme site", path: path, windowId: "w1")]), token: "master")
        let (runner, fake) = makeRunner(docker: FakeDocker(), runDir: runDir)
        XCTAssertThrowsError(try runner.run(RunOptions(path: path))) {
            guard case .alreadyHosted(_, let place, _)? = $0 as? ContainerError else { return XCTFail("\($0)") }
            XCTAssertEqual(place, "an Ocelot window")
        }
        XCTAssertFalse(fake.calls.contains { $0.contains("run") }, "nothing was started")
    }

    func testRunIgnoresEntriesOfDeadProcesses() throws {
        let path = try makePackage()
        let runDir = InstanceDirectory(url: temp.appendingPathComponent("run"))
        try put(runDir, InstanceRecord(instance: "app-dead", kind: .app, pid: 999_999, started: "2026-11-09T00:00:00Z", http: "http://127.0.0.1:\(try listeningPort())",
                                        projects: [RunProject(id: "11111111-2222-3333-4444-555555555555", name: "Acme site", path: path, windowId: nil)]), token: "t")
        let (runner, _) = makeRunner(docker: FakeDocker(), runDir: runDir)
        XCTAssertNoThrow(try runner.run(RunOptions(path: path)))
    }

    func testRunTwiceIsRefusedWhileTheFirstContainerRuns() throws {
        let path = try makePackage()
        let runDir = InstanceDirectory(url: temp.appendingPathComponent("run"))
        let (runner, _) = makeRunner(docker: FakeDocker(), runDir: runDir)
        _ = try runner.run(RunOptions(path: path))
        XCTAssertThrowsError(try runner.run(RunOptions(path: path))) {
            guard case .alreadyHosted(_, let place, let hint)? = $0 as? ContainerError else { return XCTFail("\($0)") }
            XCTAssertTrue(place.hasPrefix("container "))
            XCTAssertTrue(hint.contains("ocelot stop"))
        }
    }

    func testRunReportsFrontDoorURLWhenTheAppIsRunning() throws {
        let path = try makePackage()
        let runDir = InstanceDirectory(url: temp.appendingPathComponent("run"))
        let appPort = try listeningPort()
        try put(runDir, InstanceRecord(instance: "app-1", kind: .app, pid: Int(getpid()), started: "2026-11-09T00:00:00Z", http: "http://127.0.0.1:\(appPort)", projects: []), token: "master-token")
        var (runner, _) = makeRunner(docker: FakeDocker(), runDir: runDir)
        runner.mintFrontDoorToken = { app, projectId, _ in app.instance == "app-1" && projectId == "11111111-2222-3333-4444-555555555555" ? "project-token" : nil }
        let result = try runner.run(RunOptions(path: path))
        XCTAssertEqual(result.frontDoorURL, "http://127.0.0.1:\(appPort)/mcp/p/11111111-2222-3333-4444-555555555555")
        XCTAssertEqual(result.frontDoorToken, "project-token", "a project-scoped token, not the app's master token")
        for text in [OcelotRunCommands.renderHuman(result, direct: false, command: "ocelot"), OcelotRunCommands.renderJSON(result)] {
            XCTAssertFalse(text.contains("master-token"), "the master token must not be printed")
        }
        let text = OcelotRunCommands.renderHuman(result, direct: false, command: "ocelot")
        XCTAssertTrue(text.contains("claude mcp add ocelot-acme-site -- ocelot mcp --project 11111111-2222-3333-4444-555555555555"), "stdio shim line")
        XCTAssertTrue(text.contains("claude mcp add --transport http ocelot-acme-site http://127.0.0.1:\(appPort)/mcp/p/"), "front door HTTP line")
        XCTAssertTrue(OcelotRunCommands.renderHuman(result, direct: true, command: "ocelot").contains("claude mcp add --transport http ocelot-acme-site http://127.0.0.1:54321/mcp --header"))
    }

    func testRunOffersNoFrontDoorWhenTheAppWillNotMintAProjectToken() throws {
        let path = try makePackage()
        let runDir = InstanceDirectory(url: temp.appendingPathComponent("run"))
        try put(runDir, InstanceRecord(instance: "app-1", kind: .app, pid: Int(getpid()), started: "2026-11-09T00:00:00Z", http: "http://127.0.0.1:\(try listeningPort())", projects: []), token: "master-token")
        var (runner, _) = makeRunner(docker: FakeDocker(), runDir: runDir)
        runner.mintFrontDoorToken = { _, _, _ in nil }
        let result = try runner.run(RunOptions(path: path))
        XCTAssertNil(result.frontDoorURL)
        XCTAssertNil(result.frontDoorToken)
        XCTAssertFalse(OcelotRunCommands.renderJSON(result).contains("master-token"))
    }

    func testMissingImageAndBadPathExplainTheRemedy() throws {
        let runDir = InstanceDirectory(url: temp.appendingPathComponent("run"))
        let docker = FakeDocker()
        docker.imageOK = false
        let (runner, _) = makeRunner(docker: docker, runDir: runDir)
        let path = try makePackage()
        XCTAssertThrowsError(try runner.run(RunOptions(path: path))) {
            XCTAssertTrue(($0 as? LocalizedError)?.errorDescription?.contains("make container") == true)
        }
        XCTAssertThrowsError(try runner.run(RunOptions(path: temp.appendingPathComponent("nope.ocelot").path))) {
            guard case .notAnOcelotPackage? = $0 as? ContainerError else { return XCTFail("\($0)") }
        }
    }

    func testUnhealthyContainerIsRemovedWithItsLogs() throws {
        let path = try makePackage()
        let runDir = InstanceDirectory(url: temp.appendingPathComponent("run"))
        let (runner, fake) = makeRunner(docker: FakeDocker(), runDir: runDir, health: nil)
        var options = RunOptions(path: path)
        options.healthTimeout = 0.5
        XCTAssertThrowsError(try runner.run(options)) {
            guard case .notHealthy(let logs)? = $0 as? ContainerError else { return XCTFail("\($0)") }
            XCTAssertTrue(logs.contains("boom"))
        }
        XCTAssertTrue(records(runDir).isEmpty, "no discovery entry for a container that never became healthy")
        XCTAssertTrue(fake.calls.contains { $0.first == "docker" && $0.contains("rm") })
    }

    func testStopRemovesContainerAndEntry() throws {
        let path = try makePackage()
        let runDir = InstanceDirectory(url: temp.appendingPathComponent("run"))
        let docker = FakeDocker()
        let (runner, fake) = makeRunner(docker: docker, runDir: runDir)
        let result = try runner.run(RunOptions(path: path))
        let stopped = try runner.stop(target: String(result.projectId.prefix(8)))
        XCTAssertEqual(stopped.map(\.instance), [result.instance])
        XCTAssertTrue(records(runDir).isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: runDir.tokenURL(result.instance).path))
        XCTAssertTrue(fake.calls.contains { $0.contains("stop") })
        XCTAssertTrue(fake.calls.contains { $0.contains("rm") })
        XCTAssertThrowsError(try runner.stop(target: "nothing")) { XCTAssertEqual($0 as? ContainerError, .noSuchContainer("nothing")) }
    }

    func testStaleContainerEntriesAreReapedOnNextRun() throws {
        let path = try makePackage()
        let runDir = InstanceDirectory(url: temp.appendingPathComponent("run"))
        try put(runDir, InstanceRecord(instance: "container-old", kind: .container, containerId: "gone123", runtime: "docker", started: "2026-11-09T00:00:00Z",
                                        http: "http://127.0.0.1:50000", projects: [RunProject(id: "old", name: "Old", path: "/x/Old.ocelot", windowId: nil)]), token: "t")
        let (runner, _) = makeRunner(docker: FakeDocker(), runDir: runDir)
        _ = try runner.run(RunOptions(path: path))
        XCTAssertNil(records(runDir).first { $0.instance == "container-old" })
    }

    // MARK: pieces

    func testParseRunOptions() throws {
        let o = try OcelotRunCommands.parseRun(["Acme.ocelot", "--cpus", "1.5", "--memory", "512m", "--idle-stop-min", "5", "--runtime", "docker", "--direct", "--json", "--create"], environment: ["OCELOT_CONTAINER_IMAGE": "x:1"])
        XCTAssertEqual(o.path, "Acme.ocelot")
        XCTAssertEqual([o.cpus, o.memory, o.image], ["1.5", "512m", "x:1"])
        XCTAssertEqual(o.idleStopMinutes, 5)
        XCTAssertEqual(o.runtime, .docker)
        XCTAssertTrue(o.direct && o.json && o.create)
        XCTAssertThrowsError(try OcelotRunCommands.parseRun([], environment: [:]))
        XCTAssertThrowsError(try OcelotRunCommands.parseRun(["a", "--memory", "lots"], environment: [:]))
        XCTAssertThrowsError(try OcelotRunCommands.parseRun(["a", "--wat"], environment: [:]))
    }

    func testClientConfigLines() {
        let c = HTTPClientConfig(name: MCPClientConfig.serverName(projectName: "Acme Site (v2)!"), url: "http://127.0.0.1:7420/mcp/p/abc", token: "T", tokenFile: "/run/x.token")
        XCTAssertEqual(c.name, "ocelot-acme-site-v2")
        XCTAssertEqual(c.claudeCode, "claude mcp add --transport http ocelot-acme-site-v2 http://127.0.0.1:7420/mcp/p/abc --header \"Authorization: Bearer T\"")
        XCTAssertTrue(c.codex.contains("[mcp_servers.ocelot-acme-site-v2]"))
        let json = try? JSONSerialization.jsonObject(with: Data(c.omp.utf8)) as? [String: Any]
        let server = ((json?["mcpServers"] as? [String: Any])?["ocelot-acme-site-v2"]) as? [String: Any]
        XCTAssertEqual(server?["type"] as? String, "http")
        XCTAssertEqual((server?["headers"] as? [String: String])?["Authorization"], "!printf 'Bearer %s' \"$(cat '/run/x.token')\"")
    }

    func testStatusSearchAndPortAllocation() throws {
        XCTAssertTrue(ContainerRuntime.containsStatus([["configuration": ["id": "x"], "status": "running"]], "running"))
        XCTAssertFalse(ContainerRuntime.containsStatus([["status": "stopped"]], "running"))
        let port = try PortAllocator.freeLoopbackPort()
        XCTAssertTrue((1024...65535).contains(port))
        XCTAssertEqual(TokenGenerator.hex(bytes: 32).count, 64)
        XCTAssertEqual(ContainerRunner.shortHash("/a/b.ocelot").count, 8)
    }

    func testServeParsingAndHostDiscovery() throws {
        let o = try OcelotServeCommand.parse(["X.ocelot", "--port", "7430", "--idle-stop-min", "3", "--json", "--create"])
        XCTAssertEqual(o, OcelotServeCommand.Options(path: "X.ocelot", create: true, port: 7430, idleStopMinutes: 3, json: true))
        XCTAssertThrowsError(try OcelotServeCommand.parse(["X.ocelot", "--port", "99999"]))

        let repo = temp.appendingPathComponent("repo/editor/e2e", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        let script = repo.appendingPathComponent("headless-host.mjs")
        try Data().write(to: script)
        let nested = temp.appendingPathComponent("repo/mac/build/Debug").path
        XCTAssertEqual(OcelotServeCommand.locateHostScript(environment: [:], startingPoints: [nested]).map(canonicalPath), canonicalPath(script.path))
        XCTAssertEqual(OcelotServeCommand.locateHostScript(environment: ["OCELOT_REPO": temp.appendingPathComponent("repo").path], startingPoints: []).map(canonicalPath), canonicalPath(script.path))
        XCTAssertNil(OcelotServeCommand.locateHostScript(environment: [:], startingPoints: ["/"]))
    }
}
