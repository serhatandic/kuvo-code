import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// Who allowed a step is said on the step, never as a line of its own (#406): "Allowed by you"
/// for what you approved after Auto's reviewer held it back, "Allowed by Auto-review", "Not
/// allowed by Pixel". And the bridge's notes for you are told from the engine's for the model.
struct PermissionMarksTests {
    private func messages(_ json: String) throws -> [Message] {
        try JSONDecoder().decode([Message].self, from: Data(json.utf8))
    }

    @Test func whatYouApprovedMarksTheStepThatDoesIt() throws {
        let all = try messages(#"""
        [{"type": "assistant", "id": "msg_1", "time": {"created": 1}, "agent": "build", "model": {"id": "m", "providerID": "p"},
          "content": [{"type": "tool", "id": "call_1", "name": "bash", "state": {"status": "completed", "input": {"command": "node --test"}, "content": []}}]},
         {"type": "user", "id": "msg_2", "time": {"created": 2}, "text": "[The user approved what Auto's reviewer held back] node --test",
          "metadata": {"kuvo": {"note": {"from": "Your answer", "line": "You approved: node --test"}}}},
         {"type": "assistant", "id": "msg_3", "time": {"created": 3}, "agent": "build", "model": {"id": "m", "providerID": "p"},
          "content": [{"type": "tool", "id": "call_2", "name": "read", "state": {"status": "completed", "input": {"filePath": "/a"}, "content": []}},
                      {"type": "tool", "id": "call_3", "name": "bash", "state": {"status": "completed", "input": {"command": "node --test"}, "content": []}},
                      {"type": "tool", "id": "call_4", "name": "bash", "state": {"status": "completed", "input": {"command": "node --test"}, "content": []}}]},
         {"type": "user", "id": "msg_4", "time": {"created": 4}, "text": "[The user approved what Auto's reviewer held back] ~/.zshrc",
          "metadata": {"kuvo": {"note": {"from": "Your answer", "line": "You approved: rm -rf /nothing-does-this"}}}}]
        """#)
        let yours = WorkAnswer.yours(in: all)
        // Only the first step after it that does it; one that matches no step marks nothing.
        #expect(Array(yours.keys) == ["call_3"])
        #expect(yours["call_3"]?.verdict == "Allowed by you")
        #expect(yours["call_3"]?.isYours == true)
    }

    @Test func whoAllowedItIsSaidTheSameWay() {
        let refused = WorkAnswer(ask: "per_1", call: "call_1", what: "npm run deploy", decision: .deny, reason: "Not in the plan",
                                 by: .init(bot: nil, name: "Kuvo Foreman"), at: 1)
        #expect(refused.verdict == "Not allowed by Kuvo Foreman")
    }

    @Test func theBridgesNotesForYouAreToldFromTheModels() throws {
        let all = try messages(#"""
        [{"type": "synthetic", "id": "msg_1", "time": {"created": 1}, "text": "Your PreToolUse hook failed.", "metadata": {"kuvo": {"notice": true}}},
         {"type": "synthetic", "id": "msg_2", "time": {"created": 2}, "text": "User requested that active blocking work be moved to the background."}]
        """#)
        let forYou = all.map { if case .synthetic(let notice) = $0 { notice.isForYou } else { false } }
        #expect(forYou == [true, false])
    }
}
