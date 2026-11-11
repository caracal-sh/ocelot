import XCTest
@testable import Ocelot

final class CodexImageProviderTests: XCTestCase {
    /// A real `codex exec --json` stream (codex-cli on the development machine, 2026-11-09). Only the huge
    /// `aggregated_output` of the skill-file read was shortened; ids are verbatim, the home directory is neutralised.
    static let recordedStream = """
    {"type":"thread.started","thread_id":"01a1bee7-29b5-7a73-851a-223cb96b1c7f"}
    {"type":"turn.started"}
    {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’m using the imagegen skill to create the icon."}}
    {"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'cat /Users/designer/.codex/skills/.system/imagegen/SKILL.md'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
    {"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'cat /Users/designer/.codex/skills/.system/imagegen/SKILL.md'","aggregated_output":"---\\nname: \\"imagegen\\"\\ndescription: \\"Generate or edit raster i…","exit_code":0,"status":"completed"}}
    {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"/Users/designer/.codex/generated_images/01a1bee7-29b5-7a73-851a-223cb96b1c7f/exec-b15ed2f1-15e4-4cf3-be30-6ae344a28743.png"}}
    {"type":"turn.completed","usage":{"input_tokens":105916,"cached_input_tokens":65280,"cache_write_input_tokens":0,"output_tokens":248,"reasoning_output_tokens":0}}
    """

    private var dir: URL!

    override func setUpWithError() throws { dir = try makeTempDirectory() }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    // MARK: JSONL parsing

    func testParsesTheRecordedEventStream() {
        var stream = CodexEventStream()
        var events: [CodexEventStream.Event] = []
        for line in Self.recordedStream.split(separator: "\n") {
            if let event = stream.feed(String(line)) { events.append(event) }
        }
        XCTAssertEqual(stream.threadId, "01a1bee7-29b5-7a73-851a-223cb96b1c7f")
        XCTAssertTrue(stream.completed)
        XCTAssertNil(stream.failure)
        XCTAssertEqual(stream.messages.count, 2)
        XCTAssertEqual(stream.messages.last, "/Users/designer/.codex/generated_images/01a1bee7-29b5-7a73-851a-223cb96b1c7f/exec-b15ed2f1-15e4-4cf3-be30-6ae344a28743.png")
        XCTAssertEqual(events.first, .threadStarted("01a1bee7-29b5-7a73-851a-223cb96b1c7f"))
        XCTAssertEqual(events.last, .completed)
    }

    func testIgnoresGarbageAndRecordsFailures() {
        var stream = CodexEventStream()
        XCTAssertNil(stream.feed("Reading additional input from stdin..."))
        XCTAssertNil(stream.feed("{not json"))
        XCTAssertNil(stream.feed(#"{"type":"item.completed","item":{"type":"command_execution"}}"#))
        XCTAssertEqual(stream.feed(#"{"type":"turn.failed","error":{"message":"You've hit your usage limit"}}"#), .failed("You've hit your usage limit"))
        XCTAssertEqual(stream.failure, "You've hit your usage limit")
        XCTAssertFalse(stream.completed)
        XCTAssertTrue(CodexImageProvider.failureMessage(stream: stream, stderr: "", status: 1).contains("usage limit"))
        var auth = CodexEventStream()
        auth.feed(#"{"type":"error","message":"401 Unauthorized: please log in"}"#)
        XCTAssertTrue(CodexImageProvider.failureMessage(stream: auth, stderr: "", status: 1).contains("codex login"))
    }

    func testLocatesTheImageByThreadDirectoryOnly() throws {
        let thread = dir.appendingPathComponent("generated_images/thread-1", isDirectory: true)
        try FileManager.default.createDirectory(at: thread, withIntermediateDirectories: true)
        let older = thread.appendingPathComponent("a.png")
        let newer = thread.appendingPathComponent("b.png")
        try TestImages.png().write(to: older)
        try TestImages.png(red: 1).write(to: newer)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -60)], ofItemAtPath: older.path)
        let outside = dir.appendingPathComponent("elsewhere.png")
        try TestImages.png().write(to: outside)

        // The reported path wins when it is inside the thread folder.
        XCTAssertEqual(CodexEventStream.locateImage(messages: ["working…", older.path], in: thread)?.lastPathComponent, "a.png")
        // A path outside the folder is never followed; the newest file in the folder is used.
        XCTAssertEqual(CodexEventStream.locateImage(messages: [outside.path], in: thread)?.lastPathComponent, "b.png")
        XCTAssertEqual(CodexEventStream.locateImage(messages: ["no path here"], in: thread)?.lastPathComponent, "b.png")
        XCTAssertNil(CodexEventStream.locateImage(messages: [], in: dir.appendingPathComponent("missing")))
        XCTAssertTrue(CodexImageProvider.isSafeThreadId("01a1bee7-29b5-7a73-851a-223cb96b1c7f"))
        XCTAssertFalse(CodexImageProvider.isSafeThreadId("../../etc"))
    }

    func testPromptFollowsTheTemplate() {
        let base = ImageRequest(operation: .generate, model: "chatgpt-image", prompt: "a flat orange circle icon", aspect: "16:9", size: nil, n: 1, background: "opaque", quality: nil, seed: nil, references: [])
        let text = CodexImageProvider.prompt(for: base)
        XCTAssertTrue(text.hasPrefix("Use your image generation tool to create exactly one image: a flat orange circle icon."), text)
        XCTAssertTrue(text.contains("Aspect ratio 16:9."))
        XCTAssertTrue(text.contains("opaque background"))
        XCTAssertTrue(text.hasSuffix("Reply with only the absolute file path of the image."))
        var edit = base
        edit.operation = .edit
        edit.references = [ImageReference(id: "x", data: Data(), ext: "png", mime: "image/png")]
        XCTAssertTrue(CodexImageProvider.prompt(for: edit).contains("edit the attached image"))
    }

    // MARK: Whole run against a fake `codex`

    /// A shell script standing in for the codex binary: records its arguments, then behaves like the real stream.
    private func fakeCodex(_ body: String) throws -> CodexCLI {
        let script = dir.appendingPathComponent("codex-\(UUID().uuidString)")
        try "#!/bin/sh\n\(body)\n".write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return CodexCLI(path: script.path, environment: ProcessInfo.processInfo.environment)
    }

    private var argsFile: URL { dir.appendingPathComponent("args.txt") }

    private func provider(_ cli: CodexCLI?, timeout: TimeInterval = 30) -> CodexImageProvider {
        CodexImageProvider(locate: { cli }, codexHome: dir.appendingPathComponent("codex-home"), runTimeout: timeout)
    }

    private func request(_ operation: ImageOperation = .generate, n: Int = 1, references: [ImageReference] = []) -> ImageRequest {
        ImageRequest(operation: operation, model: "chatgpt-image", prompt: "an orange circle", aspect: "1:1", size: nil, n: n, background: "auto", quality: nil, seed: nil, references: references)
    }

    private var generatingScript: String {
        let png = TestImages.png(width: 8, height: 8).base64EncodedString()
        return """
        printf '%s\\n' "$@" > '\(argsFile.path)'
        thread="thread-$$-$RANDOM"
        out="$CODEX_HOME/generated_images/$thread"
        mkdir -p "$out"
        echo '\(png)' | base64 -D > "$out/exec-1.png"
        echo "{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"$thread\\"}"
        echo '{"type":"turn.started"}'
        echo "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"id\\":\\"item_0\\",\\"type\\":\\"agent_message\\",\\"text\\":\\"working\\"}}"
        echo "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"id\\":\\"item_1\\",\\"type\\":\\"agent_message\\",\\"text\\":\\"$out/exec-1.png\\"}}"
        echo '{"type":"turn.completed","usage":{}}'
        """
    }

    func testGeneratesFromFakeCodexAndPassesTheDocumentedArguments() async throws {
        let cli = try fakeCodex(generatingScript)
        let updates = UpdateLog()
        let images = try await provider(cli).generate(request(), progress: { updates.add($0) })
        XCTAssertEqual(images.count, 1)
        XCTAssertEqual(ImageSniffer.sniff(images[0].data), ImageSniffer.png)

        let args = try String(contentsOf: argsFile, encoding: .utf8).split(separator: "\n").map(String.init)
        XCTAssertEqual(Array(args.prefix(8)), ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-s", "read-only"])
        XCTAssertEqual(args[8], "-C")
        XCTAssertTrue(args[9].contains("ocelot-codex-"))
        XCTAssertEqual(args[10], "--")
        XCTAssertTrue(args[11].hasPrefix("Use your image generation tool to create exactly one image: an orange circle"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: args[9]), "the scratch directory is removed afterwards")
        XCTAssertTrue(updates.stages.contains("running"))
        // The run's thread folder is cleaned out of codex home.
        let generated = dir.appendingPathComponent("codex-home/generated_images")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: generated.path), [])
    }

    func testReferencesAreWrittenToATempDirectoryAndPassedWithI() async throws {
        let cli = try fakeCodex(generatingScript)
        let refs = [
            ImageReference(id: "r1", data: TestImages.png(red: 1), ext: "png", mime: "image/png"),
            ImageReference(id: "r2", data: TestImages.jpeg(), ext: "jpg", mime: "image/jpeg"),
        ]
        _ = try await provider(cli).generate(request(.edit, references: refs), progress: { _ in })
        let args = try String(contentsOf: argsFile, encoding: .utf8).split(separator: "\n").map(String.init)
        let flags = args.indices.filter { args[$0] == "-i" }
        XCTAssertEqual(flags.count, 2)
        XCTAssertTrue(args[flags[0] + 1].hasSuffix("reference-1.png"))
        XCTAssertTrue(args[flags[1] + 1].hasSuffix("reference-2.jpg"))
        XCTAssertEqual(args[args.count - 2], "--")
        XCTAssertTrue(args.last!.contains("edit the attached images"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: args[flags[0] + 1]), "reference temp files are removed")
    }

    func testMultipleImagesRunSequentially() async throws {
        let cli = try fakeCodex(generatingScript)
        let images = try await provider(cli).generate(request(n: 3), progress: { _ in })
        XCTAssertEqual(images.count, 3)
    }

    func testPartialResultsSurviveALaterFailure() async throws {
        // The first run produces an image; every later run fails.
        let counter = dir.appendingPathComponent("count")
        let script = """
        if [ -f '\(counter.path)' ]; then
          echo '{"type":"turn.failed","error":{"message":"You have hit your usage limit"}}'
          exit 1
        fi
        touch '\(counter.path)'
        \(generatingScript)
        """
        let cli = try fakeCodex(script)
        do {
            _ = try await provider(cli).generate(request(n: 2), progress: { _ in })
            XCTFail("expected a partial failure")
        } catch let partial as ImagePartialResult {
            XCTAssertEqual(partial.images.count, 1)
            XCTAssertTrue(partial.underlying.localizedDescription.contains("usage limit"))
        }
    }

    func testFailureMessagesAreActionable() async throws {
        let notSignedIn = try fakeCodex(#"echo '{"type":"thread.started","thread_id":"t"}'; echo '{"type":"error","message":"401 Unauthorized"}'; exit 1"#)
        do {
            _ = try await provider(notSignedIn).generate(request(), progress: { _ in })
            XCTFail("expected failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("codex login"), error.localizedDescription)
        }

        let noImage = try fakeCodex(#"echo '{"type":"thread.started","thread_id":"empty-thread"}'; echo '{"type":"item.completed","item":{"type":"agent_message","text":"I cannot do that"}}'; echo '{"type":"turn.completed"}'"#)
        do {
            _ = try await provider(noImage).generate(request(), progress: { _ in })
            XCTFail("expected failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("without producing an image"), error.localizedDescription)
            XCTAssertTrue(error.localizedDescription.contains("I cannot do that"))
        }

        do {
            _ = try await provider(nil).generate(request(), progress: { _ in })
            XCTFail("expected failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("brew install codex"), error.localizedDescription)
        }

        do {
            _ = try await provider(noImage).generate(request(.removeBackground), progress: { _ in })
            XCTFail("expected failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("fal:fal-ai/birefnet/v2"))
        }
    }

    func testTimeoutKillsTheProcess() async throws {
        let cli = try fakeCodex("sleep 30")
        do {
            _ = try await provider(cli, timeout: 0.3).generate(request(), progress: { _ in })
            XCTFail("expected a timeout")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("took longer"), error.localizedDescription)
        }
    }

    func testCancellingKillsTheSubprocess() async throws {
        let pidFile = dir.appendingPathComponent("pid")
        let cli = try fakeCodex("echo $$ > '\(pidFile.path)'\nexec sleep 60")
        let codex = provider(cli)
        let imageRequest = request()
        let work = Task { try await codex.generate(imageRequest, progress: { _ in }) }
        try await waitUntil("the subprocess to start") { FileManager.default.fileExists(atPath: pidFile.path) && ((try? String(contentsOf: pidFile, encoding: .utf8)) ?? "").contains("\n") }
        let pid = try XCTUnwrap(Int32(String(contentsOf: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)))
        XCTAssertEqual(kill(pid, 0), 0, "process is alive before cancel")
        let started = Date()
        work.cancel()
        do {
            _ = try await work.value
            XCTFail("expected cancellation")
        } catch is CancellationError {
            // expected
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        try await waitUntil("the process to exit") { kill(pid, 0) != 0 }
    }

    func testStatusReadsCodexLoginStatus() async throws {
        let signedIn = try fakeCodex(#"echo "Logged in using ChatGPT""#)
        let ready = await provider(signedIn).status()
        XCTAssertEqual(ready.status, "ready")
        XCTAssertEqual(ready.models.map(\.id), ["codex:chatgpt-image"])
        XCTAssertTrue(ready.models[0].available)

        let signedOut = try fakeCodex(#"echo "Not logged in" >&2; exit 1"#)
        let needs = await provider(signedOut).status()
        XCTAssertEqual(needs.status, "needs_setup")
        XCTAssertEqual(needs.setup, "Run `codex login` in a terminal.")
        XCTAssertFalse(needs.models[0].available)

        let missing = await provider(nil).status()
        XCTAssertEqual(missing.status, "unavailable")
    }

    /// Against the real `codex` on this machine (spends one ChatGPT image): `TEST_RUNNER_OCELOT_LIVE_CODEX=1`.
    func testLiveCodexRoundTrip() async throws {
        guard ProcessInfo.processInfo.environment["OCELOT_LIVE_CODEX"] == "1" else { throw XCTSkip("set TEST_RUNNER_OCELOT_LIVE_CODEX=1 to run against the real codex") }
        let codex = CodexImageProvider()
        let status = await codex.status()
        XCTAssertEqual(status.status, "ready", status.detail)
        let reference = ImageReference(id: "ref", data: TestImages.png(width: 64, height: 64), ext: "png", mime: "image/png")
        let images = try await codex.generate(request(.edit, references: [reference]), progress: { _ in })
        XCTAssertEqual(images.count, 1)
        XCTAssertEqual(ImageSniffer.sniff(images[0].data), ImageSniffer.png)
    }

    private final class UpdateLog: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [ImageProgressUpdate] = []
        func add(_ u: ImageProgressUpdate) { lock.lock(); all.append(u); lock.unlock() }
        var stages: [String] { lock.lock(); defer { lock.unlock() }; return all.map(\.stage) }
    }
}
