import AppKit
import SwiftUI
import WebKit

@main
struct OcelotApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @FocusedValue(\.editorController) private var editorController
    @Environment(\.openWindow) private var openWindow
    @ObservedObject private var recents: RecentDocuments

    init() {
        // First: moves the Atelier-era Application Support folder, preferences and Keychain items before anything reads them
        // (RecentDocuments reads its preferences on creation, hence it is created here and not in a property initializer).
        LegacyMigration.runAtLaunch()
        _recents = ObservedObject(wrappedValue: RecentDocuments.shared)
        // Document windows come back through crash recovery and Home, not through the system's window
        // restoration (which would reopen empty "Untitled" windows instead of showing Home).
        UserDefaults.standard.register(defaults: ["NSQuitAlwaysKeepsWindows": false])
    }

    var body: some Scene {
        // The window-opening action is needed before any view exists (a file handed over while the app launches).
        let _ = HomeCoordinator.shared.install(openWindow)
        // Declared first: SwiftUI presents the first scene at launch. HomeCoordinator decides whether to keep it
        // (nothing to restore or open) or to hand over to a document window.
        Window("Home", id: HomeCoordinator.homeWindowID) {
            HomeWindowView()
        }
        .defaultSize(width: 880, height: 600)
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentMinSize)

        WindowGroup("Ocelot", id: HomeCoordinator.editorWindowID) {
            EditorWindowView()
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1440, height: 900)
        // One bar: the editor's toolbar sits in the title bar (see WindowChrome).
        .windowStyle(.hiddenTitleBar)

        Settings {
            SettingsRootView()
        }
        .commands {
            CommandGroup(after: .newItem) {
                Button("Open…") {
                    if let controller = editorController {
                        Task { @MainActor in await DocumentOpener.openWithPanel(from: controller) }
                    } else {
                        // Only Home is open: the document opens in a new window.
                        HomeCoordinator.shared.install(openWindow)
                        HomeCoordinator.shared.openWithPanel()
                    }
                }
                .keyboardShortcut("o")
                Menu("Open Recent") {
                    ForEach(recents.items.prefix(10)) { item in
                        Button(item.menuTitle) {
                            HomeCoordinator.shared.install(openWindow)
                            HomeCoordinator.shared.open(item.url)
                        }
                    }
                    if !recents.items.isEmpty { Divider() }
                    Button("Clear Menu") { recents.clear() }
                        .disabled(recents.savedCount == 0)
                }
                Button("Home") {
                    HomeCoordinator.shared.install(openWindow)
                    HomeCoordinator.shared.showHome()
                }
                .keyboardShortcut("1", modifiers: [.command, .shift])
            }
            CommandGroup(replacing: .saveItem) {
                Button("Save") { run { await $0.session.save() } }
                    .keyboardShortcut("s")
                    .disabled(editorController == nil)
                Button("Save As…") { run { await $0.session.saveAs() } }
                    .keyboardShortcut("s", modifiers: [.command, .shift])
                    .disabled(editorController == nil)
            }
            // The editor handles ⌘Z itself while the canvas has focus (WebKit gives key
            // equivalents to the page first); these items cover clicks in the menu bar.
            CommandGroup(replacing: .undoRedo) {
                Button("Undo") { run { _ = try? await $0.bridge.editor.call(EditorMethods.Undo.self, Empty()) } }
                    .keyboardShortcut("z")
                    .disabled(editorController == nil)
                Button("Redo") { run { _ = try? await $0.bridge.editor.call(EditorMethods.Redo.self, Empty()) } }
                    .keyboardShortcut("z", modifiers: [.command, .shift])
                    .disabled(editorController == nil)
            }
            // Preview: ⌥⌘P toggles it in the focused editor. The system's Enter Full Screen (⌃⌘F) stays
            // in this menu because the standard toolbar group is only extended, never replaced.
            CommandGroup(before: .toolbar) {
                Button("Preview") {
                    run { _ = try? await $0.bridge.editor.call(EditorMethods.Present.self, PresentParams(active: nil)) }
                }
                .keyboardShortcut("p", modifiers: [.command, .option])
                .disabled(editorController == nil)
                Button("Present with Presenter View") {
                    run { _ = try? await $0.bridge.editor.call(EditorMethods.Present.self, PresentParams(active: true, presenter: true, display: "auto")) }
                }
                .keyboardShortcut("p", modifiers: [.command, .option, .shift])
                .disabled(editorController == nil)
            }
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") { UpdateService.shared.checkForUpdates() }
                Button("Install Command-Line Tool…") { CLIInstallerUI.install() }
            }
            CommandGroup(after: .pasteboard) {
                Button("Copy MCP Config") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(MCPService.shared.claudeCommand(project: editorController?.session.runProject(windowId: "")), forType: .string)
                }
            }
            CommandMenu("Debug") {
                Button("Ping Editor") {
                    run { controller in
                        let message = await controller.pingEditor()
                        let alert = NSAlert()
                        alert.messageText = "Bridge ping"
                        alert.informativeText = message
                        alert.runModal()
                    }
                }
                .keyboardShortcut("p", modifiers: [.command, .option, .control])
                .disabled(editorController == nil)

                Button("Reload Editor") { editorController?.load() }
                    .keyboardShortcut("r", modifiers: [.command, .option, .control])
                    .disabled(editorController == nil)
            }
        }
    }

    private func run(_ action: @escaping @MainActor @Sendable (EditorWebController) async -> Void) {
        guard let controller = editorController else { return }
        Task { @MainActor in await action(controller) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Unit tests run inside the app; they start their own servers on free ports and leave the user's environment alone.
        guard !AppEnvironment.underTest else { return }
        MCPService.shared.start()
        // Clients files that killed Ocelots left in the gateway's home (token hashes): remove those of dead pids.
        Task.detached(priority: .utility) { AuthGateway.removeStaleClientFiles() }
    }

    /// Finder, `open -a Ocelot file.ocelot` and `ocelot open` all send the system's "open documents" Apple event, whatever
    /// window is in front or whether the app is still launching. Handled here, not by SwiftUI: its scene routing hands the
    /// URL to a scene, and with `Window("Home")` first that is Home, which has no handler: Home was merely re-shown, or
    /// closed (quitting the app when no editor window existed). `DocumentOpener` is the one place that opens documents.
    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleOpenDocuments(_:withReplyEvent:)), forEventClass: AEEventClass(kCoreEventClass), andEventID: AEEventID(kAEOpenDocuments))
    }

    @MainActor @objc private func handleOpenDocuments(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        let urls = AppDelegate.fileURLs(in: event)
        Task { @MainActor in
            for url in urls { await DocumentOpener.open(url) }
        }
    }

    /// The files of an "open documents" event (a list of file URLs; a single one arrives as a one-item list or alone).
    static func fileURLs(in event: NSAppleEventDescriptor) -> [URL] {
        guard let list = event.paramDescriptor(forKeyword: keyDirectObject) else { return [] }
        if list.numberOfItems == 0 { return list.fileURLValue.map { [$0] } ?? [] }
        return (1...list.numberOfItems).compactMap { list.atIndex($0)?.fileURLValue }
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    /// Document windows come back through crash recovery and Home; restoring the system's window list would
    /// reopen empty "Untitled" windows instead of showing Home.
    func application(_ app: NSApplication, shouldRestoreSecureApplicationState coder: NSCoder) -> Bool { false }

    /// Closing the last document window shows Home (`HomeCoordinator.editorWindowClosed`) instead of quitting;
    /// closing Home itself with no document open quits (`HomeCoordinator.homeWillClose`).
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Set by the MCP `quit_app` tool after it wrote every document itself: no second flush (see `LiveAppControl.quit`).
    nonisolated(unsafe) static var documentsFlushedForQuit = false

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        HomeCoordinator.shared.willTerminate()
        if Self.documentsFlushedForQuit { return .terminateNow }
        // Edits wait up to ~1.75 s for their autosave (250 ms in the editor, then 1.5 s here), and an edit of the last
        // 250 ms is not reported yet: write them out before the process goes away.
        let sessions = EditorRegistry.shared.all.map(\.session)
        guard !sessions.isEmpty else { return .terminateNow }
        Task { @MainActor in
            await DocumentSession.flushAll(sessions)
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    /// Clicking the Dock icon with no window on screen shows Home.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard !flag else { return true }
        HomeCoordinator.shared.showHome()
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { AgentRunner.shared.terminateAll(includingGateway: true) }
    }
}

struct EditorWindowView: View {
    @StateObject private var controller = EditorWebController()
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        DocumentTitleView(session: controller.session) {
            EditorWebViewRepresentable(webView: controller.webView)
                .ignoresSafeArea()
        }
        .background(WindowAccessor { controller.chrome.attach($0) })
        .focusedSceneValue(\.editorController, controller)
        .onAppear {
            HomeCoordinator.shared.install(openWindow)
            EditorRegistry.shared.register(controller)
        }
        .onDisappear {
            AgentRunner.shared.stopWindow(controller.id)
            EditorRegistry.shared.unregister(id: controller.id)
            HomeCoordinator.shared.editorWindowClosed()
            // The window's last edits may still wait in the autosave debounce: write them before the session goes.
            Task { @MainActor in await controller.session.windowWillClose() }
        }
    }
}

/// Observes the session so the window title tracks the file name and edited state.
private struct DocumentTitleView<Content: View>: View {
    @ObservedObject var session: DocumentSession
    @ViewBuilder var content: () -> Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        content()
            .navigationTitle(session.title)
            .overlay(alignment: .top) {
                if let error = session.lastError {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text(error)
                            .font(.callout)
                        Button("Dismiss", systemImage: "xmark") { session.dismissError() }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.borderless)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                    .padding(.top, WindowChrome.toolbarHeight + 8) // below the editor's toolbar
                    // Enters with a rise; leaves with a plain, shorter fade.
                    .transition(reduceMotion ? .opacity : .asymmetric(insertion: .opacity.combined(with: .offset(y: -8)), removal: .opacity))
                }
            }
            .animation(reduceMotion || session.lastError == nil ? .easeOut(duration: 0.15) : .smooth(duration: 0.25), value: session.lastError)
    }
}

struct EditorWebViewRepresentable: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

/// Settings: four tabs. The selection is owned by `SettingsRouter`, so an agent's `open_settings` can show a tab.
struct SettingsRootView: View {
    @ObservedObject private var router = SettingsRouter.shared

    var body: some View {
        TabView(selection: $router.tab) {
            MCPSettingsView(service: .shared)
                .tabItem { Label("MCP", systemImage: "network") }
                .tag(SettingsTab.mcp)
            AgentSettingsView(model: .shared)
                .tabItem { Label("Agent", systemImage: "shield") }
                .tag(SettingsTab.agent)
            ImageSettingsView(model: .shared)
                .tabItem { Label("Images", systemImage: "photo") }
                .tag(SettingsTab.images)
            UpdatesSettingsView(service: .shared)
                .tabItem { Label("Updates", systemImage: "arrow.down.circle") }
                .tag(SettingsTab.updates)
        }
    }
}

struct EditorControllerKey: FocusedValueKey {
    typealias Value = EditorWebController
}

extension FocusedValues {
    var editorController: EditorWebController? {
        get { self[EditorControllerKey.self] }
        set { self[EditorControllerKey.self] = newValue }
    }
}
