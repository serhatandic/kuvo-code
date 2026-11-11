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
    /// Its four lines leave words out, as they're laid out: a quote of a few sentences does, short
    /// of `isLong`'s characters, in the 420 points a quote has and fewer in a narrow window.
    @State private var isLimited = false
    /// Whether they do at the widths they're measured at: Show All's room is in its height from
    /// then on (`ShowAllLayout`).
    @State private var cuts = TextCuts()

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
            ShowAllLayout(cuts: cuts, shows: isExpanded || isCut) {
                // AppKit's text, as your words': its pointer shows only where nothing's drawn over it.
                // Asked whether the limit cuts it only while there is one: all of it showing says
                // nothing of what Show Less brings back.
                SelectableText(text: MessageMentions.attributed(FindText.marked(AttributedString(text), highlight),
                                                                font: .preferredFont(forTextStyle: .callout), color: .secondaryLabelColor).text,
                               lineLimit: isExpanded ? nil : 4,
                               cut: isExpanded ? nil : { isLimited = $0 }, cuts: cuts)
                // There, in the room it has once the words are measured cut, from when they say so.
                Button(isExpanded ? "Show Less" : "Show All") { withAnimation(.ui) { isExpanded.toggle() } }
                    .buttonStyle(TextButtonStyle())
                    .font(.caption)
                    .opacity(isExpanded || isCut ? 1 : 0)
                    .disabled(!(isExpanded || isCut))
                    .accessibilityHidden(!(isExpanded || isCut))
                    .allowsHitTesting(isExpanded || isCut)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        // Find on a place in it: all of it shows.
        .onChange(of: highlight?.current) { if highlight?.current != nil, isCut { isExpanded = true } }
    }
}

/// A quote's words over its Show All (or Show Less), at their leading edge. The button's room is
/// part of the quote's height as soon as its words are measured cut, so a conversation measures
/// the message as tall as it shows: `cut` says so only once they're laid out, a turn later, and
/// the rows under it would slide down from under it then (as a long message's Show More did,
/// before its `ShowMoreLayout`).
private struct ShowAllLayout: Layout {
    let cuts: TextCuts
    /// The button shows: Show Less, or Show All once the words said they're cut (or surely are).
    /// While it shows it keeps its room, so it's never drawn over what's under the quote.
    let shows: Bool
    private let spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let words = subviews.first?.sizeThatFits(proposal) else { return .zero }
        guard let button = button(proposal, subviews) else { return words }
        return CGSize(width: max(words.width, button.width), height: words.height + spacing + button.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let first = subviews.first else { return }
        let words = first.sizeThatFits(proposal)
        first.place(at: bounds.origin, proposal: ProposedViewSize(width: proposal.width, height: words.height))
        // Without its room it doesn't show either: under the rest, out of the way.
        guard subviews.count > 1 else { return }
        let button = subviews[1].sizeThatFits(.unspecified)
        subviews[1].place(at: CGPoint(x: bounds.minX, y: bounds.minY + words.height + spacing), proposal: ProposedViewSize(button))
    }

    /// The button's size, if it has room: it shows, or the words are cut at the width they get.
    private func button(_ proposal: ProposedViewSize, _ subviews: Subviews) -> CGSize? {
        guard subviews.count > 1 else { return nil }
        guard shows || proposal.width.flatMap({ cuts.at($0) }) == true else { return nil }
        return subviews[1].sizeThatFits(.unspecified)
    }
}
