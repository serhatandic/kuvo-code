import ClientDesign
import SwiftUI

/// The window's content card: the conversation (with the session beside it, in split view), the
/// panel while it's expanded over them, or Settings' page. It reads as the window's background
/// (the sidebar sits on the glass beside it), so what shows over the whole window (a notice at
/// the top, a palette, an ask card) centers on it rather than on the window, and moves with it as
/// the sidebar, the panel or Settings come and go.
///
/// The cards mark themselves with `contentCard(_:)`; a view laying things over the window does it
/// with `overContentCard(_:)`, and each thing in it centers with `centeredOnContentCard()`. Read
/// through anchors, so it moves in the same update as the cards, and nothing that holds the
/// cards lays itself out again for it. It slides as the cards do when the window's layout
/// changes (the sidebar or the panel coming or going, Settings opening), and keeps up exactly
/// with a card being resized.
enum ContentCard {
    /// Which card is the content, when more than one says it is: Settings over the sessions under
    /// them, the expanded panel over the conversation.
    enum Rank: Int, Comparable {
        case conversation, expandedPanel, settings
        static func < (lhs: Rank, rhs: Rank) -> Bool { lhs.rawValue < rhs.rawValue }
    }

    fileprivate struct Part {
        let rank: Rank
        let bounds: Anchor<CGRect>
        let layout: Int
    }

    fileprivate struct Key: PreferenceKey {
        static let defaultValue: [Part] = []
        static func reduce(value: inout [Part], nextValue: () -> [Part]) { value += nextValue() }
    }

    /// The card that says it's the content with the highest rank (its parts together), in `proxy`.
    fileprivate static func span(of parts: [Part], in proxy: GeometryProxy) -> Span {
        let top = parts.map(\.rank).max()
        let card = parts.filter { $0.rank == top }.map { proxy[$0.bounds] }.reduce(nil) { $0?.union($1) ?? $1 }
        var layout = Hasher()
        for part in parts {
            layout.combine(part.rank)
            layout.combine(part.layout)
        }
        return Span(card: card, width: proxy.size.width, layout: layout.finalize())
    }

    /// Where the card is across what's laid over the window, and how wide that is.
    fileprivate struct Span: Equatable {
        var card: CGRect?
        var width: CGFloat = 0
        /// Changes as the window's layout does, not as a card is resized.
        var layout = 0
    }
}

private struct ContentCardSpanKey: EnvironmentKey {
    static let defaultValue = ContentCard.Span()
}

private extension EnvironmentValues {
    var contentCardSpan: ContentCard.Span {
        get { self[ContentCardSpanKey.self] }
        set { self[ContentCardSpanKey.self] = newValue }
    }
}

extension View {
    /// This is the window's content card, or a part of it (the conversation and the session
    /// beside it are one); `nil`, not now. `layout` is what the cards are laid out from apart from
    /// their sizes (which of them show), for what's centered on it to slide with them as it changes.
    func contentCard(_ rank: ContentCard.Rank? = .conversation, layout: some Hashable = 0) -> some View {
        anchorPreference(key: ContentCard.Key.self, value: .bounds) { bounds in
            rank.map { [ContentCard.Part(rank: $0, bounds: bounds, layout: layout.hashValue)] } ?? []
        }
    }

    /// Lays `overlay` over this view from its top, as `overlay(alignment: .top)` does, telling it
    /// where the content card is for `centeredOnContentCard()`.
    func overContentCard<Overlay: View>(@ViewBuilder _ overlay: @escaping () -> Overlay) -> some View {
        overlayPreferenceValue(ContentCard.Key.self) { parts in
            GeometryReader { proxy in
                overlay()
                    .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
                    .environment(\.contentCardSpan, ContentCard.span(of: parts, in: proxy))
            }
        }
    }

    /// Centered on the content card rather than on the whole of what it's laid over; wider than
    /// the card, kept inside it.
    func centeredOnContentCard() -> some View {
        modifier(CenteredOnContentCard())
    }
}

private struct CenteredOnContentCard: ViewModifier {
    @Environment(\.contentCardSpan) private var span
    @State private var width: CGFloat = 0

    func body(content: Content) -> some View {
        let half = width / 2
        let center = span.card.map { min(max($0.midX, half), span.width - half) } ?? span.width / 2
        content
            .onGeometryChange(for: CGFloat.self, of: \.size.width) { width = $0 }
            .offset(x: span.width > 0 ? center - span.width / 2 : 0)
            .animation(.ui, value: span.layout)
    }
}
