import AppKit
import ClientDesign
import SwiftUI
import Testing
@testable import KuvoCode

/// Selecting in a conversation (C4): a drag across replies, either way, leaves one selection,
/// shown alike in every reply it takes part of, with Add to Chat and Copy over its first line; Add
/// to Chat quotes what's selected; a double click takes a word; a click elsewhere lets it all go.
/// The conversation holds the keyboard for it, never one of its texts. Real rows and replies, in a
/// window of the test's own; the pointer's events are queued as a hand would make them.
@MainActor
@Suite(.serialized) struct ConversationSelectionTests {
    struct Item: Identifiable, Equatable {
        let id: String
        let text: String
    }

    nonisolated final class Quotes: @unchecked Sendable {
        var all: [String] = []
    }

    let quotes = Quotes()
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 720, height: 520), styleMask: [.titled, .resizable], backing: .buffered, defer: false)

    init() async throws {
        TestEnvironment.prepare()
        let items = [
            Item(id: "a", text: "The keeper climbed the stairs at dusk and lit the great lamp for the ships."),
            Item(id: "b", text: "Out at sea the captain saw the light and turned toward the harbor."),
        ]
        let quotes = quotes
        let view = ConversationScroll(scroller: ConversationScroller(), change: 0, quote: { quotes.all.append($0) }) {
            RowStack(items: items, id: \.id, same: ==, estimate: { _ in 60 }) { item, _ in
                ReplyView(markdown: item.text, parser: FileLinkingParser(folders: { [] }))
            }
        }
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view.frame(width: 720, height: 520))
        window.orderBack(nil)
        for _ in 0..<40 where texts.count < 2 {
            window.contentView?.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(25))
        }
    }

    private func done() {
        window.orderOut(nil)
        window.close()
    }

    private func all<T: NSView>(_ type: T.Type, in view: NSView?) -> [T] {
        guard let view else { return [] }
        return ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { all(type, in: $0) }
    }

    private var stack: RowStackView? { all(RowStackView.self, in: window.contentView).first }
    private var texts: [ReplyTextView] { all(ReplyTextView.self, in: stack).sorted { $0.convert($0.bounds, to: nil).maxY > $1.convert($1.bounds, to: nil).maxY } }
    private var bar: NSHostingView<SelectionActions>? { stack?.subviews.compactMap { $0 as? NSHostingView<SelectionActions> }.first }

    /// A point in `text`, `x` in from its left, on its first line, in the window.
    private func point(in text: NSTextView, x: CGFloat) -> NSPoint {
        let line = text.layoutManager!.lineFragmentRect(forGlyphAt: 0, effectiveRange: nil)
        return text.convert(NSPoint(x: x, y: line.midY), to: nil)
    }

    private func event(_ type: NSEvent.EventType, at point: NSPoint, clicks: Int = 1) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                           windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
    }

    /// Pressed on `from` in `text`, dragged to `to`, let go there.
    private func drag(in text: NSTextView, from: NSPoint, to: NSPoint) {
        for step in 1...8 {
            let t = CGFloat(step) / 8
            NSApp.postEvent(event(.leftMouseDragged, at: NSPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)), atStart: false)
        }
        NSApp.postEvent(event(.leftMouseUp, at: to), atStart: false)
        text.mouseDown(with: event(.leftMouseDown, at: from))
    }

    private func click(in text: NSTextView, at point: NSPoint, clicks: Int = 1) {
        NSApp.postEvent(event(.leftMouseUp, at: point, clicks: clicks), atStart: false)
        text.mouseDown(with: event(.leftMouseDown, at: point, clicks: clicks))
    }

    @Test(arguments: [false, true])
    func aDragAcrossRepliesIsOneSelectionWithItsMenu(backwards: Bool) throws {
        defer { done() }
        let stack = try #require(stack)
        let (first, second) = (texts[0], texts[1])
        let start = point(in: first, x: 120), end = point(in: second, x: 160)
        if backwards { drag(in: second, from: end, to: start) } else { drag(in: first, from: start, to: end) }

        let selected = stack.selectedText()
        #expect(selected.contains("lit the great lamp for the ships."), "\(selected)")
        #expect(selected.contains("Out at sea"), "\(selected)")
        #expect(first.selectedRange().length > 0 && second.selectedRange().length > 0, "each reply shows its part")
        // One look for all of it, whatever color TextKit would fill each part with.
        let look: NSColor = stack.isSelectionEmphasized ? .selectedTextBackgroundColor : .unemphasizedSelectedTextBackgroundColor
        for text in [first, second] {
            for given in [NSColor.unemphasizedSelectedTextBackgroundColor, .selectedTextBackgroundColor, .systemGray] {
                #expect(SelectionColor.shown(given, in: text, for: text.selectedRange()) == look)
            }
        }
        // Another fill, outside the selection (an inline code's background), as it is.
        #expect(SelectionColor.shown(.systemTeal, in: first, for: NSRange(location: 0, length: 2)) == .systemTeal)
        // The conversation has the keyboard, never one of its texts.
        #expect(window.firstResponder === stack)
        #expect(!first.acceptsFirstResponder && !second.acceptsFirstResponder)

        // Its menu, over its first line.
        let menu = try #require(bar, "the menu shows once it's let go")
        let line = first.convert(first.layoutManager!.lineFragmentRect(forGlyphAt: 0, effectiveRange: nil), to: stack)
        #expect(menu.frame.maxY <= line.minY + 1 || menu.frame.minY >= line.maxY - 1, "over or under the line, not on it: \(menu.frame) \(line)")
        // Clear of every line it selected, in each reply, so it hides none of what you chose.
        var lines: [NSRect] = []
        for text in [first, second] {
            let layout = text.layoutManager!
            let glyphs = layout.glyphRange(forCharacterRange: text.selectedRange(), actualCharacterRange: nil)
            layout.enumerateLineFragments(forGlyphRange: glyphs) { rect, _, _, _, _ in
                lines.append(text.convert(rect.offsetBy(dx: text.textContainerOrigin.x, dy: text.textContainerOrigin.y), to: stack))
            }
        }
        #expect(lines.count >= 2)
        let scroll = try #require(stack.enclosingScrollView)
        #expect(stack.convert(scroll.contentView.bounds, from: scroll.contentView).contains(menu.frame), "in sight: \(menu.frame)")
        for line in lines {
            #expect(!menu.frame.insetBy(dx: 0, dy: 1).intersects(line), "the menu \(menu.frame) covers a selected line \(line)")
        }

        // Add to Chat quotes what's selected, and the menu goes.
        let addToChat = try #require(menu.rootView.addToChat)
        addToChat()
        #expect(quotes.all == [selected.trimmingCharacters(in: .whitespacesAndNewlines)])
        #expect(bar == nil)
    }

    @Test func aClickLetsItGoADoubleClickTakesAWord() throws {
        defer { done() }
        let stack = try #require(stack)
        let first = texts[0]
        drag(in: first, from: point(in: first, x: 40), to: point(in: first, x: 200))
        #expect(stack.selection != nil)
        click(in: first, at: point(in: first, x: 300))
        #expect(stack.selection == nil, "a click lets it go")
        #expect(bar == nil)
        #expect(first.selectedRange().length == 0)

        click(in: first, at: point(in: first, x: 45), clicks: 2)
        let word = stack.selectedText()
        #expect(!word.isEmpty && !word.contains(" "), "one word: \(word)")
        #expect(bar != nil, "with its menu")
    }

    /// With no room over the selection, and the composer just under it, the menu stays in what's
    /// in sight: never under the composer.
    @Test func theMenuStaysOutFromUnderTheComposer() throws {
        defer { done() }
        let stack = try #require(stack)
        let scroll = try #require(stack.enclosingScrollView)
        let (first, second) = (texts[0], texts[1])
        func line(of text: NSTextView) -> NSRect {
            text.convert(text.layoutManager!.lineFragmentRect(forGlyphAt: 0, effectiveRange: nil), to: stack)
        }
        // The header ends at the first line's top; the composer starts 10 pt under the second's.
        let clip = stack.convert(scroll.contentView.bounds, from: scroll.contentView)
        let top = line(of: first).minY - clip.minY, bottom = clip.maxY - line(of: second).maxY - 10
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: top, left: 0, bottom: bottom, right: 0)
        scroll.contentView.scroll(to: scroll.contentView.bounds.origin)
        window.contentView?.layoutSubtreeIfNeeded()

        drag(in: first, from: point(in: first, x: 40), to: point(in: second, x: 160))
        let menu = try #require(bar, "the menu shows once it's let go")
        let shown = stack.convert(scroll.contentView.bounds, from: scroll.contentView)
        let inSight = NSRect(x: shown.minX, y: shown.minY + scroll.contentInsets.top, width: shown.width,
                             height: shown.height - scroll.contentInsets.top - scroll.contentInsets.bottom)
        #expect(inSight.contains(menu.frame), "between the header and the composer \(inSight): \(menu.frame)")
    }
}
