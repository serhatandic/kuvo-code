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
        WindowServer.pointerIsOver(window)
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
    /// view's on its run loop's next turn (`WindowServer.appKitsTurn`), not as it's laid out, and
    /// always before it hands over a move of the real pointer; a move told to a text without one
    /// would reach nothing.
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
            WindowServer.appKitsTurn(over: window)
            await Task.yield()
            turns += 1
        }
    }

    func done() {
        WindowServer.pointerLeft(window)
        NSCursor.arrow.set()
        window.orderOut(nil)
        window.close()
    }

    /// The pointer moved to `point` (in the window), as AppKit tells it: a move to the owner of each
    /// text's tracking area for moves that has the point.
    func move(to point: NSPoint) throws {
        let event = try moveEvent(to: point)
        for owner in owners(at: point) { owner.mouseMoved(with: event) }
    }

    /// Each owner of a tracking area for moves at `point` told of a move there on its own, as
    /// AppKit tells them in an order of its own: the pointer each shows after it, from the arrow.
    func pointersShown(movingTo point: NSPoint, over only: PointerAwareTextView? = nil) throws -> [NSCursor] {
        let event = try moveEvent(to: point)
        return areas(at: point, for: .mouseMoved, over: only).compactMap { $0.owner as? NSResponder }.map { owner in
            NSCursor.arrow.set()
            owner.mouseMoved(with: event)
            return NSCursor.current
        }
    }

    /// Each owner of a tracking area for coming on and leaving at `point` told the pointer came on
    /// there, on its own, by an event naming its area as AppKit's do: the pointer each shows after
    /// it, from the arrow. As when a row comes in under the pointer resting there.
    func pointersShown(comingOnAt point: NSPoint, over only: PointerAwareTextView? = nil) throws -> [NSCursor] {
        try areas(at: point, for: .mouseEnteredAndExited, over: only).map { area in
            let event = try #require(NSEvent.enterExitEvent(with: .mouseEntered, location: point, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, trackingNumber: Int(bitPattern: Unmanaged.passUnretained(area).toOpaque()), userData: nil))
            NSCursor.arrow.set()
            (area.owner as? NSResponder)?.mouseEntered(with: event)
            return NSCursor.current
        }
    }

    /// Each owner of a tracking area for pointer updates at `point` asked for its pointer there,
    /// on its own, as AppKit asks when the pointer comes into its area: the pointer each shows
    /// after it, from the arrow.
    func pointersShown(updatingAt point: NSPoint, over only: PointerAwareTextView? = nil) throws -> [NSCursor] {
        try areas(at: point, for: .cursorUpdate, over: only).map { area in
            let event = try #require(NSEvent.enterExitEvent(with: .cursorUpdate, location: point, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, trackingNumber: Int(bitPattern: Unmanaged.passUnretained(area).toOpaque()), userData: nil))
            NSCursor.arrow.set()
            (area.owner as? NSResponder)?.cursorUpdate(with: event)
            return NSCursor.current
        }
    }

    /// A menu opened over the rows at `point`, as the composer's chips open theirs (and Decisions
    /// and the model picker their popovers): a window of its own in front of the conversation's,
    /// the one the window server has under the pointer. Until `closeTheMenu`.
    private func openAMenu(at point: NSPoint) -> NSWindow {
        let corner = window.convertPoint(toScreen: point)
        let menu = NSPanel(contentRect: NSRect(x: corner.x - 40, y: corner.y - 60, width: 240, height: 160), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        menu.level = .popUpMenu
        menu.isReleasedWhenClosed = false
        menu.orderFront(nil)
        WindowServer.pointerIsOver(menu)
        return menu
    }

    private func closeTheMenu(_ menu: NSWindow) {
        WindowServer.pointerIsOver(window)
        menu.orderOut(nil)
        menu.close()
    }

    private func moveEvent(to point: NSPoint) throws -> NSEvent {
        try #require(NSEvent.mouseEvent(with: .mouseMoved, location: point, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0))
    }

    /// The owners of the texts' tracking areas for moves that have `point` (in the window): the
    /// claim's own, and AppKit's text view's.
    private func owners(at point: NSPoint) -> [NSResponder] {
        areas(at: point, for: .mouseMoved).compactMap { $0.owner as? NSResponder }
    }

    /// The texts' tracking areas for `events` that have `point` (in the window), or only `only`'s.
    private func areas(at point: NSPoint, for events: NSTrackingArea.Options, over only: PointerAwareTextView? = nil) -> [NSTrackingArea] {
        texts.filter { $0.window != nil && (only == nil || $0 === only) }.flatMap { text in
            let local = text.convert(point, from: nil)
            return text.trackingAreas.filter { area in
                area.options.contains(events) && (area.options.contains(.inVisibleRect) ? text.visibleRect : area.rect).contains(local)
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

    /// A point (in the window) on `text`'s words where nothing is over them.
    func pointOnTheWords(of text: PointerAwareTextView) -> NSPoint? {
        guard text.window != nil, let bounds = window.contentView?.bounds else { return nil }
        let frame = text.convert(text.visibleRect, to: nil).intersection(bounds)
        guard !frame.isEmpty else { return nil }
        return stride(from: frame.minY + 4, to: frame.maxY, by: 8).lazy.flatMap { y in
            stride(from: frame.minX + 4, to: frame.maxX, by: 16).lazy.map { NSPoint(x: $0, y: y) }
        }.first { self.hit($0) === text && text.pointer(at: $0) == .iBeam }
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

    /// However AppKit orders the moves it hands the texts' tracking areas (the claim's, and each
    /// text view's own), none leaves the I-beam over Scroll to the End, nor does a row coming in
    /// under the pointer resting on it.
    func checkNoMoveShowsTheIBeamOverScrollToTheEnd() throws {
        for point in pointsUnderAControl() {
            let shown = try pointersShown(movingTo: point)
            #expect(shown.count > 1, "the claim's tracking area and the text view's own at \(point.y)")
            #expect(!shown.contains(.iBeam), "the I-beam at \(point.y), over Scroll to the End")
            // A row come in under the pointer resting on it.
            #expect(try !pointersShown(comingOnAt: point).contains(.iBeam), "the I-beam coming on at \(point.y), over Scroll to the End")
        }
        // On the words beside it, the text there shows the I-beam from each.
        let beside = try #require(besideTheControl())
        let onTheWords = try pointersShown(movingTo: beside, over: try #require(hit(beside) as? PointerAwareTextView))
        #expect(onTheWords.count > 1 && onTheWords.allSatisfy { $0 == .iBeam }, "on the words: \(onTheWords)")
        #expect(try pointersShown(comingOnAt: beside, over: try #require(hit(beside) as? PointerAwareTextView)).contains(.iBeam), "coming on the words")
    }

    /// A menu open over the words (the mode chip's, or a popover like Decisions): the words under
    /// it show no I-beam, however AppKit tells them of the pointer, and the menu's own pointer
    /// shows. Closed, the I-beam is back on them.
    func checkNoIBeamUnderAMenu() throws {
        let words = try #require(besideTheControl())
        let text = try #require(hit(words) as? PointerAwareTextView)
        let menu = openAMenu(at: words)
        defer { if menu.isVisible { closeTheMenu(menu) } }
        #expect(text.pointer(at: words) == nil, "the I-beam on the words under the menu")
        let moved = try pointersShown(movingTo: words)
        #expect(moved.count > 1, "the claim's tracking area and the text view's own")
        #expect(!moved.contains(.iBeam), "the I-beam from a move under the menu: \(moved)")
        #expect(try !pointersShown(comingOnAt: words).contains(.iBeam), "the I-beam coming on under the menu")
        let updated = try pointersShown(updatingAt: words)
        #expect(!updated.isEmpty, "a tracking area for pointer updates")
        #expect(!updated.contains(.iBeam), "the I-beam from a pointer update under the menu: \(updated)")
        closeTheMenu(menu)
        #expect(text.pointer(at: words) == .iBeam, "the I-beam on the words once the menu is closed")
        #expect(try pointersShown(movingTo: words, over: text).allSatisfy { $0 == .iBeam }, "a move on the words once the menu is closed")
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

    @Test func noMoveShowsTheIBeamOverScrollToTheEnd() throws {
        defer { scene.done() }
        try scene.checkNoMoveShowsTheIBeamOverScrollToTheEnd()
    }

    @Test func aLinkShowsThePointingHand() throws {
        defer { scene.done() }
        try scene.checkALinkShowsThePointingHand()
    }

    @Test func noIBeamUnderAMenu() throws {
        defer { scene.done() }
        try scene.checkNoIBeamUnderAMenu()
    }

    /// Scrolled to rows not in view before: once the run loop has turned, as it does before the
    /// pointer's next move, the I-beam shows on their words. (That AppKit gives the rows their
    /// tracking areas then is AppKit's part, taken here by `appKitsTurn`: the rows' own part is
    /// what this checks.)
    @Test func rowsScrolledIntoViewShowTheIBeam() async throws {
        defer { scene.done() }
        let shown = Set(scene.texts.map(ObjectIdentifier.init))
        try #require(scene.scrollToRowsNotShownYet(besides: shown))
        await scene.runLoopTurned()
        // Wherever the rows settled: words of one not in view before.
        let words = try #require(scene.texts.lazy.filter { !shown.contains(ObjectIdentifier($0)) }.compactMap { scene.pointOnTheWords(of: $0) }.first, "a row not in view before")
        NSCursor.arrow.set()
        try scene.move(to: words)
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

    @Test func noMoveShowsTheIBeamOverScrollToTheEnd() throws {
        defer { scene.done() }
        try scene.checkNoMoveShowsTheIBeamOverScrollToTheEnd()
    }

    @Test func aLinkShowsThePointingHand() throws {
        defer { scene.done() }
        try scene.checkALinkShowsThePointingHand()
    }

    @Test func noIBeamUnderAMenu() throws {
        defer { scene.done() }
        try scene.checkNoIBeamUnderAMenu()
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

    @Test func noMoveShowsTheIBeamOverScrollToTheEnd() throws {
        defer { scene.done() }
        try scene.checkNoMoveShowsTheIBeamOverScrollToTheEnd()
    }
}

/// The window server's answer to which window is under a point on the screen, while a scene is up
/// (and AppKit's turn that follows the pointer coming into a window, `appKitsTurn`):
/// its window, as the user's window is under their pointer (a test's never is), or a menu opened
/// over it. AppKit's text views ask it before they show their I-beam on
/// a move, and so does every view claiming the pointer (`PointerClaim`).
@MainActor enum WindowServer {
    private static var over: Int?
    private static var isStubbed = false

    /// The pointer gone from `window`: the real answer again, unless another scene's window has it.
    static func pointerLeft(_ window: NSWindow) {
        if over == window.windowNumber { over = nil }
    }

    /// AppKit's turn over `window` before it hands on the pointer's next event there: the views'
    /// cursor rectangles given again and their tracking areas updated. AppKit (on macOS 27.2)
    /// takes it only for a window the window server has sent an event of the pointer's, once the
    /// pointer has come into it, and then for the views that moved or changed size; a test's
    /// window, never under the real pointer, would get no tracking areas and no cursor rectangles
    /// at all. A scene takes it each time its window settles, for every view, which is more than
    /// AppKit does: each view's own `updateTrackingAreas` still decides what it tracks.
    static func appKitsTurn(over window: NSWindow) {
        window.resetCursorRects()
        func update(_ view: NSView) {
            view.updateTrackingAreas()
            view.subviews.forEach(update)
        }
        var root = window.contentView
        while let parent = root?.superview { root = parent }
        root.map(update)
    }

    static func pointerIsOver(_ window: NSWindow?) {
        over = window?.windowNumber
        guard !isStubbed else { return }
        isStubbed = true
        let selector = #selector(NSWindow.windowNumber(at:belowWindowWithWindowNumber:))
        let method = class_getClassMethod(NSWindow.self, selector)!
        typealias Call = @convention(c) (AnyClass, Selector, NSPoint, Int) -> Int
        let real = unsafeBitCast(method_getImplementation(method), to: Call.self)
        let answer: @convention(block) (AnyClass, NSPoint, Int) -> Int = { type, point, below in
            // Asked off the main thread too, where no scene is. Only within the window: a point
            // anywhere else gets the real answer, as one given in the wrong coordinates would.
            let window = Thread.isMainThread ? MainActor.assumeIsolated { over.flatMap { NSApp.window(withWindowNumber: $0)?.frame.contains(point) == true ? $0 : nil } } : nil
            return window ?? real(type, selector, point, below)
        }
        method_setImplementation(method, imp_implementationWithBlock(answer))
    }
}
