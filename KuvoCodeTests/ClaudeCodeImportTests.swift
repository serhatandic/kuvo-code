import Foundation
import Testing
@testable import KuvoCode

/// Bringing over Claude Code's subagents and slash commands (Settings › Agents and › Commands,
/// "From Claude Code"), as Claude Code writes them in ~/.claude: each agent with its name,
/// description and instructions, never in place of one of the engine's own; each command by its
/// file's name, in Claude Code's folders too, with its prompt as written. A made-up ~/.claude in
/// the test's own folder.
@Suite(.serialized) struct ClaudeCodeImportTests {
    let claude = AppInfo.testRoot.appending(path: "dot-claude-\(UUID().uuidString.prefix(6))")

    init() {
        TestEnvironment.prepare()
    }

    private func write(_ path: String, _ text: String) throws {
        let url = claude.appending(path: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    @Test func itsAgentsComeOverWithTheirInstructions() throws {
        defer { try? FileManager.default.removeItem(at: claude) }
        try write("agents/code-reviewer.md", """
            ---
            name: code-reviewer
            description: Use this agent after writing code.\\nIt reviews for bugs: logic, edge cases.
            tools: Read, Grep, Glob
            model: sonnet
            color: blue
            ---

            You are a senior reviewer. Read the diff, then list what's wrong, worst first.
            """)
        // Named as one of the engine's own: it comes over beside it, not over it.
        try write("agents/plan.md", "---\nname: Plan\ndescription: Plans a feature\n---\nWrite the plan first.\n")
        // No header at all: by its file's name.
        try write("agents/Release Notes.md", "Write release notes from the commits since the last tag.\n")
        try write("agents/notes.txt", "not an agent")

        let agents = ClaudeAgents.load(from: claude.appending(path: "agents"))
        #expect(agents.map(\.id).sorted() == ["code-reviewer", "plan-claude", "release-notes"])
        let reviewer = try #require(agents.first { $0.id == "code-reviewer" })
        #expect(reviewer.description == "Use this agent after writing code.\nIt reviews for bugs: logic, edge cases.")
        #expect(reviewer.instructions == "You are a senior reviewer. Read the diff, then list what's wrong, worst first.")
        #expect(agents.first { $0.id == "release-notes" }?.instructions.hasPrefix("Write release notes") == true)
    }

    @Test func itsCommandsComeOverInItsFoldersToo() throws {
        defer { try? FileManager.default.removeItem(at: claude) }
        try write("commands/review.md", """
            ---
            description: Review a pull request
            argument-hint: [pr-number]
            ---
            Review pull request #$ARGUMENTS: what it changes, and what could break.
            """)
        try write("commands/frontend/component.md", "Make a React component named $ARGUMENTS, with a test.\n")
        try write("commands/empty.md", "---\ndescription: nothing yet\n---\n")

        let commands = ClaudeCommands.load(from: claude.appending(path: "commands"))
        #expect(commands.map(\.id) == ["frontend-component", "review"], "one with nothing to say is left out")
        let review = try #require(commands.first { $0.id == "review" })
        #expect(review.description == "Review a pull request")
        #expect(review.template == "Review pull request #$ARGUMENTS: what it changes, and what could break.")
    }

    /// A phone's From Claude Code: each with what Import writes where in a computer's settings,
    /// and whether this Mac has it; a command named as one of the engine's comes over beside it.
    @MainActor @Test func aPhoneSeesWhatImportWrites() async throws {
        defer { try? FileManager.default.removeItem(at: claude) }
        try write("agents/code-reviewer.md", "---\nname: code-reviewer\ndescription: Reviews code\n---\nList what's wrong, worst first.\n")
        try write("commands/review.md", "---\ndescription: Review a pull request\n---\nReview #$ARGUMENTS.\n")
        let app = AppModel()
        let link = PhoneLink()
        app.bots.app = app
        link.bots = app.bots

        let (status, body) = await link.claudeCodeJSON(folder: claude)
        #expect(status == 200)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let agent = try #require((json["agents"] as? [[String: Any]])?.first)
        #expect(agent["path"] as? [String] == ["agents", "code-reviewer"])
        #expect(agent["settings"] as? [String: String] == ["mode": "subagent", "description": "Reviews code", "system": "List what's wrong, worst first."])
        #expect(agent["imported"] as? Bool == false)
        let command = try #require((json["commands"] as? [[String: Any]])?.first)
        #expect(command["name"] as? String == "review-claude", "beside the engine's /review")
        #expect(command["path"] as? [String] == ["commands", "review-claude"])
        #expect(command["settings"] as? [String: String] == ["template": "Review #$ARGUMENTS.", "description": "Review a pull request"])

        // Imported as the phone does it (its settings at its path): said to be there.
        let config = app.config(for: .mac)
        defer { config.set(nil, at: ["agents", "code-reviewer"]) }
        config.set(try #require(ClaudeAgents.load(from: claude.appending(path: "agents")).first).settings, at: ["agents", "code-reviewer"])
        let again = try #require(try JSONSerialization.jsonObject(with: await link.claudeCodeJSON(folder: claude).1) as? [String: Any])
        #expect((again["agents"] as? [[String: Any]])?.first?["imported"] as? Bool == true)
        // For a computer that isn't one of yours: nothing.
        #expect(await link.claudeCodeJSON(for: "nowhere", folder: claude).0 == 404)
    }
}
