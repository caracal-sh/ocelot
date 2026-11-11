import Foundation

/// Everything needed to start one project container.
struct ContainerRunSpec: Sendable, Equatable {
    static let containerPort = 7420
    static let projectMountPath = "/project"
    /// Marks containers Ocelot started, so a stopped leftover can be found and removed.
    static let labelKey = "sh.caracal.ocelot"

    var instance: String
    var containerName: String
    var image: String
    /// Absolute path of the one `.ocelot` package mounted read-write at /project.
    var packagePath: String
    var hostPort: Int
    var cpus: String = "2"
    var memory: String = "2g"
    var idleStopMinutes: Int = 30
    /// File with `OCELOT_PROJECT_TOKEN=<token>`, mode 0600; keeps the token off the process list.
    var envFile: String
}

/// Thin wrapper over the container CLI. Pure argument builders are separate from execution so they can be unit-tested.
struct ContainerRuntime: Sendable {
    var backend: ContainerBackend
    var runner: CommandRunning = ProcessRunner()

    // MARK: Arguments (pure)

    static func runArguments(kind: ContainerRuntimeKind, spec: ContainerRunSpec) throws -> [String] {
        var args = [
            "run", "-d",
            "--name", spec.containerName,
            "--init",
            "--read-only",
            "--tmpfs", "/tmp",
            "--cpus", spec.cpus,
            "--memory", kind == .container ? spec.memory.uppercased() : spec.memory, // Apple documents K/M/G/T/P suffixes
            "--label", "\(ContainerRunSpec.labelKey)=1",
            "--label", "\(ContainerRunSpec.labelKey).instance=\(spec.instance)",
        ]
        // No capabilities (both runtimes document --cap-drop). Docker also gets no-new-privileges and a process cap;
        // Apple `container` has no such flags, but each container is its own VM with its own kernel.
        args += ["--cap-drop", "ALL"]
        if kind == .docker { args += ["--security-opt", "no-new-privileges", "--pids-limit", "512"] }
        args += [
            "--mount", try mountArgument(kind: kind, source: spec.packagePath),
            // Loopback only, on the host side. The container itself listens on 0.0.0.0 inside its own network namespace.
            "-p", "127.0.0.1:\(spec.hostPort):\(ContainerRunSpec.containerPort)",
            "--env-file", spec.envFile,
            "-e", "OCELOT_IDLE_STOP_MIN=\(spec.idleStopMinutes)",
            spec.image,
        ]
        return args
    }

    static func mountArgument(kind: ContainerRuntimeKind, source: String) throws -> String {
        let needsQuoting = source.contains(",") || source.contains("\"")
        if needsQuoting && kind == .container { throw ContainerError.unsupportedPath(source) }
        // Docker parses --mount as CSV: a field containing a comma is wrapped in double quotes, inner quotes doubled.
        let sourceField = needsQuoting ? "\"source=\(source.replacingOccurrences(of: "\"", with: "\"\""))\"" : "source=\(source)"
        return "type=bind,\(sourceField),target=\(ContainerRunSpec.projectMountPath)"
    }

    // MARK: Execution

    func imageExists(_ image: String) throws -> Bool {
        switch backend.kind {
        case .docker:
            return try runner.run(backend.executable, ["image", "inspect", "--format", "{{.Id}}", image], timeout: 20).succeeded
        case .container:
            return try runner.run(backend.executable, ["image", "inspect", image], timeout: 20).succeeded
        }
    }

    /// Starts the container detached; returns its id.
    func start(_ spec: ContainerRunSpec) throws -> String {
        let args = try Self.runArguments(kind: backend.kind, spec: spec)
        let result = try runner.run(backend.executable, args, timeout: 120)
        guard result.succeeded else { throw ContainerError.startFailed(result.summary) }
        let id = result.stdout.split(whereSeparator: \.isNewline).last.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        return id.isEmpty ? spec.containerName : id
    }

    func isRunning(_ nameOrId: String) -> Bool {
        switch backend.kind {
        case .docker:
            let result = try? runner.run(backend.executable, ["inspect", "--format", "{{.State.Running}}", nameOrId], timeout: 20)
            return result?.succeeded == true && result?.stdout.trimmingCharacters(in: .whitespacesAndNewlines) == "true"
        case .container:
            guard let result = try? runner.run(backend.executable, ["inspect", nameOrId], timeout: 20), result.succeeded,
                  let json = try? JSONSerialization.jsonObject(with: Data(result.stdout.utf8))
            else { return false }
            return Self.containsStatus(json, "running")
        }
    }

    /// True if a container (running or stopped) with this name exists.
    func exists(_ nameOrId: String) -> Bool {
        let args = backend.kind == .docker ? ["inspect", "--format", "{{.Id}}", nameOrId] : ["inspect", nameOrId]
        return (try? runner.run(backend.executable, args, timeout: 20))?.succeeded == true
    }

    func logs(_ nameOrId: String, tail: Int = 40) -> String {
        let args = backend.kind == .docker ? ["logs", "--tail", "\(tail)", nameOrId] : ["logs", nameOrId]
        guard let result = try? runner.run(backend.executable, args, timeout: 20) else { return "" }
        let text = result.stdout + result.stderr
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
        return lines.suffix(tail).joined(separator: "\n")
    }

    /// Graceful stop (the host saves the document on SIGTERM), then remove. Missing containers are not an error.
    func stopAndRemove(_ nameOrId: String, graceSeconds: Int = 10) throws {
        if isRunning(nameOrId) {
            let stopArgs = backend.kind == .docker ? ["stop", "-t", "\(graceSeconds)", nameOrId] : ["stop", "--time", "\(graceSeconds)", nameOrId]
            let result = try runner.run(backend.executable, stopArgs, timeout: TimeInterval(graceSeconds + 30))
            if !result.succeeded && isRunning(nameOrId) { throw ContainerError.commandFailed("\(backend.kind.rawValue) stop", result.summary) }
        }
        remove(nameOrId)
    }

    func remove(_ nameOrId: String) {
        guard exists(nameOrId) else { return }
        let args = backend.kind == .docker ? ["rm", "-f", nameOrId] : ["delete", "--force", nameOrId]
        _ = try? runner.run(backend.executable, args, timeout: 60)
    }

    /// Names of stopped Ocelot containers (idle-stopped ones nobody removed). Docker only; Apple `container` leftovers are
    /// found by name when the same project is run again.
    func exitedOcelotContainers() -> [String] {
        guard backend.kind == .docker else { return [] }
        let args = ["ps", "-a", "--filter", "label=\(ContainerRunSpec.labelKey)=1", "--filter", "status=exited", "--format", "{{.Names}}"]
        guard let result = try? runner.run(backend.executable, args, timeout: 20), result.succeeded else { return [] }
        return result.stdout.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// Apple's inspect output shape is not documented in the research; accept `status: "running"` anywhere in the JSON.
    static func containsStatus(_ json: Any, _ status: String) -> Bool {
        if let dict = json as? [String: Any] {
            if let value = dict["status"] as? String, value.lowercased() == status { return true }
            return dict.values.contains { containsStatus($0, status) }
        }
        if let array = json as? [Any] { return array.contains { containsStatus($0, status) } }
        return false
    }
}
