import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// A right-click on a message's words offers the message's own menu (Copy, Undo From Here…), as
/// a right-click beside them does: the words are AppKit's text, whose own menu (Look Up, Copy,
/// Share) would cover it over most of the bubble. On words you selected, the text's menu.
@MainActor
@Suite(.serialized) struct MessageMenuTests {
    let app = AppModel()
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 600, height: 300), styleMask: [.titled], backing: .buffered, defer: false)

    init() {
        TestEnvironment.prepare()
        window.isReleasedWhenClosed = false
    }

    private func all<T: NSView>(_ type: T.Type, in view: NSView?) -> [T] {
        guard let view else { return [] }
        return ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { all(type, in: $0) }
    }

    /// A right-click in the middle of `text`'s first line (or at `spot` in it), as AppKit asks the
    /// view under it.
    private func rightClick(on text: NSTextView, at spot: NSPoint? = nil) throws -> NSMenu? {
        let point = text.convert(spot ?? NSPoint(x: text.bounds.midX, y: text.textContainerOrigin.y + 6), to: nil)
        let event = try #require(NSEvent.mouseEvent(with: .rightMouseDown, location: point, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
        return text.menu(for: event)
    }

    @Test func rightClickingAMessagesWordsOffersTheMessagesMenu() async throws {
        defer { window.close() }
        let message = YourMessage(text: "Rename the harbor keeper's lamp settings and run the tests again", sent: .now, fork: {}, undo: {}, undoNote: "")
        window.contentView = NSHostingView(rootView: message.environment(app).frame(width: 600))
        window.contentView?.layoutSubtreeIfNeeded()
        let text = try #require(all(SelectableTextView.self, in: window.contentView).first)
        #expect(text.bounds.width > 100, "the words laid out")

        let titles = try rightClick(on: text)?.items.map(\.title) ?? []
        #expect(titles.contains("Undo From Here…"), "\(titles)")
        #expect(titles.contains("New Session From Here"), "\(titles)")

        // Words selected under the pointer: what the text offers for them.
        text.setSelectedRange(NSRange(location: 0, length: text.string.count))
        let selected = try rightClick(on: text)?.items ?? []
        #expect(selected.contains { $0.action == #selector(NSText.copy(_:)) }, "\(selected.map(\.title))")
        #expect(!selected.contains { $0.title == "Undo From Here…" })

        // The last word selected, right-clicked at its end: on the selection still.
        let words = text.string as NSString
        let last = words.range(of: "again")
        text.setSelectedRange(last)
        let end = try #require(spot(in: text, of: NSRange(location: NSMaxRange(last) - 1, length: 1), at: 0.9))
        let onEnd = try rightClick(on: text, at: end)?.items ?? []
        #expect(!onEnd.contains { $0.title == "Undo From Here…" }, "\(onEnd.map(\.title))")
    }

    /// The point a fraction of the way across these characters, in the text view.
    private func spot(in text: NSTextView, of range: NSRange, at fraction: CGFloat) -> NSPoint? {
        guard let layout = text.layoutManager, let container = text.textContainer else { return nil }
        let rect = layout.boundingRect(forGlyphRange: layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil), in: container)
        return NSPoint(x: rect.minX + rect.width * fraction + text.textContainerOrigin.x, y: rect.midY + text.textContainerOrigin.y)
    }

    /// On a web address in your message, what the text offers for a link (Copy Link), not the
    /// message's menu.
    @Test func rightClickingALinkInAMessageOffersTheLinksMenu() async throws {
        defer { window.close() }
        let message = YourMessage(text: "Read https://example.com/harbor before you start", sent: .now, fork: {}, undo: {}, undoNote: "")
        window.contentView = NSHostingView(rootView: message.environment(app).frame(width: 600))
        window.contentView?.layoutSubtreeIfNeeded()
        let text = try #require(all(SelectableTextView.self, in: window.contentView).first)
        let address = (text.string as NSString).range(of: "example.com")
        let point = try #require(spot(in: text, of: address, at: 0.5))
        #expect(text.link(at: point) != nil, "the address is a link")

        let titles = try rightClick(on: text, at: point)?.items.map(\.title) ?? []
        #expect(!titles.contains("Undo From Here…"), "\(titles)")
        #expect(titles.contains { $0.contains("Link") }, "\(titles)")
    }
}
