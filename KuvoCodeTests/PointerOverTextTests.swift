import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// The pointer over a conversation scrolled up, with Scroll to the End floating over its replies:
/// over the button the reply under it shows no I-beam (the button's pointer shows), over the
/// reply's words beside it the I-beam, over a link the pointing hand. Real rows and replies, in a
/// window of the test's own; nothing moves the real pointer, the text is asked what it would show.
@MainActor
@Suite(.serialized) struct PointerOverTextTests {
    struct Item: Identifiable, Equatable {
        let id: String
        let text: String
    }

    let scroller = ConversationScroller()
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 720, height: 520), styleMask: [.titled, .resizable], backing: .buffered, defer: false)

    init() async throws {
        TestEnvironment.prepare()
        // Long paragraphs, so their words run under the button at the bottom's middle.
        let words = String(repeating: "The keeper climbed the stairs at dusk and lit the great lamp for the ships out at sea. ", count: 14)
        let items = (0..<6).map { Item(id: "\($0)", text: "Read [the harbor log](https://example.com/log) first. " + words) }
        let view = ConversationScroll(scroller: scroller, change: 0, quote: { _ in }) {
            RowStack(items: items, id: \.id, same: ==, estimate: { _ in 400 }) { item, _ in
                ReplyView(markdown: item.text, parser: FileLinkingParser(folders: { [] }))
            }
        }
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view.frame(width: 720, height: 520))
        window.orderBack(nil)
        for _ in 0..<40 where texts.isEmpty {
            window.contentView?.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(25))
        }
        // Scrolled up: Scroll to the End shows, over a reply's words.
        scroller.scroll(to: 0)
        for _ in 0..<80 where pointsUnderAControl().isEmpty || besideTheControl() == nil {
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

    private var texts: [ReplyTextView] { all(ReplyTextView.self, in: window.contentView) }
    private var stack: RowStackView? { all(RowStackView.self, in: window.contentView).first }

    /// The reply text laid out under `point` (in the window), whatever is over it.
    private func text(under point: NSPoint) -> ReplyTextView? {
        texts.first { $0.window != nil && $0.convert($0.bounds, to: nil).contains(point) }
    }

    /// What a click at `point` reaches.
    private func hit(_ point: NSPoint) -> NSView? {
        var root = window.contentView
        while let parent = root?.superview { root = parent }
        return root?.hitTest(point)
    }

    /// Points along the bottom's middle with a reply's text laid out under them but something
    /// drawn over the conversation on top: Scroll to the End.
    private func pointsUnderAControl() -> [NSPoint] {
        guard let stack else { return [] }
        return (2...90).map { NSPoint(x: 360, y: CGFloat($0)) }.filter { point in
            guard text(under: point) != nil, let hit = hit(point) else { return false }
            return hit !== stack && !hit.isDescendant(of: stack)
        }
    }

    /// A point on the reply's words left of the button, level with its middle.
    private func besideTheControl() -> NSPoint? {
        let under = pointsUnderAControl()
        guard !under.isEmpty else { return nil }
        let middle = under[under.count / 2].y
        return (40...300).map { NSPoint(x: CGFloat($0), y: middle) }.first { hit($0) is ReplyTextView }
    }

    @Test func noIBeamOverScrollToTheEnd() throws {
        defer { done() }
        let under = pointsUnderAControl()
        #expect(under.count > 10)
        for point in under {
            let text = try #require(text(under: point))
            #expect(text.pointer(at: point) == nil, "the I-beam at \(point.y), over Scroll to the End")
        }
        // Beside the button, on the same line of words: the I-beam.
        let beside = try #require(besideTheControl())
        let text = try #require(text(under: beside))
        #expect(text.pointer(at: beside) == .iBeam)
    }

    @Test func aLinkShowsThePointingHand() throws {
        defer { done() }
        // The middle of the link at the start of a reply in view, with nothing over it.
        let found = texts.compactMap { text -> (ReplyTextView, NSPoint, NSPoint)? in
            guard let layout = text.layoutManager, let container = text.textContainer, let storage = text.textStorage else { return nil }
            var link: NSRange?
            storage.enumerateAttribute(.link, in: NSRange(location: 0, length: storage.length)) { value, range, stop in
                if value != nil, link == nil { link = range; stop.pointee = true }
            }
            guard let link, link.length > 4 else { return nil }
            let glyphs = layout.glyphRange(forCharacterRange: NSRange(location: link.location + link.length / 2, length: 1), actualCharacterRange: nil)
            let rect = layout.boundingRect(forGlyphRange: glyphs, in: container)
            let origin = text.textContainerOrigin
            let onLink = NSPoint(x: rect.midX + origin.x, y: rect.midY + origin.y)
            guard text.visibleRect.contains(onLink), hit(text.convert(onLink, to: nil)) === text else { return nil }
            return (text, text.convert(onLink, to: nil), text.convert(NSPoint(x: 8, y: onLink.y), to: nil))
        }.first
        let (text, onLink, onWords) = try #require(found)
        #expect(text.pointer(at: onLink) == .pointingHand, "\(String(describing: text.pointer(at: onLink))) at \(onLink) in \(text.string.prefix(30))")
        #expect(text.pointer(at: onWords) == .iBeam)
    }
}
