import AppKit
import ClientDesign
import Foundation

/// The icons of the sites agents' replies link to, shown before each link (`SiteIconCell`): KuvoClient's
/// `SiteIcons` (ClientDesign), which fetches and keeps them, as this Mac reads pictures (any
/// NSImage can draw, SVG too, kept at twice its size).
extension SiteIcons {
    static let shared = SiteIcons(
        // `~/Library/Caches/<bundle id>/Site Icons` (the tests' own).
        folder: AppInfo.isHostingTests
            ? AppInfo.testRoot.appending(path: "Caches/Site Icons")
            : URL.cachesDirectory.appending(path: Bundle.main.bundleIdentifier ?? "run.kuvo.code").appending(path: "Site Icons"),
        drawsSVG: true, picture: { NSImage(data: $0) }, usable: { Self.usable($0) })

    // MARK: Whether it reads

    /// `data` as an icon worth showing, as PNG at the size it's kept: a picture that decodes, not
    /// tiny, and not a colorless glyph on clear (black, white or gray, which would vanish on a dark
    /// or a light card).
    nonisolated static func usable(_ data: Data) -> Data? {
        guard data.count > 0, let image = NSImage(data: data), image.isValid,
              let rep = image.representations.max(by: { $0.pixelsWide < $1.pixelsWide }),
              max(rep.pixelsWide, Int(image.size.width)) >= 8 else { return nil }
        let pixels = Int(side * 2)
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
                                            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        bitmap.size = NSSize(width: side, height: side)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        image.draw(in: NSRect(x: 0, y: 0, width: side, height: side), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        guard !isColorlessGlyph(bitmap) else { return nil }
        return bitmap.representation(using: .png, properties: [:])
    }

    /// Whether the icon as drawn is a colorless glyph (`SiteIcons.isColorlessGlyph`): its pixels
    /// that aren't clear, as this Mac reads them.
    nonisolated static func isColorlessGlyph(_ bitmap: NSBitmapImageRep) -> Bool {
        var opaque: [(r: Double, g: Double, b: Double)] = []
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide {
                guard let color = bitmap.colorAt(x: x, y: y), color.alphaComponent > 0.9 else { continue }
                opaque.append((color.redComponent, color.greenComponent, color.blueComponent))
            }
        }
        return isColorlessGlyph(opaque, total: bitmap.pixelsWide * bitmap.pixelsHigh)
    }
}

/// A site's icon in a reply drawn by TextKit (`ReplyView`), in the square of the globe it shows
/// until then (`SiteIcons.shown`), with the room before the link's words: nothing moves when it
/// comes.
final class SiteIconCell: NSTextAttachmentCell {
    let site: String?
    private let url: URL
    nonisolated private let room: CGSize
    private let globe: NSImage
    nonisolated private let baseline: CGFloat
    /// The square it's drawn in, at the left of its room.
    private let side: CGFloat

    init(url: URL, size: CGSize, globe: NSImage, baseline: CGFloat) {
        self.url = url
        self.site = SiteAddresses.site(of: url)
        self.room = size
        self.side = size.height
        self.globe = globe
        self.baseline = baseline
        super.init(imageCell: nil)
    }

    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    nonisolated override func cellSize() -> NSSize { room }
    nonisolated override func cellBaselineOffset() -> NSPoint { NSPoint(x: 0, y: baseline) }

    override func draw(withFrame frame: NSRect, in view: NSView?) {
        let square = NSRect(x: frame.minX, y: frame.minY, width: side, height: frame.height)
        guard let site else { return globe.draw(in: square, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil) }
        let shown = SiteIcons.shared.shown(site)
        if shown == nil { SiteIcons.shared.load(url) }
        if case .icon(let icon)? = shown {
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(roundedRect: square, xRadius: side * 0.2, yRadius: side * 0.2).addClip()
            icon.draw(in: square, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
            NSGraphicsContext.restoreGraphicsState()
        } else {
            globe.draw(in: square, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        }
    }

    override func draw(withFrame frame: NSRect, in view: NSView?, characterIndex: Int) {
        draw(withFrame: frame, in: view)
    }

    override func draw(withFrame frame: NSRect, in view: NSView?, characterIndex: Int, layoutManager: NSLayoutManager) {
        draw(withFrame: frame, in: view)
    }
}
