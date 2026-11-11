import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// What changed between two replies shows as a word in the next reply's footer, never as a pill in
/// the conversation (the user, 11-10): only when it changed since the reply before, once.
struct ReplyChangesTests {
    private let sonnet = ModelRef(id: "claude-sonnet", providerID: "p", variant: "high")
    private let opus = ModelRef(id: "claude-opus", providerID: "p")

    private func notice(_ text: String, description: String? = nil, metadata: [String: Any]? = nil, type: String = "synthetic") throws -> Message.Notice {
        var json: [String: Any] = ["id": "msg_1", "type": type, "time": ["created": 1], "text": text]
        if let description { json["description"] = description }
        if let metadata { json["metadata"] = metadata }
        switch try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: json)) {
        case .synthetic(let notice), .system(let notice): return notice
        default: throw CocoaError(.coderReadCorrupt)
        }
    }

    @Test func aModelOrModeSwitchedShowsOnceInTheNextFooter() {
        var changes = ReplyChanges()
        #expect(changes.replied() == [])
        changes.switched(to: sonnet, from: opus, name: "Claude Sonnet")
        changes.switched(toMode: "plan", from: "build")
        #expect(changes.replied() == ["Plan mode", "Claude Sonnet · High"])
        #expect(changes.replied() == [])
        // Switched and back before the next reply: nothing changed.
        changes.switched(to: opus, from: sonnet, name: "Claude Opus")
        changes.switched(to: sonnet, from: opus, name: "Claude Sonnet")
        #expect(changes.replied() == [])
    }

    @Test func aSummaryAndTheProjectsFoldersSayWhatChanged() throws {
        var changes = ReplyChanges()
        changes.summarized("running")
        #expect(changes.replied() == [])
        changes.summarized("completed")
        changes.note(try notice("Folders: /src/web", description: "Instructions updated: api/kuvo.project-folders",
                                metadata: ["notice": "instructions", "instructionSources": ["api/kuvo.project-folders"]], type: "system"))
        #expect(changes.replied() == ["summarized", "folders updated"])
        changes.note(BoxNote(from: "Goal", line: "Goal started"))
        #expect(changes.replied() == ["goal started"])
    }

    /// The engine's words to the model, and the box's to the agent, change nothing a footer says.
    @Test func notesForTheModelSayNothing() throws {
        var changes = ReplyChanges()
        changes.note(try notice("User requested that active blocking work be moved to the background.\n\nBackgrounded work:\n- shell: npm test\n\nThe backgrounded work is still unfinished."))
        changes.note(try notice("<shell id=\"sh_1\" state=\"completed\" command=\"npm test\">\nok\n</shell>", description: "npm test", metadata: ["source": "shell", "state": "completed", "exit": 0]))
        changes.note(try notice("The previous response was interrupted. Continue from where you left off."))
        changes.note(try notice("<mcp_instructions>…", description: "Instructions updated: core/mcp-guidance", metadata: ["notice": "instructions", "instructionSources": ["core/mcp-guidance"]], type: "system"))
        changes.note(BoxNote(from: "Your answer", line: "You answered: yes"))
        #expect(changes.replied() == [])
    }

    /// A session that starts in Plan mode says so once, at its first reply.
    @Test func startingInPlanModeSaysItOnce() throws {
        var changes = ReplyChanges()
        let rules = try notice("<system-reminder>\nPlan mode is active.\n</system-reminder>")
        changes.note(rules)
        #expect(changes.replied() == ["Plan mode"])
        changes.note(rules)
        #expect(changes.replied() == [])
    }
}
