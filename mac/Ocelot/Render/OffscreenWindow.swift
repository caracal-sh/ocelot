import AppKit

/// The window an offscreen WKWebView renders in (screenshots, PNG/PDF export, video frames). WebKit only renders in a
/// window that is ordered in, so this one is, but the person must never see it.
///
/// Parking it far outside every screen is not enough: macOS can move a window that sits off every display back onto
/// one, and then the page being rendered showed on the desktop. So the window is also fully transparent (WebKit still
/// renders and snapshots it; `alphaValue` only affects compositing to the screen), refuses to be constrained onto a
/// screen, and is parked again before every render.
@MainActor
final class OffscreenWindow: NSWindow {
    private static let parkedOrigin = NSPoint(x: -32000, y: -32000)

    init(size: NSSize, transparentBackground: Bool = false) {
        super.init(contentRect: NSRect(origin: Self.parkedOrigin, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        isReleasedWhenClosed = false
        alphaValue = 0
        ignoresMouseEvents = true
        hasShadow = false
        isExcludedFromWindowsMenu = true
        collectionBehavior = [.transient, .ignoresCycle, .stationary]
        if transparentBackground {
            isOpaque = false
            backgroundColor = .clear
        }
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Never pulled onto a screen.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }

    /// Resizes the content and moves the window back to its parking spot, wherever the system put it.
    func park(contentSize size: NSSize) {
        setFrame(frameRect(forContentRect: NSRect(origin: Self.parkedOrigin, size: size)), display: false)
    }
}
