import XCTest

/// Which command client configs launch: `ocelot` only when the one on PATH is this very executable.
final class CLICommandTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-clicommand-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private func makeExecutable(_ name: String, in folder: String) throws -> URL {
        let directory = dir.appendingPathComponent(folder, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(name)
        try "#!/bin/sh\n".write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        return file
    }

    func testUsesTheNameWhenPathHoldsThisVeryExecutable() throws {
        let tool = try makeExecutable("ocelot", in: "app")
        let bin = dir.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: bin.appendingPathComponent("ocelot"), withDestinationURL: tool)
        XCTAssertEqual(CLICommand.forConfigs(executable: tool, searchPath: [dir.appendingPathComponent("empty").path, bin.path]), "ocelot")
    }

    func testAnotherOcelotOnPathDoesNotCount() throws {
        let tool = try makeExecutable("ocelot", in: "app")
        let other = try makeExecutable("ocelot", in: "other")
        XCTAssertEqual(CLICommand.forConfigs(executable: tool, searchPath: [other.deletingLastPathComponent().path]), tool.path)
    }

    func testFallsBackToTheAbsolutePath() throws {
        let tool = try makeExecutable("ocelot", in: "app")
        XCTAssertEqual(CLICommand.forConfigs(executable: tool, searchPath: []), tool.path)
        XCTAssertEqual(CLICommand.searchPath("/a:/b"), ["/a", "/b"])
        XCTAssertEqual(CLICommand.searchPath(nil), [])
    }
}
