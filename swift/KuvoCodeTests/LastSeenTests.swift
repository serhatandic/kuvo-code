import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Opening Kuvo Code again (A6): before its engine is up, the sidebar lists this Mac's sessions as
/// last seen, and a conversation opens as it was, to read; once the engine answers, its own takes
/// the copy's place in the same view, with what came since. The engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct LastSeenTests {
    let engine = StubEngine(port: 47985)
    let id = "ses_lastseen"
    let you: [String: Any] = ["id": "msg_01", "type": "user", "time": ["created": 1], "text": "Fix the flaky test"]
    let reply: [String: Any] = ["id": "msg_02", "type": "assistant", "agent": "build", "time": ["created": 2, "completed": 3],
                                "model": ["id": "m", "providerID": "p"], "content": [["type": "text", "text": "It waited on the clock; fixed."]]]
    let since: [String: Any] = ["id": "msg_03", "type": "user", "time": ["created": 4], "text": "Thanks, now the docs"]

    private func decoded<T: Decodable>(_ value: Any, as type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value))
    }

    @Test func aConversationOpensAsLastSeenUntilTheEngineHasIt() async throws {
        defer {
            engine.stop()
            SessionCopies.remove(id)
            SessionCopies.saveLocalSessions([])
        }
        // What earlier tests' workspaces keep of this Mac's list, a moment after it changed, kept
        // first, not over this test's.
        try await Task.sleep(for: .seconds(2.5))
        // As the app left them when it quit.
        let session = try decoded(StubEngine.session(id, title: "Flaky test", directory: "/tmp/kuvo-tests-lastseen"), as: Session.self)
        SessionCopies.saveLocalSessions([session])
        SessionCopies.save(.init(session: session, messages: try decoded([you, reply], as: [Message].self)))
        await SessionCopies.written()

        // Opened again, the engine still starting.
        let workspace = Workspace()
        #expect(workspace.session(id)?.title == "Flaky test", "listed as last seen")
        let model = try #require(workspace.model(for: id))
        #expect(model.transcript.messages.map(\.id) == ["msg_01", "msg_02"])

        // The engine is up: its conversation, with what came since, in the same view.
        engine.list([StubEngine.session(id, title: "Flaky test", directory: "/tmp/kuvo-tests-lastseen")])
        engine.conversation(id, [you, reply, since])
        workspace.api = engine.api
        await workspace.refresh()
        try await until { model.transcript.messages.count == 3 }
        #expect(workspace.model(for: id) === model, "the same conversation, read in place")
        #expect(model.transcript.messages.map(\.id) == ["msg_01", "msg_02", "msg_03"])
    }
}
