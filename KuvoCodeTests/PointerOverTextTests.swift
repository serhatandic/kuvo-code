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

    /// How tall the composer under the conversation is, with `composer`: the rows scroll on under
    /// it, as in a session, and Scroll to the End sits on its edge.
    static let composerHeight: CGFloat = 110
    private let band: CGFloat

    /// Six rows of long paragraphs (so their words run under the button at the bottom's middle),
    /// each starting with a link, drawn by `row`; with `composer`, over the composer's card as a
    /// session's conversation is.
    init(composer: Bool = false, row: @escaping (Item) -> AnyView) async {
        band = composer ? 46 + Self.composerHeight : 46
        TestEnvironment.prepare()
        let words = String(repeating: "The keeper climbed the stairs at dusk and lit the great lamp for the ships out at sea. ", count: 14)
        let items = (0..<6).map { Item(id: "\($0)", text: "Read [the harbor log](https://example.com/log) first. " + words) }
        let view = ConversationScroll(scroller: scroller, change: 0, quote: { _ in }) {
            RowStack(items: items, id: \.id, same: ==, estimate: { _ in 400 }) { item, _ in row(item) }
        }
        window.isReleasedWhenClosed = false
        window.contentView = composer
            ? NSHostingView(rootView: AnyView(view.conversationBar {
                PointerOverScrolledTextTests.Composer(editable: true)
                    .padding(15)
                    .frame(maxWidth: .infinity)
                    .frame(height: Self.composerHeight)
            }.frame(width: 720, height: 520)))
            : NSHostingView(rootView: AnyView(view.frame(width: 720, height: 520)))
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
            return !scroller.seesEnd && pointsUnderAControl().count > 10 && besideTheControl() != nil && textsTrackThePointer
        }
    }

    /// Every text in view has the tracking area it claims the pointer through. AppKit adds a new
    /// view's on its run loop's next turn, not as it's laid out, and always before it hands over a
    /// move of the real pointer; a move told to a text without one would reach nothing.
    private var textsTrackThePointer: Bool {
        texts.filter { $0.window != nil }.allSatisfy { text in text.trackingAreas.contains { $0.options.contains(.mouseMoved) } }
    }

    /// AppKit's run loop turned, as it does before the real pointer's next move: the texts that came
    /// into view track the pointer.
    func runLoopTurned() async {
        await settle { textsTrackThePointer }
    }

    /// Scrolled down the conversation at once, as a flick of the trackpad does, to where the words
    /// beside Scroll to the End are a row's not in view before (`shown`): its rows laid out there,
    /// the run loop not turned yet. Whether it got there.
    func scrollToRowsNotShownYet(besides shown: Set<ObjectIdentifier>) -> Bool {
        guard let clip = stack?.enclosingScrollView?.contentView, let document = clip.documentView else { return false }
        let start = clip.bounds.origin
        for distance in stride(from: 500, through: 1_200, by: 20) {
            clip.scroll(to: NSPoint(x: start.x, y: start.y + (document.isFlipped ? 1 : -1) * CGFloat(distance)))
            clip.enclosingScrollView?.reflectScrolledClipView(clip)
            window.contentView?.layoutSubtreeIfNeeded()
            if let beside = besideTheControl(), let text = hit(beside), !shown.contains(ObjectIdentifier(text)) { return true }
        }
        return false
    }

    private var linedUpTo: CGFloat?

    private func lineUpATextWithTheControl() {
        // One it can be scrolled to: not one that would have to come down from above the top.
        guard let top = distanceFromTop, let text = texts
            .filter({ $0.window != nil })
            .map({ $0.convert($0.bounds, to: nil) })
            .filter({ $0.height > 120 && top - ($0.midY - band) >= 0 })
            .min(by: { abs($0.midY - band) < abs($1.midY - band) }) else { return }
        // Up the conversation brings its words down the window, down it brings them up.
        let target = top - (text.midY - band)
        guard abs(text.midY - band) > 1, target != linedUpTo else { return }
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
        return (2...Int(band + 44)).map { NSPoint(x: 360, y: CGFloat($0)) }.filter { point in
            guard text(under: point) != nil, let hit = hit(point) else { return false }
            return hit !== stack && !hit.isDescendant(of: stack)
        }
    }

    /// Scroll to the End's middle: 15 points under the top of what's over the rows there (under
    /// it, the bottom's edge or the composer).
    func controlMiddle() -> NSPoint? {
        pointsUnderAControl().last.map { NSPoint(x: 360, y: $0.y - 15) }
    }

    /// A point on a row's words beside the button, level with its middle.
    func besideTheControl() -> NSPoint? {
        guard let middle = controlMiddle()?.y else { return nil }
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

    /// Across Scroll to the End's whole circle, not only down its middle (where its arrow is): a
    /// click anywhere on it reaches it, and the text under it shows no I-beam there.
    func checkNoIBeamAcrossScrollToTheEnd() throws {
        let center = try #require(controlMiddle())
        // Inside its 30-point circle, short of the rim.
        let across = stride(from: -12, through: 12, by: 2).flatMap { dx in
            stride(from: -12, through: 12, by: 2).map { dy in NSPoint(x: center.x + CGFloat(dx), y: center.y + CGFloat(dy)) }
        }.filter { hypot($0.x - center.x, $0.y - center.y) <= 12 }
        for point in across {
            guard let text = text(under: point) else { continue }
            #expect(text.pointer(at: point) == nil, "the I-beam \(point.x - center.x), \(point.y - center.y) from Scroll to the End's middle")
        }
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

    @Test func noIBeamAcrossScrollToTheEnd() throws {
        defer { scene.done() }
        try scene.checkNoIBeamAcrossScrollToTheEnd()
    }

    @Test func movingOntoScrollToTheEndLetsTheIBeamGo() throws {
        defer { scene.done() }
        try scene.checkMovingOntoScrollToTheEndLetsTheIBeamGo()
    }

    @Test func aLinkShowsThePointingHand() throws {
        defer { scene.done() }
        try scene.checkALinkShowsThePointingHand()
    }

    /// Scrolled to rows not in view before: once the run loop has turned, as it does before the
    /// pointer's next move, the I-beam shows on their words.
    @Test func rowsScrolledIntoViewShowTheIBeam() async throws {
        defer { scene.done() }
        let shown = Set(scene.texts.map(ObjectIdentifier.init))
        try #require(scene.scrollToRowsNotShownYet(besides: shown))
        await scene.runLoopTurned()
        let beside = try #require(scene.besideTheControl())
        #expect(scene.hit(beside).map { !shown.contains(ObjectIdentifier($0)) } == true, "a row not in view before")
        NSCursor.arrow.set()
        try scene.move(to: beside)
        #expect(NSCursor.current == .iBeam)
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

    @Test func noIBeamAcrossScrollToTheEnd() throws {
        defer { scene.done() }
        try scene.checkNoIBeamAcrossScrollToTheEnd()
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

/// The same as in a session, where the conversation scrolls on under the composer and Scroll to
/// the End sits on the composer's edge: no I-beam over the button, nor under the composer.
@MainActor
@Suite(.serialized) struct PointerOverTextAboveTheComposerTests {
    let scene: ScrolledConversation

    init() async throws {
        scene = await ScrolledConversation(composer: true) { item in
            AnyView(ReplyView(markdown: item.text, parser: FileLinkingParser(folders: { [] })))
        }
    }

    @Test func noIBeamOverScrollToTheEndNorTheComposer() throws {
        defer { scene.done() }
        try scene.checkNoIBeamOverScrollToTheEnd()
    }

    @Test func noIBeamAcrossScrollToTheEnd() throws {
        defer { scene.done() }
        try scene.checkNoIBeamAcrossScrollToTheEnd()
    }

    @Test func movingOntoScrollToTheEndLetsTheIBeamGo() throws {
        defer { scene.done() }
        try scene.checkMovingOntoScrollToTheEndLetsTheIBeamGo()
    }
}
