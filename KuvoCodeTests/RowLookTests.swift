import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// A conversation's rows follow light and dark as the window turns, or the whole Mac (at sunset):
/// a row drawn as the transcript draws its rows, kept from drawing again while it's the same
/// (`.equatable()`), takes the new look all the same.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct RowLookTests {
    /// The look the row was last drawn in.
    final class Seen { var scheme: ColorScheme? }

    /// A row as the transcript's: drawn again only when what it shows changes.
    private struct Line: View, Equatable {
        static func == (lhs: Line, rhs: Line) -> Bool { lhs.text == rhs.text }
        let text: String
        let seen: Seen
        @Environment(\.colorScheme) private var scheme

        var body: some View {
            seen.scheme = scheme
            TestPulse.beat()
            return Text(text)
        }
    }

    private struct Item: Equatable { let id: String }

    @Test(arguments: [false, true])
    func aRowTakesTheNewLook(wholeMac: Bool) async throws {
        let before = NSApp.appearance
        if wholeMac { NSApp.appearance = NSAppearance(named: .aqua) }
        defer { NSApp.appearance = before }
        let seen = Seen()
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        if !wholeMac { window.appearance = NSAppearance(named: .aqua) }
        window.contentView = NSHostingView(rootView: ScrollView {
            RowStack(items: [Item(id: "a")], id: \.id, same: ==, estimate: { _ in 40 }) { _, _ in
                Line(text: "The M2 is about a fifth faster.", seen: seen).equatable()
            }
        }.frame(width: 400, height: 300))
        window.orderBack(nil)
        window.contentView?.layoutSubtreeIfNeeded()
        try await until { seen.scheme == .light }

        if wholeMac { NSApp.appearance = NSAppearance(named: .darkAqua) } else { window.appearance = NSAppearance(named: .darkAqua) }
        try await until { seen.scheme == .dark }
    }
}
