import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A session's life in the sidebar (B18, D4): deleting one takes it and what you'd written in it
/// away and nothing else's; one that finished while you were elsewhere is unread, counted on the
/// Dock, until you look at it; one renamed, archived or moved elsewhere (the phone, another Mac)
/// follows here; a chat moved into a project goes there. The engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SessionLifecycleTests {
    let engine = StubEngine(port: 47987)
    let workspace = Workspace()
    let project = "/tmp/kuvo-tests-lifecycle/web"

    init() {
        workspace.api = engine.api
    }

    private func start(_ sessions: [[String: Any]]) async {
        engine.list(sessions)
        engine.on("DELETE", "/api/session/*", json: [:])
        engine.on("POST", "/api/session/*", json: [:])
        engine.on("PATCH", "/api/session/*", json: [:])
        await workspace.refresh()
    }

    private func listed() -> [String] {
        (workspace.projects.flatMap(\.sessions) + workspace.chats).map(\.id).sorted()
    }

    @Test func deletingASessionTakesItAndItsDraftAway() async throws {
        defer { engine.stop() }
        await start([StubEngine.session("ses_a", directory: project, created: 2), StubEngine.session("ses_b", directory: project, created: 1)])
        Drafts.shared["ses_a"].text = "half a thought"
        Drafts.shared["ses_b"].text = "another thought"
        defer { Drafts.shared.remove("ses_b") }
        var stillThere: Bool?
        workspace.onDeleted = { [workspace] id in stillThere = workspace.session(id) != nil }

        await workspace.delete("ses_a")
        #expect(engine.requests("DELETE", "/api/session/ses_a").count == 1)
        #expect(listed() == ["ses_b"])
        #expect(Drafts.shared["ses_a"].text.isEmpty)
        #expect(Drafts.shared["ses_b"].text == "another thought")
        #expect(stillThere == true, "what goes with it (its wake-ups, its tabs) is told while it can still be read")
    }

    /// Finished while you were elsewhere: unread, on the Dock's count, until you look; archived,
    /// not counted.
    @Test func unreadUntilYouLook() async throws {
        defer { engine.stop() }
        await start([
            StubEngine.session("ses_done", directory: project, extra: ["time": ["created": 1, "updated": 9, "idle": 9, "viewed": 4]]),
            StubEngine.session("ses_seen", directory: project, extra: ["time": ["created": 1, "updated": 9, "idle": 5, "viewed": 5]]),
            StubEngine.session("ses_old", directory: project, extra: ["time": ["created": 1, "updated": 9, "idle": 9, "viewed": 1], "metadata": ["kuvo.archived": true]]),
        ])
        #expect(workspace.waitingCount == 1)
        workspace.markViewed("ses_done")
        #expect(workspace.waitingCount == 0)
        #expect(workspace.session("ses_done")?.isUnread == false)
        try await until { !engine.requests("POST", "/api/session/ses_done/view").isEmpty }
        #expect(engine.requests("POST", "/api/session/ses_done/view").first?.body["idle"] as? Double == 9)
    }

    /// Renamed, archived and moved elsewhere: the lists follow.
    @Test func changesMadeElsewhereShowHere() async throws {
        defer { engine.stop() }
        await start([StubEngine.session("ses_a", title: "Fix login", directory: project), StubEngine.session("ses_chat", title: "Question", directory: Workspace.chatsFolder)])
        engine.on("GET", "/api/session/ses_a", json: ["data": StubEngine.session("ses_a", title: "Fix the login form", directory: project)])
        workspace.handle(try engine.event("session.renamed", session: "ses_a"))
        try await until { workspace.session("ses_a")?.title == "Fix the login form" }
        #expect(workspace.session("ses_a")?.title == "Fix the login form")

        engine.on("GET", "/api/session/ses_a", json: ["data": StubEngine.session("ses_a", title: "Fix the login form", directory: project, extra: ["metadata": ["kuvo.archived": true]])])
        workspace.handle(try engine.event("session.metadata.updated", session: "ses_a"))
        try await until { !listed().contains("ses_a") }
        #expect(listed() == ["ses_chat"])

        engine.on("GET", "/api/session/ses_chat", json: ["data": StubEngine.session("ses_chat", title: "Question", directory: project)])
        workspace.handle(try engine.event("session.moved", session: "ses_chat"))
        try await until { workspace.chats.isEmpty }
        #expect(workspace.projects.first { $0.directory == project }?.sessions.map(\.id) == ["ses_chat"])
    }

    /// A chat that turns into work, moved into a project (D4): the engine moves it, and it's the
    /// project's, with the conversation it had.
    @Test func aChatMovedIntoAProject() async throws {
        defer { engine.stop() }
        await start([StubEngine.session("ses_chat", title: "Question", directory: Workspace.chatsFolder)])
        engine.on("GET", "/api/session/ses_chat", json: ["data": StubEngine.session("ses_chat", title: "Question", directory: project)])
        try await workspace.move("ses_chat", toProject: project)
        #expect(engine.requests("POST", "/api/session/ses_chat/move").first?.body["directory"] as? String == project)
        #expect(workspace.chats.isEmpty)
        #expect(workspace.projects.first { $0.directory == project }?.sessions.map(\.id) == ["ses_chat"])
    }
}
