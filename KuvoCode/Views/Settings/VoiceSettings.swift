import SwiftUI

/// Settings › General › Voice Input: how voice input shows itself, as two pictures to pick from,
/// and its shortcut.
struct VoiceSettings: View {
    @AppStorage(VoiceStyle.key) private var style = VoiceStyle.composer.rawValue

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Voice input")
                    Text("Talk instead of typing. Your words are recognized on this Mac, and nothing is sent until you press Send.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 12) {
                    ForEach(VoiceStyle.allCases) { each in
                        VoiceStyleTile(style: each, isOn: style == each.rawValue) { style = each.rawValue }
                    }
                }
            }
            .padding(.vertical, 4)
            LabeledContent {
                Text("⌘⇧Space")
                    .font(.system(size: 13))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: .rect(cornerRadius: 6))
            } label: {
                Text("Shortcut")
                Text("Hold it to talk while it’s held, or press it once to talk until you pause.")
            }
        }
    }
}

/// One way voice input shows itself, as a picture of it, picked with a click.
private struct VoiceStyleTile: View {
    let style: VoiceStyle
    let isOn: Bool
    let pick: () -> Void

    var body: some View {
        Button(action: pick) {
            VStack(alignment: .leading, spacing: 8) {
                picture
                    .frame(height: 92)
                    .frame(maxWidth: .infinity)
                    .background(.quaternary.opacity(0.6), in: .rect(cornerRadius: 8))
                HStack(spacing: 6) {
                    Image(systemName: isOn ? "largecircle.fill.circle" : "circle")
                        .foregroundStyle(isOn ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                    Text(style.title)
                    Text(style.purpose)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(8)
            .background(.background, in: .rect(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(isOn ? AnyShapeStyle(.tint) : AnyShapeStyle(.separator), lineWidth: isOn ? 2 : 1)
            }
            .contentShape(.rect(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .accessibilityLabel("\(style.title), \(style.purpose)")
        .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
    }

    /// The composer listening, its chips a trace; or the window stepped back behind your words.
    @ViewBuilder private var picture: some View {
        switch style {
        case .composer:
            VStack {
                Spacer(minLength: 0)
                HStack(spacing: 8) {
                    Circle().fill(.red).frame(width: 5, height: 5)
                    Spacer(minLength: 12)
                    HStack(spacing: 2) {
                        ForEach(0..<26, id: \.self) { index in
                            Capsule().fill(.tint).frame(width: 2, height: 4 + CGFloat((index * 7) % 11))
                        }
                    }
                }
                .padding(.horizontal, 10)
                .frame(height: 26)
                .background(.background, in: .rect(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(.tint, lineWidth: 1))
                .padding(10)
            }
        case .field:
            VStack(spacing: 6) {
                Capsule().fill(.secondary.opacity(0.5)).frame(width: 110, height: 5)
                Capsule().fill(.secondary.opacity(0.5)).frame(width: 74, height: 5)
                VoiceWave(level: 0.45)
                    .frame(height: 18)
                    .padding(.horizontal, 14)
                    .padding(.top, 4)
            }
        }
    }
}
