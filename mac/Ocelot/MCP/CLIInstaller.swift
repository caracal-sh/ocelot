import AppKit
import Foundation

/// The `ocelot` command-line tool lives inside the app (`Contents/Helpers/ocelot`); "Install command-line
/// tool" symlinks it into `~/.local/bin` (no admin rights needed).
struct CLIInstaller {
    enum Status: Equatable {
        case notInstalled
        case installed
        /// A different file or a link to another copy of the app is in the way.
        case other(String)
    }

    var bundled: URL
    var installDirectory: URL

    init(bundled: URL = Self.bundledURL, installDirectory: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin", isDirectory: true)) {
        self.bundled = bundled
        self.installDirectory = installDirectory
    }

    static var bundledURL: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/ocelot") }

    var link: URL { installDirectory.appendingPathComponent("ocelot") }

    var status: Status {
        let fm = FileManager.default
        guard let dest = try? fm.destinationOfSymbolicLink(atPath: link.path) else {
            return fm.fileExists(atPath: link.path) ? .other("\(link.path) exists and is not a link to Ocelot.") : .notInstalled
        }
        let resolved = URL(fileURLWithPath: dest, relativeTo: link.deletingLastPathComponent()).standardizedFileURL.path
        if resolved == bundled.standardizedFileURL.path { return .installed }
        // A link to another copy of Ocelot (e.g. the Release build when running Debug) is a stale install.
        return .other("\(link.path) points to \(resolved).")
    }

    /// Creates `~/.local/bin/ocelot`. Replaces a link to another copy of the app, never a regular file.
    func install() throws {
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: bundled.path) else {
            throw InstanceDirectory.Failure("The command-line tool is missing from this build (\(bundled.path)). Rebuild Ocelot.")
        }
        try fm.createDirectory(at: installDirectory, withIntermediateDirectories: true)
        if (try? fm.destinationOfSymbolicLink(atPath: link.path)) != nil {
            try fm.removeItem(at: link)
        } else if fm.fileExists(atPath: link.path) {
            throw InstanceDirectory.Failure("\(link.path) already exists and is not a link. Remove it, then install again.")
        }
        try fm.createSymbolicLink(at: link, withDestinationURL: bundled)
    }

    func uninstall() throws {
        if status == .installed { try FileManager.default.removeItem(at: link) }
    }

    /// Whether `~/.local/bin` is on the PATH this process sees (a GUI app sees the login-shell PATH only partially).
    var directoryOnPath: Bool {
        (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").contains { String($0) == installDirectory.path }
    }

    /// What to put in client configs: `ocelot` once installed, else the absolute path of the bundled tool.
    var commandForConfigs: String { CLICommand.forConfigs(executable: bundled, searchPath: [installDirectory.path]) }
}

/// Alerts around `CLIInstaller` (app menu and Settings).
@MainActor
enum CLIInstallerUI {
    static func install() {
        let installer = CLIInstaller()
        let alert = NSAlert()
        do {
            try installer.install()
            alert.messageText = "Installed the ocelot command"
            var info = "\(installer.link.path) now points to this copy of Ocelot. Try: ocelot ls"
            if !installer.directoryOnPath {
                info += "\n\n\(installer.installDirectory.path) is not on your PATH. Add this to your shell profile:\n  export PATH=\"$HOME/.local/bin:$PATH\""
            }
            alert.informativeText = info
        } catch {
            alert.alertStyle = .warning
            alert.messageText = "Could not install the ocelot command"
            alert.informativeText = error.localizedDescription
        }
        alert.runModal()
    }
}
