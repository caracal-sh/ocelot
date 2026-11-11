import Foundation

/// `ocelot handoff`: the brief a coding agent needs to implement the design. A thin client of the `get_handoff` tool: it prints the
/// prompt, or with `--out` writes the handoff folder the tool returns (`files: true`), so the editor stays the one place that builds it.
enum HandoffCommand: Subcommand {
    static let name = "handoff"
    static let summary = "Print the prompt that hands the design to a coding agent, or write the handoff folder"
    static let usage = """
    Usage: ocelot handoff [--project <id|name> | --window <id>] [--scope selection|page|document] [--page <id>] [--node <id>]... [--out <dir>] [--json]

    Prints the prompt for a coding agent: the screens (ids, sizes, routes), the flows, the design system, the Ocelot tools to call in order
    and the constraints. Paste it into Claude Code, Codex or Cursor, or pipe it: `ocelot handoff --project pricing | pbcopy`.
    --scope     selection, page or document. Default: --node ids mean selection, --page means page, else the selection in the app, else the document.
    --node      an artboard or layer id; repeat it, or separate ids with commas.
    --out <dir> writes the handoff folder instead: HANDOFF.md, README.md, flows.json, screens/*.png (2x), code/ (React + Tailwind),
                prototype/ (linked HTML) and design-system/ (the shadcn registry, with a design system). Files at the same paths are replaced.
    --json      prints the brief as JSON (screens, flows, design_system, steps, constraints) instead of the prompt.
    Examples:
      ocelot handoff --project pricing --scope document
      ocelot handoff --project pricing --node n_abc --out ./handoff
    """

    static let scopes = ["selection", "page", "document"]

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, valueOptions: Target.valueOptions.union(["--scope", "--page", "--node", "--out"]), flags: ["--json"])
        guard parsed.positionals.isEmpty else {
            throw CLIError(message: "ocelot handoff takes options only (got \"\(parsed.positionals[0])\"). Run `ocelot handoff --help`.", code: 2)
        }
        let out = parsed.value("--out").map { ($0 as NSString).expandingTildeInPath }
        let arguments = try toolArguments(scope: parsed.value("--scope"), page: parsed.value("--page"), nodes: parsed.all("--node"), files: out != nil)

        let target = Target(parsed)
        let resolver = Resolver()
        let connection = MCPConnection(endpoint: try resolver.ensure(target), reconnect: { try resolver.ensure(target) })
        defer { connection.close() }
        let result = try connection.callTool("get_handoff", arguments: arguments)
        if result.isError { throw CLIError(message: result.text.isEmpty ? "get_handoff failed." : result.text) }
        let blocks = result.content.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }
        guard blocks.count >= 2, let brief = JSON.object(Data(blocks[0].utf8)) else {
            throw CLIError(message: "Ocelot answered get_handoff in an unexpected shape. Update Ocelot and the ocelot command so they match.")
        }

        if let out {
            guard let folder = brief["folder"] as? [String: Any], let files = folder["files"] as? [[String: Any]] else {
                throw CLIError(message: "Ocelot's answer had no folder. Update Ocelot and the ocelot command so they match.")
            }
            let written = try write(files: files, into: URL(fileURLWithPath: out, isDirectory: true))
            for warning in folder["warnings"] as? [String] ?? [] { Console.err("Note: \(warning)") }
            Console.out(written.path)
            Console.err("Wrote \(files.count) files. Open the folder in your coding agent and say: read HANDOFF.md.")
        } else if parsed.flag("--json") {
            Console.out(blocks[0])
        } else {
            Console.out(blocks[1])
        }
        return 0
    }

    /// The `get_handoff` arguments for the command-line options.
    static func toolArguments(scope: String?, page: String?, nodes: [String], files: Bool) throws -> [String: Any] {
        var arguments: [String: Any] = [:]
        if let scope {
            guard scopes.contains(scope) else {
                throw CLIError(message: "--scope must be one of \(scopes.joined(separator: ", ")), got \"\(scope)\".", code: 2)
            }
            arguments["scope"] = scope
        }
        if let page { arguments["page_id"] = page }
        let ids = nodes.flatMap { $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } }.filter { !$0.isEmpty }
        if !ids.isEmpty { arguments["node_ids"] = ids }
        if files { arguments["files"] = true }
        return arguments
    }

    /// Writes the files below `folder` (created if needed) and returns it. Every path is checked first: nothing is written when one
    /// is absolute or climbs out of the folder.
    @discardableResult
    static func write(files: [[String: Any]], into folder: URL) throws -> URL {
        var planned: [(URL, Data)] = []
        let root = folder.standardizedFileURL
        for file in files {
            guard let path = file["path"] as? String, !path.isEmpty, !path.hasPrefix("/"), !path.hasPrefix("~"), !path.contains("\\"), !path.contains("\0"),
                  !path.split(separator: "/", omittingEmptySubsequences: true).contains("..")
            else {
                throw CLIError(message: "Ocelot sent a file path that is not inside the folder: \"\(file["path"] as? String ?? "")\". Nothing was written.")
            }
            let data: Data
            if let text = file["text"] as? String {
                data = Data(text.utf8)
            } else if let encoded = file["base64"] as? String, let bytes = Data(base64Encoded: encoded) {
                data = bytes
            } else {
                throw CLIError(message: "Ocelot sent \"\(path)\" without its content. Nothing was written.")
            }
            let target = root.appendingPathComponent(path).standardizedFileURL
            guard target.path.hasPrefix(root.path + "/") else {
                throw CLIError(message: "Ocelot sent a file path that leaves the folder: \"\(path)\". Nothing was written.")
            }
            planned.append((target, data))
        }
        let fm = FileManager.default
        do {
            for (target, data) in planned {
                try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: target)
            }
        } catch {
            throw CLIError(message: "Could not write the handoff folder \(root.path): \(error.localizedDescription). Choose another --out folder.")
        }
        return root
    }
}
