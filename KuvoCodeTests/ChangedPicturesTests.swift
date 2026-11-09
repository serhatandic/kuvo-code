import AppKit
import Testing
@testable import KuvoCode

/// A picture on this Mac that changed where it is shows as it is now (#132's review): an agent
/// that redraws a chart and shows it again (show_file) showed the first chart, kept by its path;
/// a file attached again after you changed it, likewise.
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

    @Test(arguments: ["path", "local"])
    func aPictureChangedWhereItIsShowsAsItIsNow(kind: String) async throws {
        let folder = URL.temporaryDirectory.appending(path: "KuvoCodeTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let chart = folder.appending(path: "chart.png")
        func item() -> AttachmentItem { kind == "path" ? .path(chart.path) : .local(chart) }
        // Its times set, not the clock's: the second is later however fast the test runs.
        func write(_ color: Color, at seconds: TimeInterval) throws {
            try Self.png(color).write(to: chart)
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceReferenceDate: seconds)], ofItemAtPath: chart.path)
        }

        try write(.blue, at: 800_000_000)
        let first = try #require(await item().loadImage())
        #expect(try Self.color(of: first) == .blue)

        // Redrawn in the same place (the same size of file), and shown again.
        try write(.red, at: 800_000_060)
        let shown = item()
        let second = try #require(await shown.loadImage())
        #expect(try Self.color(of: second) == .red)
        // What the picture's view starts from, before it loads, is the new one too.
        let kept = try #require(AttachmentImages.cache.object(forKey: shown.contentID as NSString))
        #expect(try Self.color(of: kept) == .red)
    }
}
