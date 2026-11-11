import AppKit
import SwiftUI

/// Settings > Images: the default image model and the state of each image provider. Shares its storage with the
/// editor's Assets > Providers dialog (`ImageProviderHub`).
struct ImageSettingsView: View {
    @ObservedObject var model: ImageSettingsModel

    var body: some View {
        Form {
            Section("Default model") {
                Picker("Default image model", selection: selection) {
                    Text("Automatic (first available)").tag(ImageSettingsModel.automaticTag)
                    ForEach(model.modelGroups, id: \.id) { provider in
                        Section(provider.label) {
                            ForEach(provider.models, id: \.id) { image in
                                Text(image.label)
                                    .tag(image.id)
                                    .disabled(!image.available)
                                    .help(image.unavailableReason ?? Self.capabilities(image))
                            }
                        }
                    }
                    if let custom = model.customDefault {
                        Text(custom).tag(custom)
                    }
                }
                caption
            }

            Section("Providers") {
                if model.providers.isEmpty {
                    Text("Checking providers…").foregroundStyle(.secondary)
                }
                ForEach(model.providers, id: \.id) { provider in
                    ProviderRow(provider: provider, model: model)
                }
                HStack {
                    Spacer()
                    Button(model.isRefreshing ? "Refreshing…" : "Refresh") { Task { await model.refresh() } }
                        .disabled(model.isRefreshing)
                        .help("Check every provider again: picks up a login or key added outside Ocelot.")
                }
                if let message = model.message {
                    Text(message).font(.subheadline).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 560)
        .task { await model.reload() }
    }

    private var selection: Binding<String> {
        Binding(get: { model.selectionTag }, set: { tag in Task { await model.select(tag) } })
    }

    @ViewBuilder private var caption: some View {
        if let id = model.defaultModel, let image = model.model(id) {
            if let reason = image.unavailableReason, !image.available {
                Text("Not available right now: \(reason)").font(.subheadline).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(Self.capabilities(image)).font(.subheadline).foregroundStyle(.secondary)
            }
        } else if let custom = model.customDefault {
            Text("\(custom) is not in the catalog; it is used as typed.").font(.subheadline).foregroundStyle(.secondary)
        } else {
            Text("Used when a request names no model: Ocelot picks the first available one that can do the job.")
                .font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private static func capabilities(_ image: ImageModelInfo) -> String {
        let hint = ImageSettingsModel.capabilityHint(image)
        return hint.isEmpty ? image.label : hint.prefix(1).uppercased() + hint.dropFirst()
    }
}

/// One provider: status dot, the detail it reports, the setup step and the action that fits (fal key, login command).
private struct ProviderRow: View {
    let provider: ImageProviderInfo
    @ObservedObject var model: ImageSettingsModel
    @State private var addingKey = false
    @State private var keyDraft = ""
    @State private var copied = false
    @State private var copyReset: Task<Void, Never>?

    private var loginCommand: String? {
        switch provider.id {
        case "omp": "omp login"
        case "codex": "codex login"
        default: nil
        }
    }

    private var needsAttention: Bool { provider.status != "ready" || provider.models.contains { !$0.available } }

    private var statusText: String {
        switch provider.status {
        case "ready": "Ready"
        case "needs_setup": "Needs setup"
        default: "Unavailable"
        }
    }

    private var statusColor: Color {
        switch provider.status {
        case "ready": .green
        case "needs_setup": .orange
        default: .red
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent(provider.label) {
                HStack(spacing: 6) {
                    Circle().fill(statusColor).frame(width: 8, height: 8)
                    Text(statusText)
                }
                .accessibilityElement(children: .combine)
            }
            Text(provider.detail).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let setup = provider.setup, provider.id != "fal" {
                Text(setup).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if provider.status == "ready", let reason = provider.models.first(where: { !$0.available })?.unavailableReason {
                Text(reason).font(.subheadline).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            actions
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder private var actions: some View {
        if provider.id == "fal" {
            if addingKey {
                SecureField("fal.ai key", text: $keyDraft, prompt: Text("Paste your key from fal.ai/dashboard/keys"))
                    .onSubmit(saveKey)
                HStack {
                    Button("Save", action: saveKey).disabled(keyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Cancel") { stopAdding() }
                }
            } else {
                HStack {
                    Button(provider.keyStored == true ? "Replace key…" : "Add key…") { addingKey = true }
                    if provider.keyStored == true {
                        Button("Remove key", role: .destructive) { Task { await model.setFalKey(nil) } }
                    }
                }
            }
        } else if let command = loginCommand, needsAttention {
            HStack {
                Text(command).font(.subheadline.monospaced()).textSelection(.enabled)
                Button(copied ? "Copied" : "Copy command") { copy(command) }
            }
        }
    }

    private func saveKey() {
        let key = keyDraft
        guard !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        Task {
            if await model.setFalKey(key) { stopAdding() }
        }
    }

    private func stopAdding() {
        addingKey = false
        keyDraft = ""
    }

    private func copy(_ command: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        copied = true
        copyReset?.cancel()
        copyReset = Task {
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { copied = false }
        }
    }
}
