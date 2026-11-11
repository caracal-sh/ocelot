import AppKit
import Foundation

/// The app tools (editor/src/mcp/appTools.ts) as the Mac app does them: thin wrappers around what the menus, Home and
/// Settings already do (`DocumentOpener`, `HomeCoordinator`, `DocumentSession`, `RecentDocuments`, the settings models). Design
/// logic stays in the editor: when a tool has to change the document (a theme for a new project) it calls the editor's own
/// document tools through `editor.mcpHandle`. Every action that changes something the person can see is announced through
/// `AppActivity` ("Claude Code opened Acme").
@MainActor
final class LiveAppControl: AppControl {
    private unowned let service: MCPService
    private let registry: EditorRegistry
    private let coordinator: HomeCoordinator
    private let recents: RecentDocuments
    private let known: KnownProjects
    private let activity: AppActivity
    let settings: AppSettings
    private let updates: UpdateService
    private let isolation: AgentIsolationModel

    init(service: MCPService, registry: EditorRegistry, coordinator: HomeCoordinator = .shared, recents: RecentDocuments = .shared,
         known: KnownProjects, activity: AppActivity = .shared, updates: UpdateService = .shared,
         images: ImageSettingsModel = .shared, isolation: AgentIsolationModel = .shared) {
        self.service = service
        self.registry = registry
        self.coordinator = coordinator
        self.recents = recents
        self.known = known
        self.activity = activity
        self.updates = updates
        self.isolation = isolation
        self.settings = AppSettings(hooks: .live(updates: updates, images: images, isolation: isolation, mcp: service))
    }

    // MARK: Dispatch

    func call(tool: String, arguments a: [String: Any], client: String?) async throws -> Any {
        switch tool {
        case "get_app_info": return appInfo()
        case "list_projects": return listProjects(includeRecent: try bool(a, "include_recent") ?? true, query: try string(a, "query"))
        case "open_project": return try await openProject(ref: try string(a, "project"), path: try string(a, "path"), background: try bool(a, "background") ?? false, client: client)
        case "new_project": return try await newProject(a, client: client)
        case "duplicate_project": return try await duplicateProject(a, client: client)
        case "save_project": return try await saveProject(ref: try string(a, "project"), client: client)
        case "save_project_as": return try await saveProjectAs(ref: try string(a, "project"), path: try required(a, "path"), overwrite: try bool(a, "overwrite") ?? false, client: client)
        case "close_project": return try await closeProject(ref: try string(a, "project"), discard: try bool(a, "discard") ?? false, client: client)
        case "reveal_project": return try revealProject(ref: try string(a, "project"))
        case "remove_recent_projects": return try removeRecents(ref: try string(a, "project"), all: try bool(a, "all") ?? false, client: client)
        case "open_home":
            coordinator.showHome()
            activity.record(client: client, did: "opened Home")
            return ["shown": true]
        case "open_settings": return try openSettings(tab: try string(a, "tab"), client: client)
        case "list_windows": return ["windows": windows().map(\.json)]
        case "focus_window": return try focusWindow(a, client: client)
        case "arrange_windows": return try arrangeWindows(a, client: client)
        case "reload_editor": return try reloadEditor(ref: try string(a, "project"), windowId: try string(a, "window_id"))
        case "get_app_settings": return await settings.snapshot()
        case "set_app_settings":
            guard let changes = a["settings"] as? [String: Any] else {
                throw AppToolError("set_app_settings needs \"settings\": an object such as { \"updates.automatic_checks\": false }. Keys you may change: \(settings.writableKeys.joined(separator: ", ")).")
            }
            let result = try await settings.apply(changes)
            activity.record(client: client, did: "changed app settings (\((result["changed"] as? [String: Any] ?? [:]).keys.sorted().joined(separator: ", ")))")
            return result
        case "verify_agent_isolation": return await verifyIsolation()
        case "install_command_line_tool":
            let remove = try bool(a, "remove") ?? false
            let result = try await settings.apply(["cli.installed": !remove])
            activity.record(client: client, did: remove ? "removed the command-line tool" : "installed the command-line tool")
            return result
        case "check_for_updates": return await checkForUpdates()
        case "get_mcp_config": return try mcpConfig(client: try required(a, "client"), ref: try string(a, "project"))
        case "quit_app": return try await quit(save: try bool(a, "save") ?? false, client: client)
        default: throw AppToolError("Unknown app tool \"\(tool)\".")
        }
    }

    // MARK: Arguments

    private func string(_ a: [String: Any], _ key: String) throws -> String? {
        guard let v = a[key], !(v is NSNull) else { return nil }
        guard let s = v as? String else { throw AppToolError("\"\(key)\" must be a string.") }
        return s.isEmpty ? nil : s
    }

    private func required(_ a: [String: Any], _ key: String) throws -> String {
        guard let s = try string(a, key) else { throw AppToolError("Missing required argument \"\(key)\".") }
        return s
    }

    private func bool(_ a: [String: Any], _ key: String) throws -> Bool? {
        guard let v = a[key], !(v is NSNull) else { return nil }
        guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw AppToolError("\"\(key)\" must be true or false.") }
        return n.boolValue
    }

    // MARK: Paths and projects

    /// An absolute (or `~/`) path to a package; ".ocelot" is added when missing.
    static func packageURL(_ raw: String) throws -> URL {
        var path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if path.hasPrefix("~") { path = (path as NSString).expandingTildeInPath }
        guard path.hasPrefix("/") else { throw AppToolError("\"\(raw)\" is not an absolute path. Give a path such as ~/Designs/Acme.ocelot, or an absolute one.") }
        var url = URL(fileURLWithPath: path).standardizedFileURL
        if !DocumentExtension.matches(url) { url.appendPathExtension(DocumentExtension.current) }
        return url
    }

    private func looksLikePath(_ ref: String) -> Bool { ref.hasPrefix("/") || ref.hasPrefix("~") || DocumentExtension.matches(path: ref) }

    private func samePath(_ a: URL, _ b: URL) -> Bool {
        a.standardizedFileURL.resolvingSymlinksInPath().path == b.standardizedFileURL.resolvingSymlinksInPath().path
    }

    private func name(of controller: EditorWebController) -> String {
        controller.session.fileURL?.deletingPathExtension().lastPathComponent ?? controller.session.documentName
    }

    /// What a reference names: an open window, or a saved package that is not open.
    private enum Resolved {
        case window(EditorWebController)
        case saved(url: URL, name: String)
    }

    private func resolve(_ ref: String?, requireWindowWhenOmitted: Bool = true) throws -> Resolved {
        guard let ref else {
            if let active = registry.active { return .window(active) }
            throw AppToolError("No project is open, so there is nothing to act on. Call list_projects to see what exists, then open_project; or new_project to start one.")
        }
        let windows = registry.all
        if looksLikePath(ref) {
            let url = try Self.packageURL(ref)
            if let open = windows.first(where: { $0.session.shows(url) }) { return .window(open) }
            guard DocumentPackage.hasDocument(at: url) else {
                throw AppToolError("\(url.path) is not an Ocelot document (no document.json inside). list_projects shows the projects Ocelot knows; new_project creates one.")
            }
            return .saved(url: url, name: url.deletingPathExtension().lastPathComponent)
        }
        let openProjects = windows.compactMap { c in c.session.runProject(windowId: c.id).map { (c, $0) } }
        if let hit = InstanceDirectory.match(ref, in: openProjects.map(\.1)) {
            return .window(openProjects.first { $0.1.id == hit.id }!.0)
        }
        let clash = openProjects.filter { $0.1.name.lowercased() == ref.lowercased() }
        if clash.count > 1 { throw AppToolError("More than one open project is called \"\(ref)\": \(clash.map { "\($0.1.name) (\($0.1.id))" }.joined(separator: ", ")). Use the id.") }
        // A saved project that is not open: the recent list by name or path, then the ids this Mac has opened.
        let wanted = ref.lowercased()
        let recentHits = recents.items.filter { $0.name.lowercased() == wanted || InstanceDirectory.slug($0.name) == InstanceDirectory.slug(ref) }
        if recentHits.count == 1 { return .saved(url: recentHits[0].url, name: recentHits[0].name) }
        if recentHits.count > 1 { throw AppToolError("More than one recent document is called \"\(ref)\": \(recentHits.map(\.url.path).joined(separator: ", ")). Use the path.") }
        if let entry = known.entry(matching: ref) {
            if let open = windows.first(where: { $0.session.shows(URL(fileURLWithPath: entry.path)) }) { return .window(open) }
            return .saved(url: URL(fileURLWithPath: entry.path), name: entry.name)
        }
        if let remote = otherHost(for: ref) {
            throw AppToolError("\(remote.project.name) is served by \(remote.record.instance) (\(remote.record.kind.rawValue)), not by an editor window. Its document tools work on it directly at /mcp/p/\(remote.project.id) (`ocelot mcp --project \(remote.project.id)`); to edit it in the app, stop that host first (`ocelot stop \(remote.project.id)`).")
        }
        let open = openProjects.map { "\($0.1.name) (\($0.1.id))" }
        throw AppToolError("No project matches \"\(ref)\". \(open.isEmpty ? "No project is open." : "Open: \(open.joined(separator: ", ")).") list_projects shows saved ones too; pass a path to open a package that is not listed.")
    }

    private func otherHost(for ref: String) -> (record: InstanceRecord, project: RunProject)? {
        for record in service.runDirectory.liveInstances() where record.instance != service.instance {
            if let project = record.project(matching: ref) { return (record, project) }
        }
        return nil
    }

    private func controller(for ref: String?) throws -> EditorWebController {
        switch try resolve(ref) {
        case .window(let c): return c
        case .saved(_, let name): throw AppToolError("\"\(name)\" is not open. open_project it first.")
        }
    }

    /// Polls until a window satisfying `match` has loaded its document (project id known), up to `timeout` seconds.
    private func waitForController(timeout: Double = 40, _ match: (EditorWebController) -> Bool) async -> EditorWebController? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let c = registry.all.first(where: { match($0) && !$0.session.projectId.isEmpty }) { return c }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return nil
    }

    /// Like `waitForController`, for a window that was just requested. An app that was launched in the background (`ocelot`
    /// starts it with `open -g`) does not create scene windows until it is active: when nothing appears within a moment the app
    /// is woken, and with `background` the previous app gets the keyboard back as soon as the window exists.
    private func waitForNewWindow(background: Bool, _ match: (EditorWebController) -> Bool) async -> EditorWebController? {
        let previous = NSWorkspace.shared.frontmostApplication
        if let c = await waitForController(timeout: 2.5, match) { return c }
        NSApp.activate()
        var found = await waitForController(timeout: 4, match)
        if found == nil {
            coordinator.retryQueuedWindow()
            found = await waitForController(timeout: 40, match)
        }
        if background, let previous, previous.processIdentifier != getpid() { previous.activate() }
        return found
    }

    private func describe(_ c: EditorWebController) -> [String: Any] {
        var out: [String: Any] = ["project_id": c.session.projectId, "name": name(of: c), "window_id": c.id]
        if let path = c.session.fileURL?.path { out["path"] = path }
        return out
    }

    private func bringToFront(_ c: EditorWebController, background: Bool) {
        guard let window = c.webView.window else { return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        if background { window.orderFront(nil) } else {
            DocumentOpener.show(c, coordinator: coordinator)
            NSApp.activate()
        }
    }

    // MARK: Info and lists

    private func appInfo() -> [String: Any] {
        var seen = Set<String>()
        let agents: [[String: Any]] = service.gateway.connectedClients.compactMap { entry in
            guard seen.insert(entry.client).inserted else { return nil }
            return ["client": AppActivity.label(for: entry.client), "name": entry.client, "connected_to": entry.route]
        }
        let editors = registry.all
        return [
            "name": AppInfo.name, "version": AppInfo.version, "build": AppInfo.build,
            "host": "mac-app", "instance": service.instance,
            "mcp": ["running": { if case .running = service.state { true } else { false } }(), "port": service.boundPort, "app_endpoint": service.url(for: .app)],
            "windows": windows().count,
            "open_projects": editors.compactMap { $0.session.runProject(windowId: $0.id)?.name },
            "agents_connected": agents,
            "command_line_tool_installed": CLIInstaller().status == .installed,
        ]
    }

    private func listProjects(includeRecent: Bool, query: String?) -> [String: Any] {
        let match: (String, String) -> Bool = { name, path in
            guard let q = query?.lowercased() else { return true }
            return name.lowercased().contains(q) || path.lowercased().contains(q)
        }
        let front = registry.active
        let open: [[String: Any]] = registry.all.compactMap { c in
            var row = describe(c)
            guard match(row["name"] as? String ?? "", row["path"] as? String ?? "") else { return nil }
            row["focused"] = c === front
            row["unsaved"] = c.session.hasUnsavedEdits
            if c.session.fileURL == nil { row["untitled"] = true }
            return row
        }
        var out: [String: Any] = ["open": open]
        if includeRecent {
            let openURLs = registry.all.compactMap(\.session.fileURL)
            let entries = known.all()
            let iso = ISO8601DateFormatter()
            out["recent"] = recents.items.compactMap { item -> [String: Any]? in
                guard match(item.name, item.url.path) else { return nil }
                var row: [String: Any] = ["name": item.name, "path": item.url.path, "last_opened": iso.string(from: item.lastOpened), "open": openURLs.contains { samePath($0, item.url) }]
                if let entry = entries.first(where: { samePath(URL(fileURLWithPath: $0.path), item.url) }) { row["project_id"] = entry.id }
                return row
            }
        }
        let others: [[String: Any]] = service.runDirectory.liveInstances().filter { $0.instance != service.instance }.flatMap { record in
            record.projects.filter { match($0.name, $0.path ?? "") }.map { project -> [String: Any] in
                var row: [String: Any] = ["project_id": project.id, "name": project.name, "host": record.instance, "kind": record.kind.rawValue]
                if let path = project.path { row["path"] = path }
                return row
            }
        }
        if !others.isEmpty { out["other_hosts"] = others }
        out["next"] = "open_project({ project: <id, name or path> }) opens one in the editor; new_project creates one."
        return out
    }

    // MARK: Opening and creating

    private func openProject(ref: String?, path: String?, background: Bool, client: String?) async throws -> Any {
        guard ref != nil || path != nil else { throw AppToolError("open_project needs \"project\" (an id, name or path from list_projects) or \"path\" (a .ocelot package). list_projects shows what exists.") }
        let target = try resolve(path ?? ref)
        switch target {
        case .window(let c):
            bringToFront(c, background: background)
            var out = describe(c)
            out["already_open"] = true
            activity.record(client: client, did: "showed \(name(of: c))", in: [c])
            return out
        case .saved(let url, let name):
            switch await DocumentOpener.open(url, interactive: false) {
            case .refused(let why): throw AppToolError(why)
            case .cancelled: throw AppToolError("Opening \(name) was cancelled.")
            case .focused, .loaded, .newWindow: break
            }
            guard let c = await waitForNewWindow(background: background, { $0.session.shows(url) }) else {
                coordinator.discardQueued(.open(url))
                throw AppToolError("\(name) did not finish opening within 40 seconds. list_windows shows what is on screen; try open_project again.")
            }
            bringToFront(c, background: background)
            var out = describe(c)
            out["already_open"] = false
            activity.record(client: client, did: "opened \(self.name(of: c))", in: [c])
            return out
        }
    }

    private struct EditorToolFailure: Error { var message: String }

    /// One of the editor's own document tools, run in `c` as the calling agent (so the person sees it in the badges).
    @discardableResult
    private func callEditorTool(_ c: EditorWebController, _ tool: String, _ arguments: [String: Any], client: String?) async throws -> String {
        let request: [String: Any] = ["jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": ["name": tool, "arguments": arguments]]
        let body = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
        let reply = try await c.bridge.editor.call(EditorMethods.McpHandle.self, McpMessage(body: body, client: client ?? "ocelot-app", readOnly: nil), timeout: .seconds(120))
        guard let text = reply.body, let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else {
            throw AppToolError("The editor did not answer \(tool).")
        }
        if let error = object["error"] as? [String: Any] { throw AppToolError("\(tool): \(error["message"] as? String ?? "failed")") }
        let result = object["result"] as? [String: Any] ?? [:]
        let content = (result["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined(separator: "\n")
        if result["isError"] as? Bool == true { throw AppToolError("\(tool): \(content)") }
        return content
    }

    private func attachments(_ raw: Any?) throws -> [StartAttachment] {
        guard let raw, !(raw is NSNull) else { return [] }
        guard let list = raw as? [[String: Any]] else { throw AppToolError("\"attachments\" must be an array of { path | text | data_base64, name }.") }
        var items: [HomeAttachment] = []
        for (index, item) in list.enumerated() {
            let label = "attachments[\(index)]"
            if let path = item["path"] as? String {
                var expanded = path
                if expanded.hasPrefix("~") { expanded = (expanded as NSString).expandingTildeInPath }
                guard expanded.hasPrefix("/") else { throw AppToolError("\(label).path must be an absolute path (or start with ~/).") }
                items.append(HomeAttachment.file(URL(fileURLWithPath: expanded)))
            } else if let text = item["text"] as? String {
                guard let name = item["name"] as? String, !name.isEmpty else { throw AppToolError("\(label) needs \"name\" (for example brief.md) with \"text\".") }
                let mime = (item["mime_type"] as? String) ?? HomeAttachment.classify(name: name)?.mimeType ?? "text/plain"
                items.append(HomeAttachment.text(name: name, mimeType: mime, data: Data(text.utf8)))
            } else if let b64 = item["data_base64"] as? String {
                guard let name = item["name"] as? String, !name.isEmpty else { throw AppToolError("\(label) needs \"name\" (for example logo.png) with \"data_base64\".") }
                guard let data = Data(base64Encoded: b64) else { throw AppToolError("\(label).data_base64 is not valid base64.") }
                guard let (kind, classified) = HomeAttachment.classify(name: name), kind == .image else {
                    throw AppToolError("\(label): \"\(name)\" is not an image name. Send images as data_base64 with a name ending in .png, .jpg, .webp, .gif or .heic; send text with \"text\".")
                }
                guard data.count <= HomeAttachment.maxSourceImageBytes else { throw AppToolError("\(label) is larger than \(HomeAttachment.formatBytes(HomeAttachment.maxSourceImageBytes)).") }
                items.append(HomeAttachment(id: UUID(), kind: .image, name: name, mimeType: (item["mime_type"] as? String) ?? classified, size: data.count, content: .imageData(data)))
            } else {
                throw AppToolError("\(label) needs one of path, text or data_base64.")
            }
        }
        let problems = HomeAttachment.errors(for: items)
        if !problems.isEmpty { throw AppToolError(items.compactMap { problems[$0.id] }.joined(separator: " ")) }
        return try items.map { try $0.payload() }
    }

    private func newProject(_ a: [String: Any], client: String?) async throws -> Any {
        let name = try string(a, "name")
        let prompt = try string(a, "prompt")
        let kind = try string(a, "kind")
        let theme = try string(a, "theme")
        let designSystem = a["design_system"] as? [String: Any]
        if a["design_system"] != nil, !(a["design_system"] is NSNull), designSystem == nil { throw AppToolError("\"design_system\" must be an object of create_design_system arguments.") }
        let pathText = try string(a, "path")
        let from = try string(a, "from_project")
        if let kind, !["design", "deck", "video"].contains(kind) { throw AppToolError("\"kind\" must be design, deck or video.") }
        if theme != nil, designSystem != nil { throw AppToolError("A document has a theme or a design system, not both: pass \"theme\" or \"design_system\".") }
        let files = try attachments(a["attachments"])
        let url = try pathText.map { try Self.packageURL($0) }
        if let url, FileManager.default.fileExists(atPath: url.path) { throw AppToolError("\(url.path) already exists. Pick another path, or open_project it.") }

        if let from {
            guard let url else { throw AppToolError("from_project copies a project to disk, so it needs \"path\" for the copy. Pass the path, or omit from_project for a blank project.") }
            if prompt != nil || !files.isEmpty || kind != nil || theme != nil || designSystem != nil {
                throw AppToolError("from_project makes a copy as it is. Open the copy, then change it with the document tools (apply_theme, update_page) or sidebar_agent.")
            }
            return try await duplicate(ref: from, url: url, open: true, name: name, client: client)
        }

        let before = Set(registry.all.map(\.id))
        // Plain Home semantics when nothing needs setting up first: the prompt starts with the window.
        let setup = name != nil || kind != nil || theme != nil || designSystem != nil || url != nil
        let request: HomeCoordinator.Request
        if let prompt, !setup { request = .prompt(prompt, files) }
        else if prompt == nil, !files.isEmpty, !setup { request = .prompt(HomeAttachment.defaultPrompt, files) }
        else { request = .blank }
        coordinator.start(request)
        guard let c = await waitForNewWindow(background: (try bool(a, "background")) ?? false, { !before.contains($0.id) }) else {
            // Nobody claimed the request: take it back, or the next window the person opens would become this project.
            let withdrawn = coordinator.discardQueued(request)
            throw AppToolError("The new project's window did not open within 40 seconds (the first launch of a new build of Ocelot can take that long). \(withdrawn ? "The request was withdrawn, so nothing is half-created. " : "")Call list_windows to see what is on screen, then call new_project again.")
        }
        // The window of a request made while the app is launching may open behind others: bring it up.
        bringToFront(c, background: (try bool(a, "background")) ?? false)
        do {
            if let name { _ = try await c.bridge.editor.call(EditorMethods.SetName.self, SetNameParams(name: name)); c.session.editorReportedChange(name: name) }
            if let kind, kind != "design" {
                let pages = try await callEditorTool(c, "list_pages", [:], client: client)
                guard let data = pages.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let first = (object["pages"] as? [[String: Any]])?.first?["id"] as? String else { throw AppToolError("The new project has no page to make a \(kind).") }
                try await callEditorTool(c, "update_page", ["page_id": first, "kind": kind], client: client)
            }
            if let theme { try await callEditorTool(c, "apply_theme", ["theme_id": theme], client: client) }
            if let designSystem { try await callEditorTool(c, "create_design_system", designSystem, client: client) }
            if let url {
                guard await c.session.saveAs(to: url) else { throw AppToolError(c.session.lastError ?? "Could not save \(url.path).") }
            }
            if let prompt = prompt ?? (files.isEmpty ? nil : HomeAttachment.defaultPrompt), setup {
                await c.session.startAgent(with: prompt, attachments: files)
            }
        } catch let error as AppToolError {
            var out = describe(c)
            out["warning"] = "The project was created but a setup step failed: \(error.message) Fix it with the document tools (project_id above)."
            activity.record(client: client, did: "created \(self.name(of: c)) (with a problem)", in: [c])
            return out
        }
        var out = describe(c)
        if prompt != nil || !files.isEmpty { out["sidebar_agent"] = "started on your brief; watch it with get_sidebar_agent, or work in the project yourself (the canvas and its locks are shared)." }
        activity.record(client: client, did: prompt == nil ? "created \(self.name(of: c))" : "started \(self.name(of: c)) from a prompt", in: [c])
        return out
    }

    private func duplicateProject(_ a: [String: Any], client: String?) async throws -> Any {
        let url = try Self.packageURL(try required(a, "path"))
        guard !FileManager.default.fileExists(atPath: url.path) else { throw AppToolError("\(url.path) already exists. Pick another path.") }
        return try await duplicate(ref: try string(a, "project"), url: url, open: try bool(a, "open") ?? true, name: nil, client: client)
    }

    private func duplicate(ref: String?, url: URL, open: Bool, name: String?, client: String?) async throws -> Any {
        let source: URL
        let sourceName: String
        switch try resolve(ref) {
        case .window(let c):
            guard let file = c.session.fileURL else { throw AppToolError("\"\(self.name(of: c))\" is untitled, so it has no package to copy. save_project_as it first.") }
            await c.session.flushPendingAutosave()
            source = file
            sourceName = self.name(of: c)
        case .saved(let u, let n):
            source = u
            sourceName = n
        }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: source, to: url)
        } catch {
            throw AppToolError("Could not copy \(source.lastPathComponent) to \(url.path): \(error.localizedDescription)")
        }
        var out: [String: Any] = ["name": name ?? url.deletingPathExtension().lastPathComponent, "path": url.path, "copied_from": sourceName]
        if open {
            let opened = try await openProject(ref: nil, path: url.path, background: false, client: nil) as? [String: Any] ?? [:]
            if let name, let c = registry.all.first(where: { $0.session.shows(url) }) {
                _ = try? await c.bridge.editor.call(EditorMethods.SetName.self, SetNameParams(name: name))
                c.session.editorReportedChange(name: name)
            }
            out.merge(opened) { _, new in new }
            if let c = registry.all.first(where: { $0.session.shows(url) }) { out["name"] = self.name(of: c) }
        }
        activity.record(client: client, did: "duplicated \(sourceName)")
        return out
    }

    // MARK: Saving and closing

    private func saveProject(ref: String?, client: String?) async throws -> Any {
        let c = try controller(for: ref)
        guard let url = c.session.fileURL else {
            throw AppToolError("\"\(name(of: c))\" is untitled: it has no file yet (Ocelot keeps it in crash recovery meanwhile). Call save_project_as with a path, for example { \"path\": \"~/Designs/\(name(of: c)).ocelot\" }.")
        }
        await c.session.save()
        if let error = c.session.lastError { throw AppToolError(error) }
        activity.record(client: client, did: "saved \(name(of: c))", in: [c])
        return ["project_id": c.session.projectId, "path": url.path, "saved": true]
    }

    private func saveProjectAs(ref: String?, path: String, overwrite: Bool, client: String?) async throws -> Any {
        let c = try controller(for: ref)
        let url = try Self.packageURL(path)
        if FileManager.default.fileExists(atPath: url.path) {
            guard overwrite else { throw AppToolError("\(url.path) already exists. Pass overwrite: true to replace it, or pick another path.") }
            guard !registry.all.contains(where: { $0 !== c && $0.session.shows(url) }) else { throw AppToolError("\(url.path) is open in another window. close_project it first.") }
            guard DocumentPackage.hasDocument(at: url) else { throw AppToolError("\(url.path) exists and is not an Ocelot package; refusing to replace it. Pick another path.") }
            try? FileManager.default.removeItem(at: url)
        }
        guard await c.session.saveAs(to: url) else { throw AppToolError(c.session.lastError ?? "Could not save \(url.path).") }
        activity.record(client: client, did: "saved \(name(of: c)) as \(url.lastPathComponent)", in: [c])
        return ["project_id": c.session.projectId, "name": name(of: c), "path": url.path]
    }

    private func closeProject(ref: String?, discard: Bool, client: String?) async throws -> Any {
        let c = try controller(for: ref)
        let session = c.session
        let title = name(of: c)
        var saved = false
        if session.fileURL == nil {
            if session.holdsUntitledWork {
                guard discard else {
                    throw AppToolError("\"\(title)\" is untitled and has work in it, and closing would lose it. Call save_project_as with a path first, then close_project; or close_project with discard: true if the person asked you to throw it away.")
                }
                session.discardUntitledWork()
            }
        } else {
            await session.save()
            if let error = session.lastError { throw AppToolError("Not closed: \(error)") }
            saved = true
        }
        activity.record(client: client, did: "closed \(title)", in: registry.all.filter { $0 !== c })
        c.webView.window?.close()
        return ["closed": true, "name": title, "saved": saved]
    }

    private func revealProject(ref: String?) throws -> Any {
        let url: URL
        switch try resolve(ref) {
        case .window(let c):
            guard let file = c.session.fileURL else { throw AppToolError("\"\(name(of: c))\" is untitled and has no file to show. save_project_as it first.") }
            url = file
        case .saved(let u, _): url = u
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
        return ["revealed": url.path]
    }

    private func removeRecents(ref: String?, all: Bool, client: String?) throws -> Any {
        if all {
            let count = recents.items.count
            recents.clear()
            activity.record(client: client, did: "cleared the recent documents")
            return ["removed": count]
        }
        guard let ref else { throw AppToolError("remove_recent_projects needs \"project\" (a name or path from list_projects' recent list) or all: true.") }
        let hits: [RecentDocument]
        if looksLikePath(ref) {
            let url = try Self.packageURL(ref)
            hits = recents.items.filter { samePath($0.url, url) }
        } else {
            hits = recents.items.filter { $0.name.lowercased() == ref.lowercased() }
        }
        guard !hits.isEmpty else { throw AppToolError("No recent document matches \"\(ref)\". list_projects shows the recent list.") }
        guard hits.count == 1 else { throw AppToolError("More than one recent document is called \"\(ref)\": \(hits.map(\.url.path).joined(separator: ", ")). Use the path.") }
        recents.remove(hits[0].url)
        activity.record(client: client, did: "removed \(hits[0].name) from the recent documents")
        return ["removed": hits[0].url.path]
    }

    // MARK: Windows

    struct WindowRow {
        var id: String
        var kind: String
        var window: NSWindow
        var projectId: String?
        var title: String

        @MainActor var json: [String: Any] {
            var out: [String: Any] = [
                "window_id": id, "kind": kind, "title": title,
                "focused": window.isKeyWindow, "minimized": window.isMiniaturized,
                "full_screen": window.styleMask.contains(.fullScreen), "visible": window.isVisible,
                "frame": LiveAppControl.topLeftFrame(window.frame),
            ]
            if let projectId, !projectId.isEmpty { out["project_id"] = projectId }
            return out
        }
    }

    func windows() -> [WindowRow] {
        var rows: [WindowRow] = registry.all.compactMap { c in
            guard let w = c.webView.window else { return nil }
            return WindowRow(id: c.id, kind: "editor", window: w, projectId: c.session.projectId, title: c.session.title)
        }
        if let home = coordinator.homeNSWindow, home.isVisible || home.isMiniaturized { rows.append(WindowRow(id: "home", kind: "home", window: home, projectId: nil, title: "Home")) }
        if let settings = NSApp.windows.first(where: { $0.identifier?.rawValue.hasSuffix("Settings_window") == true }), settings.isVisible {
            rows.append(WindowRow(id: "settings", kind: "settings", window: settings, projectId: nil, title: settings.title))
        }
        return rows
    }

    /// Frame in points with the origin at the top left of the primary display (AppKit's is bottom left).
    static func topLeftFrame(_ f: NSRect) -> [String: Double] {
        let height = NSScreen.screens.first?.frame.height ?? f.maxY
        return ["x": f.origin.x.rounded(), "y": (height - f.maxY).rounded(), "width": f.width.rounded(), "height": f.height.rounded()]
    }

    static func appKitFrame(x: Double, y: Double, width: Double, height: Double) -> NSRect {
        let screenHeight = NSScreen.screens.first?.frame.height ?? 0
        return NSRect(x: x, y: screenHeight - y - height, width: width, height: height)
    }

    private func focusWindow(_ a: [String: Any], client: String?) throws -> Any {
        let target: WindowRow
        if let id = try string(a, "window_id") {
            guard let row = windows().first(where: { $0.id == id }) else { throw AppToolError("No window \(id). list_windows shows the window ids.") }
            target = row
        } else if let ref = try string(a, "project") {
            let c = try controller(for: ref)
            guard let row = windows().first(where: { $0.id == c.id }) else { throw AppToolError("\"\(name(of: c))\" has no window on screen.") }
            target = row
        } else {
            throw AppToolError("focus_window needs \"window_id\" (from list_windows) or \"project\".")
        }
        let window = target.window
        if window.isMiniaturized { window.deminiaturize(nil) }
        if let wantFull = try bool(a, "full_screen"), wantFull != window.styleMask.contains(.fullScreen) { window.toggleFullScreen(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        activity.record(client: client, did: "brought \(target.title) to the front")
        return ["focused": target.json]
    }

    private func arrangeWindows(_ a: [String: Any], client: String?) throws -> Any {
        guard let layout = try string(a, "layout"), ["tile", "cascade", "frames"].contains(layout) else { throw AppToolError("\"layout\" must be tile, cascade or frames.") }
        let wanted = (a["window_ids"] as? [String]).map(Set.init)
        var rows = windows().filter { $0.kind == "editor" && !$0.window.isMiniaturized && !$0.window.styleMask.contains(.fullScreen) }
        if let wanted { rows = rows.filter { wanted.contains($0.id) } }
        var applied: [(WindowRow, NSRect)] = []
        if layout == "frames" {
            guard let frames = a["frames"] as? [[String: Any]], !frames.isEmpty else { throw AppToolError("layout \"frames\" needs \"frames\": [{ window_id, x, y, width, height }].") }
            for f in frames {
                guard let id = f["window_id"] as? String, let x = (f["x"] as? NSNumber)?.doubleValue, let y = (f["y"] as? NSNumber)?.doubleValue,
                      let w = (f["width"] as? NSNumber)?.doubleValue, let h = (f["height"] as? NSNumber)?.doubleValue, w >= 300, h >= 200 else {
                    throw AppToolError("Every frame needs window_id, x, y and a width of at least 300 and a height of at least 200.")
                }
                guard let row = windows().first(where: { $0.id == id }) else { throw AppToolError("No window \(id). list_windows shows the window ids.") }
                applied.append((row, Self.appKitFrame(x: x, y: y, width: w, height: h)))
            }
        } else {
            guard !rows.isEmpty else { throw AppToolError("No editor window to arrange. open_project or new_project opens one.") }
            let area = (NSScreen.screens.first ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            if layout == "tile" {
                let n = rows.count
                let cols = n <= 3 ? n : Int(ceil(Double(n).squareRoot()))
                let rowsCount = Int(ceil(Double(n) / Double(cols)))
                let w = area.width / Double(cols), h = area.height / Double(rowsCount)
                for (i, row) in rows.enumerated() {
                    let col = i % cols, r = i / cols
                    applied.append((row, NSRect(x: area.minX + Double(col) * w, y: area.maxY - Double(r + 1) * h, width: w, height: h)))
                }
            } else {
                let w = max(900, area.width * 0.7), h = max(600, area.height * 0.7)
                for (i, row) in rows.enumerated() {
                    let step = 32.0 * Double(i)
                    applied.append((row, NSRect(x: area.minX + 24 + step, y: area.maxY - h - 24 - step, width: w, height: h)))
                }
            }
        }
        for (row, frame) in applied { row.window.setFrame(frame, display: true, animate: false) }
        activity.record(client: client, did: "arranged the windows")
        return ["arranged": applied.map { ["window_id": $0.0.id, "frame": Self.topLeftFrame($0.1)] as [String: Any] }]
    }

    private func reloadEditor(ref: String?, windowId: String?) throws -> Any {
        let c: EditorWebController
        if let windowId {
            guard let found = registry.controller(id: windowId) else { throw AppToolError("No editor window \(windowId). list_windows shows the window ids.") }
            c = found
        } else {
            c = try controller(for: ref)
        }
        c.load()
        return ["reloading": name(of: c), "note": "The editor page reloads and restores the document from its last save (Debug > Reload Editor). Wait a second before the next document tool call."]
    }

    private func openSettings(tab: String?, client: String?) throws -> Any {
        if let tab {
            guard let t = SettingsTab(rawValue: tab) else { throw AppToolError("\"tab\" must be one of \(SettingsTab.allCases.map(\.rawValue).joined(separator: ", ")).") }
            SettingsRouter.shared.tab = t
        }
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        NSApp.activate()
        activity.record(client: client, did: "opened Settings")
        return ["shown": true, "tab": SettingsRouter.shared.tab.rawValue]
    }

    // MARK: Settings-adjacent

    private func verifyIsolation() async -> Any {
        guard !isolation.unconfined else {
            return ["mode": "unconfined", "note": "The sidebar agent runs unconfined (Settings > Agent), so there is no sandbox to verify. Only the person can turn confinement back on."]
        }
        await isolation.verify()
        if let probes = isolation.probes {
            return ["mode": "sandboxed", "ok": probes.allSatisfy(\.ok), "probes": probes.map { ["label": $0.label, "ok": $0.ok, "detail": $0.detail] as [String: Any] }]
        }
        return ["mode": "sandboxed", "error": isolation.lastError ?? "The check could not run. Open the sidebar once so the agent service starts, then try again."]
    }

    private func checkForUpdates() async -> Any {
        let probe = await updates.probe()
        var out: [String: Any] = ["status": probe.status.rawValue, "current": probe.current]
        if let latest = probe.latest { out["latest"] = latest }
        if let notes = probe.notes { out["notes"] = notes }
        if let reason = probe.reason { out["reason"] = reason }
        if probe.status == .available { out["next"] = "Tell the person: Ocelot menu > Check for Updates… downloads and installs it. Agents never install updates." }
        return out
    }

    private func mcpConfig(client kind: String, ref: String?) throws -> Any {
        guard let client = MCPClientKind(rawValue: kind) else { throw AppToolError("\"client\" must be one of \(MCPClientKind.allCases.map(\.rawValue).joined(separator: ", ")).") }
        var project: RunProject?
        if let ref { let c = try controller(for: ref); project = c.session.runProject(windowId: c.id) }
        let text = MCPClientConfig.render(client, command: CLIInstaller().commandForConfigs, project: project?.id, projectName: project?.name)
        return ["client": kind, "config": text, "note": "stdio through the ocelot CLI: no token is involved. The HTTP form with a bearer token is only in Settings > MCP."]
    }

    // MARK: Quit

    private func quit(save: Bool, client: String?) async throws -> Any {
        let sessions = registry.all
        let unsaved = sessions.filter { $0.session.hasUnsavedEdits }
        if !unsaved.isEmpty, !save {
            throw AppToolError("Not quitting: \(unsaved.map { "\"\(name(of: $0))\"" }.joined(separator: ", ")) \(unsaved.count == 1 ? "has" : "have") unsaved changes. Call save_project (or save_project_as for an untitled one) for each, or quit_app with save: true to save them and quit.")
        }
        var saved: [String] = []
        var recovery: [String] = []
        for c in unsaved {
            if c.session.fileURL != nil {
                await c.session.save()
                if let error = c.session.lastError { throw AppToolError("Not quitting: \(error)") }
                saved.append(name(of: c))
            } else {
                await c.session.flushPendingAutosave()
                recovery.append(name(of: c))
            }
        }
        activity.record(client: client, did: "is quitting Ocelot")
        // Everything is written: quit without the delegate's second flush (its `.terminateLater` waits for a main-actor job that
        // could never run while this one is inside `terminate`). The reply leaves first; the app exits right after it.
        AppDelegate.documentsFlushedForQuit = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            MainActor.assumeIsolated { NSApp.terminate(nil) }
        }
        var out: [String: Any] = ["quitting": true, "saved": saved, "note": "The next tool call starts Ocelot again."]
        if !recovery.isEmpty { out["kept_in_recovery"] = recovery; out["recovery_note"] = "Untitled projects have no file: they stay in crash recovery and come back at the next launch (save_project_as would have given them a place)." }
        return out
    }
}
