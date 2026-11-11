import AppKit
import WebKit
import XCTest

/// Spike behind the toasts' pause (`Toasts.tsx`: timers are held while `document.visibilityState` is "hidden"): does a real
/// `WKWebView` in a real window report that state, and fire `visibilitychange`, when the window is minimised, ordered out, or
/// fully covered by another window? The page logs every change it sees; each case waits for "hidden", then for "visible" again.
/// Needs a window server (a logged-in Mac or a CI runner's GUI session); without one the tests skip.
@MainActor
final class WebViewVisibilityTests: XCTestCase {
    private var window: NSWindow!
    private var cover: NSWindow?
    private var web: WKWebView!

    private static let page = """
    <!doctype html><meta charset=utf-8><body>
    <script>
    window.changes = [];
    document.addEventListener('visibilitychange', () => window.changes.push(document.visibilityState));
    </script>
    """

    override func setUp() async throws {
        try XCTSkipIf(NSScreen.screens.isEmpty, "no window server")
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory) // no Dock icon or menu bar for a test run
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        window = NSWindow(contentRect: NSRect(x: 160, y: 160, width: 400, height: 300), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        web.loadHTMLString(Self.page, baseURL: nil)
        // An inactive app's window sits behind the frontmost app's windows and is usually occluded, hence "hidden": activate first.
        NSApp.activate(ignoringOtherApps: true)
        try await requireVisibleWindow()
        try await waitFor("visible")
        // The page may still be reporting its own first "visible"; count only what the cases below cause.
        try await Task.sleep(for: .milliseconds(300))
        _ = try await web.evaluateJavaScript("window.changes = []")
    }

    override func tearDown() async throws {
        cover?.close()
        window?.close()
        cover = nil
        window = nil
        web = nil
    }

    private func state() async throws -> String {
        (try await web.evaluateJavaScript("document.visibilityState") as? String) ?? ""
    }

    private func changes() async throws -> [String] {
        (try await web.evaluateJavaScript("window.changes") as? [String]) ?? []
    }

    /// A locked screen, a sleeping display or a session without focus never shows the window: AppKit keeps it occluded, so the page
    /// stays "hidden" and the cases below would fail for a reason that has nothing to do with the code. Skip then; the assertions
    /// themselves stay as they are for a session that can show the window (CI, an unlocked desktop).
    private func requireVisibleWindow(timeout: TimeInterval = 5) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if window.occlusionState.contains(.visible) { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw XCTSkip("needs an unlocked, visible session: the window never became visible (occlusionState=\(window.occlusionState.rawValue), isVisible=\(window.isVisible), appActive=\(NSApp.isActive))")
    }

    /// Polls until the page's visibility state is `expected` (the window server reports occlusion asynchronously).
    private func waitFor(_ expected: String, timeout: TimeInterval = 8, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        var last = "?"
        while Date() < deadline {
            if let now = try? await state(), !now.isEmpty {
                last = now
                if now == expected { return }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        let win = "isVisible=\(window.isVisible) onActiveSpace=\(window.isOnActiveSpace) occluded=\(!window.occlusionState.contains(.visible)) miniaturized=\(window.isMiniaturized) appActive=\(NSApp.isActive)"
        XCTFail("visibilityState stayed \"\(last)\" for \(timeout)s; expected \"\(expected)\" (\(win))", file: file, line: line)
    }

    func testMinimisingTheWindowHidesThePageAndRestoringShowsIt() async throws {
        window.miniaturize(nil)
        try await waitFor("hidden")
        window.deminiaturize(nil)
        try await waitFor("visible")
        let seen = try await changes()
        XCTAssertEqual(seen, ["hidden", "visible"], "visibilitychange fired for each")
    }

    func testOrderingTheWindowOutHidesThePage() async throws {
        window.orderOut(nil)
        try await waitFor("hidden")
        window.makeKeyAndOrderFront(nil)
        try await waitFor("visible")
        let seen = try await changes()
        XCTAssertEqual(seen, ["hidden", "visible"])
    }

    func testAnotherWindowFullyCoveringItHidesThePage() async throws {
        let frame = window.frame.insetBy(dx: -40, dy: -40)
        let blanket = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        blanket.isReleasedWhenClosed = false
        blanket.isOpaque = true
        blanket.backgroundColor = .black
        blanket.level = .floating
        cover = blanket
        blanket.orderFrontRegardless()
        try await waitFor("hidden")
        blanket.orderOut(nil)
        try await waitFor("visible")
        let seen = try await changes()
        XCTAssertEqual(seen, ["hidden", "visible"])
    }
}
