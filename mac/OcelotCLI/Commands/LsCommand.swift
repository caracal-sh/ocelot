import Foundation

enum LsCommand: Subcommand {
    static let name = "ls"
    static let summary = "List open projects (id, name, where, path)"
    static let usage = """
    Usage: ocelot ls [--json] [--instance <name>]

    Lists every project open in a running Ocelot (app, headless host or container), newest host first.
    The id is what `--project` takes everywhere. --json prints an array of
    { id, name, path, windowId, instance, kind, http, url } for scripts.
    """

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, valueOptions: ["--instance"], flags: ["--json"])
        let hosts = Resolver().instances(matching: parsed.value("--instance"))
        var rows: [[String: Any]] = []
        for host in hosts {
            for project in host.projects {
                var row: [String: Any] = [
                    "id": project.id, "name": project.name, "instance": host.instance, "kind": host.kind.rawValue,
                    "http": host.http, "url": host.http + MCPRoute.project(project.id).path,
                ]
                if let path = project.path { row["path"] = path }
                if let window = project.windowId, !window.isEmpty { row["windowId"] = window }
                if let pid = host.pid { row["pid"] = pid }
                rows.append(row)
            }
        }
        if parsed.flag("--json") {
            Console.out(JSON.string(rows, pretty: true))
            return 0
        }
        if hosts.isEmpty {
            Console.out("Ocelot is not running. Start it with `ocelot open <path.ocelot>` (or open the app).")
            return 0
        }
        if rows.isEmpty {
            Console.out("Ocelot is running (\(hosts.map(\.instance).joined(separator: ", "))) but no project is open. Open a document window, or run `ocelot open <path.ocelot>`.")
            return 0
        }
        let table = [["ID", "NAME", "WHERE", "PATH"]] + rows.map { row in
            [row["id"] as! String, row["name"] as! String, "\(row["kind"] as! String) \(row["instance"] as! String)", row["path"] as? String ?? "(untitled)"]
        }
        let widths = (0..<4).map { col in table.map { $0[col].count }.max() ?? 0 }
        for line in table {
            Console.out(zip(line, widths).map { $0.0.padding(toLength: $0.1, withPad: " ", startingAt: 0) }.joined(separator: "  ").trimmingCharacters(in: .whitespaces))
        }
        return 0
    }
}
