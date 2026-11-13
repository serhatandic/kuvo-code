import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Whatever makes the composer taller pushes the conversation, so nothing sits under it: following
/// the end, the last message stays over it; reading further up, what was just over it stays there,
/// and it's all back as the composer shrinks. The conversation and composer are the real ones, in
/// a window of the test's own; selections and scrolling come as the pointer's and the trackpad's
/// events.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ComposerGrowthTests {
    let engine = StubEngine(port: 48_205)
    let app = AppModel()
    let catalog = Catalog()
    let model: SessionModel
    let id = "ses_growth_" + UUID().uuidString
    static let size = NSSize(width: 720, height: 620)
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: size.width, height: size.height), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    /// Its messages' ids of its own: what's opened is kept by them, for as long as the app runs.
    let run = "msg_" + UUID().uuidString.prefix(8) + "_"

    /// Something of the window's own that animates as the composer does, to tell when that's over.
    @Observable final class Probe { var isOn = false }
    struct ProbeView: View {
        let probe: Probe
        // Drawn, with an opacity that animates: over nothing to animate, its end comes at once.
        var body: some View { Color.black.opacity(probe.isOn ? 0.02 : 0.01).frame(width: 1, height: 1) }
    }
    let probe = Probe()

    /// The session in view: another can take its place, under the same composer's room.
    @Observable final class Shown {
        var model: SessionModel
        init(_ model: SessionModel) { self.model = model }
    }
    struct Root: View {
        let shown: Shown
        var body: some View { SessionView(model: shown.model) }
    }
    let shown: Shown
    /// Another session, to go to and back.
    let other = "ses_growth_other_" + UUID().uuidString

    static let longQuote = String(repeating: "The keeper climbed the stairs at dusk and lit the great lamp. ", count: 4)

    init() async throws {
        TestEnvironment.prepare()
        app.workspace.api = engine.api
        engine.list([StubEngine.session(id, title: "Growth", directory: "/tmp/kuvo-tests-composer-growth", created: 1),
                     StubEngine.session(other, title: "Other", directory: "/tmp/kuvo-tests-composer-growth", created: 2)])
        engine.conversation(id, [])
        engine.conversation(other, [])
        await app.workspace.refresh()
        model = try #require(app.workspace.model(for: id))
        shown = Shown(model)
        AXElement.reading(true)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: AnyView(Root(shown: shown)
            .environment(app)
            .environment(app.workspace)
            .environment(catalog)
            .frame(width: Self.size.width, height: Self.size.height)
            .background(ProbeView(probe: probe))))
        window.orderBack(nil)
    }

    private func done() {
        for file in model.draftFiles { try? FileManager.default.removeItem(at: file) }
        Drafts.shared.remove(model.id)
        Drafts.shared.remove(other)
        engine.stop()
        window.orderOut(nil)
        window.close()
        window.contentView = nil
        AXElement.reading(false)
    }

    /// A conversation with this many turns, read, shown, and at its end.
    private func conversation(turns: Int) async throws {
        var messages: [[String: Any]] = []
        for turn in 0..<turns {
            let at = Double(turn) / 100
            messages.append(["id": run + "0\(100 + turn * 2)", "type": "user", "time": ["created": at], "text": "Question \(turn)"])
            messages.append(["id": run + "0\(101 + turn * 2)", "type": "assistant", "agent": "build", "time": ["created": at, "completed": at], "model": ["id": "m", "providerID": "p"],
                             "content": [["type": "text", "text": String(repeating: "Some words of the answer. ", count: 40)]]])
        }
        engine.conversation(id, messages)
        await model.load()
        try await until { laidOut && stack?.shownFrames().window.isEmpty == false && field != nil }
        await settled()
    }

    private func all<T: NSView>(_ type: T.Type, in view: NSView?) -> [T] {
        guard let view else { return [] }
        return ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { all(type, in: $0) }
    }

    private var stack: RowStackView? { all(RowStackView.self, in: window.contentView).first }
    private var scroll: NSScrollView? { stack?.enclosingScrollView }
    private var clip: NSClipView? { scroll?.contentView }
    private var origin: CGFloat { clip?.bounds.origin.y ?? -1 }
    private var field: MessageTextView? { all(MessageTextView.self, in: window.contentView).first { $0.accessibilityIdentifier() == "composer" } }

    /// Lays the window out and looks again on the main queue's next turn, which `until` can't
    /// otherwise see.
    private var laidOut: Bool {
        window.contentView?.layoutSubtreeIfNeeded()
        DispatchQueue.main.async { TestPulse.beat() }
        return true
    }

    /// An animation started now, the composer's spring, has ended.
    private func settled() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            // Once it has quite gone, not only mostly there: a spring's last of it moves things too.
            withAnimation(.ui, completionCriteria: .removed) { probe.isOn.toggle() } completion: { done.resume() }
        }
        window.contentView?.layoutSubtreeIfNeeded()
    }

    /// Down the window from its top.
    private func down(_ inWindow: NSRect) -> NSRect {
        NSRect(x: inWindow.minX, y: window.contentLayoutRect.height - inWindow.maxY, width: inWindow.width, height: inWindow.height)
    }

    /// How far down the window the last message ends.
    private var lastMessageBottom: CGFloat { stack?.shownFrames().window.values.map(\.maxY).max() ?? .infinity }

    /// How far down the window the composer starts: the highest of what it draws (its fields, the
    /// quotes over them), as VoiceOver and the window find them.
    private var composerTop: CGFloat {
        window.contentView?.layoutSubtreeIfNeeded()
        let fields = all(MessageTextView.self, in: window.contentView).map { down($0.convert($0.bounds, to: nil)).minY }
        let quotes = AXElement.all(in: window.contentView).filter { $0.label == "Remove All" || $0.label == "Don’t Reply to This" }
            .map { down(window.convertFromScreen($0.frame)).minY }
        return (fields + quotes).min() ?? .infinity
    }

    /// What's left between the last message and what's over it.
    private var roomUnderLastMessage: CGFloat {
        window.contentLayoutRect.height - (scroll?.contentInsets.bottom ?? 0) - lastMessageBottom
    }

    /// Scrolled off the end, the way back to it shows.
    private var isOffTheEnd: Bool { labels.contains("Scroll to the End") }

    private var labels: [String] {
        window.contentView?.layoutSubtreeIfNeeded()
        DispatchQueue.main.async { TestPulse.beat() }
        return AXElement.all(in: window.contentView).compactMap(\.label)
    }

    /// Scrolled with a trackpad: up by this much, or down when it's negative. (To the scroll view
    /// itself: the window finds nothing under events off screen.)
    private func yourScroll(by delta: CGFloat) async throws {
        try send(0, .began)
        await settled()
        try send(delta, .changed)
        await settled()
        try send(0, .ended)
        await settled()
    }

    /// One of a trackpad's scroll events, up by `amount` (down, less than 0).
    private func send(_ amount: CGFloat, _ phase: CGScrollPhase) throws {
        let scroll = try #require(scroll)
        let event = try #require(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(amount), wheel2: 0, wheel3: 0))
        event.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase.rawValue))
        event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        scroll.scrollWheel(with: try #require(NSEvent(cgEvent: event)))
    }

    private func press(_ label: String) throws {
        window.contentView?.layoutSubtreeIfNeeded()
        let found = try #require(AXElement.all(in: window.contentView).first { $0.label == label }, "“\(label)” among \(labels)")
        #expect(found.press(), "“\(label)” didn't press")
    }

    /// Quoted from the conversation, the way Reply does it, once the composer has grown for it.
    private func quote(_ text: String = longQuote) async throws {
        let over = scroll?.contentInsets.bottom ?? 0
        let quotes = model.draftQuotes.count
        model.addQuote(text + " \(quotes)", how: "message")
        try await until { laidOut && (scroll?.contentInsets.bottom ?? 0) > over + 1 }
        await settled()
    }

    /// Everything that makes what's over the conversation taller, as it comes.
    enum Growth: String, CaseIterable, CustomTestStringConvertible {
        case aQuote, linesYouWrite, aFileAttached, theCommandList, somethingThatFailed, aMessageWaiting
        var testDescription: String { rawValue }
    }

    private func grow(_ growth: Growth) async throws {
        switch growth {
        case .aQuote:
            model.addQuote(Self.longQuote, how: "message")
        case .linesYouWrite:
            let field = try #require(field)
            field.insertText("one\ntwo\nthree\nfour\nfive\nsix", replacementRange: field.selectedRange())
        case .aFileAttached:
            model.draftFiles = [try #require(Attachments.write(Data("words".utf8), named: "growth-\(UUID().uuidString.prefix(8))", extension: "txt"))]
        case .theCommandList:
            let field = try #require(field)
            field.insertText("/", replacementRange: field.selectedRange())
        case .somethingThatFailed:
            model.failure = "That didn't go through, and this says why at some length so that it takes up the room it would."
        case .aMessageWaiting:
            let item: [String: Any] = ["id": run + "queued", "sessionID": id, "type": "user", "delivery": "queue", "payload": ["text": "Then make the app icon"]]
            engine.on("GET", "/api/session/\(id)/inbox", json: ["data": [item]])
            await model.load()
        }
    }

    private func shrink(_ growth: Growth) async throws {
        switch growth {
        case .aQuote:
            withAnimation(.ui) { model.draftQuotes = [] }
        case .linesYouWrite, .theCommandList:
            let field = try #require(field)
            field.selectAll(nil)
            field.deleteBackward(nil)
        case .aFileAttached:
            for file in model.draftFiles { try? FileManager.default.removeItem(at: file) }
            model.draftFiles = []
        case .somethingThatFailed:
            model.failure = nil
        case .aMessageWaiting:
            engine.on("GET", "/api/session/\(id)/inbox") { _ in StubWeb.json(["data": [[String: Any]]()]) }
            await model.load()
        }
    }

    private var over: CGFloat { scroll?.contentInsets.bottom ?? 0 }

    /// Taller by more than a nudge, and finished growing.
    private func grown(_ growth: Growth) async throws -> CGFloat {
        let before = over
        try await grow(growth)
        try await until { laidOut && over > before + 10 }
        await settled()
        return over - before
    }

    private func shrunk(_ growth: Growth, to height: CGFloat) async throws {
        try await shrink(growth)
        try await until { laidOut && abs(over - height) < 2 }
        await settled()
    }

    // MARK: Following the end

    /// Each way it grows, at the end: the last message stays over it, as far as it was, and comes
    /// back with it.
    @Test(arguments: Growth.allCases) func growingAtTheEndPushesTheLastMessageUp(_ growth: Growth) async throws {
        defer { done() }
        try await conversation(turns: 14)
        let room = roomUnderLastMessage
        let height = over
        let grew = try await grown(growth)
        #expect(grew > 10)
        #expect(abs(roomUnderLastMessage - room) < 1.5, "room \(roomUnderLastMessage), was \(room)")
        try await shrunk(growth, to: height)
        #expect(abs(roomUnderLastMessage - room) < 1.5, "gone: room \(roomUnderLastMessage), was \(room)")
    }

    /// Each way it grows, further up: what was just over it is still just over it, and it's back
    /// where it was after.
    @Test(arguments: Growth.allCases) func growingFurtherUpPushesWhatYouRead(_ growth: Growth) async throws {
        defer { done() }
        try await conversation(turns: 14)
        try await yourScroll(by: 700)
        try await until { isOffTheEnd }
        let place = origin
        let height = over
        let grew = try await grown(growth)
        #expect(abs(origin - place - grew) < 1.5, "the composer grew by \(grew); the view moved from \(place) to \(origin)")
        #expect(isOffTheEnd, "still reading")
        try await shrunk(growth, to: height)
        #expect(abs(origin - place) < 1.5, "back: from \(place) to \(origin)")
    }

    @Test func aQuoteAddedAtTheEndKeepsTheLastMessageOverTheComposer() async throws {
        defer { done() }
        try await conversation(turns: 14)
        #expect(!isOffTheEnd)
        let room = roomUnderLastMessage
        try await quote()
        #expect(lastMessageBottom <= composerTop, "the last message ends at \(lastMessageBottom), the composer starts at \(composerTop)")
        #expect(abs(roomUnderLastMessage - room) < 1.5, "room \(roomUnderLastMessage), was \(room)")

        // Removed: as it was, nothing left looking wrong.
        try press("Don’t Reply to This")
        try await until { laidOut && model.draftQuotes.isEmpty }
        await settled()
        #expect(abs(roomUnderLastMessage - room) < 1.5, "room \(roomUnderLastMessage), was \(room)")
        #expect(!isOffTheEnd)
    }

    /// The conversation moves with the composer as it animates (a quote going, here), each frame,
    /// rather than in one jump before or after it: what's between them stays the same all the way.
    /// Seen as each pass of the main run loop leaves it, which is what's drawn.
    @Test func theConversationGoesWithTheComposerAllTheWay() async throws {
        defer { done() }
        try await conversation(turns: 14)
        try await quote()
        let scroll = try #require(scroll)
        let clip = try #require(clip)
        let height = try #require(scroll.documentView).frame.height
        var steps: [(origin: CGFloat, gap: CGFloat)] = []
        let observer = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { _, _ in
            MainActor.assumeIsolated {
                if steps.last?.origin != clip.bounds.origin.y {
                    steps.append((clip.bounds.origin.y, clip.bounds.maxY - scroll.contentInsets.bottom - height))
                }
            }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        defer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
        try press("Don’t Reply to This")
        try await until { laidOut && model.draftQuotes.isEmpty }
        await settled()
        #expect(steps.count >= 4, "in \(steps.count) steps: \(steps)")
        #expect(steps.allSatisfy { abs($0.gap) < 2 }, "apart along the way: \(steps)")
    }

    /// Up to the list's limit, then taken away one by one, and all at once.
    @Test func severalQuotesKeepTheLastMessageOverTheComposerAsTheyComeAndGo() async throws {
        defer { done() }
        try await conversation(turns: 14)
        let room = roomUnderLastMessage
        for number in 1...2 {
            try await quote("Quote \(number): " + Self.longQuote)
            #expect(lastMessageBottom <= composerTop, "with \(number): the last message ends at \(lastMessageBottom), the composer starts at \(composerTop)")
        }
        // Past the list's limit it scrolls, and the composer stays as tall.
        for number in 3...5 {
            model.addQuote("Quote \(number): " + Self.longQuote, how: "message")
        }
        try await until { laidOut && labels.contains("Remove All") && model.draftQuotes.count == 5 }
        await settled()
        #expect(abs(roomUnderLastMessage - room) < 1.5, "at the limit: room \(roomUnderLastMessage), was \(room)")

        while model.draftQuotes.count > 2 {
            let count = model.draftQuotes.count
            try press("Don’t Reply to This")
            try await until { laidOut && model.draftQuotes.count == count - 1 }
            await settled()
            #expect(abs(roomUnderLastMessage - room) < 1.5, "with \(count - 1): room \(roomUnderLastMessage), was \(room)")
        }
        try press("Remove All")
        try await until { laidOut && model.draftQuotes.isEmpty }
        await settled()
        #expect(abs(roomUnderLastMessage - room) < 1.5, "all removed: room \(roomUnderLastMessage), was \(room)")
    }

    /// A conversation with room to spare: it scrolls only once the composer needs that, and it's
    /// back where it was after.
    @Test func aConversationThatFitsMakesRoomOnlyAsItHasTo() async throws {
        defer { done() }
        try await conversation(turns: 1)
        let start = origin
        let bottom = lastMessageBottom
        for number in 1...4 {
            model.addQuote("Quote \(number): " + Self.longQuote, how: "message")
        }
        try await until { laidOut && labels.contains("Remove All") && model.draftQuotes.count == 4 }
        await settled()
        #expect(origin > start, "it scrolled, the composer being taller than what was left")
        #expect(lastMessageBottom <= composerTop, "the last message ends at \(lastMessageBottom), the composer starts at \(composerTop)")
        try press("Remove All")
        try await until { laidOut && model.draftQuotes.isEmpty }
        await settled()
        #expect(abs(origin - start) < 1, "at \(origin), was \(start)")
        #expect(abs(lastMessageBottom - bottom) < 1, "ends at \(lastMessageBottom), was \(bottom)")
    }

    // MARK: Reading further up

    /// Each way it grows, with the view at the very top, where there's nothing above it: what's
    /// under the composer still moves up from under it, and it's back at the very top after.
    @Test(arguments: Growth.allCases) func growingAtTheVeryTopPushesAndComesBackExactly(_ growth: Growth) async throws {
        defer { done() }
        try await conversation(turns: 14)
        let scroll = try #require(scroll)
        let top = -scroll.contentInsets.top
        for _ in 0..<40 where origin > top + 0.5 {
            try await yourScroll(by: 3_000)
        }
        try #require(abs(origin - top) <= 0.5, "at the top: \(origin), its top \(top)")
        let height = over
        let grew = try await grown(growth)
        #expect(abs(origin - top - grew) < 1.5, "the composer grew by \(grew); the view moved from \(top) to \(origin)")
        try await shrunk(growth, to: height)
        #expect(abs(origin - top) <= 0.5, "back: from \(top) to \(origin)")
    }

    /// Each way it grows, in a conversation too short to scroll, or that only just does: nothing
    /// under it, and exactly as it was after.
    @Test(arguments: Growth.allCases, [1, 3]) func growingOverAShortConversationHidesNothing(_ growth: Growth, turns: Int) async throws {
        defer { done() }
        try await conversation(turns: turns)
        let place = origin
        let bottom = lastMessageBottom
        let height = over
        _ = try await grown(growth)
        #expect(roomUnderLastMessage >= 0, "the last message ends \(-roomUnderLastMessage) under what's over it")
        #expect(!isOffTheEnd)
        try await shrunk(growth, to: height)
        #expect(abs(origin - place) <= 0.5, "back: from \(place) to \(origin)")
        #expect(abs(lastMessageBottom - bottom) <= 0.5, "back: from \(bottom) to \(lastMessageBottom)")
    }

    /// What the composer pushed up from further up isn't taken back to the end, and from there,
    /// all the way down, the end still comes out from over it.
    @Test func theEndIsStillInReachAfterAPushFurtherUp() async throws {
        defer { done() }
        try await conversation(turns: 14)
        try await yourScroll(by: 700)
        try await until { isOffTheEnd }
        try await quote()
        try await yourScroll(by: -2_000)
        try await until { !isOffTheEnd }
        #expect(lastMessageBottom <= composerTop, "the last message ends at \(lastMessageBottom), the composer starts at \(composerTop)")
    }

    /// Read at the very top under a tall composer (two quotes), then another conversation with an
    /// empty one and back: as you left it. (Kept out of sight, the conversation shares the
    /// composer's room; pushed then, the top stopped it going one way and not the other.)
    @Test func aConversationYouLeaveAndComeBackToIsAsYouLeftIt() async throws {
        defer { done() }
        try await conversation(turns: 14)
        for number in 1...2 { try await quote("Quote \(number): " + Self.longQuote) }
        let scroll = try #require(scroll)
        let clip = try #require(clip)
        let top = -scroll.contentInsets.top
        for _ in 0..<40 where origin > top + 0.5 {
            try await yourScroll(by: 3_000)
        }
        try #require(abs(origin - top) <= 0.5, "at the top: \(origin), its top \(top)")
        shown.model = try #require(app.workspace.model(for: other))
        try await until { laidOut && !labels.contains("Don’t Reply to This") }
        await settled()
        shown.model = model
        try await until { laidOut && labels.contains("Don’t Reply to This") }
        await settled()
        #expect(abs(clip.bounds.origin.y - top) <= 0.5, "back: at \(clip.bounds.origin.y), left at the top \(top)")
    }

    /// Right at the end, not following it (as Find leaves it on the last message): the last
    /// message stays over the composer as it grows, and as it shrinks again.
    @Test func rightAtTheEndWithoutFollowingTheLastMessageStaysOverTheComposer() async throws {
        defer { done() }
        try await conversation(turns: 14)
        let room = roomUnderLastMessage
        let height = over
        try #require(ScrollAnchor.shownAnchor).stopFollowing()
        _ = try await grown(.linesYouWrite)
        #expect(abs(roomUnderLastMessage - room) < 1.5, "grown: room \(roomUnderLastMessage), was \(room)")
        try await shrunk(.linesYouWrite, to: height)
        #expect(abs(roomUnderLastMessage - room) < 1.5, "shrunk: room \(roomUnderLastMessage), was \(room)")
    }

    /// What comes in while you scroll at the end (down there, a bounce) takes the end further, not
    /// you away from it: still following, and at the end once you let go.
    @Test func whatComesInUnderYourScrollAtTheEndIsStillFollowed() async throws {
        defer { done() }
        try await conversation(turns: 14)
        let room = roomUnderLastMessage
        try send(0, .began)
        await settled()
        try send(-30, .changed)
        await settled()
        // Two more turns, a screen and more, come in meanwhile.
        try await conversation(turns: 16)
        try send(0, .ended)
        await settled()
        try await until { laidOut && abs(roomUnderLastMessage - room) < 1.5 }
        #expect(!isOffTheEnd, "it still follows the end")
    }

    /// A little way up is up: not taken for the end, which the composer's height once counted
    /// towards, so what grows next pushes it by as much, and doesn't carry it to the end.
    @Test func aLittleWayUpIsNotTheEnd() async throws {
        defer { done() }
        try await conversation(turns: 14)
        let end = origin
        try await yourScroll(by: 100)
        #expect(origin < end - 60, "scrolled from \(end) to \(origin)")
        try await until { isOffTheEnd }
        let place = origin
        let height = over
        try await quote()
        #expect(abs(origin - place - (over - height)) < 1.5, "the composer grew by \(over - height); the view moved from \(place) to \(origin)")
    }

    /// With a tall composer, the end under it isn't in view, however close: you scrolled off it,
    /// and there's a way back.
    @Test func scrolledUpUnderATallComposerTheEndIsOutOfView() async throws {
        defer { done() }
        try await conversation(turns: 14)
        for number in 1...2 { try await quote("Quote \(number): " + Self.longQuote) }
        try await yourScroll(by: 250)
        try await until { isOffTheEnd }
        try press("Scroll to the End")
        try await until { !isOffTheEnd }
        await settled()
        #expect(lastMessageBottom <= composerTop, "the last message ends at \(lastMessageBottom), the composer starts at \(composerTop)")
    }

    /// A line of the conversation's text at about this far down the window, and where it is in its
    /// text view.
    private func line(near y: CGFloat, within range: ClosedRange<CGFloat>) -> (text: ReplyTextView, line: NSRect)? {
        let lines = all(ReplyTextView.self, in: stack).flatMap { text -> [(ReplyTextView, NSRect, CGFloat)] in
            guard let layout = text.layoutManager else { return [] }
            layout.ensureLayout(for: text.textContainer!)
            var found: [(ReplyTextView, NSRect, CGFloat)] = []
            layout.enumerateLineFragments(forGlyphRange: layout.glyphRange(for: text.textContainer!)) { rect, _, _, _, _ in
                let place = rect.offsetBy(dx: text.textContainerOrigin.x, dy: text.textContainerOrigin.y)
                found.append((text, place, down(text.convert(place, to: nil)).midY))
            }
            return found
        }
        return lines.filter { range.contains($0.2) }.min { abs($0.2 - y) < abs($1.2 - y) }.map { ($0.0, $0.1) }
    }

    /// Selects the line with a drag, as a hand would, and takes Add to Chat from its menu.
    private func selectAndAddToChat(_ line: NSRect, in text: ReplyTextView) throws {
        func event(_ type: NSEvent.EventType, at point: NSPoint) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                               windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        let from = text.convert(NSPoint(x: line.minX + 10, y: line.midY), to: nil), to = text.convert(NSPoint(x: line.minX + 200, y: line.midY), to: nil)
        for step in 1...6 {
            let t = CGFloat(step) / 6
            NSApp.postEvent(event(.leftMouseDragged, at: NSPoint(x: from.x + (to.x - from.x) * t, y: from.y)), atStart: false)
        }
        NSApp.postEvent(event(.leftMouseUp, at: to), atStart: false)
        text.mouseDown(with: event(.leftMouseDown, at: from))
        let bar = try #require(stack?.subviews.compactMap { $0 as? NSHostingView<SelectionActions> }.first, "the selection's menu shows")
        let addToChat = try #require(bar.rootView.addToChat)
        addToChat()
    }

    /// What you select and Add to Chat just over the composer stays just over it, and you can read on.
    @Test func aLineQuotedJustOverTheComposerStaysJustOverIt() async throws {
        defer { done() }
        try await conversation(turns: 14)
        try await yourScroll(by: 700)
        try await until { isOffTheEnd }
        let top = composerTop
        let lowest = try #require(line(near: top - 50, within: 40...(top - 40)))
        try await yourScroll(by: top - 50 - down(lowest.text.convert(lowest.line, to: nil)).midY)
        let found = try #require(line(near: top - 50, within: 40...(top - 36)))
        let height = over
        let at = down(found.text.convert(found.line, to: nil))
        try selectAndAddToChat(found.line, in: found.text)
        try await until { laidOut && over > height + 10 }
        await settled()
        let now = down(found.text.convert(found.line, to: nil))
        #expect(now.maxY <= composerTop, "the line you quoted ends at \(now.maxY), the composer starts at \(composerTop)")
        #expect(abs(at.minY - now.minY - (over - height)) < 1.5, "it moved from \(at.minY) to \(now.minY), the composer grew by \(over - height)")
    }

    // MARK: Pictures

    /// The window as it shows before and after a quote comes, at the end and reading further up,
    /// in each look, into KUVO_DRAFTS_OUT (with `KUVO_DRAFTS_TAG` before each name: before, after):
    /// not a test of behavior, it runs only when that's set.
    @Test(arguments: ["dark", "light"]) func renders(_ scheme: String) async throws {
        defer { done() }
        guard let out = ProcessInfo.processInfo.environment["KUVO_DRAFTS_OUT"].map({ URL(fileURLWithPath: $0) }) else { return }
        let tag = ProcessInfo.processInfo.environment["KUVO_DRAFTS_TAG"] ?? "now"
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        // The app's own look too, which some controls draw by.
        let look = NSApp.appearance
        defer { NSApp.appearance = look }
        window.appearance = NSAppearance(named: scheme == "dark" ? .darkAqua : .aqua)
        NSApp.appearance = window.appearance
        try await conversation(turns: 14)
        func shoot(_ name: String) async throws {
            await settled()
            let host = try #require(window.contentView)
            host.layoutSubtreeIfNeeded()
            host.display()
            let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            // Over the window's own background, which the view leaves to it, at the capture's scale.
            let cg = try #require(rep.cgImage)
            let context = try #require(CGContext(data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: 0,
                                                 space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.setFillColor(scheme == "dark" ? CGColor(gray: 0.12, alpha: 1) : CGColor(gray: 0.97, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            let png = try #require(context.makeImage().flatMap { NSBitmapImageRep(cgImage: $0).representation(using: .png, properties: [:]) })
            try png.write(to: out.appending(path: "\(tag)-\(name)-\(scheme).png"))
        }
        try await shoot("1-at-the-end")
        try await quote()
        try await shoot("2-at-the-end-quoted")
        try press("Don’t Reply to This")
        try await until { laidOut && model.draftQuotes.isEmpty }
        try await yourScroll(by: 700)
        try await shoot("3-further-up")
        try await quote()
        try await shoot("4-further-up-quoted")
    }
}
