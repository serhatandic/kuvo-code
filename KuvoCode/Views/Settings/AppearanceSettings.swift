import AppKit
import ClientDesign
import SwiftUI

/// Appearance: light or dark, the accent color, the window, how messages read, with a preview of
/// a conversation in what's chosen.
struct AppearanceSettings: View {
    @AppStorage(Appearance.key) private var mode = Appearance.system
    @AppStorage(Look.accentKey) private var accent = Look.Accent.system.rawValue
    @AppStorage(Look.windowKey) private var window = Look.Window.glass
    @AppStorage(Look.textSizeKey) private var textSize = 14.0
    @AppStorage(Look.fontKey) private var typeface = Look.Typeface.system
    @AppStorage(StepsDetail.key) private var steps = StepsDetail.summary
    @AppStorage(ReviewLayout.key) private var reviewLayout = ReviewLayout.list

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
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 124), spacing: 12, alignment: .leading)], alignment: .leading, spacing: 12) { modes }
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
                    Text("Messages, replies, the composer and the sidebar.")
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
                LabeledContent {
                    Picker("Review findings", selection: $reviewLayout) {
                        Text("As a List").tag(ReviewLayout.list)
                        Text("One at a Time").tag(ReviewLayout.single)
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .fixedSize()
                } label: {
                    Text("Review findings")
                    Text("How /review shows what it found.")
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
                        reviewLayout = .list
                    }
                    .disabled(mode == .system && accent == Look.Accent.system.rawValue && window == .glass && textSize == 14 && typeface == .system && steps == .summary && reviewLayout == .list)
                }
            }
        }
    }

    private var stepsCaption: String {
        switch steps {
        case .each: "Every step the agent takes, as it takes it."
        case .summary: "Its steps between replies in a line, like “Worked for 40s”, that opens to each."
        case .minimal: "Only how many steps it took, to open if you want."
        }
    }

    private var accentName: String {
        if let preset = Look.Accent(rawValue: accent) { return preset.title }
        return "Custom, \(accent)"
    }
}

/// A corner of the window in a mode, to pick it by: large enough to see, run off the tile's edges.
private struct ModeThumbnail: View {
    let mode: Appearance
    let isSelected: Bool
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    static let size = CGSize(width: 124, height: 80)

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Group {
                    switch mode {
                    case .light: WindowCorner(dark: false)
                    case .dark: WindowCorner(dark: true)
                    case .system:
                        // Light and dark, split on a diagonal, as the Mac switches through the day.
                        ZStack {
                            WindowCorner(dark: false)
                            WindowCorner(dark: true)
                                .mask { Diagonal() }
                        }
                    }
                }
                .frame(width: Self.size.width, height: Self.size.height)
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

    /// The lower right half, from the top right corner to the bottom left.
    private nonisolated struct Diagonal: Shape {
        func path(in rect: CGRect) -> Path {
            Path { path in
                path.move(to: CGPoint(x: rect.maxX, y: rect.minY))
                path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
                path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
                path.closeSubpath()
            }
        }
    }
}

/// The window's top left corner over the desktop, cut by the tile's right and bottom edges: its
/// traffic lights, bots in the sidebar, and a message with the reply under it.
private struct WindowCorner: View {
    let dark: Bool
    @Environment(\.accent) private var accent

    private static let looks = BotTemplate.all.prefix(3).map(\.look)

    var body: some View {
        let ground = dark ? Color(red: 0.2, green: 0.21, blue: 0.24) : Color(red: 0.84, green: 0.86, blue: 0.89)
        let window = dark ? Color(red: 0.1, green: 0.105, blue: 0.12) : Color(red: 0.96, green: 0.955, blue: 0.945)
        let card = dark ? Color(red: 0.15, green: 0.155, blue: 0.175) : .white
        let ink = dark ? Color.white.opacity(0.26) : Surface.slate.opacity(0.16)
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 3.5) {
                    ForEach([Color.red, .yellow, .green], id: \.self) { Circle().fill($0.opacity(0.85)).frame(width: 6, height: 6) }
                }
                .padding(.bottom, 3)
                ForEach(Array(Self.looks.enumerated()), id: \.offset) { index, look in
                    HStack(spacing: 5) {
                        BotAvatar(look: look, size: 12, animates: false)
                        Capsule().fill(ink).frame(width: index == 1 ? 16 : 20, height: 3.5)
                    }
                }
            }
            .padding(.top, 8)
            .padding(.leading, 8)
            .frame(width: 50, alignment: .leading)
            VStack(alignment: .leading, spacing: 7) {
                Capsule().fill(accent.opacity(dark ? 0.55 : 0.32)).frame(width: 40, height: 11)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                VStack(alignment: .leading, spacing: 4) {
                    Capsule().fill(ink).frame(width: 56, height: 3.5)
                    Capsule().fill(ink).frame(width: 46, height: 3.5)
                    Capsule().fill(ink).frame(width: 52, height: 3.5)
                }
            }
            .padding(8)
            .frame(width: 96, height: 90, alignment: .topLeading)
            .background(card, in: UnevenRoundedRectangle(topLeadingRadius: 6))
            .padding(.top, 6)
        }
        .frame(width: 160, height: 100, alignment: .topLeading)
        .background(window, in: UnevenRoundedRectangle(topLeadingRadius: 10))
        .shadow(color: .black.opacity(dark ? 0.35 : 0.12), radius: 4, y: 1)
        .padding(.leading, 14)
        .padding(.top, 12)
        .frame(width: ModeThumbnail.size.width, height: ModeThumbnail.size.height, alignment: .topLeading)
        .background(ground)
    }
}

/// The accent colors as swatches, and any color from the color picker.
private struct AccentSwatches: View {
    @Binding var accent: String

    var body: some View {
        HStack(spacing: 8) {
            ForEach(Look.Accent.allCases) { option in
                Button {
                    // The color panel, if it's open, no longer picks the accent.
                    ColorPanel.shared.close()
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
            .accessibilityLabel("Custom Color")
            .accessibilityAddTraits(isCustom ? .isSelected : [])
        }
        // Leaving the page, the color panel no longer picks the accent.
        .onDisappear { ColorPanel.shared.close() }
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

    /// Closed, and no longer telling anyone its colors: a color picked after this changes nothing.
    func close() {
        guard onChange != nil else { return }
        onChange = nil
        let panel = NSColorPanel.shared
        panel.setTarget(nil)
        panel.setAction(nil)
        panel.orderOut(nil)
    }

    @objc private func changed(_ panel: NSColorPanel) {
        onChange?(Color(nsColor: panel.color))
    }
}
