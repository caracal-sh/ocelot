import Foundation

/// `ocelot run <path.ocelot>`: a project in a locked-down container. Logic and tests live in `Run/` (Foundation-only).
enum RunCommand: Subcommand {
    static let name = "run"
    static let summary = "Run a project in a container (Docker or Apple container); prints the MCP config"
    static let usage = OcelotRunCommands.runUsage

    static func run(_ args: [String]) throws -> Int32 {
        OcelotRunCommands.run(args)
    }
}
