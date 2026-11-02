import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// A conversation scrolled up, with Scroll to the End floating over its rows: real rows in a
/// window of the test's own. Nothing moves the real pointer: the texts are asked what they'd show,
/// or told of a move as AppKit tells them.
@MainActor
final class ScrolledConversation {
    struct Item: Identifiable, Equatable {
        let id: String
        let text: String
    }

    let scroller = ConversationScroller()
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 720, height: 520), styleMask: [.titled, .resizable], backing: .buffered, defer: false)

    /// Six rows of long paragraphs (so their words run under the button at the bottom's middle),
    /// each starting with a link, drawn by `row`.
    init(row: @escaping (Item) -> AnyView) async {
        TestEnvironment.prepare()
        let words = String(repeating: "The keeper climbed the stairs at dusk and lit the great lamp for the ships out at sea. ", count: 14)
        let items = (0..<6).map { Item(id: "\($0)", text: "Read [the harbor log](https://example.com/log) first. " + words) }
        let view = ConversationScroll(scroller: scroller, change: 0, quote: { _ in }) {
            RowStack(items: items, id: \.id, same: ==, estimate: { _ in 400 }) { item, _ in row(item) }
        }
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view.frame(width: 720, height: 520))
        window.orderBack(nil)
        await settle { !texts.isEmpty }
        // Scrolled up, so Scroll to the End shows, with the middle of a row's text level with the
        // bottom's middle (where the button is), so the words run all the way under it however
        // tall the rows are. Lined up again until the rows have their heights (a long message
        // grows a Show More once it's laid out).
        scroller.scroll(to: 0)
        await settle {
            // Scrolled up for real: with the end in view there's no way back to it to show.
            if scroller.seesEnd { scroller.scroll(to: 0) } else { lineUpATextWithTheControl() }
            return !scroller.seesEnd && pointsUnderAControl().count > 10 && besideTheControl() != nil
        }
    }

    private static let band: CGFloat = 46
    private var linedUpTo: CGFloat?

    private func lineUpATextWithTheControl() {
        guard let top = distanceFromTop, let text = texts
            .filter({ $0.window != nil })
            .map({ $0.convert($0.bounds, to: nil) })
            .filter({ $0.height > 120 })
            .min(by: { abs($0.midY - Self.band) < abs($1.midY - Self.band) }) else { return }
        // Up the conversation brings its words down the window, down it brings them up.
        let target = top - (text.midY - Self.band)
        guard abs(text.midY - Self.band) > 1, target != linedUpTo else { return }
        linedUpTo = target
        scroller.scroll(to: target)
    }

    /// How far down the conversation is scrolled.
    private var distanceFromTop: CGFloat? {
        guard let clip = stack?.enclosingScrollView?.contentView, let document = clip.documentView else { return nil }
        return document.isFlipped ? clip.bounds.minY : document.frame.height - clip.bounds.maxY
    }

    /// Lets the window lay out and SwiftUI and the rows catch up, until `ready`.
    private func settle(until ready: () -> Bool) async {
        var turns = 0
        while !ready(), turns < 400 {
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            await Task.yield()
            turns += 1
        }
    }

    func done() {
        NSCursor.arrow.set()
        window.orderOut(nil)
        window.close()
    }

    /// The pointer moved to `point` (in the window), as AppKit tells it: a move to the owner of each
    /// text's tracking area for moves that has the point.
    func move(to point: NSPoint) throws {
        let event = try #require(NSEvent.mouseEvent(with: .mouseMoved, location: point, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0))
        for text in texts where text.window != nil {
            let local = text.convert(point, from: nil)
            for area in text.trackingAreas where area.options.contains(.mouseMoved) {
                let rect = area.options.contains(.inVisibleRect) ? text.visibleRect : area.rect
                if rect.contains(local) { (area.owner as? NSResponder)?.mouseMoved(with: event) }
            }
        }
    }

    private func all<T: NSView>(_ type: T.Type, in view: NSView?) -> [T] {
        guard let view else { return [] }
        return ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { all(type, in: $0) }
    }

    /// The rows' texts.
    var texts: [PointerAwareTextView] { all(PointerAwareTextView.self, in: stack) }
    private var stack: RowStackView? { all(RowStackView.self, in: window.contentView).first }

    /// The text laid out under `point` (in the window), whatever is over it.
    func text(under point: NSPoint) -> PointerAwareTextView? {
        texts.first { $0.window != nil && $0.convert($0.bounds, to: nil).contains(point) }
    }

    /// What a click at `point` reaches.
    func hit(_ point: NSPoint) -> NSView? {
        var root = window.contentView
        while let parent = root?.superview { root = parent }
        return root?.hitTest(point)
    }

    /// Points along the bottom's middle with a row's text laid out under them but something
    /// drawn over the conversation on top: Scroll to the End.
    func pointsUnderAControl() -> [NSPoint] {
        guard let stack else { return [] }
        return (2...90).map { NSPoint(x: 360, y: CGFloat($0)) }.filter { point in
            guard text(under: point) != nil, let hit = hit(point) else { return false }
            return hit !== stack && !hit.isDescendant(of: stack)
        }
    }

    /// A point on a row's words beside the button, level with its middle.
    func besideTheControl() -> NSPoint? {
        let under = pointsUnderAControl()
        guard !under.isEmpty else { return nil }
        let middle = under[under.count / 2].y
        return (40...700).map { NSPoint(x: CGFloat($0), y: middle) }.first { (hit($0) as? PointerAwareTextView)?.pointer(at: $0) == .iBeam }
    }

    /// The middle of the first link in a row in view with nothing over it, and a point on the
    /// words at its start.
    func aLink() -> (text: PointerAwareTextView, onLink: NSPoint, onWords: NSPoint)? {
        texts.compactMap { text -> (PointerAwareTextView, NSPoint, NSPoint)? in
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
            return (text, text.convert(onLink, to: nil), text.convert(NSPoint(x: origin.x + 2, y: onLink.y), to: nil))
        }.first
    }

    // The checks each suite makes of its rows.

    func checkNoIBeamOverScrollToTheEnd() throws {
        let under = pointsUnderAControl()
        #expect(under.count > 10, "a row's text under Scroll to the End at \(under.count) points")
        for point in under {
            let text = try #require(text(under: point))
            #expect(text.pointer(at: point) == nil, "the I-beam at \(point.y), over Scroll to the End")
        }
        // Beside the button, on the same line of words: the I-beam.
        let beside = try #require(besideTheControl())
        let text = try #require(hit(beside) as? PointerAwareTextView)
        #expect(text.pointer(at: beside) == .iBeam)
    }

    func checkMovingOntoScrollToTheEndLetsTheIBeamGo() throws {
        let beside = try #require(besideTheControl())
        let under = try #require(pointsUnderAControl().first { abs($0.y - beside.y) < 1 })
        NSCursor.arrow.set()
        try move(to: beside)
        #expect(NSCursor.current == .iBeam, "on the words")
        try move(to: under)
        #expect(NSCursor.current != .iBeam, "over Scroll to the End")
        try move(to: beside)
        #expect(NSCursor.current == .iBeam, "back on the words")
    }

    func checkALinkShowsThePointingHand() throws {
        let (text, onLink, onWords) = try #require(aLink())
        #expect(text.pointer(at: onLink) == .pointingHand, "\(String(describing: text.pointer(at: onLink))) at \(onLink) in \(text.string.prefix(30))")
        #expect(text.pointer(at: onWords) == .iBeam)
    }
}

/// The pointer over replies with Scroll to the End floating over them: over the button the reply
/// under it shows no I-beam (the button's pointer shows), over the reply's words beside it the
/// I-beam, over a link the pointing hand.
@MainActor
@Suite(.serialized) struct PointerOverTextTests {
    let scene: ScrolledConversation

    init() async throws {
        scene = await ScrolledConversation { item in
            AnyView(ReplyView(markdown: item.text, parser: FileLinkingParser(folders: { [] })))
        }
    }

    @Test func noIBeamOverScrollToTheEnd() throws {
        defer { scene.done() }
        try scene.checkNoIBeamOverScrollToTheEnd()
    }

    @Test func movingOntoScrollToTheEndLetsTheIBeamGo() throws {
        defer { scene.done() }
        try scene.checkMovingOntoScrollToTheEndLetsTheIBeamGo()
    }

    @Test func aLinkShowsThePointingHand() throws {
        defer { scene.done() }
        try scene.checkALinkShowsThePointingHand()
    }
}

/// The same over your own messages: their words are drawn by AppKit's text as the composer's are,
/// so the I-beam shows only where they're on top, never under Scroll to the End. (SwiftUI's
/// selectable Text, which drew them before, kept its I-beam over its whole frame.)
@MainActor
@Suite(.serialized) struct PointerOverYourMessagesTests {
    let app = AppModel()
    let scene: ScrolledConversation

    init() async throws {
        let app = app
        scene = await ScrolledConversation { item in
            // As sent: a web address (a link, as the bubble makes it) and long words after it.
            let words = item.text.replacingOccurrences(of: "[the harbor log](https://example.com/log)", with: "https://example.com/harbor-log")
            return AnyView(UserBubble(text: words).environment(app))
        }
    }

    @Test func noIBeamOverScrollToTheEnd() throws {
        defer { scene.done() }
        try scene.checkNoIBeamOverScrollToTheEnd()
    }

    @Test func movingOntoScrollToTheEndLetsTheIBeamGo() throws {
        defer { scene.done() }
        try scene.checkMovingOntoScrollToTheEndLetsTheIBeamGo()
    }

    @Test func aLinkShowsThePointingHand() throws {
        defer { scene.done() }
        try scene.checkALinkShowsThePointingHand()
    }
}

/// The composer and a file in the panel sit in scroll views, which AppKit gives the I-beam over
/// all they show whenever their text is made selectable or editable in a window, under whatever
/// is drawn over them. Theirs stays off: the text's own claim shows the I-beam where it's on top.
@MainActor
@Suite(.serialized) struct PointerOverScrolledTextTests {
    struct Composer: View {
        @State var text = "Hello"
        let editable: Bool
        var body: some View {
            var field = MessageField(text: $text, placeholder: "Message", font: .systemFont(ofSize: 13))
            field.isEditable = editable
            return field.frame(width: 400, height: 80)
        }
    }

    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 420, height: 320), styleMask: [.titled], backing: .buffered, defer: false)

    init() {
        TestEnvironment.prepare()
        window.isReleasedWhenClosed = false
    }

    private func done() {
        window.orderOut(nil)
        window.close()
    }

    private func texts(in view: NSView?) -> [PointerAwareTextView] {
        guard let view else { return [] }
        return ((view as? PointerAwareTextView).map { [$0] } ?? []) + view.subviews.flatMap { texts(in: $0) }
    }

    private func show(_ view: some View) async -> [PointerAwareTextView] {
        if let host = window.contentView as? NSHostingView<AnyView> {
            host.rootView = AnyView(view)
        } else {
            window.contentView = NSHostingView(rootView: AnyView(view))
            window.orderBack(nil)
        }
        var turns = 0
        while texts(in: window.contentView).isEmpty, turns < 100 {
            window.contentView?.layoutSubtreeIfNeeded()
            await Task.yield()
            turns += 1
        }
        window.contentView?.layoutSubtreeIfNeeded()
        return texts(in: window.contentView)
    }

    @Test func theComposersScrollViewShowsNoIBeamOfItsOwn() async throws {
        defer { done() }
        _ = await show(Composer(editable: true))
        // Voice input takes over and gives it back: editable set again, in the window.
        let listening = try #require(await show(Composer(editable: false)).first)
        #expect(!listening.isEditable)
        let text = try #require(await show(Composer(editable: true)).first)
        #expect(text.isEditable)
        let scroll = try #require(text.enclosingScrollView)
        #expect(scroll.documentCursor == nil)
    }

    @Test func aFilesScrollViewShowsNoIBeamOfItsOwn() async throws {
        defer { done() }
        let text = try #require(await show(CodeTextView(text: "let x = 1\nlet y = 2\n", language: nil).frame(width: 400, height: 300)).first)
        // Made selectable again in the window, as when the file reloads.
        text.isSelectable = false
        text.isSelectable = true
        let scroll = try #require(text.enclosingScrollView)
        #expect(scroll.documentCursor == nil)
    }
}
