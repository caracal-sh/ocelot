import Foundation

/// The user's Codex CLI install.
struct CodexCLI: Sendable {
    let path: String
    let environment: [String: String]

    /// A GUI app starts with a minimal PATH: ask the login shell, then try the usual install directories.
    /// `OCELOT_CODEX_PATH` wins. Blocking (spawns a shell): call off the main actor.
    static func locate() -> CodexCLI? {
        let env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var path = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        var candidates: [String] = []
        if let explicit = env["OCELOT_CODEX_PATH"], !explicit.isEmpty { candidates.append(explicit) }

        let shell = env["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        let marker = "__OCELOT__"
        if let probe = shellProbe(shell, #"printf '\#(marker)%s\n\#(marker)%s\n' "$PATH" "$(command -v codex)""#, env: env) {
            let values = probe.split(separator: "\n").filter { $0.hasPrefix(marker) }.map { String($0.dropFirst(marker.count)) }
            if values.count == 2 {
                if !values[0].isEmpty { path = values[0] }
                if values[1].hasPrefix("/") { candidates.append(values[1]) }
            }
        }
        candidates += [
            "/opt/homebrew/bin/codex", "/usr/local/bin/codex",
            "\(home)/.bun/bin/codex", "\(home)/.local/bin/codex",
        ]
        guard let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { return nil }
        var environment = env
        let dir = (found as NSString).deletingLastPathComponent
        environment["PATH"] = ([dir] + path.split(separator: ":").map(String.init) + ["/opt/homebrew/bin", "/usr/local/bin"])
            .reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
            .joined(separator: ":")
        return CodexCLI(path: found, environment: environment)
    }

    private static func shellProbe(_ shell: String, _ script: String, env: [String: String]) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-l", "-i", "-c", script]
        p.environment = env
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: killer)
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        killer.cancel()
        return p.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
    }
}

/// Finds Codex once and remembers it; a failed check forgets it so installing it later works without a restart.
actor CodexLocator {
    static let shared = CodexLocator()
    private var cached: CodexCLI?

    func cli() async -> CodexCLI? {
        if let cached { return cached }
        let found = await Task.detached { CodexCLI.locate() }.value
        cached = found
        return found
    }

    func forget() { cached = nil }
}

/// `codex exec --json` events, one JSON object per line.
struct CodexEventStream: Sendable {
    enum Event: Sendable, Equatable {
        case threadStarted(String)
        case message(String)
        case completed
        case failed(String)
    }

    private(set) var threadId: String?
    /// Every `agent_message` text, in order. The last one is the image path.
    private(set) var messages: [String] = []
    private(set) var failure: String?
    private(set) var completed = false

    @discardableResult
    mutating func feed(_ line: String) -> Event? {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String
        else { return nil }
        switch type {
        case "thread.started":
            guard let id = object["thread_id"] as? String else { return nil }
            threadId = id
            return .threadStarted(id)
        case "item.completed":
            guard let item = object["item"] as? [String: Any], item["type"] as? String == "agent_message",
                  let text = item["text"] as? String
            else { return nil }
            messages.append(text)
            return .message(text)
        case "turn.completed":
            completed = true
            return .completed
        case "turn.failed":
            let message = ((object["error"] as? [String: Any])?["message"] as? String) ?? "the turn failed"
            failure = message
            return .failed(message)
        case "error":
            guard let message = object["message"] as? String else { return nil }
            failure = message
            return .failed(message)
        default:
            return nil
        }
    }

    /// The image file the run produced: the path the final message names when it lies inside the thread's
    /// output folder, else the newest image file in that folder. Never looks anywhere else.
    static func locateImage(messages: [String], in threadDirectory: URL) -> URL? {
        let fm = FileManager.default
        let base = threadDirectory.standardizedFileURL.resolvingSymlinksInPath().path + "/"
        for text in messages.reversed() {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.hasPrefix("/") else { continue }
            let candidate = URL(fileURLWithPath: trimmed).standardizedFileURL.resolvingSymlinksInPath()
            if candidate.path.hasPrefix(base), fm.fileExists(atPath: candidate.path) { return candidate }
        }
        let files = (try? fm.contentsOfDirectory(at: threadDirectory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        return files
            .filter { ["png", "jpg", "jpeg", "webp"].contains($0.pathExtension.lowercased()) }
            .max { a, b in
                let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return da < db
            }
    }
}

/// ChatGPT-subscription image generation through `codex exec` (the stable `image_generation` feature).
/// One image per run; n > 1 runs sequentially. The image lands in `<codex home>/generated_images/<thread id>/`.
struct CodexImageProvider: ImageProvider {
    let id = "codex"
    let label = "Codex (ChatGPT subscription)"
    static let modelId = "chatgpt-image"

    let locate: @Sendable () async -> CodexCLI?
    let codexHome: URL
    /// Per-image time limit.
    let runTimeout: TimeInterval

    init(
        locate: @escaping @Sendable () async -> CodexCLI? = { await CodexLocator.shared.cli() },
        codexHome: URL? = nil,
        runTimeout: TimeInterval = 300
    ) {
        self.locate = locate
        self.codexHome = codexHome
            ?? ProcessInfo.processInfo.environment["CODEX_HOME"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex", isDirectory: true)
        self.runTimeout = runTimeout
    }

    // MARK: Status

    private var model: ImageModelInfo {
        ImageModelInfo(
            id: "codex:\(Self.modelId)", provider: "codex", model: Self.modelId, label: "ChatGPT Image (Codex)",
            capabilities: ["generate", "edit", "references"], aspects: ImageAspects.all, maxN: 4,
            cost: "Included in your ChatGPT plan",
            note: "About 30 s per image, one image per run. Aspect is a prompt instruction; no mask, seed or real transparency.",
            available: true, unavailableReason: nil
        )
    }

    func status() async -> ImageProviderInfo {
        guard let cli = await locate() else {
            await CodexLocator.shared.forget()
            return info("unavailable", "The Codex CLI is not installed.", setup: "Install Codex (`brew install codex`), then run `codex login`.", unavailable: "Codex is not installed.")
        }
        let output = Output()
        let config = StreamingProcess.Config(executable: cli.path, arguments: ["login", "status"], environment: cli.environment, directory: nil, timeout: 15)
        let result = try? await StreamingProcess.run(config) { output.append($0) }
        let text = (output.text + " " + (result?.stderr ?? "")).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.contains("Logged in using ChatGPT") {
            return ImageProviderInfo(id: id, label: label, status: "ready", detail: "Signed in to Codex with ChatGPT.", models: [model], keyStored: nil, setup: nil)
        }
        if text.contains("Logged in") {
            return info("needs_setup", "Codex is signed in without a ChatGPT account.", setup: "Run `codex login` and choose ChatGPT.", unavailable: "Codex needs the ChatGPT login.")
        }
        return info("needs_setup", "Codex is not signed in.", setup: "Run `codex login` in a terminal.", unavailable: "Codex is not signed in.")
    }

    private func info(_ status: String, _ detail: String, setup: String, unavailable: String) -> ImageProviderInfo {
        var m = model
        m.available = false
        m.unavailableReason = unavailable
        return ImageProviderInfo(id: id, label: label, status: status, detail: detail, models: [m], keyStored: nil, setup: setup)
    }

    private final class Output: @unchecked Sendable {
        private let lock = NSLock()
        private var lines: [String] = []
        func append(_ line: String) { lock.lock(); lines.append(line); lock.unlock() }
        var text: String { lock.lock(); defer { lock.unlock() }; return lines.joined(separator: " ") }
    }

    // MARK: Generate

    func warnings(for request: ImageRequest) -> [String] {
        var notes: [String] = []
        if request.aspect != nil || request.size != nil { notes.append("Codex takes the aspect ratio as a prompt instruction; the exact size is up to the model.") }
        if request.quality != nil { notes.append("Codex has no quality setting; it was ignored.") }
        return notes
    }

    func generate(_ request: ImageRequest, progress: @escaping ImageProgressHandler) async throws -> [GeneratedImage] {
        guard request.operation != .removeBackground else {
            throw ImageFailure("Codex cannot remove backgrounds. Use fal:fal-ai/birefnet/v2 (list_image_models shows models with the remove_background capability).")
        }
        guard let cli = await locate() else {
            await CodexLocator.shared.forget()
            throw ImageFailure("The Codex CLI was not found. Install it (`brew install codex`) and run `codex login`, or set OCELOT_CODEX_PATH.")
        }
        var images: [GeneratedImage] = []
        for index in 0..<request.n {
            let label = request.n > 1 ? "image \(index + 1) of \(request.n)" : "the image"
            do {
                try Task.checkCancellation()
                let image = try await runOnce(request, cli: cli, label: label, fraction: Double(index) / Double(request.n), progress: progress)
                images.append(image)
            } catch {
                if images.isEmpty { throw error }
                throw ImagePartialResult(images: images, underlying: error)
            }
        }
        return images
    }

    private func runOnce(_ request: ImageRequest, cli: CodexCLI, label: String, fraction: Double, progress: @escaping ImageProgressHandler) async throws -> GeneratedImage {
        let fm = FileManager.default
        let scratch = fm.temporaryDirectory.appendingPathComponent("ocelot-codex-\(UUID().uuidString)", isDirectory: true)
        let work = scratch.appendingPathComponent("work", isDirectory: true)
        let refs = scratch.appendingPathComponent("refs", isDirectory: true)
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        try fm.createDirectory(at: refs, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: scratch) }

        var arguments = [
            "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
            "-s", "read-only", "-C", work.path,
        ]
        for (i, reference) in request.references.enumerated() {
            let file = refs.appendingPathComponent("reference-\(i + 1).\(reference.ext)")
            try reference.data.write(to: file)
            arguments += ["-i", file.path]
        }
        // `-i` takes several values, so the prompt goes after `--`.
        arguments += ["--", Self.prompt(for: request)]

        var environment = cli.environment
        environment["CODEX_HOME"] = codexHome.path
        let config = StreamingProcess.Config(executable: cli.path, arguments: arguments, environment: environment, directory: work, timeout: runTimeout)

        progress(ImageProgressUpdate(stage: "queued", message: "Starting Codex for \(label)…", fraction: fraction))
        let events = EventBox()
        let result = try await StreamingProcess.run(config) { line in
            if case .threadStarted = events.feed(line) {
                progress(ImageProgressUpdate(stage: "running", message: "Codex is generating \(label) (about 30 s)…", fraction: fraction))
            }
        }
        let stream = events.snapshot
        if result.timedOut {
            throw ImageFailure("Codex took longer than \(Int(runTimeout / 60)) minutes and was stopped. Try again, or use a faster model (list_image_models).")
        }
        guard result.status == 0 || stream.completed else {
            let raw = Self.rawFailure(stream: stream, stderr: result.stderr, status: result.status)
            throw ImageFailure(
                Self.failureMessage(stream: stream, stderr: result.stderr, status: result.status),
                credentialRejected: Self.isSignInFailure(raw)
            )
        }
        guard let thread = stream.threadId, Self.isSafeThreadId(thread) else {
            throw ImageFailure("Codex finished without reporting a session id, so its image could not be located. Update Codex (`brew upgrade codex`) and try again.")
        }
        let threadDirectory = codexHome.appendingPathComponent("generated_images", isDirectory: true).appendingPathComponent(thread, isDirectory: true)
        progress(ImageProgressUpdate(stage: "downloading", message: "Reading the generated image…", fraction: nil))
        guard let file = CodexEventStream.locateImage(messages: stream.messages, in: threadDirectory) else {
            let reply = (stream.messages.last ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let said = reply.isEmpty ? "" : " Codex said: \(String(reply.prefix(200)))"
            throw ImageFailure("Codex finished without producing an image.\(said) Make the prompt more explicit about the image, or try again.")
        }
        let data = try Data(contentsOf: file)
        guard let kind = ImageSniffer.sniff(data), kind != ImageSniffer.svg else {
            throw ImageFailure("Codex produced a file that is not an image. Try again.")
        }
        // The folder belongs to this run (its thread id is unique): drop it so images do not pile up in ~/.codex.
        try? fm.removeItem(at: threadDirectory)
        var image = GeneratedImage(data: data)
        image.params["codexThread"] = .string(thread)
        return image
    }

    private final class EventBox: @unchecked Sendable {
        private let lock = NSLock()
        private var stream = CodexEventStream()
        func feed(_ line: String) -> CodexEventStream.Event? {
            lock.lock()
            defer { lock.unlock() }
            return stream.feed(line)
        }
        var snapshot: CodexEventStream { lock.lock(); defer { lock.unlock() }; return stream }
    }

    static func isSafeThreadId(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 80 && id.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }

    private static func rawFailure(stream: CodexEventStream, stderr: String, status: Int32) -> String {
        stream.failure ?? stderr.split(separator: "\n").last.map(String.init) ?? "exit status \(status)"
    }

    /// Codex says it is not (or no longer) signed in.
    static func isSignInFailure(_ raw: String) -> Bool {
        let lower = raw.lowercased()
        return lower.contains("log in") || lower.contains("login") || lower.contains("unauthorized") || lower.contains("401") || lower.contains("not signed in")
    }

    /// The failure text for a run that exited non-zero.
    static func failureMessage(stream: CodexEventStream, stderr: String, status: Int32) -> String {
        let raw = rawFailure(stream: stream, stderr: stderr, status: status)
        let lower = raw.lowercased()
        if isSignInFailure(raw) {
            return "Codex is not signed in (\(String(raw.prefix(160)))). Run `codex login` in a terminal and choose ChatGPT."
        }
        if lower.contains("usage limit") || lower.contains("rate limit") || lower.contains("429") {
            return "Codex reports a usage limit (\(String(raw.prefix(160)))). Wait for the limit to reset, or pick another model (list_image_models)."
        }
        return "Codex failed: \(String(raw.prefix(240))). Run `codex login status`, then try again."
    }

    /// The instruction sent to Codex. It names the image tool explicitly and asks for the bare path back.
    static func prompt(for request: ImageRequest) -> String {
        let aspect: String
        if let ratio = request.aspect {
            aspect = "Aspect ratio \(ratio)."
        } else if let size = request.size {
            aspect = "Aspect ratio \(size.width):\(size.height) (about \(size.width)×\(size.height) pixels)."
        } else {
            aspect = "Pick the aspect ratio that suits the subject."
        }
        let background: String
        switch request.background {
        case "transparent":
            background = "Isolate the subject on a plain, flat, uniform white background so it can be cut out afterwards"
        case "opaque":
            background = "Fill the whole canvas with an opaque background"
        default:
            background = "Choose the background that suits the subject"
        }
        let lead: String
        if request.references.isEmpty {
            lead = "Use your image generation tool to create exactly one image: \(request.prompt)."
        } else if request.operation == .edit {
            lead = "Use your image generation tool to edit the attached image\(request.references.count > 1 ? "s" : ""), producing exactly one new image: \(request.prompt)."
        } else {
            lead = "Use your image generation tool to create exactly one image, using the attached image\(request.references.count > 1 ? "s" : "") as references: \(request.prompt)."
        }
        return "\(lead) \(aspect) \(background). Reply with only the absolute file path of the image."
    }
}
