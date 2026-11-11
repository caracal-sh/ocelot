import Foundation

/// `ocelot asset models|list|generate`: the image tools of the MCP server from a shell.
/// Generation runs in the host (the app or a headless host); no credentials pass through the CLI.
enum AssetCommand: Subcommand {
    static let name = "asset"
    static let summary = "List image models and assets, generate images into a project"
    static let usage = """
    Usage:
      ocelot asset models   [--project <id|name>] [--json]
      ocelot asset list     [--project <id|name>] [--query <text>] [--kind generated|edited|background_removed|upload] [--unused] [--limit <n>] [--json]
      ocelot asset generate <prompt> [--project <id|name>] [--model <id>] [--aspect 16:9] [--n 1-4] [--background auto|transparent|opaque]
                             [--quality low|medium|high] [--seed <n>] [--into <node>] [--parent <node> [--width <px>] [--height <px>] [--index <n>]]
                             [--reference <asset-or-node>] [--out <dir>] [--json]
      ocelot asset import   <image file> [--project <id|name>] [--name <text>] [--into <node> | --parent <node> [--width <px>] [--height <px>] [--index <n>]] [--json]
      ocelot asset remove-bg [--node <id> | --asset <id>] [--provider auto|on-device|fal|omp] [--crop] [--no-apply] [--project <id|name>] [--out <dir>] [--json]

    models:   the image models available now (omp, Codex, fal.ai), their capabilities and what is missing to set up.
    list:     the images stored in the project, newest first, with how many layers use each.
    generate: makes an image with the default (or given) model and stores it in the project's assets (<project>.ocelot/assets/).
              --into <node> puts it into that layer (an image layer's src, or a frame's background); --parent <node> inserts a new
              image layer into that frame. Without either it is only stored. The preview is saved as a PNG in --out (default: temp dir).
    import:   stores an image file from disk as an "upload" asset (the Assets panel's Upload image): logos, photos, screenshots
              (PNG, JPEG, WebP, GIF, AVIF, SVG up to 25 MB). The CLI reads the file and sends it to the project (the tool itself takes base64).
    remove-bg: cuts the subject out of an image layer (--node; its image is replaced, one undo step) or a stored asset (--asset; stored only). --provider auto tries on-device (Apple Vision, Mac app: free, private, offline), then fal, then omp.
              --crop trims to the subject. --no-apply stores the cutout without changing the layer.
    Takes 5-120 s. The key for fal.ai lives in the app's settings (Assets > Providers) or the FAL_KEY variable of a headless host.
    Examples:
      ocelot asset generate "isometric office, soft pastel palette, no text" --aspect 16:9 --project pricing --parent n_hero
      ocelot asset list --query office --project pricing
    """

    static func run(_ args: [String]) throws -> Int32 {
        let options: Set<String> = Target.valueOptions.union(["--query", "--kind", "--limit", "--model", "--aspect", "--n", "--background", "--quality", "--seed", "--into", "--parent", "--width", "--height", "--index", "--reference", "--out", "--node", "--asset", "--provider", "--name"])
        let parsed = try Args(args, valueOptions: options, flags: ["--json", "--unused", "--crop", "--no-apply"])
        guard let action = parsed.positionals.first else {
            throw CLIError(message: "Say what to do: ocelot asset models | list | generate <prompt> | import <file> | remove-bg. Run `ocelot asset --help`.", code: 2)
        }
        let rest = Array(parsed.positionals.dropFirst())
        let tool: String
        var arguments: [String: Any] = [:]
        switch action {
        case "models":
            guard rest.isEmpty else { throw CLIError(message: "ocelot asset models takes no arguments.", code: 2) }
            tool = "list_image_models"
        case "list":
            guard rest.isEmpty else { throw CLIError(message: "ocelot asset list takes only options (--query, --kind, --unused, --limit).", code: 2) }
            tool = "list_assets"
            if let q = parsed.value("--query") { arguments["query"] = q }
            if let kind = parsed.value("--kind") { arguments["kind"] = kind }
            if parsed.flag("--unused") { arguments["unused"] = true }
            if let limit = parsed.value("--limit") { arguments["limit"] = try integer(limit, "--limit") }
        case "generate":
            guard rest.count == 1, !rest[0].trimmingCharacters(in: .whitespaces).isEmpty else {
                throw CLIError(message: "Give the prompt as one quoted argument: ocelot asset generate \"a lighthouse at dusk, watercolor\".", code: 2)
            }
            tool = "generate_image"
            arguments["prompt"] = rest[0]
            arguments["wait"] = true // a script wants the image in the same call, not a job id
            if let v = parsed.value("--model") { arguments["model"] = v }
            if let v = parsed.value("--aspect") { arguments["aspect"] = v }
            if let v = parsed.value("--n") { arguments["n"] = try integer(v, "--n") }
            if let v = parsed.value("--background") { arguments["background"] = v }
            if let v = parsed.value("--quality") { arguments["quality"] = v }
            if let v = parsed.value("--seed") { arguments["seed"] = try integer(v, "--seed") }
            if let v = parsed.value("--reference") { arguments["references"] = [v] }
            if let into = parsed.value("--into") {
                if parsed.value("--parent") != nil { throw CLIError(message: "Use either --into <node> or --parent <node>, not both.", code: 2) }
                arguments["into_node"] = into
            } else if let parent = parsed.value("--parent") {
                var placement: [String: Any] = ["parent_id": parent]
                if let v = parsed.value("--width") { placement["width"] = try integer(v, "--width") }
                if let v = parsed.value("--height") { placement["height"] = try integer(v, "--height") }
                if let v = parsed.value("--index") { placement["index"] = try integer(v, "--index") }
                arguments["new_image"] = placement
            }
        case "import":
            guard rest.count == 1 else { throw CLIError(message: "Give one image file: ocelot asset import ~/Brand/logo.png [--parent <node>].", code: 2) }
            tool = "import_image"
            let file = URL(fileURLWithPath: (rest[0] as NSString).expandingTildeInPath)
            guard let data = try? Data(contentsOf: file) else { throw CLIError(message: "Could not read \(rest[0]). Check the path.", code: 2) }
            let mimes = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif", "avif": "image/avif", "svg": "image/svg+xml"]
            arguments["data_base64"] = data.base64EncodedString()
            if let mime = mimes[file.pathExtension.lowercased()] { arguments["mime_type"] = mime }
            arguments["name"] = parsed.value("--name") ?? file.deletingPathExtension().lastPathComponent
            if let into = parsed.value("--into") {
                if parsed.value("--parent") != nil { throw CLIError(message: "Use either --into <node> or --parent <node>, not both.", code: 2) }
                arguments["into_node"] = into
            } else if let parent = parsed.value("--parent") {
                var placement: [String: Any] = ["parent_id": parent]
                if let v = parsed.value("--width") { placement["width"] = try integer(v, "--width") }
                if let v = parsed.value("--height") { placement["height"] = try integer(v, "--height") }
                if let v = parsed.value("--index") { placement["index"] = try integer(v, "--index") }
                arguments["new_image"] = placement
            }
        case "remove-bg":
            guard rest.isEmpty else { throw CLIError(message: "ocelot asset remove-bg takes only options (--node or --asset).", code: 2) }
            tool = "remove_background"
            switch (parsed.value("--node"), parsed.value("--asset")) {
            case (let node?, nil): arguments["node_id"] = node
            case (nil, let asset?): arguments["asset_id"] = asset
            default: throw CLIError(message: "Give the source: --node <image layer id> or --asset <asset id> (see `ocelot asset list`).", code: 2)
            }
            if let v = parsed.value("--provider") { arguments["provider"] = v }
            if parsed.flag("--crop") { arguments["crop_to_subject"] = true }
            if parsed.flag("--no-apply") { arguments["apply"] = false }
            arguments["wait"] = true
        default:
            throw CLIError(message: "Unknown asset command \"\(action)\". Use: models, list, generate, import or remove-bg.", code: 2)
        }

        let target = Target(parsed)
        let resolver = Resolver()
        let connection = MCPConnection(endpoint: try resolver.ensure(target), reconnect: { try resolver.ensure(target) })
        defer { connection.close() }
        let result = try connection.callTool(tool, arguments: arguments)
        return try CallCommand.render(result, json: parsed.flag("--json"), outDirectory: parsed.value("--out"), name: "asset-\(action)")
    }

    private static func integer(_ text: String, _ option: String) throws -> Int {
        guard let n = Int(text) else { throw CLIError(message: "\(option) takes a whole number, got \"\(text)\".", code: 2) }
        return n
    }
}
