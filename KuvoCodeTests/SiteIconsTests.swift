import AppKit
import ClientDesign
import Foundation
import Testing
@testable import KuvoCode

/// A web link in an agent's reply shows its site's icon when it reads well on this Mac: a picture
/// with two colors, or one ink in a color (a blue whale), shows; a colorless glyph (one ink on
/// clear, black, white or gray), which would vanish on a dark or a light card, shows the globe.
/// How icons are fetched from the sites and kept is KuvoClient's (`ClientDesign`'s SiteIconsTests).
@MainActor
@Suite struct SiteIconsTests {
    init() {
        TestEnvironment.prepare()
    }

    /// A picture as a site serves it: two colors, or one ink on clear.
    private func png(oneInk: Bool, ink: NSColor = .black) -> Data {
        let image = NSImage(size: NSSize(width: 32, height: 32), flipped: false) { rect in
            if oneInk {
                ink.setFill()
                NSBezierPath(ovalIn: rect.insetBy(dx: 8, dy: 8)).fill()
            } else {
                NSColor.systemOrange.setFill()
                rect.fill()
                NSColor.white.setFill()
                NSBezierPath(ovalIn: rect.insetBy(dx: 8, dy: 8)).fill()
            }
            return true
        }
        return NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!
    }

    @Test func iconsThatReadWell() throws {
        let kept = try #require(SiteIcons.usable(png(oneInk: false)), "two colors")
        #expect(NSImage(data: kept) != nil, "kept as the app reads it back")
        #expect(SiteIcons.usable(png(oneInk: true)) == nil, "a black glyph on clear: the globe")
        #expect(SiteIcons.usable(png(oneInk: true, ink: .systemBlue)) != nil, "a colored mark reads on either card")
        #expect(SiteIcons.usable(Data("not a picture".utf8)) == nil)
    }
}
