import Foundation
import OpenCodeKit
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "keeper")

/// Kuvo Code's own tools that this Mac's box answers without the app, for the keeper while the app
/// isn't open (`KeeperTools`): agents writing to each other and running their sessions, wake-ups,
/// a bot's job, the vault, the sandbox's way out, the Work Queue, and showing a file or a widget in
/// the conversation. Every box answers them alike (`kuvo/agent-tools`, `kuvo/vault/tools`,
/// `kuvo/sandbox/tools`, `kuvo/work-queue/tools`), as a machine's `kuvo-browser.js mcp` passes them
/// on, so bots on this Mac keep doing them with the app closed. The box is found by its record in `run` (`serve.json`).
@MainActor
final class KeeperBoxTools {
    typealias Answer = (text: String, isError: Bool)

    /// Where one of the box's processes answers, by its record's name.
    private let record: @MainActor (String) -> ServerEndpoint?
    /// Its own, never one a test's web stand-in answers for.
    private let session = URLSession(configuration: .ephemeral)

    init(record: @escaping @MainActor (String) -> ServerEndpoint? = { KeeperFollower.record($0) }) {
        self.record = record
    }

    /// Whether this answers `name`, rather than the open app: every one the box answers but
    /// show_in_panel, which the window shows (the transcript draws show_file's and show_widget's
    /// from the call, on the Mac when it opens and on a phone, and the box reads mark_final's).
    static func answers(_ name: String) -> Bool {
        (BrowserTools.boxTools.contains(name) && name != BrowserTools.showInPanel) || BrowserTools.isVault(name) || BrowserTools.isSandbox(name)
            || BrowserTools.isWorkQueue(name)
    }

    /// A call from `caller`'s conversation (the engine's session, or the coding agent's the bridge
    /// named): its MCP result.
    func call(_ name: String, _ arguments: [String: Any], caller: String?) async -> [String: Any] {
        let answer: Answer
        if BrowserTools.isVault(name) {
            answer = await vault(name, arguments, caller)
        } else if BrowserTools.isSandbox(name) {
            answer = await sandbox(name, arguments, caller)
        } else if BrowserTools.isWorkQueue(name) {
            answer = await workQueue(name, arguments, caller)
        } else {
            answer = await mail(name, arguments, caller)
        }
        return ["content": [["type": "text", "text": answer.text]], "isError": answer.isError]
    }

    /// The vault's tools as the box lists them (`GET kuvo/vault/tools`): none without a box, or
    /// while agents may not use the vault.
    func vaultDefinitions() async -> [[String: Any]] {
        guard let answer = try? await box("GET", "kuvo/vault/tools", timeout: 15), answer.status == 200 else { return [] }
        return (try? JSONSerialization.jsonObject(with: answer.data) as? [String: Any])?["tools"] as? [[String: Any]] ?? []
    }

    // MARK: Kuvo Code's own

    /// list_agents, send_message, read_conversation, the wake-ups, set_job and the rest: the box answers them
    /// (`POST kuvo/agent-tools`). One that waits for an answer holds up to eleven minutes;
    /// stopped, the box stops waiting, and an answer that comes later reaches the conversation as
    /// a message.
    private func mail(_ name: String, _ arguments: [String: Any], _ caller: String?) async -> Answer {
        var body: [String: Any] = ["name": name, "arguments": arguments]
        if let caller { body["session"] = caller }
        guard let answer = try? await box("POST", "kuvo/agent-tools", body: body, timeout: 720) else {
            return ("Kuvo Code’s background service on this Mac didn’t answer. Try again in a moment.", true)
        }
        let said = (try? JSONSerialization.jsonObject(with: answer.data)) as? [String: Any]
        guard answer.status == 200, let text = said?["text"] as? String else {
            return (said?["message"] as? String ?? "Kuvo Code’s background service on this Mac didn’t answer. Try again in a moment.", true)
        }
        return (text, said?["isError"] as? Bool ?? false)
    }

    // MARK: The vault

    /// vault_items, vault_ask, vault_run: under the caller's grants (`POST kuvo/vault/tools`). One
    /// that asks you waits for you.
    private func vault(_ name: String, _ arguments: [String: Any], _ caller: String?) async -> Answer {
        var body: [String: Any] = ["name": name, "arguments": arguments]
        if let caller { body["session"] = caller }
        guard let answer = try? await box("POST", "kuvo/vault/tools", body: body, timeout: 16 * 60) else {
            return ("This Mac's vault can't be reached now. Try again in a moment.", true)
        }
        let said = (try? JSONSerialization.jsonObject(with: answer.data)) as? [String: Any]
        guard answer.status == 200, let text = said?["text"] as? String else {
            return (said?["message"] as? String ?? "The vault couldn't do that (\(answer.status)).", true)
        }
        return (text, said?["isError"] as? Bool ?? false)
    }

    // MARK: The sandbox

    /// The sandbox's tools as the box lists them (`GET kuvo/sandbox/tools`): none without a box, or
    /// while commands here aren't in the sandbox.
    func sandboxDefinitions() async -> [[String: Any]] {
        guard let answer = try? await box("GET", "kuvo/sandbox/tools", timeout: 15), answer.status == 200 else { return [] }
        return (try? JSONSerialization.jsonObject(with: answer.data) as? [String: Any])?["tools"] as? [[String: Any]] ?? []
    }

    /// sandbox_ask: the box asks you, and runs the command you allow (`POST kuvo/sandbox/tools`),
    /// as it does for the open app's tools. It waits for you.
    private func sandbox(_ name: String, _ arguments: [String: Any], _ caller: String?) async -> Answer {
        var body: [String: Any] = ["name": name, "arguments": arguments]
        if let caller { body["session"] = caller }
        guard let answer = try? await box("POST", "kuvo/sandbox/tools", body: body, timeout: TimeInterval(BrowserTools.executionTimeout) / 1000) else {
            return ("This Mac's box can't be reached now. Try again in a moment.", true)
        }
        let said = (try? JSONSerialization.jsonObject(with: answer.data)) as? [String: Any]
        guard answer.status == 200, let text = said?["text"] as? String else {
            return (said?["message"] as? String ?? "The sandbox couldn't do that (\(answer.status)).", true)
        }
        return (text, said?["isError"] as? Bool ?? false)
    }

    // MARK: The Work Queue

    /// The Work Queue's tools, and what agents are told of them, as the box gives them
    /// (`GET kuvo/work-queue/tools`): none without a box.
    func workQueueDefinitions() async -> (tools: [[String: Any]], instructions: String) {
        guard let answer = try? await box("GET", "kuvo/work-queue/tools", timeout: 15), answer.status == 200,
              let said = try? JSONSerialization.jsonObject(with: answer.data) as? [String: Any],
              let tools = said["tools"] as? [[String: Any]] else { return ([], "") }
        return (tools, said["instructions"] as? String ?? "")
    }

    /// queue_add, queue_list and the rest: the box carries them out for the conversation calling
    /// (`POST kuvo/work-queue/tools`), as it does for the open app's tools.
    private func workQueue(_ name: String, _ arguments: [String: Any], _ caller: String?) async -> Answer {
        var body: [String: Any] = ["name": name, "arguments": arguments]
        if let caller { body["session"] = caller }
        guard let answer = try? await box("POST", "kuvo/work-queue/tools", body: body, timeout: 16 * 60) else {
            return ("This Mac's box can't be reached now. Try again in a moment.", true)
        }
        let said = (try? JSONSerialization.jsonObject(with: answer.data)) as? [String: Any]
        guard answer.status == 200, let text = said?["text"] as? String else {
            return (said?["message"] as? String ?? "The Work Queue couldn't do that (\(answer.status)).", true)
        }
        return (text, said?["isError"] as? Bool ?? false)
    }

    // MARK: HTTP

    /// One of this Mac's box's routes; throws when it isn't running or doesn't answer.
    private func box(_ method: String, _ path: String, body: [String: Any]? = nil, timeout: TimeInterval) async throws -> (status: Int, data: Data) {
        guard let endpoint = record("serve.json") else { throw URLError(.cannotConnectToHost) }
        return try await send(method, path, to: endpoint, body: body, timeout: timeout)
    }

    private func send(_ method: String, _ path: String, to endpoint: ServerEndpoint, body: [String: Any]? = nil, timeout: TimeInterval) async throws -> (status: Int, data: Data) {
        let base = endpoint.url.absoluteString.hasSuffix("/") ? endpoint.url.absoluteString : endpoint.url.absoluteString + "/"
        guard let url = URL(string: base + path) else { throw URLError(.badURL) }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        if let password = endpoint.password {
            request.setValue("Basic " + Data("\(endpoint.username):\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        do {
            // (A total, not only a wait between bytes: the box says it's still working on a request
            // it holds every 20 seconds, which a request's own timeout counts as activity.)
            let session = self.session, sent = request
            let (data, response) = try await withThrowingTaskGroup(of: (Data, URLResponse).self) { group in
                group.addTask { try await session.data(for: sent) }
                group.addTask {
                    try await Task.sleep(for: .seconds(timeout))
                    throw URLError(.timedOut)
                }
                defer { group.cancelAll() }
                guard let first = try await group.next() else { throw URLError(.unknown) }
                return first
            }
            return ((response as? HTTPURLResponse)?.statusCode ?? 502, data)
        } catch {
            log.info("This Mac's box didn't answer \(method, privacy: .public) \(path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            throw error
        }
    }
}
