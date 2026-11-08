import ClientDesign
import SwiftUI
import Testing

/// A sent message's pictures, laid out by `Flow` in both apps: they wrap within the width they're
/// given, rather than running off its edge in one row (#241).
@MainActor
struct FlowTests {
    private func size(_ count: Int, width: CGFloat, in room: CGFloat) -> CGSize {
        size(of: Flow(alignment: .trailing, spacing: 6) {
            ForEach(0..<count, id: \.self) { _ in Color.teal.frame(width: width, height: 100) }
        }, in: room)
    }

    private func size(of flow: some View, in room: CGFloat) -> CGSize {
        ImageRenderer(content: flow.frame(width: room, alignment: .trailing).fixedSize(horizontal: false, vertical: true)).cgImage
            .map { CGSize(width: CGFloat($0.width), height: CGFloat($0.height)) } ?? .zero
    }

    @Test func picturesWrapWithinTheirRoom() {
        // Two to a row in 290 points: five make three rows.
        #expect(Int(size(5, width: 140, in: 290).height) == 100 * 3 + 6 * 2)
        // Room for all of them: one row.
        #expect(Int(size(3, width: 140, in: 600).height) == 100)
    }

    /// A picture wider than the room (a wide screenshot in the narrowest conversation) shrinks
    /// into it, in its own shape, rather than running past the edge.
    @Test func aPictureWiderThanTheRoomShrinksIntoIt() {
        let wide = Flow(alignment: .trailing, spacing: 6) {
            Color.teal.aspectRatio(2, contentMode: .fit).frame(idealWidth: 400, maxWidth: 400)
        }
        #expect(Int(size(of: wide, in: 260).height) == 130)
    }
}
