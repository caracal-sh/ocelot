import SwiftUI

/// What the person chose on Home (or an agent through `new_project`) besides the words: carried with the start request to the new
/// document's editor, which creates the design system before the agent's first turn and marks a plan-first start in its first message.
struct HomeStartOptions: Equatable, Sendable {
    /// Arguments of the editor's `create_design_system` tool (`{ "style": "luma" }` from Home). Nil: the agent decides.
    var designSystem: JSONValue?
    /// The agent interviews the person and shows a plan before it touches the canvas.
    var planFirst = false

    init(designSystem: JSONValue? = nil, planFirst: Bool = false) {
        self.designSystem = designSystem
        self.planFirst = planFirst
    }

    /// Home's choices: `styleID` is a `HomeDesignStyle` raw value ("" or unknown: the agent decides).
    init(styleID: String, planFirst: Bool) {
        let style = HomeDesignStyle(rawValue: styleID)
        self.init(designSystem: style.map { .object(["style": .string($0.rawValue)]) }, planFirst: planFirst)
    }
}

/// The eight shadcn styles Home offers, with the one-line character the design-system guide gives each.
enum HomeDesignStyle: String, CaseIterable, Identifiable {
    case nova, vega, maia, lyra, mira, luma, rhea, sera

    var id: String { rawValue }
    var title: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }

    var character: String {
        switch self {
        case .nova: "compact, 32px controls"
        case .vega: "the classic shadcn look"
        case .maia: "soft, generous spacing"
        case .lyra: "boxy, sharp, technical"
        case .mira: "dense, 28px controls"
        case .luma: "pill controls, soft elevation"
        case .rhea: "luma, more compact"
        case .sera: "editorial, typographic"
        }
    }

    /// UserDefaults keys of the two choices (they are remembered across launches).
    static let defaultsKey = "ocelot.home.designSystem"
    static let planFirstKey = "ocelot.home.planFirst"
}

/// "Design system: Agent decides" and the eight styles, each with its character, in a quiet menu next to the attach button.
struct DesignSystemMenu: View {
    /// A `HomeDesignStyle` raw value, or "" for "Agent decides".
    @Binding var styleID: String
    @State private var hovering = false

    private var style: HomeDesignStyle? { HomeDesignStyle(rawValue: styleID) }
    private var valueTitle: String { style?.title ?? "Agent decides" }

    var body: some View {
        Menu {
            Picker("Design system", selection: $styleID) {
                Text("Agent decides").tag("")
                Divider()
                ForEach(HomeDesignStyle.allCases) { style in
                    Text("\(style.title) · \(style.character)").tag(style.rawValue)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            HStack(spacing: 4) {
                Text("Design system: \(valueTitle)")
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8, weight: .semibold))
            }
            .font(.system(size: 12))
            .foregroundStyle(hovering || style != nil ? .primary : .secondary)
            .padding(.horizontal, 8)
            .frame(height: 26)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.primary.opacity(hovering ? 0.07 : 0)))
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .help("The design system the agent builds with. Agent decides: it picks one from your brief, or none.")
        .accessibilityLabel("Design system")
        .accessibilityValue(valueTitle)
    }
}

/// "Plan first": the agent asks questions and shows a plan before it builds.
struct PlanFirstToggle: View {
    @Binding var isOn: Bool
    @State private var hovering = false

    var body: some View {
        Button { isOn.toggle() } label: {
            Label("Plan first", systemImage: isOn ? "checkmark.circle.fill" : "circle")
                .labelStyle(.titleAndIcon)
                .font(.system(size: 12))
                .foregroundStyle(isOn ? Color.accentColor : (hovering ? Color.primary : Color.secondary))
                .padding(.horizontal, 8)
                .frame(height: 26)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(isOn ? Color.accentColor.opacity(0.10) : Color.primary.opacity(hovering ? 0.07 : 0)))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
        .fixedSize()
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .animation(.easeOut(duration: 0.12), value: isOn)
        .help("The agent asks you questions and shows a plan before it builds anything.")
        .accessibilityLabel("Plan first")
        .accessibilityHint("The agent asks you questions and shows a plan before it builds anything.")
        .accessibilityValue(isOn ? "On" : "Off")
        .accessibilityAddTraits(.isToggle)
    }
}
