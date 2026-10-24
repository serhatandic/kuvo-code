import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A phone picks a coding agent's model (Claude Code, say) in a conversation the engine was
/// running: the Mac carries it on with the coding agents, as picking it there does, and answers
/// with the new conversation, for the phone to open; the engine's goes to Archived. Nothing opens
/// on the Mac. A model that isn't theirs, a conversation there isn't, or one with them already is
/// turned away. The engine and the agents' bridge are stubbed.
@MainActor
@Suite(.serialized) struct PhoneMovesToAgentsTests {
    let engine = StubEngine(port: 47993)
    let bridge = StubEngine(port: 47994, alongside: true)
    let app = AppModel()
    let link = PhoneLink()
    let id = "ses_phone_engine"
    let folder = "/tmp/kuvo-tests-phone-move"

    init() {
        app.bots.app = app
        app.workspace.api = engine.api
        app.workspace.agents = app.agents
        app.agents.connect(bridge.api.client.endpoint, folderPrefix: "")
        link.bots = app.bots
        link.workspace = app.workspace
    }

    private func done() {
        app.agents.disconnect()
        engine.stop()
        Drafts.shared.remove(id)
        Drafts.shared.remove("ses_phone_agent")
    }

    private func ask(_ path: String, body: [String: Any]) async throws -> (status: Int, json: [String: Any]?) {
        let request = LinkRequest(method: "POST", path: path, headers: ["content-type": "application/json"], body: try JSONSerialization.data(withJSONObject: body))
        var status = 0
        var answer = Data()
        for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: engine.url + "/")!, password: nil, agents: nil) {
            switch part {
            case .head(let code, _): status = code
            case .body(let chunk): answer += chunk
            }
        }
        return (status, try? JSONSerialization.jsonObject(with: answer) as? [String: Any])
    }

    @Test func aPhoneMovesAConversationToTheCodingAgents() async throws {
        defer { done() }
        let session = StubEngine.session(id, title: "Settings", directory: folder)
        engine.list([session])
        engine.conversation(id, [["id": "msg_01", "type": "user", "time": ["created": 1], "text": "Add a settings page"]])
        engine.on("GET", "/api/session/\(id)", json: ["data": session])
        engine.on("GET", "/api/session/\(id)/inbox", json: ["data": []])
        engine.on("PATCH", "/api/session/\(id)", json: [:])
        bridge.on("POST", "/api/session/import", json: ["data": StubEngine.session("ses_phone_agent", title: "Settings", directory: folder, extra: ["metadata": ["kuvoAgent": "claude"]])])
        await app.workspace.refresh()
        let sonnet: [String: Any] = ["model": ["id": "sonnet", "providerID": "claude-code"]]

        let notTheirs = try await ask("kuvo/sessions/\(id)/agents", body: ["model": ["id": "glm", "providerID": "opencode"]])
        #expect(notTheirs.status == 400)
        #expect(try await ask("kuvo/sessions/ses_nowhere/agents", body: sonnet).status == 404)

        let moved = try await ask("kuvo/sessions/\(id)/agents", body: sonnet)
        #expect(moved.status == 200)
        #expect(moved.json?["session"] as? String == "ses_phone_agent")
        let imported = try #require(bridge.requests("POST", "/api/session/import").first)
        #expect((imported.body["messages"] as? [[String: Any]])?.compactMap { $0["id"] as? String } == ["msg_01"])
        #expect(Workspace.isArchived(try #require(app.workspace.session(id))), "the engine's goes to Archived")
        #expect(app.tabs.keys.isEmpty, "nothing opens on the Mac for a move from a phone")

        // With them already: turned away.
        #expect(try await ask("kuvo/sessions/ses_phone_agent/agents", body: sonnet).status == 409)
    }
}
