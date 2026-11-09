import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The panel's browser offered to agents as MCP tools on this Mac only (127.0.0.1): reached with
/// the token the engine is given, and nothing else, by any other program or web page. Over real
/// HTTP, with a session of its own (the web stub answers other tests' requests).
@MainActor
@Suite(.serialized) struct BrowserToolServerTests {
    let server = BrowserToolServer(agent: BrowserAgent(utilities: Utilities(), asks: BrowserAsks()))
    let session = URLSession(configuration: .ephemeral)

    init() { TestEnvironment.prepare() }

    /// The engine's settings for it: its address and the token it takes.
    private var token: String {
        let servers = (server.engineConfig?["mcp"] as? [String: Any])?["servers"] as? [String: Any]
        let headers = (servers?["kuvo-browser"] as? [String: Any])?["headers"] as? [String: String]
        return String(headers?["Authorization"]?.dropFirst("Bearer ".count) ?? "")
    }

    private func call(_ url: URL, method: String = "POST", token: String?, body: Any? = nil) async throws -> (status: Int, json: Any?, headers: [AnyHashable: Any]) {
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await session.data(for: request)
        let http = response as! HTTPURLResponse
        return (http.statusCode, try? JSONSerialization.jsonObject(with: data), http.allHeaderFields)
    }

    /// "Take a screenshot and show it to me": the agent says show, and the picture is in the
    /// conversation, as one it made; one it took to see the page for itself stays in its step.
    @Test func aScreenshotYouAskedToSeeShowsInTheConversation() throws {
        let screenshot = try #require(BrowserTools.definitions.first { $0["name"] as? String == "browser_screenshot" })
        #expect(((screenshot["inputSchema"] as? [String: Any])?["properties"] as? [String: Any])?["show"] != nil)
        func call(_ input: [String: Any]) throws -> Message.ToolCall {
            let json: [String: Any] = ["type": "tool", "id": "call_1", "name": "kuvo-browser_browser_screenshot",
                                       "state": ["status": "completed", "input": input, "content": [["type": "file", "uri": "data:image/png;base64,iVBORw0KGgo=", "mime": "image/png"]]]]
            return try JSONDecoder().decode(Message.ToolCall.self, from: JSONSerialization.data(withJSONObject: json))
        }
        #expect(MadePictureRow.isMade(try call(["show": true])))
        #expect(!MadePictureRow.isMade(try call([:])))
    }

    @Test func shownPicturesGroupWithCaptionsAndKeepBoundaries() throws {
        func call(_ id: String, path: String, caption: String? = nil, status: String = "completed") throws -> Message.ToolCall {
            var input: [String: Any] = ["path": path]
            if let caption { input["caption"] = caption }
            let json: [String: Any] = ["type": "tool", "id": id, "name": "kuvo-browser_show_file",
                                       "state": ["status": status, "input": input, "content": []]]
            return try JSONDecoder().decode(Message.ToolCall.self, from: JSONSerialization.data(withJSONObject: json))
        }
        let first = try call("a", path: "/tmp/a.png", caption: "First")
        let second = try call("b", path: "/tmp/b.png", caption: "Second")
        let document = try call("c", path: "/tmp/c.txt")
        let third = try call("d", path: "/tmp/d.png")
        let groups = MadePictureRow.groups(in: [.tool(first), .tool(second), .tool(document), .tool(third)])
        #expect(groups[0]?.map(\.id) == ["a", "b"])
        #expect(groups[3]?.map(\.id) == ["d"])
        #expect(groups[0]?.first?.state.input?["caption"]?.string == "First")
        #expect(groups[2] == nil)
    }

    @Test func onlyOnThisMac() async throws {
        let url = try await server.start()
        #expect(url.host() == "127.0.0.1")
        #expect(url.path() == "/mcp")
    }

    /// Without the token, a wrong one, another path, or another method: nothing.
    @Test func onlyWithItsToken() async throws {
        let url = try await server.start()
        let ping: [String: Any] = ["jsonrpc": "2.0", "id": 1, "method": "ping"]
        #expect(try await call(url, token: nil, body: ping).status == 401)
        #expect(try await call(url, token: "guess", body: ping).status == 401)
        #expect(try await call(url, token: String(token.dropLast()), body: ping).status == 401)
        #expect(try await call(url.deletingLastPathComponent().appending(path: "admin"), token: token, body: ping).status == 404)
        #expect(try await call(url, method: "GET", token: token).status == 405)
        #expect(try await call(url, token: token, body: ping).status == 200)
    }

    /// With it: an MCP server with the browser's tools, signing in among them.
    @Test func anMCPServerWithTheBrowsersTools() async throws {
        let url = try await server.start()
        let start = try await call(url, token: token, body: ["jsonrpc": "2.0", "id": 1, "method": "initialize", "params": ["protocolVersion": "2025-06-18"]])
        let result = (start.json as? [String: Any])?["result"] as? [String: Any]
        #expect((result?["serverInfo"] as? [String: Any])?["name"] as? String == "kuvo-browser")
        #expect(result?["protocolVersion"] as? String == "2025-06-18")
        #expect(start.headers.keys.contains { ($0 as? String)?.lowercased() == "mcp-session-id" })
        let list = try await call(url, token: token, body: ["jsonrpc": "2.0", "id": 2, "method": "tools/list"])
        let tools = (((list.json as? [String: Any])?["result"] as? [String: Any])?["tools"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
        #expect(tools.contains("browser_navigate"))
        #expect(tools.contains("browser_sign_in"))
        // Not JSON: said so, as JSON-RPC does.
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = Data("{not json".utf8)
        let (data, _) = try await session.data(for: request)
        #expect(((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? [String: Any])?["code"] as? Int == -32700)
    }

    /// While this Mac's vault isn't open to agents (their commands don't run sandboxed yet), they
    /// aren't offered what only the vault could answer, so they never call a tool that sends them
    /// back to the one they just called: no browser_fill, no vault item to name when signing in.
    @Test func withoutTheVaultOpenToAgentsTheyArentOfferedItsFills() async throws {
        let url = try await server.start()
        let start = try await call(url, token: token, body: ["jsonrpc": "2.0", "id": 1, "method": "initialize", "params": ["protocolVersion": "2025-06-18"]])
        let instructions = ((start.json as? [String: Any])?["result"] as? [String: Any])?["instructions"] as? String ?? ""
        #expect(instructions.contains("browser_sign_in"))
        #expect(!instructions.contains("vault_items"))
        let list = try await call(url, token: token, body: ["jsonrpc": "2.0", "id": 2, "method": "tools/list"])
        let tools = ((list.json as? [String: Any])?["result"] as? [String: Any])?["tools"] as? [[String: Any]] ?? []
        #expect(!tools.contains { $0["name"] as? String == "browser_fill" })
        let signIn = try #require(tools.first { $0["name"] as? String == "browser_sign_in" })
        let properties = (signIn["inputSchema"] as? [String: Any])?["properties"] as? [String: Any] ?? [:]
        #expect(properties["password"] != nil)
        #expect(properties["item"] == nil)
    }

    /// The engine is told to call its tools directly (not behind Code Mode), with no sign-in.
    @Test func theEngineCallsItsToolsDirectly() async throws {
        _ = try await server.start()
        let entry = ((server.engineConfig?["mcp"] as? [String: Any])?["servers"] as? [String: Any])?["kuvo-browser"] as? [String: Any]
        #expect(entry?["codemode"] as? Bool == false)
        #expect(entry?["oauth"] as? Bool == false)
        #expect(token.count >= 64)
    }
}
