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

    private func step(_ name: String, _ input: [String: Any], running: Bool = false, metadata: [String: Any] = [:]) throws -> Message.ToolCall {
        let state: [String: Any] = running ? ["status": "running", "input": input] : ["status": "completed", "input": input, "content": [], "metadata": metadata]
        let message: [String: Any] = ["id": "m", "type": "assistant", "agent": "build", "time": ["created": 1], "model": ["id": "m", "providerID": "p"],
                                      "content": [["type": "tool", "id": "c", "name": name, "executed": true, "state": state]]]
        let decoded = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: message))
        guard case .assistant(let assistant) = decoded, case .tool(let call)? = assistant.content.first else { throw TestFailure("no tool call") }
        return call
    }

    private func words(_ name: String, _ input: [String: Any], running: Bool = false, metadata: [String: Any] = [:]) throws -> String {
        ToolCallView.summary(of: try step(name, input, running: running, metadata: metadata), in: project)
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
