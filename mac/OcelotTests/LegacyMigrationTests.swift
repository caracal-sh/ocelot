import Security
import XCTest
@testable import Ocelot

/// The one-time move of Atelier-era user data. Everything runs against
/// temp directories, throwaway suite names and throwaway Keychain service names.
final class LegacyMigrationTests: XCTestCase {
    private var root: URL!
    private var oldSuite: String!
    private var newSuite: String!
    private var oldService: String!
    private var newService: String!

    override func setUpWithError() throws {
        root = try makeTempDirectory("ocelot-migration-tests")
        oldSuite = TestDefaults.name("legacy-old")
        newSuite = TestDefaults.name("legacy-new")
        oldService = "sh.caracal.ocelot.tests.legacy-old.\(UUID().uuidString)"
        newService = "sh.caracal.ocelot.tests.legacy-new.\(UUID().uuidString)"
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        TestDefaults.remove(oldSuite)
        TestDefaults.remove(newSuite)
        for service in [oldService!, newService!] {
            SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
        }
    }

    private var oldSupport: URL { root.appendingPathComponent("Atelier", isDirectory: true) }
    private var newSupport: URL { root.appendingPathComponent("Ocelot", isDirectory: true) }

    private func migration(keychain: Bool = false) -> LegacyMigration {
        LegacyMigration(
            oldSupportDirectory: oldSupport, newSupportDirectory: newSupport,
            oldDefaultsDomain: oldSuite, newDefaults: UserDefaults(suiteName: newSuite)!, newDefaultsDomain: newSuite,
            keychainServices: keychain ? [(oldService, newService)] : []
        )
    }

    private func write(_ text: String, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    // MARK: Application Support

    func testSupportDirectoryMovesWithEverythingInIt() throws {
        try write("[]", to: oldSupport.appendingPathComponent("projects.json"))
        try write("x", to: oldSupport.appendingPathComponent("Recovery/Untitled-1.atelier/document.json"))
        try write("t", to: oldSupport.appendingPathComponent("run/app.token"))

        let report = migration().run()

        XCTAssertTrue(report.movedSupportDirectory)
        XCTAssertTrue(report.failures.isEmpty, "\(report.failures)")
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldSupport.path))
        XCTAssertEqual(try String(contentsOf: newSupport.appendingPathComponent("projects.json"), encoding: .utf8), "[]")
        XCTAssertTrue(DocumentPackage.hasDocument(at: newSupport.appendingPathComponent("Recovery/Untitled-1.atelier")))
        XCTAssertTrue(FileManager.default.fileExists(atPath: newSupport.appendingPathComponent("run/app.token").path))
    }

    /// The CLI (`ocelot serve/run`) or a test host can create the new folder before the app's first launch.
    func testAnExistingNewFolderGetsTheOldEntriesMergedInAndNeverLosesItsOwn() throws {
        try write("old", to: oldSupport.appendingPathComponent("projects.json"))
        try write("old-doc", to: oldSupport.appendingPathComponent("Recovery/Untitled-1.atelier/document.json"))
        try write("old-token", to: oldSupport.appendingPathComponent("run/app.token"))
        try write("old-agent", to: oldSupport.appendingPathComponent("Agent/gateway-home/clients-1.json"))
        try write("new", to: newSupport.appendingPathComponent("projects.json"))
        try write("new-token", to: newSupport.appendingPathComponent("run/app.token"))
        try write("new-run", to: newSupport.appendingPathComponent("run/headless-9.token"))
        try FileManager.default.createDirectory(at: newSupport.appendingPathComponent("Recovery"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: newSupport.appendingPathComponent("Agent/gateway-home/.omp"), withIntermediateDirectories: true)

        let report = migration().run()

        XCTAssertTrue(report.movedSupportDirectory)
        XCTAssertTrue(report.failures.isEmpty, "\(report.failures)")
        func text(_ path: String) -> String? { try? String(contentsOf: newSupport.appendingPathComponent(path), encoding: .utf8) }
        XCTAssertEqual(text("projects.json"), "new", "an entry that exists on both sides stays as the new side has it")
        XCTAssertEqual(text("run/app.token"), "new-token")
        XCTAssertEqual(text("run/headless-9.token"), "new-run")
        XCTAssertEqual(text("Recovery/Untitled-1.atelier/document.json"), "old-doc")
        XCTAssertEqual(text("Agent/gateway-home/clients-1.json"), "old-agent", "directories merge recursively")
        XCTAssertTrue(FileManager.default.fileExists(atPath: newSupport.appendingPathComponent("Agent/gateway-home/.omp").path))
        // The conflicting old files are the only things left; they are not deleted.
        XCTAssertEqual(try String(contentsOf: oldSupport.appendingPathComponent("projects.json"), encoding: .utf8), "old")
        XCTAssertFalse(migration().run().movedSupportDirectory, "a second run finds nothing left to move")
    }

    func testAFullyMergedOldFolderDisappearsAndAFreshMachineCreatesNothing() throws {
        try write("old", to: oldSupport.appendingPathComponent("Recovery/a/document.json"))
        try FileManager.default.createDirectory(at: newSupport.appendingPathComponent("Recovery"), withIntermediateDirectories: true)
        XCTAssertTrue(migration().run().movedSupportDirectory)
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldSupport.path), "nothing left: the old folder is removed")

        // Fresh machine: neither exists.
        try FileManager.default.removeItem(at: newSupport)
        let fresh = migration().run()
        XCTAssertFalse(fresh.movedSupportDirectory)
        XCTAssertTrue(fresh.failures.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: newSupport.path), "an empty install creates nothing")
    }

    func testSecondRunAfterAMoveDoesNothing() throws {
        try write("1", to: oldSupport.appendingPathComponent("projects.json"))
        let m = migration()
        XCTAssertTrue(m.run().movedSupportDirectory)
        let again = m.run()
        XCTAssertFalse(again.movedSupportDirectory)
        XCTAssertEqual(again.copiedDefaults, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: newSupport.appendingPathComponent("projects.json").path))
    }

    func testAFailedMoveIsReportedNotThrown() throws {
        try write("1", to: oldSupport.appendingPathComponent("projects.json"))
        // A parent that is not a directory: the move cannot succeed.
        let blocker = root.appendingPathComponent("file")
        try write("", to: blocker)
        var m = migration()
        m.newSupportDirectory = blocker.appendingPathComponent("Ocelot")
        let report = m.run()
        XCTAssertFalse(report.movedSupportDirectory)
        XCTAssertEqual(report.failures.count, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: oldSupport.appendingPathComponent("projects.json").path), "the old data stays where it was")
    }

    // MARK: UserDefaults

    func testDefaultsAreCopiedForKeysNotSetYetAndPrefixedKeysAreRenamed() throws {
        let old = UserDefaults(suiteName: oldSuite)!
        old.set(7777, forKey: "mcp.port")
        old.set("1440 900", forKey: "NSWindow Frame home")
        old.set(Data([1, 2, 3]), forKey: "atelier.recentDocuments")
        old.set(true, forKey: "atelier.agent.unconfined")
        old.set("old-model", forKey: "atelier.image.defaultModel")
        let new = UserDefaults(suiteName: newSuite)!
        new.set("chosen-in-ocelot", forKey: "ocelot.image.defaultModel")

        let report = migration().run()

        XCTAssertEqual(report.copiedDefaults, 4)
        XCTAssertEqual(new.integer(forKey: "mcp.port"), 7777)
        XCTAssertEqual(new.string(forKey: "NSWindow Frame home"), "1440 900")
        XCTAssertEqual(new.data(forKey: "ocelot.recentDocuments"), Data([1, 2, 3]))
        XCTAssertTrue(new.bool(forKey: "ocelot.agent.unconfined"))
        XCTAssertEqual(new.string(forKey: "ocelot.image.defaultModel"), "chosen-in-ocelot", "a key that is already set wins")
        XCTAssertNil(new.object(forKey: "atelier.recentDocuments"))
        XCTAssertNotNil(old.object(forKey: "mcp.port"), "the old domain is left untouched")
    }

    func testDefaultsAreCopiedOnceSoADeletedPreferenceDoesNotComeBack() throws {
        let old = UserDefaults(suiteName: oldSuite)!
        old.set("a", forKey: "atelier.image.defaultModel")
        let new = UserDefaults(suiteName: newSuite)!
        let m = migration()
        XCTAssertEqual(m.run().copiedDefaults, 1)
        new.removeObject(forKey: "ocelot.image.defaultModel")
        XCTAssertEqual(m.run().copiedDefaults, 0)
        XCTAssertNil(new.object(forKey: "ocelot.image.defaultModel"))
    }

    func testMissingOldDefaultsAreFine() throws {
        let report = migration().run()
        XCTAssertEqual(report.copiedDefaults, 0)
        XCTAssertTrue(report.failures.isEmpty)
    }

    // MARK: Keychain

    private func keychainItem(service: String, account: String) -> String? {
        var out: CFTypeRef?
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    private func addKeychainItem(service: String, account: String, value: String) throws {
        let status = SecItemAdd([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecValueData as String: Data(value.utf8), kSecAttrLabel as String: "Atelier fal.ai key"] as CFDictionary, nil)
        if status != errSecSuccess { throw XCTSkip("Keychain not writable in this environment (error \(status))") }
    }

    func testKeychainItemsMoveToTheNewServiceAndTheOldOnesAreDeleted() throws {
        try addKeychainItem(service: oldService, account: "fal", value: "secret-1")
        try addKeychainItem(service: oldService, account: "other", value: "secret-2")

        let report = migration(keychain: true).run()

        XCTAssertTrue(report.failures.isEmpty, "\(report.failures)")
        XCTAssertEqual(report.movedKeychainItems, 2)
        XCTAssertEqual(keychainItem(service: newService, account: "fal"), "secret-1")
        XCTAssertEqual(keychainItem(service: newService, account: "other"), "secret-2")
        XCTAssertNil(keychainItem(service: oldService, account: "fal"))
        XCTAssertNil(keychainItem(service: oldService, account: "other"))
        XCTAssertEqual(migration(keychain: true).run().movedKeychainItems, 0, "idempotent")
    }

    func testAKeyAlreadyStoredUnderTheNewServiceIsNotOverwritten() throws {
        try addKeychainItem(service: oldService, account: "fal", value: "old")
        try addKeychainItem(service: newService, account: "fal", value: "new")
        _ = migration(keychain: true).run()
        XCTAssertEqual(keychainItem(service: newService, account: "fal"), "new")
        XCTAssertNil(keychainItem(service: oldService, account: "fal"))
    }
}
