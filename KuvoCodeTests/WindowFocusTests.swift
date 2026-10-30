import AppKit
import ClientDesign
import SwiftUI
import Testing
@testable import KuvoCode

/// The card you work in looks it (crisp, the others a warm ivory): the one you last clicked or
/// typed in. A click on a reply's words makes the conversation that card, as a click anywhere in
/// it does; a click on the sidebar makes the sidebar it; with Settings open, clicks there leave
/// the cards as they were; the keyboard moving into a card makes it the one too. A session picked
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

        // And back to the sidebar, with a click below its rows.
        click(at: NSPoint(x: 60, y: 200))
        try await until { app.tabs.focus == .sessions }
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

    /// A session picked in the sidebar: the click is the sidebar's, then its row opens the session
    /// (the store call its button makes as the click ends), and you work in its conversation.
    @Test func aSessionPickedInTheSidebarLeavesYouInItsConversation() async throws {
        defer { done() }
        _ = try #require(reply)
        // The press and its release in the sidebar, as on a row.
        click(at: NSPoint(x: 60, y: 200))
        let handled = TestClick()
        NSApp.postEvent(handled.marker(in: window), atStart: false)
        try await until { handled.isHandled }
        #expect(app.tabs.focus == .sessions)
        // What the row's button does as the click ends; then the keyboard goes to its composer.
        app.tabs.open(.session(harbor))
        try await until { (window.firstResponder as? MessageTextView)?.accessibilityIdentifier() == "composer" }
        let settled = TestClick()
        NSApp.postEvent(settled.marker(in: window), atStart: false)
        try await until { settled.isHandled }
        #expect(app.tabs.selection == .session(harbor))
        #expect(app.tabs.focus == .conversation)
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

    /// With a session beside the conversation, the keyboard goes back to the half you worked in:
    /// here the session beside.
    @Test func closingThePanelInASplitGivesTheKeyboardBackToTheHalfYouWorkedIn() async throws {
        defer { done() }
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
