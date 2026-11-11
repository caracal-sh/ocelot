import AppKit
import Combine
import SwiftUI

/// One bar per window: the web toolbar sits in the title bar (`.hiddenTitleBar`), the traffic
/// lights are centred in it, and the editor shows the document title. Drag and double-click on
/// the bar's empty space come back over the bridge (`host.windowDrag`,
/// `host.windowTitlebarDoubleClick`) because WKWebView swallows mouse events.
@MainActor
final class WindowChrome {
    /// Height of the editor's toolbar (`--at-toolbar-h` in theme.css). Keep in sync.
    static let toolbarHeight: CGFloat = 40
    /// Gap between the zoom button and the first toolbar item.
    private static let gapAfterButtons: CGFloat = 14

    private weak var window: NSWindow?
    private let session: DocumentSession
    private let bridge: WebBridge
    private var observers: [NSObjectProtocol] = []
    private var cancellables: Set<AnyCancellable> = []
    private var lastSent: WindowChromeParams?

    init(session: DocumentSession, bridge: WebBridge) {
        self.session = session
        self.bridge = bridge
        // Title and edited state follow the session.
        session.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.push() }
            .store(in: &cancellables)
    }

    func register(on host: HostEndpoint) {
        host.register(HostMethods.WindowDrag.self) { [weak self] _ in
            self?.drag()
            return Empty()
        }
        host.register(HostMethods.WindowTitlebarDoubleClick.self) { [weak self] _ in
            self?.titlebarDoubleClick()
            return Empty()
        }
        host.register(HostMethods.WindowToggleFullScreen.self) { [weak self] _ in
            self?.window?.toggleFullScreen(nil)
            return Empty()
        }
    }

    func attach(_ window: NSWindow) {
        guard self.window !== window else { return }
        self.window = window
        observers.forEach(NotificationCenter.default.removeObserver)
        // AppKit re-lays out the title bar on these; put the buttons back each time.
        let names: [Notification.Name] = [
            NSWindow.didResizeNotification, NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
            NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification,
        ]
        observers = names.map { name in
            NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.layoutTrafficLights()
                    self?.push()
                }
            }
        }
        // Preview's full-screen button uses native full screen (`host.windowToggleFullScreen`, View > Enter Full Screen).
        window.collectionBehavior.remove([.fullScreenNone, .fullScreenAuxiliary])
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.titlebarSeparatorStyle = .none
        layoutTrafficLights()
        push()
    }

    /// Sends the title, edited state and traffic-light inset to the editor (no-op when unchanged).
    /// `force` resends after the editor page (re)loaded.
    func push(force: Bool = false) {
        guard let window else { return }
        let name = session.fileURL?.deletingPathExtension().lastPathComponent ?? session.documentName
        window.isDocumentEdited = session.isDirty
        let params = WindowChromeParams(leadingInset: leadingInset(window), title: name, edited: session.isDirty)
        if !force, params == lastSent { return }
        lastSent = params
        let bridge = self.bridge
        Task { @MainActor in
            // Before the editor has loaded there is no endpoint yet; the next push after load sends it.
            _ = try? await bridge.editor.call(EditorMethods.WindowChrome.self, params, timeout: .seconds(2))
        }
    }

    // MARK: - Traffic lights

    private func leadingInset(_ window: NSWindow) -> Int {
        guard !window.styleMask.contains(.fullScreen), let zoom = window.standardWindowButton(.zoomButton) else { return 0 }
        return Int((zoom.frame.maxX + Self.gapAfterButtons).rounded())
    }

    /// Centres the close / minimise / zoom buttons vertically in the toolbar.
    private func layoutTrafficLights() {
        guard let window, !window.styleMask.contains(.fullScreen),
              let close = window.standardWindowButton(.closeButton),
              let mini = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton),
              let titlebar = close.superview, let container = titlebar.superview
        else { return }
        let height = Self.toolbarHeight
        var frame = container.frame
        frame.size.height = height
        frame.origin.y = window.frame.height - height
        container.frame = frame
        titlebar.frame = container.bounds
        let leading: CGFloat = 14
        let spacing = max(20, mini.frame.minX - close.frame.minX)
        for (index, button) in [close, mini, zoom].enumerated() {
            button.setFrameOrigin(NSPoint(x: leading + CGFloat(index) * spacing, y: ((height - button.frame.height) / 2).rounded()))
        }
    }

    // MARK: - Drag and double-click

    private func drag() {
        guard let window, let event = NSApp.currentEvent,
              [.leftMouseDown, .leftMouseDragged, .leftMouseUp].contains(event.type) else { return }
        // The first click's drag tracking eats its mouse-up, so the page may not see a double-click;
        // AppKit's click count is authoritative.
        if event.type != .leftMouseDragged, event.clickCount >= 2 {
            titlebarDoubleClick()
            return
        }
        guard event.type != .leftMouseUp else { return }
        window.performDrag(with: event)
    }

    /// Follows System Settings > Desktop & Dock > "Double-click a window's title bar to".
    private func titlebarDoubleClick() {
        guard let window else { return }
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize": window.performMiniaturize(nil)
        case "None": break
        default: window.performZoom(nil)
        }
    }
}

/// Hands the hosting NSWindow to a callback once the view is in a window.
struct WindowAccessor: NSViewRepresentable {
    let onWindow: @MainActor (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView { AccessorView(onWindow: onWindow) }
    func updateNSView(_ nsView: NSView, context: Context) {}

    private final class AccessorView: NSView {
        let onWindow: @MainActor (NSWindow) -> Void
        init(onWindow: @escaping @MainActor (NSWindow) -> Void) {
            self.onWindow = onWindow
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { onWindow(window) }
        }
    }
}
