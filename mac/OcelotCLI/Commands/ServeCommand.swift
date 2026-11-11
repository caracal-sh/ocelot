import Foundation

/// `ocelot serve <path.ocelot>`: a headless host (Node + Chromium) for one project, in the foreground.
enum ServeCommand: Subcommand {
    static let name = "serve"
    static let summary = "Serve a project headless (Node + Chromium), without the Mac app"
    static let usage = OcelotServeCommand.usage

    static func run(_ args: [String]) throws -> Int32 {
        OcelotServeCommand.run(args)
    }
}
