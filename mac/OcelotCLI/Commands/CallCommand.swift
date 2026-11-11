import Foundation

enum CallCommand: Subcommand {
    static let name = "call"
    static let summary = "Call one MCP tool and print the result"
    static let usage = """
    Usage: ocelot call <tool> ['<json arguments>'] [--project <id|name> | --window <id>] [--json] [--out <dir>]

    One-shot tool call, like an agent would make it (starts the app if needed). App tools (list_projects, open_project,
    new_project, list_windows, get_app_settings, ...) need no project; document tools work on --project (default: the key window). Text results go to stdout;
    images are saved as PNG files (in --out, default the temp directory) and their paths are printed.
    --json prints the raw tool result. Exit status 1 when the tool reports an error.
    Examples:
      ocelot call get_document_info --project pricing
      ocelot call get_screenshot '{"node_id":"n_abc","scale":2}' --project pricing --out ./shots
    """

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, valueOptions: Target.valueOptions.union(["--out"]), flags: ["--json"])
        guard let tool = parsed.positionals.first, parsed.positionals.count <= 2 else {
            throw CLIError(message: "Usage: ocelot call <tool> ['<json arguments>']. Tool names: \(ToolManifestData.tools.compactMap { $0["name"] as? String }.joined(separator: ", ")).", code: 2)
        }
        let isApp = AppToolData.hasTool(tool)
        guard isApp || ToolManifestData.hasTool(tool) else {
            throw CLIError(message: "Unknown tool \"\(tool)\". Known tools: \((ToolManifestData.tools + AppToolData.tools).compactMap { $0["name"] as? String }.joined(separator: ", ")).", code: 2)
        }
        var arguments: [String: Any] = [:]
        if parsed.positionals.count == 2 {
            guard let object = JSON.object(Data(parsed.positionals[1].utf8)) else {
                throw CLIError(message: "The arguments must be a JSON object, e.g. '{\"node_id\":\"n_abc\"}'. Got: \(parsed.positionals[1])", code: 2)
            }
            arguments = object
        }
        let target = Target(parsed)
        let resolver = Resolver()
        let connection = isApp
            ? MCPConnection(endpoint: try resolver.ensureApp(target), reconnect: { try resolver.ensureApp(target) })
            : MCPConnection(endpoint: try resolver.ensure(target), reconnect: { try resolver.ensure(target) })
        defer { connection.close() }
        let result = try connection.callTool(tool, arguments: arguments)
        return try render(result, json: parsed.flag("--json"), outDirectory: parsed.value("--out"), name: tool)
    }

    static func render(_ result: MCPConnection.ToolResult, json: Bool, outDirectory: String?, name: String) throws -> Int32 {
        if json {
            Console.out(JSON.string(["isError": result.isError, "content": result.content], pretty: true))
            return result.isError ? 1 : 0
        }
        var lines: [String] = []
        var imageIndex = 0
        for block in result.content {
            switch block["type"] as? String {
            case "text": lines.append(block["text"] as? String ?? "")
            case "image":
                guard let b64 = block["data"] as? String, let data = Data(base64Encoded: b64) else { continue }
                imageIndex += 1
                let ext = (block["mimeType"] as? String)?.hasSuffix("jpeg") == true ? "jpg" : "png"
                let url = try imageURL(directory: outDirectory, name: name, index: imageIndex, ext: ext)
                try data.write(to: url)
                lines.append("[image saved: \(url.path)]")
            default: break
            }
        }
        let text = lines.joined(separator: "\n")
        if result.isError { Console.err(text) } else { Console.out(text) }
        return result.isError ? 1 : 0
    }

    static func imageURL(directory: String?, name: String, index: Int, ext: String) throws -> URL {
        let dir = directory.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath, isDirectory: true) } ?? FileManager.default.temporaryDirectory
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        return dir.appendingPathComponent("ocelot-\(name)-\(stamp)-\(index).\(ext)")
    }
}
