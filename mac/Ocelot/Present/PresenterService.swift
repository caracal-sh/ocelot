import AppKit
import Foundation
import os
import WebKit

/// The audience window: a borderless window that shows the player page (editor/src/present/player.ts) and never becomes key,
/// so the clicker keys keep landing in the editor window, which is the presenter console.
final class AudienceWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Opens and feeds the audience window for one editor window (`host.presenter*` in bridge/schema.json). Swift stays thin:
/// it lists screens, puts a window on one, keeps the display awake, and hands the editor's messages to the player page.
/// What the player draws, and when, is decided in TS.
///
/// Verified here on a single display only: the audience window on the main screen (`windowed`, so it does not cover the
/// presenter console). Full-screen placement on an external display, hot-unplug and Spaces behaviour are untested.
@MainActor
final class PresenterController: NSObject, WKNavigationDelegate {
    private let log = Logger(subsystem: "sh.caracal.ocelot", category: "present")
    private weak var bridge: WebBridge?
    private var window: AudienceWindow?
    private var webView: WKWebView?
    private var ready = false
    private var pending: [String] = []
    private var activity: NSObjectProtocol?
    private var observers: [NSObjectProtocol] = []
    private var shownOn: String?

    init(bridge: WebBridge) {
        self.bridge = bridge
    }

    func register(on host: HostEndpoint) {
        host.register(HostMethods.PresenterListScreens.self) { [weak self] _ in
            PresenterScreens(screens: self?.screens() ?? [])
        }
        host.register(HostMethods.PresenterOpenAudience.self) { [weak self] params in
            guard let self else { throw BridgeFailure(.hostUnavailable, "The editor window is closed.") }
            return try self.open(screenId: params.screenId, windowed: params.windowed ?? false)
        }
        host.register(HostMethods.PresenterPush.self) { [weak self] params in
            guard let self, self.window != nil else {
                throw BridgeFailure(.invalidParams, "The audience window is not open. Open it with host.presenterOpenAudience first.")
            }
            self.push(params.message)
            return Empty()
        }
        host.register(HostMethods.PresenterClose.self) { [weak self] _ in
            self?.close(notify: false)
            return Empty()
        }
    }

    // MARK: - Screens

    static func screenId(_ screen: NSScreen) -> String {
        if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber { return number.stringValue }
        return screen.localizedName
    }

    func screens() -> [PresenterScreen] {
        let editorScreen = bridge?.webView?.window?.screen
        return NSScreen.screens.enumerated().map { index, screen in
            PresenterScreen(
                id: Self.screenId(screen),
                name: screen.localizedName,
                x: Double(screen.frame.origin.x),
                y: Double(screen.frame.origin.y),
                width: Double(screen.frame.width),
                height: Double(screen.frame.height),
                scale: Double(screen.backingScaleFactor),
                maxFps: Double(screen.maximumFramesPerSecond),
                primary: index == 0,
                holdsEditor: editorScreen.map { $0 == screen } ?? (index == 0)
            )
        }
    }

    // MARK: - Window

    private func open(screenId: String, windowed: Bool) throws -> PresenterOpenResult {
        guard let screen = NSScreen.screens.first(where: { Self.screenId($0) == screenId }) else {
            throw BridgeFailure(.invalidParams, "There is no display with id \(screenId) any more. Call host.presenterListScreens again and pick one of the listed ids.")
        }
        close(notify: false)

        let frame: NSRect
        let level: NSWindow.Level
        if windowed {
            // Same display as the presenter console (which takes the right side of the editor window): a 16:9 floating window in the lower left corner, so the console stays visible.
            let area = screen.visibleFrame
            let width = (area.width * 0.5).rounded()
            let height = (width * 9 / 16).rounded()
            frame = NSRect(x: area.minX + 24, y: area.minY + 24, width: width, height: height)
            level = .floating
        } else {
            frame = screen.frame
            level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 1)
        }

        let window = AudienceWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false, screen: screen)
        window.isReleasedWhenClosed = false
        window.level = level
        window.backgroundColor = .black
        window.hasShadow = windowed
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.ignoresMouseEvents = true
        window.setFrame(frame, display: true)

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(EditorSchemeHandler(root: EditorSource.bundleRoot), forURLScheme: EditorSource.scheme)
        let webView = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        #if DEBUG
        webView.isInspectable = true
        #endif
        window.contentView = webView
        self.webView = webView
        self.window = window
        self.ready = false
        self.pending = []
        self.shownOn = Self.screenId(screen)

        if let dev = EditorSource.devURL, let url = URL(string: "/player.html", relativeTo: dev) {
            webView.load(URLRequest(url: url.absoluteURL))
        } else {
            webView.load(URLRequest(url: URL(string: "\(EditorSource.scheme)://app/player.html")!))
        }
        // Not makeKey: the editor window keeps the keyboard.
        window.orderFrontRegardless()
        activity = ProcessInfo.processInfo.beginActivity(options: [.idleDisplaySleepDisabled, .userInitiated], reason: "Presenting a deck")

        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.screensChanged() }
            },
            center.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.close(notify: true) }
            },
        ]
        // The editor window going away takes the audience window with it.
        if let editorWindow = bridge?.webView?.window {
            observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: editorWindow, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.close(notify: false) }
            })
        }
        log.info("audience window opened on \(screen.localizedName, privacy: .public) windowed=\(windowed)")
        return PresenterOpenResult(screenId: Self.screenId(screen), windowed: windowed)
    }

    /// The display the audience window is on was unplugged: close it and tell the editor, which continues in its own window.
    private func screensChanged() {
        guard let shownOn else { return }
        if !NSScreen.screens.contains(where: { Self.screenId($0) == shownOn }) { close(notify: true) }
    }

    func close(notify: Bool) {
        let had = window != nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
        activity = nil
        webView?.navigationDelegate = nil
        window?.orderOut(nil)
        window?.contentView = nil
        window?.close()
        window = nil
        webView = nil
        ready = false
        pending = []
        shownOn = nil
        guard had, notify, let bridge else { return }
        Task { @MainActor in
            _ = try? await bridge.editor.call(EditorMethods.PresenterEvent.self, PresenterEventParams(type: "audienceClosed"), timeout: .seconds(2))
        }
    }

    // MARK: - Messages

    func push(_ message: String) {
        if ready { deliver(message) } else { pending.append(message) }
    }

    private func deliver(_ message: String) {
        webView?.callAsyncJavaScript(
            """
            for (let i = 0; i < 50 && !window.__ocelotPlayer; i++) await new Promise((r) => setTimeout(r, 100));
            if (!window.__ocelotPlayer) throw new Error('The player page did not install window.__ocelotPlayer.');
            await window.__ocelotPlayer.dispatch(json);
            """,
            arguments: ["json": message], in: nil, in: .page
        ) { [log] result in
            if case .failure(let error) = result { log.error("player rejected a message: \(error.localizedDescription, privacy: .public)") }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.callAsyncJavaScript("return typeof window.__ocelotPlayer", in: nil, in: .page) { [log] result in
            switch result {
            case .success(let value): log.info("audience page loaded; player is \(String(describing: value), privacy: .public)")
            case .failure(let error): log.error("audience page check failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        ready = true
        let queued = pending
        pending = []
        queued.forEach(deliver)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        log.error("audience page failed to load: \(error.localizedDescription, privacy: .public)")
    }
}
