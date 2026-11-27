import Foundation

/// Which program the sandboxed agent service may start: the omp the person runs, never anything else the app might pass by mistake.
enum OmpExecutable {
    static let refusal = "The sandboxed agent only runs omp. Reinstall omp, or turn on \"Run agent unconfined\" in Settings > Agent."

    /// Nil when `command` (the path omp was found at, e.g. `~/.bun/bin/omp`) is named omp and both paths are absolute; otherwise
    /// what to tell the person. Where the command leads (`resolved`) differs by install: a binary named omp, a version file of a
    /// managed install (`…/omp/versions/19.2.1`), or the package's script for bun and npm installs (`…/dist/cli.js`), and it may
    /// change with any omp release; whether the sandbox can read it is checked when it starts.
    static func problem(command: String, resolved: String) -> String? {
        guard command.hasPrefix("/"), resolved.hasPrefix("/"), (command as NSString).lastPathComponent == "omp" else { return refusal }
        return nil
    }

    /// The directories an omp found at `command` needs on its PATH: its own (a bun install puts bun next to it) and the one of the
    /// `bun` on the person's PATH, so a script omp (`#!/usr/bin/env bun`) finds its runtime. Deduplicated, in that order.
    static func searchPath(command: String, personPath: String, isExecutable: (String) -> Bool) -> [String] {
        var dirs = [(command as NSString).deletingLastPathComponent]
        if let bunDir = personPath.split(separator: ":").map(String.init).first(where: { $0.hasPrefix("/") && isExecutable("\($0)/bun") }) {
            dirs.append(bunDir)
        }
        return dirs.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
    }
}
