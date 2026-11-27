import XCTest
@testable import Ocelot

/// The sandboxed agent service starts what the person runs as `omp`. Where that leads depends on how omp was installed and can
/// change with any release, so the service checks the name omp was found under, not the file it resolves to.
final class OmpExecutableTests: XCTestCase {
    func testAcceptsEveryWayOmpIsInstalled() {
        // omp's installer, binary mode: one file named omp.
        XCTAssertNil(OmpExecutable.problem(command: "/h/.local/bin/omp", resolved: "/h/.local/bin/omp"))
        // A managed install: one file per version behind ~/.local/bin/omp.
        XCTAssertNil(OmpExecutable.problem(command: "/h/.local/bin/omp", resolved: "/h/Library/Application Support/Tern/omp/versions/19.2.1"))
        // bun install -g (what Ocelot's own installer runs) and npm install -g: the package's script.
        XCTAssertNil(OmpExecutable.problem(command: "/h/.bun/bin/omp", resolved: "/h/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"))
        XCTAssertNil(OmpExecutable.problem(command: "/opt/homebrew/bin/omp", resolved: "/opt/homebrew/lib/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"))
    }

    func testRefusesAnythingNotFoundAsOmp() {
        XCTAssertEqual(OmpExecutable.problem(command: "/bin/sh", resolved: "/bin/sh"), OmpExecutable.refusal)
        XCTAssertEqual(OmpExecutable.problem(command: "omp", resolved: "/h/.local/bin/omp"), OmpExecutable.refusal)
        XCTAssertEqual(OmpExecutable.problem(command: "/h/.local/bin/omp", resolved: "omp"), OmpExecutable.refusal)
        XCTAssertEqual(OmpExecutable.problem(command: "/h/.local/bin/omp-old", resolved: "/h/.local/bin/omp-old"), OmpExecutable.refusal)
    }

    func testSearchPathHasOmpsFolderThenTheFolderOfBun() {
        let bun: Set<String> = ["/h/.bun/bin/bun", "/opt/homebrew/bin/bun"]
        // bun install: bun lives next to omp, one entry.
        XCTAssertEqual(OmpExecutable.searchPath(command: "/h/.bun/bin/omp", personPath: "/usr/bin:/h/.bun/bin", isExecutable: bun.contains), ["/h/.bun/bin"])
        // npm install under Homebrew with bun elsewhere on the person's PATH: the first bun wins.
        XCTAssertEqual(OmpExecutable.searchPath(command: "/usr/local/bin/omp", personPath: "relative:/h/.bun/bin:/opt/homebrew/bin", isExecutable: bun.contains), ["/usr/local/bin", "/h/.bun/bin"])
        // A binary omp and no bun: just its own folder.
        XCTAssertEqual(OmpExecutable.searchPath(command: "/h/.local/bin/omp", personPath: "/usr/bin:/bin", isExecutable: { _ in false }), ["/h/.local/bin"])
    }
}
