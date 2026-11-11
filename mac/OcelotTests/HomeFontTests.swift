import AppKit
import XCTest
@testable import Ocelot

final class HomeFontTests: XCTestCase {
    /// Home's prompt face is the bundled Geist Serif (v1.9.2 static Regular); the system serif is only the fallback for a missing resource.
    func testGeistSerifIsBundledAndRegistered() {
        XCTAssertTrue(HomeFont.isAvailable, "GeistSerif-Regular.ttf is missing from the app bundle or was refused by Core Text")
        XCTAssertNotNil(NSFont(name: "Geist Serif", size: HomeFont.promptSize), "the family name Home asks for is not registered")
    }
}
