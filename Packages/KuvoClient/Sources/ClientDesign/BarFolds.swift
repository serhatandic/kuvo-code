// The bars in the card over a conversation's composer, folding once it's full: the same rule on
// the Mac and the phone, whose bars differ.

/// Which bar in the card is open once the card is full: with three bars or more, each folds to
/// its line but the one that most needs you. While a card asks something over it, that's the
/// card, so they all fold; otherwise it's the newest change (a bar that came, a review that found
/// something, a side question answered). Opening one folds the others, so the card stays a few
/// lines tall. With fewer bars, each opens and folds on its own, as you left it.
public struct BarFolds<Bar: Hashable>: Equatable {
    public init() {}

    /// How many bars fill the card.
    public static var full: Int { 3 }

    /// The one open while the card is full.
    public private(set) var open: Bar?
    /// Opened by you, so it stays open while a card asks.
    public private(set) var openedByYou = false

    /// Whether `bar` is folded, among `bars`; `own` is how it was left with fewer bars.
    public func isHidden(_ bar: Bar, among bars: [Bar], asking: Bool, own: Bool) -> Bool {
        guard bars.count >= Self.full else { return own }
        let shown = asking && !openedByYou ? nil : open
        return shown != bar
    }

    /// Opened or folded by you.
    public mutating func set(_ bar: Bar, hidden: Bool, among bars: [Bar], own: inout Bool) {
        guard bars.count >= Self.full else { return own = hidden }
        if hidden {
            if open == bar { open = nil }
        } else {
            open = bar
            openedByYou = true
        }
    }

    /// Something changed in `bar` that you'd want to see: it opens, unless a card asks.
    public mutating func changed(_ bar: Bar) {
        open = bar
        openedByYou = false
    }

    /// Opened by you from elsewhere (a side question picked in the sidebar): open, a card asking or not.
    public mutating func opened(_ bar: Bar) {
        open = bar
        openedByYou = true
    }

    /// The bars went from `old` to `new`: one that went isn't open any more, and the newest that
    /// came opens where `opens` says it's worth seeing.
    public mutating func bars(from old: [Bar], to new: [Bar], opens: (Bar) -> Bool) {
        if let open, !new.contains(open) {
            self.open = nil
            openedByYou = false
        }
        if let came = new.last(where: { !old.contains($0) && opens($0) }) { changed(came) }
    }

    /// Nothing asks any more: a bar you opened while something did is just open, and the next card
    /// that asks folds it too.
    public mutating func askingEnded() {
        openedByYou = false
    }

    /// Shown again (another conversation, and back): the newest of the bars with something to see
    /// opens, unless one is open already.
    public mutating func start(_ bars: [Bar], opens: (Bar) -> Bool) {
        guard open == nil, let bar = bars.last(where: opens) else { return }
        changed(bar)
    }
}
