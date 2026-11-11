import AppKit
import Foundation

/// Swift implementations of the `host.*` methods in bridge/schema.json.
@MainActor
enum HostMethodHandlers {
    static func register(on host: HostEndpoint, session: DocumentSession) {
        host.register(HostMethods.Ping.self) { params in
            PingResult(message: params.message, from: "swift", version: AppInfo.version, receivedAt: Date().timeIntervalSince1970 * 1000)
        }
        host.register(HostMethods.GetInfo.self) { _ in
            HostInfo(
                appName: AppInfo.name,
                appVersion: AppInfo.version,
                build: AppInfo.build,
                devMode: EditorSource.devURL != nil,
                osVersion: ProcessInfo.processInfo.operatingSystemVersionString
            )
        }
        host.register(HostMethods.Log.self) { params in
            AppInfo.editorLog(level: params.level, message: params.message)
            return Empty()
        }
        host.register(HostMethods.RenderSnapshot.self) { params in
            try await OffscreenRenderer.shared.render(params)
        }
        host.register(HostMethods.ListFonts.self) { _ in
            FontList(families: NSFontManager.shared.availableFontFamilies.sorted())
        }
        host.register(HostMethods.GetMcpStatus.self) { [weak session] _ in
            // Pin the copied config to this window's project when it has an id.
            MCPService.shared.status(for: session?.runProject(windowId: ""))
        }
        host.register(HostMethods.GetMcpClientConfig.self) { [weak session] params in
            // The connect text for one agent, pinned to this window's project like `host.getMcpStatus`.
            let project = session?.runProject(windowId: "")
            let status = MCPService.shared.status(for: project)
            let command = CLIInstaller().commandForConfigs
            let text: String
            if params.client == "other" {
                text = MCPClientConfig.renderGeneric(command: command, project: project?.id, projectName: project?.name)
            } else if let kind = MCPClientKind(rawValue: params.client) {
                text = MCPClientConfig.render(kind, command: command, project: project?.id, projectName: project?.name)
            } else {
                let known = (MCPClientKind.allCases.map(\.rawValue) + ["other"]).joined(separator: ", ")
                throw BridgeFailure(.invalidParams, "Unknown agent \"\(params.client)\". Use one of: \(known).")
            }
            return McpClientConfig(client: params.client, text: text, running: status.running, error: status.error)
        }
        host.register(HostMethods.CopyText.self) { params in
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(params.text, forType: .string)
            return Empty()
        }
        host.register(HostMethods.OpenURL.self) { params in
            let url = try ExternalURL.validated(params.url)
            guard NSWorkspace.shared.open(url) else {
                throw BridgeFailure(.internal, "macOS could not open \(url.absoluteString). Check that a browser or mail app is installed and set as default.")
            }
            return Empty()
        }
        host.register(HostMethods.DocumentChanged.self) { [weak session] params in
            session?.editorReportedChange(name: params.name)
            return Empty()
        }
        AssetBridge.register(on: host, session: session)
        ExportBridge.register(on: host, session: session)
        VideoExportBridge.register(on: host, session: session)
    }
}
