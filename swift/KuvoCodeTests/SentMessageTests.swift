import ClientSessions
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A message you send goes to its box as what you wrote and what goes with it (the keyword, your
/// comments on the changes, the agents you named with "&"), and the box writes what the agent reads
/// and keeps the message's parts with it. Wherever it shows again (its bubble, Edit), it's what you
/// wrote, with its comments as cards; one from before, which keeps no parts, shows as its box reads
/// it. This Mac's box is the real one; the engine is stubbed. (The words the agent reads, case by
/// case, are the box's: protocol/vectors/message-parts.json.)
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SentMessageTests {
    let engine = StubEngine(port: 47906)
    let workspace = Workspace()
    let box = SessionsBox()
    let id = "ses_sent_\(UUID().uuidString.prefix(8).lowercased())"

    init() {
        workspace.api = engine.api
        MessageParts.forgetRead()
    }

    private func done() {
        box.stop()
        engine.stop()
        Drafts.shared.remove(id)
        MessageParts.forgetRead()
    }

    private func open(_ conversation: [[String: Any]] = []) async throws -> SessionModel {
        engine.list([StubEngine.session(id, title: "Sent", directory: "/tmp/kuvo-tests-sent")])
        engine.conversation(id, conversation)
        engine.on("POST", "/api/session/\(id)/prompt", json: [:])
        try await box.start(engine, for: workspace)
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        return model
    }

    private func yours(in model: SessionModel) -> [Message.User] {
        model.transcript.messages.compactMap { if case .user(let user) = $0 { user } else { nil } }
    }

    @Test func whatYouWroteGoesToItsBoxWhichWritesWhatTheAgentReads() async throws {
        defer { done() }
        let model = try await open()
        model.reviewComments = [ReviewComment(file: "notes.md", line: 3, side: .old, snippet: "- old step", text: "Why did this go?")]
        model.send("  Please fix the limit.  ", for: nil)
        try await until { !engine.requests("POST", "/api/session/\(id)/prompt").isEmpty }
        let sent = try #require(engine.requests("POST", "/api/session/\(id)/prompt").first)
        let text = try #require(sent.body["text"] as? String)
        #expect(text.hasPrefix("Please fix the limit.\n\n<review-comments>\nComments on lines of the current changes:\n\n[notes.md:3 (removed)]\n> - old step\nWhy did this go?\n</review-comments>"))
        // Not a phone's.
        #expect(!text.contains("<from-phone>"))
        // Shown at once as what you wrote, and once the engine has it, the same, from the parts it keeps.
        let messageID = try #require(sent.body["id"] as? String)
        model.apply(try engine.event("session.inbox.enqueued", session: id, [
            "inboxID": messageID, "item": ["type": "user", "delivery": "steer", "payload": ["text": text, "metadata": sent.body["metadata"] ?? [:]]],
        ]))
        model.apply(try engine.event("session.inbox.delivered", session: id, ["inboxID": messageID]))
        let message = try #require(yours(in: model).last)
        let parts = SentMessage.parts(message)
        #expect(parts.words == "Please fix the limit.")
        #expect(parts.reviewComments.map(\.location) == ["notes.md:3 (removed)"])
        #expect(parts.reviewComments.map(\.text) == ["Why did this go?"])
        #expect(model.reviewComments.isEmpty)
    }

    /// A message sent before its box wrote the blocks (its parts not kept with it) shows as its box
    /// reads it, the moment the conversation does: the words, its keyword and its comments, never
    /// the blocks written for the agent.
    @Test func aMessageFromBeforeShowsAsItsBoxReadsIt() async throws {
        defer { done() }
        let before = "Check the build\n\n<sent-with>\nThe user sent this with a Kuvo Code keyword, which Kuvo Code has already done (switched to Plan, or set the message to repeat), so there's nothing for you to do about it:\n/plan\n</sent-with>\n\n<review-comments>\nComments on lines of the current changes:\n\n[a.js:4]\n> x()\nCall it once\n</review-comments>"
        let model = try await open([["id": "msg_01", "type": "user", "time": ["created": 1], "text": before]])
        let message = try #require(yours(in: model).first)
        let parts = SentMessage.parts(message)
        #expect(parts.words == "Check the build")
        #expect(parts.keyword == "/plan")
        #expect(parts.reviewComments.map(\.location) == ["a.js:4"])
        // Gone back to with ↑, it's what you wrote.
        #expect(model.sentMessages == ["Check the build"])
    }

    /// A conversation kept to show while its computer is away keeps the parts its box read: shown
    /// from the copy, a message from before is a bubble, not the blocks written for the agent.
    @Test func aSavedCopyKeepsWhatItsBoxRead() async throws {
        defer {
            done()
            SessionCopies.remove(id)
        }
        let before = "Check the build\n\n<sent-with>\nThe user sent this with a Kuvo Code keyword, which Kuvo Code has already done (switched to Plan, or set the message to repeat), so there's nothing for you to do about it:\n/plan\n</sent-with>"
        let model = try await open([["id": "msg_01", "type": "user", "time": ["created": 1], "text": before]])
        model.apply(try engine.event("session.execution.succeeded", session: id))
        await SessionCopies.written()
        let copy = try #require(SessionCopies.load(id))
        guard case .user(let user)? = copy.messages.first else { Issue.record("no message in the copy"); return }
        #expect(MessageParts.kept(in: user.metadata) == MessageParts(words: "Check the build", keyword: "/plan"))
    }

    /// Another agent's message from before shows as its message, from its box's reading of it.
    @Test func anotherAgentsMessageFromBeforeShowsAsTheirs() async throws {
        defer { done() }
        let model = try await open([["id": "msg_01", "type": "user", "time": ["created": 1], "text": "[Message from Ada · ses_ada] (To answer, use send_message to ses_ada.)\n\nCan you review?"]])
        let parts = SentMessage.parts(try #require(yours(in: model).first))
        #expect(parts.mail == MessageParts.Agent(name: "Ada", session: "ses_ada"))
        #expect(parts.words == "Can you review?")
        #expect(model.sentMessages.isEmpty)
    }
}
