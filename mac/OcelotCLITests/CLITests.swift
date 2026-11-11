import XCTest

/// A tiny loopback HTTP/1.1 server (one request per connection) standing in for the app's MCP endpoint.
final class FakeHost: @unchecked Sendable {
    struct Request { var method: String; var path: String; var headers: [String: String]; var body: Data }
    struct Response { var status = 200; var headers: [String: String] = [:]; var body = "" }

    private let lock = NSLock()
    private var listenFD: Int32 = -1
    private(set) var port = 0
    private var _requests: [Request] = []
    var handler: (Request) -> Response = { _ in Response() }
    var requests: [Request] { lock.lock(); defer { lock.unlock() }; return _requests }

    init() {
        listenFD = socket(AF_INET, SOCK_STREAM, 0)
        var yes: Int32 = 1
        setsockopt(listenFD, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listenFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        listen(listenFD, 16)
        var bound = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &bound) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listenFD, $0, &len) } }
        port = Int(UInt16(bigEndian: bound.sin_port))
        let fd = listenFD
        Thread.detachNewThread { [weak self] in
            while true {
                let client = accept(fd, nil, nil)
                if client < 0 { return }
                self?.serve(client)
            }
        }
    }

    func stop() { close(listenFD); listenFD = -1 }

    private func serve(_ fd: Int32) {
        defer { close(fd) }
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 65536)
        var headerEnd: Range<Data.Index>?
        while headerEnd == nil {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { return }
            data.append(buf, count: n)
            headerEnd = data.range(of: Data("\r\n\r\n".utf8))
        }
        let head = String(decoding: data[..<headerEnd!.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let first = head[0].split(separator: " ")
        var headers: [String: String] = [:]
        for line in head.dropFirst() { if let i = line.firstIndex(of: ":") { headers[line[..<i].lowercased()] = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces) } }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        var body = Data(data[headerEnd!.upperBound...])
        while body.count < length {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            body.append(buf, count: n)
        }
        let request = Request(method: String(first[0]), path: String(first[1]), headers: headers, body: body)
        lock.lock(); _requests.append(request); lock.unlock()
        let response = handler(request)
        var out = "HTTP/1.1 \(response.status) X\r\nContent-Length: \(response.body.utf8.count)\r\nConnection: close\r\nContent-Type: application/json\r\n"
        for (k, v) in response.headers { out += "\(k): \(v)\r\n" }
        out += "\r\n" + response.body
        _ = out.withCString { write(fd, $0, strlen($0)) }
    }
}

final class ArgsTests: XCTestCase {
    func testParsesOptionsFlagsAndPositionals() throws {
        let a = try Args(["new", "--project", "p1", "--read-only", "--ttl=1h", "-o", "file.png"], valueOptions: ["--project", "--ttl", "--out"], flags: ["--read-only"], aliases: ["-o": "--out"])
        XCTAssertEqual(a.positionals, ["new"])
        XCTAssertEqual(a.value("--project"), "p1")
        XCTAssertEqual(a.value("--ttl"), "1h")
        XCTAssertEqual(a.value("--out"), "file.png")
        XCTAssertTrue(a.flag("--read-only"))
    }

    func testUnknownOptionsAndMissingValuesExplainThemselves() {
        XCTAssertThrowsError(try Args(["--nope"], valueOptions: ["--project"])) { XCTAssertTrue("\($0)".contains("--project")) }
        XCTAssertThrowsError(try Args(["--project"], valueOptions: ["--project"])) { XCTAssertTrue("\($0)".contains("needs a value")) }
    }

    func testDurations() throws {
        XCTAssertEqual(try parseDuration("90s"), 90)
        XCTAssertEqual(try parseDuration("15m"), 900)
        XCTAssertEqual(try parseDuration("1h"), 3600)
        XCTAssertEqual(try parseDuration("2d"), 172_800)
        XCTAssertEqual(try parseDuration("30"), 30)
        XCTAssertThrowsError(try parseDuration("soon"))
        XCTAssertThrowsError(try parseDuration("0h"))
    }

    func testTokenTTLIsBoundedInsteadOfTrappingOnHugeValues() throws {
        XCTAssertEqual(try TokenCommand.tokenTTL("1h"), 3600)
        XCTAssertEqual(try TokenCommand.tokenTTL("365d"), 31_536_000)
        for bad in ["1e30", "1e30d", "366d", "0.5s", "99999999999999999999d"] {
            XCTAssertThrowsError(try TokenCommand.tokenTTL(bad), bad) { error in
                XCTAssertEqual((error as? CLIError)?.code, 2)
            }
        }
    }
}

final class ResolverTests: XCTestCase {
    private var dir: URL!
    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-cli-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("run"), withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func resolver() -> Resolver { Resolver(directory: InstanceDirectory(url: dir.appendingPathComponent("run")), launcher: AppLauncher(environment: [:], executable: nil), launchTimeout: 1) }

    private func publish(_ instance: String, kind: InstanceRecord.Kind, port: Int, projects: [RunProject]) throws {
        let d = InstanceDirectory(url: dir.appendingPathComponent("run"))
        try d.publish(InstanceRecord(instance: instance, kind: kind, pid: Int(getpid()), started: ISO8601DateFormatter().string(from: Date()), http: "http://127.0.0.1:\(port)", projects: projects))
        try d.writeToken("token-\(instance)", instance: instance)
    }

    func testFindsProjectsByIdNameSlugAndWindow() throws {
        let host = FakeHost(); defer { host.stop() }
        try publish("app-test", kind: .app, port: host.port, projects: [RunProject(id: "3f2a-1111", name: "Pricing Page", path: "/p/Pricing.ocelot", windowId: "W1"), RunProject(id: "77bd-2222", name: "Docs", windowId: "W2")])
        let r = resolver()
        for ref in ["3f2a-1111", "3f2a", "pricing-page", "Pricing Page"] {
            let e = try XCTUnwrap(try r.find(Target(project: ref)), ref)
            XCTAssertEqual(e.route, .project("3f2a-1111"))
            XCTAssertEqual(e.token, "token-app-test")
            XCTAssertEqual(e.url.absoluteString, "http://127.0.0.1:\(host.port)/mcp/p/3f2a-1111")
        }
        XCTAssertEqual(try r.find(Target(window: "W2"))?.route, .window("W2"))
        XCTAssertEqual(try r.find(Target())?.route, .keyWindow)
        XCTAssertNil(try r.find(Target(project: "nope")))
        XCTAssertNil(try r.find(Target(project: "docs", instance: "headless")), "--instance filters hosts")
    }

    func testAppEndpointNeedsNoProjectAndFollowsTheHostThatServesAPinnedOne() throws {
        let app = FakeHost(), headless = FakeHost(); defer { app.stop(); headless.stop() }
        let r = resolver()
        XCTAssertNil(try r.findApp(Target()), "nothing runs")
        try publish("app-test", kind: .app, port: app.port, projects: [])
        let found = try XCTUnwrap(try r.findApp(Target()))
        XCTAssertEqual(found.route, .app, "an app with no project open still answers app tools")
        XCTAssertEqual(found.url.absoluteString, "http://127.0.0.1:\(app.port)/mcp/app")
        try publish("headless-1", kind: .headless, port: headless.port, projects: [RunProject(id: "h-1111", name: "CI Doc")])
        XCTAssertEqual(try r.findApp(Target(project: "ci-doc"))?.base.port, headless.port, "a project only a headless host serves: its own app tools")
        XCTAssertEqual(try r.findApp(Target())?.base.port, app.port, "otherwise the app")
        XCTAssertEqual(try r.findApp(Target(instance: "headless"))?.base.port, headless.port)
    }

    /// A still-running Atelier-era app publishes in the old run directory; the CLI reads it as a fallback, with that
    /// directory's own token, and prefers a host of the new directory with the same name.
    func testFindsAnOldAppThroughTheLegacyRunDirectory() throws {
        let old = FakeHost(), new = FakeHost(); defer { old.stop(); new.stop() }
        let legacy = InstanceDirectory(url: dir.appendingPathComponent("legacy-run"))
        try legacy.publish(InstanceRecord(instance: "app", kind: .app, pid: Int(getpid()), started: ISO8601DateFormatter().string(from: Date()), http: "http://127.0.0.1:\(old.port)", projects: [RunProject(id: "old-1", name: "Old Doc")]))
        try legacy.writeToken("legacy-token", instance: "app")
        let r = Resolver(directory: InstanceDirectory(url: dir.appendingPathComponent("run")), legacyDirectory: legacy, launcher: AppLauncher(environment: [:], executable: nil), launchTimeout: 1)

        let found = try XCTUnwrap(try r.find(Target(project: "old-doc")))
        XCTAssertEqual(found.token, "legacy-token")
        XCTAssertEqual(found.base.port, old.port)
        XCTAssertEqual(r.instances(matching: nil).map(\.instance), ["app"])

        try publish("app", kind: .app, port: new.port, projects: [RunProject(id: "new-1", name: "New Doc")])
        let preferred = try XCTUnwrap(try r.find(Target()))
        XCTAssertEqual(preferred.token, "token-app", "the new directory wins for the same instance name")
        XCTAssertEqual(preferred.base.port, new.port)
        XCTAssertEqual(r.instances(matching: nil).count, 1)
        XCTAssertNil(try resolver().find(Target(project: "old-doc")), "without a legacy directory nothing is read from it")
    }

    func testMissingProjectErrorListsWhatIsOpen() throws {
        let host = FakeHost(); defer { host.stop() }
        try publish("app-test", kind: .app, port: host.port, projects: [RunProject(id: "p1", name: "Docs")])
        XCTAssertThrowsError(try resolver().ensure(Target(project: "ghost"), launch: true)) { error in
            let message = "\(error)"
            XCTAssertTrue(message.contains("Docs (p1)"), message)
            XCTAssertTrue(message.contains("ocelot open"), message)
        }
    }

    func testRegenerateRewritesTheTokenFileOfAHostWithoutDiscovery() throws {
        let host = FakeHost(); defer { host.stop() }
        host.handler = { _ in .init(headers: ["Content-Type": "application/json"], body: #"{"token":"fresh"}"#) }
        try publish("headless-1", kind: .headless, port: host.port, projects: [RunProject(id: "p1", name: "Docs")])
        let runURL = dir.appendingPathComponent("run")
        setenv("OCELOT_RUN_DIR", runURL.path, 1)
        defer { unsetenv("OCELOT_RUN_DIR") }
        XCTAssertEqual(try TokenCommand.run(["--regenerate", "--instance", "headless-1"]), 0)
        XCTAssertEqual(InstanceDirectory(url: runURL).readToken(instance: "headless-1"), "fresh", "a stale file would make every CLI call answer 401")
    }

    func testLauncherPrefersTheEnclosingAppThenTheBundleId() {
        let inApp = AppLauncher(environment: [:], executable: URL(fileURLWithPath: "/Applications/Ocelot.app/Contents/Helpers/ocelot"))
        XCTAssertEqual(inApp.arguments(path: "/x/A.ocelot", foreground: false), ["-g", "-a", "/Applications/Ocelot.app", "/x/A.ocelot"])
        XCTAssertEqual(AppLauncher(environment: [:], executable: URL(fileURLWithPath: "/usr/local/bin/ocelot")).arguments(path: nil, foreground: true), ["-b", "sh.caracal.ocelot"])
        XCTAssertEqual(AppLauncher(environment: ["OCELOT_APP": "/Dev/Ocelot.app"], executable: nil).arguments(path: nil, foreground: false), ["-g", "-a", "/Dev/Ocelot.app"])
    }
}

final class StdioProxyTests: XCTestCase {
    private func endpoint(_ host: FakeHost) -> Endpoint {
        Endpoint(instance: InstanceRecord(instance: "app-test", kind: .app, started: "x", http: "http://127.0.0.1:\(host.port)", projects: []), token: "tok", route: .project("p1"), project: nil)
    }

    private func collect(_ proxy: StdioProxy.Type = StdioProxy.self) {}

    private func rpc(_ method: String, id: Int = 1, params: [String: Any] = [:]) -> String {
        JSON.string(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
    }

    func testAnswersInitializeAndToolsListWithoutAnyHost() throws {
        var out: [[String: Any]] = []
        let proxy = StdioProxy(target: Target(), resolve: { _ in XCTFail("must not touch the app"); throw CLIError(message: "no") }, write: { out.append(JSON.object($0)!) })
        proxy.handle(line: rpc("initialize", params: ["protocolVersion": "2025-06-18", "clientInfo": ["name": "claude-code"]]))
        proxy.handle(line: JSON.string(["jsonrpc": "2.0", "method": "notifications/initialized"]))
        proxy.handle(line: rpc("tools/list", id: 2))
        proxy.handle(line: rpc("ping", id: 3))
        proxy.handle(line: rpc("resources/list", id: 4))
        XCTAssertEqual(out.count, 4, "notifications get no reply")
        let initialize = try XCTUnwrap(out[0]["result"] as? [String: Any])
        XCTAssertEqual(initialize["protocolVersion"] as? String, "2025-06-18")
        XCTAssertEqual((initialize["serverInfo"] as? [String: Any])?["name"] as? String, "ocelot")
        XCTAssertTrue((initialize["instructions"] as? String ?? "").contains("get_screenshot"))
        let tools = try XCTUnwrap((out[1]["result"] as? [String: Any])?["tools"] as? [[String: Any]])
        XCTAssertTrue(tools.contains { $0["name"] as? String == "get_document_info" })
        XCTAssertEqual(tools.count, ToolManifestData.tools.count + AppToolData.tools.count, "document tools and app tools in one flat list")
        XCTAssertTrue(tools.contains { $0["name"] as? String == "open_project" })
        XCTAssertTrue(tools.contains { $0["name"] as? String == "new_project" })
        XCTAssertNotNil(out[2]["result"])
        XCTAssertEqual(((out[3]["error"]) as? [String: Any])?["code"] as? Int, -32601)
    }

    func testToolCallsForwardWithTheClientIdentityAndReconnectAfterARestart() throws {
        let host = FakeHost(); defer { host.stop() }
        var generation = 0
        var validSession = ""
        host.handler = { request in
            let body = JSON.object(request.body)
            switch body?["method"] as? String {
            case "initialize":
                generation += 1
                validSession = "s\(generation)"
                return .init(headers: ["Mcp-Session-Id": validSession], body: #"{"jsonrpc":"2.0","id":"ocelot-init","result":{}}"#)
            case "notifications/initialized": return .init(status: 202)
            default:
                guard request.headers["mcp-session-id"] == validSession else { return .init(status: 404, body: #"{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Unknown or ended MCP session."}}"#) }
                return .init(body: #"{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"ok \#(validSession)"}]}}"#)
            }
        }
        var out: [[String: Any]] = []
        var resolved = 0
        let proxy = StdioProxy(target: Target(), resolve: { _ in resolved += 1; return self.endpoint(host) }, write: { out.append(JSON.object($0)!) })
        proxy.handle(line: rpc("initialize", params: ["protocolVersion": "2025-06-18", "clientInfo": ["name": "cursor", "version": "1"]]))
        proxy.handle(line: rpc("tools/call", id: 7, params: ["name": "get_document_info", "arguments": [:]]))
        func text(_ o: [String: Any]) -> String? { (((o["result"] as? [String: Any])?["content"] as? [[String: Any]])?.first?["text"]) as? String }
        XCTAssertEqual(text(out[1]), "ok s1")
        let init1 = host.requests.first { JSON.object($0.body)?["method"] as? String == "initialize" }
        XCTAssertEqual(((JSON.object(init1!.body)?["params"] as? [String: Any])?["clientInfo"] as? [String: Any])?["name"] as? String, "cursor", "the upstream session is the real client, so lock badges name it")
        XCTAssertEqual(init1?.headers["authorization"], "Bearer tok")
        XCTAssertEqual(init1?.path, "/mcp/p/p1")

        // The app restarted: the old session is gone. The next call re-initializes transparently.
        generation = 10
        validSession = "restarted"
        proxy.handle(line: rpc("tools/call", id: 7, params: ["name": "get_document_info", "arguments": [:]]))
        XCTAssertEqual(text(out[2]), "ok s11")
        XCTAssertEqual(resolved, 2)
    }

    private func appEndpoint(_ host: FakeHost) -> Endpoint {
        Endpoint(instance: InstanceRecord(instance: "app-test", kind: .app, started: "x", http: "http://127.0.0.1:\(host.port)", projects: []), token: "tok", route: .app, project: nil)
    }

    /// The app tools go to /mcp/app (no project needed); after open_project the document tools follow that project.
    func testAppToolsUseTheAppEndpointAndDocumentToolsFollowTheOpenedProject() throws {
        let host = FakeHost(); defer { host.stop() }
        host.handler = { request in
            let body = JSON.object(request.body)
            switch body?["method"] as? String {
            case "initialize": return .init(headers: ["Mcp-Session-Id": "s"], body: #"{"jsonrpc":"2.0","id":"ocelot-init","result":{}}"#)
            case "notifications/initialized": return .init(status: 202)
            default:
                let name = (body?["params"] as? [String: Any])?["name"] as? String ?? ""
                let text = name == "open_project" ? #"{\"project_id\":\"P-new\",\"name\":\"Acme\"}"# : "doc \(request.path)"
                return .init(body: #"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"\#(text)"}]}}"#)
            }
        }
        var out: [[String: Any]] = []
        var projectRequests: [String?] = []
        let proxy = StdioProxy(target: Target(), resolve: { opened in
            projectRequests.append(opened)
            let route: MCPRoute = opened.map { .project($0) } ?? .keyWindow
            return Endpoint(instance: InstanceRecord(instance: "app-test", kind: .app, started: "x", http: "http://127.0.0.1:\(host.port)", projects: []), token: "tok", route: route, project: nil)
        }, resolveApp: { self.appEndpoint(host) }, write: { out.append(JSON.object($0)!) })
        func text(_ o: [String: Any]) -> String? { (((o["result"] as? [String: Any])?["content"] as? [[String: Any]])?.first?["text"]) as? String }
        proxy.handle(line: rpc("initialize", params: ["protocolVersion": "2025-06-18", "clientInfo": ["name": "claude-code"]]))
        proxy.handle(line: rpc("tools/call", id: 2, params: ["name": "list_projects", "arguments": [:]]))
        XCTAssertEqual(host.requests.last?.path, "/mcp/app", "app tools never need an open project")
        XCTAssertTrue(projectRequests.isEmpty, "the document endpoint was not resolved (the app may have no window)")
        proxy.handle(line: rpc("tools/call", id: 3, params: ["name": "get_document_info", "arguments": [:]]))
        XCTAssertEqual(text(out[2]), "doc /mcp")
        proxy.handle(line: rpc("tools/call", id: 4, params: ["name": "open_project", "arguments": ["project": "Acme"]]))
        XCTAssertEqual(host.requests.last { JSON.object($0.body)?["method"] as? String == "tools/call" }?.path, "/mcp/app")
        proxy.handle(line: rpc("tools/call", id: 5, params: ["name": "get_document_info", "arguments": [:]]))
        XCTAssertEqual(text(out[4]), "doc /mcp/p/P-new", "the document tools now follow the project the agent opened")
        XCTAssertEqual(projectRequests.last ?? nil, "P-new")
    }

    func testAPinnedProxyKeepsItsProjectWhateverTheAgentOpens() throws {
        let host = FakeHost(); defer { host.stop() }
        host.handler = { request in
            let body = JSON.object(request.body)
            switch body?["method"] as? String {
            case "initialize": return .init(headers: ["Mcp-Session-Id": "s"], body: "{}")
            case "notifications/initialized": return .init(status: 202)
            default:
                let name = (body?["params"] as? [String: Any])?["name"] as? String ?? ""
                let text = name == "new_project" ? #"{\"project_id\":\"P-other\"}"# : "doc \(request.path)"
                return .init(body: #"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"\#(text)"}]}}"#)
            }
        }
        var out: [[String: Any]] = []
        var seen: [String?] = []
        let proxy = StdioProxy(target: Target(project: "pinned"), resolve: { opened in
            seen.append(opened)
            return Endpoint(instance: InstanceRecord(instance: "app-test", kind: .app, started: "x", http: "http://127.0.0.1:\(host.port)", projects: []), token: "tok", route: .project("pinned"), project: nil)
        }, resolveApp: { self.appEndpoint(host) }, write: { out.append(JSON.object($0)!) })
        proxy.handle(line: rpc("tools/call", id: 1, params: ["name": "new_project", "arguments": [:]]))
        proxy.handle(line: rpc("tools/call", id: 2, params: ["name": "get_document_info", "arguments": [:]]))
        XCTAssertEqual((((out[1]["result"] as? [String: Any])?["content"] as? [[String: Any]])?.first?["text"]) as? String, "doc /mcp/p/pinned")
        XCTAssertEqual(seen.compactMap { $0 }, [], "an explicit --project is never overridden")
    }

    func testFailuresBecomeToolErrorsTheAgentCanReadAndUnknownToolsAreProtocolErrors() throws {
        var out: [[String: Any]] = []
        let proxy = StdioProxy(target: Target(), resolve: { _ in throw CLIError(message: "No open project matches \"x\". Run `ocelot ls`.") }, write: { out.append(JSON.object($0)!) })
        proxy.handle(line: rpc("tools/call", params: ["name": "get_document_info"]))
        let result = try XCTUnwrap(out[0]["result"] as? [String: Any])
        XCTAssertEqual(result["isError"] as? Bool, true)
        XCTAssertTrue(((result["content"] as? [[String: Any]])?.first?["text"] as? String ?? "").contains("ocelot ls"))
        proxy.handle(line: rpc("tools/call", id: 2, params: ["name": "no_such_tool"]))
        XCTAssertEqual((out[1]["error"] as? [String: Any])?["code"] as? Int, -32602)
        proxy.handle(line: "not json")
        XCTAssertEqual((out[2]["error"] as? [String: Any])?["code"] as? Int, -32700)
    }

    func testGatewayErrorsKeepTheirMessage() throws {
        let host = FakeHost(); defer { host.stop() }
        host.handler = { request in
            if JSON.object(request.body)?["method"] as? String == "initialize" { return .init(headers: ["Mcp-Session-Id": "s"], body: "{}") }
            if JSON.object(request.body)?["method"] as? String == "notifications/initialized" { return .init(status: 202) }
            return .init(status: 403, body: #"{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"This token is limited to project P."}}"#)
        }
        var out: [[String: Any]] = []
        let proxy = StdioProxy(target: Target(), resolve: { _ in self.endpoint(host) }, write: { out.append(JSON.object($0)!) })
        proxy.handle(line: rpc("tools/call", params: ["name": "get_tree"]))
        let text = (((out[0]["result"] as? [String: Any])?["content"] as? [[String: Any]])?.first?["text"]) as? String
        XCTAssertEqual(text, "This token is limited to project P.")
    }
}

final class CommandOutputTests: XCTestCase {
    func testCallSavesImagesAndPrintsText() throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47]).base64EncodedString()
        let result = MCPConnection.ToolResult(isError: false, content: [["type": "text", "text": "hello"], ["type": "image", "data": png, "mimeType": "image/png"]])
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-out-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        XCTAssertEqual(try CallCommand.render(result, json: false, outDirectory: dir.path, name: "get_screenshot"), 0)
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(try Data(contentsOf: dir.appendingPathComponent(files[0])), Data([0x89, 0x50, 0x4E, 0x47]))
    }

    func testExportPicksArtboardsByIdNameOrFirst() throws {
        let boards: [[String: Any]] = [["id": "n_1", "name": "Home"], ["id": "n_2", "name": "Pricing"]]
        XCTAssertEqual(try ExportCommand.pick(nil, artboards: boards).id, "n_1")
        XCTAssertEqual(try ExportCommand.pick("pricing", artboards: boards).id, "n_2")
        XCTAssertEqual(try ExportCommand.pick("n_2", artboards: boards).name, "Pricing")
        XCTAssertThrowsError(try ExportCommand.pick(nil, artboards: []))
    }

    func testHandoffArgumentsFollowTheOptions() throws {
        XCTAssertEqual(try HandoffCommand.toolArguments(scope: nil, page: nil, nodes: [], files: false).count, 0)
        let args = try HandoffCommand.toolArguments(scope: "selection", page: "p_1", nodes: ["n_1,n_2", " n_3 "], files: true)
        XCTAssertEqual(args["scope"] as? String, "selection")
        XCTAssertEqual(args["page_id"] as? String, "p_1")
        XCTAssertEqual(args["node_ids"] as? [String], ["n_1", "n_2", "n_3"])
        XCTAssertEqual(args["files"] as? Bool, true)
        XCTAssertThrowsError(try HandoffCommand.toolArguments(scope: "everything", page: nil, nodes: [], files: false)) { error in
            XCTAssertTrue((error as? CLIError)?.message.contains("selection, page, document") == true)
        }
    }

    func testHandoffWritesTextAndBase64FilesAndRefusesPathsOutsideTheFolder() throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47])
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-handoff-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let files: [[String: Any]] = [
            ["path": "HANDOFF.md", "text": "# Handoff"],
            ["path": "screens/home@2x.png", "base64": png.base64EncodedString()],
            ["path": "code/public/assets/a.png", "base64": png.base64EncodedString()],
        ]
        let folder = try HandoffCommand.write(files: files, into: dir)
        XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent("HANDOFF.md"), encoding: .utf8), "# Handoff")
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("screens/home@2x.png")), png)
        // Writing again replaces files in place.
        _ = try HandoffCommand.write(files: [["path": "HANDOFF.md", "text": "v2"]], into: dir)
        XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent("HANDOFF.md"), encoding: .utf8), "v2")

        let outside = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-handoff-out-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: outside) }
        for bad in ["../x.txt", "a/../../x.txt", "/etc/x", "~/x", "a\\b", ""] {
            XCTAssertThrowsError(try HandoffCommand.write(files: [["path": "ok.txt", "text": "1"], ["path": bad, "text": "x"]], into: outside), "should refuse \(bad)")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.path), "nothing is written when one path is refused")
        XCTAssertThrowsError(try HandoffCommand.write(files: [["path": "a.png"]], into: outside))
    }

    func testRegistryListsEveryCommandOnceWithUsage() {
        let names = SubcommandRegistry.all.map { $0.name }
        XCTAssertEqual(Set(names).count, names.count)
        for name in ["ls", "open", "token", "mcp", "mcp-config", "call", "export", "handoff", "serve", "run"] { XCTAssertTrue(names.contains(name), name) }
        for command in SubcommandRegistry.all { XCTAssertFalse(command.usage.isEmpty); XCTAssertFalse(command.summary.isEmpty) }
        XCTAssertTrue(SubcommandRegistry.help.contains("--project"))
    }
}

final class AppCommandTests: XCTestCase {
    func testSettingsPairsAreTypedAndMalformedOnesExplainTheForm() throws {
        let changes = try SettingsCommand.changes(["updates.automatic_checks=false", "images.default_model=fal-ai/flux/dev", "x=null", "mcp.port=9000"])
        XCTAssertEqual(changes["updates.automatic_checks"] as? Bool, false)
        XCTAssertEqual(changes["images.default_model"] as? String, "fal-ai/flux/dev")
        XCTAssertTrue(changes["x"] is NSNull)
        XCTAssertEqual(changes["mcp.port"] as? Int, 9000, "typed like JSON; the app refuses the security key")
        XCTAssertThrowsError(try SettingsCommand.changes(["novalue"])) { XCTAssertEqual(($0 as? CLIError)?.code, 2) }
    }

    func testNewMapsOptionsToTheToolArguments() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("brief-\(UUID().uuidString).md")
        try Data("hi".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let parsed = try Args(["MCP Check", "--prompt", "A pricing page", "--attach", file.path, "--kind", "deck", "--theme", "paper", "--path", "/tmp/x.ocelot", "--background"], valueOptions: ["--prompt", "--attach", "--kind", "--theme", "--path", "--from"], flags: ["--json", "--background"])
        let arguments = try NewCommand.arguments(parsed)
        XCTAssertEqual(arguments["name"] as? String, "MCP Check")
        XCTAssertEqual(arguments["prompt"] as? String, "A pricing page")
        XCTAssertEqual(arguments["kind"] as? String, "deck")
        XCTAssertEqual(arguments["theme"] as? String, "paper")
        XCTAssertEqual(arguments["background"] as? Bool, true)
        XCTAssertEqual((arguments["attachments"] as? [[String: Any]])?.first?["path"] as? String, file.standardizedFileURL.path)
        let missing = try Args(["--attach", "/nope/none.png"], valueOptions: ["--attach"])
        XCTAssertThrowsError(try NewCommand.arguments(missing))
    }

    func testProjectsPrintOpenAndRecentWithFlags() {
        let text = ProjectsCommand.render([
            "open": [["project_id": "P1", "name": "Acme", "path": "/x/Acme.ocelot", "focused": true, "unsaved": true], ["project_id": "P2", "name": "Scratch", "untitled": true]],
            "recent": [["name": "Old", "path": "/x/Old.ocelot", "open": false]],
        ])
        XCTAssertTrue(text.contains("P1\tAcme\t/x/Acme.ocelot  [front, unsaved]"))
        XCTAssertTrue(text.contains("(untitled)"))
        XCTAssertTrue(text.contains("Old\t/x/Old.ocelot"))
    }

    func testEveryAppCommandIsRegisteredAndDocumented() {
        for name in ["projects", "new", "save", "close", "settings", "quit"] {
            XCTAssertNotNil(SubcommandRegistry.find(name), name)
            XCTAssertTrue(SubcommandRegistry.find(name)!.usage.contains("Usage: ocelot \(name)"), name)
        }
        XCTAssertTrue(SubcommandRegistry.help.contains("App tools"))
    }
}
