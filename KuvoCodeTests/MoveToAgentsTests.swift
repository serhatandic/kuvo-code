import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Picking a coding agent's model (Claude Code, say) in a conversation the engine was running
/// (B14): it carries on with the coding agents, in a session of theirs that has the whole
/// conversation, without what an undo you haven't kept took back, and the messages you'd left
/// waiting, still waiting; what you were typing comes along. The engine's session goes to
/// Archived, and what waited there doesn't also run there. (Its tab: `WindowTabsTests`.)
/// The engine and the agents' bridge are stubbed.
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

    private func done() {
        agents.disconnect()
        engine.stop()
        Drafts.shared.remove(id)
        Drafts.shared.remove("ses_agent")
    }

    private func text(_ id: String, _ text: String, created: Double) -> [String: Any] {
        ["id": id, "type": "user", "time": ["created": created], "text": text]
    }

    private func reply(_ id: String, _ text: String, created: Double) -> [String: Any] {
        ["id": id, "type": "assistant", "agent": "build", "time": ["created": created, "completed": created + 0.5],
         "model": ["id": "glm", "providerID": "opencode"], "content": [["type": "text", "text": text]]]
    }

    @Test func theConversationCarriesOnWithTheAgents() async throws {
        defer { done() }
        let conversation = [
            text("msg_01", "Add a settings page", created: 1), reply("msg_02", "Added SettingsView.", created: 2),
            text("msg_03", "Make it dark", created: 3), reply("msg_04", "Dark now.", created: 4),
        ]
        // The last turn undone, not yet kept.
        let session = StubEngine.session(id, title: "Settings", directory: folder, extra: ["revert": ["messageID": "msg_03"]])
        engine.list([session])
        engine.conversation(id, conversation)
        engine.on("GET", "/api/session/\(id)", json: ["data": session])
        engine.on("GET", "/api/session/\(id)/inbox", json: ["data": [
            ["id": "inb_1", "sessionID": id, "type": "user", "delivery": "queue", "text": "Then add a toggle", "payload": ["text": "Then add a toggle"]],
        ]])
        engine.on("DELETE", "/api/session/\(id)/inbox/*", json: [:])
        engine.on("PATCH", "/api/session/\(id)", json: [:])
        bridge.on("POST", "/api/session/import", json: ["data": StubEngine.session("ses_agent", title: "Settings", directory: folder)])
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
    }

    /// Its side panel goes with it: the page it had open (signed in, say) is the new session's,
    /// the one its agent goes on browsing in, not left running behind the archived one.
    @Test func itsPanelGoesWithIt() async throws {
        defer { done() }
        let app = AppModel()
        app.workspace.api = engine.api
        app.workspace.agents = agents
        // As the app has it (AppModel.start).
        app.workspace.onMovedToAgents = { [weak app] from, to in await app?.movedToAgents(from: from, to: to) ?? false }
        engine.list([StubEngine.session(id, title: "Docs", directory: folder)])
        engine.conversation(id, [text("msg_01", "Check the docs site", created: 1)])
        engine.on("GET", "/api/session/\(id)", json: ["data": StubEngine.session(id, title: "Docs", directory: folder)])
        engine.on("GET", "/api/session/\(id)/inbox", json: ["data": []])
        engine.on("PATCH", "/api/session/\(id)", json: [:])
        bridge.on("POST", "/api/session/import", json: ["data": StubEngine.session("ses_agent", title: "Docs", directory: folder)])
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
