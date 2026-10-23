import AppKit
import SwiftUI

/// Appearance: light or dark, the accent color, the window, how messages read, with a preview of
/// a conversation in what's chosen, and how the sidebar switches between your computers.
struct AppearanceSettings: View {
    @AppStorage(Appearance.key) private var mode = Appearance.system
    @AppStorage(Look.accentKey) private var accent = Look.Accent.system.rawValue
    @AppStorage(Look.windowKey) private var window = Look.Window.glass
    @AppStorage(Look.textSizeKey) private var textSize = 14.0
    @AppStorage(Look.fontKey) private var typeface = Look.Typeface.system
    @AppStorage(StepsDetail.key) private var steps = StepsDetail.summary

    private var modes: some View {
        ForEach(Appearance.allCases, id: \.self) { option in
            ModeThumbnail(mode: option, isSelected: mode == option) { mode = option }
        }
    }

    var body: some View {
        ScrollingSettingsForm {
            Section("Mode") {
                // In a narrow window, two to a row.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 18) { modes }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 112), spacing: 12, alignment: .leading)], alignment: .leading, spacing: 12) { modes }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 6)
            }

            Section {
                LabeledContent {
                    AccentSwatches(accent: $accent)
                } label: {
                    Text("Accent")
                    Text(accentName)
                }
                LabeledContent {
                    Picker("Window", selection: $window) {
                        ForEach(Look.Window.allCases) { Text($0.title).tag($0) }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .fixedSize()
                } label: {
                    Text("Window")
                    Text(window == .glass ? "Frosted glass that lets your desktop’s colors through." : "A solid background, with nothing showing through.")
                }
            } header: {
                Text("Colors")
            }

            Section {
                LabeledContent {
                    Picker("Text size", selection: $textSize) {
                        ForEach(Look.textSizes, id: \.size) { Text($0.title).tag($0.size) }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .fixedSize()
                } label: {
                    Text("Text size")
                    Text("Messages, replies and the composer.")
                }
                Picker(selection: $typeface) {
                    ForEach(Look.Typeface.allCases) { Text($0.title).tag($0) }
                } label: {
                    Text("Typeface")
                    Text("Code always stays monospaced.")
                }
                LabeledContent {
                    Picker("Agent’s steps", selection: $steps) {
                        ForEach(StepsDetail.allCases) { Text($0.title).tag($0) }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .fixedSize()
                } label: {
                    Text("Agent’s steps")
                    Text(stepsCaption)
                }
                ConversationPreview(font: MessageFont(size: textSize, typeface: typeface))
            } header: {
                Text("Messages")
            }

            Section {
                HStack {
                    Spacer()
                    Button("Reset to Defaults") {
                        mode = .system
                        accent = Look.Accent.system.rawValue
                        window = .glass
                        textSize = 14
                        typeface = .system
                        steps = .summary
                    }
                    .disabled(mode == .system && accent == Look.Accent.system.rawValue && window == .glass && textSize == 14 && typeface == .system && steps == .summary)
                }
            }
        }
    }

    private var stepsCaption: String {
        switch steps {
        case .each: "Every step the agent takes, as it takes it."
        case .summary: "Its steps between replies in a line, like “Ran 6 commands, read 3 files”, that opens to each."
        case .minimal: "Only how many steps it took, to open if you want."
        }
    }

    private var accentName: String {
        if let preset = Look.Accent(rawValue: accent) { return preset.title }
        return "Custom, \(accent)"
    }
}

/// A small drawing of the window in a mode, to pick it by.
private struct ModeThumbnail: View {
    let mode: Appearance
    let isSelected: Bool
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Group {
                    switch mode {
                    case .light: MiniWindow(dark: false)
                    case .dark: MiniWindow(dark: true)
                    case .system:
                        // Half and half, as the Mac switches through the day.
                        ZStack {
                            MiniWindow(dark: false)
                            MiniWindow(dark: true)
                                .mask(alignment: .trailing) { Rectangle().frame(width: 56) }
                        }
                    }
                }
                .frame(width: 112, height: 72)
                .clipShape(.rect(cornerRadius: 9))
                .overlay {
                    RoundedRectangle(cornerRadius: 9)
                        .strokeBorder(isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(Surface.hairline(scheme)), lineWidth: isSelected ? 2.5 : 1)
                }
                Text(mode.title)
                    .font(.callout.weight(isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? .primary : .secondary)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// The window, drawn small: the canvas, a sidebar, and a card with a message and a reply.
private struct MiniWindow: View {
    let dark: Bool
    @Environment(\.accent) private var accent

    var body: some View {
        let canvas = dark ? Color(red: 0.075, green: 0.078, blue: 0.09) : Color(red: 0.95, green: 0.94, blue: 0.92)
        let card = dark ? Color(red: 0.12, green: 0.125, blue: 0.14) : .white
        let ink = dark ? Color.white.opacity(0.22) : Surface.slate.opacity(0.14)
        HStack(alignment: .top, spacing: 5) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 2) {
                    ForEach([Color.red, .yellow, .green], id: \.self) { Circle().fill($0.opacity(0.8)).frame(width: 3.5, height: 3.5) }
                }
                .padding(.bottom, 3)
                ForEach(0..<4) { index in
                    Capsule().fill(index == 1 ? accent.opacity(0.45) : ink).frame(width: index == 1 ? 22 : 18, height: 3.5)
                }
            }
            .padding(.top, 5)
            .padding(.leading, 6)
            VStack(alignment: .trailing, spacing: 5) {
                Capsule().fill(accent.opacity(dark ? 0.5 : 0.3)).frame(width: 34, height: 7)
                VStack(alignment: .leading, spacing: 3.5) {
                    Capsule().fill(ink).frame(width: 52, height: 3.5)
                    Capsule().fill(ink).frame(width: 44, height: 3.5)
                    Capsule().fill(ink).frame(width: 48, height: 3.5)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 0)
                RoundedRectangle(cornerRadius: 3).fill(ink.opacity(0.6)).frame(height: 9)
            }
            .padding(6)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(card, in: .rect(cornerRadius: 5))
            .padding([.top, .trailing, .bottom], 5)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(canvas)
    }
}

/// The accent colors as swatches, and any color from the color picker.
private struct AccentSwatches: View {
    @Binding var accent: String

    var body: some View {
        HStack(spacing: 8) {
            ForEach(Look.Accent.allCases) { option in
                Button {
                    accent = option.rawValue
                } label: {
                    Swatch(fill: option == .system ? AnyShapeStyle(AngularGradient(colors: [.red, .orange, .yellow, .green, .blue, .purple, .pink, .red], center: .center)) : AnyShapeStyle(option.color), isSelected: accent == option.rawValue)
                }
                .buttonStyle(.plain)
                .clickablePointer()
                .help(option.title)
                .accessibilityLabel(option.title)
                .accessibilityAddTraits(accent == option.rawValue ? .isSelected : [])
            }
            // Any color, from the system's color panel.
            Button {
                ColorPanel.shared.open(Look.Accent(rawValue: accent) == nil ? Look.accent(accent) : .accentColor) { accent = $0.hex }
            } label: {
                Swatch(fill: isCustom ? AnyShapeStyle(Look.accent(accent)) : AnyShapeStyle(.clear), isSelected: isCustom)
                    .overlay {
                        if !isCustom {
                            Image(systemName: "plus")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .overlay {
                        if !isCustom { Circle().strokeBorder(.secondary.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [2.5, 2])).padding(3) }
                    }
            }
            .buttonStyle(.plain)
            .clickablePointer()
            .help("Custom Color…")
        }
    }

    private var isCustom: Bool { Look.Accent(rawValue: accent) == nil }

    private struct Swatch: View {
        let fill: AnyShapeStyle
        let isSelected: Bool

        var body: some View {
            Circle()
                .fill(fill)
                .frame(width: 18, height: 18)
                .overlay { Circle().strokeBorder(.black.opacity(0.12), lineWidth: 0.5) }
                .padding(3)
                .overlay {
                    if isSelected { Circle().strokeBorder(.primary.opacity(0.55), lineWidth: 1.5) }
                }
                .contentShape(.circle)
        }
    }
}

/// A message and a reply, as they'd read with the chosen size and typeface.
private struct ConversationPreview: View {
    let font: MessageFont
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add a farewell function next to greet.")
                .font(font.body)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .accentGlass(RoundedRectangle(cornerRadius: Metrics.bubbleRadius))
                .frame(maxWidth: .infinity, alignment: .trailing)
            (Text("Added ") + Text("farewell(name)").font(font.code) + Text(" to hello.py, with a test for each function. All 4 tests pass."))
                .font(font.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity)
        .background(Surface.cardFill(scheme, focused: true), in: .rect(cornerRadius: 12))
        .specularRim(RoundedRectangle(cornerRadius: 12))
        .padding(.vertical, 4)
    }
}

/// The system's color panel, telling `onChange` each color picked.
@MainActor
final class ColorPanel: NSObject {
    static let shared = ColorPanel()
    private var onChange: ((Color) -> Void)?

    func open(_ color: Color, onChange: @escaping (Color) -> Void) {
        self.onChange = onChange
        let panel = NSColorPanel.shared
        panel.showsAlpha = false
        panel.color = NSColor(color)
        panel.setTarget(self)
        panel.setAction(#selector(changed(_:)))
        panel.isContinuous = true
        panel.makeKeyAndOrderFront(nil)
    }

    @objc private func changed(_ panel: NSColorPanel) {
        onChange?(Color(nsColor: panel.color))
    }
}
