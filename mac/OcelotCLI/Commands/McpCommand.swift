import Foundation

enum McpCommand: Subcommand {
    static let name = "mcp"
    static let summary = "stdio MCP server for agents (what `claude mcp add` runs)"
    static let usage = """
    Usage: ocelot mcp [--project <id|name> | --window <id>] [--instance <name>]

    A stdio MCP server: agents launch it, it answers initialize and tools/list from a built-in manifest even
    when Ocelot is closed, starts the app (and reopens a known project) on the first tool call, and forwards
    calls to the project's pinned endpoint (/mcp/p/<id>). If the app restarts, the next call reconnects.
    Two kinds of tools in one list: app tools (list_projects, open_project, new_project, save_project, close_project,
    windows, settings, check_for_updates, quit_app; served at /mcp/app, they need no open project and start the app)
    and document tools (get_document_info, write_html, ...). Without --project/--window the document tools follow the
    project the agent opened or created last (else the key window of the newest app); with --project they stay on it.
    Set up a client with `ocelot mcp-config <claude|codex|cursor|omp> --project <id>`.
    """

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, valueOptions: Target.valueOptions)
        guard parsed.positionals.isEmpty else { throw CLIError(message: "`ocelot mcp` takes no positional arguments. Did you mean --project \(parsed.positionals[0])?", code: 2) }
        let target = Target(parsed)
        let resolver = Resolver()
        let lock = NSLock()
        let proxy = StdioProxy(target: target, resolve: { opened in
            // Not pinned: the project the agent opened last (open_project / new_project), else the key window.
            try resolver.ensure(opened.map { Target(project: $0, instance: target.instance) } ?? target)
        }, resolveApp: { try resolver.ensureApp(target) }, write: { data in
            lock.lock()
            defer { lock.unlock() }
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        })
        while let line = readLine(strippingNewline: true) { proxy.handle(line: line) }
        proxy.close()
        return 0
    }
}
