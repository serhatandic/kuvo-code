import Foundation
import OpenCodeKit
import ClientSessions
import Testing
@testable import KuvoCode

/// What the box and the engine write to an agent in its conversation, as the transcript draws it:
/// no pills (the user, 11-10). A lead's sessions telling it what they did read as messages from each
/// (#404), in the design of a message from another agent, opening that session, and one still
/// working shows nothing (the user, 11-10: they're no longer sent); the engine's notes for the model (work moved to the background for a
/// message, a background run ending) show nothing (#406); what changed (the model, a summary) is a
/// word in the next reply's footer. The engine is stubbed.
@MainActor
@Suite(.serialized) struct TranscriptNotesTests {
    let engine = StubEngine(port: 47871)
    let workspace = Workspace()
    let id = "ses_notes"

    init() {
        workspace.api = engine.api
    }

    private func rows(_ conversation: [[String: Any]]) async throws -> [Row] {
        engine.list([StubEngine.session(id, title: "Lead", directory: "/tmp/kuvo-tests-notes")])
        engine.conversation(id, conversation)
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        #expect(model.transcript.messages.count == conversation.count, "the whole conversation read")
        return TranscriptView.rows(of: model, catalog: Catalog(), detail: .summary)
    }

    private func notices(_ rows: [Row]) -> [String] {
        rows.compactMap { if case .notice(_, _, let text) = $0 { text } else { nil } }
    }

    private func reply(_ id: String, at: Double, _ text: String, model: String = "m") -> [String: Any] {
        ["id": id, "type": "assistant", "agent": "build", "time": ["created": at, "completed": at + 1], "model": ["id": model, "providerID": "p"],
         "content": [["type": "text", "text": text]]]
    }

    @Test func itsSessionsNewsReadsAsMessagesFromThem() async throws {
        defer { engine.stop() }
        let note = { (line: String) -> [String: Any] in ["kuvo": ["note": ["from": "Its sessions", "line": line]]] }
        let rows = try await rows([
            ["id": "msg_01", "type": "user", "time": ["created": 1_000], "text": "Start the two fixes."],
            ["id": "msg_02", "type": "user", "time": ["created": 2_000],
             "text": "[Session still working] \"#398 sign-in card answers the wrong computer\" in kuvo-ai (address ses_398), after 40 min:\nThe phone and Mac tests are still running.\n(Still running in the background: the command `scripts/heavy.sh phone`. It may write again once that ends.)",
             "metadata": note("“#398 sign-in card answers the wrong computer” still working")],
            ["id": "msg_03", "type": "user", "time": ["created": 3_000],
             "text": "[Session finished] \"#399 keep-alive\" in kuvo-ai (address ses_399), after 2 h:\nMerged to main. Tests green.\n\n[Session asks] \"#400 deploy\" in kuvo-web (address ses_400) asks to run `npm run deploy` (ask per_1). Answer with answer_ask if it's yours to allow, or tell the user in a line and carry on.",
             "metadata": note("2 updates from its sessions")],
        ])
        let news = rows.compactMap { if case .news(_, let news, let at) = $0 { (news, at) } else { nil } }
        // Still working: nothing.
        #expect(news.map(\.0.title) == ["#399 keep-alive", "#400 deploy"])
        #expect(news.map(\.0.session) == ["ses_399", "ses_400"])
        #expect(news.map(\.0.status) == ["finished", "asks"])
        #expect(news.map(\.0.body) == ["Merged to main. Tests green.", "Asks to run `npm run deploy`."])
        #expect(news.map(\.1) == [3_000, 3_000])
        // No pill for any of them, nor the words the lead was told to act on.
        #expect(notices(rows).isEmpty)
        #expect(!news.contains { $0.0.body.contains("answer_ask") })
        // Each its own row, and Find reads what it shows.
        #expect(Set(rows.map(\.id)).count == rows.count)
        #expect(rows.contains { if case .news = $0 { $0.findParts.count == 1 } else { false } })
    }

    @Test func notesForTheModelShowNothingAndAModelChangeIsInTheNextFooter() async throws {
        defer { engine.stop() }
        let command = "cd /tmp/kuvo-373/phone && timeout -k 30 2400 ../kuvo-ai/scripts/heavy.sh phone sh scripts/test-app.sh > /tmp/phone-ui.log 2>&1; echo exit $?"
        let rows = try await rows([
            ["id": "msg_01", "type": "user", "time": ["created": 1_000], "text": "Run the phone's UI tests."],
            reply("msg_02", at: 1_100, "Running them."),
            ["id": "msg_03", "type": "idle", "time": ["created": 1_200], "outcome": "succeeded"],
            ["id": "msg_04", "type": "model-switched", "time": ["created": 1_500], "model": ["id": "claude-sonnet", "providerID": "p", "variant": "high"], "previous": ["id": "m", "providerID": "p"]],
            ["id": "msg_05", "type": "user", "time": ["created": 1_600], "text": "How did it go?"],
            ["id": "msg_06", "type": "synthetic", "time": ["created": 2_000],
             "text": "User requested that active blocking work be moved to the background.\n\nBackgrounded work:\n- shell: \(command)\n\nThe backgrounded work is still unfinished. Move on to other work if you can. If there is nothing else useful to do, finish your response. Do not wait, sleep, poll, or report the backgrounded work as complete until a later completion notification is added to the conversation."],
            ["id": "msg_07", "type": "synthetic", "time": ["created": 3_000], "text": "<shell id=\"sh_1\" state=\"completed\" command=\"\(command)\">\nexit 0\n</shell>",
             "description": command, "metadata": ["source": "shell", "shellID": "sh_1", "state": "completed", "exit": 0]],
            reply("msg_08", at: 3_100, "All passed.", model: "claude-sonnet"),
            ["id": "msg_09", "type": "idle", "time": ["created": 3_200], "outcome": "succeeded"],
        ])
        #expect(notices(rows).isEmpty)
        #expect(!rows.contains { $0.copiedText(folders: []).contains("User requested") || $0.copiedText(folders: []).contains("Background command") })
        let footers = rows.compactMap { if case .turnEnd(_, let stats, _, _) = $0 { stats.changes } else { nil } }
        #expect(footers == [[], ["claude-sonnet High"]])
    }
}
