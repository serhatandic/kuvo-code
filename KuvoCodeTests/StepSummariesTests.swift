import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Each of the agent's steps in words, as the conversation and its export show them: files by
/// their path in the project, a command with how it ended, a bot's memory as its memory, the
/// browser's actions as what it did.
@MainActor
@Suite struct StepSummariesTests {
    let project = "/Users/me/web"

    private func step(_ name: String, _ input: [String: Any], running: Bool = false, metadata: [String: Any] = [:], error: String? = nil) throws -> Message.ToolCall {
        let state: [String: Any] = if let error { ["status": "error", "input": input, "error": ["type": error, "message": "It went wrong"]] }
            else if running { ["status": "running", "input": input] }
            else { ["status": "completed", "input": input, "content": [], "metadata": metadata] }
        let message: [String: Any] = ["id": "m", "type": "assistant", "agent": "build", "time": ["created": 1], "model": ["id": "m", "providerID": "p"],
                                      "content": [["type": "tool", "id": "c", "name": name, "executed": true, "state": state]]]
        let decoded = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: message))
        guard case .assistant(let assistant) = decoded, case .tool(let call)? = assistant.content.first else { throw TestFailure("no tool call") }
        return call
    }

    private func words(_ name: String, _ input: [String: Any], running: Bool = false, metadata: [String: Any] = [:], error: String? = nil) throws -> String {
        ToolCallView.summary(of: try step(name, input, running: running, metadata: metadata, error: error), in: project)
    }

    @Test func filesByTheirPathInTheProject() throws {
        #expect(try words("read", ["path": "/Users/me/web/src/App.swift"]) == "Read src/App.swift")
        #expect(try words("edit", ["path": "/Users/me/web/src/App.swift"], running: true) == "Editing src/App.swift")
        #expect(try words("write", ["path": "/tmp/notes.md"]) == "Wrote /tmp/notes.md")
        #expect(try words("read", ["path": "/Users/me/web"]) == "Read web")
    }

    /// A subagent's row says what it's doing while its step runs ("Sleeping", not "Used sleep"),
    /// and what it did once that's done.
    @Test func aStepUnderWayInThePresentAndDoneInThePast() throws {
        #expect(StepsSummary.doing(try step("sleep", ["seconds": 180], running: true)) == "Sleeping")
        #expect(StepsSummary.summary(of: [try step("sleep", ["seconds": 180])]) == "Slept")
        #expect(StepsSummary.doing(try step("bash", ["command": "swift test"], running: true)) == "Running a command")
        #expect(StepsSummary.summary(of: [try step("bash", ["command": "swift test"])]) == "Ran a command")
    }

    @Test func aPatchOfSeveralFiles() throws {
        let files: [[String: Any]] = [["file": "/Users/me/web/a.swift", "patch": "x", "additions": 1, "deletions": 0],
                                      ["file": "/Users/me/web/b.swift", "patch": "y", "additions": 1, "deletions": 0]]
        #expect(try words("patch", [:], metadata: ["files": files]) == "Edited 2 files")
        #expect(try words("patch", [:], metadata: ["files": [files[0]]]) == "Edited a.swift")
    }

    @Test func aCommandAndHowItEnded() throws {
        #expect(try words("shell", ["command": "swift test"]) == "Ran `swift test`")
        #expect(try words("shell", ["command": "swift test"], metadata: ["exit": 1]) == "Ran `swift test` (exit 1)")
        #expect(try words("shell", ["command": "npm run dev"], running: true) == "Running `npm run dev`")
    }

    /// The command a step names is what shows as code, whole, never its backticks: also one with
    /// backticks of its own, which a sandbox ask must show as it will run.
    @Test func aCommandShowsAsCodeWhole() throws {
        func shown(_ summary: String) -> (text: String, code: [String]) {
            let pieces = InlineCode.pieces(summary[...])
            return (pieces.map { String($0.text) }.joined(), pieces.filter(\.isCode).map { String($0.text) })
        }
        let plain = shown(try words("shell", ["command": "swift test"]))
        #expect(plain.text == "Ran swift test")
        #expect(plain.code == ["swift test"])
        let ticks = #"git commit -m "fix `foo` and ``bar``""#
        let asked = shown(try words("sandbox_ask", ["command": ticks], running: true))
        #expect(asked.code == [ticks])
        #expect(asked.text == "Asking to run \(ticks) outside the sandbox")
        let edged = "`which swift`"
        #expect(shown(try words("shell", ["command": edged])).code == [edged])
        // A command of several lines: its first, and that there's more, never its backticks
        // (the whole of it shows once the step is open).
        let lines = shown(try words("sandbox_ask", ["command": "npm install \\\n  --save left-pad\nnpm test"], running: true))
        #expect(lines.code == ["npm install …"])
        #expect(lines.text == "Asking to run npm install … outside the sandbox")
        #expect(shown(try words("shell", ["command": "\n\nswift build\n"])).code == ["swift build"])
        #expect(shown(try words("shell", ["command": "swift build \\\n\n"])).code == ["swift build"])
        #expect(try words("shell", ["command": " \n "]) == "Ran a command")
        // A backslash at the very end is the command's own (an escaped space), not a line carried on.
        #expect(shown(try words("shell", ["command": "ls my\\ "])).code == ["ls my\\"])
    }

    @Test func searches() throws {
        #expect(try words("grep", ["pattern": "TODO", "path": "/Users/me/web/src"]) == "Searched for “TODO” in src")
        #expect(try words("tool_search", ["query": "send message"]) == "Looked for a tool: “send message”")
        #expect(try words("websearch", ["query": "swift testing"]) == "Searched the web for “swift testing”")
    }

    @Test func theBrowser() throws {
        #expect(try words("kuvo-browser_browser_navigate", ["url": "https://example.com"]) == "Opened https://example.com")
        #expect(try words("kuvo-browser_browser_click", ["index": 4]) == "Clicked [4]")
        // A number no element could have (a model's slip) reads as none given.
        #expect(try words("kuvo-browser_browser_click", ["index": 1e20]) == "Clicked an element")
        #expect(try words("kuvo-browser_browser_tabs", ["action": "switch", "tab": -1e300]) == "Switched to tab")
    }

    /// A bot's other tools come from the same server as the browser's, and say what they do: only
    /// the browser's own are "Used the browser", in a row and in the line that sums them up.
    @Test func aBotsOtherToolsAreNotTheBrowser() throws {
        #expect(try words("kuvo-browser_list_sessions", [:]) == "Checked its sessions")
        #expect(try words("kuvo-browser_list_sessions", [:], running: true) == "Checking its sessions")
        #expect(try words("kuvo-browser_set_job", ["summary": "Keeps the build green"]) == "Set its job: Keeps the build green")
        #expect(try words("kuvo-browser_stop_session", ["session": "ses_1"]) == "Stopped a session")
        #expect(try words("kuvo-browser_compact_session", ["session": "ses_1"]) == "Summarized a session")
        #expect(try words("kuvo-browser_make_project", ["name": "Tidepool"]) == "Made the project “Tidepool”")
        #expect(try words("kuvo-browser_vault_items", [:]) == "Looked up its vault items")
        #expect(try words("kuvo-browser_schedule_wake_up", ["when": "+2h", "note": "check CI"]) == "Scheduled a wake-up in 2 hr: check CI")
        #expect(try words("kuvo-browser_send_message", ["to": "&Mira", "text": "hi"]) == "Wrote to Mira")
        #expect(try words("kuvo-browser_start_session", ["task": "x", "title": "Write the tests"]) == "Started a session: Write the tests")
        // One the app doesn't know yet is named by what it is, never called the browser.
        #expect(try words("kuvo-browser_make_coffee", [:]) == "Used make coffee")
        #expect(try words("kuvo-browser_browser_fill", ["index": 3]) == "Filled [3] from your vault")
        #expect(try words("kuvo-browser_browser_unheard_of", [:]) == "Used the browser")
        let calls = [try step("kuvo-browser_list_sessions", [:]), try step("kuvo-browser_set_job", ["summary": "x"]), try step("kuvo-browser_browser_snapshot", [:])]
        #expect(StepsSummary.summary(of: calls) == "Checked its sessions, set its job, used the browser")
    }

    /// The line over a turn's steps counts the rows it opens to: a last step that has ended (the
    /// model is still working out what next) is one of them, and only one still going is shown by
    /// itself below it.
    @Test func theLineCountsTheStepsItOpensTo() throws {
        let browser = Message.Content.tool(try step("kuvo-browser_list_sessions", [:]))
        let ended = Message.Content.tool(try step("shell", ["command": "date"]))
        let going = Message.Content.tool(try step("shell", ["command": "swift test"], running: true))
        let live = StepsRow.split([browser, ended], isLive: true)
        #expect(live.done.count == 2 && live.current == nil)
        #expect(StepsRow.count(live.done) == "2 steps")
        let working = StepsRow.split([browser, ended, going], isLive: true)
        #expect(working.done.count == 2 && working.current != nil)
        let finished = StepsRow.split([browser, going], isLive: false)
        #expect(finished.done.count == 2 && finished.current == nil)
    }

    /// Reading or writing to another agent says whom by name, whichever way the agent addressed
    /// it; an address the app can't place is never shown.
    @Test func anotherAgentByNameNotByAddress() throws {
        let before = AgentMail.shared.agents
        AgentMail.shared.agents = [AgentMail.Agent(session: "ses_1ac7ff9cc001iiSrxcYn8C4tCV", name: "Finish Model roles", kind: "session")]
        defer { AgentMail.shared.agents = before }
        let read = "kuvo-browser_read_conversation"
        #expect(try words(read, ["of": "ses_1ac7ff9cc001iiSrxcYn8C4tCV", "query": "tests"]) == "Read Finish Model roles’s conversation about “tests”")
        #expect(try words(read, ["of": "&finish model roles"], running: true) == "Reading Finish Model roles’s conversation")
        #expect(try words(read, ["of": "ses_unknown000"]) == "Read another agent’s conversation")
        #expect(try words(read, ["of": "&Mira"]) == "Read Mira’s conversation")
        #expect(try words("kuvo-browser_send_message", ["to": "ses_1ac7ff9cc001iiSrxcYn8C4tCV", "text": "hi"]) == "Wrote to Finish Model roles")
        #expect(try words("kuvo-browser_send_message", ["to": "ses_unknown000", "text": "hi"]) == "Wrote to another agent")
    }

    /// Something the agent makes to show (a widget) by its title, also when it couldn't make it
    /// or was stopped: never as the browser.
    @Test func aWidget() throws {
        let widget = "kuvo-browser_show_widget"
        #expect(try words(widget, ["title": "Focus this week"], running: true) == "Making “Focus this week”")
        #expect(try words(widget, ["title": "Focus this week"]) == "Made “Focus this week”")
        #expect(try words(widget, ["title": "Focus this week"], error: "tool") == "Couldn’t make “Focus this week”")
        #expect(try words(widget, [:], error: "tool") == "Couldn’t make a widget")
        // Stopped with the turn: the row says "Stopped" beside these words, so they don't again.
        #expect(try words(widget, ["title": "Focus this week"], error: "aborted") == "Making “Focus this week”")
    }

    /// In a group chat as in a session: a widget that was made is drawn after the bot's words, and
    /// one it couldn't make is a step that says so.
    @Test func aWidgetInAGroupChat() throws {
        let widget = "kuvo-browser_show_widget"
        #expect(GroupChatView.isDrawn(try step(widget, ["title": "Focus this week"])))
        #expect(!GroupChatView.isDrawn(try step(widget, ["title": "Focus this week"], error: "tool")))
        #expect(!GroupChatView.isDrawn(try step(widget, ["title": "Focus this week"], error: "aborted")))
    }

    /// A wake-up the agent schedules (through kuvo-wake) reads as one, not as a command.
    @Test func wakeUps() throws {
        #expect(try words("shell", ["command": "kuvo-wake add +2h \"check whether CI passed\""]) == "Scheduled a wake-up in 2 hr: check whether CI passed")
        #expect(try words("shell", ["command": "\"$KUVO_WAKE\" list"]) == "Ran `\"$KUVO_WAKE\" list`")
        #expect(try words("shell", ["command": "kuvo-wake list"]) == "Checked its wake-ups")
        #expect(try words("shell", ["command": "kuvo-wake add +30m 'retry the deploy'"], metadata: ["exit": 1]) == "Couldn’t schedule a wake-up: retry the deploy (exit 1)")
    }

    /// A tool the app doesn't know, by its name in words.
    @Test func anUnknownTool() throws {
        #expect(try words("linear_create_issue", [:]) == "Linear Create Issue")
    }
}
