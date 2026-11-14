import SwiftUI

/// Shared chrome for the branded, off-screen share-card PNGs (`ShareCardView`, `TotalSpendShareCardView`):
/// the authored width, opaque tray background (an `ImageRenderer` has no window backdrop), forced
/// appearance, tooltip suppression (the tooltips' AppKit anchors rasterize as yellow boxes otherwise),
/// and the centered watermark footer. Callers supply just their header + body; wrapping them here keeps
/// every exported card one family and these settings in one place.
struct ShareCardChrome<Content: View>: View {
    let appearance: ColorScheme
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            content
            watermarkFooter
        }
        .padding(16)
        .frame(width: ShareCardView.width, alignment: .topLeading)
        .background(Theme.traySurface)
        .environment(\.colorScheme, appearance)
        .environment(\.hoverTooltipsDisabled, true)
    }

    /// The host app's name, centered at the bottom. Quiet (secondary) so it reads as a watermark.
    private var watermarkFooter: some View {
        HStack(spacing: 6) {
            Image(systemName: "gauge.with.dots.needle.50percent")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            Text(HostApp.name)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}
