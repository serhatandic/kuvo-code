import SwiftUI
import Testing
import ClientDesign

/// The look both apps draw with, the same on each.
@MainActor
@Suite struct ClientDesignTests {
    /// Colors written as 0xRRGGBB come out as those colors (every code color is one).
    @Test func hexColorsAreThoseColors() {
        let environment = EnvironmentValues()
        let written = Color(hex: 0x9B2393).resolve(in: environment)
        let expected = Color(red: 0x9B / 255.0, green: 0x23 / 255.0, blue: 0x93 / 255.0).resolve(in: environment)
        #expect(written == expected)
        #expect(Color(hex: 0xFFFFFF).resolve(in: environment) == Color.white.resolve(in: environment))
    }

    /// An open project's folder is drawn open, a closed one's closed, at the size asked.
    @Test func aFolderShowsWhetherItsOpen() throws {
        func pixels(open: Bool, size: CGFloat) throws -> (Data, CGSize) {
            let renderer = ImageRenderer(content: FolderIcon(isOpen: open, size: size))
            let image = try #require(renderer.cgImage)
            let data = try #require(image.dataProvider?.data as Data?)
            return (data, CGSize(width: image.width, height: image.height))
        }
        let closed = try pixels(open: false, size: 16), open = try pixels(open: true, size: 16)
        #expect(closed.0 != open.0)
        #expect(try pixels(open: true, size: 28).1.width > open.1.width)
    }
}
