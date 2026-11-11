import AppKit
import SwiftUI

/// Settings > MCP: endpoint status, port, token, the command-line tool, and every open project with
/// its pinned MCP URL and one-click agent configs.
struct MCPSettingsView: View {
    @ObservedObject var service: MCPService
    @State private var portText = ""
    @State private var copied: String?
    @State private var copyReset: Task<Void, Never>?
    @State private var cli = CLIInstaller()
    @State private var cliMessage: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Form {
            Section("MCP server") {
                LabeledContent("Status") {
                    switch service.state {
                    case .running(let port):
                        Label { Text("Listening on 127.0.0.1:\(port)") } icon: { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                    case .starting: Text("Starting…")
                    case .stopped: Text("Stopped")
                    case .failed(let message):
                        Label { Text(message) } icon: { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red) }
                    }
                }
                LabeledContent("Endpoint") { Text(service.url).textSelection(.enabled).font(.body.monospaced()) }
                LabeledContent("Port") {
                    HStack {
                        TextField("7420", text: $portText).frame(width: 80)
                            .onSubmit { if let p = Int(portText) { service.setPort(p) } }
                        Button("Apply") { if let p = Int(portText) { service.setPort(p) } }
                    }
                }
                LabeledContent("Token") {
                    HStack {
                        Text(String(service.token.prefix(6)) + "…").font(.body.monospaced())
                        Button("Regenerate") { service.regenerateToken() }
                            .help("HTTP clients configured with the old token stop working. Clients that run `ocelot mcp` are not affected.")
                    }
                }
                Text("The server only accepts connections from this Mac and requires a token. The token lives in a file only you can read (`ocelot token`).")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Command-line tool") {
                LabeledContent("ocelot") {
                    HStack {
                        switch cli.status {
                        case .installed:
                            Label("Installed in ~/.local/bin", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                            Button("Remove") { run { try cli.uninstall() } }
                        case .notInstalled:
                            Text("Not installed")
                            Button("Install…") { run { try cli.install() } }
                        case .other(let why):
                            Text(why).font(.caption).foregroundStyle(.secondary)
                            Button("Reinstall") { run { try cli.install() } }
                        }
                    }
                }
                if let cliMessage { Text(cliMessage).font(.caption).foregroundStyle(.orange) }
                Text("Agents run `ocelot mcp --project <id>`: it answers tools/list even when Ocelot is closed and opens the app on the first tool call.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Open projects") {
                if service.projects.isEmpty {
                    Text("No project is open. Open or create a document window.").foregroundStyle(.secondary)
                }
                ForEach(service.projects, id: \.id) { project in
                    ProjectRow(project: project, service: service, command: cli.commandForConfigs, copied: $copied, copy: copy)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 560)
        .onAppear {
            portText = String(service.boundPort)
            cli = CLIInstaller()
            service.publishNow()
        }
    }

    private func run(_ action: () throws -> Void) {
        do { try action(); cliMessage = nil } catch { cliMessage = error.localizedDescription }
        cli = CLIInstaller()
    }

    private func copy(_ text: String, label: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = label
        copyReset?.cancel()
        copyReset = Task {
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { copied = nil }
        }
    }
}

private struct ProjectRow: View {
    let project: RunProject
    @ObservedObject var service: MCPService
    let command: String
    @Binding var copied: String?
    let copy: (String, String) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var url: String { service.url(for: .project(project.id)) }
    private var justCopied: Bool { copied?.hasPrefix(project.id) == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(project.name).font(.headline)
                Spacer()
                Menu {
                    ForEach(MCPClientKind.allCases, id: \.self) { client in
                        Button("Copy for \(client.displayName)") {
                            copy(MCPClientConfig.render(client, command: command, project: project.id, projectName: project.name), "\(project.id)-\(client.rawValue)")
                        }
                    }
                    Divider()
                    Button("Copy HTTP config for Claude Code (token)") { copy(service.claudeHTTPCommand(route: .project(project.id)), "\(project.id)-http") }
                    Button("Copy URL") { copy(url, "\(project.id)-url") }
                } label: {
                    // copy → checkmark replaces in place (scale, opacity, blur); under Reduce Motion it is a plain crossfade.
                    Label {
                        Text(justCopied ? "Copied" : "Copy config")
                    } icon: {
                        Image(systemName: justCopied ? "checkmark" : "doc.on.doc")
                            .contentTransition(reduceMotion ? .opacity : .symbolEffect(.replace))
                    }
                    .animation(reduceMotion ? .easeOut(duration: 0.15) : .smooth(duration: 0.3), value: justCopied)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
            Text(url).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            if let path = project.path {
                Text(path).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            } else {
                Text("Untitled: save it to give agents a stable place to reopen it.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
