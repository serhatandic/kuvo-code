import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// A message that ran a command shows the command ("/review main") rather than the prompt it sent,
/// kept for the latest few hundred; one noted again (its events read twice) keeps its note. Kept
/// here in memory, never in an app's settings.
@MainActor
@Suite struct CommandMessagesTests {
    final class Kept { var entries: [[String]] = [] }

    @Test func aMessageNotedTwiceKeepsItsCommand() {
        let kept = Kept()
        let notes = CommandMessages(kept: []) { kept.entries = $0 }
        let id = "msg_cmd_\(UUID().uuidString)"
        notes.note(id, command: "/review main")
        for index in 0..<498 { notes.note("msg_other_\(index)_\(UUID().uuidString)", command: "/init") }
        notes.note(id, command: "/review main")
        // Older notes go as newer come: not one that was noted again since.
        for index in 0..<10 { notes.note("msg_more_\(index)_\(UUID().uuidString)", command: "/init") }
        #expect(notes[id] == "/review main")
        // As the next launch has them.
        #expect(CommandMessages(kept: kept.entries) { _ in }[id] == "/review main")
    }

    @Test func theCommandShowsInPlaceOfItsPrompt() throws {
        let notes = CommandMessages(kept: []) { _ in }
        let id = "msg_cmd_\(UUID().uuidString)"
        notes.note(id, command: "/review main")
        let message = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: ["id": id, "type": "user", "time": ["created": 1], "text": "You are a code reviewer. Review the diff between…"]))
        guard case .user(let user) = message else { Issue.record("not a user message"); return }
        #expect(notes.text(of: user) == "/review main")
    }
}
