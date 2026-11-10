import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// A note in a conversation (the engine's, the box's or the bridge's, written for the agent) shows
/// in both apps as a pill only for a change of state, and otherwise as a short line that opens to
/// its details, never as the words written for the model (#406). As they were in real
/// conversations.
struct TranscriptNoteTests {
    private func notice(_ text: String, description: String? = nil, metadata: [String: Any]? = nil, type: String = "synthetic") throws -> Message.Notice {
        var json: [String: Any] = ["id": "msg_1", "type": type, "time": ["created": 1], "text": text]
        if let description { json["description"] = description }
        if let metadata { json["metadata"] = metadata }
        let message = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: json))
        switch message {
        case .synthetic(let notice), .system(let notice): return notice
        default: throw CocoaError(.coderReadCorrupt)
        }
    }

    /// Kuvo Code's box moved the command to the background so a message could reach the agent: the
    /// line says that, in a few words, never the engine's "User requested", nor its words to the model.
    @Test func workMovedToTheBackgroundSaysWhoAndWhy() throws {
        let moved = try #require(TranscriptNote.of(try notice("""
        User requested that active blocking work be moved to the background.

        Backgrounded work:
        - shell: cd /tmp/kuvo-373/phone && rm -rf /tmp/kuvo-373b/shots-phone && KUVO_HEAVY_SLOTS=2 ONLY=KuvoCodeMobileUITests/PictureGalleryTests timeout -k 30 2400 ../kuvo-ai/scripts/heavy.sh phone sh scripts/test-app.sh > /tmp/kuvo-373b/phone-ui.log 2>&1; echo exit $?

        The backgrounded work is still unfinished. Move on to other work if you can. If there is nothing else useful to do, finish your response. Do not wait, sleep, poll, or report the backgrounded work as complete until a later completion notification is added to the conversation.
        """)))
        #expect(moved.look == .line)
        #expect(moved.text == "Moved heavy.sh phone to the background for a new message")
        #expect(moved.command?.hasPrefix("cd /tmp/kuvo-373/phone && rm -rf") == true)
        let detail = try #require(moved.detail)
        #expect(detail.contains("Kuvo Code moved this to the background"))
        for written in [moved.text, detail] {
            #expect(!written.contains("User requested"))
            #expect(!written.contains("Do not wait"))
        }
    }

    /// A command left running ended: a line with what it ran in a few words, opening to the whole
    /// command and what it printed, not the raw command in a pill.
    @Test func aBackgroundRunsEndIsALine() throws {
        let command = "cd /Users/me/swift-squid; TEST_RUNNER_X=1 xcodebuild test -scheme Squid > /tmp/x.log 2>&1; tail -5 /tmp/x.log"
        let ended = try #require(TranscriptNote.of(try notice("<shell id=\"sh_1\" state=\"completed\" command=\"\(command)\">\nTest Suite passed\n</shell>",
                                                              description: command, metadata: ["source": "shell", "state": "completed", "exit": 0])))
        #expect(ended.look == .line)
        #expect(ended.text == "Background run finished: xcodebuild test")
        #expect(ended.command == command)
        #expect(ended.output == "Test Suite passed")

        let failed = try #require(TranscriptNote.of(try notice("<shell id=\"sh_2\" state=\"completed\" command=\"npm test\">\n1 failing\n</shell>",
                                                               description: "npm test", metadata: ["source": "shell", "state": "completed", "exit": 1])))
        #expect(failed.text == "Background run failed (exit 1): npm test")

        // Claude Code's, through the bridge: its own description of the command, when it gave one.
        let claude = try #require(TranscriptNote.of(try notice("A command left running in the background finished.", description: "swift test --filter X",
                                                               metadata: ["source": "shell", "state": "completed", "exit": 0, "title": "Run the box's tests"])))
        #expect(claude.text == "Background run finished: Run the box's tests")
        #expect(claude.output == nil)
    }

    /// A subagent sent off in the background reported back: what it was for, opening to its report.
    @Test func aSubagentsReportIsALine() throws {
        let report = try #require(TranscriptNote.of(try notice("<subagent sessionID=\"ses_2\" state=\"completed\" description=\"Review the fix\">\nNothing blocks the merge.\n</subagent>",
                                                               description: "Review the fix", metadata: ["source": "subagent", "childID": "ses_2", "state": "completed"])))
        #expect(report.look == .line)
        #expect(report.text == "Subagent finished: Review the fix")
        #expect(report.detail == "Nothing blocks the merge.")
    }

    /// What's long goes in a line of its first words, opening to the rest, never a pill.
    @Test func nothingLongIsAPill() throws {
        let long = try #require(TranscriptNote.of(try notice("Your message for the subagent:\n\nPlease also check the phone's tests, then report back.", description: "Your message for “Review”",
                                                             metadata: ["kuvo": ["relayedTo": "ses_3"]])))
        #expect(long.look == .line)
        #expect(long.text == "Your message for “Review”")
        let cut = try #require(TranscriptNote.of(try notice(String(repeating: "word ", count: 60))))
        #expect(cut.look == .line)
        #expect(cut.text.count <= 120)
    }

    /// Pills are for changes of state only, a line long.
    @Test func changesOfStateArePills() throws {
        let folders = try #require(TranscriptNote.of(try notice("Folders: /src/web", description: "Instructions updated: api/kuvo.project-folders",
                                                                metadata: ["notice": "instructions", "instructionSources": ["api/kuvo.project-folders"]], type: "system")))
        #expect(folders.look == .pill)
        #expect(folders.text == "Project folders updated")
        // Kuvo Code's own guidance, and the engine's: nothing.
        #expect(TranscriptNote.of(try notice("<mcp_instructions>…", description: "Instructions updated: core/mcp-guidance",
                                             metadata: ["notice": "instructions", "instructionSources": ["core/mcp-guidance"]], type: "system")) == nil)
        #expect(TranscriptNote.of(try notice("<context key=\"kuvo.worktree\">…", metadata: ["notice": "instructions", "instructionSources": ["api/kuvo.worktree"]], type: "system")) == nil)

        let plan = try #require(TranscriptNote.of(try notice("<system-reminder>\nPlan mode is active.\n</system-reminder>")))
        #expect(plan.look == .pill)
        // Said once, after a switch to Plan mode says it.
        #expect(TranscriptNote.of(try notice("<system-reminder>\nPlan mode is active.\n</system-reminder>"), after: plan) == nil)

        let goal = TranscriptNote.of(BoxNote(from: "Goal", line: "Goal started"))
        #expect(goal.look == .pill)
        #expect(TranscriptNote.of(BoxNote(from: "Goal", line: "Reminded to carry on")).look == .line)
        #expect(TranscriptNote.of(BoxNote(from: "Your answer", line: "You answered: Made Tidepool at ~/Developer/tidepool.")).look == .line)
    }

    /// The engine asking the model to carry on a reply that was cut off: a line, in our words.
    @Test func aCutOffReplyIsALine() throws {
        let carried = try #require(TranscriptNote.of(try notice("The previous response was interrupted. Continue from where you left off.")))
        #expect(carried.look == .line)
        #expect(carried.text == "The reply was cut off, so it carried on")
    }
}
