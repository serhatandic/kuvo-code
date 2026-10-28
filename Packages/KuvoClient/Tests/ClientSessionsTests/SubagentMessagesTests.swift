import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// How both apps let you write to a subagent, as its box says: a composer for the engine's and
/// Codex's, one that says it goes through the conversation that started it for Claude Code's, and
/// a line saying why not, in its place, for the agents that can't take one.
struct SubagentMessagesTests {
    private func subagent(metadata: String) throws -> Session {
        let json = #"{"id": "ses_child", "parentID": "ses_parent", "projectID": "p", "title": "Look into it", "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "time": {"created": 1, "updated": 2}, "location": {"directory": "/p"}, "metadata": \#(metadata)}"#
        return try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    @Test func eachRouteShowsWhatItSays() throws {
        let codex = SubagentMessages.of(try subagent(metadata: #"{"kuvoAgent": "codex", "kuvoSubagent": true, "kuvo": {"messages": {"via": "direct"}}}"#))
        #expect(codex.takesMessages)
        #expect(codex.line(parentTitle: "Fix the login bug") == nil)

        let claude = SubagentMessages.of(try subagent(metadata: #"{"kuvoAgent": "claude", "kuvoSubagent": true, "kuvo": {"messages": {"via": "parent"}}}"#))
        #expect(claude.takesMessages)
        #expect(claude.line(parentTitle: "Fix the login bug") == "Goes through Fix the login bug")

        let antigravity = SubagentMessages.of(try subagent(metadata: #"{"kuvoAgent": "antigravity", "kuvoSubagent": true, "kuvo": {"messages": {"via": "none", "note": "Antigravity can't take messages for its subagents."}}}"#))
        #expect(!antigravity.takesMessages)
        #expect(antigravity.line(parentTitle: "Fix the login bug") == "Antigravity can't take messages for its subagents.")
    }

    @Test func subagentsFromBeforeBoxesSaid() throws {
        // The engine's own: you write to it, as always.
        #expect(SubagentMessages.of(try subagent(metadata: "null")) == .direct)
        // A coding agent's from an older box: not here, as before.
        #expect(SubagentMessages.of(try subagent(metadata: #"{"kuvoAgent": "claude", "kuvoSubagent": true}"#)) == .unavailable(SubagentMessages.fromOlderBox))
    }
}
