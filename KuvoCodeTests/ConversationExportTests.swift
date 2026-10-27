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

    nonisolated private static func user(_ id: String, _ text: String) -> [String: Any] {
        ["id": id, "type": "user", "time": ["created": 1], "text": text]
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

    private func decode(_ messages: [[String: Any]]) throws -> [Message] {
        try JSONDecoder().decode([Message].self, from: JSONSerialization.data(withJSONObject: messages))
    }

    @Test func aConversationAsMarkdown() throws {
        var prepared = Attachments.Prepared()
        prepared.paths = ["/Users/me/Desktop/trace.log"]
        let comment = ReviewComment(file: "App.swift", line: 3, side: .new, snippet: "let a", text: "Why?")
        let yours = Attachments.text(ReviewComments.text("Look at this", adding: [comment]), for: prepared)
        let messages = try decode([
            Self.user("m1", yours),
            Self.reply("m2", [Self.tool("read", ["filePath": "/p/App.swift"]), Self.tool("bash", ["command": "swift test", "description": "Run tests"]), Self.text("All good.")]),
            Self.user("m3", AgentMail.compose(from: "Ada", session: "ses_ada", text: "Can you review?", waits: false)),
            Self.user("m4", Wakes.marker + "Check the build"),
            Self.user("m5", SentWithKeyword.message("check CI", typed: "/loop every hour")),
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
        #expect(markdown.contains("**You**\n\n/loop every hour check CI"))
        #expect(!markdown.contains("<sent-with>"))
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
