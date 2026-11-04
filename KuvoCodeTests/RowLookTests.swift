import AppKit
import ClientDesign
import SwiftUI
import Testing
@testable import KuvoCode

/// A conversation's rows follow the look as it changes: light and dark as the window turns, or the
/// whole Mac (at sunset), and Settings › Appearance's text size and accent. A row drawn as the
/// transcript draws its rows, kept from drawing again while it's the same (`.equatable()`), takes
/// the new look all the same.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct RowLookTests {
    /// The look the row was last drawn in.
    final class Seen {
        var scheme: ColorScheme?
        var size: Double?
        var accent: Color?
    }

    /// A row as the transcript's: drawn again only when what it shows changes.
    private struct Line: View, Equatable {
        static func == (lhs: Line, rhs: Line) -> Bool { lhs.text == rhs.text }
        let text: String
        let seen: Seen
        @Environment(\.colorScheme) private var scheme
        @Environment(\.messageFont) private var font
        @Environment(\.accent) private var accent

        var body: some View {
            seen.scheme = scheme
            seen.size = font.size
            seen.accent = accent
            TestPulse.beat()
            return Text(text)
        }
    }

    private struct Item: Equatable { let id: String }

    enum Change: CaseIterable { case window, wholeMac, textSize, accent }

    @Test(arguments: Change.allCases)
    func aRowTakesTheNewLook(_ change: Change) async throws {
        let before = NSApp.appearance
        if change == .wholeMac { NSApp.appearance = NSAppearance(named: .aqua) }
        defer { NSApp.appearance = before }
        let seen = Seen()
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        if change != .wholeMac { window.appearance = NSAppearance(named: .aqua) }
        func conversation(size: Double, accent: Color) -> AnyView {
            AnyView(ScrollView {
                RowStack(items: [Item(id: "a")], id: \.id, same: ==, estimate: { _ in 40 }) { _, _ in
                    Line(text: "The M2 is about a fifth faster.", seen: seen).equatable()
                }
            }
            .environment(\.messageFont, MessageFont(size: size))
            .environment(\.accent, accent)
            .frame(width: 400, height: 300))
        }
        let host = NSHostingView(rootView: conversation(size: 14, accent: .blue))
        window.contentView = host
        // The window's look turning is known by its views, not by anything a wait watches.
        let turned = host.observe(\.effectiveAppearance) { _, _ in TestPulse.beat() }
        defer { turned.invalidate() }
        window.orderBack(nil)
        host.layoutSubtreeIfNeeded()
        try await until { seen.scheme == .light && seen.size == 14 && seen.accent == .blue }

        switch change {
        case .window: window.appearance = NSAppearance(named: .darkAqua)
        case .wholeMac: NSApp.appearance = NSAppearance(named: .darkAqua)
        case .textSize: host.rootView = conversation(size: 18, accent: .blue)
        case .accent: host.rootView = conversation(size: 14, accent: .orange)
        }
        // Laid out again, as a window on screen is once its look changes (this one, off screen,
        // isn't drawn): the stack hands its rows what's around them, and they draw.
        try await until {
            host.layoutSubtreeIfNeeded()
            return switch change {
            case .window, .wholeMac: seen.scheme == .dark
            case .textSize: seen.size == 18
            case .accent: seen.accent == .orange
            }
        }
    }
}
