import Foundation
import OpenCodeKit
import ClientSessions
import Testing
@testable import KuvoCode

/// What the box and the engine write to an agent in its conversation, as the transcript draws it:
/// a lead's sessions telling it what they did read as messages from each (#404), in the design of a
/// message from another agent, opening that session; the engine's notes for the model (work moved
/// to the background for a message, a background run ending) are short lines that open to their
/// details, never the words written for the model (#406). Pills are only for changes of state. The
/// engine is stubbed.
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

    private func pills(_ rows: [Row]) -> [String] {
        rows.compactMap { if case .notice(_, _, let text) = $0 { text } else { nil } }
    }

    private func lines(_ rows: [Row]) -> [TranscriptNote] {
        rows.compactMap { if case .line(_, let note) = $0 { note } else { nil } }
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
        #expect(news.map(\.0.title) == ["#398 sign-in card answers the wrong computer", "#399 keep-alive", "#400 deploy"])
        #expect(news.map(\.0.session) == ["ses_398", "ses_399", "ses_400"])
        #expect(news.map(\.0.status) == ["still working", "finished", "asks"])
        #expect(news.map(\.0.body) == [
            "The phone and Mac tests are still running.\n\nStill running in the background: the command `scripts/heavy.sh phone`.",
            "Merged to main. Tests green.",
            "Asks to run `npm run deploy`.",
        ])
        #expect(news.map(\.1) == [2_000, 3_000, 3_000])
        // No pill for any of them, nor the words the lead was told to act on.
        #expect(pills(rows).isEmpty)
        #expect(!news.contains { $0.0.body.contains("answer_ask") })
        // Each its own row, and Find reads what it shows.
        #expect(Set(rows.map(\.id)).count == rows.count)
        #expect(rows.contains { if case .news = $0 { $0.findParts.count == 1 } else { false } })
    }

    @Test func workMovedToTheBackgroundIsALineThatSaysWhoAndWhy() async throws {
        defer { engine.stop() }
        let command = "cd /tmp/kuvo-373/phone && KUVO_HEAVY_SLOTS=2 ONLY=KuvoCodeMobileUITests/PictureGalleryTests timeout -k 30 2400 ../kuvo-ai/scripts/heavy.sh phone sh scripts/test-app.sh > /tmp/phone-ui.log 2>&1; echo exit $?"
        let rows = try await rows([
            ["id": "msg_01", "type": "user", "time": ["created": 1_000], "text": "Run the phone's UI tests."],
            ["id": "msg_02", "type": "model-switched", "time": ["created": 1_500], "model": ["id": "claude-opus", "providerID": "p"], "previous": ["id": "m", "providerID": "p"]],
            ["id": "msg_03", "type": "synthetic", "time": ["created": 2_000],
             "text": "User requested that active blocking work be moved to the background.\n\nBackgrounded work:\n- shell: \(command)\n\nThe backgrounded work is still unfinished. Move on to other work if you can. If there is nothing else useful to do, finish your response. Do not wait, sleep, poll, or report the backgrounded work as complete until a later completion notification is added to the conversation."],
            ["id": "msg_04", "type": "synthetic", "time": ["created": 3_000], "text": "<shell id=\"sh_1\" state=\"completed\" command=\"\(command)\">\nexit 0\n</shell>",
             "description": command, "metadata": ["source": "shell", "shellID": "sh_1", "state": "completed", "exit": 0]],
        ])
        let lines = lines(rows)
        #expect(lines.map(\.text) == ["Moved heavy.sh phone to the background for a new message", "Background run finished: heavy.sh phone"])
        #expect(lines.allSatisfy { $0.opens })
        #expect(lines.first?.detail?.contains("Kuvo Code moved this to the background") == true)
        #expect(lines.last?.command == command)
        // Only the model's change is a pill; nothing says the user asked.
        #expect(pills(rows) == ["Switched to claude-opus"])
        #expect(!lines.contains { $0.text.contains("User requested") || ($0.detail ?? "").contains("User requested") })
    }
}
