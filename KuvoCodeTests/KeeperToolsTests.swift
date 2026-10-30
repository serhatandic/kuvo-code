import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// With Kuvo Code closed, this Mac's box goes on, and so do the agents on it: the keeper's tools
/// (`KeeperTools`) answer what a machine's box answers without any app (agents writing to each
/// other, wake-ups, a bot's job, the vault), and only the browser says it needs Kuvo Code open.
/// Over real HTTP, to a stand-in for this Mac's box on a loopback port of the test's own.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct KeeperToolsTests {
    let session = URLSession(configuration: .ephemeral)

    init() { TestEnvironment.prepare() }

    /// What the box stand-in was asked, by route.
    nonisolated final class Asked: @unchecked Sendable {
        private let lock = NSLock()
        private var bodies: [(path: String, authorization: String?, body: [String: Any])] = []
        func note(_ request: URLRequest, _ body: Data) {
            let json = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
            lock.withLock { bodies.append((request.url?.path() ?? "", request.value(forHTTPHeaderField: "authorization"), json)) }
        }
        func requests(_ path: String) -> [(authorization: String?, body: [String: Any])] {
            lock.withLock { bodies.filter { $0.path == path }.map { ($0.authorization, $0.body) } }
        }
    }

    /// One MCP call to the keeper's tools: its `result`.
    private func call(_ server: OutsideAgents.ToolServer, _ message: [String: Any], headers: [String: String] = [:]) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: server.url)!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(server.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        var whole: [String: Any] = ["jsonrpc": "2.0", "id": 1]
        whole.merge(message) { $1 }
        request.httpBody = try JSONSerialization.data(withJSONObject: whole)
        let (data, _) = try await session.data(for: request)
        return try #require((try JSONSerialization.jsonObject(with: data) as? [String: Any])?["result"] as? [String: Any])
    }

    private func text(_ result: [String: Any]) -> String {
        ((result["content"] as? [[String: Any]])?.first?["text"] as? String) ?? ""
    }

    /// A bot writes to another with Kuvo Code closed: its send_message goes to this Mac's box, as
    /// the conversation it's from (the engine names it, or the coding agents' bridge in a header),
    /// and what the box says comes back to it.
    @Test func anAgentsMessageGoesThroughThisMacsBoxWithTheAppClosed() async throws {
        let asked = Asked()
        let box = try await StubListener { request, body in
            asked.note(request, body)
            guard request.url?.path() == "/kuvo/agent-tools" else { return StubWeb.Answer(status: 404) }
            return StubWeb.json(["text": "Sent to Mira. She'll answer in this conversation.", "isError": false])
        }
        let endpoint = box.endpoint
        let tools = KeeperTools(record: { $0 == "serve.json" ? endpoint : nil })
        defer {
            tools.stop()
            box.stop()
        }
        let server = try await tools.start().agents

        let result = try await call(server, ["method": "tools/call", "params": [
            "name": "send_message", "arguments": ["to": "Mira", "text": "The build is green."],
            "_meta": ["ai.opencode/sessionID": "ses_bot"],
        ]])
        #expect(text(result) == "Sent to Mira. She'll answer in this conversation.")
        #expect(result["isError"] as? Bool == false)
        let sent = try #require(asked.requests("/kuvo/agent-tools").first)
        #expect(sent.body["name"] as? String == "send_message")
        #expect(sent.body["session"] as? String == "ses_bot")
        #expect((sent.body["arguments"] as? [String: Any])?["text"] as? String == "The build is green.")
        #expect(sent.authorization == "Basic " + Data("opencode:test".utf8).base64EncodedString())

        // A coding agent's call, its session named by the bridge.
        _ = try await call(server, ["method": "tools/call", "params": ["name": "list_agents", "arguments": [:]]], headers: ["x-kuvo-session": "ses_claude"])
        #expect(asked.requests("/kuvo/agent-tools").last?.body["session"] as? String == "ses_claude")
    }

    /// The browser can't work without the app: a call says Kuvo Code needs to be open, and the
    /// box isn't asked.
    @Test func theBrowserSaysKuvoCodeNeedsToBeOpen() async throws {
        let asked = Asked()
        let box = try await StubListener { request, body in
            asked.note(request, body)
            return StubWeb.Answer(status: 404)
        }
        let endpoint = box.endpoint
        let tools = KeeperTools(record: { $0 == "serve.json" ? endpoint : nil })
        defer {
            tools.stop()
            box.stop()
        }
        let server = try await tools.start().agents

        let result = try await call(server, ["method": "tools/call", "params": [
            "name": "browser_navigate", "arguments": ["url": "https://example.com"],
            "_meta": ["ai.opencode/sessionID": "ses_bot"],
        ]])
        #expect(text(result) == KeeperTools.needsApp)
        #expect(text(result).contains("Kuvo Code open"))
        #expect(result["isError"] as? Bool == true)
        #expect(asked.requests("/kuvo/agent-tools").isEmpty)
    }
}
