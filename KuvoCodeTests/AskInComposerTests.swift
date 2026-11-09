import ClientSessions
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// An ask takes the composer's place (B10, draft B): one at a time, "1 of 3" where more wait, the
/// one you went to staying until it's answered (here or on another client), then the next after it;
/// none left, the composer and its draft come back. Don't Allow can carry what to do instead.
/// The engine is stubbed.
@MainActor
@Suite(.serialized) struct AskInComposerTests {
    let engine = StubEngine(port: 47992)
    let workspace = Workspace()
    let id = "ses_asks"

    init() {
        workspace.api = engine.api
    }

    private func open() async throws -> SessionModel {
        engine.list([StubEngine.session(id, title: "Asks", directory: "/tmp/kuvo-tests-asks")], running: [id])
        engine.conversation(id, [["id": "msg_you", "type": "user", "time": ["created": 1], "text": "Set it up"]])
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        return model
    }

    private func asked(_ request: String, _ command: String) -> [String: Any] {
        ["id": request, "sessionID": id, "action": "shell", "resources": [command]]
    }

    @Test func oneAtATimeAndTheOneYouWentToStaysTillItsAnswered() async throws {
        defer { engine.stop() }
        let model = try await open()
        model.draftText = "And then add tests"
        for (request, command) in [("per_1", "npm install"), ("per_2", "npm test"), ("per_3", "git push")] {
            workspace.handle(try engine.event("permission.asked", asked(request, command)))
        }
        // Which shows, as the conversation's composer place keeps it.
        var place = AskPlace()
        place.update(model.permissions.map(\.id) + model.forms.map(\.id))
        #expect(place.words == "1 of 3")
        // You went to the second; the first is answered on your phone meanwhile.
        place.show(1)
        #expect(place.words == "2 of 3")
        workspace.handle(try engine.event("permission.replied", ["sessionID": id, "requestID": "per_1"]))
        place.update(model.permissions.map(\.id))
        #expect(place.words == "1 of 2", "still the one you went to")
        #expect(place.shown == "per_2")
        // It's answered there too: the next after it shows.
        workspace.handle(try engine.event("permission.replied", ["sessionID": id, "requestID": "per_2"]))
        place.update(model.permissions.map(\.id))
        #expect(place.words == nil, "one alone has no count")
        #expect(place.shown == "per_3")
        workspace.handle(try engine.event("permission.replied", ["sessionID": id, "requestID": "per_3"]))
        place.update(model.permissions.map(\.id))
        #expect(place.shown == nil, "none: the composer is back")
        #expect(model.draftText == "And then add tests", "with what you'd written")
    }

    /// "Or tell it what to do instead…": Don't Allow, with your words for the agent.
    @Test func dontAllowCanSayWhatToDoInstead() async throws {
        defer { engine.stop() }
        engine.on("POST", "/api/session/\(id)/permission/*", json: [:])
        let model = try await open()
        workspace.handle(try engine.event("permission.asked", asked("per_1", "npm install")))
        model.reply(to: try #require(model.permissions.first), .reject, message: "Use pnpm instead")
        try await until { !engine.requests("POST", "/permission/per_1/reply").isEmpty }
        let sent = try #require(engine.requests("POST", "/permission/per_1/reply").first)
        #expect(sent.body["decision"] as? String == "reject")
        #expect(sent.body["message"] as? String == "Use pnpm instead")
    }
}
