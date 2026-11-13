import AppKit
import SwiftUI

/// The usage panel for the host's paired phones (fork addition): what the Bars view shows, as
/// JSON, and a way to refresh it.
extension UsageMenuBar {
    /// The providers the Bars view lists, in its order, each with its brand color, its mark,
    /// what's wrong if anything, and its lines; whether a refresh is under way, and when the last
    /// one ended. Nil until the panel is up. Dates are seconds since 1970.
    public func phoneUsage() -> Data? {
        guard let container else { return nil }
        let store = container.dataStore
        let encoder = Self.phoneEncoder
        // As the Bars view lists them; where this Mac's box states rows for a provider, its place,
        // with only what the box doesn't state (the phone reads the rows from the box itself,
        // `kuvo/agents/api/kuvo/limits`, and draws them there).
        let providers = HostLimits.shared.phoneGroups(container.layout.displayGroups).compactMap { group, covers -> PhoneUsage.Provider? in
            let provider = group.provider
            guard let snapshot = store.snapshots[provider.id] else { return nil }
            // (Not the meters, nor what the card has from the rows, Cursor's credits and on-demand spend:
            // the phone draws each row's own, under its account.)
            let fromRows = covers.map(HostLimits.shared.rowLines(for:)) ?? []
            let lines = covers == nil ? snapshot.lines : snapshot.lines.filter { line in
                if case .progress = line { return false }
                return !fromRows.contains(line.label)
            }
            return PhoneUsage.Provider(
                id: provider.id,
                name: snapshot.displayName,
                plan: snapshot.plan,
                color: Self.hex(TotalSpendPalette.color(for: provider.id)),
                icon: Self.phoneMark(for: provider.id),
                iconIsTemplate: true,
                refreshed: snapshot.refreshedAt,
                notice: store.headerNotice(for: provider.id),
                stale: store.stalenessHint(for: provider.id) == nil ? nil : true,
                lines: Self.phoneLines(lines, encoder: encoder),
                covers: covers
            )
        }
        let usage = PhoneUsage(providers: providers, refreshing: !store.refreshingProviderIDs.isEmpty, refreshed: store.lastRefreshAt)
        return try? encoder.encode(usage)
    }

    private static var phoneEncoder: JSONEncoder {
        let encoder = JSONEncoder()
        // Sorted: the phone link sends it again only when the text differs.
        encoder.outputFormatting = .sortedKeys
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }

    /// The lines JSON can carry: one that can't (a provider's infinite or undefined number) is left
    /// out, or it would take every provider's with it.
    static func phoneLines(_ lines: [MetricLine], encoder: JSONEncoder = phoneEncoder) -> [MetricLine] {
        lines.filter { (try? encoder.encode($0)) != nil }
    }

    /// Refreshes every provider now, past the cache (a phone pulled to refresh). False until the
    /// panel is up.
    @discardableResult
    public func refreshAll() -> Bool {
        guard let container else { return false }
        Task { await container.dataStore.refreshAll(force: true) }
        HostHistory.shared.refresh?()
        return true
    }

    /// Its brand color in light mode, as "#RRGGBB".
    private static func hex(_ color: Color) -> String {
        var hex = "#888888"
        NSAppearance(named: .aqua)?.performAsCurrentDrawingAppearance {
            guard let rgb = NSColor(color).usingColorSpace(.sRGB) else { return }
            let channel = { (value: CGFloat) in Int((min(max(value, 0), 1) * 255).rounded()) }
            hex = String(format: "#%02X%02X%02X", channel(rgb.redComponent), channel(rgb.greenComponent), channel(rgb.blueComponent))
        }
        return hex
    }

    /// The provider's mark, black on clear, 64 points square, as base64 PNG for the phone to tint;
    /// drawn once per provider.
    public static func phoneMark(for providerID: String) -> String? {
        if let drawn = marks[providerID] { return drawn }
        let view = Group {
            if let mark = ProviderMarks.mark(for: providerID) {
                ProviderIconShape(mark: mark, inset: 0.04).fill(Color.black)
            } else {
                Image(systemName: ProviderMarks.symbolFallback(for: providerID))
                    .resizable()
                    .scaledToFit()
                    .padding(6)
                    .foregroundStyle(Color.black)
            }
        }
        .frame(width: 64, height: 64)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        guard let image = renderer.cgImage,
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { return nil }
        let encoded = png.base64EncodedString()
        marks[providerID] = encoded
        return encoded
    }

    private static var marks: [String: String] = [:]
}

private struct PhoneUsage: Encodable {
    struct Provider: Encodable {
        var id: String
        var name: String
        var plan: String?
        var color: String
        var icon: String?
        var iconIsTemplate: Bool?
        var refreshed: Date
        var notice: String?
        var stale: Bool?
        var lines: [MetricLine]
        /// The service whose rows the phone puts here, from this Mac's box, with these lines under the first.
        var covers: String?
    }

    var providers: [Provider]
    var refreshing: Bool
    var refreshed: Date?
}
