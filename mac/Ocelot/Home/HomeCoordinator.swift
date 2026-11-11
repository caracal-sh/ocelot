import AppKit
import SwiftUI

/// Routes between the Home window and the editor windows.
///
/// - Launch: Home is the first scene, so SwiftUI opens it at launch (hidden, see `attachHome`). `routeLaunch` then
///   decides: restored / Finder-opened windows win, a recovery document opens the editor, otherwise Home shows.
/// - Closing the last document window shows Home instead of quitting; closing Home with no document window quits.
/// - Starting something from Home queues a `Request` and opens an editor window; that window's controller claims
///   the request when it is created (see `EditorWebController.init`).
@MainActor
final class HomeCoordinator {
    static let shared = HomeCoordinator()

    static let homeWindowID = "home"
    static let editorWindowID = "editor"

    /// What a new editor window should do instead of its default (a blank document, or the recovery file).
    enum Request: Equatable {
        /// A new, empty document.
        case blank
        /// Open this package.
        case open(URL)
        /// A new document whose agent chat starts with this message and these files (images and texts the person attached).
        case prompt(String, [StartAttachment])
    }

    private(set) var isTerminating = false
    /// Opens a window of the given scene id. Nil until the first SwiftUI view appears (the app is still launching).
    private var windowOpener: ((String) -> Void)?
    /// Editor windows requested before `windowOpener` existed (a file the system hands over while the app launches).
    private var windowsOwed = 0
    private weak var homeWindow: NSWindow?
    private var closeObserver: NSObjectProtocol?
    private var queue: [Request] = []
    private var didRouteLaunch = false
    /// True once Home can be seen: the launch decision was made and its window is not the invisible launch placeholder.
    var isHomeRevealed: Bool { didRouteLaunch && (homeWindow?.alphaValue ?? 1) > 0 }
    private var isClosingHome = false
    private let underTest = AppEnvironment.underTest

    /// How long Home waits at launch for the system to deliver restored windows or a file to open.
    private static let launchSettle: Duration = .milliseconds(180)
    /// Extra wait before a blank window at launch is treated as SwiftUI's default window, not a file being opened.
    private static let fileOpenGrace: Duration = .milliseconds(350)

    func install(_ action: OpenWindowAction) { install { action(id: $0) } }

    /// Installs the window opener and opens the editor windows that were asked for before it existed.
    func install(_ opener: @escaping (String) -> Void) {
        windowOpener = opener
        let owed = windowsOwed
        windowsOwed = 0
        for _ in 0..<owed { opener(Self.editorWindowID) }
    }

    /// A requested window that still has not claimed its request: open one more (only while a request waits).
    func retryQueuedWindow() {
        guard !queue.isEmpty else { return }
        windowOpener?(Self.editorWindowID)
    }

    func willTerminate() { isTerminating = true }

    // MARK: Home window

    func isHome(_ window: NSWindow) -> Bool { window === homeWindow }

    var isHomeVisible: Bool { homeWindow?.isVisible == true }

    /// Home's window while it exists (for `list_windows` / `focus_window`).
    var homeNSWindow: NSWindow? { homeWindow }

    /// Brings Home to the front, re-presenting the window if it was closed (SwiftUI may reuse its NSWindow).
    func showHome() {
        if let window = homeWindow, window.isVisible || window.isMiniaturized {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.alphaValue = 1
            window.makeKeyAndOrderFront(nil)
            NotificationCenter.default.post(name: .homeDidShow, object: nil)
        } else {
            windowOpener?(Self.homeWindowID)
        }
        NSApp.activate()
    }

    func attachHome(_ window: NSWindow) {
        if homeWindow === window {
            // Re-presented after a close: make sure it is not left invisible from the launch decision.
            if didRouteLaunch { window.alphaValue = 1 }
            return
        }
        homeWindow = window
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.styleMask.insert(.fullSizeContentView)
        window.isMovableByWindowBackground = true
        window.collectionBehavior.insert(.fullScreenNone)
        // Invisible until the launch decision is made, so Home never flashes before a document window.
        if !didRouteLaunch { window.alphaValue = 0 }
        if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
        closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.homeWillClose() }
        }
    }

    /// Closing Home with no document window open ends the session: there is nothing left to show.
    private func homeWillClose() {
        guard !isClosingHome, !isTerminating, !underTest, EditorRegistry.shared.all.isEmpty else { return }
        // A closing editor window shows Home again (`editorWindowClosed`); only an explicit close of Home quits.
        NSApp.terminate(nil)
    }

    /// Closes Home because the person started something (no quit).
    func dismissHome() {
        guard let window = homeWindow else { return }
        isClosingHome = true
        window.close()
        isClosingHome = false
    }

    // MARK: Launch

    func routeLaunch() async {
        guard !didRouteLaunch else { return }
        didRouteLaunch = true
        if underTest {
            dismissHome()
            return
        }
        try? await Task.sleep(for: Self.launchSettle)
        if DocumentSession.hasUnclaimedRecoveryFile {
            // A window the system opened (or one we open now) adopts the recovery document on its first load.
            if EditorRegistry.shared.all.isEmpty, queue.isEmpty { windowOpener?(Self.editorWindowID) }
            dismissHome()
            return
        }
        // SwiftUI may open a blank document window at launch next to Home, and a file opened from Finder starts
        // as a blank window too until its URL arrives. Give that a moment, then keep only windows with content.
        if !EditorRegistry.shared.all.isEmpty, EditorRegistry.shared.all.allSatisfy(\.session.isEmptyUntitled) {
            try? await Task.sleep(for: Self.fileOpenGrace)
        }
        let editors = EditorRegistry.shared.all
        if editors.contains(where: { !$0.session.isEmptyUntitled }) {
            dismissHome() // a file opened from Finder, or an edited document
            return
        }
        for editor in editors { editor.webView.window?.close() }
        showHome()
    }

    /// An editor window closed: with no document window left, Home takes over instead of the app quitting.
    func editorWindowClosed() {
        guard !isTerminating, !underTest, EditorRegistry.shared.all.isEmpty, !isHomeVisible else { return }
        showHome()
    }

    // MARK: Starting documents

    /// Opens an editor window that carries out `request`. Asked before the app finished launching, the window is
    /// opened as soon as SwiftUI can (`install`); the request waits for its controller either way.
    func start(_ request: Request) {
        // A document asked for before Home took part in the launch (a file handed over while launching) is the launch
        // decision: Home must neither hide behind it nor claim the recovery document when it shows later.
        didRouteLaunch = true
        queue.append(request)
        if let windowOpener { windowOpener(Self.editorWindowID) } else { windowsOwed += 1 }
        dismissHome()
    }

    /// Takes a request back that no window claimed (an MCP tool gave up waiting): it must not land on the next window the
    /// person opens. True when it was still queued.
    @discardableResult
    func discardQueued(_ request: Request) -> Bool {
        guard let index = queue.firstIndex(of: request) else { return false }
        queue.remove(at: index)
        if windowsOwed > 0 { windowsOwed -= 1 }
        return true
    }

    /// A window for `url` was requested and has not claimed the request yet.
    func isOpening(_ url: URL) -> Bool {
        queue.contains { if case .open(let queued) = $0 { queued.standardizedFileURL.resolvingSymlinksInPath() == url.standardizedFileURL.resolvingSymlinksInPath() } else { false } }
    }

    /// Opens `url` through the one document router (Open Recent, Home's recent list).
    func open(_ url: URL) {
        Task { @MainActor in await DocumentOpener.open(url) }
    }

    func openWithPanel() {
        guard let url = DocumentOpener.chooseDocument() else { return }
        open(url)
    }

    /// Called from a new editor window's controller: what Home asked it to do, if anything.
    func apply(to controller: EditorWebController) {
        guard !queue.isEmpty else { return }
        switch queue.removeFirst() {
        case .blank:
            controller.session.prepareFresh()
        case .prompt(let text, let attachments):
            controller.session.prepareFresh(prompt: text, attachments: attachments)
        case .open(let url):
            // `DocumentOpener.open` already validated the package and settled the single-writer rule.
            Task { @MainActor in await controller.session.open(url) }
        }
    }
}

extension Notification.Name {
    /// Home was revealed or brought to the front: its prompt should take the keyboard focus.
    static let homeDidShow = Notification.Name("sh.caracal.ocelot.homeDidShow")
}
