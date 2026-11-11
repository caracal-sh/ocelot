import AppKit
import Foundation
import os
import WebKit

/// Renders standalone HTML in a hidden WKWebView and returns PNG snapshots.
///
/// Independent of what the user sees: the page is loaded at the artboard's exact
/// CSS size in its own off-screen window. For scale 2 the view is twice as large
/// with `pageZoom = 2`, so the CSS viewport stays the artboard size while the
/// snapshot has twice the pixels.
@MainActor
final class OffscreenRenderer: NSObject {
    static let shared = OffscreenRenderer()

    enum Failure: LocalizedError {
        case loadFailed(String)
        case nodeNotFound(String)
        case snapshotFailed(String)

        var errorDescription: String? {
            switch self {
            case .loadFailed(let s): "Could not load the page for the screenshot: \(s)"
            case .nodeNotFound(let id): "Node \(id) is not rendered (hidden, empty or outside the artboard)."
            case .snapshotFailed(let s): "WebKit could not take the snapshot: \(s)"
            }
        }
    }

    private var window: NSWindow?
    private var webView: WKWebView?
    private var loadContinuation: CheckedContinuation<Void, any Error>?
    private var queueTail: Task<Void, Never>?
    private let log = Logger(subsystem: "sh.caracal.ocelot", category: "snapshot")

    /// Serializes renders: one page load at a time.
    func render(_ req: SnapshotRequest) async throws -> SnapshotResult {
        try await serialized { try await self.renderNow(req) }
    }

    /// One page as a vector PDF (`WKWebView.createPDF`): the page is `width` × `height` points, i.e. the artboard's CSS size.
    /// Text stays text and fonts are embedded; images, gradients and shadows keep what WebKit draws.
    func renderPDF(html: String, width: Double, height: Double) async throws -> Data {
        try await serialized { try await self.renderPDFNow(html: html, width: width, height: height) }
    }

    private func serialized<T: Sendable>(_ work: @escaping @MainActor () async throws -> T) async throws -> T {
        let previous = queueTail
        let task = Task { @MainActor () -> Result<T, any Error> in
            await previous?.value
            do { return .success(try await work()) } catch { return .failure(error) }
        }
        queueTail = Task { _ = await task.value }
        return try await task.value.get()
    }

    private func renderPDFNow(html: String, width: Double, height: Double) async throws -> Data {
        let viewSize = NSSize(width: ceil(width), height: ceil(height))
        let webView = ensureWebView(size: viewSize)
        webView.pageZoom = 1
        Self.setTransparent(false, on: webView)
        try await EditorClient.withTimeout(.seconds(20), method: "pdf load") { @MainActor @Sendable in
            try await self.load(html, in: webView)
        }
        let settleJS = """
        await document.fonts.ready;
        await Promise.all([...document.images].map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; })));
        return true;
        """
        _ = try await EditorClient.withTimeout(.seconds(10), method: "pdf settle") { @MainActor @Sendable () -> Bool in
            (try await webView.callAsyncJavaScript(settleJS, arguments: [:], contentWorld: .page) as? Bool) ?? false
        }
        return try await EditorClient.withTimeout(.seconds(20), method: "pdf") { @MainActor @Sendable () -> Data in
            let config = WKPDFConfiguration()
            config.rect = CGRect(x: 0, y: 0, width: width, height: height)
            return try await webView.pdf(configuration: config)
        }
    }

    /// Lets snapshots keep alpha: no page background is painted. (KVC on the private `drawsBackground`, the long-standing WKWebView switch.)
    private static func setTransparent(_ on: Bool, on webView: WKWebView) {
        webView.setValue(!on, forKey: "drawsBackground")
    }

    private func renderNow(_ req: SnapshotRequest) async throws -> SnapshotResult {
        let scale = max(1, min(req.scale, 3))
        let viewSize = NSSize(width: ceil(req.width * scale), height: ceil(req.height * scale))
        let webView = ensureWebView(size: viewSize)
        webView.pageZoom = scale
        Self.setTransparent(req.transparent == true, on: webView)

        try await EditorClient.withTimeout(.seconds(20), method: "snapshot load") { @MainActor @Sendable in
            try await self.load(req.html, in: webView)
        }

        // Wait for fonts and images, then measure the node and the content size.
        let measureJS = """
        await document.fonts.ready;
        // Code layers (sandboxed frames) post `ocelot:ready` after their first frame.
        if (window.__ocelotCodeReady) await window.__ocelotCodeReady(8000);
        await Promise.all([...document.images].map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; })));
        const root = document.querySelector('[data-ocelot-root]') || document.body;
        const el = nodeId ? document.querySelector('[data-node-id="' + CSS.escape(nodeId) + '"]') : root;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height, root.scrollWidth, root.scrollHeight];
        """
        let measured = try await EditorClient.withTimeout(.seconds(10), method: "snapshot measure") { @MainActor @Sendable () -> [Double]? in
            let value = try await webView.callAsyncJavaScript(measureJS, arguments: ["nodeId": req.nodeId ?? NSNull()], contentWorld: .page)
            return (value as? [NSNumber])?.map(\.doubleValue)
        }
        guard let m = measured, m.count == 6 else { throw Failure.nodeNotFound(req.nodeId ?? "root") }

        // Crop to the node, clamped to the artboard viewport (CSS px).
        let x0 = max(0, m[0]), y0 = max(0, m[1])
        let x1 = min(req.width, m[0] + m[2]), y1 = min(req.height, m[1] + m[3])
        guard x1 > x0, y1 > y0 else { throw Failure.nodeNotFound(req.nodeId ?? "root") }
        let cssRect = CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)

        let pixelsWide = Int((cssRect.width * scale).rounded())
        let pixelsHigh = Int((cssRect.height * scale).rounded())
        let snapshotRect = CGRect(x: cssRect.minX * scale, y: cssRect.minY * scale, width: cssRect.width * scale, height: cssRect.height * scale)
        let png = try await EditorClient.withTimeout(.seconds(10), method: "snapshot") { @MainActor @Sendable () -> Data in
            let config = WKSnapshotConfiguration()
            config.rect = snapshotRect
            config.afterScreenUpdates = true
            config.snapshotWidth = NSNumber(value: Double(snapshotRect.width))
            let image = try await webView.takeSnapshot(configuration: config)
            guard let data = OffscreenRenderer.pngData(image, pixelsWide: pixelsWide, pixelsHigh: pixelsHigh) else {
                throw Failure.snapshotFailed("PNG encoding failed")
            }
            return data
        }
        return SnapshotResult(png: png.base64EncodedString(), width: pixelsWide, height: pixelsHigh, contentWidth: m[4], contentHeight: m[5])
    }

    /// Redraws into a bitmap of exactly the requested pixel size (independent of screen scale).
    static func pngData(_ image: NSImage, pixelsWide: Int, pixelsHigh: Int) -> Data? {
        guard pixelsWide > 0, pixelsHigh > 0,
              let rep = NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: pixelsWide, pixelsHigh: pixelsHigh, bitsPerSample: 8, samplesPerPixel: 4,
                hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return nil }
        rep.size = NSSize(width: pixelsWide, height: pixelsHigh)
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.current = ctx
        ctx.imageInterpolation = .high
        image.draw(in: NSRect(x: 0, y: 0, width: pixelsWide, height: pixelsHigh), from: .zero, operation: .copy, fraction: 1)
        ctx.flushGraphics()
        return rep.representation(using: .png, properties: [:])
    }

    private func ensureWebView(size: NSSize) -> WKWebView {
        if let webView, let window {
            window.setContentSize(size)
            webView.frame = NSRect(origin: .zero, size: size)
            return webView
        }
        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = true
        // Code layers import the vendored libraries from ocelot://app/vendor/ (Release builds).
        config.setURLSchemeHandler(EditorSchemeHandler(root: EditorSource.bundleRoot), forURLScheme: EditorSource.scheme)
        let webView = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        webView.navigationDelegate = self
        // Keep rendering while the window is not visible on any screen.
        // (SPI; KVC resolves the key to -_setWindowOcclusionDetectionEnabled:.)
        if webView.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) {
            webView.setValue(false, forKey: "windowOcclusionDetectionEnabled")
        }
        // Borderless window far outside every screen: never visible, never focusable.
        let window = NSWindow(
            contentRect: NSRect(x: -32000, y: -32000, width: size.width, height: size.height),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.ignoresMouseEvents = true
        window.hasShadow = false
        window.isExcludedFromWindowsMenu = true
        window.collectionBehavior = [.transient, .ignoresCycle, .stationary]
        window.contentView = webView
        window.orderFrontRegardless()
        self.window = window
        self.webView = webView
        return webView
    }

    private func load(_ html: String, in webView: WKWebView) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, any Error>) in
            loadContinuation?.resume(throwing: Failure.loadFailed("superseded"))
            loadContinuation = cont
            // The editor's origin (ocelot://app/): root-relative URLs resolve, so the bundled /fonts/ render in screenshots, PNG and PDF exports.
            webView.loadHTMLString(html, baseURL: EditorSource.bundleURL)
        }
    }

    private func finishLoad(_ result: Result<Void, any Error>) {
        let c = loadContinuation
        loadContinuation = nil
        c?.resume(with: result)
    }
}

extension OffscreenRenderer: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finishLoad(.success(()))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        finishLoad(.failure(Failure.loadFailed(error.localizedDescription)))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        finishLoad(.failure(Failure.loadFailed(error.localizedDescription)))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        // Only the initial document load. Frames (artboard, code layers) may load about:srcdoc and
        // nothing else: a code layer must not navigate itself anywhere.
        if navigationAction.targetFrame?.isMainFrame == false { return navigationAction.request.url?.scheme == "about" ? .allow : .cancel }
        return navigationAction.navigationType == .other ? .allow : .cancel
    }
}
