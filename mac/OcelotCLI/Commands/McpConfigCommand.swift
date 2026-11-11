import Foundation

enum McpConfigCommand: Subcommand {
    static let name = "mcp-config"
    static let summary = "Print (or install) the MCP config for claude, codex, cursor or omp"
    static let usage = """
    Usage: ocelot mcp-config <claude|codex|cursor|omp> [--project <id|name> | --window <id>] [--install]

    Prints the stdio config that makes the client run `ocelot mcp`. With --project it is pinned to that
    project (by id, so renaming it does not break the config); without, it follows the key window.
    --install (claude only): runs `claude mcp add` for you; it needs the `claude` CLI on PATH.
    """

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, valueOptions: Target.valueOptions, flags: ["--install"])
        guard let clientName = parsed.positionals.first, parsed.positionals.count == 1, let client = MCPClientKind(rawValue: clientName) else {
            throw CLIError(message: "Say which client: ocelot mcp-config <\(MCPClientKind.allCases.map(\.rawValue).joined(separator: "|"))>.", code: 2)
        }
        let target = Target(parsed)
        var projectId: String?, projectName: String?
        if let ref = target.project {
            let resolver = Resolver()
            if let hit = (try? resolver.find(Target(project: ref, instance: target.instance)))?.project {
                (projectId, projectName) = (hit.id, hit.name)
            } else if let entry = resolver.knownEntry(matching: ref) {
                (projectId, projectName) = (entry.id, entry.name)
            } else {
                // Not open and never seen: keep what the user typed (an id from another machine's config, say).
                (projectId, projectName) = (ref, nil)
                Console.err("Note: no project matches \"\(ref)\" right now; the config uses it as typed. `ocelot ls` shows open projects.")
            }
        }
        let command = CLICommand.forRunningTool()
        if parsed.flag("--install") {
            guard client == .claude else { throw CLIError(message: "--install only supports claude. Paste the config above into \(client.displayName)'s settings.", code: 2) }
            return try installClaude(command: command, project: projectId, projectName: projectName, window: target.window)
        }
        Console.out(MCPClientConfig.render(client, command: command, project: projectId, projectName: projectName, window: target.window))
        return 0
    }

    private static func installClaude(command: String, project: String?, projectName: String?, window: String?) throws -> Int32 {
        guard let claude = findExecutable("claude") else {
            throw CLIError(message: "The `claude` CLI is not on PATH. Install Claude Code, or run the printed command yourself.")
        }
        var args = ["mcp", "add", MCPClientConfig.serverName(projectName: projectName), "--", command, "mcp"]
        if let project { args += ["--project", project] }
        if let window { args += ["--window", window] }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: claude)
        process.arguments = args
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }

    static func findExecutable(_ name: String, path: String = ProcessInfo.processInfo.environment["PATH"] ?? "") -> String? {
        for dir in path.split(separator: ":") {
            let candidate = String(dir) + "/" + name
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }
}
