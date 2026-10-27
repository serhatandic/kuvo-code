import SwiftUI
import Testing
import ClientDesign

/// The look both apps draw with, the same on each.
@MainActor
@Suite struct ClientDesignTests {
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
