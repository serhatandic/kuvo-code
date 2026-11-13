import Foundation
import OpenCodeKit
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "keeper")

/// Kuvo Code's own tools (the panel's browser, `BrowserToolServer`) as the keeper's engine and
/// coding agents reach them: an MCP server of the keeper's, on 127.0.0.1, whose address stays the
/// same while the app opens and quits. While the app is open, it has said where its tools answer
/// (`KeeperControl.Command.app`) and each call goes there as it is. While it isn't, the tools are
/// still listed (as the app last listed them), and the box answers what a machine's box answers
/// without any app (`KeeperBoxTools`): agents writing to each other and running their sessions,
/// wake-ups, a bot's job, the vault, the sandbox's way out, and a file or widget shown in the
/// conversation. Only the browser and the side panel need the app: a browser call opens it in the
/// background (`AppOpener`) and goes to it once it has said where its tools answer; the panel says
/// it isn't open (nobody is looking at a window it opened by itself).
@MainActor
final class KeeperTools {
    private lazy var server = LoopbackServer { [weak self] request in await self?.respond(to: request) ?? .init(status: 503) }
    private let token = UUID().uuidString + UUID().uuidString
    /// Where the open app's tools answer, and to what token.
    private var app: (url: URL, token: String)?
    /// The tools this Mac's box answers while the app isn't open.
    let boxTools: KeeperBoxTools
    /// Tool calls under way without the app, by client and request: one the client cancels stops
    /// (a message that waits for its answer stops waiting).
    private var calls: [String: Task<CallResult, Never>] = [:]
    private struct CallResult: @unchecked Sendable { let value: [String: Any] }

    /// Opens the app for a browser call while it's closed.
    let opener: AppOpener

    /// `record`: where the box's processes answer, by their records in `run` (a test's own);
    /// `opener`: how the app is opened for its browser (a test's never opens one).
    init(record: @escaping @MainActor (String) -> ServerEndpoint? = { KeeperFollower.record($0) }, opener: AppOpener = AppOpener()) {
        boxTools = KeeperBoxTools(record: record)
        self.opener = opener
        opener.isReady = { [weak self] in self?.app != nil }
    }

    /// What a call the app answers says while it isn't open (and it isn't one the app is opened for).
    static let needsApp = "This tool needs Kuvo Code open on this Mac, and it isn't open now. Ask the user to open Kuvo Code, then try again."
    /// What show_in_panel says while the app isn't open.
    static let panelNeedsApp = "Kuvo Code isn't open on this Mac, so its side panel can't show anything now. To show the user a file, use show_file: it's in the conversation, on their Mac and their phone."
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
            opener.ready()
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
        // A browser call with the app closed: the app opened in the background, and the call
        // goes to it once it's there; what went wrong otherwise.
        if app == nil, Self.opensApp(request) {
            if let failed = await opener.open() { return await answerWithoutApp(request, failed: failed) }
            if let app, let answer = await forward(request, to: app) { return answer }
        }
        return await answerWithoutApp(request)
    }

    /// Whether `request` calls one of the browser's tools, which the app is opened for.
    private static func opensApp(_ request: HTTPRequest) -> Bool {
        guard request.method == "POST",
              let message = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              message["method"] as? String == "tools/call", message["id"] != nil,
              let name = (message["params"] as? [String: Any])?["name"] as? String else { return false }
        return BrowserTools.isBrowser(name)
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
            // Nobody there: the app quit without saying. Anything else (a call stopped, or one that
            // took too long) leaves it the app's, and says what happened.
            guard (error as? URLError)?.code == .cannotConnectToHost else {
                return await answerWithoutApp(request, failed: "The call didn’t finish: \(error.localizedDescription)")
            }
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

    /// MCP, answered here: the tools listed as the app last listed them; a call to the browser or
    /// the panel saying they need the app, and the rest answered by the box (`KeeperBoxTools`).
    /// `failed`: what a call says instead, the open app's having not finished.
    private func answerWithoutApp(_ request: HTTPRequest, failed: String? = nil) async -> HTTPResponse {
        guard request.method == "POST" else {
            // A client ending its session (DELETE): nothing kept here to end.
            return request.method == "DELETE" ? .init(status: 200) : .init(status: 405, headers: ["Allow": "POST, DELETE"])
        }
        guard let message = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let method = message["method"] as? String else { return .init(status: 400) }
        let params = message["params"] as? [String: Any] ?? [:]
        let client = request.headers["mcp-session-id"]
        // A notification has nothing to answer; a call the client gave up on stops.
        guard let id = message["id"] else {
            if method == "notifications/cancelled", let asked = params["requestId"] { calls[Self.key(asked, client: client)]?.cancel() }
            return .init(status: 202)
        }
        let result: [String: Any]
        switch method {
        case "initialize":
            let requested = params["protocolVersion"] as? String
            let supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
            result = [
                "protocolVersion": requested.flatMap { supported.contains($0) ? $0 : nil } ?? "2025-06-18",
                "capabilities": ["tools": ["listChanged": false]],
                "serverInfo": ["name": "kuvo-browser", "title": "Kuvo Code browser", "version": AppInfo.version],
                // What the tools are for, as the app tells it: a model that starts while the app
                // is closed hears it too.
                "instructions": BrowserTools.instructions(machine: false, vault: await listed().contains { BrowserTools.isVault($0["name"] as? String ?? "") }),
            ]
        case "ping":
            result = [:]
        case "tools/list":
            result = ["tools": await listed()]
        case "tools/call":
            let name = params["name"] as? String ?? ""
            let arguments = params["arguments"] as? [String: Any] ?? [:]
            if let failed {
                result = ["content": [["type": "text", "text": failed]], "isError": true]
            } else if KeeperBoxTools.answers(name) {
                // The engine names the session calling; the coding agents' bridge, in a header.
                let caller = (params["_meta"] as? [String: Any])?["ai.opencode/sessionID"] as? String ?? request.headers["x-kuvo-session"]
                let key = Self.key(id, client: client)
                let call = Task { [boxTools] in CallResult(value: await boxTools.call(name, arguments, caller: caller)) }
                calls[key] = call
                defer { if calls[key] == call { calls[key] = nil } }
                // The connection closing stops it too.
                result = await withTaskCancellationHandler { await call.value } onCancel: { call.cancel() }.value
            } else {
                result = ["content": [["type": "text", "text": name == BrowserTools.showInPanel ? Self.panelNeedsApp : Self.needsApp]], "isError": true]
            }
        default:
            var answer = HTTPResponse.json(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Method not found"]])
            answer.status = 200
            return answer
        }
        var answer = HTTPResponse.json(["jsonrpc": "2.0", "id": id, "result": result])
        if method == "initialize" { answer.headers["Mcp-Session-Id"] = UUID().uuidString }
        return answer
    }

    /// The tools as the app last listed them; before it ever has, Kuvo Code's own, with the
    /// vault's as this Mac's box lists them. The sandbox's as the box lists them now, whatever the
    /// app last listed: only while commands here run in the sandbox.
    private func listed() async -> [[String: Any]] {
        let sandbox = await boxTools.sandboxDefinitions()
        if let kept = (try? Data(contentsOf: Self.listFile)).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] }) {
            return kept.filter { !BrowserTools.isSandbox($0["name"] as? String ?? "") } + sandbox
        }
        return BrowserTools.definitions(vault: await boxTools.vaultDefinitions()) + sandbox
    }

    private static func key(_ id: Any, client: String?) -> String { (client ?? "") + "|" + String(describing: id) }
}
