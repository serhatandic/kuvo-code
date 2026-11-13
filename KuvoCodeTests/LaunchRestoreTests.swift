import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// The app opened again (#284): the conversation you were in when you quit is the one in view,
/// from the first frame, also when macOS didn't keep the window (it doesn't on ⌘Q unless "Close
/// windows when quitting an application" is off), never the latest session after a moment of
/// the welcome. The window is the app's own (`MainView`), twice, a launch each, in windows of the
/// test's own: the second has none of the first's scene storage, as after ⌘Q. The engine is
/// stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct LaunchRestoreTests {
    let engine = StubEngine(port: 47930)
    let folder = "/tmp/kuvo-tests-launch-restore"
    let suite = "LaunchRestoreTests-\(UUID().uuidString)"
    let lamp = "ses_launch_lamp"
    let harbor = "ses_launch_harbor"

    init() throws {
        TestEnvironment.prepare()
        AXElement.reading(true)
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        // The lamp is the latest: what the window opened at launch.
        engine.list([StubEngine.session(lamp, title: "The lamp", directory: folder, created: 2),
                     StubEngine.session(harbor, title: "The harbor", directory: folder, created: 1)])
        for (id, words) in [(lamp, "The keeper climbed the stairs at dusk and lit the great lamp."),
                            (harbor, "Out at sea the captain saw the light and turned toward the harbor.")] {
            engine.conversation(id, [
                ["id": id + "_1", "type": "user", "time": ["created": 1], "text": "Tell me about it"],
                ["id": id + "_2", "type": "assistant", "agent": "build", "time": ["created": 2, "completed": 2.5],
                 "model": ["id": "glm", "providerID": "opencode"], "content": [["type": "text", "text": words]]],
            ])
        }
    }

    private func done() {
        engine.stop()
        try? FileManager.default.removeItem(atPath: folder)
        UserDefaults().removePersistentDomain(forName: suite)
    }

    /// A launch: the app, and its window.
    private func launch() -> (app: AppModel, window: NSWindow) {
        let app = AppModel()
        app.tabs.keptIn = UserDefaults(suiteName: suite)
        app.workspace.api = engine.api
        let view = MainView()
            .environment(app)
            .environment(app.catalog)
            .environment(app.workspace)
            .environment(app.bots)
            .environment(app.chats)
            .environment(Updates())
            .frame(width: 1400, height: 700)
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 1400, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.orderBack(nil)
        return (app, window)
    }

    private func quit(_ window: NSWindow) {
        window.orderOut(nil)
        window.close()
        window.contentView = nil
    }

    /// Whether the window shows the welcome (its "Welcome to Kuvo Code").
    private func showsWelcome(_ window: NSWindow) -> Bool {
        window.contentView?.layoutSubtreeIfNeeded()
        return AXElement.all(in: window.contentView).contains { element in
            let selector = #selector(NSAccessibilityProtocol.accessibilityValue)
            let value = element.object.responds(to: selector) ? element.object.perform(selector)?.takeUnretainedValue() as? String : nil
            return [element.label, value].contains { $0?.hasPrefix("Welcome to") == true }
        }
    }

    @Test func theConversationYouLeftIsInViewAtTheNextLaunchWithoutTheWelcomeFirst() async throws {
        defer { done() }
        // The first launch: the harbor picked, then quit.
        let first = launch()
        await first.app.workspace.refresh()
        let firstFollows = try await engine.listing.follow(first.app.workspace)
        defer { firstFollows.cancel() }
        // (The latest open first, as the launch opens it once its box has listed them.)
        try await until { first.app.tabs.selection == .session(lamp) }
        first.app.tabs.choose(.session(harbor))
        // Kept by the window as it changes, as in the app.
        let kept = UserDefaults(suiteName: suite)
        try await until {
            first.window.contentView?.layoutSubtreeIfNeeded()
            TestPulse.beat()
            return kept?.string(forKey: WindowTabs.keptKey)?.contains(harbor) == true && first.app.tabs.selection == .session(harbor)
        }
        quit(first.window)

        // The next: the harbor from the first frame, while the sessions are still being read.
        let next = launch()
        defer { quit(next.window) }
        #expect(!next.app.workspace.isLoaded)
        #expect(next.app.tabs.selection == .session(harbor))
        #expect(!showsWelcome(next.window), "no welcome while the sessions are read")

        await next.app.workspace.refresh()
        let nextFollows = try await engine.listing.follow(next.app.workspace)
        defer { nextFollows.cancel() }
        try await until { next.app.workspace.isLoaded }
        next.window.contentView?.layoutSubtreeIfNeeded()
        #expect(next.app.tabs.selection == .session(harbor), "still the harbor, not the latest")
        #expect(!showsWelcome(next.window))
    }

    /// Nothing kept (the first launch, or the tabs all closed): no welcome while the sessions are
    /// read, then the latest; the welcome only when there's nothing to open.
    @Test func withNothingKeptTheLatestOpensWithoutTheWelcomeFirst() async throws {
        defer { done() }
        let launched = launch()
        defer { quit(launched.window) }
        #expect(!showsWelcome(launched.window), "no welcome while the sessions are read")
        await launched.app.workspace.refresh()
        let follows = try await engine.listing.follow(launched.app.workspace)
        defer { follows.cancel() }
        try await until { launched.app.tabs.selection == .session(lamp) }
        #expect(!showsWelcome(launched.window))

        launched.app.tabs.close(.session(lamp))
        try await until { launched.app.tabs.keys.isEmpty }
        #expect(showsWelcome(launched.window), "nothing open: the welcome")
    }
}
