import Foundation

/// `ocelot stop <project|path>`: stops a container started by `ocelot run` and removes its run-dir entry.
enum StopCommand: Subcommand {
    static let name = "stop"
    static let summary = "Stop a container started by `ocelot run`"
    static let usage = OcelotRunCommands.stopUsage

    static func run(_ args: [String]) throws -> Int32 {
        OcelotRunCommands.stop(args)
    }
}
