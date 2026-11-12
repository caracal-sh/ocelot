import AppKit
import Combine
import Foundation
import os
import UniformTypeIdentifiers

/// File state for one editor window: where the document lives, whether it has
/// unsaved changes, autosave and crash recovery. The document itself lives in the
/// editor; this class only moves its serialized form to and from disk.
///
/// Autosave: every change notification from the editor schedules a save after
/// `autosaveDelay`. Saved documents autosave in place; untitled ones autosave to a
/// recovery package in Application Support. That package is never deleted when the window closes (unless the document
/// is empty): Home lists it as an unsaved document and opens it again (`open` adopts it), the first window after a
/// launch adopts the newest one, and saving the document somewhere real deletes it.
@MainActor
final class DocumentSession: ObservableObject {
    @Published private(set) var fileURL: URL? { didSet { if fileURL != oldValue { onIdentityChange?(); assetRoot.set(packageURL) } } }
    @Published private(set) var isDirty = false
    @Published private(set) var documentName = "Untitled" { didSet { if documentName != oldValue { onIdentityChange?() } } }
    @Published private(set) var lastError: String?
    /// Stable id of the project in this window (a UUID stored in the package); empty until the editor reported it.
    @Published private(set) var projectId = "" { didSet { if projectId != oldValue { onIdentityChange?() } } }

    /// Fired when the project id, name or file changes: the MCP discovery file lists these.
    var onIdentityChange: (@MainActor () -> Void)?
    /// Whether another window already uses this project id (a copied package opened next to its original).
    var projectIdInUse: @MainActor (String) -> Bool = { _ in false }

    /// Which document a window shows: `epoch` changes when another document replaces it (open, new document), not
    /// when the same one is saved somewhere else. Work started for one document (image generation) checks it.
    private(set) var documentEpoch = UUID()
    var binding: DocumentBinding { DocumentBinding(epoch: documentEpoch, package: packageURL) }
    /// Fired when another document replaces the current one, before it loads.
    var onDocumentReplaced: (@MainActor () -> Void)?

    var title: String {
        let name = fileURL?.deletingPathExtension().lastPathComponent ?? documentName
        return isDirty ? "\(name) — Edited" : name
    }

    var autosaveDelay: Duration = .milliseconds(1500)

    /// Where this window's document lives on disk now: its `.ocelot`, or the recovery package while untitled.
    var packageURL: URL { fileURL ?? recoveryURL }

    private let editor: () -> EditorClient?
    /// This window's editor endpoint, for host features that report back to it (image progress).
    func editorClient() -> EditorClient? { editor() }
    private var recoveryURL: URL { didSet { assetRoot.set(packageURL) } }
    /// The package this window's assets live in: the saved document, else the recovery package.
    private let assetRoot: AssetRoot
    /// This window's asset store (`<package>/assets/`); follows Save As and new/open transitions.
    let assets: AssetStore
    private var autosaveTask: Task<Void, Never>?
    private var hasLoadedOnce = false
    /// False while the editor page is (re)loading: opens requested then wait in `pendingOpen`.
    private var editorReady = false
    /// True while a document is being loaded into the editor (a restore after a page load, or `open`): the editor holds
    /// something else until the load finishes, so nothing may be autosaved from it.
    private var loadingDocument = false
    private var pendingOpen: URL?
    /// Home flow: this window starts a new document, so its first load must not adopt a recovery file.
    private var skipsRecoveryOnFirstLoad = false
    /// Home flow: the person's first message, attached files and choices (design system, plan first), sent once the editor (and its agent chat) is up.
    private var pendingPrompt: (text: String, attachments: [StartAttachment], options: HomeStartOptions)?
    private var previewTask: Task<Void, Never>?
    private var lastPreviewAt: ContinuousClock.Instant?
    /// Autosaves rewrite `preview.png` at most this often (an explicit save always does).
    var previewInterval: Duration = .seconds(20)
    private let log = Logger(subsystem: "sh.caracal.ocelot", category: "document")

    /// Recovery files already adopted by a window in this process.
    private static var claimedRecovery = Set<String>()

    /// `isEditorReady` skips the wait for the first page load and recovery adoption (tests).
    init(editor: @escaping () -> EditorClient?, isEditorReady: Bool = false) {
        self.editor = editor
        self.editorReady = isEditorReady
        self.hasLoadedOnce = isEditorReady
        let recovery = Self.freshRecoveryURL()
        self.recoveryURL = recovery
        self.assetRoot = AssetRoot(recovery)
        self.assets = AssetStore(root: assetRoot)
    }

    static var recoveryDirectory: URL {
        // Lets a test run (or a second instance) keep its untitled documents apart from the real ones.
        if let override = ProcessInfo.processInfo.environment["OCELOT_RECOVERY_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("Ocelot/Recovery", isDirectory: true)
    }

    // MARK: Editor lifecycle

    /// Called after every editor page load. The first load adopts a recovery file
    /// if one exists; later loads (dev reload, web process crash) restore the
    /// last saved state so the page never comes back empty.
    func editorDidLoad() async {
        await restoreAfterLoad()
        if let start = pendingPrompt, editorReady {
            pendingPrompt = nil
            // Not awaited: the agent can take a while to start, and the window must not wait for it.
            Task { @MainActor in await startAgent(with: start.text, attachments: start.attachments, options: start.options) }
        }
    }

    /// This window starts a new, empty document (never a recovery file), optionally with a first message (and files, and the Home choices) for the agent.
    func prepareFresh(prompt: String? = nil, attachments: [StartAttachment] = [], options: HomeStartOptions = HomeStartOptions()) {
        skipsRecoveryOnFirstLoad = true
        let text = prompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        pendingPrompt = text.isEmpty && attachments.isEmpty ? nil : (text, attachments, options)
    }

    /// Sends the first message to the sidebar agent (Home's Start; MCP `new_project` with a prompt after it set the project up). The editor creates the
    /// design system the person chose before the agent's turn, and marks a plan-first start in the message.
    func startAgent(with prompt: String, attachments: [StartAttachment], options: HomeStartOptions = HomeStartOptions()) async {
        guard let editor = editor() else { return }
        do {
            let params = StartWithPromptParams(prompt: prompt, attachments: attachments.isEmpty ? nil : attachments, designSystem: options.designSystem, planFirst: options.planFirst ? true : nil)
            _ = try await editor.call(EditorMethods.StartWithPrompt.self, params, timeout: .seconds(120))
        } catch where WebBridge.isPageLoading(error) {
            pendingPrompt = (prompt, attachments, options) // the page reloaded; the next editorDidLoad sends it
        } catch {
            report("Could not start the agent with your prompt: \(error.localizedDescription) Type it in the Agent tab to try again.")
        }
    }

    private func restoreAfterLoad() async {
        editorReady = true
        if let url = pendingOpen {
            pendingOpen = nil
            hasLoadedOnce = true
            await open(url)
            return
        }
        loadingDocument = true
        defer { loadingDocument = false }
        let source: URL?
        if !hasLoadedOnce {
            hasLoadedOnce = true
            if !skipsRecoveryOnFirstLoad, let recovered = Self.claimNewestRecoveryFile() {
                recoveryURL = recovered
                isDirty = true
                source = recovered
            } else {
                source = nil
            }
        } else {
            source = fileURL ?? (DocumentPackage.hasDocument(at: recoveryURL) ? recoveryURL : nil)
        }
        guard let source else {
            await refreshProjectInfo()
            return
        }
        do {
            let file = try DocumentPackage.read(from: source)
            _ = try await editor()?.call(EditorMethods.LoadDocument.self, LoadDocumentParams(file: file, name: nil))
            documentName = file.name
            lastError = nil // a restore that failed during an earlier (interrupted) load
            log.info("restored document from \(source.path, privacy: .public)")
        } catch where WebBridge.isPageLoading(error) {
            // The page reloaded mid-restore (e.g. Vite re-optimizing): the next editorDidLoad restores
            // from the same file (hasLoadedOnce is set and recoveryURL / fileURL point at it).
            log.info("restore interrupted by a page reload; retrying after the next load")
            return
        } catch {
            report("Could not restore the document: \(error)")
        }
        await refreshProjectInfo()
    }

    /// The editor page is about to (re)load: its endpoint is gone until `editorDidLoad`.
    func editorWillLoad() { editorReady = false }

    /// This window shows `url` (or is about to): its file, or while it is untitled its recovery package (Home's "Unsaved" documents open by that path).
    func shows(_ url: URL) -> Bool {
        let target = url.standardizedFileURL.resolvingSymlinksInPath()
        let candidates = [fileURL ?? recoveryURL, pendingOpen]
        return candidates.contains { $0?.standardizedFileURL.resolvingSymlinksInPath() == target }
    }

    /// A fresh window nobody has typed in: safe to load a file into, or to close in favour of another window.
    var isEmptyUntitled: Bool { fileURL == nil && pendingOpen == nil && !isDirty && lastError == nil }

    /// Reads the project id (and name) from the editor and keeps ids unique across windows.
    func refreshProjectInfo() async {
        guard let editor = editor() else { return }
        do {
            var info = try await editor.call(EditorMethods.GetProjectInfo.self, Empty())
            if projectIdInUse(info.projectId) {
                info = try await editor.call(EditorMethods.RegenerateProjectId.self, Empty())
                log.info("project id was already open in another window; assigned a new one")
            }
            projectId = info.projectId
        } catch {
            log.error("could not read the project id: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// The `projects` entry of the MCP discovery file for this window.
    func runProject(windowId: String) -> RunProject? {
        guard !projectId.isEmpty else { return nil }
        return RunProject(id: projectId, name: fileURL?.deletingPathExtension().lastPathComponent ?? documentName, path: fileURL?.path, windowId: windowId)
    }

    func editorReportedChange(name: String) {
        documentName = name
        isDirty = true
        scheduleAutosave()
    }

    // MARK: Commands

    func save() async {
        guard let url = fileURL else {
            await saveAs()
            return
        }
        await write(to: url, isAutosave: false)
    }

    func saveAs() async {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.ocelotDocument]
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = (fileURL?.deletingPathExtension().lastPathComponent ?? documentName) + ".\(DocumentExtension.current)"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        await saveAs(to: url)
    }

    /// Save As without the panel (MCP `save_project_as`, and the panel's second half): writes the package at `url`, renames
    /// the document after it and keeps this window on it. False when the write failed (`lastError` says why).
    @discardableResult
    func saveAs(to url: URL) async -> Bool {
        let name = url.deletingPathExtension().lastPathComponent
        _ = try? await editor()?.call(EditorMethods.SetName.self, SetNameParams(name: name))
        documentName = name
        await write(to: url, isAutosave: false)
        guard lastError == nil else { return false }
        let previous = packageURL
        fileURL = url
        // The images live next to the old document (or its recovery package): bring them along.
        do {
            try await assets.adopt(from: previous)
            discardRecoveryFile()
        } catch {
            report("Saved \(url.lastPathComponent), but its images could not be copied: \(error.localizedDescription) They are still in \(previous.path); copy its assets folder into the new document manually.")
            return false
        }
        return true
    }

    /// An untitled document with something in it (`windowWillClose` keeps such a document in recovery).
    var holdsUntitledWork: Bool {
        guard fileURL == nil else { return false }
        if hasUnsavedEdits { return true }
        return (try? DocumentPackage.read(from: recoveryURL)).map(DocumentPackage.hasArtboards) ?? false
    }

    func open(_ url: URL) async {
        // `open -a Ocelot file.ocelot` creates the window and delivers the URL before the editor page
        // has loaded: wait for `editorDidLoad` instead of failing with "endpoint is not installed yet".
        guard editorReady else {
            pendingOpen = url
            return
        }
        // Keep whatever is open now: flush it to its file or recovery package first.
        await flushPendingAutosave()
        // The thumbnail task renders whatever the editor holds: it must not land in the package we are leaving.
        cancelPreview()
        let previousFile = fileURL
        let previousRecovery = recoveryURL
        // Home's "Unsaved" documents are recovery packages: they open as untitled documents that keep autosaving to the same package.
        let isRecovery = Self.isRecoveryPackage(url)
        loadingDocument = true
        defer { loadingDocument = false }
        do {
            let file = try DocumentPackage.read(from: url)
            documentReplaced()
            // The editor lists assets right after loading: the store must already point at this package.
            if isRecovery { adoptRecovery(url) } else { fileURL = url }
            _ = try await editor()?.call(EditorMethods.LoadDocument.self, LoadDocumentParams(file: file, name: isRecovery ? nil : url.deletingPathExtension().lastPathComponent))
            documentName = isRecovery ? file.name : url.deletingPathExtension().lastPathComponent
            isDirty = isRecovery // an untitled document stays "Edited" until it is saved somewhere real
            lastError = nil
            if isRecovery { RecentDocuments.shared.reload() } else { RecentDocuments.shared.note(url) }
            await refreshProjectInfo()
        } catch where WebBridge.isPageLoading(error) {
            // The page reloaded mid-open: the next editorDidLoad opens the file again instead of dropping it.
            restore(file: previousFile, recovery: previousRecovery)
            pendingOpen = url
            log.info("open interrupted by a page reload; retrying after the next load")
        } catch {
            restore(file: previousFile, recovery: previousRecovery)
            report("Could not open \(url.lastPathComponent): \(error.localizedDescription)")
        }
    }

    /// Whether `url` is an untitled document's recovery package (a package directly in the Recovery folder).
    static func isRecoveryPackage(_ url: URL) -> Bool { UnsavedScanner.isPackage(url, in: recoveryDirectory) }

    /// This window now holds the untitled document whose recovery package is `url`: it autosaves there from now on.
    private func adoptRecovery(_ url: URL) {
        let previous = recoveryURL
        let target = url.standardizedFileURL
        // Our own package, never written, is nothing to keep. One that holds work stays on disk and stays claimed (Home
        // lists it; no other window may adopt it on its own).
        if Self.claimKey(previous) != Self.claimKey(target), !DocumentPackage.hasDocument(at: previous) {
            Self.claimedRecovery.remove(Self.claimKey(previous))
        }
        Self.claimedRecovery.insert(Self.claimKey(target))
        fileURL = nil
        recoveryURL = target
    }

    /// An open that failed or was interrupted: this window shows what it showed before.
    private func restore(file: URL?, recovery: URL) {
        if recoveryURL != recovery {
            Self.claimedRecovery.remove(Self.claimKey(recoveryURL))
            Self.claimedRecovery.insert(Self.claimKey(recovery))
            recoveryURL = recovery
        }
        fileURL = file
    }

    /// Whether closing or quitting now would lose edits that still wait for their autosave.
    var hasUnsavedEdits: Bool { autosaveTask != nil || isDirty }

    func flushPendingAutosave() async {
        guard autosaveTask != nil || isDirty else { return }
        autosaveTask?.cancel()
        autosaveTask = nil
        if isDirty { await write(to: fileURL ?? recoveryURL, isAutosave: true) }
    }

    /// The window is closing: nothing may stay in the debounce. A saved document gets its last edits; an untitled
    /// one stays in the recovery package (it is the person's only copy) unless it holds nothing worth recovering.
    func windowWillClose() async {
        await flushPendingAutosave()
        await saveIfEditorAhead()
        if fileURL == nil {
            let kept = (try? DocumentPackage.read(from: recoveryURL)).map(DocumentPackage.hasArtboards) ?? false
            if !kept { discardRecoveryFile() }
        }
        // The unsaved document this window held belongs in Home's list from now on.
        RecentDocuments.shared.reload()
    }

    /// The editor tells the host about an edit 250 ms after it happens (`host.documentChanged`), so an edit made in the
    /// last moments before a window closes or the app quits is not known here yet. Asks the editor for its state and
    /// writes it when it differs from what is on disk: nothing is written when nothing changed.
    func saveIfEditorAhead() async {
        // Never ask a page that is still loading (its editor holds the previous or an empty document), and never
        // bring back a document that was deleted while it was open.
        guard editorReady, !loadingDocument, let editor = editor() else { return }
        guard let file = try? await editor.call(EditorMethods.GetDocument.self, Empty(), timeout: .seconds(3)) else { return }
        guard !loadingDocument else { return }
        let target = fileURL ?? recoveryURL
        if let onDisk = try? DocumentPackage.read(from: target) {
            if onDisk.yjs == file.yjs { return }
        } else if fileURL != nil || !DocumentPackage.hasArtboards(file) {
            return
        }
        await write(to: target, isAutosave: true, file: file)
    }

    /// Writes every session's last edits (app quit): the ones waiting for their autosave, and the ones the editor has not
    /// reported yet. Each editor call has its own timeout, so a wedged page delays but cannot block quitting forever.
    static func flushAll(_ sessions: [DocumentSession]) async {
        for session in sessions {
            await session.flushPendingAutosave()
            await session.saveIfEditorAhead()
        }
    }

    // MARK: Internals

    private func scheduleAutosave() {
        autosaveTask?.cancel()
        let delay = autosaveDelay
        autosaveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            self.autosaveTask = nil
            await self.write(to: self.fileURL ?? self.recoveryURL, isAutosave: true)
        }
    }

    /// `file` is the editor's state when the caller already asked for it (`saveIfEditorAhead`). Autosaves never write
    /// while a document is loading: the editor then holds the previous (or an empty) document, which must not land over the one being opened.
    private func write(to url: URL, isAutosave: Bool, file prefetched: DocumentFile? = nil) async {
        guard let editor = editor() else { return }
        if isAutosave, loadingDocument { return }
        do {
            let file: DocumentFile
            if let prefetched { file = prefetched } else { file = try await editor.call(EditorMethods.GetDocument.self, Empty()) }
            if isAutosave, loadingDocument { return }
            try DocumentPackage.write(file, to: url)
            lastError = nil
            // Untitled documents stay "Edited" until saved somewhere real.
            if url == fileURL { isDirty = false }
            // Remember a real file for Home / Open Recent; refresh the thumbnail of the file or, while untitled, of the recovery package (Home shows it).
            if url != recoveryURL, !isAutosave { RecentDocuments.shared.note(url) }
            schedulePreview(for: url, force: !isAutosave && url != recoveryURL)
            log.info("\(isAutosave ? "autosaved" : "saved", privacy: .public) \(url.path, privacy: .public)")
        } catch {
            report("Could not save \(url.lastPathComponent): \(error)")
        }
    }

    /// Rewrites `preview.png` in the saved package: immediately for an explicit save, otherwise at most every
    /// `previewInterval` (a trailing run catches the last autosave of a burst).
    private func schedulePreview(for url: URL, force: Bool) {
        previewTask?.cancel()
        var wait = Duration.zero
        if !force, let last = lastPreviewAt { wait = max(.zero, previewInterval - (ContinuousClock.now - last)) }
        previewTask = Task { @MainActor [weak self, wait] in
            if wait > .zero { try? await Task.sleep(for: wait) }
            guard !Task.isCancelled, let self else { return }
            await self.writePreview(to: url)
        }
    }

    private func writePreview(to url: URL) async {
        guard let editor = editor() else { return }
        lastPreviewAt = .now
        do {
            let result = try await editor.call(EditorMethods.RenderPreview.self, Empty(), timeout: .seconds(45))
            // The editor may hold another document by now (open, new document): never write its picture here.
            guard !Task.isCancelled, packageURL == url else { return }
            guard let encoded = result.png else {
                try DocumentPackage.writePreview(nil, to: url) // no artboard: drop a stale thumbnail
                return
            }
            guard let data = Data(base64Encoded: encoded), let thumbnail = DocumentPreview.thumbnail(from: data) else { return }
            try DocumentPackage.writePreview(thumbnail, to: url)
        } catch {
            // The thumbnail is a nicety: never bother the person with it.
            log.info("preview not updated: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func discardRecoveryFile() {
        try? FileManager.default.removeItem(at: recoveryURL)
        Self.claimedRecovery.remove(Self.claimKey(recoveryURL))
    }

    private func documentReplaced() {
        documentEpoch = UUID()
        onDocumentReplaced?()
    }

    private func cancelPreview() {
        previewTask?.cancel()
        previewTask = nil
    }

    private func report(_ message: String) {
        lastError = message
        log.error("\(message, privacy: .public)")
    }

    func dismissError() { lastError = nil }

    /// Whether an earlier session left an untitled document that the next window will restore.
    static var hasUnclaimedRecoveryFile: Bool { newestUnclaimedRecoveryFile() != nil }

    private static func claimNewestRecoveryFile() -> URL? {
        guard let newest = newestUnclaimedRecoveryFile() else { return nil }
        claimedRecovery.insert(claimKey(newest))
        return newest
    }

    /// A new recovery package for a window's own untitled document. Claimed at once: another window's first load
    /// must not adopt the package of a window that is still open.
    private static func freshRecoveryURL() -> URL {
        let url = recoveryDirectory.appendingPathComponent("Untitled-\(UUID().uuidString).ocelot", isDirectory: true)
        claimedRecovery.insert(claimKey(url))
        return url
    }

    /// Directory URLs compare unequal with and without the trailing slash: compare standardized paths.
    private static func claimKey(_ url: URL) -> String { url.standardizedFileURL.path }

    private static func newestUnclaimedRecoveryFile() -> URL? {
        let dir = recoveryDirectory
        guard let items = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]
        ) else { return nil }
        let candidates = items
            .filter { DocumentExtension.matches($0) && !claimedRecovery.contains(claimKey($0)) && DocumentPackage.hasDocument(at: $0) }
            .sorted {
                let a = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let b = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return a > b
            }
        return candidates.first
    }
}

/// The document a window shows at some moment (see `DocumentSession.documentEpoch`).
struct DocumentBinding: Sendable, Equatable {
    var epoch: UUID
    var package: URL
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
