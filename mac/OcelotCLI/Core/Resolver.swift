import Foundation

/// Which project/window/instance a command addresses (`--project`, `--window`, `--instance`).
struct Target: Equatable {
    var project: String?
    var window: String?
    var instance: String?

    static let valueOptions: Set<String> = ["--project", "--window", "--instance"]

    init(project: String? = nil, window: String? = nil, instance: String? = nil) {
        self.project = project
        self.window = window
        self.instance = instance ?? ProcessInfo.processInfo.environment["OCELOT_INSTANCE"].flatMap { $0.isEmpty ? nil : $0 }
    }

    init(_ args: Args) {
        self.init(project: args.value("--project"), window: args.value("--window"), instance: args.value("--instance"))
    }
}

/// A resolved MCP endpoint: where to connect, with which token, pinned to what.
struct Endpoint {
    var instance: InstanceRecord
    var token: String
    var route: MCPRoute
    var project: RunProject?

    var base: URL { URL(string: instance.http)! }
    var url: URL { URL(string: instance.http + route.path)! }
}

/// Finds running hosts through the run directory, starting the Mac app when asked.
struct Resolver {
    var directory: InstanceDirectory
    /// The run directory of the app's earlier releases (Atelier), read as a fallback so a still-running old app is found.
    /// Defaults to it only while `directory` is the standard one (not under `OCELOT_RUN_DIR`, not in tests).
    var legacyDirectory: InstanceDirectory?
    var launcher: AppLauncher
    var known: KnownProjects { KnownProjects(runDirectory: directory) }
    /// How long to wait for the app to start and publish its discovery file.
    var launchTimeout: TimeInterval

    init(directory: InstanceDirectory = .standard, legacyDirectory: InstanceDirectory? = nil, launcher: AppLauncher = AppLauncher(), launchTimeout: TimeInterval = 45) {
        self.directory = directory
        self.legacyDirectory = legacyDirectory ?? (directory.url.standardizedFileURL == InstanceDirectory.standard.url.standardizedFileURL ? InstanceDirectory.legacy : nil)
        self.launcher = launcher
        self.launchTimeout = launchTimeout
    }

    // MARK: Pure lookup

    typealias Located = (record: InstanceRecord, directory: InstanceDirectory)

    /// Live hosts with the directory that published each (its token lives next to it). A host of the old app is listed
    /// unless the new directory has an instance of the same name. The old directory is only read: stale files stay.
    func located(matching selector: String?) -> [Located] {
        var live: [Located] = directory.liveInstances().map { ($0, directory) }
        if let legacy = legacyDirectory {
            let names = Set(live.map(\.record.instance))
            live += legacy.liveInstances(prune: false).filter { !names.contains($0.instance) }.map { ($0, legacy) }
            live.sort { $0.record.started > $1.record.started }
        }
        guard let selector else { return live }
        return live.filter { $0.record.instance == selector || $0.record.kind.rawValue == selector || $0.record.instance.hasPrefix(selector) || $0.record.containerId?.hasPrefix(selector) == true }
    }

    func instances(matching selector: String?) -> [InstanceRecord] {
        located(matching: selector).map(\.record)
    }

    /// A project this Mac has opened before: the new list, else the old app's (it moves at the new app's first launch).
    func knownEntry(matching ref: String) -> KnownProjects.Entry? {
        known.entry(matching: ref) ?? legacyDirectory.flatMap { KnownProjects(runDirectory: $0).entry(matching: ref) }
    }

    /// The endpoint for `target` among running hosts, or nil when none hosts it (yet).
    func find(_ target: Target) throws -> Endpoint? {
        let live = located(matching: target.instance)
        if let ref = target.project {
            // A host that has the project itself; apps first (they are the front door), newest first.
            for host in live.filter({ $0.record.kind == .app }) + live.filter({ $0.record.kind != .app }) {
                if let project = host.record.project(matching: ref) {
                    return try endpoint(host, route: .project(project.id), project: project)
                }
            }
            return nil
        }
        if let window = target.window {
            for host in live {
                if let project = host.record.projects.first(where: { $0.windowId == window }) {
                    return try endpoint(host, route: .window(window), project: project)
                }
            }
            return nil
        }
        // Newest app (or the selected instance); the server routes `/mcp` to its key window.
        guard let host = live.first(where: { $0.record.kind == .app }) ?? live.first else { return nil }
        return try endpoint(host, route: .keyWindow, project: nil)
    }

    private func endpoint(_ host: Located, route: MCPRoute, project: RunProject?) throws -> Endpoint {
        let record = host.record
        guard let token = host.directory.readToken(instance: record.instance) else {
            throw CLIError(message: "No token file for instance \(record.instance) in \(host.directory.url.path). Restart that host so it writes <instance>.token.")
        }
        return Endpoint(instance: record, token: token, route: route, project: project)
    }

    /// The app endpoint (`/mcp/app`) of the host the target names: the instance asked for, else the host that serves a pinned
    /// project when that is a headless host or container (the Mac app front door has the project too, unless it does not),
    /// else the newest app, else any live host. App tools never need a project.
    func findApp(_ target: Target) throws -> Endpoint? {
        let live = located(matching: target.instance)
        if target.instance == nil, let ref = target.project,
           !live.contains(where: { $0.record.kind == .app && $0.record.project(matching: ref) != nil }),
           let host = live.first(where: { $0.record.kind != .app && $0.record.project(matching: ref) != nil }) {
            return try endpoint(host, route: .app, project: nil)
        }
        guard let host = live.first(where: { $0.record.kind == .app }) ?? live.first else { return nil }
        return try endpoint(host, route: .app, project: nil)
    }

    /// Like `findApp`, but starts Ocelot (without opening any project) when nothing runs, then waits for the discovery file.
    func ensureApp(_ target: Target, launch: Bool = true) throws -> Endpoint {
        if let found = try findApp(target) { return found }
        guard launch else { throw CLIError(message: "Ocelot is not running. Run `ocelot open <path.ocelot>`, or call an app tool such as new_project through `ocelot mcp`.") }
        if let instance = target.instance, instances(matching: instance).isEmpty {
            throw CLIError(message: "No running instance matches \"\(instance)\". Run `ocelot ls` to see hosts.")
        }
        try launcher.launch(path: nil, foreground: false)
        let deadline = Date().addingTimeInterval(launchTimeout)
        while Date() < deadline {
            if let found = try findApp(target) { return found }
            Thread.sleep(forTimeInterval: 0.2)
        }
        throw CLIError(message: "Ocelot did not start within \(Int(launchTimeout)) seconds. Open it manually, then retry; `ocelot ls` shows what is running.")
    }

    // MARK: Launching

    /// Like `find`, but starts Ocelot (and opens a known project) when needed, then waits for the discovery file.
    func ensure(_ target: Target, launch: Bool = true) throws -> Endpoint {
        if let found = try find(target) { return found }
        guard launch else { throw notFound(target) }
        let live = instances(matching: target.instance)
        if target.instance != nil && live.isEmpty {
            throw CLIError(message: "No running instance matches \"\(target.instance!)\". Run `ocelot ls` to see hosts.")
        }
        var openPath: String?
        if let ref = target.project {
            openPath = knownEntry(matching: ref)?.path
            // Nothing is running and nothing is known: still start the app, it may restore an unsaved project.
            if openPath == nil && !live.isEmpty { throw notFound(target) }
        } else if target.window != nil {
            throw notFound(target)
        }
        if live.isEmpty || openPath != nil {
            try launcher.launch(path: openPath, foreground: false)
        }
        let deadline = Date().addingTimeInterval(launchTimeout)
        while Date() < deadline {
            if let found = try find(target) { return found }
            Thread.sleep(forTimeInterval: 0.2)
        }
        if target.project != nil || target.window != nil { throw notFound(target, afterLaunch: true) }
        throw CLIError(message: "Ocelot did not start within \(Int(launchTimeout)) seconds. Open it manually, then retry; `ocelot ls` shows what is running.")
    }

    func notFound(_ target: Target, afterLaunch: Bool = false) -> CLIError {
        let open = instances(matching: nil).flatMap(\.projects)
        let list = open.isEmpty ? "No project is open." : "Open projects: " + open.map { "\($0.name) (\($0.id))" }.joined(separator: ", ") + "."
        if let ref = target.project {
            return CLIError(message: "No open project matches \"\(ref)\"\(afterLaunch ? " even after starting Ocelot" : ""). \(list) Run `ocelot ls`, or `ocelot open <path.ocelot>` to open one.")
        }
        if let window = target.window {
            return CLIError(message: "No open window with id \(window). \(list) Run `ocelot ls`.")
        }
        return CLIError(message: "Ocelot is not running. Run `ocelot open <path.ocelot>`.")
    }
}

/// Starts the Mac app: `OCELOT_APP`, else the app this CLI is bundled in, else LaunchServices by bundle id.
struct AppLauncher {
    static let bundleId = "sh.caracal.ocelot"
    var environment: [String: String] = ProcessInfo.processInfo.environment
    var executable: URL? = Bundle.main.executableURL?.resolvingSymlinksInPath()

    var appPath: String? {
        if let p = environment["OCELOT_APP"], !p.isEmpty { return p }
        guard let path = executable?.path, let range = path.range(of: ".app/Contents/") else { return nil }
        return String(path[..<range.lowerBound]) + ".app"
    }

    /// Arguments for /usr/bin/open.
    func arguments(path: String?, foreground: Bool) -> [String] {
        var args: [String] = foreground ? [] : ["-g"]
        if let app = appPath { args += ["-a", app] } else { args += ["-b", Self.bundleId] }
        if let path { args.append(path) }
        return args
    }

    func launch(path: String?, foreground: Bool) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = arguments(path: path, foreground: foreground)
        let errPipe = Pipe()
        process.standardError = errPipe
        do { try process.run() } catch {
            throw CLIError(message: "Could not run /usr/bin/open: \(error.localizedDescription).")
        }
        process.waitUntilExit()
        if process.terminationStatus != 0 {
            let detail = String(decoding: errPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw CLIError(message: "Could not start Ocelot (\(detail.isEmpty ? "open exited \(process.terminationStatus)" : detail)). Install it, or set OCELOT_APP to the path of Ocelot.app.")
        }
    }
}
