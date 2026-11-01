import CoreGraphics
import Testing
@testable import KuvoCode

/// The sidebar's computers by name, above their pages: as many as fit, in order, and a count for
/// the rest; the one in view always among them; all of them, and no count, when they fit.
@MainActor
struct BoxStripTests {
    /// Eight computers' names, 70 pt each, with a 40-pt count.
    private func shown(room: CGFloat, selected: Int, widths: [CGFloat] = Array(repeating: 70, count: 8)) -> [Int] {
        BoxNameStrip.shown(widths: widths, room: room, more: 40, spacing: 2, selected: selected)
    }

    @Test func asManyAsFitThenACount() {
        // 3 × 72 + 40 = 256 fits in 260; a fourth doesn't.
        #expect(shown(room: 260, selected: 0) == [0, 1, 2])
        #expect(shown(room: 260, selected: 2) == [0, 1, 2])
    }

    @Test func theOneInViewIsAlwaysThere() {
        // Picked from the count's menu: it takes the last place, the others keep theirs.
        #expect(shown(room: 260, selected: 6) == [0, 1, 6])
        // Wider than the one it replaces: it takes as many places as it needs.
        var widths = Array(repeating: CGFloat(70), count: 8)
        widths[6] = 140
        #expect(shown(room: 260, selected: 6, widths: widths) == [0, 6])
        // Too wide even alone: it shows, and the count.
        widths[6] = 400
        #expect(shown(room: 260, selected: 6, widths: widths) == [6])
    }

    @Test func allWhenTheyFit() {
        let two: [CGFloat] = [70, 70]
        #expect(shown(room: 150, selected: 1, widths: two) == [0, 1])
        // Before the room is known, all of them, rather than none.
        #expect(shown(room: 0, selected: 0) == Array(0..<8))
    }
}
