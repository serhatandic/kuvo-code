import AppKit
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Your message's pictures keep to the conversation however narrow it is (#241): a wide
/// screenshot shrinks to the room there is, rather than running past its edge.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct MessagePicturesTests {
    private static func screenshot(_ color: NSColor) throws -> AttachmentItem {
        let image = NSImage(size: NSSize(width: 1290, height: 600), flipped: false) { rect in
            color.setFill()
            rect.fill()
            return true
        }
        let bitmap = try #require(image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)))
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        return .stored(Message.User.Attachment(mime: "image/png", name: "Screenshot.png", data: png.base64EncodedString()), id: UUID().uuidString)
    }

    /// The pictures' size in the narrowest conversation (MainView's least, inside the transcript's
    /// insets), laid out as your message lays them out: against its right edge, past its margin.
    private func size(of items: [AttachmentItem]) async -> (shown: CGSize, room: CGFloat) {
        // Decoded first, as a message drawn again has them.
        for item in items { _ = await item.loadImage() }
        let conversation: CGFloat = 380 - 14 * 2
        let host = NSHostingController(rootView: MessageAttachments(items: items)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 80))
        return (host.sizeThatFits(in: CGSize(width: conversation, height: 4000)), conversation)
    }

    @Test func aWideScreenshotShrinksToTheNarrowestConversation() async throws {
        // A message's frame takes the conversation's width whatever its pictures do: their
        // height tells whether they fit the room past the margin, in their own shape (not the
        // placeholder's), or kept their full size and ran past the edge.
        let (one, room) = await size(of: [try Self.screenshot(.systemTeal)])
        let fitted = (room - 80) * 600 / 1290
        #expect(abs(one.height - fitted) <= 1, "one screenshot is \(one), not \(room - 80) wide")
        let (two, _) = await size(of: [try Self.screenshot(.systemTeal), try Self.screenshot(.systemOrange)])
        #expect(abs(two.height - (fitted * 2 + 6)) <= 2, "two screenshots, one to a row: \(two)")
    }
}
