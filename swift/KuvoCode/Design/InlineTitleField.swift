import AppKit
import SwiftUI

/// A title renamed where it's shown (a session's row in the sidebar, its card's header), all of it
/// selected to type over; or a name for something new, typed where it'll show (a branch). Return
/// or clicking away keeps it, as the Finder does, and so does the field going away (its row folded
/// up, another tab chosen); Escape leaves it as it was.
struct InlineTitleField: View {
    let original: String
    /// What goes in an empty field (a new one's).
    var prompt = "Title"
    /// False for something made only on Return (a branch): clicking away, or the field going
    /// away, leaves it unmade.
    var keepsOnLeaving = true
    let commit: (String) -> Void
    let cancel: () -> Void
    @State private var text = ""
    @State private var isDone = false
    @FocusState private var isFocused: Bool

    var body: some View {
        TextField(prompt, text: $text, prompt: Text(prompt))
            .textFieldStyle(.plain)
            .labelsHidden()
            .focused($isFocused)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(.primary.opacity(0.06), in: .rect(cornerRadius: 5))
            .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(.tint.opacity(0.7), lineWidth: 1.5) }
            .padding(.horizontal, -5)
            .onSubmit { finish(keeping: true) }
            .onKeyPress(.escape) {
                finish(keeping: false)
                return .handled
            }
            .onChange(of: isFocused) { _, focused in if !focused { finish(keeping: keepsOnLeaving) } }
            .onAppear {
                text = original
                isFocused = true
                // All of it selected, to type a new one over it.
                DispatchQueue.main.async { NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil) }
            }
            // Gone without a word (its row folded up, another tab chosen): it ends here, so it
            // doesn't come back later and take the keyboard.
            .onDisappear { finish(keeping: keepsOnLeaving) }
            .accessibilityLabel(prompt)
    }

    private func finish(keeping: Bool) {
        guard !isDone else { return }
        isDone = true
        let title = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if keeping, !title.isEmpty, title != original { commit(title) } else { cancel() }
    }
}
