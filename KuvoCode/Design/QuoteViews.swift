import ClientDesign
import SwiftUI

/// Over the composer: what you're replying to, shortened, with a way to drop it.
struct QuoteCard: View {
    let text: String
    /// "Replying to" over it: where nothing else says what it is.
    var says = true
    let remove: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Capsule()
                .fill(.tint)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 2) {
                if says {
                    Text("Replying to")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button("Don’t Reply to This", systemImage: "xmark", action: remove)
                .labelStyle(.iconOnly)
                .buttonStyle(IconButtonStyle())
                .help("Drop the quote")
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, 7)
        .padding(.horizontal, 9)
        .recessedWell(RoundedRectangle(cornerRadius: 10))
    }
}

/// In a message you sent: what it replied to, above your words.
struct QuoteBlock: View {
    let text: String
    @Environment(\.findHighlight) private var highlight
    @State private var isExpanded = false
    /// Its four lines leave words out, as they're laid out: a narrow window's fill with fewer than
    /// `isLong`'s characters.
    @State private var isLimited = false

    /// More than fits in its four lines, likely: it opens to all of it.
    private var isLong: Bool {
        text.count > 280 || text.split(separator: "\n", omittingEmptySubsequences: false).count > 4
    }

    private var isCut: Bool { isLong || isLimited }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Capsule()
                .fill(.secondary.opacity(0.45))
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 4) {
                // AppKit's text, as your words': its pointer shows only where nothing's drawn over it.
                SelectableText(text: MessageMentions.attributed(FindText.marked(AttributedString(text), highlight),
                                                                font: .preferredFont(forTextStyle: .callout), color: .secondaryLabelColor).text,
                               lineLimit: isExpanded ? nil : 4,
                               // Asked only while there's a limit: all of it showing says nothing of what Show Less brings back.
                               cut: isExpanded ? nil : { isLimited = $0 })
                if isExpanded || isCut {
                    Button(isExpanded ? "Show Less" : "Show All") { withAnimation(.ui) { isExpanded.toggle() } }
                        .buttonStyle(TextButtonStyle())
                        .font(.caption)
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        // Find on a place in it: all of it shows.
        .onChange(of: highlight?.current) { if highlight?.current != nil, isCut { isExpanded = true } }
    }
}
