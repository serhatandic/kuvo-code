import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// An agent summarizing the conversation by itself partway through a turn, as it fills up (a minute
/// or more with nothing from the model): while it does, its row and the line under the
/// conversation say so, rather than that it waits for the model, and once it's done one row says it
/// was summarized. A conversation opened partway through it, with a message sent meanwhile after the
/// row, says so too. The engine (the agents bridge tells it the same way) is stubbed.
@MainActor
@Suite(.serialized) struct SummarizingTests {
    let engine = StubEngine(port: 47910)
    let workspace = Workspace()
    let id = "ses_summarizing"

    init() {
        workspace.api = engine.api
    }

    /// Your message, and a step that ran a command: the turn at work.
    private let turn: [[String: Any]] = [
        ["id": "msg_01", "type": "user", "time": ["created": 1_000], "text": "Tidy the release notes."],
        ["id": "msg_02", "type": "assistant", "agent": "build", "time": ["created": 2_000, "completed": 3_000], "model": ["id": "m", "providerID": "p"],
         "content": [["type": "tool", "id": "call_1", "name": "bash", "state": ["status": "completed", "input": ["command": "ls"], "content": [["type": "text", "text": "NOTES.md"]]]]]],
    ]

    private func open(_ conversation: [[String: Any]]) async throws -> SessionModel {
        engine.list([StubEngine.session(id, title: "Release", directory: "/tmp/kuvo-tests-summarizing")], running: [id])
        engine.conversation(id, conversation)
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        #expect(model.transcript.messages.count == conversation.count, "the whole conversation read")
        return model
    }

    private func rows(_ model: SessionModel) -> [Row] {
        TranscriptView.rows(of: model, catalog: Catalog(), detail: .summary)
    }

    /// What the summary's rows say.
    private func summaries(_ rows: [Row]) -> [String] {
        rows.compactMap { if case .notice(_, "rectangle.compress.vertical", let words) = $0 { words } else { nil } }
    }

    /// The line under the conversation, at `now`.
    private func line(_ rows: [Row], at now: Date) -> String? {
        for row in rows {
            if case .working(let since, let quiet, _, _, let summarizing) = row { return Row.working(since: since, quiet: quiet, summarizing: summarizing, now: now) }
        }
        return nil
    }

    @Test func whileItSummarizesByItselfItsRowAndTheLineUnderItSaySo() async throws {
        defer { engine.stop() }
        let model = try await open(turn)
        #expect(model.transcript.isRunning)
        workspace.handle(try engine.event("session.compaction.started", session: id, ["reason": "auto"]))
        let during = rows(model)
        #expect(summaries(during) == ["Summarizing the conversation…"])
        let began = try #require(model.transcript.messages.summaryUnderWay?.time.created)
        // A minute and a half on, with nothing from the model meanwhile.
        let later = Date(timeIntervalSince1970: began / 1000 + 90)
        #expect(line(during, at: later) == "Summarizing the conversation… 1m 30s · Esc to stop")

        workspace.handle(try engine.event("session.compaction.ended", session: id))
        let after = rows(model)
        #expect(summaries(after) == ["Summarized the conversation to save space"])
        #expect(line(after, at: later)?.hasPrefix("Summarizing") == false)
    }

    @Test func openedPartwayThroughWithAMessageSentMeanwhileItSaysSoToo() async throws {
        defer { engine.stop() }
        let model = try await open(turn + [
            ["id": "msg_03", "type": "compaction", "time": ["created": 4_000], "status": "running", "reason": "auto"],
            ["id": "msg_04", "type": "user", "time": ["created": 5_000], "text": "And the changelog."],
        ])
        let shown = rows(model)
        #expect(summaries(shown) == ["Summarizing the conversation…"])
        #expect(line(shown, at: Date(timeIntervalSince1970: 69)) == "Summarizing the conversation… 1m 5s · Esc to stop")
    }

    @Test func oneThatFailedSaysSoAndTheLineCountsFromItsEnd() async throws {
        defer { engine.stop() }
        let model = try await open(turn + [["id": "msg_03", "type": "compaction", "time": ["created": 4_000, "completed": 5_000], "status": "failed", "reason": "auto"]])
        let shown = rows(model)
        #expect(summaries(shown) == ["Couldn’t summarize the conversation"])
        // Nothing from the model since it ended: it says it waits for the model, timed from then.
        #expect(line(shown, at: Date(timeIntervalSince1970: 30)) == "Waiting for the model to answer… 25s · Esc to stop")
    }
}
