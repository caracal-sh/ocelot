import XCTest
@testable import Ocelot

/// `host.openURL` only ever opens web and mail links.
final class ExternalURLTests: XCTestCase {
    func testAcceptsHttpsHttpAndMailto() throws {
        XCTAssertEqual(try ExternalURL.validated("https://example.com/pricing?a=1#top").absoluteString, "https://example.com/pricing?a=1#top")
        XCTAssertEqual(try ExternalURL.validated("http://localhost:3000/x").host, "localhost")
        XCTAssertEqual(try ExternalURL.validated("mailto:hi@example.com").scheme, "mailto")
        XCTAssertEqual(try ExternalURL.validated("mailto:hi@example.com?subject=Hello").absoluteString, "mailto:hi@example.com?subject=Hello")
    }

    func testSchemeIsCaseInsensitiveAndInputIsTrimmed() throws {
        XCTAssertEqual(try ExternalURL.validated("HTTPS://Example.com").host, "Example.com")
        XCTAssertEqual(try ExternalURL.validated("MailTo:hi@example.com").scheme?.lowercased(), "mailto")
        XCTAssertEqual(try ExternalURL.validated("  https://example.com \n").host, "example.com")
    }

    func testRejectsOtherSchemes() {
        for link in ["javascript:alert(1)", "JavaScript:alert(1)", "file:///etc/passwd", "data:text/html,<b>x</b>", "ocelot://app/index.html", "ftp://example.com", "tel:+123", "x-apple.systempreferences:"] {
            assertRejected(link)
        }
    }

    func testRejectsEmptyAndMalformed() {
        for link in ["", "   ", "example.com", "/relative/path", "not a url", "https://"] {
            assertRejected(link)
        }
    }

    func testRejectsHttpWithoutHostAndMailtoWithoutAddress() {
        assertRejected("http:///path")
        assertRejected("https:path")
        assertRejected("mailto:")
        assertRejected("mailto:?subject=Hi")
    }

    func testErrorsSayWhatToDoNext() {
        XCTAssertThrowsError(try ExternalURL.validated("javascript:alert(1)")) { error in
            let failure = error as? BridgeFailure
            XCTAssertEqual(failure?.code, .invalidParams)
            XCTAssertTrue(failure?.message.contains("Only http, https and mailto links can be opened") == true)
            XCTAssertTrue(failure?.message.contains("https://example.com") == true)
        }
    }

    private func assertRejected(_ link: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try ExternalURL.validated(link), "\(link) should be rejected", file: file, line: line) { error in
            XCTAssertEqual((error as? BridgeFailure)?.code, .invalidParams, file: file, line: line)
        }
    }
}
