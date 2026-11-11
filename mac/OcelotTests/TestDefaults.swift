import Foundation

/// Throwaway UserDefaults domains for tests. A domain named by a reverse-DNS string lives in ~/Library/Preferences,
/// and cfprefsd writes it back there (empty) even after `removePersistentDomain`, so every test run used to leave
/// files behind. A domain named by an absolute path keeps its plist at that path instead: these live in a temporary
/// folder and never touch the user's Preferences.
enum TestDefaults {
    private static let folder: URL = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-test-defaults", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    /// A fresh domain name (an absolute path) for `UserDefaults(suiteName:)`.
    static func name(_ label: String) -> String {
        folder.appendingPathComponent("\(label)-\(UUID().uuidString)").path
    }

    static func remove(_ name: String) {
        UserDefaults(suiteName: name)?.removePersistentDomain(forName: name)
        try? FileManager.default.removeItem(atPath: name + ".plist")
    }
}
