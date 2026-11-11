import XCTest
@testable import Ocelot

/// Links clicked in canvas frames: artboards may open the browser, sandboxed code layers may not.
final class SubframeLinksTests: XCTestCase {
    private let editor = URL(string: "ocelot://app/index.html")
    private let web = URL(string: "https://example.com/pricing")!

    func testClickOnAWebLinkInAnArtboardOpensTheBrowser() {
        XCTAssertTrue(SubframeLinks.opensInBrowser(web, linkActivated: true, sourceOrigin: ("ocelot", "app", 0), editorURL: editor))
    }

    func testDevServerOriginMatchesHostAndPort() {
        let dev = URL(string: "http://127.0.0.1:5173/")
        XCTAssertTrue(SubframeLinks.opensInBrowser(web, linkActivated: true, sourceOrigin: ("http", "127.0.0.1", 5173), editorURL: dev))
        XCTAssertFalse(SubframeLinks.opensInBrowser(web, linkActivated: true, sourceOrigin: ("http", "127.0.0.1", 9999), editorURL: dev))
    }

    func testSandboxedCodeLayersAndOtherFramesStaySealed() {
        // A sandboxed frame without allow-same-origin has an opaque origin.
        XCTAssertFalse(SubframeLinks.opensInBrowser(web, linkActivated: true, sourceOrigin: ("", "", 0), editorURL: editor))
        XCTAssertFalse(SubframeLinks.opensInBrowser(web, linkActivated: true, sourceOrigin: ("https", "evil.example", 0), editorURL: editor))
    }

    func testOnlyRealClicksOnWebLinksCount() {
        XCTAssertFalse(SubframeLinks.opensInBrowser(web, linkActivated: false, sourceOrigin: ("ocelot", "app", 0), editorURL: editor))
        for raw in ["file:///etc/passwd", "javascript:alert(1)", "mailto:a@b.c", "data:text/html,x"] {
            XCTAssertFalse(SubframeLinks.opensInBrowser(URL(string: raw)!, linkActivated: true, sourceOrigin: ("ocelot", "app", 0), editorURL: editor), raw)
        }
    }
}
