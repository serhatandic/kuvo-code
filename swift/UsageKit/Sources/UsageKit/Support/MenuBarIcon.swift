import AppKit
import SwiftUI

/// The menu bar glyph shown when no starred metric has data: a gauge symbol, as a template image.
/// (The fork drops OpenUsage's own mark, which its trademark policy reserves.)
@MainActor
enum MenuBarIcon {
    /// Side length (points) of the menu bar glyph.
    private static let side: CGFloat = 18

    /// Cached template image, or `nil` if the symbol fails to load.
    static let image: NSImage? = render()

    private static func render() -> NSImage? {
        let configuration = NSImage.SymbolConfiguration(pointSize: side - 3, weight: .medium)
        guard let image = NSImage(systemSymbolName: "gauge.with.dots.needle.50percent", accessibilityDescription: HostApp.name)?
            .withSymbolConfiguration(configuration) else { return nil }
        image.isTemplate = true
        return image
    }
}
