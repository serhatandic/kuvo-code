import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Picking a coding agent's model (Claude Code, say) in a conversation the engine was running
/// (B14): its box carries it on with the coding agents (`POST kuvo/sessions/<id>/agents`, as a
/// phone's pick does), in a session of theirs that has the whole conversation, without what an undo
/// you haven't kept took back, and the messages you'd left waiting, still waiting; what you were
/// typing comes along. The engine's session goes to Archived, and what waited there doesn't also
/// run there. (Its tab: `WindowTabsTests`; the box's own part: the bridge's to-agents.test.js.)
/// The engine and the agents' bridge are stubbed; this Mac's box is real.
@MainActor
@Suite(.serialized) struct MoveToAgentsTests {
    let engine = StubEngine(port: 47995)
    let bridge = StubEngine(port: 47996, alongside: true)
    let workspace = Workspace()
    let agents = OutsideAgents()
    let id = "ses_engine"
    let folder = "/tmp/kuvo-tests-move"

    init() {
        workspace.api = engine.api
        workspace.agents = agents
        agents.connect(bridge.api.client.endpoint, folderPrefix: "")
    }

    private func done(_ box: TestBox? = nil) {
        box?.stop()
        agents.disconnect()
        engine.stop()
        Drafts.shared.remove(id)
        Drafts.shared.remove("ses_agent")
    }

    /// This Mac's box, which finds the engine and the bridge, as the app's stores reach it.
    private func startBox(for workspace: Workspace) async throws -> TestBox {
        let box = try await TestBox(engine: engine.url)
        try await box.agents(at: bridge.url)
        workspace.boxes = { [engine] _ in box.client(engine: engine.url) }
        return box
    }

    /// `session` as the engine keeps it: what's changed in its metadata is there when it's read again.
    private func kept(_ session: [String: Any]) {
        let now = Guarded(session)
        engine.on("GET", "/api/session/\(id)") { _ in StubWeb.json(["data": now.withLock { $0 }]) }
        engine.on("PATCH", "/api/session/\(id)") { request in
            StubWeb.json(["data": now.withLock { session in
                var metadata = session["metadata"] as? [String: Any] ?? [:]
                for (key, value) in request.body["metadata"] as? [String: Any] ?? [:] { metadata[key] = value }
                session["metadata"] = metadata
                return session
            }])
        }
    }

    /// The coding agents' session it goes on in, as their bridge has it.
    private func theirs(_ title: String) {
        let session = StubEngine.session("ses_agent", title: title, directory: folder, extra: ["metadata": ["kuvoAgent": "claude"]])
        bridge.on("POST", "/api/session/import", json: ["data": session])
        bridge.on("GET", "/api/session/ses_agent", json: ["data": session])
    }

    private func text(_ id: String, _ text: String, created: Double) -> [String: Any] {
        ["id": id, "type": "user", "time": ["created": created], "text": text]
    }

    private func reply(_ id: String, _ text: String, created: Double) -> [String: Any] {
        ["id": id, "type": "assistant", "agent": "build", "time": ["created": created, "completed": created + 0.5],
         "model": ["id": "glm", "providerID": "opencode"], "content": [["type": "text", "text": text]]]
    }

    /// A coding agent's subagent open on its own keeps following its work when the agents'
    /// bridge comes back after dropping (the Mac waking up): its view isn't left on a model that
    /// no longer hears anything.
    @Test func aSubagentOpenKeepsFollowingAfterTheBridgeComesBack() async throws {
        defer { done() }
        let metadata: [String: Any] = ["metadata": ["kuvoAgent": "claude"]]
        let parent = StubEngine.session("ses_agent", title: "Settings", directory: folder, extra: metadata)
        let child = StubEngine.session("ses_helper", title: "Explore", directory: folder, extra: metadata.merging(["parentID": "ses_agent"]) { $1 })
        bridge.list([parent, child])
        bridge.on("GET", "/api/session/ses_helper", json: ["data": child])
        engine.list([])
        await workspace.refresh()
        await workspace.refreshAgents()
        let open = try #require(await workspace.subagentModel(for: "ses_helper", in: folder))
        // The bridge back after dropping.
        await workspace.refreshAgents()
        #expect(await workspace.subagentModel(for: "ses_helper", in: folder) === open, "the open view's model still gets its events")
    }

    @Test func theConversationCarriesOnWithTheAgents() async throws {
        let box = try await startBox(for: workspace)
        defer { done(box) }
        let conversation = [
            text("msg_01", "Add a settings page", created: 1), reply("msg_02", "Added SettingsView.", created: 2),
            text("msg_03", "Make it dark", created: 3), reply("msg_04", "Dark now.", created: 4),
        ]
        // The last turn undone, not yet kept.
        let session = StubEngine.session(id, title: "Settings", directory: folder, extra: ["revert": ["messageID": "msg_03"]])
        engine.list([session])
        engine.conversation(id, conversation)
        kept(session)
        engine.on("GET", "/api/session/\(id)/inbox", json: ["data": [
            ["id": "inb_1", "sessionID": id, "type": "user", "delivery": "queue", "text": "Then add a toggle", "payload": ["text": "Then add a toggle"]],
        ]])
        engine.on("DELETE", "/api/session/\(id)/inbox/*", json: [:])
        theirs("Settings")
        await workspace.refresh()
        Drafts.shared[id] = Drafts.Draft(text: "and a font size")

        try await workspace.moveToAgents(id, model: ModelRef(id: "sonnet", providerID: "claude-code"))

        let imported = try #require(bridge.requests("POST", "/api/session/import").first)
        #expect((imported.body["model"] as? [String: String]) == ["id": "sonnet", "providerID": "claude-code"])
        let carried = (imported.body["messages"] as? [[String: Any]])?.compactMap { $0["id"] as? String }
        #expect(carried == ["msg_01", "msg_02"], "the conversation, without what the undo took back")
        let waiting = (imported.body["waiting"] as? [[String: Any]])?.compactMap { $0["text"] as? String }
        #expect(waiting == ["Then add a toggle"], "what waited comes along, still waiting")
        #expect(engine.requests("DELETE", "/api/session/\(id)/inbox/inb_1").count == 1, "and doesn't also run on the engine")
        #expect(Drafts.shared["ses_agent"].text == "and a font size", "what you were typing comes along")
        #expect(workspace.session("ses_agent") != nil)
        #expect(Workspace.isArchived(try #require(workspace.session(id))), "the engine's goes to Archived")
        let archived = try #require(engine.requests("PATCH", "/api/session/\(id)").last)
        #expect((archived.body["metadata"] as? [String: Any])?["kuvo.carriedTo"] as? String == "ses_agent",
                "marked as carried on there: what waits on the box goes on there")
    }

    /// A move its box can't finish (the engine didn't take the change) leaves everything as it was:
    /// the conversation where it is, not archived, what you were typing in it, nothing left with the
    /// coding agents, and why, from the box.
    @Test func aMoveThatFailsLeavesItAsItWas() async throws {
        let box = try await startBox(for: workspace)
        defer { done(box) }
        let session = StubEngine.session(id, title: "Settings", directory: folder)
        engine.list([session])
        engine.conversation(id, [text("msg_01", "Add a settings page", created: 1)])
        engine.on("GET", "/api/session/\(id)", json: ["data": session])
        engine.on("GET", "/api/session/\(id)/inbox", json: ["data": []])
        engine.on("PATCH", "/api/session/\(id)", json: ["message": "The database is locked."], status: 500)
        theirs("Settings")
        bridge.on("DELETE", "/api/session/ses_agent", json: [:])
        await workspace.refresh()
        Drafts.shared[id] = Drafts.Draft(text: "and a font size")

        await #expect(throws: BoxRefusal.self) {
            try await workspace.moveToAgents(id, model: ModelRef(id: "sonnet", providerID: "claude-code"))
        }
        #expect(bridge.requests("DELETE", "/api/session/ses_agent").count == 1, "the copy it made goes")
        #expect(!Workspace.isArchived(try #require(workspace.session(id))))
        #expect(Drafts.shared[id].text == "and a font size", "what you were typing stays where it was")
        #expect(Drafts.shared["ses_agent"].isEmpty)
    }

    /// The move takes a while (the run stopped, the whole conversation read and handed over).
    /// Sent meanwhile, a message isn't left in the engine's session, which goes to Archived: it
    /// stays in the composer, says why, and goes to the new session with all you'd written, to
    /// the last moment, none of it also left behind in the old one.
    @Test func whatYouSendWhileItMovesGoesWithIt() async throws {
        let box = try await startBox(for: workspace)
        defer { done(box) }
        let session = StubEngine.session(id, title: "Settings", directory: folder)
        engine.list([session])
        engine.conversation(id, [text("msg_01", "Add a settings page", created: 1)])
        kept(session)
        engine.on("GET", "/api/session/\(id)/inbox", json: ["data": []])
        engine.on("POST", "/api/session/\(id)/prompt", json: ["data": [:]])
        let handing = Gate()
        let agentSession = StubEngine.session("ses_agent", title: "Settings", directory: folder)
        let imported = StubWeb.json(["data": agentSession])
        bridge.on("POST", "/api/session/import") { _ in
            handing.wait()
            return imported
        }
        bridge.on("GET", "/api/session/ses_agent", json: ["data": agentSession])
        await workspace.refresh()
        let old = try #require(workspace.model(for: id))

        let moving = Task { try await workspace.moveToAgents(id, model: ModelRef(id: "sonnet", providerID: "claude-code")) }
        try await until { !bridge.requests("POST", "/api/session/import").isEmpty }
        old.draftText = "and a font size"
        old.submitDraft(for: nil, queue: false)
        #expect(old.draftText == "and a font size", "it stays in the composer")
        #expect(old.failure != nil, "and says why")
        handing.open()
        _ = try await moving.value

        #expect(engine.requests("POST", "/api/session/\(id)/prompt").isEmpty, "nothing went to the engine's session")
        #expect(Drafts.shared["ses_agent"].text == "and a font size", "it's in the new session's composer")
        #expect(Drafts.shared[id].isEmpty, "and not also left in the archived one's")
    }

    /// Its side panel goes with it: the page it had open (signed in, say) is the new session's,
    /// the one its agent goes on browsing in, not left running behind the archived one.
    @Test func itsPanelGoesWithIt() async throws {
        let app = AppModel()
        app.workspace.api = engine.api
        app.workspace.agents = agents
        let box = try await startBox(for: app.workspace)
        defer { done(box) }
        // As the app has it (AppModel.start).
        app.workspace.onMovedToAgents = { [weak app] from, to in await app?.movedToAgents(from: from, to: to) ?? false }
        let session = StubEngine.session(id, title: "Docs", directory: folder)
        engine.list([session])
        engine.conversation(id, [text("msg_01", "Check the docs site", created: 1)])
        kept(session)
        engine.on("GET", "/api/session/\(id)/inbox", json: ["data": []])
        theirs("Docs")
        await app.workspace.refresh()
        let panel = app.utilities
        panel.inView = .init(session: id)
        let page = panel.newBrowser("about:blank")
        panel.agentWorks(id, in: page)
        let pageID = try #require(panel.id(of: page))

        try await app.workspace.moveToAgents(id, model: ModelRef(id: "sonnet", providerID: "claude-code"))
        panel.inView = .init(session: "ses_agent")
        #expect(panel.visibleTabs.contains { $0.id == pageID }, "the page is in the new session's panel")
        #expect(panel.agentBrowser(for: "ses_agent") === page, "and its agent goes on in it")
        panel.inView = .init(session: id)
        #expect(!panel.visibleTabs.contains { $0.id == pageID }, "not left with the archived one")
    }
}
