// The bars in the card over a conversation's composer, folding once it's full: the same rule on
// the Mac and the phone, whose bars differ.

/// Which bar in the card is open. While a card asks something over it, that's what needs you, so
/// every bar folds to its line, however many there are, but one you open yourself; answering
/// brings them back as they were. Otherwise, once the card is full (three bars or more), each
/// folds to its line but the newest change (a bar that came, a review that found something, a
/// side question answered), and opening one folds the others, so the card stays a few lines
/// tall. With fewer bars, each opens and folds on its own, as you left it.
public struct BarFolds<Bar: Hashable>: Equatable {
    public init() {}

    /// How many bars fill the card.
    public static var full: Int { 3 }

    /// The one open while the card is full; with fewer bars, the last one you opened.
    public private(set) var open: Bar?
    /// Opened by you, so it stays open while a card asks.
    public private(set) var openedByYou = false
    private var isWriting = false

    /// News is still marked while writing, but must not replace the layout to restore.
    public mutating func writing(_ active: Bool) { isWriting = active }

    /// Whether `bar` is folded, among `bars`; `own` is how it was left with fewer bars.
    public func isHidden(_ bar: Bar, among bars: [Bar], asking: Bool, own: Bool) -> Bool {
        if asking { return !(openedByYou && open == bar) }
        guard bars.count >= Self.full else { return own }
        return open != bar
    }

    /// Opened or folded by you.
    public mutating func set(_ bar: Bar, hidden: Bool, among bars: [Bar], own: inout Bool) {
        if bars.count < Self.full { own = hidden }
        if hidden {
            if open == bar { open = nil }
        } else {
            open = bar
            openedByYou = true
        }
    }

    /// Something changed in `bar` that you'd want to see: it opens, unless a card asks. While one
    /// asks, a bar you opened stays the open one.
    public mutating func changed(_ bar: Bar, asking: Bool = false) {
        guard !isWriting else { return }
        if asking, openedByYou, open != nil { return }
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
    public mutating func bars(from old: [Bar], to new: [Bar], asking: Bool = false, opens: (Bar) -> Bool) {
        if let open, !new.contains(open) {
            self.open = nil
            openedByYou = false
        }
        if let came = new.last(where: { !old.contains($0) && opens($0) }) { changed(came, asking: asking) }
    }

    /// Nothing asks any more: a bar you opened while something did is just open, and the next card
    /// that asks folds it too.
    public mutating func askingEnded() {
        openedByYou = false
    }

    /// The bars showing went from `old` to `new`, or the card showed again (`old == new`), as both
    /// apps' cards follow them. No longer full: each keeps what the card showed (`keep` hands it
    /// its own way), rather than springing open. Then, shown again, the newest with something to
    /// see (`news`) opens; changed, the newest that came, where `opens` says it's worth seeing.
    public mutating func update(from old: [Bar], to new: [Bar], asking: Bool, own: (Bar) -> Bool, keep: (Bar, Bool) -> Void,
                                news: (Bar) -> Bool, opens: (Bar) -> Bool) {
        // (As the card had them past what asks: answering brings them back so.)
        if old.count >= Self.full, new.count < Self.full {
            for bar in new { keep(bar, isHidden(bar, among: old, asking: false, own: own(bar))) }
        }
        if old == new {
            start(new, opens: news)
        } else {
            bars(from: old, to: new, asking: asking, opens: opens)
        }
    }

    /// What has something to see in each bar changed: the one that just got something opens.
    /// Those that got something, for a tucked card to mark (`BarTuck`).
    @discardableResult public mutating func news(from old: [Bar: Bool], to new: [Bar: Bool], asking: Bool = false) -> [Bar] {
        let came = new.filter { $0.value && old[$0.key] != true }.map(\.key)
        if let first = came.first { changed(first, asking: asking) }
        return came
    }

    /// Shown again (another conversation, and back): the newest of the bars with something to see
    /// opens, unless one is open already.
    public mutating func start(_ bars: [Bar], opens: (Bar) -> Bool) {
        guard open == nil, let bar = bars.last(where: opens) else { return }
        changed(bar)
    }
}

/// The bars in the card over the composer tucked into one line (the Mac's and the phone's
/// `BarStrip`). A manual fold stays until opened; writing temporarily tucks them, preserving
/// the manual choice. What came or changed meanwhile is `marked` until they show again.
/// Once none are left, the manual fold resets.
public struct BarTuck<Bar: Hashable>: Equatable {
    public init() {}

    private var hidden = false
    public private(set) var isWriting = false
    private var openedWhileWriting = false
    private var sentWithFocus = false

    /// Focus or a draft temporarily tucks the card without changing any bar's fold.
    public mutating func writing(focused: Bool, hasText: Bool) {
        if !focused || hasText { sentWithFocus = false }
        let active = hasText || (focused && !sentWithFocus)
        if active != isWriting { openedWhileWriting = false }
        isWriting = active
        if !isWriting && !hidden { marked = [] }
    }

    /// Sending ends this writing interval even where the field keeps the keyboard.
    public mutating func sent() {
        isWriting = false
        openedWhileWriting = false
        sentWithFocus = true
        if !hidden { marked = [] }
    }

    private var isHidden: Bool { hidden || (isWriting && !openedWhileWriting) }
    /// What came, or changed in a way you'd want to see, since they were tucked.
    public private(set) var marked: Set<Bar> = []

    /// Whether they're tucked, among `bars` (none: nothing to tuck).
    public func isOn(among bars: [Bar]) -> Bool { isHidden && !bars.isEmpty }

    public mutating func hide() {
        hidden = true
        marked = []
    }

    public mutating func show() {
        hidden = false
        openedWhileWriting = isWriting
        marked = []
    }

    /// The bars went from `old` to `new`: while tucked, those that came are marked; none left,
    /// it's over.
    public mutating func bars(from old: [Bar], to new: [Bar]) {
        if new.isEmpty {
            hidden = false
            marked = []
            return
        }
        guard isHidden else { return }
        marked.formUnion(new.filter { !old.contains($0) })
    }

    /// Something changed in `bar` that you'd want to see: marked, while tucked.
    public mutating func changed(_ bar: Bar) {
        if isHidden { marked.insert(bar) }
    }
}
