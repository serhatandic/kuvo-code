import CoreGraphics

// A scrolling list that follows its newest as it comes, as a conversation does: the same rule on
// the Mac and the phone (a side thread's answers).

/// Whether a list keeps its end in view as it grows: it opens there and follows what comes, until
/// you scroll up away from the end; it follows again once you're back at the end, or ask something
/// new.
public struct FollowsEnd: Equatable {
    public init() {}

    public private(set) var isFollowing = true

    /// How close to the end still counts as at it.
    public static let slack: CGFloat = 12

    /// You stopped scrolling, with `visibleBottom` (the offset plus the visible height) of
    /// `contentHeight`.
    public mutating func scrolled(visibleBottom: CGFloat, contentHeight: CGFloat) {
        isFollowing = visibleBottom >= contentHeight - Self.slack
    }

    /// You asked something: its answer is what you're waiting for.
    public mutating func asked() {
        isFollowing = true
    }
}
