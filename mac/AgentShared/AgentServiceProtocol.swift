import Foundation

/// XPC contract between the app and the sandboxed agent service (Contents/XPCServices/sh.caracal.ocelot.AgentService.xpc).
/// The service knows exactly one command line (`omp --mode rpc …`, built by `AgentLaunch`); the app
/// cannot make it run anything else. Payloads are JSON `Data` so the interface needs no secure-coding classes.
@objc protocol OcelotAgentServiceProtocol {
    /// Writes the session files into the service's own container, puts `sessionFiles` (the conversation's omp session as an
    /// `AgentSessionArchive`, empty for a new conversation) into the process's private scratch, and starts omp on it.
    /// `reply(nil)` on success, else an actionable message.
    func start(_ request: Data, sessionFiles: Data, reply: @escaping @Sendable (String?) -> Void)
    /// One newline-terminated JSON RPC line for omp's stdin (the app has already checked its allowlist).
    func send(sessionId: String, line: Data)
    /// Closes omp's stdin (it drains and exits), then terminates it after a grace period.
    func stop(sessionId: String)
    /// The session files omp has written so far in this process's private scratch, as an `AgentSessionArchive`
    /// (nil when the scratch is gone). Works for a running process and for one that exited but was not discarded yet.
    func snapshot(sessionId: String, reply: @escaping @Sendable (Data?) -> Void)
    /// Deletes the process's scratch once the app has stored the final copy. Ignored while omp still runs.
    func discard(sessionId: String)
    /// Scratch copies of processes that are not running: what a crash (of the app, of the service) left behind, or an exit
    /// the app did not collect. The reply is JSON `[AgentScratchInfo]`.
    func leftovers(reply: @escaping @Sendable (Data) -> Void)
    /// Runs read probes from inside the sandbox; the reply is JSON `[AgentProbeResult]`. `userFolders` false leaves out the
    /// probes that list the user's own folders (Documents, Application Support): macOS asks for consent when an unsandboxed
    /// build reads them, and a unit-test host must not trigger that prompt. `targets` (JSON `[AgentProbeTarget]`) are paths
    /// of the app's own that must be unreadable (other conversations' files).
    func selfTest(userFolders: Bool, targets: Data, reply: @escaping @Sendable (Data) -> Void)
}

/// Exported by the app; the service calls it with omp's output.
@objc protocol OcelotAgentClientProtocol {
    /// Raw stdout bytes (the app splits lines).
    func output(sessionId: String, data: Data)
    /// omp exited and both pipes are drained. `stderr` is the tail.
    func exited(sessionId: String, status: Int32, stderr: String)
}

struct AgentServiceStart: Codable, Sendable {
    var sessionId: String
    /// Absolute, symlink-free path of the omp executable the app resolved.
    var ompPath: String
    var systemPrompt: String
    var model: String?
    var thinking: String?
    /// Contents of the root `.mcp.json` (names the token's environment variable; holds no secret).
    var mcpConfig: String
    var modelsYml: String
    var overlay: String
    var gatewayToken: String
    /// The agent's window-scoped MCP token: passed in the process environment only, never written to a file.
    var mcpToken: String
    /// Host-owned directory used as TMPDIR (holds the pre-unpacked helper dylib; the service may write there).
    var temporaryDirectory: String
    /// Which conversation the process runs, written next to the scratch so a copy a crash left behind finds its way home.
    /// The service never touches `Agent/conversations/`: the sandbox does not let it.
    var projectId: String
    var conversationId: String
    /// Continue the session already in the scratch (`--continue`).
    var resume: Bool
}

/// A scratch copy of one conversation's session that no running process owns (see `OcelotAgentServiceProtocol.leftovers`).
struct AgentScratchInfo: Codable, Sendable, Equatable {
    var sessionId: String
    var projectId: String
    var conversationId: String
    /// Newest modification time (seconds since 1970) of any session file in it; nil when it holds none.
    var modified: Double?
}

/// A path of the app's own that the agent must not be able to read, with the command that tries (`ls` for folders, `cat` for files).
struct AgentProbeTarget: Codable, Sendable, Equatable {
    var label: String
    var path: String
    var list: Bool
}

struct AgentProbeResult: Codable, Sendable, Equatable {
    var label: String
    /// The probe behaved as the confinement requires (denied where it must be, allowed where it must be).
    var ok: Bool
    var detail: String
}

enum AgentService {
    static let name = "sh.caracal.ocelot.AgentService"
}
