import KuvoVoice
import SwiftUI

/// Settings › General › Voice Input: how voice input shows itself, as two pictures to pick from,
/// and its shortcut.
struct VoiceSettings: View {
    @AppStorage(VoiceStyle.key) private var style = VoiceStyle.composer.rawValue

    var body: some View {
        // Titled above its card, as General's other sections are.
        Section("Voice Input") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Talk instead of typing. Your words are recognized on this Mac, and nothing is sent until you press Send.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 12) {
                    ForEach(VoiceStyle.allCases) { each in
                        VoiceStyleTile(style: each, isOn: style == each.rawValue) { style = each.rawValue }
                    }
                }
            }
            .padding(.vertical, 4)
            LabeledContent {
                Text("⇧⌘Space")
                    .font(.system(size: 13))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: .rect(cornerRadius: 6))
            } label: {
                Text("Shortcut")
                Text("Hold it to talk, or press it to start and again to stop.")
            }
            SpeechModelRow(model: .shared)
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
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .background(ground)
                    .clipShape(.rect(cornerRadius: 8))
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

    @Environment(\.colorScheme) private var scheme

    /// The desktop the pictures sit on, as Settings › Appearance draws it.
    private var ground: Color { scheme == .dark ? Color(red: 0.2, green: 0.21, blue: 0.24) : Color(red: 0.84, green: 0.86, blue: 0.89) }

    /// A corner of each, run off the tile's right and bottom edges: the composer listening, its
    /// wave live in it; or the Voice Field over the stepped-back window, your words and its wave.
    @ViewBuilder private var picture: some View {
        switch style {
        case .composer:
            HStack(spacing: 8) {
                Image(systemName: "mic.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.red)
                HStack(spacing: 2) {
                    ForEach(0..<40, id: \.self) { index in
                        Capsule().fill(.tint).frame(width: 2, height: 4 + CGFloat((index * 7) % 13))
                    }
                }
            }
            .padding(.horizontal, 12)
            .frame(minWidth: 260, maxWidth: .infinity, minHeight: 40, maxHeight: 40, alignment: .leading)
            .background(.background, in: UnevenRoundedRectangle(topLeadingRadius: 12, bottomLeadingRadius: 12))
            .overlay(UnevenRoundedRectangle(topLeadingRadius: 12, bottomLeadingRadius: 12).strokeBorder(.tint, lineWidth: 1.5))
            .shadow(color: .black.opacity(0.12), radius: 4, y: 1)
            .padding(.leading, 14)
            // Past the tile's right edge, however wide it is.
            .padding(.trailing, -12)
            .padding(.top, 38)
        case .field:
            VStack(alignment: .leading, spacing: 8) {
                Text("Pause the timer when the tab")
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                    .fixedSize()
                VoiceWave(level: 0.45)
                    .frame(width: 120, height: 16)
            }
            .padding(12)
            .frame(minWidth: 260, maxWidth: .infinity, minHeight: 90, maxHeight: 90, alignment: .topLeading)
            .background(.background, in: UnevenRoundedRectangle(topLeadingRadius: 14))
            .shadow(color: .black.opacity(0.14), radius: 5, y: 1)
            .padding(.leading, 14)
            .padding(.trailing, -12)
            .padding(.top, 16)
        }
    }
}
