import Foundation

/// XPC contract between the app and the sandboxed agent service (Contents/XPCServices/sh.caracal.ocelot.AgentService.xpc).
/// The service knows exactly one command line (`omp --mode rpc …`, built by `AgentLaunch`); the app
/// cannot make it run anything else. Payloads are JSON `Data` so the interface needs no secure-coding classes.
@objc protocol OcelotAgentServiceProtocol {
    /// Writes the session files into the service's own container and starts omp. `reply(nil)` on success, else an actionable message.
    func start(_ request: Data, reply: @escaping @Sendable (String?) -> Void)
    /// One newline-terminated JSON RPC line for omp's stdin (the app has already checked its allowlist).
    func send(sessionId: String, line: Data)
    /// Closes omp's stdin (it drains and exits), then terminates it after a grace period.
    func stop(sessionId: String)
    /// Runs read probes from inside the sandbox; the reply is JSON `[AgentProbeResult]`. `userFolders` false leaves out the
    /// probes that list the user's own folders (Documents, Application Support): macOS asks for consent when an unsandboxed
    /// build reads them, and a unit-test host must not trigger that prompt.
    func selfTest(userFolders: Bool, reply: @escaping @Sendable (Data) -> Void)
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
    /// The conversation's own directory for omp's session files (`--session-dir`): `Agent/conversations/<projectId>/<conversationId>`,
    /// created by the app. The service refuses any other path; the entitlements let it read and write there and nowhere else
    /// outside its container.
    var sessionDirectory: String
    /// Continue the session in `sessionDirectory` (`--continue`).
    var resume: Bool
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
