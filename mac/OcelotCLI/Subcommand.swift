import Foundation

/// One `ocelot <name>` subcommand.
///
/// To add a command: create a type conforming to `Subcommand` (see `Commands/`) and list it in
/// `SubcommandRegistry.all`. `run` receives the arguments after the command name and returns the exit status;
/// throw `CLIError` for failures (the message must say what to do next). `--help` is handled by the caller.
protocol Subcommand: Sendable {
    static var name: String { get }
    /// One line for `ocelot help`.
    static var summary: String { get }
    /// Full text for `ocelot <name> --help`.
    static var usage: String { get }
    static func run(_ args: [String]) throws -> Int32
}

enum SubcommandRegistry {
    /// Order = order in `ocelot help`.
    static let all: [any Subcommand.Type] = [
        LsCommand.self,
        OpenCommand.self,
        ProjectsCommand.self,
        NewCommand.self,
        SaveCommand.self,
        CloseCommand.self,
        SettingsCommand.self,
        QuitCommand.self,
        TokenCommand.self,
        McpCommand.self,
        McpConfigCommand.self,
        CallCommand.self,
        ExportCommand.self,
        HandoffCommand.self,
        AssetCommand.self,
        ServeCommand.self,
        RunCommand.self,
        StopCommand.self,
    ]

    static func find(_ name: String) -> (any Subcommand.Type)? { all.first { $0.name == name } }

    static var help: String {
        let width = (all.map { $0.name.count }.max() ?? 8) + 2
        let lines = all.map { "  " + $0.name.padding(toLength: width, withPad: " ", startingAt: 0) + $0.summary }
        return """
        ocelot \(CLIInfo.version): command-line access to Ocelot projects (and the MCP server agents use)

        Usage: ocelot <command> [options]

        Commands:
        \(lines.joined(separator: "\n"))
          help        Show this help, or `ocelot help <command>`

        App tools (projects, new, save, close, settings, quit) run against the app, not a project: `ocelot call <app tool>` reaches
        the rest (list_windows, focus_window, check_for_updates, ...). Agents get the same through `ocelot mcp`.

        Project selection (ls, call, export, mcp, mcp-config, token new, save, close):
          --project <id|name>   a project by id, id prefix, name or slug (see `ocelot ls`)
          --window <id>         a window by id
          --instance <name>     a specific host (e.g. app, app-debug, headless-123, a container); default: the newest app

        Environment: OCELOT_RUN_DIR (discovery directory), OCELOT_APP (Ocelot.app to auto-launch).
        """
    }
}

enum CLIInfo {
    /// The MCP server version from the generated tool manifest.
    static var version: String {
        ((ToolManifestData.initialize["serverInfo"] as? [String: Any])?["version"] as? String) ?? "0.1.0"
    }
}
