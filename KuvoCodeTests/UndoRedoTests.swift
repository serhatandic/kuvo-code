import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Undo and Redo and the composer (B6): each undone message comes back to the composer, ahead of
/// what you'd written; Redo takes them out again while the composer is as the undo left it, and
/// never takes away what you typed meanwhile. The engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct UndoRedoTests {
    let engine = StubEngine(port: 47992)
    let workspace = Workspace()
    let id = "ses_undo_\(UUID().uuidString.prefix(8))"
    let older: [String: Any] = ["id": "msg_01", "type": "user", "time": ["created": 1], "text": "Add a settings page"]
    let newer: [String: Any] = ["id": "msg_03", "type": "user", "time": ["created": 3], "text": "Make it dark"]

    init() {
        workspace.api = engine.api
    }

    private func open() async throws -> SessionModel {
        engine.list([StubEngine.session(id, title: "Undo", directory: "/tmp/kuvo-tests-undo")])
        engine.conversation(id, [older, newer])
        engine.on("POST", "/api/session/\(id)/revert/stage") { request in
            StubWeb.json(["data": ["messageID": request.body["messageID"] as? String ?? ""]])
        }
        engine.on("DELETE", "/api/session/\(id)/revert", json: [:])
        await workspace.refresh()
        return try #require(workspace.model(for: id))
    }

    private func user(_ json: [String: Any]) throws -> Message.User {
        guard case .user(let message) = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: json)) else {
            throw TestFailure("not a user message")
        }
        return message
    }

    private func done() {
        engine.stop()
        Drafts.shared.remove(id)
    }

    /// Undo to the last message, then further back to the one before: both come back to the
    /// composer, oldest first. Redo takes them both out, back to what you'd written.
    @Test func undoTwiceThenRedo() async throws {
        defer { done() }
        let model = try await open()
        model.draftText = "half a thought"
        model.undo(from: try user(newer))
        try await until { model.draftText.contains("Make it dark") }
        model.undo(from: try user(older))
        try await until { model.draftText.contains("Add a settings page") }
        #expect(model.draftText == "Add a settings page\n\nMake it dark\n\nhalf a thought")
        model.redo()
        try await until { model.session.revert == nil }
        #expect(model.draftText == "half a thought")
    }

    /// Text you typed after an undo is yours: Redo leaves the composer as it is.
    @Test func redoKeepsWhatYouTypedAfterTheUndo() async throws {
        defer { done() }
        let model = try await open()
        model.undo(from: try user(newer))
        try await until { model.draftText == "Make it dark" }
        model.draftText += ", with a toggle"
        model.redo()
        try await until { model.session.revert == nil }
        #expect(model.draftText == "Make it dark, with a toggle")
    }

    /// Typing between two undos, then Redo: what you typed stays (it used to go with the undone
    /// messages' text, back to the composer as it was before the first undo).
    @Test func redoKeepsWhatYouTypedBetweenTwoUndos() async throws {
        defer { done() }
        let model = try await open()
        model.draftText = "half a thought"
        model.undo(from: try user(newer))
        try await until { model.draftText.contains("Make it dark") }
        model.draftText += " about colors"
        model.undo(from: try user(older))
        try await until { model.draftText.contains("Add a settings page") }
        model.redo()
        try await until { model.session.revert == nil }
        #expect(model.draftText.contains("half a thought about colors"), "typed text was lost: \(model.draftText)")
        #expect(!model.draftText.contains("Add a settings page"), "the message Redo brought back shouldn't stay in the composer to be sent again")
        #expect(!model.draftText.contains("Make it dark"), "nor the one the first undo put there: \(model.draftText)")
    }

    /// A message that waited in the queue is older than the steps the agent took before it got to
    /// it. Undoing it, then sending: the conversation goes back to where that message was, and
    /// the reply before it stays.
    @Test func undoingAQueuedMessageKeepsTheReplyBeforeIt() async throws {
        defer { done() }
        // Positions as the engine has them; the queued message's id is from when it was queued.
        let conversation: [[String: Any]] = [
            ["id": "msg_01", "type": "user", "time": ["created": 1], "text": "Fix the build"],
            ["id": "msg_02", "type": "assistant", "agent": "build", "time": ["created": 2, "completed": 3], "model": ["id": "m", "providerID": "p"],
             "content": [["type": "text", "text": "Looking at the build."]]],
            ["id": "msg_04", "type": "assistant", "agent": "build", "time": ["created": 4, "completed": 5], "model": ["id": "m", "providerID": "p"],
             "content": [["type": "text", "text": "The build passes now."]]],
            ["id": "msg_05", "type": "idle", "time": ["created": 6], "outcome": "succeeded"],
            ["id": "msg_03", "type": "user", "time": ["created": 3], "text": "Then run the tests"],
            ["id": "msg_06", "type": "assistant", "agent": "build", "time": ["created": 7, "completed": 8], "model": ["id": "m", "providerID": "p"],
             "content": [["type": "text", "text": "Tests pass."]]],
        ]
        engine.list([StubEngine.session(id, title: "Undo", directory: "/tmp/kuvo-tests-undo")])
        engine.conversation(id, conversation)
        engine.on("POST", "/api/session/\(id)/revert/stage") { request in
            StubWeb.json(["data": ["messageID": request.body["messageID"] as? String ?? ""]])
        }
        engine.on("POST", "/api/session/\(id)/prompt", json: [:])
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        #expect(model.transcript.messages.map(\.id) == ["msg_01", "msg_02", "msg_04", "msg_05", "msg_03", "msg_06"])

        model.undo(from: try user(conversation[4]))
        try await until { model.draftText == "Then run the tests" }
        model.send("Then run the tests, and the linter", for: nil)
        #expect(model.transcript.messages.map(\.id) == ["msg_01", "msg_02", "msg_04", "msg_05"], "the reply before the undone message should stay")
        // The engine's word that it made the undo final, as it takes the message: already done.
        model.apply(try engine.event("session.revert.committed", session: id, ["to": "msg_03"]))
        #expect(model.transcript.messages.map(\.id) == ["msg_01", "msg_02", "msg_04", "msg_05"], "and stays when the engine says so")

        // Opened afresh (Kuvo Code started again) as the engine's word of it comes in.
        engine.conversation(id, Array(conversation.prefix(4)))
        let again = Workspace()
        again.api = engine.api
        await again.refresh()
        let reopened = try #require(again.model(for: id))
        await reopened.load()
        reopened.apply(try engine.event("session.revert.committed", session: id, ["to": "msg_03"]))
        #expect(reopened.transcript.messages.map(\.id) == ["msg_01", "msg_02", "msg_04", "msg_05"])
    }

    /// What Undo says it does before you confirm (B6): in a git repository (a folder inside one
    /// too), the files the agent changed go back with the conversation; anywhere else they stay,
    /// as the engine can't put them back, and it says so.
    @Test func undoSaysWhetherTheFilesGoBack() throws {
        let repo = try TestRepository()
        try repo.write("src/app.swift", "a\n")
        let plain = AppInfo.testRoot.appending(path: "Folders/plain-\(UUID().uuidString.prefix(6))")
        try FileManager.default.createDirectory(at: plain, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: plain) }
        #expect(YourMessage.undoNote(in: repo.path).contains("so do the files"))
        #expect(YourMessage.undoNote(in: repo.url.appending(path: "src").path(percentEncoded: false)).contains("so do the files"))
        #expect(YourMessage.undoNote(in: plain.path(percentEncoded: false)).contains("stay as they are"))
    }
}
