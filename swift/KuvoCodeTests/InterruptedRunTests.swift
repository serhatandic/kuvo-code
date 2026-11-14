import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A job cut off when Kuvo Code quit (L50): the conversation says it was interrupted before it
/// finished, rather than ending on a failed step, as it goes and when opened again; one you
/// stopped yourself ends as stopped, and one that goes on again doesn't say it. The engine is
/// stubbed.
@MainActor
@Suite(.serialized) struct InterruptedRunTests {
    let engine = StubEngine(port: 47983)
    let workspace = Workspace()
    let id = "ses_cutoff"
    let you: [String: Any] = ["id": "msg_01", "type": "user", "time": ["created": 1], "text": "Run the migration"]

    init() {
        workspace.api = engine.api
    }

    private func open(_ conversation: [[String: Any]], running: Bool) async throws -> SessionModel {
        engine.list([StubEngine.session(id, title: "Migration", directory: "/tmp/kuvo-tests-cutoff")], running: running ? [id] : [])
        engine.conversation(id, conversation)
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        return model
    }

    private func saysInterrupted(_ model: SessionModel) -> Bool {
        TranscriptView.interruptedStep(in: model.transcript.messages, isRunning: model.transcript.isRunning) != nil
    }

    private func stepped(_ model: SessionModel, ending reason: String) throws {
        model.apply(try engine.event("session.step.started", session: id, ["assistantMessageID": "msg_02", "agent": "build", "model": ["id": "m", "providerID": "p"]]))
        model.apply(try engine.event("session.step.failed", session: id, ["assistantMessageID": "msg_02", "error": ["type": "aborted", "message": "The operation was aborted."]]))
        model.apply(try engine.event("session.execution.interrupted", session: id, ["reason": reason]))
    }

    @Test func aJobCutOffByQuittingSaysSo() async throws {
        defer { engine.stop() }
        let model = try await open([you], running: true)
        #expect(!saysInterrupted(model), "not while it runs")
        try stepped(model, ending: "shutdown")
        #expect(saysInterrupted(model))

        // Opened again: the engine's copy ends on that step.
        let read: [[String: Any]] = [you, ["id": "msg_02", "type": "assistant", "agent": "build", "time": ["created": 2, "completed": 3],
                                          "model": ["id": "m", "providerID": "p"], "content": [], "error": ["type": "aborted", "message": "The operation was aborted."]]]
        engine.conversation(id, read)
        engine.list([StubEngine.session(id, title: "Migration", directory: "/tmp/kuvo-tests-cutoff")], running: [])
        let again = Workspace()
        again.api = engine.api
        await again.refresh()
        let reopened = try #require(again.model(for: id))
        await reopened.load()
        #expect(saysInterrupted(reopened))
    }

    /// Stopped by you: its run has an end, which says so; nothing about being interrupted.
    @Test func aJobYouStoppedDoesntSayItWasCutOff() async throws {
        defer { engine.stop() }
        let model = try await open([you], running: true)
        try stepped(model, ending: "user")
        #expect(!saysInterrupted(model))
    }

    /// Carried on (a message sent after it): it isn't the end any more.
    @Test func carriedOnItNoLongerSaysIt() async throws {
        defer { engine.stop() }
        let model = try await open([you], running: true)
        try stepped(model, ending: "shutdown")
        model.apply(try engine.event("session.step.started", session: id, ["assistantMessageID": "msg_04", "agent": "build", "model": ["id": "m", "providerID": "p"]]))
        #expect(!saysInterrupted(model))
    }
}
