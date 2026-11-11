import Foundation

enum OpenCommand: Subcommand {
    static let name = "open"
    static let summary = "Open a .ocelot (or legacy .atelier) package, or a known project id, in the app"
    static let usage = """
    Usage: ocelot open <path.ocelot | project id | name> [--background] [--timeout <seconds>] [--json]

    Opens the project in Ocelot (starting the app if needed) and prints its id once it is open.
    A project that is already open is reused, not opened twice. With an id or name, the project must be one
    Ocelot has opened before (it remembers saved projects in ~/Library/Application Support/Ocelot/projects.json).
    --background opens without bringing Ocelot to the front.
    """

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, valueOptions: ["--timeout"], flags: ["--json", "--background"])
        guard let ref = parsed.positionals.first, parsed.positionals.count == 1 else {
            throw CLIError(message: "Pass one path, id or name. Usage: ocelot open <path.ocelot | project id>", code: 2)
        }
        let resolver = Resolver()
        var path: String?
        if FileManager.default.fileExists(atPath: (ref as NSString).expandingTildeInPath) {
            let url = URL(fileURLWithPath: (ref as NSString).expandingTildeInPath).standardizedFileURL.resolvingSymlinksInPath()
            guard DocumentExtension.matches(url) else { throw CLIError(message: "\(ref) is not an Ocelot package (expected a folder ending in .ocelot, or .atelier for documents saved by earlier releases).", code: 2) }
            guard FileManager.default.fileExists(atPath: url.appendingPathComponent("document.json").path) else {
                throw CLIError(message: "\(ref) is not an Ocelot package (no document.json inside).", code: 2)
            }
            path = url.path
        } else if let entry = resolver.knownEntry(matching: ref) {
            path = entry.path
        } else {
            // Maybe it is already open under this id/name.
            if let hit = try resolver.find(Target(project: ref)), let project = hit.project {
                return report(project, json: parsed.flag("--json"))
            }
            throw CLIError(message: "\"\(ref)\" is neither a path nor a project Ocelot knows. Pass the path of a .ocelot package, or run `ocelot ls`.", code: 2)
        }
        guard let path else { return 1 }
        if let existing = openProject(at: path, resolver: resolver) { return report(existing, json: parsed.flag("--json")) }

        try resolver.launcher.launch(path: path, foreground: !parsed.flag("--background"))
        let timeout = parsed.value("--timeout").flatMap(Double.init) ?? resolver.launchTimeout
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let project = openProject(at: path, resolver: resolver) { return report(project, json: parsed.flag("--json")) }
            Thread.sleep(forTimeInterval: 0.2)
        }
        throw CLIError(message: "Ocelot did not report \(ref) as open within \(Int(timeout)) seconds. Check the app for an error dialog; `ocelot ls` shows what is open.")
    }

    static func openProject(at path: String, resolver: Resolver) -> RunProject? {
        let want = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        for host in resolver.instances(matching: nil) {
            if let hit = host.projects.first(where: { $0.path.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path } == want }) { return hit }
        }
        return nil
    }

    private static func report(_ project: RunProject, json: Bool) -> Int32 {
        if json {
            var object: [String: Any] = ["id": project.id, "name": project.name]
            if let path = project.path { object["path"] = path }
            Console.out(JSON.string(object))
        } else {
            Console.out("\(project.id)\t\(project.name)")
        }
        return 0
    }
}
