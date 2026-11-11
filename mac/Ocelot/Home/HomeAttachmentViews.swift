import AppKit
import ImageIO
import SwiftUI

/// Chips under the Home prompt: a thumbnail (images) or a document glyph (texts), the name, a second line of facts, and ×.
/// A chip with an error says what to do under its row. New chips enter with opacity and a 0.96 scale (the editor's
/// standard enter); removal is instant. Reduced motion keeps the opacity.
struct AttachmentChipRow: View {
    let items: [HomeAttachment]
    let errors: [UUID: String]
    let remove: (UUID) -> Void
    let pasteAsText: (HomeAttachment) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        FlowLayout(spacing: 6, lineSpacing: 6) {
            ForEach(items) { item in
                AttachmentChip(item: item, error: errors[item.id], remove: { remove(item.id) }, pasteAsText: { pasteAsText(item) })
                    .transition(reduceMotion ? .opacity : AttachmentChip.enter)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Attachments")
    }
}

private struct AttachmentChip: View {
    let item: HomeAttachment
    let error: String?
    let remove: () -> Void
    let pasteAsText: () -> Void
    @State private var thumbnail: NSImage?
    @State private var hovering = false

    static var enter: AnyTransition { .opacity.combined(with: .scale(scale: 0.96)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                leading
                    .frame(width: 22, height: 22)
                    .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                    .imageOutline(radius: 4, enabled: item.kind == .image && error == nil && thumbnail != nil)
                Text(item.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 170, alignment: .leading)
                Text(error == nil ? item.meta : "Cannot attach")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .lineLimit(1)
                    .fixedSize()
                if item.pasted, error == nil {
                    Button("Paste as text", action: pasteAsText)
                        .buttonStyle(.plain)
                        .foregroundStyle(hovering ? .primary : .secondary)
                        .focusable(false)
                }
                Button(action: remove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .semibold))
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .focusable(false)
                .help("Remove \(item.name)")
                .accessibilityLabel("Remove \(item.name)")
            }
            if let error {
                Text(error)
                    .font(.system(size: 11.5))
                    .foregroundStyle(Color(nsColor: .systemRed))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 360, alignment: .leading)
            }
        }
        .font(.system(size: 12))
        .padding(.leading, 4)
        .padding(.trailing, 6)
        .padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.05)))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(error == nil ? Color(nsColor: .separatorColor) : Color(nsColor: .systemRed).opacity(0.6), lineWidth: 0.5)
        )
        .onHover { hovering = $0 }
        .task(id: item.id) { await loadThumbnail() }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var leading: some View {
        if item.kind == .image, error == nil {
            if let thumbnail {
                Image(nsImage: thumbnail).resizable().aspectRatio(contentMode: .fill)
            } else {
                Rectangle().fill(Color.primary.opacity(0.06))
            }
        } else {
            Image(systemName: error == nil ? "doc.text" : "exclamationmark.triangle")
                .font(.system(size: 12))
                .foregroundStyle(error == nil ? Color.secondary : Color(nsColor: .systemRed))
        }
    }

    /// A 64px thumbnail decoded by ImageIO (HEIC included), off the main thread; it crosses back as PNG data.
    private func loadThumbnail() async {
        guard item.kind == .image, error == nil else { return }
        let content = item.content
        let data = await Task.detached(priority: .utility) { Self.thumbnailPNG(for: content) }.value
        thumbnail = data.flatMap(NSImage.init(data:))
    }

    private nonisolated static func thumbnailPNG(for content: HomeAttachment.Content) -> Data? {
        let source: CGImageSource?
        switch content {
        case .file(let url): source = CGImageSourceCreateWithURL(url as CFURL, nil)
        case .imageData(let data): source = CGImageSourceCreateWithData(data as CFData, nil)
        case .text: source = nil
        }
        guard let source else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 64,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, "public.png" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, cg, nil)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }
}

/// A 1pt outline inset on a content image, in pure black (light) or white (dark) at 10%: a tinted line would show as a coloured
/// fringe on the image's edge. Not for transparent artwork.
struct ImageOutline: ViewModifier {
    let radius: CGFloat
    let enabled: Bool
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content.overlay {
            if enabled {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder((scheme == .dark ? Color.white : Color.black).opacity(0.1), lineWidth: 1)
            }
        }
    }
}

extension View {
    func imageOutline(radius: CGFloat, enabled: Bool = true) -> some View { modifier(ImageOutline(radius: radius, enabled: enabled)) }
}

/// The paperclip beside the prompt's hint: opens a panel for images and text files.
struct AttachButton: View {
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "paperclip")
                .font(.system(size: 14))
                .foregroundStyle(hovering ? .primary : .secondary)
                .frame(width: 28, height: 28)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.primary.opacity(hovering ? 0.07 : 0)))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
        .focusable(false)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .help("Attach images or text files. You can also drop or paste them.")
        .accessibilityLabel("Attach images or text files")
    }
}

/// While files are dragged over Home: the card's edge turns into a dashed target.
struct AttachDropTarget: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 20, style: .continuous)
            .strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 2, dash: [6, 5]))
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.accentColor.opacity(0.07)))
            .overlay(
                VStack(spacing: 4) {
                    Label("Drop to attach", systemImage: "paperclip")
                        .font(.system(size: 14, weight: .medium))
                    Text(HomeAttachment.supported)
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 28)
                }
            )
            .accessibilityHidden(true)
    }
}
