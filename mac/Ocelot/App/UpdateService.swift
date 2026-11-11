import AppKit
import Foundation
import Sparkle
import SwiftUI

/// Sparkle 2 behind one small type. Update checks are the documented exception to "no network":
/// only GitHub (the appcast, and, when the user accepts, the DMG) is contacted, never
/// with document data. Sparkle shows its standard consent prompt on the second launch; the user can turn automatic
/// checks off in Settings > Updates, and "Check for Updates…" is always explicit.
///
/// Ocelot's releases are on GitHub, either in a private repo or a public one; which one is a build setting
/// (`UpdateConfig`). Private: every request carries the token of the user's own GitHub CLI session
/// (`GitHubUpdateAuth`). Before each check, manual or scheduled, `preflight()` makes sure there is such a
/// token and that the repo is readable; only then does Sparkle run, so it never shows a generic network error.
/// Scheduled checks that cannot pass the preflight stay silent; the reason is shown in Settings > Updates, and a
/// manual check explains what to do. Public: plain URLs, no token, no preflight; Sparkle runs directly.
///
/// Sparkle only starts when the bundle carries a public EdDSA key (`SPARKLE_PUBLIC_ED_KEY`, set for Release builds)
/// and a usable update repo. Debug builds, unit tests and builds without a key stay unconfigured: no network, and
/// the menu item says why. Whatever the mode, an update is only installed when its EdDSA signature matches the key.
@MainActor
final class UpdateService: ObservableObject {
    static let shared = UpdateService()

    /// Test hook: `defaults write sh.caracal.ocelot OcelotUpdateFeedURLOverride
    /// http://127.0.0.1:PORT/…` (or `-OcelotUpdateFeedURLOverride …` on the command line) replaces the feed.
    /// Only loopback URLs are honoured, so the GitHub token can never be sent to another host this way; the
    /// reachability probe of the real repo is skipped, the update is still verified against `SUPublicEDKey`.
    static let feedOverrideKey = "OcelotUpdateFeedURLOverride"

    /// A preflight result is trusted this long; checks inside the window do not repeat it.
    private static let grantLifetime: TimeInterval = 300

    /// Where this build's updates come from; nil when Info.plist names no usable repo (then updates are unconfigured).
    let config: UpdateConfig?
    private let controller: SPUStandardUpdaterController?
    private let delegate = UpdateDelegate()
    private var observation: NSKeyValueObservation?
    private var preflightTask: Task<UpdateAccess, Never>?
    private var grant: (token: String, date: Date)?
    private var restartBackgroundCheck = false

    /// A check can start now (false while one is running, or when unconfigured).
    @Published private(set) var canCheck = false
    @Published private(set) var automaticChecks = false
    @Published private(set) var lastCheck: Date?
    @Published private(set) var access: UpdateAccess = .unknown

    var isConfigured: Bool { controller != nil }

    /// The loopback test feed, if one is set (see `feedOverrideKey`).
    static var feedOverride: URL? {
        guard let raw = UserDefaults.standard.string(forKey: feedOverrideKey), let url = URL(string: raw),
              url.scheme == "http" || url.scheme == "https",
              let host = url.host, ["127.0.0.1", "localhost", "::1"].contains(host) else { return nil }
        return url
    }

    private init() {
        let config = UpdateConfig.current
        self.config = config
        let key = (Bundle.main.infoDictionary?["SUPublicEDKey"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        guard config != nil, !key.isEmpty, !AppEnvironment.underTest else {
            controller = nil
            return
        }
        let controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: delegate, userDriverDelegate: nil)
        self.controller = controller
        delegate.service = self
        controller.startUpdater()
        automaticChecks = controller.updater.automaticallyChecksForUpdates
        lastCheck = controller.updater.lastUpdateCheckDate
        observation = controller.updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] _, change in
            let can = change.newValue ?? false
            Task { @MainActor in self?.canCheck = can }
        }
    }

    // MARK: Access

    /// Private repo: reads the token and asks GitHub whether the repo is readable. Concurrent callers share one run.
    /// Public repo: ready at once, nothing read, nothing asked.
    @discardableResult
    func preflight() async -> UpdateAccess {
        guard let config else { return access }
        guard config.needsAuth else {
            access = .ready
            return .ready
        }
        if let preflightTask { return await preflightTask.value }
        access = .checking
        let checkRepo = Self.feedOverride == nil
        let task = Task { () -> UpdateAccess in
            let result = await Task.detached { await GitHubUpdateAuth.preflight(config: config, checkRepo: checkRepo) }.value
            access = result.access
            grant = result.token.map { ($0, Date()) }
            preflightTask = nil
            return result.access
        }
        preflightTask = task
        return await task.value
    }

    /// Settings opens: show what can be known without asking GitHub (is `gh` there, is it signed in). Private repo only.
    func refreshLocalAccess() async {
        guard isConfigured, config?.needsAuth == true, preflightTask == nil, access == .unknown || access == .ghMissing || access == .notSignedIn else { return }
        switch await Task.detached(operation: { GitHubUpdateAuth.readToken() }).value {
        case .ghMissing: access = .ghMissing
        case .notSignedIn: access = .notSignedIn
        case .token: if access == .ghMissing { access = .unknown } // a 401 or 403 from GitHub stays until the next check
        }
    }

    private var freshGrant: String? {
        guard let grant, Date().timeIntervalSince(grant.date) < Self.grantLifetime else { return nil }
        return grant.token
    }

    // MARK: Sparkle hooks (called by UpdateDelegate)

    /// `updater(_:mayPerform:)`: runs before every check, manual and scheduled. Private repo: sets the GitHub headers from the
    /// current grant. A scheduled check without a fresh grant is dropped quietly, the preflight runs, and the check
    /// restarts once the aborted cycle has finished (`cycleFinished`). Public repo: no headers, nothing to wait for.
    func authorize(_ updater: SPUUpdater, check: SPUUpdateCheck) throws {
        guard let config, config.needsAuth else {
            updater.httpHeaders = nil
            return
        }
        if let headers = GitHubUpdateAuth.feedHeaders(config: config, token: freshGrant) {
            updater.httpHeaders = headers
            return
        }
        updater.httpHeaders = nil
        if check == .updatesInBackground { restartBackgroundCheck = true }
        throw NSError(domain: "sh.caracal.ocelot.update", code: 1, userInfo: [
            NSLocalizedDescriptionKey: access.message(repo: config.repo) ?? "Ocelot is verifying your GitHub access first. Try again in a moment.",
        ])
    }

    /// `updater(_:willDownloadUpdate:withRequest:)`: private repo only. Sparkle has copied `httpHeaders` (the Authorization) onto the
    /// request; the release asset API needs `Accept: application/octet-stream` (it answers JSON otherwise), and a
    /// token that is old by the time the user clicks "Install" is read again. A public repo's download URL gets no headers.
    func prepareDownload(_ request: NSMutableURLRequest) {
        guard let config, config.needsAuth else { return }
        var token = grant?.token
        if grant.map({ Date().timeIntervalSince($0.date) >= Self.grantLifetime }) ?? true, case .token(let fresh) = GitHubUpdateAuth.readToken() {
            token = fresh
            grant = (fresh, Date())
        }
        for (field, value) in GitHubUpdateAuth.downloadHeaders(config: config, token: token) ?? [:] {
            request.setValue(value, forHTTPHeaderField: field)
        }
    }

    /// `updater(_:didFinishUpdateCycleFor:error:)`: the cycle is over, so the token is dropped from memory.
    func cycleFinished(_ updater: SPUUpdater) {
        lastCheck = updater.lastUpdateCheckDate
        if restartBackgroundCheck {
            restartBackgroundCheck = false
            Task {
                if await preflight() == .ready { updater.checkForUpdatesInBackground() }
            }
            return
        }
        grant = nil
        updater.httpHeaders = nil
    }

    // MARK: Actions

    /// Menu action: preflight, then the standard Sparkle flow (progress, release notes, install).
    func checkForUpdates() {
        guard let controller else {
            let alert = NSAlert()
            alert.messageText = "This build has no update feed"
            alert.informativeText = "Updates are only enabled in signed release builds. Install the latest release (see the README) and replace this app."
            let releases = config?.releasesURL
            if releases != nil { alert.addButton(withTitle: "Open Releases Page") }
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn, let releases { NSWorkspace.shared.open(releases) }
            return
        }
        Task {
            let result = freshGrant == nil ? await preflight() : UpdateAccess.ready
            guard result == .ready else {
                showAccessAlert(result)
                return
            }
            controller.checkForUpdates(nil)
        }
    }

    private func showAccessAlert(_ result: UpdateAccess) {
        let alert = NSAlert()
        alert.messageText = "Can't check for updates"
        alert.informativeText = result.message(repo: config?.repo ?? "the releases repo")?.replacingOccurrences(of: "`", with: "\"") ?? "Try again in a moment."
        alert.addButton(withTitle: "OK")
        if result.fixCommand != nil { alert.addButton(withTitle: "Copy Command") }
        let response = alert.runModal()
        if response == .alertSecondButtonReturn, let command = result.fixCommand {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(command, forType: .string)
        }
    }

    /// What a silent probe found (MCP `check_for_updates`): nothing is shown, downloaded or installed.
    struct Probe: Equatable {
        enum Status: String { case upToDate = "up-to-date", available, unavailable }
        var status: Status
        var current = AppInfo.version
        var latest: String?
        var notes: String?
        var reason: String?

        static func unavailable(_ reason: String) -> Probe { Probe(status: .unavailable, reason: reason) }
    }

    private var probeContinuation: CheckedContinuation<Probe, Never>?

    /// Asks the feed whether a newer version exists, without UI (`checkForUpdateInformation`); the person installs from the menu.
    func probe() async -> Probe {
        guard let controller else { return .unavailable("This build has no update feed (development and unsigned builds never contact an update server). Install a signed release.") }
        guard probeContinuation == nil else { return .unavailable("An update check is already running. Try again in a moment.") }
        let access = freshGrant == nil ? await preflight() : UpdateAccess.ready
        guard access == .ready else { return .unavailable(access.message(repo: config?.repo ?? "the releases repo")?.replacingOccurrences(of: "`", with: "\"") ?? "Ocelot is verifying GitHub access. Try again in a moment.") }
        guard controller.updater.canCheckForUpdates else { return .unavailable("An update check or install is already in progress (see the Ocelot window).") }
        return await withCheckedContinuation { continuation in
            probeContinuation = continuation
            controller.updater.checkForUpdateInformation()
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(60))
                self?.finishProbe(.unavailable("The update feed did not answer within 60 seconds."))
            }
        }
    }

    func finishProbe(_ result: Probe) {
        probeContinuation?.resume(returning: result)
        probeContinuation = nil
    }

    func setAutomaticChecks(_ on: Bool) {
        guard let controller else { return }
        controller.updater.automaticallyChecksForUpdates = on
        automaticChecks = on
    }

    func refreshState() {
        guard let controller else { return }
        automaticChecks = controller.updater.automaticallyChecksForUpdates
        lastCheck = controller.updater.lastUpdateCheckDate
    }
}

/// The Sparkle hooks, kept apart so `UpdateService` stays the only place that holds state.
@MainActor
final class UpdateDelegate: NSObject, SPUUpdaterDelegate {
    weak var service: UpdateService?

    func feedURLString(for updater: SPUUpdater) -> String? {
        (UpdateService.feedOverride ?? service?.config?.feedURL)?.absoluteString
    }

    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        try service?.authorize(updater, check: updateCheck)
    }

    func updater(_ updater: SPUUpdater, willDownloadUpdate item: SUAppcastItem, with request: NSMutableURLRequest) {
        service?.prepareDownload(request)
    }

    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: (any Error)?) {
        // A silent probe that heard nothing else ends here: an error is "unavailable", no error means nothing newer.
        service?.finishProbe(error.map { .unavailable($0.localizedDescription) } ?? UpdateService.Probe(status: .upToDate))
        service?.cycleFinished(updater)
    }

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        service?.finishProbe(UpdateService.Probe(status: .available, latest: item.displayVersionString, notes: item.releaseNotesURL?.absoluteString))
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        service?.finishProbe(UpdateService.Probe(status: .upToDate))
    }
}

/// Settings > Updates.
struct UpdatesSettingsView: View {
    @ObservedObject var service: UpdateService

    var body: some View {
        Form {
            Section {
                Toggle("Automatically check for updates", isOn: Binding(get: { service.automaticChecks }, set: { service.setAutomaticChecks($0) }))
                    .disabled(!service.isConfigured)
                HStack {
                    Button("Check Now") { service.checkForUpdates() }
                        .disabled(service.isConfigured && (!service.canCheck || service.access == .checking))
                    Spacer()
                    if service.isConfigured {
                        Text(statusLine)
                            .foregroundStyle(.secondary)
                    }
                }
                if service.isConfigured, service.config?.needsAuth == true, let message = service.access.message(repo: service.config?.repo ?? "the releases repo") {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        Text(LocalizedStringKey(message))
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        if let command = service.access.fixCommand {
                            Button("Copy Command") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(command, forType: .string)
                            }
                        }
                    }
                    .accessibilityIdentifier("updates-access-message")
                }
            } header: {
                Text("Updates")
            } footer: {
                Text(footer)
            }
        }
        .formStyle(.grouped)
        .frame(width: 560)
        .onAppear { service.refreshState() }
        .task { await service.refreshLocalAccess() }
    }

    private var statusLine: String {
        if service.access == .checking { return "Checking GitHub access…" }
        return service.lastCheck.map { "Last checked \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "Never checked"
    }

    private var footer: String {
        guard service.isConfigured else {
            return "This build has no update feed (development and unsigned builds never contact an update server). Install releases with the script in the README."
        }
        let when = "When on, Ocelot asks GitHub once a day whether a newer version exists (the request carries the app and macOS version, nothing about your documents); you always choose whether to download and install. The first time, Ocelot asks before checking automatically."
        if service.config?.needsAuth == false {
            return "Updates come from Ocelot's public GitHub releases: no sign-in, and requests go only to GitHub (raw.githubusercontent.com, github.com). \(when)"
        }
        return "Ocelot's releases are private, so updates use your GitHub CLI sign-in (gh auth login): the token is read for each check, kept in memory only, and sent only to GitHub (api.github.com, raw.githubusercontent.com). \(when)"
    }
}
