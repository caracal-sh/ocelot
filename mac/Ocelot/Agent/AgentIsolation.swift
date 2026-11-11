import SwiftUI

/// What Settings > Agent shows: whether the sidebar agent is sandboxed, the gateway behind it,
/// and the explicit, visible switch to run it unconfined (off by default; never a silent fallback).
@MainActor
final class AgentIsolationModel: ObservableObject {
    static let shared = AgentIsolationModel()
    static let unconfinedKey = "ocelot.agent.unconfined"

    enum Mode: Equatable { case sandboxed, unconfined }

    @Published var gateway: AuthGateway.State = .idle
    /// The last problem starting or checking the agent, with its remedy; nil when the last attempt worked.
    @Published var lastError: String?
    @Published private(set) var probes: [AgentProbeResult]?
    @Published private(set) var verifying = false
    @Published var unconfined: Bool {
        didSet {
            guard unconfined != oldValue else { return }
            defaults.set(unconfined, forKey: Self.unconfinedKey)
            probes = nil
            lastError = nil
            // A running conversation keeps the confinement it started with; end it so the new setting is what runs.
            AgentRunner.shared.terminateAll()
        }
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.unconfined = defaults.bool(forKey: Self.unconfinedKey)
    }

    var mode: Mode { unconfined ? .unconfined : .sandboxed }

    /// Runs read probes from inside the sandboxed service: your omp credentials, ~/.ssh, ~/Documents and the saved conversations
    /// (the folder of all of them, and a conversation of another document, made for the check and removed after it) must be unreadable.
    func verify() async {
        verifying = true
        defer { verifying = false }
        let sentinel = AgentProbeSentinel.make()
        defer { sentinel?.remove() }
        do {
            probes = try await AgentServiceConnection.shared.selfTest(targets: sentinel?.targets ?? [])
            lastError = nil
        } catch {
            probes = nil
            lastError = (error as? BridgeFailure)?.message ?? error.localizedDescription
        }
    }
}

/// Settings > Agent.
struct AgentSettingsView: View {
    @ObservedObject var model: AgentIsolationModel

    var body: some View {
        Form {
            Section("Isolation") {
                LabeledContent("Status") { status }
                Toggle("Run agent unconfined", isOn: $model.unconfined)
                Text(model.unconfined
                    ? "The agent runs as you: it can read your files and your omp credentials. Turn this off to confine it again."
                    : "Off (recommended). The agent runs in a sandbox with no access to your files or omp credentials; its model calls go through a local gateway with a scoped token.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if model.mode == .sandboxed {
                Section("Verify") {
                    HStack {
                        Button(model.verifying ? "Checking…" : "Verify isolation") { Task { await model.verify() } }
                            .disabled(model.verifying)
                        Spacer()
                    }
                    if let probes = model.probes {
                        ForEach(probes, id: \.label) { probe in
                            Label {
                                Text("\(probe.label): \(probe.detail)")
                            } icon: {
                                Image(systemName: probe.ok ? "checkmark.circle.fill" : "xmark.octagon.fill").foregroundStyle(probe.ok ? .green : .red)
                            }
                            .font(.callout)
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 520, height: 520)
    }

    @ViewBuilder private var status: some View {
        if let error = model.lastError {
            Label { Text(error).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red) }
        } else if model.unconfined {
            Label { Text("Unconfined") } icon: { Image(systemName: "exclamationmark.shield.fill").foregroundStyle(.orange) }
        } else {
            switch model.gateway {
            case .running(let port):
                Label { Text("Sandboxed (gateway on 127.0.0.1:\(port))") } icon: { Image(systemName: "checkmark.shield.fill").foregroundStyle(.green) }
            case .failed(let message):
                Label { Text(message).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red) }
            case .starting, .restarting:
                Text("Sandboxed (starting the gateway…)")
            case .idle:
                Text("Sandboxed (the gateway starts when you open the agent sidebar)")
            }
        }
    }
}

/// A conversation made for "Verify isolation": an agent that runs for a document must not read the conversation of another one.
/// It has the shape and place of a real one (`Agent/conversations/<project>/<conversation>/<session file>`) and is removed after the check.
struct AgentProbeSentinel {
    let project: URL
    let targets: [AgentProbeTarget]

    /// nil under XCTest (reading the user's folders makes macOS ask for consent) or when the folder cannot be made.
    static func make() -> AgentProbeSentinel? {
        guard !AppEnvironment.underTest, let root = try? OmpCLI.agentDirectory() else { return nil }
        let store = AgentHistoryStore(root: root)
        guard let directory = try? store.sessionDirectory(projectId: "selftest-\(UUID().uuidString)", conversationId: "probe") else { return nil }
        let file = directory.appendingPathComponent("session.jsonl")
        guard (try? Data("ocelot isolation probe: another conversation's session\n".utf8).write(to: file)) != nil else { return nil }
        return AgentProbeSentinel(project: directory.deletingLastPathComponent(), targets: [
            AgentProbeTarget(label: "List another conversation's folder", path: directory.path, list: true),
            AgentProbeTarget(label: "Read another conversation's session file", path: file.path, list: false),
        ])
    }

    func remove() { try? FileManager.default.removeItem(at: project) }
}
