import Foundation
import OSLog
import Security

/// One-time move of a person's data from the app's previous name (Atelier) to Ocelot's own locations. Runs at
/// launch before anything reads the data (`OcelotApp.init`). Every step is idempotent and a failure is logged,
/// never fatal: the worst outcome is a fresh start, not a broken launch.
///
/// - `~/Library/Application Support/Atelier` becomes `…/Ocelot` (recovery documents, projects.json, run directory,
///   agent directories, asset caches); when `…/Ocelot` already exists the old entries are merged into it without
///   overwriting anything.
/// - UserDefaults of `com.caracal.atelier` are copied into the app's own domain for keys not set there; keys named
///   `atelier.*` become `ocelot.*`. Done once (a marker key), so a preference deleted later does not come back.
/// - Keychain generic passwords stored under the old service names (the fal key) are copied to the new service
///   names and the old items deleted.
///
/// The WKWebView origin changes with the name (`atelier://app` to `ocelot://app`), so UI preferences kept in the
/// editor's localStorage (sidebar width and tab, agent model and effort) reset once; nothing can migrate those.
struct LegacyMigration {
    struct Report: Equatable {
        var movedSupportDirectory = false
        var copiedDefaults = 0
        var movedKeychainItems = 0
        var failures: [String] = []
    }

    static let legacySupportName = "Atelier"
    static let legacyDefaultsDomain = "com.caracal.atelier"
    static let legacyKeychainServices = ["com.caracal.atelier.image-providers"]
    static let legacyDefaultsKeyPrefix = "atelier."
    static let defaultsKeyPrefix = "ocelot."
    /// Set in the new domain once the defaults copy ran.
    static let defaultsMarkerKey = "ocelot.migratedFromAtelier"

    var oldSupportDirectory: URL
    var newSupportDirectory: URL
    var oldDefaultsDomain: String
    var newDefaults: UserDefaults
    /// The persistent domain `newDefaults` writes to (the bundle id for `.standard`, the suite name for a suite).
    var newDefaultsDomain: String
    /// (old service, new service) pairs of Keychain generic passwords.
    var keychainServices: [(old: String, new: String)]

    private let log = Logger(subsystem: "sh.caracal.ocelot", category: "migration")

    /// The real locations. `base` is `~/Library/Application Support`.
    static func standard() -> LegacyMigration {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return LegacyMigration(
            oldSupportDirectory: base.appendingPathComponent(legacySupportName, isDirectory: true),
            newSupportDirectory: base.appendingPathComponent("Ocelot", isDirectory: true),
            oldDefaultsDomain: legacyDefaultsDomain,
            newDefaults: .standard,
            newDefaultsDomain: Bundle.main.bundleIdentifier ?? "sh.caracal.ocelot",
            keychainServices: legacyKeychainServices.map { ($0, FalKeychain.service) }
        )
    }

    /// Unit tests run inside the app and must never touch a real user's data.
    static func runAtLaunch() {
        guard !AppEnvironment.underTest else { return }
        _ = standard().run()
    }

    @discardableResult
    func run() -> Report {
        var report = Report()
        do { report.movedSupportDirectory = try moveSupportDirectory() } catch { fail(&report, "application support: \(error.localizedDescription)") }
        do { report.copiedDefaults = try copyDefaults() } catch { fail(&report, "preferences: \(error.localizedDescription)") }
        for pair in keychainServices {
            do { report.movedKeychainItems += try moveKeychainItems(from: pair.old, to: pair.new) } catch { fail(&report, "keychain \(pair.old): \(error.localizedDescription)") }
        }
        return report
    }

    private func fail(_ report: inout Report, _ message: String) {
        report.failures.append(message)
        log.error("migration from Atelier: \(message, privacy: .public)")
    }

    // MARK: Application Support

    /// Moves the old folder to the new path. When the new folder already exists (the `ocelot` CLI or a test host can
    /// create `run/` before the app ever starts, and a skipped move would strand the old data) the old entries are
    /// merged in instead: an entry that exists on both sides is kept as the new side has it, directories are merged
    /// recursively, and the old folder is removed once empty. Returns whether anything moved.
    func moveSupportDirectory() throws -> Bool {
        let fm = FileManager.default
        var isDirectory: ObjCBool = false
        guard fm.fileExists(atPath: oldSupportDirectory.path, isDirectory: &isDirectory), isDirectory.boolValue else { return false }
        // `attributesOfItem` does not follow symlinks: a dangling link at the new path still counts as "exists".
        guard (try? fm.attributesOfItem(atPath: newSupportDirectory.path)) != nil else {
            try fm.moveItem(at: oldSupportDirectory, to: newSupportDirectory)
            log.notice("moved \(oldSupportDirectory.path, privacy: .public) to \(newSupportDirectory.path, privacy: .public)")
            return true
        }
        let moved = try merge(oldSupportDirectory, into: newSupportDirectory)
        if moved > 0 { log.notice("merged \(moved) entries of \(oldSupportDirectory.path, privacy: .public) into \(newSupportDirectory.path, privacy: .public)") }
        return moved > 0
    }

    private func merge(_ source: URL, into destination: URL) throws -> Int {
        let fm = FileManager.default
        var moved = 0
        for name in try fm.contentsOfDirectory(atPath: source.path) {
            let from = source.appendingPathComponent(name), to = destination.appendingPathComponent(name)
            if (try? fm.attributesOfItem(atPath: to.path)) == nil {
                try fm.moveItem(at: from, to: to)
                moved += 1
                continue
            }
            var fromIsDirectory: ObjCBool = false, toIsDirectory: ObjCBool = false
            if fm.fileExists(atPath: from.path, isDirectory: &fromIsDirectory), fromIsDirectory.boolValue,
               fm.fileExists(atPath: to.path, isDirectory: &toIsDirectory), toIsDirectory.boolValue,
               (try? fm.destinationOfSymbolicLink(atPath: from.path)) == nil {
                moved += try merge(from, into: to)
            }
        }
        // Only an emptied folder goes away; anything left is a conflict that keeps the new side and stays for the user.
        if (try? fm.contentsOfDirectory(atPath: source.path))?.isEmpty == true { try? fm.removeItem(at: source) }
        return moved
    }

    // MARK: UserDefaults

    /// Returns how many keys were copied.
    func copyDefaults() throws -> Int {
        if newDefaults.persistentDomain(forName: newDefaultsDomain)?[Self.defaultsMarkerKey] != nil { return 0 }
        guard let old = UserDefaults(suiteName: oldDefaultsDomain), oldDefaultsDomain != newDefaultsDomain else {
            throw MigrationError("cannot open the old preferences domain \(oldDefaultsDomain)")
        }
        let existing = newDefaults.persistentDomain(forName: newDefaultsDomain) ?? [:]
        var copied = 0
        for (key, value) in old.persistentDomain(forName: oldDefaultsDomain) ?? [:] {
            let target = key.hasPrefix(Self.legacyDefaultsKeyPrefix) ? Self.defaultsKeyPrefix + String(key.dropFirst(Self.legacyDefaultsKeyPrefix.count)) : key
            guard existing[target] == nil else { continue }
            newDefaults.set(value, forKey: target)
            copied += 1
        }
        newDefaults.set(true, forKey: Self.defaultsMarkerKey)
        return copied
    }

    // MARK: Keychain

    /// Copies every generic password of `old` to `new` (a value already stored under `new` wins), then deletes the old
    /// item. Returns how many old items are gone.
    func moveKeychainItems(from old: String, to new: String) throws -> Int {
        guard old != new else { return 0 }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: old,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return 0 }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else {
            throw MigrationError("could not read the old items (error \(status))")
        }
        var moved = 0
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String else { continue }
            // Keychain refuses data and match-all in one query: read each secret on its own.
            var secret: CFTypeRef?
            let read: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: old, kSecAttrAccount as String: account,
                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
            ]
            guard SecItemCopyMatching(read as CFDictionary, &secret) == errSecSuccess, let data = secret as? Data else {
                throw MigrationError("could not read \(account) under \(old); the old item is kept")
            }
            var add: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: new,
                kSecAttrAccount as String: account,
                kSecValueData as String: data,
            ]
            if let label = item[kSecAttrLabel as String] as? String { add[kSecAttrLabel as String] = label.replacingOccurrences(of: "Atelier", with: "Ocelot") }
            let added = SecItemAdd(add as CFDictionary, nil)
            guard added == errSecSuccess || added == errSecDuplicateItem else {
                throw MigrationError("could not store \(account) under \(new) (error \(added)); the old item is kept")
            }
            let removed = SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: old, kSecAttrAccount as String: account] as CFDictionary)
            if removed == errSecSuccess || removed == errSecItemNotFound { moved += 1 }
        }
        return moved
    }
}

struct MigrationError: LocalizedError {
    var errorDescription: String?
    init(_ message: String) { errorDescription = message }
}
