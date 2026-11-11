import AppKit
import ClientDesign
import SwiftUI
import Testing
@testable import KuvoCode

/// The card you work in looks it (crisp, the others a warm ivory): the one you last clicked or
/// typed in. A click on a reply's words makes the conversation that card, as a click anywhere in
/// it does; a click on the sidebar doesn't make it the one (it picks what you work in elsewhere),
/// but the keyboard moving into a card does; with Settings open, clicks there leave the cards as
/// they were. A session picked
/// in the sidebar is the press, then the store call its row's button makes: SwiftUI's buttons and
/// gestures don't take queued clicks in a window that isn't key, and this one never is, so it
/// can't take your keyboard. The window is the app's own (`MainView`), with its
/// sidebar and conversation, in a window of the test's own; the engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct WindowFocusTests {
    let engine = StubEngine(port: 47914)
    let app = AppModel()
    /// A window of the test's own that never becomes key, so a click in it can't bring the test
    /// copy forward and take your keyboard.
    final class TestWindow: NSWindow {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    let window = TestWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 1700, height: 700), styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    /// Tells `until` each time the keyboard moves in the window.
    private let watch: NSKeyValueObservation
    let folder = "/tmp/kuvo-tests-window-focus"
    let lamp = "ses_focus_lamp"
    let harbor = "ses_focus_harbor"

    init() async throws {
        TestEnvironment.prepare()
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        app.workspace.api = engine.api
        engine.list([StubEngine.session(lamp, title: "The lamp", directory: folder, created: 2),
                     StubEngine.session(harbor, title: "The harbor", directory: folder, created: 1)])
        for (id, words) in [(lamp, "The keeper climbed the stairs at dusk and lit the great lamp for the ships."),
                            (harbor, "Out at sea the captain saw the light and turned toward the harbor.")] {
            engine.conversation(id, [
                ["id": id + "_1", "type": "user", "time": ["created": 1], "text": "Tell me about it"],
                ["id": id + "_2", "type": "assistant", "agent": "build", "time": ["created": 2, "completed": 2.5],
                 "model": ["id": "glm", "providerID": "opencode"], "content": [["type": "text", "text": words]]],
            ])
        }
        await app.workspace.refresh()
        app.tabs.open(.session(lamp))
        let view = MainView()
            .environment(app)
            .environment(app.catalog)
            .environment(app.workspace)
            .environment(app.bots)
            .environment(app.chats)
            .environment(Updates())
            .frame(width: 1700, height: 700)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        watch = window.observe(\.firstResponder) { _, _ in TestPulse.beat() }
        window.orderBack(nil)
        try await until { reply != nil }
        // The composer takes the keyboard as the window opens, a moment after: settled first, so
        // it doesn't land in the middle of a test.
        try await until { (window.firstResponder as? MessageTextView)?.accessibilityIdentifier() == "composer" }
        let settled = TestClick()
        NSApp.postEvent(settled.marker(in: window), atStart: false)
        try await until { settled.isHandled }
    }

    private func done() {
        app.utilities.closeAll()
        try? FileManager.default.removeItem(atPath: folder)
        engine.stop()
        window.orderOut(nil)
        window.close()
        // The conversation's own tasks (it follows the vault's asks) end with its views, not with the process.
        window.contentView = nil
    }

    private func all<T: NSView>(_ type: T.Type, in view: NSView?) -> [T] {
        guard let view else { return [] }
        return ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { all(type, in: $0) }
    }

    /// The reply's words in the conversation, once they're laid out.
    private var reply: ReplyTextView? {
        // Laid out as the window draws, which `until` can't see: each look lays it out first.
        window.contentView?.layoutSubtreeIfNeeded()
        TestPulse.beat()
        return all(ReplyTextView.self, in: window.contentView).first { $0.string.contains("great lamp") }
    }

    /// A click at `point` in the window, queued as a hand's would be: the app takes it from there,
    /// its monitors first.
    private func click(at point: NSPoint) {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            NSApp.postEvent(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!, atStart: false)
        }
    }

    @Test func aClickOnARepliesWordsMakesTheConversationTheOneYouWorkIn() async throws {
        defer { done() }
        let words = try #require(reply)
        // Working in the sidebar.
        app.tabs.focus = .sessions

        let line = words.layoutManager!.lineFragmentRect(forGlyphAt: 0, effectiveRange: nil)
        click(at: words.convert(NSPoint(x: 30, y: line.midY), to: nil))
        try await until { app.tabs.focus == .conversation }
    }

    /// The keyboard going into a card (Tab, a shortcut, a field that takes it) makes it the card
    /// you work in, as a click does: here the sidebar's search field.
    @Test func theKeyboardMovingIntoACardMakesItTheOneYouWorkIn() async throws {
        defer { done() }
        _ = try #require(reply)
        app.tabs.focus = .conversation
        let search = try #require(all(NSTextField.self, in: window.contentView).first { field in
            field.isEditable && field.convert(field.bounds, to: nil).midX < 300
        }, "the sidebar's search field")
        window.makeFirstResponder(search)
        try await until { app.tabs.focus == .sessions }
    }

    /// A session picked in the sidebar: the press on its row isn't working in the sidebar, so the
    /// conversation stays the card you work in, its composer with the keyboard, all through the
    /// click (the user's report: it looked as if you'd clicked the sidebar, for a moment). Then the
    /// row's button opens the session (the store call it makes as the click ends: SwiftUI's buttons
    /// don't take queued clicks in a window that isn't key), and its composer has the keyboard, even
    /// from the sidebar's search, and even for the session already in view.
    @Test func aSessionPickedInTheSidebarLeavesYouInItsConversation() async throws {
        defer { done() }
        _ = try #require(reply)
        // The press and its release in the sidebar, as on a row.
        click(at: NSPoint(x: 60, y: 200))
        try await drain()
        #expect(app.tabs.focus == .conversation, "a press on the sidebar leaves the conversation the card you work in")
        #expect(composerHasKeys, "and its composer the keyboard")

        app.tabs.choose(.session(harbor))
        try await until { app.tabs.selection == .session(harbor) && composerHasKeys }
        // Its composer's own asks for the keyboard as it came in, all answered.
        try await drain()
        #expect(app.tabs.focus == .conversation)
        #expect(composerHasKeys)

        // From the sidebar's search, the session in view picked again.
        window.makeFirstResponder(try sidebarSearch())
        #expect(window.firstResponder is NSTextView, "the search has the keyboard")
        try await until { app.tabs.focus == .sessions }
        app.tabs.choose(.session(harbor))
        try await until { composerHasKeys }
        #expect(app.tabs.focus == .conversation)
    }

    /// The sidebar's search field.
    private func sidebarSearch() throws -> NSTextField {
        try #require(all(NSTextField.self, in: window.contentView).first { field in
            field.isEditable && field.convert(field.bounds, to: nil).midX < 300
        }, "the sidebar's search field")
    }

    /// The sidebar shown or hidden (its button, or ⌘0) puts the keyboard in the conversation's
    /// composer, and makes the conversation the card you work in, wherever the keyboard was: the
    /// panel's terminal, the sidebar's search, or the composer already, with the sidebar looking
    /// like the card you work in (the user's report: after the sidebar went, nothing looked it).
    @Test func showingOrHidingTheSidebarPutsTheKeyboardInTheComposer() async throws {
        defer { done() }
        _ = try #require(reply)
        let terminal = try await terminalInThePanel()
        withAnimation(.ui) { app.tabs.showSidebar(false) }
        try await until { composerHasKeys }
        #expect(app.tabs.focus == .conversation)

        window.makeFirstResponder(terminal.view)
        try await until { app.tabs.focus == .changes }
        withAnimation(.ui) { app.tabs.showSidebar(true) }
        try await until { composerHasKeys }
        #expect(app.tabs.focus == .conversation)

        window.makeFirstResponder(try sidebarSearch())
        try await until { app.tabs.focus == .sessions }
        withAnimation(.ui) { app.tabs.showSidebar(false) }
        try await until { composerHasKeys }
        try await drain()
        #expect(app.tabs.focus == .conversation)

        // The composer with the keyboard all along, while the sidebar looked like the card you
        // work in: the sidebar back, the conversation looks it.
        app.tabs.focus = .sessions
        withAnimation(.ui) { app.tabs.showSidebar(true) }
        try await drain()
        #expect(composerHasKeys)
        #expect(app.tabs.focus == .conversation)
    }

    /// The panel grown over the conversation: picking the session in view, or the sidebar shown
    /// or hidden, leaves the keyboard where you type in the panel, rather than in the composer the
    /// panel covers; and the sidebar's search going leaves the panel the card you work in.
    @Test func underTheExpandedPanelTheSidebarLeavesTheKeyboardAlone() async throws {
        defer { done() }
        _ = try #require(reply)
        let terminal = try await terminalInThePanel()
        withAnimation(.ui) { app.tabs.panelExpanded = true }
        try await drain()
        window.makeFirstResponder(terminal.view)
        try await until { app.tabs.focus == .changes }

        app.tabs.choose(.session(lamp))
        try await drain()
        #expect(window.firstResponder === terminal.view, "picking the session in view leaves the terminal the keyboard")
        withAnimation(.ui) { app.tabs.showSidebar(false) }
        try await drain()
        #expect(window.firstResponder === terminal.view, "hiding the sidebar leaves the terminal the keyboard")
        withAnimation(.ui) { app.tabs.showSidebar(true) }
        try await drain()

        window.makeFirstResponder(try sidebarSearch())
        try await until { app.tabs.focus == .sessions }
        withAnimation(.ui) { app.tabs.showSidebar(false) }
        try await drain()
        #expect(app.tabs.focus == .changes, "the expanded panel is the card you work in")
        withAnimation(.ui) { app.tabs.panelExpanded = false }
    }

    /// The card you work in going (the panel closed after a click in it, the keyboard still in
    /// the composer): the conversation is the card you work in again, rather than none on screen.
    @Test func theCardYouWorkInGoingLeavesYouInTheConversation() async throws {
        defer { done() }
        _ = try #require(reply)
        withAnimation(.ui) { app.tabs.showPanel(true) }
        try await drain()
        // As a click in the panel makes it, the keyboard staying in the composer.
        app.tabs.focus = .changes
        #expect(composerHasKeys)
        withAnimation(.ui) { app.tabs.showPanel(false) }
        try await drain()
        #expect(app.tabs.focus == .conversation, "the panel gone, the conversation is the card you work in")
        #expect(composerHasKeys)
    }

    /// With Settings open over the cards, a click in Settings, or the keyboard moving there, leaves
    /// the card you work in as it was, rather than giving it to the card hidden underneath.
    @Test func clicksInSettingsLeaveTheCardsAlone() async throws {
        defer {
            app.showsSettings = false
            done()
        }
        _ = try #require(reply)
        #expect(app.tabs.focus == .conversation)
        app.showsSettings = true
        click(at: NSPoint(x: 60, y: 200))
        // Nor the keyboard going to a field of the cards under Settings.
        if let search = all(NSTextField.self, in: window.contentView).first(where: { $0.isEditable && $0.convert($0.bounds, to: nil).midX < 300 }) {
            window.makeFirstResponder(search)
        }
        // The click is handled, then nothing moved.
        let handled = TestClick()
        NSApp.postEvent(handled.marker(in: window), atStart: false)
        try await until { handled.isHandled }
        #expect(app.tabs.focus == .conversation)
    }
    /// Whether the conversation's composer has the keyboard.
    private var composerHasKeys: Bool {
        (window.firstResponder as? MessageTextView)?.accessibilityIdentifier() == "composer"
    }

    /// Everything queued so far handled (layout passes and focus changes they set off).
    private func settle() async throws {
        let handled = TestClick()
        NSApp.postEvent(handled.marker(in: window), atStart: false)
        try await until { handled.isHandled }
        window.contentView?.layoutSubtreeIfNeeded()
    }

    /// Settled, and what the window queued on the main queue as it did (where the keyboard goes
    /// next) done too: the main queue runs in order.
    private func drain() async throws {
        try await settle()
        await withCheckedContinuation { done in DispatchQueue.main.async { done.resume() } }
    }

    /// The composers in view, left to right: the conversation's, then the one beside it. Laid out
    /// first, and looked at again, as `reply` is.
    private var composers: [MessageTextView] {
        window.contentView?.layoutSubtreeIfNeeded()
        TestPulse.beat()
        return all(MessageTextView.self, in: window.contentView)
            .filter { $0.accessibilityIdentifier() == "composer" && !$0.visibleRect.isEmpty }
            .sorted { $0.convert($0.bounds, to: nil).minX < $1.convert($1.bounds, to: nil).minX }
    }

    /// Whether `view` is in the window, once it's laid out: nothing tells `until` it went in (the
    /// keyboard moving as it does was only by the way), so each look lays it out first and looks
    /// again, as `reply` does.
    private func isInWindow(_ view: NSView) -> Bool {
        window.contentView?.layoutSubtreeIfNeeded()
        TestPulse.beat()
        return view.window === window
    }

    /// The panel open with a terminal, and the keyboard in it, as a click there puts it.
    private func terminalInThePanel() async throws -> TerminalSession {
        withAnimation(.ui) { app.tabs.showPanel(true) }
        app.utilities.newTerminal(in: folder, environment: [:])
        let terminal = try #require(app.utilities.terminals.values.first)
        try await until { isInWindow(terminal.view) }
        try await settle()
        window.makeFirstResponder(terminal.view)
        #expect(window.firstResponder === terminal.view)
        return terminal
    }

    /// Typing in the conversation, the panel opened and closed again (its button, or ⌥⌘0): the
    /// keyboard stays in the composer both times.
    @Test func thePanelOpenedAndClosedLeavesTheKeyboardInTheComposer() async throws {
        defer { done() }
        _ = try #require(reply)
        #expect(composerHasKeys)
        withAnimation(.ui) { app.tabs.showPanel(true) }
        try await drain()
        #expect(composerHasKeys, "opening the panel leaves the keyboard where it was")
        withAnimation(.ui) { app.tabs.showPanel(false) }
        try await drain()
        #expect(composerHasKeys)
    }

    /// Typing in a terminal in the panel, then closing the panel: the keyboard goes back to the
    /// composer, rather than to nothing (the user's report). The panel opened again, with its
    /// terminal, leaves the keyboard in the composer you type in.
    @Test func closingThePanelGivesTheKeyboardBackToTheComposer() async throws {
        defer { done() }
        _ = try #require(reply)
        let terminal = try await terminalInThePanel()

        withAnimation(.ui) { app.tabs.showPanel(false) }
        try await until { composerHasKeys }
        #expect(app.tabs.focus == .conversation)

        withAnimation(.ui) { app.tabs.showPanel(true) }
        try await until { isInWindow(terminal.view) }
        try await drain()
        #expect(composerHasKeys, "the panel back with its terminal leaves the keyboard in the composer")
        #expect(app.tabs.focus == .conversation)
    }

    /// The panel closed while it's still sliding in, with the keyboard in its terminal, which
    /// shows nothing yet past the window's edge: the keyboard goes back to the composer all the
    /// same, rather than staying in a terminal that's gone.
    @Test func closingThePanelAsItSlidesInGivesTheKeyboardBack() async throws {
        defer { done() }
        _ = try #require(reply)
        // A slide still under way all through the test. The window slides the panel at its own
        // pace whatever animation shows it, so its pace is set aside for this one.
        var slide = Transaction(animation: .linear(duration: 600))
        slide.disablesAnimations = true
        withTransaction(slide) { app.tabs.showPanel(true) }
        app.utilities.newTerminal(in: folder, environment: [:])
        let terminal = try #require(app.utilities.terminals.values.first)
        try await until { isInWindow(terminal.view) }
        window.makeFirstResponder(terminal.view)
        try await drain()
        #expect(window.firstResponder === terminal.view)
        #expect(terminal.view.visibleRect.isEmpty, "still past the window's edge")

        // Sliding out as slowly, so the terminal is still in the window as the keyboard goes back.
        withTransaction(slide) { app.tabs.showPanel(false) }
        try await until { composerHasKeys }
        #expect(app.tabs.focus == .conversation)
    }

    /// The panel hidden and shown again is as you left it, and draws nothing meanwhile: its
    /// terminal is the same one, kept in the window, hidden once the panel has slid away and
    /// shown again as it comes back.
    @Test func theHiddenPanelKeepsItsTerminalOutOfSight() async throws {
        defer { done() }
        _ = try #require(reply)
        let terminal = try await terminalInThePanel()
        let hides = terminal.view.observe(\.isHidden) { _, _ in TestPulse.beat() }
        defer { hides.invalidate() }

        withAnimation(.ui) { app.tabs.showPanel(false) }
        try await until { terminal.view.isHidden }
        #expect(terminal.view.window === window, "kept, for showing again")

        withAnimation(.ui) { app.tabs.showPanel(true) }
        try await until { !terminal.view.isHidden }
        #expect(terminal.view.window === window)
    }

    /// The panel slides out showing what's in it: its terminal is hidden only once it's away.
    @Test func thePanelSlidesOutShowingItsTerminal() async throws {
        defer { done() }
        _ = try #require(reply)
        let terminal = try await terminalInThePanel()
        let hides = terminal.view.observe(\.isHidden) { _, _ in TestPulse.beat() }
        defer { hides.invalidate() }

        withAnimation(.ui) { app.tabs.showPanel(false) }
        // The slide's first frame, laid out at once.
        window.contentView?.layoutSubtreeIfNeeded()
        #expect(!terminal.view.isHidden, "still sliding out")
        try await until { terminal.view.isHidden }
    }

    /// In a window short of room, the panel slides away as wide as it showed: its terminal isn't
    /// laid out again for another width (and a program in it drawn again) as it goes.
    @Test func thePanelGoesAsWideAsItShowed() async throws {
        defer {
            UserDefaults.standard.removeObject(forKey: "splitWidth")
            done()
        }
        _ = try #require(reply)
        // A wide session beside the conversation, for the panel to show narrower than it would.
        UserDefaults.standard.set(900.0, forKey: "splitWidth")
        app.tabs.openBeside(harbor)
        try await until { composers.count == 2 }
        let terminal = try await terminalInThePanel()
        let shown = try #require(app.tabs.layout().changes)
        try #require(shown < app.tabs.room.changes, "the panel narrower than it is with room")
        let width = terminal.view.frame.width
        let hides = terminal.view.observe(\.isHidden) { _, _ in TestPulse.beat() }
        defer { hides.invalidate() }

        withAnimation(.ui) { app.tabs.showPanel(false) }
        try await until { terminal.view.isHidden }
        window.contentView?.layoutSubtreeIfNeeded()
        #expect(terminal.view.frame.width == width)
    }

    /// With a session beside the conversation, the keyboard goes back to the half you worked in:
    /// here the session beside.
    @Test func closingThePanelInASplitGivesTheKeyboardBackToTheHalfYouWorkedIn() async throws {
        defer { done() }
        try await closingThePanelInASplit()
    }

    /// The same with Reduce Motion on, where the panel and the session beside show at once, in
    /// place, while the conversation is still narrowing to make room for them: it took the
    /// keyboard as they did, and the panel became the conversation's, without the terminal.
    @Test(.reduceMotion) func closingThePanelInASplitWithReduceMotionGivesTheKeyboardBackToo() async throws {
        defer { done() }
        try await closingThePanelInASplit()
    }

    private func closingThePanelInASplit() async throws {
        _ = try #require(reply)
        app.tabs.openBeside(harbor)
        try await until { composers.count == 2 }
        let beside = try #require(composers.last)
        window.makeFirstResponder(beside)
        try await until { app.tabs.focus == .split }

        _ = try await terminalInThePanel()
        withAnimation(.ui) { app.tabs.showPanel(false) }
        try await until { window.firstResponder === beside }
        #expect(app.tabs.focus == .split)
    }

    /// What has the keyboard and stays in view keeps it: the panel's terminal as the panel grown
    /// over the conversation goes back beside it, and the sidebar's search as the panel closes.
    @Test func whatStaysInViewKeepsTheKeyboard() async throws {
        defer { done() }
        _ = try #require(reply)
        let terminal = try await terminalInThePanel()
        withAnimation(.ui) { app.tabs.panelExpanded = true }
        try await settle()
        withAnimation(.ui) { app.tabs.panelExpanded = false }
        try await drain()
        #expect(window.firstResponder === terminal.view, "the terminal keeps the keyboard")

        let search = try #require(all(NSTextField.self, in: window.contentView).first { field in
            field.isEditable && field.convert(field.bounds, to: nil).midX < 300
        }, "the sidebar's search field")
        window.makeFirstResponder(search)
        let editor = try #require(window.firstResponder as? NSTextView)
        withAnimation(.ui) { app.tabs.showPanel(false) }
        try await drain()
        #expect(window.firstResponder === editor, "the sidebar's search keeps the keyboard")
    }

    /// Nothing left with the keyboard, as Settings or the panel grown over the conversation leave
    /// it: once they're put away, it's back in the composer.
    @Test func settingsAndTheExpandedPanelPutAwayGiveTheKeyboardBack() async throws {
        defer {
            app.showsSettings = false
            done()
        }
        _ = try #require(reply)
        app.showsSettings = true
        try await settle()
        // What the app does as Settings come in (to its main window, which the tests' never is).
        window.makeFirstResponder(nil)
        app.showsSettings = false
        try await until { composerHasKeys }

        withAnimation(.ui) {
            app.tabs.showPanel(true)
            app.tabs.panelExpanded = true
        }
        try await settle()
        window.makeFirstResponder(nil)
        withAnimation(.ui) { app.tabs.panelExpanded = false }
        try await until { composerHasKeys }
    }

    /// The rows of the conversation in view in this window (other suites' windows show
    /// conversations meanwhile): those not hidden, as the kept ones' are.
    private var shownRows: RowStackView? {
        func views(in view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
        guard let content = window.contentView else { return nil }
        return views(in: content).lazy.compactMap { $0 as? RowStackView }.first { !$0.isHiddenOrHasHiddenAncestor }
    }

    /// How far the conversation in view is from its end, once it's laid out and long enough to
    /// read back up.
    private var fromEnd: CGFloat? {
        window.contentView?.layoutSubtreeIfNeeded()
        TestPulse.beat()
        guard let scroll = shownRows?.enclosingScrollView, let document = scroll.documentView,
              document.frame.height > scroll.contentView.bounds.height * 2 else { return nil }
        let clip = scroll.contentView.bounds
        return document.isFlipped ? document.frame.height - clip.maxY : clip.minY
    }

    /// How far down the conversation in view is scrolled: where you're reading.
    private var fromTop: CGFloat? {
        guard fromEnd != nil, let scroll = shownRows?.enclosingScrollView, let document = scroll.documentView else { return nil }
        let clip = scroll.contentView.bounds
        return document.isFlipped ? clip.minY : document.frame.height - clip.maxY
    }

    /// A day's question and the keeper's long answer, for a conversation long enough to read back up.
    private func exchange(in session: String, day: Int) -> [[String: Any]] {
        let asked = Double(day * 2 + 1), answered = Double(day * 2 + 2)
        let question: [String: Any] = ["id": "\(session)_\(day)_q", "type": "user", "time": ["created": asked], "text": "And day \(day)?"]
        let text = "Day \(day): the wind came round to the north, and the keeper wrote down the ships that passed and the oil the lamp burned through the night."
        let answer: [String: Any] = ["id": "\(session)_\(day)_a", "type": "assistant", "agent": "build",
                                     "time": ["created": answered, "completed": answered],
                                     "model": ["id": "glm", "providerID": "opencode"],
                                     "content": [["type": "text", "text": text]]]
        return [question, answer]
    }

    /// Reading back up a long conversation, then over to a new session's tab and back: it's
    /// still where you were reading, rather than made again at its end.
    @Test func aSessionIsWhereYouWereReadingAfterANewSessionsTab() async throws {
        defer { done() }
        _ = try #require(reply)
        let log = "ses_focus_log"
        engine.list([StubEngine.session(lamp, title: "The lamp", directory: folder, created: 2),
                     StubEngine.session(harbor, title: "The harbor", directory: folder, created: 1),
                     StubEngine.session(log, title: "The log", directory: folder, created: 3)])
        engine.conversation(log, (0..<30).flatMap { exchange(in: log, day: $0) })
        await app.workspace.refresh()
        app.tabs.open(.session(log))
        try await until { fromEnd.map { $0 < 2 } ?? false }

        // Read back up to the start: the end isn't followed any more, as when you scroll up.
        let rows = try #require(shownRows)
        let scroll = try #require(rows.enclosingScrollView)
        let document = try #require(scroll.documentView)
        try #require(rows.scrollAnchor).stopFollowing()
        scroll.contentView.scroll(to: NSPoint(x: 0, y: document.isFlipped ? 0 : document.frame.height - scroll.contentView.bounds.height))
        scroll.reflectScrolledClipView(scroll.contentView)
        try await until { (fromEnd ?? 0) > 500 }
        try await drain()
        let reading = try #require(fromTop)

        app.tabs.newSession(in: folder, conversation: true)
        try await drain()
        app.tabs.open(.session(log))
        try await until { fromEnd != nil }
        try await drain()
        #expect(abs((fromTop ?? .infinity) - reading) < 2, "still where you were reading")
    }

    /// The session's tab closed, nothing in its place: its composer (kept, out of sight) lets go
    /// of the keyboard, and nothing you type goes into it.
    @Test func aSessionsTabClosedLeavesNothingTypingIntoIt() async throws {
        defer { done() }
        _ = try #require(reply)
        #expect(composerHasKeys)
        let model = try #require(app.workspace.model(for: lamp))
        app.tabs.close(.session(lamp))
        try await drain()
        #expect(!composerHasKeys, "no composer has the keyboard")
        (window.firstResponder as? NSTextView)?.insertText("ahoy", replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(model.draftText.isEmpty)
    }

    /// From a new session's tab back to a session's with ⌃Tab: its composer has the keyboard,
    /// and what you type goes into it.
    @Test func backOnASessionsTabItsComposerHasTheKeyboard() async throws {
        defer { done() }
        _ = try #require(reply)
        let model = try #require(app.workspace.model(for: lamp))
        app.tabs.newSession(in: folder, conversation: true)
        try await drain()
        app.tabs.cycle(by: -1)
        #expect(app.tabs.sessionID == lamp)
        try await drain()
        try await until { composerHasKeys }
        let field = try #require(window.firstResponder as? MessageTextView)
        field.insertText("ahoy", replacementRange: NSRange(location: NSNotFound, length: 0))
        try await until { model.draftText == "ahoy" }
    }

    /// A session kept under a new session's tab asking for the keyboard (a message it couldn't
    /// send coming back, say) doesn't take it: what you type goes on into the new session.
    @Test func aSessionUnderANewSessionsTabDoesntTakeTheKeyboard() async throws {
        defer { done() }
        _ = try #require(reply)
        let model = try #require(app.workspace.model(for: lamp))
        app.tabs.newSession(in: folder, conversation: true)
        try await drain()
        try await until { composerHasKeys }
        let draft = try #require(window.firstResponder as? MessageTextView)
        let drafted = model.draftText
        model.focusComposer()
        try await drain()
        #expect(window.firstResponder === draft, "the new session's composer keeps the keyboard")
        (window.firstResponder as? NSTextView)?.insertText("ahoy", replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(model.draftText == drafted)
    }

}

/// An event queued after a test's clicks: once it's handled, so are they.
@MainActor final class TestClick {
    private(set) var isHandled = false
    private var monitor: Any?

    func marker(in window: NSWindow) -> NSEvent {
        monitor = NSEvent.addLocalMonitorForEvents(matching: .applicationDefined) { [weak self] event in
            guard event.subtype.rawValue == 7, let self else { return event }
            isHandled = true
            if let monitor { NSEvent.removeMonitor(monitor) }
            TestPulse.beat()
            return nil
        }
        return NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                                  context: nil, subtype: 7, data1: 0, data2: 0)!
    }
}
