import AppKit
import Foundation
import SwiftUI
import Testing
@testable import KuvoCode

/// A conversation opened from inside another (a bot's session from the bot, that session's
/// subagent from it) shows the way back at its top, and Back takes you to the conversation you
/// came from where you were reading in it, a step at a time; one picked in the sidebar starts
/// fresh, with no way back. The window is the app's own (`MainView`), in a window of the test's own
/// that never becomes key; the engine is stubbed, and the bot is as this Mac's box last said it
/// (`bots.json`). The Open that opens a session from the bot is the store call its button makes
/// (`AppModel.open(_:from:)`); Back is pressed as VoiceOver presses it, through the button itself.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ConversationBackTests {
    let engine = StubEngine(port: 48_417)
    let app: AppModel
    let window = WindowFocusTests.TestWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 1500, height: 700), styleMask: [.titled, .resizable, .fullSizeContentView],
                                             backing: .buffered, defer: false)
    let folder = "/tmp/kuvo-tests-conversation-back"
    let bot = "ses_back_bot"
    let work = "ses_back_work"
    let other = "ses_back_other"
    let sub = "ses_back_sub"

    init() async throws {
        TestEnvironment.prepare()
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        // The bot as its box last said, read as the app starts; gone again at once, so no other
        // suite's app finds it.
        let file = Bots.file
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: [[
            "id": "bot_back", "name": "Foreman", "job": "Coordinates the work", "instructions": "Coordinates the work.",
            "look": ["color": "sky", "shape": "round", "face": "calm"], "folder": folder, "sessionID": bot, "created": "2026-11-10T09:00:00Z",
        ]]).write(to: file)
        app = AppModel()
        try? FileManager.default.removeItem(at: file)
        app.workspace.api = engine.api

        let subagent = StubEngine.session(sub, title: "Read the slider", directory: folder, extra: ["parentID": work])
        engine.list([StubEngine.session(bot, title: "Foreman", directory: folder, created: 3),
                     StubEngine.session(work, title: "Timer cycle", directory: folder, created: 2),
                     StubEngine.session(other, title: "Settings page", directory: folder, created: 1),
                     subagent])
        engine.on("GET", "/api/session/\(sub)", json: ["data": subagent])
        for id in [bot, work, other, sub] {
            engine.conversation(id, (0..<30).flatMap { exchange(in: id, day: $0) })
        }
        await app.workspace.refresh()
        AXElement.reading(true)
        let view = MainView()
            .environment(app)
            .environment(app.catalog)
            .environment(app.workspace)
            .environment(app.bots)
            .environment(app.chats)
            .environment(Updates())
            .frame(width: 1500, height: 700)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.orderBack(nil)
    }

    private func done() {
        AXElement.reading(false)
        app.utilities.closeAll()
        try? FileManager.default.removeItem(atPath: folder)
        engine.stop()
        window.orderOut(nil)
        window.close()
        window.contentView = nil
    }

    /// A day's question and a long answer, for a conversation long enough to read back up.
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

    /// Everything queued so far handled, and what the window queued on the main queue as it did.
    private func drain() async throws {
        let handled = TestClick()
        NSApp.postEvent(handled.marker(in: window), atStart: false)
        try await until { handled.isHandled }
        window.contentView?.layoutSubtreeIfNeeded()
        await withCheckedContinuation { done in DispatchQueue.main.async { done.resume() } }
    }

    /// The rows of the conversation in view (the kept ones' are hidden).
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

    /// The way back VoiceOver finds in the window, as it lays out now: "Back to …".
    private var backs: [AXElement] {
        window.contentView?.layoutSubtreeIfNeeded()
        DispatchQueue.main.async { TestPulse.beat() }
        return AXElement.all(in: window.contentView).filter { $0.label?.hasPrefix("Back to ") == true }
    }

    private var backLabels: [String] { backs.compactMap(\.label) }

    /// Back, pressed: the one way back in view.
    private func pressBack(to name: String) throws {
        let back = try #require(backs.first { $0.label == "Back to \(name)" }, "“Back to \(name)” among \(backLabels)")
        #expect(back.press())
    }

    /// The conversation picked in the sidebar, read back up to its start, as far as you scrolled.
    private func readBackUp(_ id: String) async throws -> CGFloat {
        app.tabs.choose(.session(id))
        try await until { app.tabs.sessionID == id && (fromEnd.map { $0 < 2 } ?? false) }
        let rows = try #require(shownRows)
        let scroll = try #require(rows.enclosingScrollView)
        let document = try #require(scroll.documentView)
        try #require(rows.scrollAnchor).stopFollowing()
        // A third of the way down, not the very top, where earlier messages would be asked for.
        let place = (document.frame.height - scroll.contentView.bounds.height) / 3
        scroll.contentView.scroll(to: NSPoint(x: 0, y: document.isFlipped ? place : document.frame.height - scroll.contentView.bounds.height - place))
        scroll.reflectScrolledClipView(scroll.contentView)
        try await until { (fromEnd ?? 0) > 500 }
        try await drain()
        return try #require(fromTop)
    }

    /// The user's report: a session opened from the bot, then no way back but the sidebar. Now
    /// it has Back at its top, named for the bot, and Back finds the bot where you were reading.
    @Test func aSessionOpenedFromABotGoesBackToTheBotWhereYouWereReading() async throws {
        defer { done() }
        let reading = try await readBackUp(bot)
        #expect(backLabels.isEmpty, "the bot, picked in the sidebar, has no way back: \(backLabels)")

        app.open(.session(work), from: .session(bot))
        try await until { app.tabs.sessionID == work && backLabels == ["Back to Foreman"] }
        #expect(app.tabs.keys == [.session(work)], "in the bot's place, in its tab")

        try pressBack(to: "Foreman")
        try await until { app.tabs.sessionID == bot && fromTop != nil }
        try await drain()
        #expect(abs((fromTop ?? .infinity) - reading) < 2, "the bot where you were reading")
        #expect(backLabels.isEmpty, "back at the start: no way back further")
    }

    /// Bot, its session, that session's subagent: Back goes up one step at a time, each named.
    @Test func backGoesAStepAtATime() async throws {
        defer { done() }
        let reading = try await readBackUp(bot)
        app.open(.session(work), from: .session(bot))
        try await until { app.tabs.sessionID == work && backLabels == ["Back to Foreman"] }
        app.open(.session(sub), from: .session(work))
        try await until { app.tabs.sessionID == sub && backLabels == ["Back to Timer cycle"] }

        try pressBack(to: "Timer cycle")
        try await until { app.tabs.sessionID == work && backLabels == ["Back to Foreman"] }
        try pressBack(to: "Foreman")
        try await until { app.tabs.sessionID == bot && fromTop != nil }
        try await drain()
        #expect(abs((fromTop ?? .infinity) - reading) < 2, "the bot where you were reading")
        #expect(backLabels.isEmpty)
    }

    /// A conversation picked in the sidebar starts fresh: no way back, even the one in view that
    /// had one.
    @Test func aConversationPickedInTheSidebarHasNoWayBack() async throws {
        defer { done() }
        app.tabs.choose(.session(bot))
        app.open(.session(work), from: .session(bot))
        try await until { app.tabs.sessionID == work && backLabels == ["Back to Foreman"] }

        app.tabs.choose(.session(other))
        try await until { app.tabs.sessionID == other }
        try await drain()
        #expect(backLabels.isEmpty, "another picked in the sidebar: \(backLabels)")

        app.tabs.choose(.session(work))
        try await until { app.tabs.sessionID == work }
        try await drain()
        #expect(backLabels.isEmpty, "picked in the sidebar, it starts fresh: \(backLabels)")
    }
}
