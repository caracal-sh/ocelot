import Foundation

enum TokenCommand: Subcommand {
    static let name = "token"
    static let summary = "Print the master token, rotate it, or mint a scoped token"
    static let usage = """
    Usage: ocelot token [--instance <name>] [--json]
           ocelot token --regenerate [--instance <name>]
           ocelot token new --project <id|name> [--read-only] [--ttl 1h] [--instance <name>] [--json]
           ocelot token new --window <id> [--read-only] [--ttl 1h]

    Without arguments: prints the master token of the newest app (a 0600 file in the run directory,
    ~/Library/Application Support/Ocelot/run/<instance>.token). Treat it like a password: it reaches every project.
    --regenerate: replaces the master token; HTTP clients configured with the old one must be updated
      (clients that run `ocelot mcp` are not affected).
    new: mints a token limited to one project (or window), optionally read-only and expiring. It is kept in
      the app's memory (gone after a restart) and works at the printed URL only. Give this to an agent or CI
      job instead of the master token. Prints the token (and with --json also its URL).
    """

    static func run(_ args: [String]) throws -> Int32 {
        let parsed = try Args(args, valueOptions: Target.valueOptions.union(["--ttl"]), flags: ["--json", "--regenerate", "--read-only"])
        let resolver = Resolver()
        switch parsed.positionals.first {
        case nil:
            if parsed.flag("--regenerate") { return try regenerate(parsed, resolver) }
            return try printMaster(parsed, resolver)
        case "new":
            return try mint(parsed, resolver)
        case let other?:
            throw CLIError(message: "Unknown token subcommand \"\(other)\". Use `ocelot token`, `ocelot token --regenerate` or `ocelot token new --project <id>`.", code: 2)
        }
    }

    private static func printMaster(_ args: Args, _ resolver: Resolver) throws -> Int32 {
        let selector = Target(instance: args.value("--instance")).instance
        let host = resolver.instances(matching: selector).first(where: { $0.kind == .app }) ?? resolver.instances(matching: selector).first
        let instance = host?.instance ?? selector ?? MCPServiceNames.defaultApp(resolver.directory)
        guard let instance, let token = resolver.directory.readToken(instance: instance) else {
            throw CLIError(message: "No token found in \(resolver.directory.url.path). Start Ocelot (it writes <instance>.token there), or pass --instance.")
        }
        if args.flag("--json") {
            var object: [String: Any] = ["instance": instance, "token": token]
            if let host { object["http"] = host.http }
            Console.out(JSON.string(object))
        } else {
            Console.out(token)
        }
        return 0
    }

    private static func regenerate(_ args: Args, _ resolver: Resolver) throws -> Int32 {
        guard let host = admin(resolver, instance: args.value("--instance")) else {
            throw CLIError(message: "Ocelot is not running, so there is nothing to rotate. Start it first, or delete the token file to get a fresh one at next launch.")
        }
        let reply = try post(host, "/ocelot/v1/token/regenerate", [:])
        guard let token = reply["token"] as? String else { throw CLIError(message: "The host did not return a new token.") }
        if host.instance.kind != .app {
            // `ocelot serve` and container hosts run without discovery, so nothing else updates `<instance>.token`;
            // left stale, every CLI, stdio-proxy and front-door call would answer 401 until the host restarts.
            do { try resolver.directory.writeToken(token, instance: host.instance.instance) } catch {
                throw CLIError(message: "The host now uses a new token but \(resolver.directory.tokenURL(host.instance.instance).path) could not be updated (\(error.localizedDescription)). Write this token into that file: \(token)")
            }
        }
        Console.err("Master token replaced. HTTP clients configured with the old token need the new one; `ocelot mcp` clients keep working.")
        Console.out(token)
        return 0
    }

    private static func mint(_ args: Args, _ resolver: Resolver) throws -> Int32 {
        let target = Target(args)
        guard target.project != nil || target.window != nil else {
            throw CLIError(message: "Say what the token is for: `ocelot token new --project <id|name>` (see `ocelot ls`) or --window <id>.", code: 2)
        }
        let scope: String, id: String
        if let ref = target.project {
            // Resolve names to ids on whichever host has the project, but mint at the app when there is one (it is the front door).
            guard let endpoint = try resolver.find(Target(project: ref, instance: target.instance)), let project = endpoint.project else {
                throw resolver.notFound(Target(project: ref))
            }
            (scope, id) = ("project", project.id)
        } else {
            (scope, id) = ("window", target.window!)
        }
        guard let host = admin(resolver, instance: target.instance) else {
            throw CLIError(message: "Ocelot is not running. Scoped tokens live in the host's memory: start Ocelot (or `ocelot serve`) first.")
        }
        var body: [String: Any] = ["scope": scope, "id": id, "readOnly": args.flag("--read-only")]
        if let ttl = args.value("--ttl") { body["ttlSeconds"] = try tokenTTL(ttl) }
        let reply = try post(host, "/ocelot/v1/tokens", body)
        guard let token = reply["token"] as? String else { throw CLIError(message: "The host did not return a token.") }
        if args.flag("--json") {
            Console.out(JSON.string(reply, pretty: true))
        } else {
            Console.err("Token for \(scope) \(id)\(args.flag("--read-only") ? " (read-only)" : "")\(args.value("--ttl").map { ", expires in \($0)" } ?? ""). Use it as a Bearer token at \(reply["url"] as? String ?? "the printed URL").")
            Console.out(token)
        }
        return 0
    }

    static let maxTTLSeconds = 365 * 86400

    /// `--ttl` as whole seconds in 1...31536000 (what the hosts accept); a larger finite value like `1e30` must
    /// be refused here, because converting it to `Int` would trap.
    static func tokenTTL(_ text: String) throws -> Int {
        let seconds = try parseDuration(text)
        guard seconds >= 1, seconds <= Double(maxTTLSeconds) else {
            throw CLIError(message: "--ttl \"\(text)\" is out of range. Use between 1s and 365d (for example 1h or 7d).", code: 2)
        }
        return Int(seconds)
    }

    /// The host that mints tokens: the newest app, else the selected/newest instance.
    private static func admin(_ resolver: Resolver, instance: String?) -> Endpoint? {
        let hosts = resolver.instances(matching: instance)
        guard let host = hosts.first(where: { $0.kind == .app }) ?? hosts.first,
              let token = resolver.directory.readToken(instance: host.instance) else { return nil }
        return Endpoint(instance: host, token: token, route: .keyWindow, project: nil)
    }

    private static func post(_ host: Endpoint, _ path: String, _ body: [String: Any]) throws -> [String: Any] {
        let reply: HTTPReply
        do {
            reply = try HTTP.request("POST", URL(string: host.instance.http + path)!, headers: ["Authorization": "Bearer \(host.token)", "Content-Type": "application/json"], body: JSON.encode(body), timeout: 15)
        } catch let failure as ConnectionFailure {
            throw CLIError(message: "Could not reach \(host.instance.instance) at \(host.instance.http): \(failure.message).")
        }
        let object = JSON.object(reply.body) ?? [:]
        if reply.status != 200 {
            throw CLIError(message: MCPConnection.rpcMessage(reply.body) ?? "\(host.instance.instance) answered HTTP \(reply.status) for \(path). Update the host (this feature needs a current Ocelot).")
        }
        return object
    }
}

enum MCPServiceNames {
    /// With nothing running: the app instance whose token file exists (Debug first when both are there).
    static func defaultApp(_ directory: InstanceDirectory) -> String? {
        ["app", "app-debug"].first { directory.readToken(instance: $0) != nil }
    }
}
