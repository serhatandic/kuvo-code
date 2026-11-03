import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The row under a reply (its time, how long it took, Copy and Reply) shows under the pointer, from
/// any of the reply's rows: its steps, each piece of a long answer, its end. Your message has a row
/// of its own, so the pointer on it shows no reply's row. The latest reply keeps its row in view,
/// though a command you ran comes after it. Copy Reply, from a right-click on any piece, takes all
/// the turn said. The engine is stubbed.
@MainActor
@Suite(.serialized) struct ReplyRowTests {
    let engine = StubEngine(port: 47907)
    let workspace = Workspace()
    let id = "ses_replyrow"

    init() {
        workspace.api = engine.api
    }

    private func rows(after: [[String: Any]] = []) async throws -> [Row] {
        let long = (1...60).map { "Paragraph \($0) of the answer, which goes on about the timer for a while so that it's long." }.joined(separator: "\n\n")
        let conversation: [[String: Any]] = [
            ["id": "msg_01", "type": "user", "time": ["created": 1_000], "text": "Which file holds the timer state?"],
            ["id": "msg_02", "type": "assistant", "agent": "build", "time": ["created": 2_000, "completed": 3_000], "model": ["id": "m", "providerID": "p"],
             "content": [["type": "tool", "id": "call_1", "name": "bash", "state": ["status": "completed", "input": ["command": "ls"], "content": [["type": "text", "text": "ok"]]]]]],
            ["id": "msg_03", "type": "assistant", "agent": "build", "time": ["created": 4_000, "completed": 5_000], "model": ["id": "m", "providerID": "p"],
             "content": [["type": "text", "text": long]]],
            ["id": "msg_04", "type": "idle", "time": ["created": 6_000], "outcome": "succeeded"],
            ["id": "msg_05", "type": "user", "time": ["created": 7_000], "text": "Thanks."],
            ["id": "msg_06", "type": "assistant", "agent": "build", "time": ["created": 8_000, "completed": 9_000], "model": ["id": "m", "providerID": "p"],
             "content": [["type": "text", "text": "You're welcome."]]],
            ["id": "msg_07", "type": "idle", "time": ["created": 10_000], "outcome": "succeeded"],
        ] + after
        engine.list([StubEngine.session(id, title: "Timer", directory: "/tmp/kuvo-tests-replyrow")])
        engine.conversation(id, conversation)
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        #expect(model.transcript.messages.count == conversation.count, "the whole conversation read")
        return TranscriptView.rows(of: model, catalog: Catalog(), detail: .summary)
    }

    @Test func thePointerAnywhereOnAReplyShowsItsRow() async throws {
        defer { engine.stop() }
        let rows = try await rows()
        let hover = TurnHover()
        hover.turns = TranscriptView.turns(of: rows)
        let first = try #require(rows.firstIndex { if case .turnEnd = $0 { true } else { false } })
        let firstEnd = rows[first].id
        // Its steps, each piece of its long answer, and its end.
        let replyRows = rows[1...first]
        #expect(replyRows.count >= 4, "the steps, the answer in pieces, its end")
        for row in replyRows {
            hover.point(at: row.id)
            #expect(hover.turn == firstEnd, "\(row.id) shows the first turn's row")
        }
        // Your next message has its own row: the reply's goes.
        hover.point(at: rows[first + 1].id)
        #expect(hover.turn == nil)
        // The second turn's reply shows the second turn's row, not the first's.
        hover.point(at: rows[first + 2].id)
        #expect(hover.turn != nil && hover.turn != firstEnd)
        // Off the rows: none.
        hover.point(at: nil)
        #expect(hover.turn == nil)
    }

    @Test func copyReplyFromAnyPieceTakesAllTheTurnSaid() async throws {
        defer { engine.stop() }
        let rows = try await rows()
        let turns = TranscriptView.turns(of: rows)
        // The long answer's rows: its first piece, then each one after it.
        let pieces = rows.filter {
            switch $0 {
            case .assistant(let message, _), .more(let message, _): message.id.hasPrefix("msg_03#")
            default: false
            }
        }
        #expect(pieces.count >= 2, "a long answer is in pieces")
        let piece = try #require(pieces.last)
        let said = try #require(turns[piece.id]?.text)
        #expect(said.hasPrefix("Paragraph 1 of"))
        #expect(said.hasSuffix("Paragraph 60 of the answer, which goes on about the timer for a while so that it's long."))
    }

    @Test func theLatestReplyKeepsItsRowThoughACommandComesAfter() async throws {
        defer { engine.stop() }
        let shell: [String: Any] = ["id": "msg_08", "type": "shell", "time": ["created": 11_000, "completed": 12_000], "shellID": "sh_1", "command": "ls", "status": "completed", "exit": 0]
        let rows = try await rows(after: [shell])
        let ends = rows.compactMap { row -> (id: String, isLatest: Bool)? in
            if case .turnEnd(let idle, _, _, let isLatest) = row { (idle.id, isLatest) } else { nil }
        }
        #expect(ends.map(\.id) == ["msg_04", "msg_07"])
        #expect(ends.map(\.isLatest) == [false, true], "only the latest reply's row stays in view")
        #expect(rows.contains { if case .shell = $0 { true } else { false } }, "the command shows after it")
    }
}
