import Foundation

/// The command client configs run to start the stdio shim (`<command> mcp`). The one decision shared by the app
/// (Settings, copy buttons), `ocelot mcp-config`, `ocelot run` and `ocelot serve`.
enum CLICommand {
    /// `ocelot` when a directory in `searchPath` holds an `ocelot` that is `executable` itself (symlinks resolved):
    /// clients find it by name and the config survives moving the app. Any other `ocelot` on the PATH (another
    /// build, another checkout) does not count. Otherwise the absolute path of `executable`.
    static func forConfigs(executable: URL, searchPath: [String]) -> String {
        let me = executable.resolvingSymlinksInPath().path
        for directory in searchPath {
            let candidate = URL(fileURLWithPath: directory).appendingPathComponent("ocelot")
            if FileManager.default.isExecutableFile(atPath: candidate.path), candidate.resolvingSymlinksInPath().path == me {
                return "ocelot"
            }
        }
        return executable.path
    }

    /// The directories of a `PATH` value, in order.
    static func searchPath(_ path: String?) -> [String] {
        (path ?? "").split(separator: ":").map(String.init)
    }
}

extension CLICommand {
    /// For the `ocelot` process itself (`mcp-config`, `run`, `serve`): this binary against the PATH it was started with.
    static func forRunningTool(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        let me = Bundle.main.executableURL?.resolvingSymlinksInPath()
            ?? URL(fileURLWithPath: CommandLine.arguments.first ?? "ocelot", relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)).standardized
        return forConfigs(executable: me, searchPath: searchPath(environment["PATH"]))
    }
}
