import AppKit
import Foundation

/// The `ocelot` command-line tool lives inside the app (`Contents/Helpers/ocelot`); "Install command-line
/// tool" symlinks it into `~/.local/bin` (no admin rights needed) and, when no shell startup file mentions that
/// directory yet, appends one PATH line to the login shell's startup file, so new terminal windows find `ocelot`.
struct CLIInstaller {
    enum Status: Equatable {
        case notInstalled
        case installed
        /// A different file or a link to another copy of the app is in the way.
        case other(String)
    }

    var bundled: URL
    var installDirectory: URL
    var home: URL
    /// The user's login shell (`$SHELL`); picks the startup file.
    var shell: String

    init(
        bundled: URL = Self.bundledURL,
        installDirectory: URL? = nil,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        shell: String = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    ) {
        self.bundled = bundled
        self.home = home
        self.installDirectory = installDirectory ?? home.appendingPathComponent(".local/bin", isDirectory: true)
        self.shell = shell
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

    /// Creates `~/.local/bin/ocelot`. Replaces a link to another copy of the app, never a regular file. Returns the
    /// startup file it added the PATH line to, or nil when the directory was already on PATH.
    @discardableResult
    func install() throws -> URL? {
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
        return try addToPath()
    }

    /// Removes the link. The PATH line stays: other tools in `~/.local/bin` may rely on it by now.
    func uninstall() throws {
        if status == .installed { try FileManager.default.removeItem(at: link) }
    }

    /// The startup file new terminal windows read: `~/.zshrc` (zsh, the macOS default), `~/.bash_profile` (bash,
    /// Terminal opens login shells), a `conf.d` file for fish, else `~/.profile`.
    var profile: URL {
        switch (shell as NSString).lastPathComponent {
        case "zsh": home.appendingPathComponent(".zshrc")
        case "bash": home.appendingPathComponent(".bash_profile")
        case "fish": home.appendingPathComponent(".config/fish/conf.d/ocelot.fish")
        default: home.appendingPathComponent(".profile")
        }
    }

    /// `$HOME/.local/bin` when the directory is under home (the file stays valid if home moves), else the full path.
    private var directoryInShell: String {
        let base = home.standardizedFileURL.path + "/"
        let dir = installDirectory.standardizedFileURL.path
        return dir.hasPrefix(base) ? "$HOME/" + dir.dropFirst(base.count) : dir
    }

    /// Whether new shells already get the install directory: this process's PATH has it, or a startup file of any
    /// common shell mentions it (`.local/bin` itself; also catches `. "$HOME/.local/bin/env"` style installers).
    var directoryOnPath: Bool {
        let dir = installDirectory.standardizedFileURL.path
        if (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").contains(where: { String($0) == dir }) { return true }
        let needle = directoryInShell.hasPrefix("$HOME/") ? String(directoryInShell.dropFirst("$HOME/".count)) : dir
        let files = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".bash_profile", ".bash_login", ".bashrc", ".profile", ".config/fish/config.fish"]
            .map { home.appendingPathComponent($0) } + [profile]
        return files.contains { (try? String(contentsOf: $0, encoding: .utf8))?.contains(needle) == true }
    }

    static let pathMarker = "# Added by Ocelot: the ocelot command (Settings > MCP > Command-line tool)"

    /// Appends the PATH line to `profile` unless the directory is already on PATH. Returns the file it changed.
    @discardableResult
    func addToPath() throws -> URL? {
        if directoryOnPath { return nil }
        let line = (shell as NSString).lastPathComponent == "fish"
            ? "fish_add_path -g \"\(directoryInShell)\""
            : "export PATH=\"\(directoryInShell):$PATH\""
        let file = profile
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let existing = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
            let separator = existing.isEmpty ? "" : (existing.hasSuffix("\n") ? "\n" : "\n\n")
            try (existing + separator + Self.pathMarker + "\n" + line + "\n").write(to: file, atomically: true, encoding: .utf8)
        } catch {
            throw InstanceDirectory.Failure("Installed \(link.path), but could not add \(installDirectory.path) to your PATH in \(file.path) (\(error.localizedDescription)). Add this line to your shell profile: \(line)")
        }
        return file
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
            let profile = try installer.install()
            alert.messageText = "Installed the ocelot command"
            let shown = profile.map { $0.path.replacingOccurrences(of: installer.home.path, with: "~") }
            alert.informativeText = shown.map { "Added ~/.local/bin to your PATH in \($0). Open a new terminal window and try: ocelot ls" }
                ?? "Try it in a terminal: ocelot ls"
        } catch {
            alert.alertStyle = .warning
            alert.messageText = "Could not install the ocelot command"
            alert.informativeText = error.localizedDescription
        }
        alert.runModal()
    }
}
