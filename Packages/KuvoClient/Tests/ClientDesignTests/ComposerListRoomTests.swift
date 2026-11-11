import ClientDesign
import CoreGraphics
import Testing

/// A list over the composer's field keeps to the room over it: the card's room less the field and
/// its chips and what the bars keep at least, a few rows however short the window.
@Suite struct ComposerListRoomTests {
    /// The Mac's card: 480 for the card, the field and its chips 120 tall, no bars.
    @Test func theListGetsWhatTheFieldLeaves() {
        // Before it opens, and once it's laid out at that height: the same room.
        #expect(ComposerListRoom.height(room: 480, card: 120, list: 0, bars: 0, barsKept: 44) == 360)
        #expect(ComposerListRoom.height(room: 480, card: 480, list: 360, bars: 0, barsKept: 44) == 360)
    }

    @Test func theBarsKeepWhatTheyKeepAtLeast() {
        // Bars 200 tall keep 44 of it; bars 30 tall, all of theirs.
        #expect(ComposerListRoom.height(room: 480, card: 320, list: 0, bars: 200, barsKept: 44) == 316)
        #expect(ComposerListRoom.height(room: 480, card: 150, list: 0, bars: 30, barsKept: 44) == 330)
    }

    @Test func aFewRowsHoweverShortTheWindow() {
        #expect(ComposerListRoom.height(room: 100, card: 120, list: 0, bars: 0, barsKept: 44) == ComposerListRoom.least)
    }
}
