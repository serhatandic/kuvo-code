import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A session's sub-sessions (the sessions its agent's subagents work in) are listed under it with
/// the sessions, newest first, each with what it's doing: one at work shows working, one asking
/// shows waiting for you, one finished that you haven't seen is new. One that starts later joins
/// the list, a deleted one leaves it, and a sub-session's own are listed under that one. None gets
/// a row of its own among the sessions. Opening one reads it; opening its session reads those
/// that finished, as what they found shows there. The engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SubSessionsTests {
    let engine = StubEngine(port: 47986)
    let workspace = Workspace()
    let folder = "/tmp/kuvo-tests-sub-sessions"

    init() {
        workspace.api = engine.api
    }

    private func session(_ id: String, _ title: String, parent: String? = nil, created: Double, idle: Double? = nil, viewed: Double? = nil) -> [String: Any] {
        var extra: [String: Any] = parent.map { ["parentID": $0] } ?? [:]
        if let idle {
            var time: [String: Any] = ["created": created, "updated": idle, "idle": idle]
            if let viewed { time["viewed"] = viewed }
            extra["time"] = time
        }
        return StubEngine.session(id, title: title, directory: folder, created: created, extra: extra)
    }

    @Test func aSessionsSubSessionsAreListedUnderIt() async throws {
        defer { engine.stop() }
        engine.list([
            session("ses_timer", "Timer cycle", created: 1),
            session("ses_find", "Find where the timer state lives", parent: "ses_timer", created: 10),
            session("ses_tests", "Write tests for the long break", parent: "ses_timer", created: 20),
            session("ses_ask", "Check the settings screen", parent: "ses_timer", created: 30),
            session("ses_deeper", "Read the slider's limits", parent: "ses_ask", created: 40),
        ], running: ["ses_tests"])
        await workspace.refresh()

        #expect(workspace.subSessions["ses_timer"]?.map(\.id) == ["ses_ask", "ses_tests", "ses_find"], "newest first")
        #expect(workspace.subSessions["ses_ask"]?.map(\.id) == ["ses_deeper"], "its own, under it")
        #expect(workspace.sessions.map(\.id) == ["ses_timer"], "no row of their own")
        try await until { workspace.isWorking("ses_tests") }
        #expect(!workspace.isWorking("ses_find"))

        // One asks you something: it waits for you.
        workspace.handle(try engine.event("permission.asked", ["id": "per_1", "sessionID": "ses_ask", "action": "edit", "resources": ["Settings.swift"]]))
        try await until { workspace.needsAttention("ses_ask") }
        #expect(!workspace.needsAttention("ses_find"))

        // Another starts: it joins at the top.
        engine.on("GET", "/api/session/ses_more", json: ["data": session("ses_more", "Check the sound", parent: "ses_timer", created: 50)])
        workspace.handle(try engine.event("session.created", session: "ses_more"))
        try await until { workspace.subSessions["ses_timer"]?.first?.id == "ses_more" }

        // One is deleted: it leaves.
        workspace.handle(try engine.event("session.deleted", session: "ses_find"))
        #expect(workspace.subSessions["ses_timer"]?.map(\.id) == ["ses_more", "ses_ask", "ses_tests"])
        // A sub-session that hadn't started any gets its list with its first.
        engine.on("GET", "/api/session/ses_first", json: ["data": session("ses_first", "Look around", parent: "ses_tests", created: 60)])
        workspace.handle(try engine.event("session.created", session: "ses_first"))
        try await until { workspace.subSessions["ses_tests"]?.map(\.id) == ["ses_first"] }
    }

    /// Finished while you weren't looking: new, on its row and on its folded session's. Opening
    /// it reads it, on its box too; opening its session reads the others that finished.
    @Test func aFinishedSubSessionIsNewUntilYouLook() async throws {
        defer { engine.stop() }
        engine.list([
            session("ses_timer", "Timer cycle", created: 1, idle: 5, viewed: 5),
            session("ses_find", "Find the timer", parent: "ses_timer", created: 10, idle: 12, viewed: 4),
            session("ses_tests", "Write the tests", parent: "ses_timer", created: 20, idle: 22, viewed: 4),
            // Done before you were last in its session, never marked read: not new.
            session("ses_old", "Look around", parent: "ses_timer", created: 2, idle: 3),
            session("ses_lasts", "Old one", created: 1, idle: 9, viewed: 9),
            session("ses_lasts_sub", "From before", parent: "ses_lasts", created: 2, idle: 4),
        ])
        await workspace.refresh()
        #expect(!workspace.hasNewSubSessions("ses_lasts"), "sub-sessions from before you were last there aren't new")
        #expect(workspace.subSession("ses_old").map(workspace.isNew) == false)
        #expect(workspace.hasNewSubSessions("ses_timer"))
        #expect(workspace.subSession("ses_find")?.isUnread == true)

        workspace.markViewed("ses_find")
        #expect(workspace.subSession("ses_find")?.isUnread == false)
        try await until { engine.requests("POST", "/api/session/ses_find/view").first?.body["idle"] as? Double == 12 }
        #expect(workspace.hasNewSubSessions("ses_timer"), "the other is still new")

        workspace.markViewed("ses_timer")
        #expect(!workspace.hasNewSubSessions("ses_timer"))
        try await until { engine.requests("POST", "/api/session/ses_tests/view").first?.body["idle"] as? Double == 22 }
    }

    /// A box whose sessions' parents go round (one its own subagent's, two each other's): what's
    /// new about them and reading them work, rather than the app crashing.
    @Test func subSessionsWhoseParentsGoRoundDontCrashIt() async throws {
        defer { engine.stop() }
        engine.list([
            session("ses_timer", "Timer cycle", created: 1, idle: 5, viewed: 5),
            session("ses_self", "Its own subagent", parent: "ses_self", created: 10, idle: 12, viewed: 4),
            session("ses_a", "One", parent: "ses_b", created: 20, idle: 22, viewed: 4),
            session("ses_b", "The other", parent: "ses_a", created: 30, idle: 32, viewed: 4),
        ])
        await workspace.refresh()
        #expect(!workspace.hasNewSubSessions("ses_self"), "listed under itself, it isn't a sub-session of its own")
        #expect(workspace.hasNewSubSessions("ses_a"))

        workspace.markViewed("ses_a")
        #expect(!workspace.hasNewSubSessions("ses_a"))
        #expect(!workspace.hasNewSubSessions("ses_b"))
    }

    /// A sub-session finished since you read its session: its computer's name in the strip says
    /// there's something new, as its folded row does.
    @Test func aComputerWithANewSubSessionHasSomethingNew() async throws {
        defer { engine.stop() }
        let app = AppModel()
        app.workspace.api = engine.api
        engine.list([
            session("ses_timer", "Timer cycle", created: 1, idle: 5, viewed: 5),
            session("ses_find", "Find the timer", parent: "ses_timer", created: 10, idle: 12, viewed: 4),
        ])
        await app.workspace.refresh()
        #expect(app.workspace.session("ses_timer")?.isUnread == false)
        #expect(app.news(on: SidebarBox(directory: folder)) == .new)
        app.workspace.markViewed("ses_timer")
        #expect(app.news(on: SidebarBox(directory: folder)) == nil)
    }

    /// Read here while the list is read again (a reconnect, an engine settings change) before
    /// the engine has the read, or with the read lost on the way: it stays read, not bold again.
    @Test func aConversationYouReadStaysReadWhenTheListIsReadAgain() async throws {
        // (Its own ID: the sessions this Mac last saw, as other tests left them, are listed first.)
        defer { engine.stop() }
        engine.list([session("ses_readagain", "Timer cycle", created: 1, idle: 5)])
        await workspace.refresh()
        #expect(workspace.session("ses_readagain")?.isUnread == true)
        workspace.markViewed("ses_readagain")
        // The engine's list, without the read yet.
        await workspace.refresh()
        #expect(workspace.session("ses_readagain")?.isUnread == false)
        // It finishes again: new again.
        engine.list([session("ses_readagain", "Timer cycle", created: 1, idle: 9)])
        await workspace.refresh()
        #expect(workspace.session("ses_readagain")?.isUnread == true)
    }

    /// A sub-session's tab, as the app opens again: it learns whose it is, so it opens as a
    /// sub-session with the way back.
    @Test func aSubSessionsTabKnowsWhoseItIs() async throws {
        defer { engine.stop() }
        engine.list([session("ses_timer", "Timer cycle", created: 1)])
        engine.on("GET", "/api/session/ses_find", json: ["data": session("ses_find", "Find the timer", parent: "ses_timer", created: 10)])
        await workspace.refresh()
        #expect(workspace.parent(of: "ses_find") == nil)
        await workspace.findParent(of: "ses_find")
        #expect(workspace.parent(of: "ses_find") == "ses_timer")
        #expect(workspace.session("ses_find") == nil, "still no row of its own")
    }
}
