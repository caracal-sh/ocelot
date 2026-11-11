import AppKit
import CoreText
import SwiftUI

/// Geist Serif (Vercel, SIL OFL 1.1; `mac/Ocelot/Fonts`) is Home's one display face: the prompt. It is a
/// high-contrast display design, so it is only used large; everything else stays in the system font.
enum HomeFont {
    /// Registers the bundled font for this process (once, idempotent); false when it is missing or refused.
    static let isAvailable: Bool = {
        let bundle = Bundle.main
        guard let url = bundle.url(forResource: "GeistSerif-Regular", withExtension: "ttf")
            ?? bundle.url(forResource: "GeistSerif-Regular", withExtension: "ttf", subdirectory: "Fonts")
        else { return false }
        var error: Unmanaged<CFError>?
        if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) { return true }
        // Already registered (a second window) is fine.
        return NSFontManager.shared.availableFontFamilies.contains("Geist Serif")
    }()

    static let promptSize: CGFloat = 30

    /// The prompt's display font: Geist Serif, else the system serif.
    static var prompt: Font {
        isAvailable ? .custom("Geist Serif", size: promptSize) : .system(size: promptSize, design: .serif)
    }
}

/// Root of the Home window: installs the window-opening action, hands the NSWindow to the coordinator and
/// runs the launch decision once.
struct HomeWindowView: View {
    @Environment(\.openWindow) private var openWindow
    @ObservedObject private var recents = RecentDocuments.shared
    @State private var window: NSWindow?

    var body: some View {
        HomeView(recents: recents, coordinator: .shared)
            .frame(minWidth: 720, minHeight: 520)
            .background(WindowAccessor { window in
                self.window = window
                HomeCoordinator.shared.attachHome(window)
            })
            .onAppear {
                HomeCoordinator.shared.install(openWindow)
                if let window { HomeCoordinator.shared.attachHome(window) } // reused window, shown again
                recents.reload()
            }
            .task { await HomeCoordinator.shared.routeLaunch() }
            // Documents saved elsewhere (or removed in Finder) while Ocelot was in the background.
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in recents.reload() }
    }
}

/// Home: one large prompt, starter chips, then recent documents. The prompt is the one memorable thing; the rest
/// stays quiet.
struct HomeView: View {
    @ObservedObject var recents: RecentDocuments
    let coordinator: HomeCoordinator

    @State private var prompt = ""
    @State private var selection: RecentDocument.ID?
    @FocusState private var promptFocused: Bool
    /// Starts false so the prompt card and chips enter (see `Entrance`); set when the window is actually on screen.
    @State private var entered = false
    @State private var attachments: [HomeAttachment] = []
    /// Files are being dragged over the window: the prompt card shows a drop target.
    @State private var dragActive = false
    /// Start could not read an attached file; the chips stay so the person can fix it.
    @State private var startError: String?
    @State private var starting = false
    @State private var pasteMonitor: Any?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let starters: [(title: String, prompt: String)] = [
        ("Landing page", "A landing page for "),
        ("Mobile app onboarding", "A three-screen onboarding flow for a mobile app that "),
        ("Dashboard", "A dashboard for "),
        ("Pricing page", "A pricing page with three plans for "),
        ("Brand moodboard", "A brand moodboard for "),
    ]

    private var trimmedPrompt: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var attachmentErrors: [UUID: String] { HomeAttachment.errors(for: attachments) }
    /// Words, or attachments alone ("Design from the attached files."); never while a chip has an error.
    private var canStart: Bool { (!trimmedPrompt.isEmpty || !attachments.isEmpty) && attachmentErrors.isEmpty && !starting }

    var body: some View {
        ZStack {
            VisualEffectBackground()
                .ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    Image("OcelotMark")
                        .resizable()
                        .scaledToFit()
                        .frame(height: 30)
                        .accessibilityHidden(true) // decorative: the window title already names the app
                    promptField
                        .modifier(Entrance(entered: entered, delay: 0))
                    StarterChips(starters: Self.starters) { starter in
                        prompt = starter
                        promptFocused = true
                    }
                    .modifier(Entrance(entered: entered, delay: 0.06))
                    recentsSection
                }
                .frame(maxWidth: 760, alignment: .leading)
                .padding(.horizontal, 48)
                .padding(.top, 76)
                .padding(.bottom, 40)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.automatic)
        }
        .defaultFocus($promptFocused, true)
        // What an agent just did through the app tools ("Claude Code opened Acme"): a quiet line, gone after a few seconds.
        .overlay(alignment: .bottom) { AgentActivityLine() }
        // Files dragged anywhere over Home turn the prompt card into the drop target (an overlay that takes the drop itself).
        .dropDestination(for: URL.self) { urls, _ in addFiles(urls) } isTargeted: { dragActive = $0 }
        .onAppear {
            promptFocused = true
            installPasteMonitor()
            // A window that is re-presented after launch is visible right away; at launch it stays invisible until the
            // launch decision is made, and `.homeDidShow` says it was revealed.
            if coordinator.isHomeRevealed { entered = true }
        }
        // Safety net: the content never stays hidden if neither signal arrives.
        .task {
            try? await Task.sleep(for: .seconds(3))
            entered = true
        }
        // AppKit hands the first focusable control (a chip) the focus when the window becomes key.
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { note in
            if let window = note.object as? NSWindow, coordinator.isHome(window) { focusPrompt() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .homeDidShow)) { _ in
            entered = true
            focusPrompt()
        }
    }

    // MARK: Prompt

    private var promptField: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField("What do you want to design?", text: $prompt, axis: .vertical)
                .textFieldStyle(.plain)
                .font(HomeFont.prompt)
                .lineLimit(2...6)
                .focused($promptFocused)
                .padding(.horizontal, 22)
                .padding(.top, 22)
                // Return starts; ⇧Return adds a line.
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.shift) { return .ignored }
                    start()
                    return .handled
                }
                // Backspace in an empty prompt takes the last chip back.
                .onKeyPress(.delete, phases: .down) { _ in
                    guard prompt.isEmpty, let last = attachments.last else { return .ignored }
                    removeAttachment(last.id)
                    return .handled
                }
                .accessibilityLabel("Describe what you want to design")
            if !attachments.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    AttachmentChipRow(items: attachments, errors: attachmentErrors, remove: removeAttachment, pasteAsText: pasteAsText)
                    if let startError {
                        Text(startError)
                            .font(.system(size: 11.5))
                            .foregroundStyle(Color(nsColor: .systemRed))
                    }
                }
                .padding(.horizontal, 22)
                .padding(.top, 10)
            }
            HStack(spacing: 4) {
                AttachButton(action: chooseFiles)
                    .padding(.leading, -6)
                Text("The agent builds it on the canvas, and you can edit along.")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
                Spacer(minLength: 12)
                StartButton(enabled: canStart, action: start)
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 14)
        }
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color(nsColor: .textBackgroundColor).opacity(0.9))
                .shadow(color: .black.opacity(0.10), radius: 18, y: 6)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(promptFocused ? Color.accentColor.opacity(0.7) : Color(nsColor: .separatorColor), lineWidth: promptFocused ? 1.5 : 0.5)
        )
        .overlay {
            if dragActive {
                AttachDropTarget()
                    .dropDestination(for: URL.self) { urls, _ in addFiles(urls) } isTargeted: { dragActive = $0 }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { promptFocused = true }
    }

    // MARK: Attachments

    private var chipAnimation: Animation {
        reduceMotion ? .easeOut(duration: 0.12) : .timingCurve(0.23, 1, 0.32, 1, duration: 0.16)
    }

    private func addAttachments(_ items: [HomeAttachment]) {
        guard !items.isEmpty else { return }
        startError = nil
        withAnimation(chipAnimation) { attachments.append(contentsOf: items) }
    }

    @discardableResult
    private func addFiles(_ urls: [URL]) -> Bool {
        let files = urls.filter(\.isFileURL)
        guard !files.isEmpty else { return false }
        addAttachments(files.map(HomeAttachment.file))
        promptFocused = true
        return true
    }

    private func removeAttachment(_ id: UUID) {
        startError = nil
        attachments.removeAll { $0.id == id }
    }

    /// "Paste as text": the chip's text goes back into the prompt.
    private func pasteAsText(_ item: HomeAttachment) {
        removeAttachment(item.id)
        if let text = item.text { prompt += text }
        promptFocused = true
    }

    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = HomeAttachment.openPanelTypes
        panel.message = "Attach images or text files"
        guard panel.runModal() == .OK else { return }
        addFiles(panel.urls)
    }

    /// ⌘V in Home: files, an image or a long text become chips; short text goes to the prompt as usual. A local monitor sees the
    /// key before the Edit menu's Paste, which would otherwise hand an image to a text field that cannot take it.
    private func installPasteMonitor() {
        guard pasteMonitor == nil else { return }
        let coordinator = coordinator
        pasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  event.charactersIgnoringModifiers == "v",
                  let window = event.window, coordinator.isHome(window),
                  let paste = HomePaste.read(from: .general)
            else { return event }
            switch paste {
            case .files(let urls): addAttachments(urls.map(HomeAttachment.file))
            case .image(let data): addAttachments([.pastedImage(data, among: attachments)])
            case .longText(let text): addAttachments([.pastedText(text, among: attachments)])
            }
            return nil
        }
    }

    /// Re-asserts the prompt's focus after AppKit placed its own first responder or the window was revealed.
    private func focusPrompt() {
        promptFocused = false
        DispatchQueue.main.async { promptFocused = true }
    }

    private func start() {
        guard canStart else { return }
        let items = attachments
        let text = trimmedPrompt.isEmpty ? HomeAttachment.defaultPrompt : trimmedPrompt
        starting = true
        startError = nil
        // The app reads the files (the person chose them; the sandboxed agent never sees a path) and hands them to the editor,
        // which normalizes them with the sidebar's own code.
        Task {
            defer { starting = false }
            do {
                let files = try await Task.detached(priority: .userInitiated) { try items.map { try $0.payload() } }.value
                prompt = ""
                attachments = []
                coordinator.start(.prompt(text, files))
            } catch {
                startError = error.localizedDescription
            }
        }
    }

    // MARK: Recents

    private var recentsSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 4) {
                Text("Recent")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                QuietButton(title: "Blank document", systemImage: "plus") { coordinator.start(.blank) }
                QuietButton(title: "Open…", systemImage: "folder") { coordinator.openWithPanel() }
            }
            if recents.items.isEmpty {
                EmptyRecents()
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 176, maximum: 232), spacing: 14, alignment: .top)], alignment: .leading, spacing: 14) {
                    ForEach(recents.items) { item in
                        RecentCard(
                            item: item,
                            selected: selection == item.id,
                            select: { selection = item.id },
                            open: { coordinator.open(item.url) },
                            remove: { recents.remove(item.url) }
                        )
                    }
                }
            }
        }
    }
}

// MARK: - Pieces

/// "Claude Code opened Acme": agents drive the app through MCP (`AppActivity`), and Home says so.
private struct AgentActivityLine: View {
    @ObservedObject private var activity = AppActivity.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let entry = activity.latest {
                HStack(spacing: 6) {
                    Image(systemName: "sparkle")
                        .font(.system(size: 10))
                    Text(entry.message)
                        .font(.system(size: 12))
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(.regularMaterial, in: Capsule())
                .padding(.bottom, 14)
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 6)))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("agent-activity")
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .smooth(duration: 0.25), value: activity.latest)
    }
}

/// The primary action inside the prompt field: accent capsule, "Start ↩".
private struct StartButton: View {
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text("Start")
                Image(systemName: "return")
                    .font(.system(size: 11, weight: .semibold))
            }
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .frame(height: 30)
            .background(Capsule().fill(Color.accentColor))
        }
        .buttonStyle(PressableStyle(spring: true))
        .opacity(enabled ? 1 : 0.35)
        .disabled(!enabled)
        .help("Start a new document and send this to the agent (↩)")
    }
}

/// Starter chips: hairline capsules that fill the prompt. Wrap onto a second line in a narrow window.
private struct StarterChips: View {
    let starters: [(title: String, prompt: String)]
    let pick: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 8, lineSpacing: 8) {
            ForEach(starters, id: \.title) { starter in
                Chip(title: starter.title) { pick(starter.prompt) }
            }
        }
    }
}

private struct Chip: View {
    let title: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12.5))
                .foregroundStyle(.primary.opacity(0.85))
                .padding(.horizontal, 12)
                .frame(height: 28)
                .background(Capsule().fill(Color.primary.opacity(hovering ? 0.08 : 0.04)))
                .overlay(Capsule().strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
        }
        .buttonStyle(PressableStyle())
        // Shortcuts to the prompt: they must never take the keyboard focus (typing would press them).
        .focusable(false)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

private struct QuietButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .labelStyle(.titleAndIcon)
                .font(.system(size: 12.5))
                .foregroundStyle(hovering ? .primary : .secondary)
                .padding(.horizontal, 8)
                .frame(height: 26)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.primary.opacity(hovering ? 0.07 : 0)))
        }
        .buttonStyle(PressableStyle())
        // Shortcuts to the prompt: they must never take the keyboard focus (typing would press them).
        .focusable(false)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

/// Press feedback: a pressed button scales to 0.96 over 150ms on an ease-out, off when the person asked for reduced motion (a
/// disabled button never reports a press, so it never scales). `spring` settles the release on a spring without bounce (the Start
/// button, which hands over to a new document) instead of an ease-out.
struct PressableStyle: ButtonStyle {
    var spring = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .animation(spring ? .spring(duration: 0.3, bounce: 0) : .easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

/// First appearance of the prompt card and the chips: opacity, an 8pt rise and 4pt of blur over 300ms on the strong
/// ease-out (the web editor's `--at-ease-out`); the chips follow 60ms later. Reduced motion keeps a plain opacity fade.
private struct Entrance: ViewModifier {
    let entered: Bool
    let delay: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(entered ? 1 : 0)
            .offset(y: entered || reduceMotion ? 0 : 8)
            .blur(radius: entered || reduceMotion ? 0 : 4)
            .animation(reduceMotion ? .easeOut(duration: 0.2).delay(delay) : .timingCurve(0.23, 1, 0.32, 1, duration: 0.3).delay(delay), value: entered)
    }
}

private struct EmptyRecents: View {
    var body: some View {
        VStack(spacing: 6) {
            Text("Nothing here yet")
                .font(.system(size: 13, weight: .medium))
            Text("Designs you save show up here, with a preview of their first artboard.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, minHeight: 150)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color(nsColor: .separatorColor), style: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
        )
    }
}

private struct RecentCard: View {
    let item: RecentDocument
    let selected: Bool
    let select: () -> Void
    let open: () -> Void
    let remove: () -> Void
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Thumbnail(url: item.previewURL, stamp: item.previewStamp)
                .aspectRatio(16.0 / 10.0, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .imageOutline(radius: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.name)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                Text("\(item.folder) · \(item.lastOpened.formatted(.relative(presentation: .named)))")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 2)
        }
        .padding(6)
        // Concentric: the thumbnail's 8 + the card's 6 inset.
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(selected ? Color.accentColor.opacity(0.16) : Color.primary.opacity(hovering ? 0.05 : 0))
        )
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .onTapGesture(count: 2, perform: open)
        .onTapGesture(perform: select)
        .contextMenu {
            Button("Open", action: open)
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([item.url]) }
            Divider()
            Button("Remove from Recents", action: remove)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.name), in \(item.folder)")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Open", open)
    }
}

/// The package's `preview.png` (aspect-fit on a quiet tile), reloaded when the file's timestamp changes.
private struct Thumbnail: View {
    let url: URL?
    let stamp: Date?
    @State private var image: NSImage?

    var body: some View {
        ZStack {
            Rectangle().fill(Color.primary.opacity(0.045))
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            } else {
                Image(systemName: "square.dashed")
                    .font(.system(size: 20, weight: .light))
                    .foregroundStyle(.quaternary)
            }
        }
        .task(id: stamp) {
            guard let url else {
                image = nil
                return
            }
            let data = await Task.detached(priority: .utility) { try? Data(contentsOf: url) }.value
            image = data.flatMap(NSImage.init(data:))
        }
    }
}

/// Native window material behind the whole Home window.
private struct VisualEffectBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .underWindowBackground
        view.blendingMode = .behindWindow
        view.state = .followsWindowActiveState
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

/// Left-aligned wrapping layout for the chips.
struct FlowLayout: Layout {
    var spacing: CGFloat
    var lineSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(width: bounds.width, subviews: subviews)
        for (index, origin) in result.origins.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, maxX: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
            maxX = max(maxX, x - spacing)
        }
        return (CGSize(width: maxX, height: y + lineHeight), origins)
    }
}
