import ClientDesign
import SwiftUI
import Testing

/// A sent message's pictures, laid out by `Flow` in both apps: they wrap within the width they're
/// given, rather than running off its edge in one row (#241).
@MainActor
struct FlowTests {
    private func size(_ count: Int, width: CGFloat, in room: CGFloat) -> CGSize {
        let pictures = Flow(alignment: .trailing, spacing: 6) {
            ForEach(0..<count, id: \.self) { _ in Color.teal.frame(width: width, height: 100) }
        }
        return ImageRenderer(content: pictures.frame(width: room, alignment: .trailing).fixedSize(horizontal: false, vertical: true)).cgImage
            .map { CGSize(width: CGFloat($0.width), height: CGFloat($0.height)) } ?? .zero
    }

    @Test func picturesWrapWithinTheirRoom() {
        // Two to a row in 290 points: five make three rows.
        let five = size(5, width: 140, in: 290)
        #expect(Int(five.width) == 290)
        #expect(Int(five.height) == 100 * 3 + 6 * 2)
        // Room for all of them: one row.
        #expect(Int(size(3, width: 140, in: 600).height) == 100)
    }
}
