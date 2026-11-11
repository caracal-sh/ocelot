import XCTest
@testable import Ocelot

/// The gateway's `clients-<pid>-<id>.json` files: a killed Ocelot leaves its file behind, the next start removes it.
final class GatewayClientFilesTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("gateway-files-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func touch(_ name: String) throws {
        try Data("{}".utf8).write(to: dir.appendingPathComponent(name))
    }

    private func names() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).sorted()
    }

    func testParsesThePidOutOfTheFileName() {
        XCTAssertEqual(GatewayClientFiles.pid(ofFileNamed: "clients-123-ab12cd.json"), 123)
        XCTAssertEqual(GatewayClientFiles.pid(ofFileNamed: "clients-123-ab12cd.json.tmp"), 123)
        XCTAssertNil(GatewayClientFiles.pid(ofFileNamed: "clients-1.json"))
        XCTAssertNil(GatewayClientFiles.pid(ofFileNamed: "clients-x-ab12cd.json"))
        XCTAssertNil(GatewayClientFiles.pid(ofFileNamed: "notes-123-ab12cd.json"))
        XCTAssertNil(GatewayClientFiles.pid(ofFileNamed: ".omp"))
    }

    func testKeepsALiveProcessAndRemovesDeadOnesAndTheirTmpFiles() throws {
        let me = ProcessInfo.processInfo.processIdentifier
        // A pid that exited: spawn `true`, wait, reuse its number (unused at this moment).
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try child.run()
        child.waitUntilExit()
        let dead = child.processIdentifier
        XCTAssertFalse(GatewayClientFiles.isRunning(dead))
        XCTAssertTrue(GatewayClientFiles.isRunning(me))

        try touch("clients-\(me)-aaaaaa.json")
        try touch("clients-\(me)-aaaaaa.json.tmp")
        try touch("clients-\(dead)-bbbbbb.json")
        try touch("clients-\(dead)-bbbbbb.json.tmp")
        try touch("auth-gateway.token")

        let removed = GatewayClientFiles.removeStale(in: dir)

        XCTAssertEqual(removed, ["clients-\(dead)-bbbbbb.json", "clients-\(dead)-bbbbbb.json.tmp"])
        XCTAssertEqual(names(), ["auth-gateway.token", "clients-\(me)-aaaaaa.json", "clients-\(me)-aaaaaa.json.tmp"].sorted())
    }

    func testAMissingDirectoryIsNotAnError() {
        XCTAssertEqual(GatewayClientFiles.removeStale(in: dir.appendingPathComponent("nope")), [])
    }

    func testTheTestHostDoesNotLookForOmp() async {
        XCTAssertTrue(AppEnvironment.underTest)
        let cli = await OmpLocator.shared.cli()
        XCTAssertNil(cli, "locating omp starts the user's login shell; the XCTest host must not")
    }
}
