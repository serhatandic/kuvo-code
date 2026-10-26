import AppKit
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

    let window = TestWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 1100, height: 700), styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    /// Tells `until` each time the keyboard moves in the window.
    private let watch: NSKeyValueObservation
    let folder = "/tmp/kuvo-tests-window-focus"
    let lamp = "ses_focus_lamp"
    let harbor = "ses_focus_harbor"

    init() async throws {
        TestEnvironment.prepare()
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
            .frame(width: 1100, height: 700)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        watch = window.observe(\.firstResponder) { _, _ in TestPulse.beat() }
        window.orderBack(nil)
        try await until { reply != nil }
    }

    private func done() {
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
        // What the row's button does as the click ends.
        app.tabs.open(.session(harbor))
        #expect(app.tabs.selection == .session(harbor))
        #expect(app.tabs.focus == .conversation)
    }

    /// With Settings open over the cards, a click in Settings leaves the card you work in as it
    /// was, rather than giving it to the card hidden underneath.
    @Test func clicksInSettingsLeaveTheCardsAlone() async throws {
        defer {
            app.showsSettings = false
            done()
        }
        _ = try #require(reply)
        #expect(app.tabs.focus == .conversation)
        app.showsSettings = true
        click(at: NSPoint(x: 60, y: 200))
        // The click is handled, then nothing moved.
        let handled = TestClick()
        NSApp.postEvent(handled.marker(in: window), atStart: false)
        try await until { handled.isHandled }
        #expect(app.tabs.focus == .conversation)
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
