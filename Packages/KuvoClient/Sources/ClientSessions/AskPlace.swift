/// Which of the asks waiting in a conversation shows in the composer's place, one at a time, and
/// "2 of 3" over it where more wait. The same on the Mac and the phone.
///
/// It stays on the ask that shows while that one waits, whatever comes in meanwhile, so a new ask
/// never takes the place of the one you're reading or writing to; one that comes shows on the
/// pager's count. Once the one that shows is answered, the next after it shows (or, if it was the
/// last, the one before).
public struct AskPlace: Equatable, Sendable {
    /// The ask that shows, by its id.
    public private(set) var shown: String?
    /// The asks waiting, in their order, as last told.
    public private(set) var waiting: [String] = []

    public init() {}

    /// The asks waiting now, in their order.
    public mutating func update(_ now: [String]) {
        defer { waiting = now }
        guard !now.isEmpty else { return shown = nil }
        if let shown, now.contains(shown) { return }
        if let shown, let was = waiting.firstIndex(of: shown) {
            let after = waiting[(was + 1)...].first(where: now.contains)
            let before = waiting[..<was].last(where: now.contains)
            self.shown = after ?? before ?? now[0]
        } else {
            shown = now[0]
        }
    }

    /// To the ask at `index` (the pager's arrows).
    public mutating func show(_ index: Int) {
        guard waiting.indices.contains(index) else { return }
        shown = waiting[index]
    }

    /// Where the one that shows is among them.
    public var index: Int? { shown.flatMap(waiting.firstIndex(of:)) }

    /// "2 of 3", where more than one waits.
    public var words: String? {
        guard waiting.count > 1, let index else { return nil }
        return "\(index + 1) of \(waiting.count)"
    }
}
