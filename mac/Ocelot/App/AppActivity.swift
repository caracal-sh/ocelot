import AppKit
import Foundation

/// What agents did to the app through the app-scope MCP tools ("Claude Code opened Acme"), shown to the person: a toast in the
/// editor windows (like the lock badges for edits) and a quiet line on Home.
@MainActor
final class AppActivity: ObservableObject {
    static let shared = AppActivity()

    struct Entry: Identifiable, Equatable {
        let id = UUID()
        let client: String
        let message: String
        let date: Date
    }

    /// The newest entry, for Home. Cleared after a while so the line does not linger.
    @Published private(set) var latest: Entry?
    private(set) var history: [Entry] = []
    private var clearTask: Task<Void, Never>?

    /// "Claude Code" for `claude-code`, "Codex", "Cursor", "omp"; anything else made readable ("my_tool/1.2" -> "My Tool").
    nonisolated static func label(for client: String?) -> String {
        guard let client, !client.isEmpty else { return "An agent" }
        let lower = client.lowercased()
        if lower.range(of: #"claude[-_ ]?code"#, options: .regularExpression) != nil { return "Claude Code" }
        if lower.range(of: #"claude[-_ ]?desktop"#, options: .regularExpression) != nil { return "Claude Desktop" }
        if lower.contains("claude") { return "Claude" }
        if lower.contains("codex") { return "Codex" }
        if lower.contains("cursor") { return "Cursor" }
        if lower == "omp" || lower.hasPrefix("omp-") || lower.hasPrefix("omp ") { return "omp" }
        let base = lower.prefix { !"/@(".contains($0) }
        let words = base.split { "-_. ".contains($0) }.filter { word in !word.allSatisfy { $0.isNumber || $0 == "." } && !(word.first == "v" && word.dropFirst().allSatisfy { $0.isNumber }) }
        let special = ["cli": "CLI", "ai": "AI", "mcp": "MCP", "ide": "IDE"]
        let text = words.map { special[String($0)] ?? ($0.prefix(1).uppercased() + $0.dropFirst()) }.joined(separator: " ")
        return text.isEmpty ? "An agent" : text
    }

    /// Records `"<Client> <what>"` and shows it: a toast in `windows` (default every editor window) and on Home.
    func record(client: String?, did what: String, in windows: [EditorWebController]? = nil) {
        let who = Self.label(for: client)
        let message = "\(who) \(what)"
        let entry = Entry(client: who, message: message, date: Date())
        history.append(entry)
        if history.count > 50 { history.removeFirst(history.count - 50) }
        latest = entry
        clearTask?.cancel()
        clearTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            if !Task.isCancelled { self?.latest = nil }
        }
        for controller in windows ?? EditorRegistry.shared.all {
            Task { @MainActor in
                _ = try? await controller.bridge.editor.call(EditorMethods.AgentActivity.self, AgentActivityParams(client: client ?? "", message: message), timeout: .seconds(5))
            }
        }
    }
}

/// Which Settings tab shows (an agent's `open_settings` names one).
enum SettingsTab: String, CaseIterable, Hashable {
    case mcp, agent, images, updates
}

@MainActor
final class SettingsRouter: ObservableObject {
    static let shared = SettingsRouter()
    @Published var tab: SettingsTab = .mcp
}
