import ClientDesign
import SwiftUI

/// A bar of the card over the composer, as one item of its line once the bars are tucked away:
/// its mark (a spinner for work under way) and a few words.
struct BarStripItem: Identifiable, Equatable {
    let bar: ComposerBar
    /// Nil: at work, a spinner.
    let symbol: String?
    var isDone = false
    let words: String

    var id: ComposerBar { bar }
}

/// The bars tucked away, in one line: what each is, and a dot on what changed since. A click
/// anywhere on it brings them back.
struct BarStrip: View {
    let items: [BarStripItem]
    let marked: Set<ComposerBar>
    let show: () -> Void

    var body: some View {
        Button(action: show) {
            HStack(spacing: 0) {
                // Each in its words while they fit; past that, their marks alone.
                ViewThatFits(in: .horizontal) {
                    line(words: true)
                    line(words: false)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.up")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
            }
            .padding(.leading, 14)
            .padding(.trailing, 8)
            .frame(height: 34)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .help("Show the bars")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
        .accessibilityValue(spokenNews)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { show() }
    }

    // (Apart from the body, which is long enough for the compiler as it is.)
    private var spoken: String { "Bars: " + items.map(\.words).joined(separator: ", ") }
    private var spokenNews: String {
        marked.isEmpty ? "" : "New: " + items.filter { marked.contains($0.bar) }.map(\.words).joined(separator: ", ")
    }

    private func line(words: Bool) -> some View {
        HStack(spacing: words ? 14 : 10) {
            ForEach(items) { item in
                let isNew = marked.contains(item.bar)
                HStack(spacing: 5) {
                    Group {
                        if let symbol = item.symbol {
                            Image(systemName: symbol)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(item.isDone ? AnyShapeStyle(.green) : AnyShapeStyle(.tint))
                        } else {
                            Spinner(size: 11)
                        }
                    }
                    .frame(width: 14)
                    if words {
                        Text(item.words)
                            .font(.system(size: 12.5, weight: isNew ? .semibold : .regular))
                            .foregroundStyle(isNew ? .primary : .secondary)
                            .lineLimit(1)
                            .fixedSize()
                    }
                    if isNew {
                        Circle()
                            .fill(.tint)
                            .frame(width: 6, height: 6)
                    }
                }
            }
        }
    }
}
