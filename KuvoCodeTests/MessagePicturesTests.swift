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

    /// The pictures' width in a column `room` points wide, once they've loaded.
    private func width(of items: [AttachmentItem], in room: CGFloat) async -> CGFloat {
        // Decoded first, as a message drawn again has them.
        for item in items { _ = await item.loadImage() }
        let host = NSHostingController(rootView: MessageAttachments(items: items))
        return host.sizeThatFits(in: CGSize(width: room, height: 4000)).width
    }

    @Test func aWideScreenshotShrinksToTheNarrowestConversation() async throws {
        // The narrowest conversation's room for your message, past its margins.
        let room: CGFloat = 260
        let one = await width(of: [try Self.screenshot(.systemTeal)], in: room)
        #expect(one <= room, "one screenshot takes \(one) points")
        #expect(one > 200, "the picture itself, not its placeholder")
        let two = await width(of: [try Self.screenshot(.systemTeal), try Self.screenshot(.systemOrange)], in: room)
        #expect(two <= room, "two screenshots take \(two) points")
    }
}
