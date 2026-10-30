import ClientDesign
import SwiftUI

/// The bars in the card over the composer, in the order they show.
enum ComposerBar: Hashable {
    case goal, handoff, review, sideQuestion, subagents, work, background, wakes
}

/// A row of the card over the composer: a line under it, between it and the next.
struct CardRow: ViewModifier {
    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            Divider()
                .padding(.horizontal, 14)
                .allowsHitTesting(false)
        }
    }
}

/// In the place of what was put away: what went, with Undo where its ✕ was, until it's gone
/// for good. `undo` is nil once it's on its way out.
struct UndoLine: View {
    let text: String
    let undo: (() -> Void)?
    /// A bar's line, or a row in a bar's list.
    var isRow = false
    /// VoiceOver comes to it, as the ✕ it was on is gone.
    @AccessibilityFocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.uturn.backward.circle")
                .font(.system(size: isRow ? 12 : 13))
                .foregroundStyle(.secondary)
                .frame(width: isRow ? nil : 18)
            Text(text)
                .font(.system(size: isRow ? 12 : 13))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 8)
            if let undo {
                Button("Undo", action: undo)
                    .buttonStyle(TextButtonStyle())
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.tint)
                    .fixedSize()
                    .help("Bring it back")
            }
        }
        .padding(.leading, isRow ? 0 : 14)
        // Undo ends where the ✕ did.
        .padding(.trailing, isRow ? 0 : 8)
        .frame(height: isRow ? nil : 36)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
        // Undo, as the line's own action while it's offered.
        .accessibilityAddTraits(undo == nil ? [] : .isButton)
        .accessibilityHint(undo == nil ? "" : "Undo")
        .accessibilityAction { undo?() }
        .accessibilityFocused($isFocused)
        .onAppear { if undo != nil { isFocused = true } }
    }
}
