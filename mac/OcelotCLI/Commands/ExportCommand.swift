import Foundation

enum ExportCommand: Subcommand {
    static let name = "export"
    static let summary = "Export an artboard as html, react or png"
    static let usage = """
    Usage: ocelot export <html|react|png> [--project <id|name>] [--node <id|artboard name>] [-o <file>] [--scale 1|2]

    html: standalone HTML. react: a React + Tailwind component. png: a screenshot.
    --node defaults to the first artboard (the first one is used, with a note, when there are several).
    -o writes a file; html/react print to stdout without it, png goes to ./<artboard>.png.
    """

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, valueOptions: Target.valueOptions.union(["--node", "--out", "--scale"]), aliases: ["-o": "--out"])
        guard let format = parsed.positionals.first, parsed.positionals.count == 1, ["html", "react", "png"].contains(format) else {
            throw CLIError(message: "Say what to export: ocelot export <html|react|png> --project <id>.", code: 2)
        }
        let target = Target(parsed)
        let resolver = Resolver()
        let connection = MCPConnection(endpoint: try resolver.ensure(target), reconnect: { try resolver.ensure(target) })
        defer { connection.close() }

        let info = try connection.callTool("get_document_info", arguments: [:])
        guard !info.isError, let doc = JSON.object(Data(info.text.utf8)) else { throw CLIError(message: info.text.isEmpty ? "Could not read the document." : info.text) }
        let artboards = doc["artboards"] as? [[String: Any]] ?? []
        let (nodeId, artboardName) = try pick(parsed.value("--node"), artboards: artboards)
        if parsed.value("--node") == nil, artboards.count > 1 {
            Console.err("Note: \(artboards.count) artboards; exporting \"\(artboardName)\". Pass --node <id|name> to choose.")
        }

        var arguments: [String: Any] = ["node_id": nodeId]
        let tool: String
        switch format {
        case "html": tool = "export_html"
        case "react": tool = "export_react"
        default:
            tool = "get_screenshot"
            if let scale = parsed.value("--scale") {
                guard let n = Int(scale), [1, 2].contains(n) else { throw CLIError(message: "--scale must be 1 or 2.", code: 2) }
                arguments["scale"] = n
            }
        }
        let result = try connection.callTool(tool, arguments: arguments)
        if result.isError { throw CLIError(message: result.text) }

        if format == "png" {
            guard let block = result.content.first(where: { $0["type"] as? String == "image" }), let b64 = block["data"] as? String, let data = Data(base64Encoded: b64) else {
                throw CLIError(message: "The screenshot came back without an image.")
            }
            let path = parsed.value("--out") ?? "\(slug(artboardName)).png"
            try data.write(to: URL(fileURLWithPath: (path as NSString).expandingTildeInPath))
            Console.out(path)
        } else if let path = parsed.value("--out") {
            try Data(result.text.utf8).write(to: URL(fileURLWithPath: (path as NSString).expandingTildeInPath))
            Console.out(path)
        } else {
            Console.out(result.text)
        }
        return 0
    }

    static func pick(_ ref: String?, artboards: [[String: Any]]) throws -> (id: String, name: String) {
        guard let first = artboards.first, let firstId = first["id"] as? String else {
            if let ref { return (ref, ref) }
            throw CLIError(message: "The document has no artboards yet. Create one, then export.")
        }
        guard let ref else { return (firstId, first["name"] as? String ?? firstId) }
        if let hit = artboards.first(where: { ($0["id"] as? String) == ref }) { return (ref, hit["name"] as? String ?? ref) }
        let byName = artboards.filter { ($0["name"] as? String)?.lowercased() == ref.lowercased() }
        if byName.count == 1, let id = byName[0]["id"] as? String { return (id, ref) }
        if byName.count > 1 { throw CLIError(message: "More than one artboard is named \"\(ref)\". Use its id: \(byName.compactMap { $0["id"] as? String }.joined(separator: ", ")).", code: 2) }
        return (ref, ref) // an inner node id
    }

    static func slug(_ name: String) -> String { InstanceDirectory.slug(name) }
}
