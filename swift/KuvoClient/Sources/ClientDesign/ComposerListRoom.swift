import CoreGraphics

/// How tall a list over a composer's field ("/", "@", "&", and what a keyword asks next) can be
/// before it scrolls inside: the room the card over the conversation has, less the rest of the
/// card (the field and its chips, what waits) and as much of the bars over it as they keep at
/// least, so the field and its chips stay in sight however short the window. The same rule on the
/// Mac and the phone, whose rooms and bars differ (#228, #299).
public enum ComposerListRoom {
    /// The least a list gets, about three rows, however little room there is.
    public static let least: CGFloat = 88

    /// - Parameters:
    ///   - room: what the whole card can take.
    ///   - card: the card's height as shown, with the list and the bars in it.
    ///   - list: the list's height as shown (0 while none is open).
    ///   - bars: the bars' height as shown.
    ///   - barsKept: the bars' height kept at least, while there are bars, before they scroll.
    public static func height(room: CGFloat, card: CGFloat, list: CGFloat, bars: CGFloat, barsKept: CGFloat) -> CGFloat {
        let rest = card - bars - list
        return max(least, room - rest - min(bars, barsKept))
    }
}
