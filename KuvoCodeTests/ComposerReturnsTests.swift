import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What goes back to the composer: a message the engine didn't take (with its comments, ahead of
/// what you wrote meanwhile, and why it didn't go), and one you undo, which Redo takes back out.
/// The engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ComposerReturnsTests {
    static let engine = "http://127.0.0.1:47994"
    let workspace = Workspace()
    let id = "ses_composer_\(UUID().uuidString.prefix(8))"

    init() async {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        let session: [String: Any] = [
            "id": id, "projectID": "p", "cost": 0, "title": "Composer",
            "tokens": ["input": 0, "output": 0, "reasoning": 0, "cache": ["read": 0, "write": 0]],
            "time": ["created": 1, "updated": 2], "location": ["directory": "/tmp/kuvo-tests-composer"],
        ]
        let listed = StubWeb.json(["data": [session]])
        StubWeb.route(Self.engine + "/api/session") { _ in listed }
        StubWeb.route(Self.engine + "/api/session/active") { _ in StubWeb.json(["data": [:]]) }
        workspace.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: Self.engine)!, password: "test"))
        await workspace.refresh()
    }

    private func done() {
        StubWeb.stop()
        Drafts.shared.remove(id)
    }

    @Test func aMessageTheEngineDidntTakeComesBackWhole() async throws {
        defer { done() }
        StubWeb.handle(Self.engine + "/api/session/\(id)/prompt") { _, _ in StubWeb.json(["message": "Model is overloaded"], status: 400) }
        let model = try #require(workspace.model(for: id))
        model.reviewComments = [ReviewComment(file: "a.swift", line: 2, side: .new, snippet: "x", text: "Rename x")]
        model.send("Fix the build", for: nil)
        #expect(model.draftText.isEmpty)
        model.draftText = "and the tests"
        try await until { model.failure != nil }
        #expect(model.draftText == "Fix the build\n\nand the tests")
        #expect(model.reviewComments.map(\.text) == ["Rename x"])
        #expect(model.failure != nil)
    }

    /// A conversation on a model whose account you signed out of: said at once, naming what to
    /// sign in to, and nothing sent (the engine takes such a message and drops it without a
    /// word); your message stays to send once you've signed in or picked another model.
    @Test func aModelYouSignedOutOfSaysSoAndKeepsYourMessage() async throws {
        defer { done() }
        StubWeb.handle(Self.engine + "/api/session/\(id)/prompt") { _, _ in StubWeb.json([:]) }
        let location = ["directory": "/"]
        let model: [String: Any] = ["id": "luna", "modelID": "luna", "providerID": "openai", "name": "Luna",
                                    "capabilities": ["tools": true, "input": ["text"], "output": ["text"]], "variants": [],
                                    "time": ["released": 1], "cost": [["input": 1, "output": 1]], "status": "active", "enabled": true,
                                    "limit": ["context": 100_000, "output": 8_000]]
        try StubWeb.answer(Self.engine + "/api/integration", json: ["location": location, "data": [["id": "openai", "name": "OpenAI", "methods": [["type": "key"]], "connections": []]]])
        try StubWeb.answer(Self.engine + "/api/model", json: ["location": location, "data": [model]])
        try StubWeb.answer(Self.engine + "/api/model/default", json: ["location": location, "data": NSNull()])
        try StubWeb.answer(Self.engine + "/api/agent", json: ["location": location, "data": []])
        try StubWeb.answer(Self.engine + "/api/command", json: ["location": location, "data": []])
        let catalog = Catalog(isMac: true)
        catalog.api = workspace.api
        await catalog.refresh()
        let luna = ModelRef(id: "luna", providerID: "openai")
        #expect(catalog.needsSignIn(luna))
        // One only missing from the list (a coding agent's, as it starts, lists a few at first)
        // goes on to its agent, which says for itself if it can't run it.
        #expect(!catalog.needsSignIn(ModelRef(id: "opus[1m]", providerID: "claude-code")))
        #expect(!catalog.needsSignIn(ModelRef(id: "mystery", providerID: "elsewhere")))

        let conversation = try #require(workspace.model(for: id))
        conversation.draftText = "Summarize the release"
        conversation.submitDraft(for: catalog.model(luna), queue: false, commands: [], unavailable: catalog.unavailable(luna))
        #expect(conversation.draftText == "Summarize the release", "kept, to send once you can")
        let said = try #require(conversation.failure)
        #expect(said.contains("Luna") && said.contains("ChatGPT plan") && said.contains("Settings › Accounts"), "\(said)")
        #expect(!StubWeb.asked.contains { $0.hasSuffix("/prompt") }, "nothing sent into the void")
        // A "!" command needs no model, and runs.
        conversation.draftText = "!ls"
        conversation.submitDraft(for: nil, queue: false, commands: [], unavailable: catalog.unavailable(luna))
        #expect(conversation.failure == nil)
    }

    @Test func undoPutsItBackAndRedoTakesItOut() async throws {
        defer { done() }
        let sent: [String: Any] = ["id": "msg_sent", "type": "user", "time": ["created": 1], "text": "Refactor the parser"]
        let page = StubWeb.json(["data": [sent]])
        StubWeb.route(Self.engine + "/api/session/\(id)/message") { _ in page }
        StubWeb.handle(Self.engine + "/api/session/\(id)/revert") { request, _ in
            request.httpMethod == "DELETE" ? StubWeb.json([:]) : StubWeb.json(["data": ["messageID": "msg_sent"]])
        }
        let model = try #require(workspace.model(for: id))
        model.draftText = "half a thought"
        guard case .user(let message) = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: sent)) else { return }
        model.undo(from: message)
        try await until { model.draftText.contains("Refactor") }
        #expect(model.draftText == "Refactor the parser\n\nhalf a thought")
        #expect(model.session.revert?.messageID == "msg_sent")
        model.redo()
        try await until { model.session.revert == nil }
        #expect(model.draftText == "half a thought")
    }

    /// Sent while the agent works, with Queue: it waits its turn. With nothing running: now.
    @Test func whileItWorksAMessageWaitsItsTurn() async throws {
        defer { done() }
        let bodies = Bodies()
        StubWeb.handle(Self.engine + "/api/session/\(id)/prompt") { _, body in
            bodies.add((try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["delivery"] as? String ?? "")
            return StubWeb.json(["data": ["id": "x"]])
        }
        let model = try #require(workspace.model(for: id))
        model.send("first", for: nil, queue: true)
        try await until { bodies.all.count == 1 }
        #expect(bodies.all == ["steer"])
        let started = try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": "e1", "type": "session.execution.started", "created": 1, "data": ["sessionID": id]]))
        workspace.handle(started)
        model.send("second", for: nil, queue: true)
        try await until { bodies.all.count == 2 }
        #expect(bodies.all.last == "queue")
    }

    nonisolated final class Bodies: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [String] = []
        func add(_ delivery: String) {
            lock.withLock { list.append(delivery) }
            TestPulse.beat()
        }
        var all: [String] { lock.withLock { list } }
    }

    /// The agent asks to run a command: the ask shows in the conversation; your answer (from a
    /// notification too) goes to the engine, and the ask goes once the engine has it.
    @Test func aPermissionAskedAndAnswered() async throws {
        defer { done() }
        let bodies = Bodies()
        StubWeb.handle(Self.engine + "/api/session/\(id)/permission/") { request, body in
            bodies.add((try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["decision"] as? String ?? "")
            return StubWeb.json([:])
        }
        let model = try #require(workspace.model(for: id))
        func event(_ type: String, _ data: [String: Any]) throws -> ServerEvent {
            try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "type": type, "created": 1, "data": data]))
        }
        workspace.handle(try event("permission.asked", ["id": "per_1", "sessionID": id, "action": "shell", "resources": ["rm -rf build"]]))
        #expect(model.permissions.map(\.id) == ["per_1"])
        workspace.answer("per_1", in: id, with: .once)
        try await until { !bodies.all.isEmpty }
        #expect(bodies.all == ["once"])
        workspace.handle(try event("permission.replied", ["sessionID": id, "requestID": "per_1"]))
        #expect(model.permissions.isEmpty)
    }
}
