import Foundation
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "keeper")

/// Kuvo Code's own tools (the panel's browser, `BrowserToolServer`) as the keeper's engine and
/// coding agents reach them: an MCP server of the keeper's, on 127.0.0.1, whose address stays the
/// same while the app opens and quits. While the app is open, it has said where its tools answer
/// (`KeeperControl.Command.app`) and each call goes there as it is; while it isn't, the tools are
/// still listed (as the app last listed them), and a call says the browser needs Kuvo Code open.
@MainActor
final class KeeperTools {
    private lazy var server = LoopbackServer { [weak self] request in await self?.respond(to: request) ?? .init(status: 503) }
    private let token = UUID().uuidString + UUID().uuidString
    /// Where the open app's tools answer, and to what token.
    private var app: (url: URL, token: String)?

    /// What a call says while the app isn't open.
    static let needsApp = "The browser needs Kuvo Code open on this Mac. Ask the user to open Kuvo Code, then try again."
    /// The tools as the app last listed them, for while it isn't open.
    static var listFile: URL { KeeperRecord.run.appending(path: "tools-list.json") }

    /// Starts listening, and says what the engine and the agents are given for it.
    func start() async throws -> MacBoxRunner.Tools {
        let port = try await server.start()
        let url = "http://127.0.0.1:\(port)/mcp"
        let engineConfig: [String: Any] = ["mcp": ["servers": ["kuvo-browser": [
            "type": "remote",
            "url": url,
            "headers": ["Authorization": "Bearer \(token)"],
            "oauth": false,
            // Plain tools, so every model calls them directly.
            "codemode": false,
            // A tool that asks you (to sign in, for a code) waits for you.
            "timeout": ["execution": BrowserTools.executionTimeout],
        ] as [String: Any]]]]
        return MacBoxRunner.Tools(engineConfig: engineConfig, agents: OutsideAgents.ToolServer(url: url, token: token, timeout: BrowserTools.executionTimeout))
    }

    /// The open app's tools (`{url, token}`), or that it has gone (`{}`).
    func use(_ given: [String: Any]) {
        if let url = (given["url"] as? String).flatMap(URL.init(string:)), let token = given["token"] as? String {
            app = (url, token)
        } else {
            app = nil
        }
    }

    func stop() {
        server.stop()
    }

    private func respond(to request: HTTPRequest) async -> HTTPResponse {
        guard request.path.hasPrefix("/mcp") else { return .init(status: 404) }
        guard let authorization = request.headers["authorization"], authorization.hasPrefix("Bearer "),
              samePassword(String(authorization.dropFirst(7)), token) else { return .init(status: 401) }
        if let app, let answer = await forward(request, to: app) { return answer }
        return answerWithoutApp(request)
    }

    /// The call, to the open app's tools, as it came: nil when the app doesn't answer (it quit
    /// without saying).
    private func forward(_ request: HTTPRequest, to app: (url: URL, token: String)) async -> HTTPResponse? {
        var forwarded = URLRequest(url: app.url, timeoutInterval: TimeInterval(BrowserTools.executionTimeout) / 1000 + 30)
        forwarded.httpMethod = request.method
        for (name, value) in request.headers where !["authorization", "host", "content-length", "connection"].contains(name) {
            forwarded.setValue(value, forHTTPHeaderField: name)
        }
        forwarded.setValue("Bearer \(app.token)", forHTTPHeaderField: "Authorization")
        forwarded.httpBody = request.body
        do {
            let (data, response) = try await URLSession.shared.data(for: forwarded)
            guard let response = response as? HTTPURLResponse else { return nil }
            var headers: [String: String] = [:]
            for name in ["Content-Type", "Mcp-Session-Id"] { if let value = response.value(forHTTPHeaderField: name) { headers[name] = value } }
            keepList(data, for: request)
            return HTTPResponse(status: response.statusCode, headers: headers, body: data)
        } catch {
            log.info("The app's tools didn't answer: \(error.localizedDescription, privacy: .public)")
            self.app = nil
            return nil
        }
    }

    /// A `tools/list` answer from the app, kept for while it isn't open.
    private func keepList(_ answer: Data, for request: HTTPRequest) {
        guard (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any])?["method"] as? String == "tools/list",
              let reply = try? JSONSerialization.jsonObject(with: answer) as? [String: Any],
              let tools = (reply["result"] as? [String: Any])?["tools"] as? [Any],
              let data = try? JSONSerialization.data(withJSONObject: tools, options: [.sortedKeys]),
              (try? Data(contentsOf: Self.listFile)) != data else { return }
        FileManager.default.createFile(atPath: Self.listFile.path, contents: data, attributes: [.posixPermissions: 0o600])
    }

    /// MCP, answered here: the tools listed as the app last listed them, and each call saying the
    /// browser needs the app.
    private func answerWithoutApp(_ request: HTTPRequest) -> HTTPResponse {
        guard request.method == "POST" else {
            // A client ending its session (DELETE): nothing kept here to end.
            return request.method == "DELETE" ? .init(status: 200) : .init(status: 405, headers: ["Allow": "POST, DELETE"])
        }
        guard let message = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let method = message["method"] as? String else { return .init(status: 400) }
        // A notification has nothing to answer.
        guard let id = message["id"] else { return .init(status: 202) }
        let params = message["params"] as? [String: Any] ?? [:]
        let result: [String: Any]
        switch method {
        case "initialize":
            result = [
                "protocolVersion": params["protocolVersion"] as? String ?? "2025-06-18",
                "capabilities": ["tools": [:] as [String: Any]],
                "serverInfo": ["name": "kuvo-browser", "version": AppInfo.version],
            ]
        case "ping":
            result = [:]
        case "tools/list":
            let tools = (try? Data(contentsOf: Self.listFile)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [Any] } ?? []
            result = ["tools": tools]
        case "tools/call":
            result = ["content": [["type": "text", "text": Self.needsApp]], "isError": true]
        default:
            var answer = HTTPResponse.json(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Method not found"]])
            answer.status = 200
            return answer
        }
        var answer = HTTPResponse.json(["jsonrpc": "2.0", "id": id, "result": result])
        if method == "initialize" { answer.headers["Mcp-Session-Id"] = UUID().uuidString }
        return answer
    }
}
