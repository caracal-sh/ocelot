import AppKit
import Foundation

/// The one way a document gets opened: Finder, `open -a`, `ocelot open`, Home, Open Recent, File > Open…
/// Every entry point ends in `open(_:)`, which validates the package, settles the single-writer rule and then follows
/// `route`: show the window that already has it, load it into an empty untitled window, or open a new window.
@MainActor
enum DocumentOpener {
    enum Route: Equatable {
        /// The file is already shown (or being opened) by window `index` of the registry: bring it to the front.
        case focus(index: Int)
        /// Window `index` is empty and untitled: load the file into it.
        case load(index: Int)
        /// Nothing can take it: open a new editor window. Before the app has finished launching the window is queued
        /// (`HomeCoordinator`); with only Home on screen it opens beside it and Home steps aside.
        case newWindow
    }

    /// `sessions` are the open editor windows (most recent last); `preferred` is the one the request came from
    /// (File > Open… in a window), which is loaded first when it is empty. A window with content is never replaced.
    static func route(url: URL, sessions: [DocumentSession], preferred: Int? = nil) -> Route {
        if let shown = sessions.firstIndex(where: { $0.shows(url) }) { return .focus(index: shown) }
        if let preferred, sessions.indices.contains(preferred), sessions[preferred].isEmptyUntitled { return .load(index: preferred) }
        if let empty = sessions.lastIndex(where: \.isEmptyUntitled) { return .load(index: empty) }
        return .newWindow
    }

    // MARK: Projects served elsewhere

    /// A project has exactly one writer: if a container or headless host already serves this package (same path,
    /// or the same project id inside), opening it here would create a second Yjs copy.
    static func externalWriter(for url: URL, records: [InstanceRecord], packageProjectId: String?) -> (record: InstanceRecord, project: RunProject)? {
        let want = url.standardizedFileURL.resolvingSymlinksInPath().path
        for record in records where record.kind != .app {
            for project in record.projects {
                let samePath = project.path.map { URL(fileURLWithPath: $0).standardizedFileURL.resolvingSymlinksInPath().path == want } ?? false
                if samePath || (packageProjectId.map { !$0.isEmpty && $0 == project.id } ?? false) { return (record, project) }
            }
        }
        return nil
    }

    /// Asks whether to stop the container/headless host that serves `url` so it can be opened here.
    /// Returns true when it is safe to open (nothing serves it, or it was stopped).
    static func resolveExternalWriter(for url: URL, projectId id: String?, directory: InstanceDirectory = .standard) async -> Bool {
        guard let (record, project) = externalWriter(for: url, records: directory.liveInstances(), packageProjectId: id) else { return true }
        let alert = NSAlert()
        let started = ISO8601DateFormatter().date(from: record.started).map { $0.formatted(date: .omitted, time: .shortened) } ?? record.started
        let place = record.kind == .container ? "in a container" : "headless"
        alert.messageText = "\(project.name) is running \(place) (started \(started))."
        alert.informativeText = "A project has one writer at a time. Stop it and open here? Changes it already saved stay in the package."
        alert.addButton(withTitle: "Stop and Open")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return false }
        do {
            try await stop(record, package: url)
        } catch {
            let failure = NSAlert()
            failure.alertStyle = .warning
            failure.messageText = "Could not stop \(project.name)"
            failure.informativeText = error.localizedDescription
            failure.runModal()
            return false
        }
        for _ in 0..<100 {
            if !directory.liveInstances().contains(where: { $0.instance == record.instance }) { return true }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return false
    }

    /// Runs a helper to completion without blocking the main actor: the termination handler is set before the
    /// process starts (a process that exits at once is not missed) and stderr is drained while it runs (a chatty
    /// process cannot fill the pipe and stall).
    static func run(_ executable: URL, _ arguments: [String]) async throws -> (status: Int32, stderr: String) {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        let err = Pipe()
        process.standardError = err
        let reader = err.fileHandleForReading
        let drained = Task.detached { reader.readDataToEndOfFile() }
        let status: Int32 = try await withCheckedThrowingContinuation { continuation in
            process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
            do {
                try process.run()
                try? err.fileHandleForWriting.close() // the child holds its own copy: EOF arrives when it exits
            } catch {
                try? err.fileHandleForWriting.close()
                continuation.resume(throwing: error)
            }
        }
        return (status, String(decoding: await drained.value, as: UTF8.self))
    }

    private static func stop(_ record: InstanceRecord, package: URL) async throws {
        if record.kind == .container {
            // The bundled CLI owns the container runtime handling (`ocelot stop <path>`).
            let result = try await run(CLIInstaller.bundledURL, ["stop", package.path])
            if result.status != 0 {
                let text = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                throw InstanceDirectory.Failure(text.isEmpty ? "`ocelot stop` exited with status \(result.status)." : text)
            }
        } else if let pid = record.pid {
            guard kill(pid_t(pid), SIGTERM) == 0 else { throw InstanceDirectory.Failure("Could not signal process \(pid): \(String(cString: strerror(errno))). Stop it from a terminal.") }
        } else {
            throw InstanceDirectory.Failure("Don't know how to stop \(record.instance). Stop it yourself, then open the file again.")
        }
    }

    /// How an `open` ended, for callers that report back (MCP `open_project`).
    enum Outcome: Equatable {
        /// The file was already shown: its window came to the front.
        case focused
        /// An empty untitled window loaded it.
        case loaded
        /// A new window was queued for it (it exists a moment later).
        case newWindow
        /// Nothing was opened; the sentence says why and what to do.
        case refused(String)
        /// The person declined a dialog.
        case cancelled
    }

    /// Opens `url` in the right window (see `route`). `caller` is the window File > Open… was used in.
    /// `interactive`: a package that cannot be opened, or a project another host serves, is reported in a dialog (the person
    /// is at the keyboard). Otherwise (an agent asked) nothing modal appears and `.refused` carries the message.
    @discardableResult
    static func open(_ url: URL, from caller: EditorWebController? = nil, interactive: Bool = true, registry: EditorRegistry = .shared, coordinator: HomeCoordinator = .shared) async -> Outcome {
        let file: DocumentFile
        do {
            file = try DocumentPackage.read(from: url)
        } catch {
            let advice = "Open a package that Ocelot saved (a folder ending in .ocelot, or .atelier from earlier releases), or restore it from a backup."
            if !interactive { return .refused("Could not open \(url.lastPathComponent): \(error.localizedDescription) \(advice)") }
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "Could not open \(url.lastPathComponent)"
            alert.informativeText = "\(error.localizedDescription) \(advice)"
            alert.runModal()
            return .refused("Could not open \(url.lastPathComponent).")
        }
        // A second request for a file whose window is still being created must not create another one.
        guard !coordinator.isOpening(url) else { return .newWindow }
        if interactive {
            guard await resolveExternalWriter(for: url, projectId: file.projectId) else { return .cancelled }
        } else if let (record, project) = externalWriter(for: url, records: InstanceDirectory.standard.liveInstances(), packageProjectId: file.projectId) {
            let place = record.kind == .container ? "in a container" : "in a headless host"
            return .refused("\(project.name) is running \(place) (\(record.instance)); a project has one writer at a time. Stop it first (`ocelot stop \(project.id)`, or ask the person), then open it again. The headless host can also work on it: use its own /mcp/p/\(project.id) endpoint.")
        }
        let windows = registry.all
        switch route(url: url, sessions: windows.map(\.session), preferred: caller.flatMap { c in windows.firstIndex { $0 === c } }) {
        case .focus(let index):
            show(windows[index], coordinator: coordinator)
            return .focused
        case .load(let index):
            await windows[index].session.open(url)
            show(windows[index], coordinator: coordinator)
            return .loaded
        case .newWindow:
            coordinator.start(.open(url))
            return .newWindow
        }
    }

    static func show(_ controller: EditorWebController, coordinator: HomeCoordinator) {
        if let window = controller.webView.window {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
        }
        coordinator.dismissHome()
    }

    /// The one Open… panel (File > Open…, Home's Open…).
    static func chooseDocument() -> URL? {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = DocumentPackage.openableTypes
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        return panel.runModal() == .OK ? panel.url : nil
    }

    /// File > Open… from an editor window: the same dedupe and single-writer checks as every other open.
    static func openWithPanel(from caller: EditorWebController) async {
        guard let url = chooseDocument() else { return }
        await open(url, from: caller)
    }
}
