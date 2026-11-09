import AppKit
import Testing
@testable import KuvoCode

/// A file an agent shows you (show_file) is that step's (#132's review): one it changed and shows
/// again shows the change, not the picture an earlier step drew at that path; and a machine's file
/// is never this Mac's, though this Mac has a file at that path too.
@MainActor
@Suite(.serialized) struct ChangedPicturesTests {
    private enum Color { case red, blue }

    private static func png(_ color: Color) throws -> Data {
        let fill: NSColor = color == .red ? NSColor(srgbRed: 1, green: 0, blue: 0, alpha: 1) : NSColor(srgbRed: 0, green: 0, blue: 1, alpha: 1)
        let image = NSImage(size: NSSize(width: 60, height: 40), flipped: false) { rect in
            fill.setFill()
            rect.fill()
            return true
        }
        let bitmap = try #require(image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)))
        return try #require(bitmap.representation(using: .png, properties: [:]))
    }

    /// The color of a picture, at its middle.
    private static func color(of image: NSImage) throws -> Color? {
        let bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1, pixelsHigh: 1, bitsPerSample: 8, samplesPerPixel: 4,
                                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 4, bitsPerPixel: 32))
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        image.draw(in: NSRect(x: 0, y: 0, width: 1, height: 1))
        NSGraphicsContext.restoreGraphicsState()
        let pixel = try #require(bitmap.colorAt(x: 0, y: 0)?.usingColorSpace(.sRGB))
        if pixel.redComponent > 0.8, pixel.blueComponent < 0.3 { return .red }
        if pixel.blueComponent > 0.8, pixel.redComponent < 0.3 { return .blue }
        return nil
    }

    /// A folder of the test's own, gone after it.
    private static func folder() throws -> URL {
        let folder = URL.temporaryDirectory.appending(path: "KuvoCodeTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    @Test func aPictureShownAgainAfterItChangedShowsTheChange() async throws {
        let folder = try Self.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let chart = folder.appending(path: "chart.png")

        try Self.png(.blue).write(to: chart)
        let first = try #require(await MadePictureRow.shown(chart.path, at: RemoteFolder.fileURL(chart.path, in: folder.path), step: "call_1").loadImage())
        #expect(try Self.color(of: first) == .blue)

        // "Make it red": the same file, redrawn, shown again by the next step.
        try Self.png(.red).write(to: chart)
        let second = try #require(await MadePictureRow.shown(chart.path, at: RemoteFolder.fileURL(chart.path, in: folder.path), step: "call_2").loadImage())
        #expect(try Self.color(of: second) == .red)
    }

    @Test func aMachinesShownFileIsNeverThisMacs() async throws {
        let folder = try Self.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        // This Mac has a chart at the path the machine's agent shows.
        let chart = folder.appending(path: "chart.png")
        try Self.png(.blue).write(to: chart)
        let shown = MadePictureRow.shown(chart.path, at: RemoteFolder.fileURL(chart.path, in: RemoteFolder.folder(folder.path, on: "lab")), step: "call_1")
        #expect(shown.fileURL == nil)
        #expect(shown.name == "chart.png")
        #expect(await shown.loadImage() == nil)
    }
}
