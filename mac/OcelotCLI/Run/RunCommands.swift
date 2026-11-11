import Foundation

/// Command-line front end for `ocelot run` and `ocelot stop`. Dispatch: `OcelotRunCommands.run(arguments)` with the
/// arguments after the subcommand name; each returns the process exit status.
enum OcelotRunCommands {
    static let runUsage = """
    Usage: ocelot run <path.ocelot> [--create] [--image REF] [--cpus N] [--memory SIZE]
                       [--idle-stop-min N] [--runtime docker|container] [--direct] [--json]

    Starts the project in a locked-down container (read-only root, only the package mounted,
    MCP published on 127.0.0.1) and prints the config line for Claude Code, Codex and omp.
    Stop it with `ocelot stop <project id|path>`; it also stops itself after 30 idle minutes.
    """

    static let stopUsage = """
    Usage: ocelot stop <project id | path.ocelot | instance | container id> [--runtime docker|container]
           ocelot stop --all
    """

    // MARK: run

    static func run(_ arguments: [String], runner: ContainerRunner = ContainerRunner(), output: RunOutput = .standard) -> Int32 {
        do {
            let options = try parseRun(arguments, environment: ProcessInfo.processInfo.environment)
            let result = try runner.run(options)
            output.out(options.json ? renderJSON(result) : renderHuman(result, direct: options.direct))
            return 0
        } catch let error as ContainerError {
            if case .usage(let text) = error { output.err(text); return 2 }
            output.err("ocelot run: \(error.localizedDescription)")
            return 1
        } catch {
            output.err("ocelot run: \(error.localizedDescription)")
            return 1
        }
    }

    static func parseRun(_ arguments: [String], environment: [String: String]) throws -> RunOptions {
        var options = RunOptions(path: "")
        if let image = environment["OCELOT_CONTAINER_IMAGE"], !image.isEmpty { options.image = image }
        var positional: [String] = []
        var index = 0
        func value(_ flag: String) throws -> String {
            index += 1
            guard index < arguments.count else { throw ContainerError.usage("\(flag) needs a value.\n\(runUsage)") }
            return arguments[index]
        }
        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--create": options.create = true
            case "--direct": options.direct = true
            case "--json": options.json = true
            case "--image": options.image = try value(argument)
            case "--cpus":
                options.cpus = try value(argument)
                guard Double(options.cpus).map({ $0 > 0 }) == true else { throw ContainerError.usage("--cpus takes a positive number, e.g. 2.") }
            case "--memory":
                options.memory = try value(argument)
                guard options.memory.range(of: #"^[1-9][0-9]*[kKmMgG]?$"#, options: .regularExpression) != nil else {
                    throw ContainerError.usage("--memory takes a size such as 2g or 512m.")
                }
            case "--idle-stop-min":
                guard let minutes = Int(try value(argument)), minutes >= 0 else {
                    throw ContainerError.usage("--idle-stop-min takes whole minutes (0 disables idle stop).")
                }
                options.idleStopMinutes = minutes
            case "--runtime":
                guard let kind = ContainerRuntimeKind(rawValue: try value(argument)) else {
                    throw ContainerError.usage("--runtime is docker or container.")
                }
                options.runtime = kind
            case "-h", "--help": throw ContainerError.usage(runUsage)
            default:
                if argument.hasPrefix("-") { throw ContainerError.usage("Unknown option \(argument).\n\(runUsage)") }
                positional.append(argument)
            }
            index += 1
        }
        guard positional.count == 1 else { throw ContainerError.usage(runUsage) }
        options.path = positional[0]
        return options
    }

    /// `command` is what stdio configs launch (see `CLICommand`).
    static func renderHuman(_ r: RunResult, direct: Bool, command: String = CLICommand.forRunningTool()) -> String {
        let useFrontDoor = !direct && r.frontDoorURL != nil
        let url = useFrontDoor ? r.frontDoorURL! : r.directURL
        let token = useFrontDoor ? (r.frontDoorToken ?? r.token) : r.token
        let tokenFile: String? = useFrontDoor ? r.frontDoorTokenFile : r.tokenFile
        var lines = [
            "\"\(r.projectName)\" is running in container \(r.containerName) (\(r.runtime.rawValue), \(r.image)).",
            "  project id   \(r.projectId)",
            "  package      \(r.packagePath) (mounted read-write at /project; nothing else is visible to the container)",
            "  container    \(r.directURL)   (loopback only; token in \(r.tokenFile))",
        ]
        if let front = r.frontDoorURL { lines.append("  front door   \(front)   (the Ocelot app proxies to the container)") }
        else { lines.append("  front door   Ocelot app not running; the container endpoint works on its own. With the app open, /mcp/p/\(r.projectId) serves it too.") }
        lines += connectLines(projectId: r.projectId, projectName: r.projectName, url: url, token: token, tokenFile: tokenFile, command: command,
                              httpVia: useFrontDoor ? "through the Ocelot app" : "straight to the container")
        lines += [
            "",
            "Stop: ocelot stop \(r.projectId)" + (r.idleStopMinutes > 0 ? "   (stops by itself after \(r.idleStopMinutes) min without MCP calls)" : ""),
        ]
        return lines.joined(separator: "\n")
    }

    /// The "connect an agent" block shared by `ocelot run` and `ocelot serve`: stdio shim configs first, HTTP as the alternative.
    static func connectLines(projectId: String, projectName: String, url: String, token: String, tokenFile: String?, command: String, httpVia: String) -> [String] {
        let http = HTTPClientConfig(name: MCPClientConfig.serverName(projectName: projectName), url: url, token: token, tokenFile: tokenFile)
        func stdio(_ kind: MCPClientKind) -> [String] {
            MCPClientConfig.render(kind, command: command, project: projectId, projectName: projectName)
                .split(separator: "\n").map { "    \($0)" }
        }
        var lines = ["", "Connect an agent. These launch `ocelot mcp`, which finds the project wherever it runs:", "", "  Claude Code"]
        lines += stdio(.claude)
        lines += ["", "  Codex"] + stdio(.codex)
        lines += ["", "  omp"] + stdio(.omp)
        lines += ["", "Or over HTTP (\(httpVia)), for clients without a stdio option:", "", "  Claude Code", "    \(http.claudeCode)", "", "  Codex (add to ~/.codex/config.toml)"]
        lines += http.codex.split(separator: "\n").map { "    \($0)" }
        lines += ["", "  omp (.omp/mcp.json, or ~/.omp/agent/mcp.json)"]
        lines += http.omp.split(separator: "\n").map { "    \($0)" }
        return lines
    }

    static func renderJSON(_ r: RunResult) -> String {
        var object: [String: Any] = [
            "instance": r.instance, "container": r.containerName, "containerId": r.containerId, "runtime": r.runtime.rawValue,
            "image": r.image, "projectId": r.projectId, "name": r.projectName, "path": r.packagePath,
            "url": r.directURL, "token": r.token, "tokenFile": r.tokenFile, "idleStopMinutes": r.idleStopMinutes,
        ]
        if let front = r.frontDoorURL { object["frontDoorUrl"] = front }
        if let token = r.frontDoorToken { object["frontDoorToken"] = token }
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: stop

    static func stop(_ arguments: [String], runner: ContainerRunner = ContainerRunner(), output: RunOutput = .standard) -> Int32 {
        var targets: [String] = []
        var all = false
        var runtime: ContainerRuntimeKind?
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--all": all = true
            case "--runtime":
                index += 1
                guard index < arguments.count, let kind = ContainerRuntimeKind(rawValue: arguments[index]) else {
                    output.err("--runtime is docker or container.\n\(stopUsage)")
                    return 2
                }
                runtime = kind
            case "-h", "--help":
                output.err(stopUsage)
                return 2
            default: targets.append(arguments[index])
            }
            index += 1
        }
        guard all == targets.isEmpty else {
            output.err(stopUsage)
            return 2
        }
        do {
            let stopped = all ? try runner.stopAll(runtimeOverride: runtime) : try targets.flatMap { try runner.stop(target: $0, runtimeOverride: runtime) }
            if stopped.isEmpty { output.out("No Ocelot containers were running.") }
            for entry in stopped {
                let name = entry.projects.first?.name ?? entry.instance
                output.out("Stopped \"\(name)\" (\(entry.instance)); the package on disk holds the saved document.")
            }
            return 0
        } catch {
            output.err("ocelot stop: \(error.localizedDescription)")
            return 1
        }
    }
}

/// Injectable output so tests can capture what the commands print.
struct RunOutput: Sendable {
    var out: @Sendable (String) -> Void
    var err: @Sendable (String) -> Void

    static let standard = RunOutput(
        out: { FileHandle.standardOutput.write(Data(($0 + "\n").utf8)) },
        err: { FileHandle.standardError.write(Data(($0 + "\n").utf8)) }
    )
}
