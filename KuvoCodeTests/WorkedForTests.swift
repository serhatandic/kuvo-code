import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// One reply's steps read as one line ("Worked for 50s"), even when the engine adds guidance
/// partway through the turn (it tells the model about the browser tools after the first tool
/// round, say), which shows nothing; something that does show, like a background command ending,
/// still comes between two lines. The engine is stubbed.
@MainActor
@Suite(.serialized) struct WorkedForTests {
    let engine = StubEngine(port: 47906)
    let workspace = Workspace()
    let id = "ses_worked"

    init() {
        workspace.api = engine.api
    }

    private func step(_ id: String, at time: Double, command: String) -> [String: Any] {
        ["id": id, "type": "assistant", "agent": "build", "time": ["created": time, "completed": time + 1], "model": ["id": "m", "providerID": "p"],
         "content": [["type": "tool", "id": "call_\(id)", "name": "bash","state": ["status": "completed", "input": ["command": command], "content": [["type": "text", "text": "ok"]]]]]]
    }

    /// The conversation's rows with what comes between the turn's two steps.
    private func rows(between: [String: Any]) async throws -> [Row] {
        let conversation: [[String: Any]] = [
            ["id": "msg_01", "type": "user", "time": ["created": 1], "text": "Which file holds the timer state?"],
            step("msg_02", at: 2, command: "ls -la"),
            between,
            step("msg_04", at: 4, command: "cat src/timer.js"),
            ["id": "msg_05", "type": "assistant", "agent": "build", "time": ["created": 6, "completed": 7], "model": ["id": "m", "providerID": "p"],
             "content": [["type": "text", "text": "src/timer.js holds it."]]],
            ["id": "msg_06", "type": "idle", "time": ["created": 8], "outcome": "succeeded"],
        ]
        engine.list([StubEngine.session(id, title: "Timer", directory: "/tmp/kuvo-tests-worked")])
        engine.conversation(id, conversation)
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        #expect(model.transcript.messages.count == conversation.count, "the whole conversation read")
        return TranscriptView.rows(of: model, catalog: Catalog(), detail: .summary)
    }

    private func stepLines(_ rows: [Row]) -> Int {
        rows.count { if case .steps = $0 { true } else { false } }
    }

    @Test func guidanceAddedMidTurnLeavesOneLine() async throws {
        defer { engine.stop() }
        let guidance: [String: Any] = ["id": "msg_03", "type": "system", "time": ["created": 3], "text": "Use the browser tools to read pages.",
                                       "description": "Instructions updated: core/browser",
                                       "metadata": ["notice": "instructions", "instructionSources": ["core/browser"]]]
        let rows = try await rows(between: guidance)
        #expect(stepLines(rows) == 1)
    }

    @Test func autopilotsInstructionsLeaveNoLineInTheConversation() async throws {
        defer { engine.stop() }
        let told: [String: Any] = ["id": "msg_03", "type": "system", "time": ["created": 3], "text": "This conversation runs on Autopilot.",
                                   "description": "Instructions updated: api/kuvo.autopilot, core/instructions",
                                   "metadata": ["notice": "instructions", "instructionSources": ["api/kuvo.autopilot", "core/instructions"]]]
        let rows = try await rows(between: told)
        #expect(stepLines(rows) == 1)
        #expect(!rows.contains { if case .notice = $0 { true } else { false } })
    }

    /// A background command ending is the engine's word to the model: it shows nothing (#406), so
    /// the steps around it stay one line.
    @Test func aBackgroundCommandEndingLeavesOneLine() async throws {
        defer { engine.stop() }
        let ended: [String: Any] = ["id": "msg_03", "type": "synthetic", "time": ["created": 3], "text": "npm run dev exited with code 0",
                                    "metadata": ["source": "shell"]]
        let rows = try await rows(between: ended)
        #expect(stepLines(rows) == 1)
        #expect(!rows.contains { if case .notice = $0 { true } else { false } })
    }
}
