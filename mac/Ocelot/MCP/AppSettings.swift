import Foundation

/// What `get_app_settings` / `set_app_settings` see of the app. The live app wires these to the real models
/// (`AppSettingsHooks.live`); tests inject fakes, so the guard below is tested without Sparkle, the Keychain or the filesystem.
@MainActor
struct AppSettingsHooks {
    struct ImageModel: Equatable {
        var id: String
        var label: String
        var provider: String
        var available: Bool
        var reason: String?
    }

    /// nil = this build has no update feed (nothing to switch).
    var automaticChecks: () -> Bool?
    var setAutomaticChecks: (Bool) -> Void
    var imageModels: () async -> [ImageModel]
    var imageDefault: () -> String?
    var setImageDefault: (String?) async throws -> Void
    var falKeyStored: () -> Bool
    var cliInstalled: () -> Bool
    var cliDetail: () -> String?
    var setCLIInstalled: (Bool) throws -> Void
    var unconfined: () -> Bool
    var mcpPort: () -> Int
    var mcpRunning: () -> Bool
}

/// The settings agents may read and (except the security ones) change. The key table is `APP_SETTINGS` in
/// editor/src/mcp/appTools.ts (generated into `AppToolManifest`): a key marked `security` is readable, redacted where it is a
/// secret, and a write to it is refused with `AppToolData.securityRefusal`, whatever the value, before anything else is checked.
@MainActor
final class AppSettings {
    private let hooks: AppSettingsHooks

    init(hooks: AppSettingsHooks) { self.hooks = hooks }

    // MARK: Read

    func value(for key: String) -> Any {
        switch key {
        case "updates.automatic_checks": hooks.automaticChecks().map { $0 as Any } ?? NSNull()
        case "images.default_model": hooks.imageDefault().map { $0 as Any } ?? NSNull()
        case "cli.installed": hooks.cliInstalled()
        case "agent.unconfined": hooks.unconfined()
        case "mcp.port": hooks.mcpPort()
        case "mcp.token": "(redacted)"
        case "images.fal_key": hooks.falKeyStored() ? "(stored in the Keychain; redacted)" : "(none)"
        default: NSNull()
        }
    }

    /// Every setting with its value, whether an agent may change it, and where a person does.
    func snapshot() async -> [String: Any] {
        let models = await hooks.imageModels()
        let rows: [[String: Any]] = AppToolData.settings.compactMap { def in
            guard let key = def["key"] as? String else { return nil }
            let security = def["security"] as? Bool == true
            var row: [String: Any] = [
                "key": key,
                "value": value(for: key),
                "writable": !security && def["readonly"] as? Bool != true,
                "security": security,
                "where": def["where"] as? String ?? "",
                "description": def["description"] as? String ?? "",
            ]
            if key == "updates.automatic_checks", hooks.automaticChecks() == nil {
                row["note"] = "This build has no update feed (development and unsigned builds), so there is nothing to switch."
                row["writable"] = false
            }
            if security { row["how"] = AppToolData.securityHint }
            return row
        }
        var details: [String: Any] = [
            "image_models": models.map { m -> [String: Any] in
                var out: [String: Any] = ["id": m.id, "label": m.label, "provider": m.provider, "available": m.available]
                if let reason = m.reason { out["unavailable_reason"] = reason }
                return out
            },
            "mcp": ["running": hooks.mcpRunning(), "port": hooks.mcpPort()],
        ]
        if let detail = hooks.cliDetail() { details["cli"] = detail }
        return ["settings": rows, "details": details]
    }

    // MARK: Write

    /// All or nothing: every key is checked (security first, then name, type, value) before the first one changes.
    func apply(_ changes: [String: Any]) async throws -> [String: Any] {
        guard !changes.isEmpty else {
            throw AppToolError("set_app_settings needs \"settings\": an object such as { \"updates.automatic_checks\": false }. Keys: \(writableKeys.joined(separator: ", ")).")
        }
        let keys = changes.keys.sorted()
        if let blocked = keys.first(where: { AppToolData.isSecurity($0) }) {
            throw AppToolError(AppToolData.securityRefusal(blocked))
        }
        for key in keys {
            guard let def = AppToolData.setting(key) else {
                throw AppToolError("Unknown setting \"\(key)\". Settings you may change: \(writableKeys.joined(separator: ", ")). get_app_settings lists them all.")
            }
            if def["readonly"] as? Bool == true { throw AppToolError("\"\(key)\" cannot be set here (\(def["where"] as? String ?? "see Settings")).") }
        }
        var plan: [() async throws -> Void] = []
        var result: [String: Any] = [:]
        for key in keys {
            let new = changes[key] as Any
            switch key {
            case "updates.automatic_checks":
                guard let on = Self.bool(new) else { throw AppToolError("\"\(key)\" must be true or false.") }
                guard hooks.automaticChecks() != nil else { throw AppToolError("This build has no update feed (development and unsigned builds), so automatic checks cannot be switched. Install a signed release.") }
                result[key] = ["from": value(for: key), "to": on]
                plan.append { [hooks] in hooks.setAutomaticChecks(on) }
            case "images.default_model":
                var id: String?
                if new is NSNull { id = nil } else if let s = new as? String { id = s.isEmpty ? nil : s } else { throw AppToolError("\"\(key)\" must be a model id from get_app_settings (details.image_models), or null for automatic.") }
                if let id {
                    let models = await hooks.imageModels()
                    // A custom `fal:<endpoint>` is not in the catalogs; the hub validates it. Catalog models must be available.
                    if let model = models.first(where: { $0.id == id }) {
                        guard model.available else { throw AppToolError("\(id) is not available: \(model.reason ?? "its provider needs setup"). Available models: \(models.filter(\.available).map(\.id).joined(separator: ", ")).") }
                    } else if !id.hasPrefix("fal:") {
                        throw AppToolError("Unknown image model \"\(id)\". Available models: \(models.filter(\.available).map(\.id).joined(separator: ", ")); or null for automatic.")
                    }
                }
                result[key] = ["from": value(for: key), "to": id.map { $0 as Any } ?? NSNull()]
                plan.append { [hooks] in try await hooks.setImageDefault(id) }
            case "cli.installed":
                guard let on = Self.bool(new) else { throw AppToolError("\"\(key)\" must be true (install) or false (remove).") }
                result[key] = ["from": value(for: key), "to": on]
                plan.append { [hooks] in try hooks.setCLIInstalled(on) }
            default:
                throw AppToolError("\"\(key)\" cannot be changed through MCP.")
            }
        }
        for step in plan { try await step() }
        return ["changed": result]
    }

    var writableKeys: [String] {
        AppToolData.settings.compactMap { def in
            guard def["security"] as? Bool != true, def["readonly"] as? Bool != true else { return nil }
            return def["key"] as? String
        }
    }

    private static func bool(_ value: Any) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
}

/// A failure the agent can read and act on: becomes a tool result with `isError: true`.
struct AppToolError: Error, CustomStringConvertible {
    var message: String
    init(_ message: String) { self.message = message }
    var description: String { message }
}

extension AppSettingsHooks {
    /// Wired to the app's real models.
    static func live(updates: UpdateService, images: ImageSettingsModel, isolation: AgentIsolationModel, mcp: MCPService) -> AppSettingsHooks {
        AppSettingsHooks(
            automaticChecks: { updates.isConfigured ? updates.automaticChecks : nil },
            setAutomaticChecks: { updates.setAutomaticChecks($0) },
            imageModels: {
                await images.reload()
                return images.providers.flatMap { provider in
                    provider.models.map { ImageModel(id: $0.id, label: $0.label, provider: provider.label, available: $0.available, reason: $0.unavailableReason) }
                }
            },
            imageDefault: { images.defaultModel },
            setImageDefault: { id in
                images.message = nil
                await images.select(id ?? ImageSettingsModel.automaticTag)
                if let message = images.message { throw AppToolError(message) }
            },
            falKeyStored: { images.providers.first { $0.id == "fal" }?.keyStored ?? false },
            cliInstalled: { CLIInstaller().status == .installed },
            cliDetail: {
                switch CLIInstaller().status {
                case .installed: "Linked at \(CLIInstaller().link.path)"
                case .notInstalled: nil
                case .other(let why): why
                }
            },
            setCLIInstalled: { on in
                let installer = CLIInstaller()
                if on { try installer.install() } else { try installer.uninstall() }
            },
            unconfined: { isolation.unconfined },
            mcpPort: { mcp.boundPort },
            mcpRunning: { if case .running = mcp.state { true } else { false } }
        )
    }
}
