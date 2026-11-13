import ClientText
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A conversation as Markdown (Export, and what another agent reads with read_conversation): your
/// words with your comments and files, the agent's replies with its steps listed, messages from
/// other agents and wake-ups named as such; a long one read whole, without what an undo took back.
@MainActor
@Suite(.serialized) struct ConversationExportTests {
    static let engine = "http://127.0.0.1:47998"

    init() { TestEnvironment.prepare() }

    nonisolated private static func user(_ id: String, _ text: String, metadata: [String: Any]? = nil) -> [String: Any] {
        ["id": id, "type": "user", "time": ["created": 1], "text": text].merging(metadata.map { ["metadata": $0] } ?? [:]) { $1 }
    }

    private static func reply(_ id: String, _ blocks: [[String: Any]]) -> [String: Any] {
        ["id": id, "type": "assistant", "agent": "build", "time": ["created": 2, "completed": 3],
         "model": ["id": "m", "providerID": "p"], "content": blocks]
    }

    private static func text(_ text: String) -> [String: Any] { ["type": "text", "text": text] }

    private static func tool(_ name: String, _ input: [String: Any]) -> [String: Any] {
        ["type": "tool", "id": UUID().uuidString, "name": name, "executed": true,
         "state": ["status": "completed", "input": input, "content": [], "metadata": [:]]]
    }

    /// A message's parts, as its box keeps them.
    private static func parts(_ parts: [String: Any]) -> [String: Any] { ["kuvo": ["parts": parts]] }

    private func decode(_ messages: [[String: Any]]) throws -> [Message] {
        try JSONDecoder().decode([Message].self, from: JSONSerialization.data(withJSONObject: messages))
    }

    @Test func aConversationAsMarkdown() throws {
        // Each as its box keeps it: the text the agent read, and its parts.
        let messages = try decode([
            Self.user("m1", "Look at this\n\n<review-comments>…</review-comments>\n\n<attached-files>…</attached-files>", metadata: Self.parts([
                "words": "Look at this", "comments": [["file": "App.swift", "line": 3, "side": "new", "snippet": "let a", "text": "Why?"]], "paths": ["/Users/me/Desktop/trace.log"],
            ])),
            Self.reply("m2", [Self.tool("read", ["filePath": "/p/App.swift"]), Self.tool("bash", ["command": "swift test", "description": "Run tests"]), Self.text("All good.")]),
            Self.user("m3", "[Message from Ada · ses_ada] (To answer, use send_message to ses_ada.)\n\nCan you review?", metadata: Self.parts(["words": "Can you review?", "mail": ["name": "Ada", "session": "ses_ada"]])),
            Self.user("m4", Wakes.marker + "Check the build"),
            Self.user("m5", "check CI\n\n<sent-with>…</sent-with>", metadata: Self.parts(["words": "check CI", "keyword": "/loop every hour"])),
            // /goal in a bot's chat, as its box sends it.
            Self.user("m6", "Summarize the commits weekly\n\n<sent-with>…</sent-with>", metadata: Self.parts(["words": "Summarize the commits weekly", "keyword": "/goal"])),
            Self.user("m7", "[Goal] Plan the launch\n\n(…)", metadata: Self.parts(["words": "Plan the launch", "keyword": "/goal"])),
            // What the box told the bot: what happened, never as yours, marked or from before it was.
            Self.user("m8", "[Goal started] The user approved the plan. Work through it now: 1. Read 2. Write\nSpend nothing.",
                      metadata: ["kuvo": ["note": ["from": "Goal", "line": "Goal started"]]]),
            Self.user("m9", "[The user answered] Made Tidepool at ~/Developer/tidepool."),
        ])
        let markdown = ConversationExport.markdown(title: "Fix the app", messages: messages, directory: "/p")
        #expect(markdown.hasPrefix("# Fix the app\n"))
        #expect(markdown.contains("**You**\n\n> On App.swift:3: Why?\n\nLook at this\n\nAttached: trace.log"))
        // Its steps, listed together before what it said.
        let steps = try #require(markdown.range(of: "**Agent**\n\n- "))
        #expect(markdown[steps.upperBound...].contains("\n\nAll good."))
        #expect(markdown.contains("**Message from Ada**\n\nCan you review?"))
        #expect(markdown.contains("**Wake-up**\n\nCheck the build"))
        // Sent with a keyword: as you typed it, without the note the agent reads.
        #expect(markdown.contains("**You**\n\n/loop every hour check CI\n\n/goal Summarize the commits weekly\n\n/goal Plan the launch\n\n**Goal**"))
        #expect(!markdown.contains("<sent-with>") && !markdown.contains("propose_goal"))
        #expect(markdown.contains("**Goal**\n\nGoal started"))
        #expect(markdown.contains("**Your answer**\n\nYou answered: Made Tidepool at ~/Developer/tidepool."))
        #expect(!markdown.contains("[Goal started]") && !markdown.contains("Spend nothing") && !markdown.contains("[The user answered]"))
        #expect(!markdown.contains("<review-comments>") && !markdown.contains("<attached-files>"))
    }

    /// A long conversation, read page by page from the engine (newest first), comes back whole and
    /// oldest first; what an undo took back isn't in it.
    @Test func aLongConversationIsReadWholeWithoutWhatWasUndone() async throws {
        StubWeb.start(hosts: ["127.0.0.1"])
        defer { StubWeb.stop() }
        let count = 450
        // The engine's pages: the newest first, each with a cursor to the one before, if any.
        StubWeb.route(Self.engine + "/api/session/ses_long/message") { request in
            let query = Dictionary(uniqueKeysWithValues: (request.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            let limit = Int(query["limit"] ?? "") ?? 100
            let end = query["cursor"].flatMap { Int($0) } ?? count
            let start = max(0, end - limit)
            let page = (start..<end).reversed().map { Self.user(String(format: "msg_%04d", $0), "message \($0)") }
            return StubWeb.json(["data": page, "cursor": start > 0 ? ["next": String(start)] : [:]])
        }
        let api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: Self.engine)!, password: "test"))
        var session = try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: [
            "id": "ses_long", "projectID": "p", "cost": 0, "tokens": ["input": 0, "output": 0, "reasoning": 0, "cache": ["read": 0, "write": 0]],
            "time": ["created": 1, "updated": 2], "location": ["directory": "/p"],
        ]))
        let whole = try await ConversationExport.messages(of: session, api: api)
        #expect(whole.count == 450)
        #expect(whole.first?.id == "msg_0000" && whole.last?.id == "msg_0449")

        session.revert = try JSONDecoder().decode(Session.Revert.self, from: Data(#"{"messageID":"msg_0300"}"#.utf8))
        let undone = try await ConversationExport.messages(of: session, api: api)
        #expect(undone.count == 300)
        #expect(undone.last?.id == "msg_0299")
    }
}
