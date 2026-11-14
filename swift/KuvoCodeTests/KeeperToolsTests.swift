import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// With Kuvo Code closed, this Mac's box goes on, and so do the agents on it: the keeper's tools
/// (`KeeperTools`) answer what a machine's box answers without any app (agents writing to each
/// other, wake-ups, a bot's job, the vault, the sandbox's way out, the Work Queue); the browser opens Kuvo Code
/// (`KeeperOpensAppTests`).
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

    /// With Kuvo Code closed, a bot's wake-ups, its job and the files it shows go to this Mac's box
    /// too, which answers them as every box does (the box's own tests hold what it does with them:
    /// box/bridge-tests/own-tools.test.js); only show_in_panel needs the window.
    @Test func wakeUpsAJobAndShownFilesGoThroughThisMacsBoxWithTheAppClosed() async throws {
        let asked = Asked()
        let box = try await StubListener { request, body in
            asked.note(request, body)
            guard request.url?.path() == "/kuvo/agent-tools" else { return StubWeb.Answer(status: 404) }
            return StubWeb.json(["text": "Done.", "isError": false])
        }
        let endpoint = box.endpoint
        let tools = KeeperTools(record: { $0 == "serve.json" ? endpoint : nil })
        defer {
            tools.stop()
            box.stop()
        }
        let server = try await tools.start().agents
        for name in ["schedule_wake_up", "list_wake_ups", "set_job", "show_file", "mark_final", "show_widget"] {
            let result = try await call(server, ["method": "tools/call", "params": [
                "name": name, "arguments": ["path": "/tmp/report.pdf"], "_meta": ["ai.opencode/sessionID": "ses_bot"],
            ]])
            #expect(text(result) == "Done.", "\(name)")
        }
        #expect(asked.requests("/kuvo/agent-tools").map { $0.body["name"] as? String } == ["schedule_wake_up", "list_wake_ups", "set_job", "show_file", "mark_final", "show_widget"])
        #expect(asked.requests("/kuvo/agent-tools").allSatisfy { $0.body["session"] as? String == "ses_bot" })

        let panel = try await call(server, ["method": "tools/call", "params": ["name": "show_in_panel", "arguments": ["path": "/tmp"]]])
        #expect(panel["isError"] as? Bool == true)
        #expect(asked.requests("/kuvo/agent-tools").count == 6, "the side panel needs the app")
    }

    /// An agent whose command the sandbox stopped asks to run it outside, with Kuvo Code closed (#206):
    /// sandbox_ask is listed as this Mac's box lists it now, before the app has ever listed the tools
    /// and whatever it last listed, and the call goes to the box, which asks you, rather than saying
    /// the browser needs Kuvo Code open.
    @Test func anAgentAsksToGoOutsideTheSandboxWithTheAppClosed() async throws {
        let asked = Asked()
        let sandboxTools = StubWeb.json(["tools": [["name": "sandbox_ask", "description": "Ask the user to run a command outside the sandbox.", "inputSchema": ["type": "object"]]]])
        let box = try await StubListener { request, body in
            asked.note(request, body)
            guard request.url?.path() == "/kuvo/sandbox/tools" else { return StubWeb.Answer(status: 404) }
            if request.httpMethod == "GET" { return sandboxTools }
            return StubWeb.json(["text": "Allowed once. It printed: done", "isError": false])
        }
        let endpoint = box.endpoint
        let tools = KeeperTools(record: { $0 == "serve.json" ? endpoint : nil })
        try? FileManager.default.removeItem(at: KeeperTools.listFile)
        defer {
            tools.stop()
            box.stop()
            try? FileManager.default.removeItem(at: KeeperTools.listFile)
        }
        let server = try await tools.start().agents
        let names = { (result: [String: Any]) in ((result["tools"] as? [[String: Any]]) ?? []).compactMap { $0["name"] as? String } }

        // Before the app has ever listed them.
        var listed = names(try await call(server, ["method": "tools/list"]))
        #expect(listed.contains("sandbox_ask"))
        #expect(listed.contains("send_message"))
        // As the app last listed them, from before the sandbox was on.
        let kept = try JSONSerialization.data(withJSONObject: BrowserTools.definitions(vault: []))
        FileManager.default.createFile(atPath: KeeperTools.listFile.path, contents: kept)
        listed = names(try await call(server, ["method": "tools/list"]))
        #expect(listed.filter { $0 == "sandbox_ask" }.count == 1)

        let result = try await call(server, ["method": "tools/call", "params": [
            "name": "sandbox_ask", "arguments": ["command": "swift build", "why": "To build the app."],
            "_meta": ["ai.opencode/sessionID": "ses_bot"],
        ]])
        #expect(text(result) == "Allowed once. It printed: done")
        #expect(result["isError"] as? Bool == false)
        let sent = try #require(asked.requests("/kuvo/sandbox/tools").last)
        #expect(sent.body["name"] as? String == "sandbox_ask")
        #expect(sent.body["session"] as? String == "ses_bot")
        #expect((sent.body["arguments"] as? [String: Any])?["command"] as? String == "swift build")
    }

    /// A bot keeps its Work Queue with Kuvo Code closed (#662): the queue's tools are listed, and
    /// what agents are told of them said, in this Mac's box's words (before the app has ever listed
    /// them, and once only after it has), and queue_add goes to the box as the conversation calling,
    /// rather than saying it needs Kuvo Code open.
    @Test func aBotKeepsItsWorkQueueWithTheAppClosed() async throws {
        let asked = Asked()
        let queueTools = StubWeb.json([
            "tools": [["name": "queue_add", "description": "Add an item to the Work Queue.", "inputSchema": ["type": "object"]],
                      ["name": "queue_list", "description": "List the Work Queue.", "inputSchema": ["type": "object"]]],
            "instructions": " Keep your work in the Work Queue.",
        ])
        let box = try await StubListener { request, body in
            asked.note(request, body)
            guard request.url?.path() == "/kuvo/work-queue/tools" else { return StubWeb.Answer(status: 404) }
            if request.httpMethod == "GET" { return queueTools }
            return StubWeb.json(["text": "Added #12: Ship the release notes.", "isError": false])
        }
        let endpoint = box.endpoint
        let tools = KeeperTools(record: { $0 == "serve.json" ? endpoint : nil })
        try? FileManager.default.removeItem(at: KeeperTools.listFile)
        defer {
            tools.stop()
            box.stop()
            try? FileManager.default.removeItem(at: KeeperTools.listFile)
        }
        let server = try await tools.start().agents
        let names = { (result: [String: Any]) in ((result["tools"] as? [[String: Any]]) ?? []).compactMap { $0["name"] as? String } }

        let started = try await call(server, ["method": "initialize", "params": ["protocolVersion": "2025-06-18"]])
        #expect((started["instructions"] as? String)?.hasSuffix(" Keep your work in the Work Queue.") == true)
        // Before the app has ever listed them.
        var listed = names(try await call(server, ["method": "tools/list"]))
        #expect(listed.contains("queue_add"))
        #expect(listed.contains("send_message"))
        // As the app last listed them, its own copy of the queue's with them.
        let kept = try JSONSerialization.data(withJSONObject: BrowserTools.definitions(vault: []) + [["name": "queue_add", "description": "Old words.", "inputSchema": ["type": "object"]]])
        FileManager.default.createFile(atPath: KeeperTools.listFile.path, contents: kept)
        listed = names(try await call(server, ["method": "tools/list"]))
        #expect(listed.filter { $0 == "queue_add" }.count == 1)
        #expect(listed.contains("queue_list"))

        let result = try await call(server, ["method": "tools/call", "params": [
            "name": "queue_add", "arguments": ["title": "Ship the release notes"],
            "_meta": ["ai.opencode/sessionID": "ses_bot"],
        ]])
        #expect(text(result) == "Added #12: Ship the release notes.")
        #expect(result["isError"] as? Bool == false)
        let sent = try #require(asked.requests("/kuvo/work-queue/tools").last)
        #expect(sent.body["name"] as? String == "queue_add")
        #expect(sent.body["session"] as? String == "ses_bot")
        #expect((sent.body["arguments"] as? [String: Any])?["title"] as? String == "Ship the release notes")
        #expect(sent.authorization == "Basic " + Data("opencode:test".utf8).base64EncodedString())
    }
}
