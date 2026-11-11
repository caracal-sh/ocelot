import Foundation

/// Runs one app tool (`/mcp/app`; the app starts if closed, no project needed) for the commands below. They mirror the app
/// tools of editor/src/mcp/appTools.ts so people and scripts reach what agents reach.
enum AppToolRunner {
    static func call(_ tool: String, _ arguments: [String: Any] = [:], target: Target = Target()) throws -> MCPConnection.ToolResult {
        let resolver = Resolver()
        let connection = MCPConnection(endpoint: try resolver.ensureApp(target), reconnect: { try resolver.ensureApp(target) })
        defer { connection.close() }
        return try connection.callTool(tool, arguments: arguments)
    }

    /// The JSON a tool answered with (its first text block), or the error text as a CLIError.
    static func json(_ result: MCPConnection.ToolResult) throws -> [String: Any] {
        if result.isError { throw CLIError(message: result.text) }
        return JSON.object(Data(result.text.utf8)) ?? [:]
    }

    /// `true`, `false`, `null` and numbers become JSON values; anything else stays text.
    static func value(_ raw: String) -> Any {
        switch raw {
        case "true": return true
        case "false": return false
        case "null": return NSNull()
        default: return Int(raw) ?? Double(raw).flatMap { $0.isFinite ? $0 : nil } ?? raw
        }
    }

    static func print(_ result: MCPConnection.ToolResult, json: Bool, name: String) throws -> Int32 {
        try CallCommand.render(result, json: json, outDirectory: nil, name: name)
    }
}

enum ProjectsCommand: Subcommand {
    static let name = "projects"
    static let summary = "List open and recent projects (the app tool list_projects)"
    static let usage = """
    Usage: ocelot projects [--query <text>] [--no-recent] [--json]

    Lists the projects open in Ocelot (id, name, path, unsaved) and the recent documents on disk, so you can
    `ocelot open <id|name|path>` one. Starts the app if it is closed. `ocelot ls` lists only what is open now, from the run directory.
    """

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, valueOptions: ["--query"], flags: ["--json", "--no-recent"])
        var arguments: [String: Any] = [:]
        if let query = parsed.value("--query") { arguments["query"] = query }
        if parsed.flag("--no-recent") { arguments["include_recent"] = false }
        let result = try AppToolRunner.call("list_projects", arguments)
        if parsed.flag("--json") { return try AppToolRunner.print(result, json: true, name: "list_projects") }
        let data = try AppToolRunner.json(result)
        Console.out(render(data))
        return 0
    }

    static func render(_ data: [String: Any]) -> String {
        var lines: [String] = []
        let open = data["open"] as? [[String: Any]] ?? []
        lines.append(open.isEmpty ? "No project is open." : "Open:")
        for p in open {
            let flags = [p["focused"] as? Bool == true ? "front" : nil, p["unsaved"] as? Bool == true ? "unsaved" : nil, p["untitled"] as? Bool == true ? "untitled" : nil].compactMap { $0 }
            lines.append("  \(p["project_id"] as? String ?? "")\t\(p["name"] as? String ?? "")\t\(p["path"] as? String ?? "(untitled)")\(flags.isEmpty ? "" : "  [\(flags.joined(separator: ", "))]")")
        }
        if let recent = data["recent"] as? [[String: Any]] {
            lines.append(recent.isEmpty ? "No recent documents." : "Recent:")
            for p in recent { lines.append("  \(p["name"] as? String ?? "")\t\(p["path"] as? String ?? "")\(p["open"] as? Bool == true ? "  [open]" : "")") }
        }
        for p in data["other_hosts"] as? [[String: Any]] ?? [] {
            lines.append("  \(p["project_id"] as? String ?? "")\t\(p["name"] as? String ?? "")\t(\(p["kind"] as? String ?? "host") \(p["host"] as? String ?? ""))")
        }
        return lines.joined(separator: "\n")
    }
}

enum NewCommand: Subcommand {
    static let name = "new"
    static let summary = "Create a project, optionally from a prompt (the app tool new_project)"
    static let usage = """
    Usage: ocelot new [<name>] [--prompt <text>] [--attach <file>]... [--kind design|deck|video] [--theme <id>]
                      [--path <file.ocelot>] [--from <project>] [--background] [--json]

    Creates a project in a new editor window (starting Ocelot if needed), like Home's Blank document or, with --prompt,
    like typing the brief on Home: the sidebar agent starts on it. --attach adds an image or text file to the brief
    (repeatable). --kind deck or video makes the first page a presentation or a film; --theme applies a theme before the
    agent starts; --path saves it right away; --from copies an existing project (with --path). Prints the new project id.
    """

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, valueOptions: ["--prompt", "--attach", "--kind", "--theme", "--path", "--from"], flags: ["--json", "--background"])
        guard parsed.positionals.count <= 1 else { throw CLIError(message: "Pass the project name as one argument (quote it). Usage: ocelot new [<name>] [--prompt <text>]", code: 2) }
        return try AppToolRunner.print(try AppToolRunner.call("new_project", try arguments(parsed)), json: parsed.flag("--json"), name: "new_project")
    }

    static func arguments(_ parsed: Args) throws -> [String: Any] {
        var arguments: [String: Any] = [:]
        if let name = parsed.positionals.first { arguments["name"] = name }
        if let prompt = parsed.value("--prompt") { arguments["prompt"] = prompt }
        let files = parsed.all("--attach")
        if !files.isEmpty {
            arguments["attachments"] = try files.map { file -> [String: Any] in
                let path = URL(fileURLWithPath: (file as NSString).expandingTildeInPath).standardizedFileURL.path
                guard FileManager.default.fileExists(atPath: path) else { throw CLIError(message: "\(file) does not exist. Pass the path of an image or text file to attach.", code: 2) }
                return ["path": path]
            }
        }
        for (flag, key) in [("--kind", "kind"), ("--theme", "theme"), ("--from", "from_project")] { if let v = parsed.value(flag) { arguments[key] = v } }
        if let path = parsed.value("--path") { arguments["path"] = (path as NSString).expandingTildeInPath }
        if parsed.flag("--background") { arguments["background"] = true }
        return arguments
    }
}

enum SettingsCommand: Subcommand {
    static let name = "settings"
    static let summary = "Read or change app settings (get_app_settings / set_app_settings)"
    static let usage = """
    Usage: ocelot settings [get] [--json]
           ocelot settings set <key>=<value>... [--json]

    `get` lists every app setting with its value and whether it may be changed. `set` changes the non-security ones,
    for example `ocelot settings set updates.automatic_checks=false images.default_model=fal-ai/flux/dev`
    (true, false, null and numbers are typed; everything else is text). Security settings (agent confinement, MCP port
    and token, the fal key) are shown but refused: change them in Ocelot > Settings.
    """

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, flags: ["--json"])
        let words = parsed.positionals
        if words.isEmpty || words == ["get"] {
            let result = try AppToolRunner.call("get_app_settings")
            if parsed.flag("--json") { return try AppToolRunner.print(result, json: true, name: "get_app_settings") }
            Console.out(render(try AppToolRunner.json(result)))
            return 0
        }
        guard words.first == "set", words.count > 1 else { throw CLIError(message: "Usage: ocelot settings [get] | ocelot settings set <key>=<value>...", code: 2) }
        let result = try AppToolRunner.call("set_app_settings", ["settings": try changes(Array(words.dropFirst()))])
        return try AppToolRunner.print(result, json: parsed.flag("--json"), name: "set_app_settings")
    }

    static func changes(_ pairs: [String]) throws -> [String: Any] {
        var out: [String: Any] = [:]
        for pair in pairs {
            guard let eq = pair.firstIndex(of: "="), eq != pair.startIndex else { throw CLIError(message: "\"\(pair)\" is not key=value. Example: updates.automatic_checks=false", code: 2) }
            out[String(pair[..<eq])] = AppToolRunner.value(String(pair[pair.index(after: eq)...]))
        }
        return out
    }

    static func render(_ data: [String: Any]) -> String {
        (data["settings"] as? [[String: Any]] ?? []).map { row in
            let value = row["value"].map { $0 is NSNull ? "null" : "\($0)" } ?? "null"
            let mode = row["security"] as? Bool == true ? "read-only (security)" : row["writable"] as? Bool == true ? "settable" : "read-only"
            return "\(row["key"] as? String ?? "")\t\(value)\t\(mode)\t\(row["where"] as? String ?? "")"
        }.joined(separator: "\n")
    }
}

/// `ocelot save` / `close` / `quit`: the File menu and Quit as commands.
enum SaveCommand: Subcommand {
    static let name = "save"
    static let summary = "Save a project (File > Save), or save it as a new package with --as"
    static let usage = """
    Usage: ocelot save [--project <id|name>] [--as <path.ocelot>] [--overwrite] [--json]

    Saves the project now (Ocelot also autosaves). An untitled project has no file yet: pass --as to give it one.
    """

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, valueOptions: ["--project", "--as"], flags: ["--json", "--overwrite"])
        var arguments: [String: Any] = [:]
        if let project = parsed.value("--project") { arguments["project"] = project }
        let tool: String
        if let path = parsed.value("--as") {
            tool = "save_project_as"
            arguments["path"] = (path as NSString).expandingTildeInPath
            if parsed.flag("--overwrite") { arguments["overwrite"] = true }
        } else {
            tool = "save_project"
        }
        return try AppToolRunner.print(try AppToolRunner.call(tool, arguments), json: parsed.flag("--json"), name: tool)
    }
}

enum CloseCommand: Subcommand {
    static let name = "close"
    static let summary = "Save and close a project's window"
    static let usage = """
    Usage: ocelot close [--project <id|name>] [--discard] [--json]

    Saves the project, then closes its window. An untitled project with work in it is not closed (`ocelot save --as <path>` first),
    unless you pass --discard to throw it away.
    """

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, valueOptions: ["--project"], flags: ["--json", "--discard"])
        var arguments: [String: Any] = [:]
        if let project = parsed.value("--project") { arguments["project"] = project }
        if parsed.flag("--discard") { arguments["discard"] = true }
        return try AppToolRunner.print(try AppToolRunner.call("close_project", arguments), json: parsed.flag("--json"), name: "close_project")
    }
}

enum QuitCommand: Subcommand {
    static let name = "quit"
    static let summary = "Quit the Ocelot app (refused while projects have unsaved changes)"
    static let usage = """
    Usage: ocelot quit [--save] [--json]

    Quits the app. Refused while a project has unsaved changes unless --save, which saves them first.
    Does not start the app: with nothing running it says so.
    """

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, flags: ["--json", "--save"])
        let resolver = Resolver()
        guard try resolver.findApp(Target()) != nil else { Console.out("Ocelot is not running."); return 0 }
        return try AppToolRunner.print(try AppToolRunner.call("quit_app", parsed.flag("--save") ? ["save": true] : [:]), json: parsed.flag("--json"), name: "quit_app")
    }
}
