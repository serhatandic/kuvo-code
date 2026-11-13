import AppKit
import ClientDesign
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Scrolled up to read, the conversation stays exactly where you are while a turn runs: its tool
/// calls coming in, its words streaming, a call's card growing, a subagent at work and the turn
/// ending. Only at the end does it follow. The conversation is the real one, in a window of the
/// test's own, scrolled as a trackpad scrolls it; the engine is stubbed, and its events are the
/// ones a run sends.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ScrolledUpStaysTests {
    let engine = StubEngine(port: 48_236)
    let app = AppModel()
    let catalog = Catalog()
    let model: SessionModel
    let id = "ses_scrolled_up_" + UUID().uuidString
    static let size = NSSize(width: 720, height: 620)
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: size.width, height: size.height), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    /// Its messages' ids of its own: what's opened is kept by them, for as long as the app runs.
    let run = "msg_" + UUID().uuidString.prefix(8) + "_"

    /// Something of the window's own that animates as the conversation does, to tell when that's over.
    @Observable final class Probe { var isOn = false }
    struct ProbeView: View {
        let probe: Probe
        var body: some View { Color.black.opacity(probe.isOn ? 0.02 : 0.01).frame(width: 1, height: 1) }
    }
    let probe = Probe()

    init() async throws {
        TestEnvironment.prepare()
        app.workspace.api = engine.api
        engine.list([StubEngine.session(id, title: "Scrolled up", directory: "/tmp/kuvo-tests-scrolled-up", created: 1)], running: [id])
        engine.conversation(id, [])
        await app.workspace.refresh()
        model = try #require(app.workspace.model(for: id))
        AXElement.reading(true)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: AnyView(SessionView(model: model)
            .environment(app)
            .environment(app.workspace)
            .environment(catalog)
            .frame(width: Self.size.width, height: Self.size.height)
            .background(ProbeView(probe: probe))))
        window.orderBack(nil)
    }

    private func done() {
        engine.stop()
        window.orderOut(nil)
        window.close()
        window.contentView = nil
        AXElement.reading(false)
    }

    // MARK: The window

    private func all<T: NSView>(_ type: T.Type, in view: NSView?) -> [T] {
        guard let view else { return [] }
        return ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { all(type, in: $0) }
    }

    private var stack: RowStackView? { all(RowStackView.self, in: window.contentView).first }
    private var scroll: NSScrollView? { stack?.enclosingScrollView }
    private var clip: NSClipView? { scroll?.contentView }
    private var origin: CGFloat { clip?.bounds.origin.y ?? -1 }

    /// Lays the window out and looks again on the main queue's next turn, which `until` can't
    /// otherwise see.
    private var laidOut: Bool {
        window.contentView?.layoutSubtreeIfNeeded()
        DispatchQueue.main.async { TestPulse.beat() }
        return true
    }

    /// An animation started now, the conversation's spring, has quite ended. Started once the
    /// window has run what's pending, in an update of its own: started with what the test had just
    /// done, in the same update (several answers above the view grown at once, read again),
    /// SwiftUI never said it had ended, and the test waited for good.
    private func settled() async {
        window.contentView?.layoutSubtreeIfNeeded()
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            withAnimation(.ui, completionCriteria: .removed) { probe.isOn.toggle() } completion: { done.resume() }
        }
        window.contentView?.layoutSubtreeIfNeeded()
    }

    private var labels: [String] {
        window.contentView?.layoutSubtreeIfNeeded()
        DispatchQueue.main.async { TestPulse.beat() }
        return AXElement.all(in: window.contentView).compactMap(\.label)
    }

    /// Scrolled off the end, the way back to it shows.
    private var isOffTheEnd: Bool { labels.contains("Scroll to the End") }

    /// The view's bottom is at the conversation's end, over what's over it.
    private var atTheEnd: Bool {
        guard let scroll, let clip, let height = clip.documentView?.frame.height else { return false }
        return abs(height + scroll.contentInsets.bottom - clip.bounds.maxY) < 2
    }

    /// Scrolled with a trackpad, a few frames at a time as a hand does: up by this much, or down
    /// when it's negative. (To the scroll view itself: the window finds nothing under events off
    /// screen.)
    private func yourScroll(by delta: CGFloat, frames: Int = 4) async throws {
        try send(0, .began)
        await settled()
        for _ in 0..<frames {
            try send(delta / CGFloat(frames), .changed)
            await settled()
        }
        try send(0, .ended)
        await settled()
    }

    private func send(_ amount: CGFloat, _ phase: CGScrollPhase) throws {
        let scroll = try #require(scroll)
        let event = try #require(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(amount), wheel2: 0, wheel3: 0))
        event.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase.rawValue))
        event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        scroll.scrollWheel(with: try #require(NSEvent(cgEvent: event)))
    }

    /// One move up, as a single event: a trackpad's that's over in one frame, or a mouse wheel's
    /// notch (lines, with no phases, as a wheel sends them).
    enum SingleMove: String, CaseIterable, CustomTestStringConvertible {
        case aFlick, aWheelsNotch
        var testDescription: String { rawValue }
    }

    private func move(_ move: SingleMove, up distance: CGFloat) async throws {
        switch move {
        case .aFlick:
            try await yourScroll(by: distance, frames: 1)
        case .aWheelsNotch:
            let scroll = try #require(scroll)
            let lines = Int32((distance / max(1, scroll.verticalLineScroll)).rounded())
            let event = try #require(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: lines, wheel2: 0, wheel3: 0))
            scroll.scrollWheel(with: try #require(NSEvent(cgEvent: event)))
            await settled()
        }
    }

    /// Where the row you read was down the window as each pass of the main run loop left it
    /// (what's drawn), from now until `stop`; nil, out of view.
    private final class Watch {
        var places: [CGFloat?] = []
        var observer: CFRunLoopObserver?
        func stop() {
            if let observer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
            observer = nil
        }
    }

    private func watch(_ row: String) throws -> Watch {
        let stack = try #require(stack)
        let watch = Watch()
        watch.places = [stack.shownFrames().window[row]?.minY]
        let observer = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { [weak watch, weak stack] _, _ in
            MainActor.assumeIsolated {
                guard let watch, let stack else { return }
                let now = stack.shownFrames().window[row]?.minY
                if watch.places.last != now { watch.places.append(now) }
            }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        watch.observer = observer
        return watch
    }

    // MARK: The conversation and its run

    private func answer(_ turn: Int, words: Int = 40) -> [[String: Any]] {
        let at = Double(turn) / 100
        return [["id": run + "0\(100 + turn * 2)", "type": "user", "time": ["created": at], "text": "Question \(turn)"],
                ["id": run + "0\(101 + turn * 2)", "type": "assistant", "agent": "build", "time": ["created": at, "completed": at], "model": ["id": "m", "providerID": "p"],
                 "content": [["type": "text", "text": "Answer \(turn). " + String(repeating: "Some words of the answer. ", count: words)]]]]
    }

    /// The run's message for its step `number` (after the question's, and every earlier turn's).
    private func message(_ number: Int) -> String { run + "\(number + 10)" }

    private func step(_ number: Int) -> [String: Any] {
        ["id": message(number), "type": "assistant", "agent": "build", "time": ["created": Double(number + 1), "completed": Double(number + 1)], "model": ["id": "m", "providerID": "p"],
         "content": [["type": "tool", "id": "call_\(number)", "name": "shell", "executed": true,
                      "state": ["status": "completed", "input": ["command": "echo step\(number)"], "content": [["type": "text", "text": "ok"]]]]]]
    }

    /// What the run said between its steps, at length.
    private func said(_ number: Int) -> [String: Any] {
        ["id": message(number), "type": "assistant", "agent": "build", "time": ["created": Double(number + 1), "completed": Double(number + 1)], "model": ["id": "m", "providerID": "p"],
         "content": [["type": "text", "text": (1...30).map { "Finding \($0): " + String(repeating: "what it read so far, ", count: 8) }.joined(separator: "\n\n")]]]
    }

    /// A conversation of `turns` answered turns, then a question the agent is at work on, with the
    /// run's messages so far: read, shown, and at its end.
    private func conversation(turns: Int = 14, words: Int = 40, run messages: [[String: Any]]? = nil) async throws {
        var all = (0..<turns).flatMap { answer($0, words: words) }
        all.append(["id": run + "0900", "type": "user", "time": ["created": 1], "text": "Look around."])
        all += messages ?? [step(1), step(2)]
        engine.conversation(id, all)
        await model.load()
        try await until { laidOut && stack?.shownFrames().window.isEmpty == false && atTheEnd }
        await settled()
    }

    /// A step's events as a run sends them (as the engine's recorded run does: OpenCodeKit's
    /// Fixtures/events.jsonl), up to its command running: it thinks, then calls a tool.
    private func starts(_ number: Int) async throws {
        let message = message(number), call = "call_\(number)"
        model.apply(try engine.event("session.step.started", session: id, ["assistantMessageID": message, "agent": "build", "model": ["id": "m", "providerID": "p"]]))
        model.apply(try engine.event("session.reasoning.started", session: id, ["assistantMessageID": message, "ordinal": 0]))
        for words in ["Let me look at step \(number) next. ", "It should say what it found, ", "and then the next one."] {
            model.apply(try engine.event("session.reasoning.delta", session: id, ["assistantMessageID": message, "ordinal": 0, "delta": words]))
            await settled()
        }
        model.apply(try engine.event("session.tool.input.started", session: id, ["assistantMessageID": message, "id": call, "name": "shell"]))
        model.apply(try engine.event("session.reasoning.ended", session: id, ["assistantMessageID": message, "ordinal": 0, "text": "Let me look at step \(number) next. It should say what it found, and then the next one."]))
        await settled()
        model.apply(try engine.event("session.tool.input.delta", session: id, ["assistantMessageID": message, "id": call, "delta": "{\"command\": \"echo step\(number)\"}"]))
        model.apply(try engine.event("session.tool.input.ended", session: id, ["assistantMessageID": message, "id": call, "text": "{\"command\": \"echo step\(number)\"}"]))
        model.apply(try engine.event("session.tool.called", session: id, ["assistantMessageID": message, "id": call, "input": ["command": "echo step\(number)"]]))
        model.apply(try engine.event("session.step.streamed", session: id, ["assistantMessageID": message]))
        model.apply(try engine.event("session.tool.progress", session: id, ["assistantMessageID": message, "id": call, "metadata": ["shellID": "sh_\(number)"]]))
    }

    private func ends(_ number: Int) throws {
        model.apply(try engine.event("session.tool.success", session: id, ["assistantMessageID": message(number), "id": "call_\(number)", "content": [["type": "text", "text": "step\(number)"]], "metadata": ["status": "completed", "exit": 0]]))
        model.apply(try engine.event("session.step.ended", session: id, ["assistantMessageID": message(number), "finish": "tool-calls"]))
    }

    /// A reply's words streaming in, a paragraph at a time.
    private func writes(_ number: Int, lines: Int) async throws {
        model.apply(try engine.event("session.step.started", session: id, ["assistantMessageID": message(number), "agent": "build", "model": ["id": "m", "providerID": "p"]]))
        model.apply(try engine.event("session.text.started", session: id, ["assistantMessageID": message(number), "ordinal": 0]))
        for line in 0..<lines {
            model.apply(try engine.event("session.text.delta", session: id, ["assistantMessageID": message(number), "ordinal": 0,
                                                                             "delta": "Line \(line) of what it found, " + String(repeating: "and more of it ", count: 6) + "\n\n"]))
            await settled()
        }
    }

    /// The run goes on from step `first`: tool calls one after another, a reply written, and the
    /// turn's end.
    private func runs(from first: Int) async throws {
        for number in first..<(first + 4) {
            try await starts(number)
            await settled()
            try ends(number)
            await settled()
        }
        try await writes(first + 4, lines: 8)
        model.apply(try engine.event("session.text.ended", session: id, ["assistantMessageID": message(first + 4), "ordinal": 0]))
        model.apply(try engine.event("session.step.ended", session: id, ["assistantMessageID": message(first + 4), "finish": "stop"]))
        model.apply(try engine.event("session.execution.succeeded", session: id))
        try await until { laidOut && !model.isRunning }
        await settled()
        await settled()
    }

    /// Up by `distance`, off the end: the row across the middle of the view then, and where it
    /// starts down the window.
    private func scrollUp(by distance: CGFloat) async throws -> (row: String, at: CGFloat) {
        try await yourScroll(by: distance)
        try await until { isOffTheEnd }
        await settled()
        window.contentView?.layoutSubtreeIfNeeded()
        let rows = try #require(stack?.shownFrames().window)
        let middle = Self.size.height / 2
        let read = try #require(rows.first { $0.value.minY <= middle && $0.value.maxY > middle }, "a row across the middle among \(rows)")
        return (read.key, read.value.minY)
    }

    /// The row you read stayed where it was down the window, in every frame drawn.
    private func stayed(_ watch: Watch, at place: CGFloat, sourceLocation: SourceLocation = #_sourceLocation) {
        watch.stop()
        #expect(watch.places.allSatisfy { $0.map { abs($0 - place) < 1 } == true }, "the row you read was at \(place), then at \(watch.places.map { $0.map { "\(Int($0))" } ?? "out of view" })", sourceLocation: sourceLocation)
    }

    // MARK: Scrolled up

    /// Further up than the run, reading an earlier answer: its tool calls coming in and ending,
    /// its words streaming and the turn ending move nothing, at any moment.
    @Test(arguments: [1_500, 300] as [CGFloat]) func aRunningTurnLeavesAnEarlierAnswerWhereItIs(_ distance: CGFloat) async throws {
        defer { done() }
        try await conversation()
        let read = try await scrollUp(by: distance)
        let watch = try watch(read.row)
        defer { watch.stop() }
        try await runs(from: 3)
        stayed(watch, at: read.at)
        #expect(isOffTheEnd, "still reading")
    }

    /// Reading what the run itself said, with its steps above: what comes in after it and the turn
    /// ending move nothing either.
    @Test func aRunningTurnLeavesWhatItSaidWhereItIs() async throws {
        defer { done() }
        try await conversation(run: [step(1), step(2), said(3), step(4)])
        let read = try await scrollUp(by: 500)
        let watch = try watch(read.row)
        defer { watch.stop() }
        try await runs(from: 5)
        stayed(watch, at: read.at)
        #expect(isOffTheEnd, "still reading")
    }

    /// A little way up, reading the latest of what it said just over the composer: that's off the
    /// end too, however tall what's over it is (it once counted toward the end, and the next tool
    /// call took you back there).
    @Test(arguments: [false, true]) func aLittleWayUpStaysToo(_ tallComposer: Bool) async throws {
        defer { done() }
        try await conversation(run: [step(1), step(2), said(3), step(4)])
        if tallComposer {
            // Two quotes over it: a few hundred points of composer.
            for number in 1...2 {
                let over = scroll?.contentInsets.bottom ?? 0
                model.addQuote("Quote \(number): " + String(repeating: "The keeper climbed the stairs at dusk and lit the great lamp. ", count: 4), how: "message")
                try await until { laidOut && (scroll?.contentInsets.bottom ?? 0) > over + 1 }
                await settled()
            }
        }
        try await yourScroll(by: 120)
        await settled()
        let rows = try #require(stack?.shownFrames().window)
        let read = try #require(rows.first { $0.value.minY <= Self.size.height / 2 && $0.value.maxY > Self.size.height / 2 })
        let watch = try watch(read.key)
        defer { watch.stop() }
        try await runs(from: 5)
        stayed(watch, at: read.value.minY)
        #expect(isOffTheEnd, "still reading")
    }

    /// Scrolled up in a single move (a mouse's wheel, a quick flick): just as still.
    @Test(arguments: SingleMove.allCases) func aSingleMoveUpIsAsStill(_ single: SingleMove) async throws {
        defer { done() }
        try await conversation(run: [step(1), step(2), said(3), step(4)])
        try await move(single, up: 500)
        try await until { isOffTheEnd }
        await settled()
        let rows = try #require(stack?.shownFrames().window)
        let read = try #require(rows.first { $0.value.minY <= Self.size.height / 2 && $0.value.maxY > Self.size.height / 2 })
        let watch = try watch(read.key)
        defer { watch.stop() }
        try await runs(from: 5)
        stayed(watch, at: read.value.minY)
    }

    /// Writing your next message while you read: the composer keeps its caret in view, and that
    /// moves nothing of the conversation as the run goes on.
    @Test func writingWhileYouReadMovesNothing() async throws {
        defer { done() }
        try await conversation(run: [step(1), step(2), said(3), step(4)])
        let field = try #require(all(MessageTextView.self, in: window.contentView).first { $0.accessibilityIdentifier() == "composer" })
        window.makeFirstResponder(field)
        field.insertText("Then look at", replacementRange: field.selectedRange())
        await settled()
        let read = try await scrollUp(by: 500)
        // More written after you scrolled up, as you read.
        field.insertText(" the tests too", replacementRange: field.selectedRange())
        await settled()
        try #require(window.firstResponder === field)
        let place = try #require(stack?.shownFrames().window[read.row]?.minY)
        let watch = try watch(read.row)
        defer { watch.stop() }
        try await runs(from: 5)
        stayed(watch, at: place)
        #expect(isOffTheEnd, "still reading")
    }

    /// Up in a single move (a wheel's notch, a flick), then the answers above the view get taller
    /// (read again, with more of what they said): what you read stays where it is. (The rows went on
    /// taking it as following the end, as nothing told them since: what was above moved it.) Short
    /// answers too, several of them above the view growing at once.
    @Test(arguments: SingleMove.allCases, [40, 20]) func rowsAboveGrowingAfterASingleMoveUpLeaveWhatYouRead(_ single: SingleMove, words: Int) async throws {
        defer { done() }
        try await conversation(words: words)
        try await move(single, up: 300)
        try await until { isOffTheEnd }
        await settled()
        let rows = try #require(stack?.shownFrames().window)
        let read = try #require(rows.first { $0.value.minY <= Self.size.height / 2 && $0.value.maxY > Self.size.height / 2 })
        let watch = try watch(read.key)
        defer { watch.stop() }
        // The answers wholly above the view, longer (made, not yet scrolled to: within a screen).
        let above = Set(rows.filter { $0.value.maxY < 0 }.map { String($0.key.prefix { $0 != "#" }) })
        let grown = Set((0..<14).filter { above.contains(run + "0\(101 + $0 * 2)") })
        try #require(grown.count > (words < 40 ? 1 : 0), "answers above the view among \(rows)")
        var longer = (0..<14).flatMap { turn in answer(turn, words: grown.contains(turn) ? words + 30 : words) }
        longer.append(["id": run + "0900", "type": "user", "time": ["created": 1], "text": "Look around."])
        longer += [step(1), step(2)]
        engine.conversation(id, longer)
        await model.load()
        await settled()
        await settled()
        stayed(watch, at: read.value.minY)
    }

    /// At the end, the same run is followed: once it's over, the view is at its end and still
    /// following it.
    @Test func atTheEndTheRunIsFollowed() async throws {
        defer { done() }
        try await conversation()
        try await runs(from: 3)
        try await until { laidOut && atTheEnd }
        #expect(!isOffTheEnd)
        #expect(stack?.scrollAnchor?.isFollowingEnd == true, "still following")
    }

    /// Scrolled up to its top, what you send takes you to its end once: in every frame drawn its
    /// end comes nearer, never further, and it stays there, following it (the phone's #403).
    @Test func sendingFromTheTopGoesToTheEndOnce() async throws {
        let box = SessionsBox()
        defer {
            box.stop()
            done()
        }
        try await conversation(turns: 30)
        try await box.start(engine, for: app.workspace)
        model.apply(try engine.event("session.execution.succeeded", session: id))
        try await until { laidOut && !model.isRunning }
        await settled()
        try await yourScroll(by: 200_000)
        try await until { laidOut && isOffTheEnd && origin < 1 - (scroll?.contentInsets.top ?? 0) }
        await settled()

        // How far the end is below what shows, as each pass of the main run loop left it.
        final class Gaps { var all: [Int] = [] }
        let gaps = Gaps()
        let gap = { [weak scroll, weak clip] () -> Int? in
            guard let scroll, let clip, let height = clip.documentView?.frame.height else { return nil }
            return Int((height + scroll.contentInsets.bottom - clip.bounds.maxY).rounded())
        }
        gaps.all = gap().map { [$0] } ?? []
        let observer = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { _, _ in
            MainActor.assumeIsolated { if let now = gap(), gaps.all.last != now { gaps.all.append(now) } }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        defer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
        model.draftText = "Looks good.\nOne more thing:\nkeep the toggle."
        model.submitDraft(for: nil, queue: false)
        try await until { laidOut && atTheEnd && !isOffTheEnd }
        await settled()
        await settled()
        CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes)

        var nearest = gaps.all.first ?? 0
        var back: [String] = []
        for gap in gaps.all {
            if gap > nearest + 24 { back.append("\(gap) after \(nearest)") }
            nearest = min(nearest, gap)
        }
        #expect(back.isEmpty, "on the way to the end it went back up: \(back), of \(gaps.all)")
        #expect(atTheEnd, "it didn't stay at the end: \(gaps.all)")
        #expect(stack?.scrollAnchor?.isFollowingEnd == true, "it doesn't follow the end")
    }
}

/// A row above what you read growing by itself (a picture or a diagram drawn at last), after a
/// mouse wheel's notch took you off the end: it grows up out of view, and what you read stays.
/// The real conversation's scroll, with plain rows.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct RowAboveGrowingAfterAWheelTests {
    @Observable final class Heights { var grown: Int? }
    /// Something of the window's own that animates, to tell when frames have been drawn.
    @Observable final class Probe { var isOn = false }
    struct ProbeView: View {
        let probe: Probe
        var body: some View { Color.black.opacity(probe.isOn ? 0.02 : 0.01).frame(width: 1, height: 1) }
    }
    struct Item: Hashable { let id: Int }
    struct Grows: View {
        let id: Int
        let heights: Heights
        var body: some View { Color.clear.frame(height: heights.grown == id ? 300 : 200) }
    }

    @Test func whatYouReadStays() async throws {
        TestEnvironment.prepare()
        let items = (0..<30).map(Item.init)
        let heights = Heights()
        let probe = Probe()
        let scroller = ConversationScroller()
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 640, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: ConversationScroll(scroller: scroller, change: 0, quote: { _ in }) {
            RowStack(items: items, id: { "\($0.id)" }, same: ==, estimate: { _ in 200 }) { item, _ in Grows(id: item.id, heights: heights) }
        }
        .frame(width: 640, height: 500)
        .background(ProbeView(probe: probe)))
        window.orderBack(nil)
        defer { window.orderOut(nil); window.close() }

        func stack() -> RowStackView? {
            func find(_ view: NSView?) -> RowStackView? {
                guard let view else { return nil }
                return (view as? RowStackView) ?? view.subviews.lazy.compactMap(find).first
            }
            return find(window.contentView)
        }
        /// The main queue's next turns, as many as it takes the conversation to lay out.
        func turns(_ count: Int) async {
            for _ in 0..<count {
                window.contentView?.layoutSubtreeIfNeeded()
                await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in DispatchQueue.main.async { done.resume() } }
            }
        }
        /// An animation started now has quite ended: frames have been drawn, and told of.
        func settled() async {
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                withAnimation(.ui, completionCriteria: .removed) { probe.isOn.toggle() } completion: { done.resume() }
            }
            window.contentView?.layoutSubtreeIfNeeded()
        }
        var waited = 0
        while (stack()?.frame.height ?? 0) < 5000 || stack()?.shownFrames().window.isEmpty != false, waited < 400 {
            await turns(1)
            waited += 1
        }
        let scroll = try #require(stack()?.enclosingScrollView)
        await settled()
        // A notch of the wheel, up a screen and a half: lines, no phases, as a wheel sends them.
        let event = try #require(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(700 / max(1, scroll.verticalLineScroll)), wheel2: 0, wheel3: 0))
        scroll.scrollWheel(with: try #require(NSEvent(cgEvent: event)))
        await settled()
        try #require(!scroller.followsEnd, "the notch took it off the end")
        let rows = try #require(stack()?.shownFrames().window)
        let read = try #require(rows.filter { $0.value.minY >= 0 }.min { $0.value.minY < $1.value.minY }, "a row in view among \(rows)")
        // The row just above it, wholly out of view, drawn taller.
        let above = try #require(Int(read.key)).advanced(by: -2)
        try #require(rows["\(above)"].map { $0.maxY < 0 } == true, "row \(above) is above the view: \(rows)")
        heights.grown = above
        await settled()
        await settled()
        let now = stack()?.shownFrames().window[read.key]?.minY
        #expect(now.map { abs($0 - read.value.minY) < 1 } == true, "the row you read moved from \(read.value.minY) to \(now.map { "\($0)" } ?? "out of view")")
    }
}
