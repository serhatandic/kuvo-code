import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// The card over the composer: every line of a bar and every row under it ends on one right edge.
/// The chevron of "Running in the background" ends where its row's "Stop" does (it sat 26 points
/// left of it, with a gap kept for a ✕ the line doesn't have), and so do the bar's own button
/// ("All"), a line with nothing under it, and a ✕. The real bars are drawn in a window of the
/// test's own, light and dark, and each line's last ink is looked for in what was drawn.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BarEndsTests {
    private static let width: CGFloat = 520
    /// Ink of a chevron and of a word's last letter ends about a point apart (a hover fill's room
    /// around each differs by a point and a half); what this guards against is a gap of a control's
    /// width.
    private static let tolerance: CGFloat = 2

    private func job() throws -> ShellJob {
        try JSONDecoder().decode(ShellJob.self, from: Data(#"{"id":"sh_build","status":"running","command":"swift build","time":{"started":1700000000000}}"#.utf8))
    }

    private func all() -> some View {
        Button("All") {}
            .buttonStyle(TextButtonStyle())
            .font(.system(size: 13))
    }

    private func mark() -> AnyView { AnyView(Image(systemName: "circle").frame(width: 14, height: 14)) }

    /// A bar's lines, each its own view, with the bands (in points from its top) where the controls
    /// at the end of each are.
    private var cases: [(name: String, bar: AnyView, bands: [ClosedRange<CGFloat>])] {
        get throws {
        [
            // The chevron in the line, then the row under it: Output, Stop.
            ("background", AnyView(BackgroundBar(jobs: [try job()], api: nil, directory: "/tmp", isHidden: .constant(false)) { _ in }), [0...36, 36...66]),
            // The bar's own button before the chevron.
            ("all and chevron", AnyView(BarLine(mark: mark(), title: "3 sessions at work", accessory: AnyView(all()), showHelp: "", hideHelp: "", isHidden: .constant(false))), [0...36]),
            // Nothing under it: its own button in the chevron's place.
            ("all alone", AnyView(BarLine(mark: mark(), title: "20 sessions today, none at work", accessory: AnyView(all()), showHelp: "", hideHelp: "", isHidden: .constant(true), opens: false)), [0...36]),
            // ✕ last.
            ("close", AnyView(BarLine(mark: mark(), title: "Review", showHelp: "", hideHelp: "", isHidden: .constant(false), close: {})), [0...36]),
        ]
        }
    }

    /// Where the last ink is in each band: how far from the card's right edge, in points.
    private func insets(of bar: AnyView, bands: [ClosedRange<CGFloat>], scheme: ColorScheme) async throws -> [CGFloat] {
        let background: NSColor = scheme == .dark ? NSColor(white: 0.12, alpha: 1) : NSColor(white: 0.97, alpha: 1)
        let root = bar
            .frame(width: Self.width)
            .background(Color(nsColor: background))
            .environment(\.colorScheme, scheme)
        let host = NSHostingView(rootView: root)
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: Self.width, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        window.contentView = host
        defer {
            window.contentView = nil
            window.close()
        }
        var found: [CGFloat] = []
        try await until {
            // Drawn again on the main queue's next turn, once the window has laid it out.
            DispatchQueue.main.async { TestPulse.beat() }
            host.setFrameSize(NSSize(width: Self.width, height: host.fittingSize.height))
            host.layoutSubtreeIfNeeded()
            host.display()
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return false }
            host.cacheDisplay(in: host.bounds, to: rep)
            let scale = CGFloat(rep.pixelsWide) / host.bounds.width
            found = bands.map { band in
                var last: CGFloat = 0
                // The right half only: where the controls at the end are.
                for x in Int(Self.width / 2 * scale)..<rep.pixelsWide {
                    for y in Int(band.lowerBound * scale)..<min(Int(band.upperBound * scale), rep.pixelsHigh) {
                        guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                        let reference = background.usingColorSpace(.deviceRGB) ?? background
                        let difference = abs(color.redComponent - reference.redComponent) + abs(color.greenComponent - reference.greenComponent) + abs(color.blueComponent - reference.blueComponent)
                        if difference > 0.45 { last = max(last, CGFloat(x + 1) / scale) }
                    }
                }
                return last == 0 ? 0 : Self.width - last
            }
            return found.allSatisfy { $0 > 0 }
        }
        return found
    }

    @Test(arguments: [ColorScheme.dark, .light]) func everyLinesLastControlEndsWhereTheRowsDo(scheme: ColorScheme) async throws {
        var edges: [(String, CGFloat)] = []
        for (name, bar, bands) in try cases {
            let insets = try await insets(of: bar, bands: bands, scheme: scheme)
            for (index, inset) in insets.enumerated() { edges.append(("\(name) \(index == 0 ? "line" : "row")", inset)) }
        }
        let row = try #require(edges.first { $0.0 == "background row" }).1
        for (name, inset) in edges {
            #expect(abs(inset - row) <= Self.tolerance, "\(name) ends \(inset) points from the card's edge, its row's Stop \(row): \(edges)")
        }
        // And near the edge: not a column of room kept beside the chevron.
        #expect(row < 20, "the last control ends \(row) points from the card's edge")
    }
}
