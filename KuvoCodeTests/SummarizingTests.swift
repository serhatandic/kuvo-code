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

    private func open(_ conversation: [[String: Any]], running: Bool = true) async throws -> SessionModel {
        engine.list([StubEngine.session(id, title: "Release", directory: "/tmp/kuvo-tests-summarizing")], running: running ? [id] : [])
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

    /// Lines of their own in the conversation: none, for a summary (#406: no pills).
    private func notices(_ rows: [Row]) -> [String] {
        rows.compactMap { if case .notice(_, _, let words) = $0 { words } else { nil } }
    }

    /// What each reply's footer says changed before it.
    private func footers(_ rows: [Row]) -> [[String]] {
        rows.compactMap { if case .turnEnd(_, let stats, _, _) = $0 { stats.changes } else { nil } }
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
        #expect(notices(during).isEmpty)
        let began = try #require(model.transcript.messages.summaryUnderWay?.time.created)
        // A minute and a half on, with nothing from the model meanwhile.
        let later = Date(timeIntervalSince1970: began / 1000 + 90)
        #expect(line(during, at: later) == "Summarizing the conversation… 1m 30s · Esc to stop")

        workspace.handle(try engine.event("session.compaction.ended", session: id))
        let after = rows(model)
        #expect(notices(after).isEmpty)
        #expect(line(after, at: later)?.hasPrefix("Summarizing") == false)
    }

    @Test func openedPartwayThroughWithAMessageSentMeanwhileItSaysSoToo() async throws {
        defer { engine.stop() }
        let model = try await open(turn + [
            ["id": "msg_03", "type": "compaction", "time": ["created": 4_000], "status": "running", "reason": "auto"],
            ["id": "msg_04", "type": "user", "time": ["created": 5_000], "text": "And the changelog."],
        ])
        let shown = rows(model)
        #expect(notices(shown).isEmpty)
        #expect(line(shown, at: Date(timeIntervalSince1970: 69)) == "Summarizing the conversation… 1m 5s · Esc to stop")
    }

    @Test func oneThatFailedSaysSoAndTheLineCountsFromItsEnd() async throws {
        defer { engine.stop() }
        let model = try await open(turn + [["id": "msg_03", "type": "compaction", "time": ["created": 4_000, "completed": 5_000], "status": "failed", "reason": "auto"]])
        let shown = rows(model)
        #expect(notices(shown).isEmpty)
        // Nothing from the model since it ended: it says it waits for the model, timed from then.
        #expect(line(shown, at: Date(timeIntervalSince1970: 30)) == "Waiting for the model to answer… 25s · Esc to stop")
    }

    /// Once the reply after it ends, its footer says the conversation was summarized, beside its
    /// time, and the reply after that doesn't say it again.
    @Test func theReplyAfterItSaysItWasSummarized() async throws {
        defer { engine.stop() }
        let reply = { (id: String, at: Double, text: String) -> [String: Any] in
            ["id": id, "type": "assistant", "agent": "build", "time": ["created": at, "completed": at + 1], "model": ["id": "m", "providerID": "p"],
             "content": [["type": "text", "text": text]]]
        }
        let model = try await open(turn + [
            ["id": "msg_03", "type": "compaction", "time": ["created": 4_000, "completed": 5_000], "status": "completed", "reason": "auto"],
            reply("msg_04", 6_000, "Tidied."),
            ["id": "msg_05", "type": "idle", "time": ["created": 7_000], "outcome": "succeeded"],
            ["id": "msg_06", "type": "user", "time": ["created": 8_000], "text": "And the changelog."],
            reply("msg_07", 9_000, "Done."),
            ["id": "msg_08", "type": "idle", "time": ["created": 10_000], "outcome": "succeeded"],
        ], running: false)
        let shown = rows(model)
        #expect(notices(shown).isEmpty)
        #expect(footers(shown) == [["summarized"], []])
    }
}
