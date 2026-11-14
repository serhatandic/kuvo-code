import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Sessions as the app keeps them in step with the engine: a model or mode chosen elsewhere shows
/// in the open conversation, Try Again sends a message's files again, and a session deleted while
/// it worked stops counting as working. The
/// engine is stubbed; what the app sent it is recorded.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SessionsTests {
    static let engine = "http://127.0.0.1:47997"
    let workspace = Workspace()
    let sent = Sent()
    let id = "ses_reply"

    nonisolated final class Sent: @unchecked Sendable {
        private let lock = NSLock()
        private var bodies: [[String: Any]] = []
        func add(_ body: [String: Any]) { lock.withLock { bodies.append(body) } }
        var prompts: [[String: Any]] { lock.withLock { bodies } }
    }

    init() async {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        let session: [String: Any] = [
            "id": id, "projectID": "p", "cost": 0, "title": "Fix login",
            "tokens": ["input": 0, "output": 0, "reasoning": 0, "cache": ["read": 0, "write": 0]],
            "time": ["created": 1, "updated": 2], "location": ["directory": "/tmp/kuvo-tests-project"],
            "model": ["id": "luna", "providerID": "openai"], "agent": "build",
        ]
        let listed = StubWeb.json(["data": [session]])
        StubWeb.route(Self.engine + "/api/session") { _ in listed }
        StubWeb.route(Self.engine + "/api/session/active") { _ in StubWeb.json(["data": [:]]) }
        let sent = sent
        StubWeb.handle(Self.engine + "/api/session/\(id)/prompt") { _, body in
            sent.add((try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:])
            return StubWeb.json(["data": ["id": "msg_x"]])
        }
        workspace.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: Self.engine)!, password: "test"))
        await workspace.refresh()
    }

    private func event(_ type: String, _ data: [String: Any]) throws -> ServerEvent {
        try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "type": type, "created": 1, "data": ["sessionID": id].merging(data) { $1 }]))
    }

    /// A model or mode chosen elsewhere (a bot's editor, the phone): the open conversation shows it.
    @Test func aModelChosenElsewhereShowsInTheOpenConversation() throws {
        defer { StubWeb.stop() }
        let open = try #require(workspace.model(for: id))
        workspace.handle(try event("session.model.selected", ["model": ["id": "sol", "providerID": "openai"]]))
        workspace.handle(try event("session.agent.selected", ["agent": "plan"]))
        #expect(open.session.model?.id == "sol")
        #expect(open.session.agent == "plan")
        #expect(workspace.session(id)?.model?.id == "sol")
    }

    /// Try Again on a message with a file the engine keeps inline (a machine's, a photo from the
    /// phone): the file goes again with it.
    @Test func tryAgainKeepsAnInlineFile() async throws {
        defer { StubWeb.stop() }
        let message: [String: Any] = ["id": "msg_failed", "type": "user", "time": ["created": 1], "text": "What's in this picture?",
                                      "files": [["mime": "image/png", "name": "photo.png", "data": "iVBORw0KGgo=", "source": ["type": "inline"]]]]
        let page = StubWeb.json(["data": [message]])
        StubWeb.route(Self.engine + "/api/session/\(id)/message") { _ in page }
        StubWeb.handle(Self.engine + "/api/session/\(id)/revert/stage") { _, _ in StubWeb.json(["data": ["messageID": "msg_failed"]]) }
        let open = try #require(workspace.model(for: id))
        let user = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: message))
        guard case .user(let failed) = user else { Issue.record("not a user message"); return }
        open.retry(failed)
        // Until it's gone (a moment, off the main thread).
        try await until { !sent.prompts.isEmpty }
        let files = try #require(sent.prompts.last?["files"] as? [[String: Any]])
        #expect(files.count == 1)
        #expect((files.first?["uri"] as? String)?.hasPrefix("data:image/png;base64,") == true)
    }

    @Test func aSessionDeletedWhileWorkingStopsCountingAsWorking() throws {
        defer { StubWeb.stop() }
        workspace.handle(try event("session.execution.started", [:]))
        #expect(workspace.running.contains(id))
        workspace.handle(try event("session.deleted", [:]))
        #expect(!workspace.running.contains(id))
        #expect(workspace.session(id) == nil)
    }
}
