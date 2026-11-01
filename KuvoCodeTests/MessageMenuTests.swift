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

    /// A right-click in the middle of `text`'s first line, as AppKit asks the view under it.
    private func rightClick(on text: NSTextView) throws -> NSMenu? {
        let point = text.convert(NSPoint(x: text.bounds.midX, y: text.textContainerOrigin.y + 6), to: nil)
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
    }
}
