import AppKit
import ClientSessions
import KuvoLink
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// A bot's sessions while its goal shows: a chip on the goal's line ("1 working"), which VoiceOver
/// reads in full, and no work bar of their own under it, so nothing is said twice. Once you put the
/// goal away, the work bar is back. The bot's conversation and the card over its composer are the
/// real ones, in a window of the test's own; its box is a stand-in answering as a box does.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct GoalWorkChipTests {
    let engine = StubEngine(port: 48_012)
    let app = AppModel()
    let catalog = Catalog()
    let model: SessionModel
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 720, height: 620), styleMask: [.titled, .resizable], backing: .buffered, defer: false)

    /// What the bot's box says: Pixel, a session it runs at work, and its goal, met.
    nonisolated private static func answer(_ path: String) -> Data {
        let now = Date.now.timeIntervalSince1970 * 1000
        let body: Any
        switch path {
        case "kuvo/bots":
            body = ["bots": [["id": "bot_pixel00001", "session": "ses_goalchip", "name": "Pixel", "look": ["color": "sky", "shape": "round", "face": "calm"], "created": "2026-10-01T09:00:00Z"]]]
        case _ where path.hasPrefix("kuvo/work?bot="):
            body = ["bot": "bot_pixel00001", "answered": [Any](), "today": ["started": 1, "working": 1, "tokens": 0],
                    "sessions": [["session": "ses_signin", "title": "Sign-in", "folder": "/Users/me/tidepool", "startedBy": "ses_goalchip", "depth": 1,
                                  "state": "working", "started": now, "tokens": 0]]]
        case "kuvo/work/goals":
            body = ["goals": [["id": "goal_1", "bot": "bot_pixel00001", "name": "Pixel", "session": "ses_goalchip", "goal": "Launch Driftwood.", "state": "done",
                               "steps": [["id": "s1", "text": "Build the site", "state": "done", "began": now - 600_000, "ended": now - 60_000]],
                               "checks": [Any](), "spend": [Any](), "public": [Any](), "projects": [String](), "wake": false, "digest": "none",
                               "proposed": now - 900_000, "started": now - 600_000, "ended": now - 60_000, "waiting": [Any](), "paused": [Any](), "waited": 0,
                               "watching": [String](), "alone": true]]]
        default:
            body = [String: Any]()
        }
        return (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
    }

    init() async throws {
        TestEnvironment.prepare()
        try? FileManager.default.removeItem(at: Bots.file)
        let box = BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            let path = request.path.hasPrefix("/") ? String(request.path.dropFirst()) : request.path
            let body = Self.answer(path)
            return AsyncThrowingStream { continuation in
                // A follow's stream ends at once: what it would tell, the reads here say.
                if !path.hasSuffix("/events") {
                    continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(body))
                }
                continuation.finish()
            }
        })
        app.bots.app = app
        app.botWork.app = app
        app.goalPlans.app = app
        app.bots.boxes = { _ in box }
        app.botWork.boxes = { _ in box }
        app.goalPlans.boxes = { _ in box }
        app.workspace.api = engine.api
        // The box says Sign-in works, and the app shows it so only while its engine runs it (`AtWork`).
        engine.list([StubEngine.session("ses_goalchip", title: "Pixel", directory: "/tmp/kuvo-tests-goal-work", created: 1),
                     StubEngine.session("ses_signin", title: "Sign-in", directory: "/Users/me/tidepool", created: 2)],
                    running: ["ses_signin"])
        engine.conversation("ses_goalchip", [])
        await app.workspace.refresh()
        model = try #require(app.workspace.model(for: "ses_goalchip"))
        await app.bots.refresh(BoxClient.mac)
        let pixel = try #require(app.bots.bot("bot_pixel00001"))
        await app.botWork.read(pixel)
        await app.goalPlans.read(BoxClient.mac)
        // Last, once nothing here can throw: `done()` switches it off again.
        AXElement.reading(true)
        let view = BottomStack(model: model, lastModel: .constant(nil))
            .environment(app)
            .environment(app.workspace)
            .environment(catalog)
            .frame(width: 720, height: 620, alignment: .bottom)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.orderBack(nil)
    }

    private func done() {
        engine.stop()
        window.orderOut(nil)
        window.close()
        try? FileManager.default.removeItem(at: Bots.file)
        AXElement.reading(false)
    }

    /// What VoiceOver finds over the composer, as it lays out now. (Read while the window lays
    /// out, which `until` can't see: each look lays it out first, and says so on the main queue's
    /// next turn, once the wait is watching, for it to look again after SwiftUI's update.)
    private var elements: [AXElement] {
        window.contentView?.layoutSubtreeIfNeeded()
        DispatchQueue.main.async { TestPulse.beat() }
        return AXElement.all(in: window.contentView)
    }

    /// The chip on the goal's line, whatever it says: found by where it takes you.
    private var chip: AXElement? {
        elements.first { $0.help?.hasSuffix("all of Pixel’s work today") == true || $0.help == "Shows all of Pixel’s work today" }
    }

    /// The work bar's own All, which only the bar has.
    private var workBar: AXElement? { elements.first { $0.label == "All" } }

    @Test func theGoalsLineHasTheBotsSessionsAndTheirBarIsBackOnceItsPutAway() async throws {
        defer { done() }
        try await until { chip != nil || app.goalPlans.plan(for: "ses_goalchip") == nil }
        #expect(chip?.label == "A session is at work", "the chip on the goal's line says its session works, among \(elements.compactMap(\.label))")
        #expect(workBar == nil, "no work bar under the goal: its line says it")
        #expect(app.goalPlans.plan(for: "ses_goalchip") != nil)

        let close = try #require(elements.first { $0.label == "Close Launch Driftwood." }, "among \(elements.compactMap(\.label))")
        #expect(close.press())
        try await until { workBar != nil }
        #expect(chip == nil, "the goal gone, and its chip with it")
    }
}
