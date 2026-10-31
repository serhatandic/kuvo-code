import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What a permission card shows (B10): a command the agent wants to run as the one line it wrote,
/// pipes and && included, though the engine asks about each command in it on its own. The engine
/// is stubbed.
@MainActor
@Suite(.serialized) struct PermissionCardsTests {
    let engine = StubEngine(port: 47988)
    let workspace = Workspace()
    let id = "ses_permission"

    init() {
        workspace.api = engine.api
    }

    private func open(_ conversation: [[String: Any]]) async throws -> SessionModel {
        engine.list([StubEngine.session(id, title: "Permissions", directory: "/tmp/kuvo-tests-permissions")], running: [id])
        engine.conversation(id, conversation)
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        return model
    }

    private let ask: [String: Any] = [
        "id": "per_1", "sessionID": "ses_permission", "action": "shell", "resources": ["npm test", "tail -5"],
        "source": ["type": "tool", "messageID": "msg_step", "id": "call_1"],
    ]

    @Test func aPipedCommandIsAskedAsOneLine() async throws {
        defer { engine.stop() }
        let model = try await open([
            ["id": "msg_you", "type": "user", "time": ["created": 1], "text": "Run the tests"],
            ["id": "msg_step", "type": "assistant", "agent": "build", "time": ["created": 2], "model": ["id": "m", "providerID": "p"],
             "content": [["type": "tool", "id": "call_1", "name": "shell", "executed": true,
                          "state": ["status": "running", "input": ["command": "npm test | tail -5"]]]]],
        ])
        workspace.handle(try engine.event("permission.asked", ask))
        #expect(model.permissions.map(\.id) == ["per_1"])
        #expect(model.permissionCommands["per_1"] == "npm test | tail -5")
    }

    /// Stopped while it asks: the engine lets the ask go without a word, so its card and the
    /// session's "needs you" go with the run, as do a subagent's when its own run ends.
    @Test func anAskGoesWhenItsRunIsStopped() async throws {
        defer { engine.stop() }
        let helper = "ses_permission_helper"
        engine.on("GET", "/api/session/\(helper)", json: ["data": StubEngine.session(helper, title: "Check", directory: "/tmp/kuvo-tests-permissions", extra: ["parentID": id])])
        let model = try await open([["id": "msg_you", "type": "user", "time": ["created": 1], "text": "Run the tests"]])
        workspace.handle(try engine.event("permission.asked", ask))
        workspace.handle(try engine.event("permission.asked", ["id": "per_2", "sessionID": helper, "action": "shell", "resources": ["curl example.com"]]))
        try await until { model.permissions.count == 2 }
        #expect(workspace.needsAttention(id))

        workspace.handle(try engine.event("session.execution.interrupted", session: id, ["reason": "user"]))
        #expect(model.permissions.map(\.id) == ["per_2"], "the subagent's own run goes on")
        workspace.handle(try engine.event("session.execution.interrupted", session: helper, ["reason": "user"]))
        #expect(model.permissions.isEmpty)
        #expect(!workspace.needsAttention(id))
    }

    /// A coding agent's session, one the list doesn't have yet: its bridge says itself when an ask
    /// goes (a subagent of theirs in the background still asks after the turn), so its turn ending
    /// leaves it waiting on you.
    @Test func aCodingAgentsAskOutlivesItsTurn() async throws {
        defer { engine.stop() }
        let agents = "ses_permission_agent"
        workspace.handleAgents(try engine.event("permission.asked", ["id": "per_9", "sessionID": agents, "action": "shell", "resources": ["npm test"]]))
        workspace.handleAgents(try engine.event("session.execution.succeeded", session: agents))
        #expect(workspace.needsAttention(agents))
    }

    /// Stopped as soon as a subagent the app didn't know yet asks: its card doesn't come once
    /// it's found.
    @Test func anAskStoppedBeforeItsSubagentIsFoundStaysGone() async throws {
        defer { engine.stop() }
        let helper = "ses_permission_new_helper"
        engine.on("GET", "/api/session/\(helper)", json: ["data": StubEngine.session(helper, title: "Check", directory: "/tmp/kuvo-tests-permissions", extra: ["parentID": id])])
        let model = try await open([["id": "msg_you", "type": "user", "time": ["created": 1], "text": "Run the tests"]])
        workspace.handle(try engine.event("permission.asked", ["id": "per_3", "sessionID": helper, "action": "shell", "resources": ["curl example.com"]]))
        workspace.handle(try engine.event("session.execution.interrupted", session: helper, ["reason": "user"]))
        try await until { workspace.parent(of: helper) == id }
        #expect(model.permissions.isEmpty)
        #expect(!workspace.needsAttention(id))
    }

    /// The ask can come before the step's own word of the command reaches the app (a step read
    /// again, events in another order): the card shows the whole line once it does.
    @Test func theLineShowsOnceTheStepHasIt() async throws {
        defer { engine.stop() }
        let model = try await open([
            ["id": "msg_you", "type": "user", "time": ["created": 1], "text": "Run the tests"],
            ["id": "msg_step", "type": "assistant", "agent": "build", "time": ["created": 2], "model": ["id": "m", "providerID": "p"], "content": []],
        ])
        workspace.handle(try engine.event("permission.asked", ask))
        workspace.handle(try engine.event("session.tool.input.started", session: id, ["assistantMessageID": "msg_step", "id": "call_1", "name": "shell"]))
        workspace.handle(try engine.event("session.tool.called", session: id, ["assistantMessageID": "msg_step", "id": "call_1", "input": ["command": "npm test | tail -5"]]))
        #expect(model.permissionCommands["per_1"] == "npm test | tail -5")
    }
}
