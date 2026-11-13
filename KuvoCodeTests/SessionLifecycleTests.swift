import ClientDesign
import Foundation
import Observation
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
    /// (A folder of the test's own: the box makes and moves sessions only into one that's there.)
    let projects = AppInfo.testRoot.appending(path: "Lifecycle-\(UUID().uuidString.prefix(8))")
    var project: String { projects.appending(path: "web").path }

    init() {
        workspace.api = engine.api
    }

    private func start(_ sessions: [[String: Any]]) async throws {
        engine.list(sessions)
        engine.on("DELETE", "/api/session/*", json: [:])
        engine.on("POST", "/api/session/*", json: [:])
        engine.on("PATCH", "/api/session/*", json: [:])
        await workspace.refresh()
        try await engine.listed(for: workspace)
    }

    /// This Mac's box, its engine the stand-in: what makes and moves sessions, as the app asks it.
    private func box() async throws -> TestBox {
        let box = try await TestBox(engine: engine.url)
        try FileManager.default.createDirectory(atPath: project, withIntermediateDirectories: true)
        let url = engine.url
        workspace.boxes = { $0 == BoxClient.mac ? box.client(engine: url) : nil }
        return box
    }

    private func listed() -> [String] {
        (workspace.projects.flatMap(\.sessions) + workspace.chats).map(\.id).sorted()
    }

    @Test func deletingASessionTakesItAndItsDraftAway() async throws {
        defer { engine.stop() }
        try await start([StubEngine.session("ses_a", directory: project, created: 2), StubEngine.session("ses_b", directory: project, created: 1)])
        Drafts.shared["ses_a"].text = "half a thought"
        Drafts.shared["ses_b"].text = "another thought"
        defer { Drafts.shared.remove("ses_b") }
        var stillThere: Bool?
        workspace.onDeleted = { [workspace] id in stillThere = workspace.session(id) != nil }

        try await workspace.delete("ses_a")
        #expect(engine.requests("DELETE", "/api/session/ses_a").count == 1)
        #expect(listed() == ["ses_b"])
        #expect(Drafts.shared["ses_a"].text.isEmpty)
        #expect(Drafts.shared["ses_b"].text == "another thought")
        #expect(stillThere == true, "what goes with it (its wake-ups, its tabs) is told while it can still be read")
    }

    /// Its engine refuses (Settings › Storage's clean-up, the sidebar's Delete): it stays, with
    /// what you'd written in it, and why is said, rather than it going and coming back later.
    /// Out of the sidebar while its engine answers (a running one stops first, a machine's is
    /// over SSH), and back if it's refused.
    @Test func oneItsEngineRefusesStaysAndSaysWhy() async throws {
        defer { engine.stop() }
        try await start([StubEngine.session("ses_a", directory: project, created: 2), StubEngine.session("ses_b", directory: project, created: 1)])
        let answering = Gate()
        let refused = StubWeb.json(["message": "database is locked"], status: 500)
        engine.on("DELETE", "/api/session/*") { _ in
            answering.wait()
            return refused
        }
        Drafts.shared["ses_a"].text = "half a thought"
        defer { Drafts.shared.remove("ses_a") }

        let deleting = Task { try await workspace.delete("ses_a") }
        try await until { !engine.requests("DELETE", "/api/session/ses_a").isEmpty }
        #expect(listed() == ["ses_b"], "out of the sidebar meanwhile")
        answering.open()
        await #expect(throws: (any Error).self) { try await deleting.value }
        #expect(listed() == ["ses_a", "ses_b"])
        #expect(Drafts.shared["ses_a"].text == "half a thought")
    }

    /// Deleted from your phone while this Mac wasn't listening: its engine doesn't have it, and
    /// Delete takes it away here too.
    @Test func oneItsEngineHasNoMoreGoes() async throws {
        defer { engine.stop() }
        try await start([StubEngine.session("ses_a", directory: project, created: 2), StubEngine.session("ses_b", directory: project, created: 1)])
        engine.on("DELETE", "/api/session/*", json: ["message": "Session not found"], status: 404)

        try await workspace.delete("ses_a")
        #expect(listed() == ["ses_b"])
    }

    /// Finished while you were elsewhere: unread, on the Dock's count, until you look; archived,
    /// not counted.
    @Test func unreadUntilYouLook() async throws {
        defer { engine.stop() }
        try await start([
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

    /// Read on the phone (or another Mac): its box says so, and it's read here too, off the
    /// Dock's count; a look at an earlier finish leaves a newer one unread.
    @Test func readElsewhereIsReadHere() async throws {
        defer { engine.stop() }
        try await start([
            StubEngine.session("ses_done", directory: project, extra: ["time": ["created": 1, "updated": 9, "idle": 9, "viewed": 4]]),
            StubEngine.session("ses_again", directory: project, extra: ["time": ["created": 1, "updated": 9, "idle": 9, "viewed": 4]]),
        ])
        #expect(workspace.waitingCount == 2)
        let shown = ShownNotifications(threads: ["ses_done", "ses_again"])
        defer { shown.done() }
        workspace.handle(try engine.event("session.viewed", session: "ses_done", ["idle": 9]))
        #expect(workspace.session("ses_done")?.isUnread == false)
        try await until { shown.threads == ["ses_again"] }
        #expect(shown.threads == ["ses_again"], "its notification gone from Notification Center, the other's kept")
        workspace.handle(try engine.event("session.viewed", session: "ses_again", ["idle": 6]))
        #expect(workspace.session("ses_again")?.isUnread == true, "it finished again after that look")
        #expect(workspace.waitingCount == 1)

        // A read of it the engine answered before that look (as the run ended, on a machine):
        // the look stands.
        engine.on("GET", "/api/session/ses_done", json: ["data": StubEngine.session("ses_done", title: "Renamed", directory: project,
                                                                                     extra: ["time": ["created": 1, "updated": 10, "idle": 9, "viewed": 4]])])
        workspace.handle(try engine.event("session.renamed", session: "ses_done"))
        try await until { workspace.session("ses_done")?.title == "Renamed" }
        #expect(workspace.session("ses_done")?.isUnread == false)
    }

    /// A new session, made and sent to at once (as a demo copy's prompt does): what's said shows
    /// in its conversation as it comes, and it has its row.
    @Test func aNewSessionShowsItsFirstTurn() async throws {
        let box = try await box()
        defer { box.stop(); engine.stop(); try? FileManager.default.removeItem(at: projects) }
        try await start([])
        let made = StubEngine.session("ses_new", title: "New session", directory: project)
        engine.on("POST", "/api/session", json: ["data": made])
        engine.on("GET", "/api/session/ses_new", json: ["data": made])
        engine.conversation("ses_new", [])
        let session = try await workspace.createSession(in: project, model: nil, agent: "build")
        let model = try #require(workspace.model(for: session.id))
        model.submit("Say hi in three words.", files: [], for: nil, queue: false)
        try await until { !engine.requests("POST", "/api/session/ses_new/prompt").isEmpty }
        let sent = try #require(engine.requests("POST", "/api/session/ses_new/prompt").first?.body["id"] as? String)
        workspace.handle(try engine.event("session.created", session: "ses_new"))
        workspace.handle(try engine.event("session.inbox.enqueued", session: "ses_new", ["inboxID": sent, "item": ["type": "user", "delivery": "steer", "payload": ["text": "Say hi in three words."]]]))
        workspace.handle(try engine.event("session.execution.started", session: "ses_new"))
        workspace.handle(try engine.event("session.inbox.delivered", session: "ses_new", ["inboxID": sent]))
        let step: [String: Any] = ["assistantMessageID": "msg_02", "agent": "build", "model": ["id": "m", "providerID": "p"]]
        workspace.handle(try engine.event("session.step.started", session: "ses_new", step))
        workspace.handle(try engine.event("session.text.started", session: "ses_new", ["assistantMessageID": "msg_02", "ordinal": 0]))
        workspace.handle(try engine.event("session.text.delta", session: "ses_new", ["assistantMessageID": "msg_02", "ordinal": 0, "delta": "Hi there, friend."]))
        workspace.handle(try engine.event("session.text.ended", session: "ses_new", ["assistantMessageID": "msg_02", "ordinal": 0, "text": "Hi there, friend."]))
        let shown = try #require(workspace.model(for: "ses_new"))
        #expect(shown === model, "the conversation on screen is the one that was sent to")
        let said = shown.transcript.messages.map { message -> String in
            switch message {
            case .user(let user): user.text
            case .assistant(let reply): reply.content.compactMap { if case .text(let text) = $0 { text.text } else { nil } }.joined()
            default: ""
            }
        }
        #expect(said == ["Say hi in three words.", "Hi there, friend."])
        // (Its box lists it, as its engine does.)
        engine.lists(made)
        try await until { workspace.projects.first { $0.directory == workspace.folderPath(project) }?.sessions.map(\.id) == ["ses_new"] }
    }

    /// A session opened as it's made (a demo copy's prompt, a session another client starts): the
    /// window, asking again for the conversation as soon as anything it follows changes, shows the
    /// same one its turn goes to, not one of its own that stays empty.
    @Test func aSessionOpenedAsItsMadeShowsItsTurn() async throws {
        let box = try await box()
        defer { box.stop(); engine.stop(); try? FileManager.default.removeItem(at: projects) }
        try await start([StubEngine.session("ses_open", title: "Open", directory: project)])
        let made = StubEngine.session("ses_new", title: "New session", directory: project)
        engine.on("POST", "/api/session", json: ["data": made])
        engine.on("GET", "/api/session/ses_new", json: ["data": made])
        engine.conversation("ses_new", [])
        let session = try await workspace.createSession(in: project, model: nil, agent: "build")
        // The window, showing a conversation, looks again whenever what it read changes.
        let window = Window(workspace: workspace, id: session.id)
        withObservationTracking {
            _ = workspace.model(for: "ses_open")
        } onChange: {
            MainActor.assumeIsolated { window.look() }
        }
        let sentTo = try #require(workspace.model(for: session.id))
        #expect((window.shown ?? workspace.model(for: session.id)) === sentTo, "the conversation on screen is the one its turn goes to")
        #expect(workspace.model(for: session.id) === sentTo)
    }

    /// A window showing a session's conversation, as it asks for it.
    nonisolated private final class Window: @unchecked Sendable {
        let workspace: Workspace
        let id: String
        var shown: SessionModel?
        init(workspace: Workspace, id: String) {
            self.workspace = workspace
            self.id = id
        }
        private var looked = false
        /// Once: what it reads as it looks changes again, and the window would look again.
        @MainActor func look() {
            guard !looked else { return }
            looked = true
            shown = workspace.model(for: id)
        }
    }

    /// Renamed, archived and moved elsewhere: the lists follow.
    @Test func changesMadeElsewhereShowHere() async throws {
        defer { engine.stop() }
        try await start([StubEngine.session("ses_a", title: "Fix login", directory: project), StubEngine.session("ses_chat", title: "Question", directory: Workspace.chatsFolder)])
        engine.on("GET", "/api/session/ses_a", json: ["data": StubEngine.session("ses_a", title: "Fix the login form", directory: project)])
        workspace.handle(try engine.event("session.renamed", session: "ses_a"))
        try await until { workspace.session("ses_a")?.title == "Fix the login form" }
        #expect(workspace.session("ses_a")?.title == "Fix the login form")

        engine.on("GET", "/api/session/ses_a", json: ["data": StubEngine.session("ses_a", title: "Fix the login form", directory: project, extra: ["metadata": ["kuvo.archived": true]])])
        engine.lists(StubEngine.session("ses_a", title: "Fix the login form", directory: project, extra: ["metadata": ["kuvo.archived": true]]))
        workspace.handle(try engine.event("session.metadata.updated", session: "ses_a"))
        try await until { !listed().contains("ses_a") }
        #expect(listed() == ["ses_chat"])

        engine.on("GET", "/api/session/ses_chat", json: ["data": StubEngine.session("ses_chat", title: "Question", directory: project)])
        engine.lists(StubEngine.session("ses_chat", title: "Question", directory: project))
        workspace.handle(try engine.event("session.moved", session: "ses_chat"))
        try await until { workspace.chats.isEmpty }
        try await until { workspace.projects.first { $0.directory == project }?.sessions.map(\.id) == ["ses_chat"] }
    }

    /// A chat that turns into work, moved into a project (D4): the engine moves it, and it's the
    /// project's, with the conversation it had.
    @Test func aChatMovedIntoAProject() async throws {
        let box = try await box()
        defer { box.stop(); engine.stop(); try? FileManager.default.removeItem(at: projects) }
        try await start([StubEngine.session("ses_chat", title: "Question", directory: Workspace.chatsFolder)])
        engine.on("GET", "/api/session/ses_chat", json: ["data": StubEngine.session("ses_chat", title: "Question", directory: project)])
        try await workspace.move("ses_chat", toProject: project)
        #expect(engine.requests("POST", "/api/session/ses_chat/move").first?.body["directory"] as? String == project)
        // (Its box lists it where its engine moved it.)
        engine.lists(StubEngine.session("ses_chat", title: "Question", directory: project))
        try await until { workspace.chats.isEmpty }
        try await until { workspace.projects.first { $0.directory == project }?.sessions.map(\.id) == ["ses_chat"] }
    }
}
