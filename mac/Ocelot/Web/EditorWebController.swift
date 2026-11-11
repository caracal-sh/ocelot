import AppKit
import UniformTypeIdentifiers
import Combine
import Foundation
import os
import WebKit

/// Owns one editor WKWebView and its bridge. One per window.
/// ObservableObject only so SwiftUI can hold it in @StateObject (created once per window).
@MainActor
final class EditorWebController: NSObject, ObservableObject {
    let webView: WKWebView
    let bridge: WebBridge
    let session: DocumentSession
    /// Unified title bar: traffic lights, drag, double-click, title in the editor's toolbar.
    let chrome: WindowChrome
    /// The audience window of Present (a deck on a second display).
    let presenter: PresenterController
    /// Identifies this window to the MCP server (see `MCPHTTPServer.windowHeader`).
    let id = UUID().uuidString
    private let log = Logger(subsystem: "sh.caracal.ocelot", category: "web")
    private var loadedDevServer = false

    override init() {
        let bridge = WebBridge()
        let config = WKWebViewConfiguration()
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: BridgeSchema.messageHandler)
        config.setURLSchemeHandler(EditorSchemeHandler(root: EditorSource.bundleRoot), forURLScheme: EditorSource.scheme)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false
        #if DEBUG
        webView.isInspectable = true
        #endif

        self.webView = webView
        self.bridge = bridge
        let session = DocumentSession(editor: { [weak bridge] in bridge?.editor })
        self.session = session
        self.chrome = WindowChrome(session: session, bridge: bridge)
        self.presenter = PresenterController(bridge: bridge)
        super.init()

        bridge.webView = webView
        webView.navigationDelegate = self
        webView.uiDelegate = self
        HostMethodHandlers.register(on: bridge.host, session: session)
        chrome.register(on: bridge.host)
        presenter.register(on: bridge.host)
        AgentRunner.shared.register(on: bridge.host, windowId: id, bridge: bridge)
        session.projectIdInUse = { [weak self] id in EditorRegistry.shared.all.contains { $0 !== self && $0.session.projectId == id } }
        session.onIdentityChange = { EditorRegistry.shared.onChange?() }
        EditorRegistry.shared.register(self)
        // Started from Home (new document, starting prompt, a recent file)? Must precede the first page load.
        HomeCoordinator.shared.apply(to: self)
        load()
    }

    func load() {
        session.editorWillLoad()
        if let dev = EditorSource.devURL {
            loadedDevServer = true
            log.info("loading editor from dev server \(dev.absoluteString, privacy: .public)")
            webView.load(URLRequest(url: dev))
        } else {
            loadedDevServer = false
            webView.load(URLRequest(url: EditorSource.bundleURL))
        }
    }

    /// Swift -> TS round trip. Used at startup and by Debug > Ping Editor.
    func pingEditor() async -> String {
        let start = ContinuousClock.now
        do {
            let result = try await bridge.editor.call(EditorMethods.Ping.self, PingParams(message: "hello from host"), timeout: .seconds(3))
            let elapsed = ContinuousClock.now - start
            let ms = Double(elapsed.components.attoseconds) / 1e15 + Double(elapsed.components.seconds) * 1000
            return "Editor answered \"\(result.message)\" (from \(result.from) \(result.version)) in \(String(format: "%.1f", ms)) ms"
        } catch {
            return "Ping failed: \(error)"
        }
    }

    private func isEditorURL(_ url: URL?) -> Bool {
        guard let url else { return false }
        if url.scheme == EditorSource.scheme { return true }
        if let dev = EditorSource.devURL { return url.host == dev.host && url.port == dev.port }
        return false
    }

    private func showDevServerHelp(_ error: any Error) {
        let url = EditorSource.devURL?.absoluteString ?? "?"
        let html = """
        <!doctype html><meta charset="utf-8"><title>Ocelot</title>
        <body style="font: 13px -apple-system; padding: 40px; color: #888">
        <h3>Dev server not reachable</h3>
        <p>Could not load <code>\(url)</code> (\(error.localizedDescription)).</p>
        <p>Run <code>make dev</code> (it starts Vite and the app together), or unset
        <code>OCELOT_DEV_URL</code> in the scheme to use the bundled editor.</p></body>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }
}

extension EditorWebController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isEditorURL(webView.url) else { return } // help pages
        Task { @MainActor in
            let message = await pingEditor()
            log.info("bridge self-test: \(message, privacy: .public)")
            await session.editorDidLoad()
            chrome.push(force: true)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        log.error("navigation failed: \(error.localizedDescription, privacy: .public)")
        if loadedDevServer { showDevServerHelp(error) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        // The editor is a single-page app; open any outbound link in the browser instead.
        guard let url = navigationAction.request.url else { return .cancel }
        // Frames inside the canvas (artboards, sandboxed code layers) only ever load about:srcdoc.
        // Refuse everything else so a code layer cannot navigate itself to a network page.
        if navigationAction.targetFrame?.isMainFrame == false {
            if url.scheme == "about" { return .allow }
            // A link clicked in an artboard (Preview mode) opens in the browser like any other outbound link. Only frames of the
            // editor's own origin may do that: sandboxed code layers have an opaque origin and cannot reach out at all.
            let source = navigationAction.sourceFrame.securityOrigin
            if SubframeLinks.opensInBrowser(url, linkActivated: navigationAction.navigationType == .linkActivated,
                                            sourceOrigin: (source.protocol, source.host, source.port), editorURL: webView.url) {
                NSWorkspace.shared.open(url)
            }
            return .cancel
        }
        if url.scheme == "about" || isEditorURL(url) { return .allow }
        if navigationAction.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
        return .cancel
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log.error("web content process terminated; reloading editor")
        load()
    }
}

extension EditorWebController: WKUIDelegate {
    /// `<input type="file">` (the image tool, the agent composer's paperclip): WebKit shows nothing unless the host provides a panel.
    /// The page cannot say what it accepts, so the panel offers images and the text files the agent can take; each caller refuses
    /// what it cannot use with a message that names what is supported.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image] + HomeAttachment.openPanelTypes
        return panel.runModal() == .OK ? panel.urls : nil
    }
}

/// Which links clicked inside canvas frames may leave the app.
enum SubframeLinks {
    /// True for a real click on an http(s) link in a frame whose origin is the editor's own (an artboard).
    static func opensInBrowser(_ url: URL, linkActivated: Bool, sourceOrigin: (scheme: String, host: String, port: Int), editorURL: URL?) -> Bool {
        guard linkActivated, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", let editorURL else { return false }
        return sourceOrigin.scheme == editorURL.scheme && sourceOrigin.host == (editorURL.host ?? "") && sourceOrigin.port == (editorURL.port ?? 0)
    }
}
