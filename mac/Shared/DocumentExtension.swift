import Foundation

/// File extensions of document packages. `.ocelot` is what Ocelot creates; `.atelier` is what the app wrote while it was
/// called Atelier: same package layout, still opened, and saved back to the same file (never renamed behind the
/// user's back). Shared by the app and the `ocelot` CLI so both accept the same set.
enum DocumentExtension {
    static let current = "ocelot"
    static let legacy = "atelier"
    static let all = [current, legacy]

    static func matches(pathExtension ext: String) -> Bool {
        all.contains(ext.lowercased())
    }

    static func matches(_ url: URL) -> Bool {
        matches(pathExtension: url.pathExtension)
    }

    /// For a plain path string (the CLI works on strings); trailing slashes are ignored.
    static func matches(path: String) -> Bool {
        matches(pathExtension: (path as NSString).pathExtension)
    }
}
