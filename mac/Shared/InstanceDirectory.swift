import Foundation

/// One project an instance hosts, as listed in its run-directory record.
struct RunProject: Codable, Equatable, Sendable {
    var id: String
    var name: String
    var path: String?
    var windowId: String?
}

/// `<instance>.json` in the run directory: one per running host (Mac app, headless host, container).
struct InstanceRecord: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable { case app, headless, container }

    var v: Int = 1
    var instance: String
    var kind: Kind
    var pid: Int?
    var containerId: String?
    var runtime: String?
    var started: String
    /// `http://127.0.0.1:<port>`
    var http: String
    var socket: String?
    var projects: [RunProject]

    var port: Int? { URL(string: http)?.port }

    /// The project with this id, or the unique project whose name or id prefix matches `ref`.
    func project(matching ref: String) -> RunProject? {
        if let exact = projects.first(where: { $0.id == ref }) { return exact }
        return InstanceDirectory.match(ref, in: projects)
    }
}

/// `~/Library/Application Support/Ocelot/run/` (0700): discovery files written by every running host.
/// `OCELOT_RUN_DIR` overrides the location (tests, side-by-side dev setups).
struct InstanceDirectory: Sendable {
    let url: URL

    init(url: URL) { self.url = url }

    static var standard: InstanceDirectory {
        if let override = ProcessInfo.processInfo.environment["OCELOT_RUN_DIR"], !override.isEmpty {
            return InstanceDirectory(url: URL(fileURLWithPath: override, isDirectory: true))
        }
        return InstanceDirectory(url: supportDirectory.appendingPathComponent("run", isDirectory: true))
    }

    /// `~/Library/Application Support/Ocelot`
    static var supportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Ocelot", isDirectory: true)
    }

    /// `~/Library/Application Support/Atelier/run`: where the app's earlier releases (named Atelier) publish. The CLI reads it
    /// as a fallback so it still finds an old app that is running; the new app moves the whole folder to Ocelot's at
    /// launch. Nil when `OCELOT_RUN_DIR` redirects discovery (tests, side-by-side setups).
    static var legacy: InstanceDirectory? {
        if let override = ProcessInfo.processInfo.environment["OCELOT_RUN_DIR"], !override.isEmpty { return nil }
        return InstanceDirectory(url: supportDirectory.deletingLastPathComponent().appendingPathComponent("Atelier/run", isDirectory: true))
    }

    struct Failure: LocalizedError {
        var errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    // MARK: Paths

    /// Instance names become file names: letters, digits, `.`, `_`, `-` only.
    static func isValidInstanceName(_ name: String) -> Bool {
        !name.isEmpty && name.count <= 96 && !name.hasPrefix(".") && name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) }
    }

    func recordURL(_ instance: String) -> URL { url.appendingPathComponent("\(instance).json") }
    func tokenURL(_ instance: String) -> URL { url.appendingPathComponent("\(instance).token") }

    // MARK: Writing

    /// Creates the directory (0700) if needed and tightens an existing one.
    func prepare() throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }

    func publish(_ record: InstanceRecord) throws {
        guard Self.isValidInstanceName(record.instance) else { throw Failure("Invalid instance name \"\(record.instance)\".") }
        try prepare()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try Self.writeAtomically(try encoder.encode(record), to: recordURL(record.instance))
    }

    func writeToken(_ token: String, instance: String) throws {
        guard Self.isValidInstanceName(instance) else { throw Failure("Invalid instance name \"\(instance)\".") }
        try prepare()
        try Self.writeAtomically(Data(token.utf8), to: tokenURL(instance))
    }

    func readToken(instance: String) -> String? {
        guard Self.isValidInstanceName(instance),
              let text = try? String(contentsOf: tokenURL(instance), encoding: .utf8) else { return nil }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// Removes the discovery file. `keepToken` is for the Mac app, whose master token must survive restarts
    /// so HTTP clients configured with it keep working; every other host removes both.
    func remove(instance: String, keepToken: Bool = false) {
        guard Self.isValidInstanceName(instance) else { return }
        try? FileManager.default.removeItem(at: recordURL(instance))
        if !keepToken { try? FileManager.default.removeItem(at: tokenURL(instance)) }
    }

    /// Write to a 0600 temp file in the same directory, then rename over the target.
    static func writeAtomically(_ data: Data, to target: URL) throws {
        let tmp = target.deletingLastPathComponent().appendingPathComponent(".\(target.lastPathComponent).\(getpid()).\(UInt32.random(in: 0...UInt32.max)).tmp")
        let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw Failure("Could not write \(tmp.path): \(String(cString: strerror(errno)))") }
        var offset = 0
        var failed: Int32 = 0
        data.withUnsafeBytes { raw in
            while offset < raw.count {
                let n = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if n < 0 { if errno == EINTR { continue }; failed = errno; return }
                offset += n
            }
        }
        _ = fsync(fd)
        close(fd)
        if failed != 0 {
            unlink(tmp.path)
            throw Failure("Could not write \(target.lastPathComponent): \(String(cString: strerror(failed)))")
        }
        guard rename(tmp.path, target.path) == 0 else {
            let code = errno
            unlink(tmp.path)
            throw Failure("Could not replace \(target.lastPathComponent): \(String(cString: strerror(code)))")
        }
    }

    // MARK: Reading

    /// Every live instance, newest first. Entries whose process is gone or whose endpoint does not answer are
    /// deleted (and reported nowhere): the contract says readers drop stale files.
    func liveInstances(prune: Bool = true) -> [InstanceRecord] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: url.path) else { return [] }
        var live: [InstanceRecord] = []
        for name in names where name.hasSuffix(".json") && !name.hasPrefix(".") {
            let file = url.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: file), let record = try? JSONDecoder().decode(InstanceRecord.self, from: data),
                  record.instance == String(name.dropLast(5)) else { continue }
            if Self.isLive(record) {
                live.append(record)
            } else if prune {
                remove(instance: record.instance, keepToken: record.kind == .app)
            }
        }
        return live.sorted { $0.started > $1.started }
    }

    static func isLive(_ record: InstanceRecord) -> Bool {
        if let pid = record.pid, pid > 0, kill(pid_t(pid), 0) != 0, errno != EPERM { return false }
        guard let port = record.port else { return false }
        return tcpReachable(port: port, timeout: 0.4)
    }

    /// Connectable on 127.0.0.1 within `timeout` seconds.
    static func tcpReachable(port: Int, timeout: TimeInterval) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(clamping: port)).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        if rc == 0 { return true }
        guard errno == EINPROGRESS else { return false }
        var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        guard poll(&pfd, 1, Int32(timeout * 1000)) > 0 else { return false }
        var err: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
        return err == 0
    }

    // MARK: Matching

    static func slug(_ name: String) -> String {
        let lowered = name.lowercased()
        var out = ""
        var lastDash = false
        for ch in lowered {
            if ch.isASCII && (ch.isLetter || ch.isNumber) { out.append(ch); lastDash = false } else if !lastDash && !out.isEmpty { out.append("-"); lastDash = true }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return out.isEmpty ? "untitled" : out
    }

    /// Resolves a user-typed project reference: id, id prefix (4+ chars), exact name, or slug.
    /// Returns nil when nothing or more than one project matches.
    static func match(_ ref: String, in projects: [RunProject]) -> RunProject? {
        let r = ref.lowercased()
        let candidates: [[RunProject]] = [
            projects.filter { $0.id.lowercased() == r },
            r.count >= 4 ? projects.filter { $0.id.lowercased().hasPrefix(r) } : [],
            projects.filter { $0.name.lowercased() == r },
            projects.filter { slug($0.name) == slug(ref) },
        ]
        for group in candidates where !group.isEmpty { return group.count == 1 ? group[0] : nil }
        return nil
    }
}

/// `~/Library/Application Support/Ocelot/projects.json`: saved projects the Mac app has opened, so
/// `ocelot open <id>` and the CLI's auto-launch can reopen a project by id while the app is closed.
struct KnownProjects: Sendable {
    struct Entry: Codable, Equatable, Sendable {
        var id: String
        var name: String
        var path: String
        var lastSeen: String
    }

    let file: URL

    init(file: URL) { self.file = file }

    /// Sits next to the run directory (so `OCELOT_RUN_DIR` isolates tests too).
    init(runDirectory: InstanceDirectory) {
        file = runDirectory.url.deletingLastPathComponent().appendingPathComponent("projects.json")
    }

    func all() -> [Entry] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        return (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    }

    func record(_ project: RunProject, now: Date = Date()) {
        guard let path = project.path, !project.id.isEmpty else { return }
        let stamp = ISO8601DateFormatter().string(from: now)
        var entries = all().filter { $0.id != project.id && $0.path != path }
        entries.insert(Entry(id: project.id, name: project.name, path: path, lastSeen: stamp), at: 0)
        if entries.count > 200 { entries.removeLast(entries.count - 200) }
        guard let data = try? JSONEncoder().encode(entries) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? InstanceDirectory.writeAtomically(data, to: file)
    }

    func entry(matching ref: String) -> Entry? {
        let entries = all()
        let projects = entries.map { RunProject(id: $0.id, name: $0.name, path: $0.path) }
        guard let hit = InstanceDirectory.match(ref, in: projects) else { return nil }
        return entries.first { $0.id == hit.id }
    }
}
