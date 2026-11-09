import SwiftUI

/// A row's title with a short note at its end (a session started from another computer: "from
/// Mini"), the same in both apps. The title always wins: the note shows only where the title still
/// keeps about its first twelve characters beside it, and otherwise the row is the title's alone
/// (its hover text and VoiceOver hint still say what the note would). The note is drawn as given,
/// at its own width; the title takes the rest, cut at its end.
public struct TitleWithTail<Title: View, Tail: View>: View {
    /// What of the title it keeps at least, beside the note.
    private let kept: String
    private let spacing: CGFloat
    private let title: Title
    private let tail: Tail

    /// `text`: the title's words, as `title` draws them, in the same font.
    public init(_ text: String, spacing: CGFloat = 6, @ViewBuilder title: () -> Title, @ViewBuilder tail: () -> Tail) {
        kept = Self.kept(of: text)
        self.spacing = spacing
        self.title = title()
        self.tail = tail()
    }

    /// About its first twelve characters, as it reads cut there.
    static func kept(of text: String) -> String {
        text.count > 12 ? text.prefix(12).trimmingCharacters(in: .whitespaces) + "…" : text
    }

    public var body: some View {
        // The first that fits at its ideal width: what the title keeps, then the note; else the title alone.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: spacing) {
                // (Measures by what the title keeps; it's drawn over that, in all the room left.)
                Text(kept)
                    .lineLimit(1)
                    .hidden()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .leading) { title }
                tail
            }
            title
        }
    }
}
