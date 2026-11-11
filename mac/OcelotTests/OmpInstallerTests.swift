import XCTest
@testable import Ocelot

final class OmpInstallerTests: XCTestCase {
    func testBunInstallsOmpDirectly() {
        let plan = OmpInstaller.plan(bun: true, npm: true, path: "/usr/bin")
        XCTAssertEqual(plan.installer, "bun")
        XCTAssertEqual(plan.command, "bun install -g @oh-my-pi/pi-coding-agent")
    }

    func testNpmInstallsBunFirst() {
        let plan = OmpInstaller.plan(bun: false, npm: true, path: "/usr/bin")
        XCTAssertEqual(plan.installer, "npm")
        XCTAssertEqual(plan.command, "npm install -g bun && bun install -g @oh-my-pi/pi-coding-agent")
    }

    func testNeitherUsesTheBunInstaller() {
        let plan = OmpInstaller.plan(bun: false, npm: false, path: "/usr/bin")
        XCTAssertEqual(plan.installer, "none")
        XCTAssertTrue(plan.command.hasPrefix("curl -fsSL https://bun.sh/install | bash && "))
        XCTAssertTrue(plan.command.hasSuffix("bun install -g @oh-my-pi/pi-coding-agent"))
    }
}
