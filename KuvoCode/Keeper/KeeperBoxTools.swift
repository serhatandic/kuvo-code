import Foundation
import OpenCodeKit
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "keeper")

/// Kuvo Code's own tools that this Mac's box answers without the app, for the keeper while the app
/// isn't open (`KeeperTools`): agents writing to each other and running their sessions, wake-ups,
/// a bot's job, the vault, the sandbox's way out, and showing a file or a widget in the
/// conversation. A machine's box answers the same calls in its `kuvo-browser.js mcp` (`mail`,
/// `wake`, `setJob`, its vault and sandbox calls), and this does what it does, so bots on this Mac
/// keep doing them with the app closed.
/// The box, its engine and the coding agents' bridge are found by their records in `run`
/// (`serve.json`, `engine.json`, `bridge.json`), as a machine's are.
@MainActor
final class KeeperBoxTools {
    typealias Answer = (text: String, isError: Bool)

    /// Where one of the box's processes answers, by its record's name.
    private let record: @MainActor (String) -> ServerEndpoint?
    /// The environment kuvo-wake runs with: your shell's, as the keeper's runner has it.
    var shell: @MainActor () -> [String: String] = { ProcessInfo.processInfo.environment }
    /// Its own, never one a test's web stand-in answers for.
    private let session = URLSession(configuration: .ephemeral)
    /// Where each session was found: the engine's (`engine.json`) or the bridge's (`bridge.json`).
    private var places: [String: String] = [:]

    init(record: @escaping @MainActor (String) -> ServerEndpoint? = { KeeperFollower.record($0) }) {
        self.record = record
    }

    /// The tools shown in the conversation itself, which need no window: the transcript draws them
    /// from the call (on the Mac when it opens, and on a phone), and the box reads `mark_final`.
    static let shownTools: Set<String> = [BrowserTools.showFile, BrowserTools.showWidget, BrowserTools.markFinal]

    /// Whether this answers `name`, rather than the open app.
    static func answers(_ name: String) -> Bool {
        BrowserTools.mailTools.contains(name) || BrowserTools.wakeTools.contains(name) || name == BrowserTools.setJob
            || BrowserTools.isVault(name) || BrowserTools.isSandbox(name) || shownTools.contains(name)
    }

    /// A call from `caller`'s conversation (the engine's session, or the coding agent's the bridge
    /// named): its MCP result.
    func call(_ name: String, _ arguments: [String: Any], caller: String?) async -> [String: Any] {
        if name == BrowserTools.showFile { return BrowserTools.showFileCall(arguments) }
        if name == BrowserTools.showWidget { return BrowserTools.showWidgetCall(arguments) }
        if name == BrowserTools.markFinal { return BrowserTools.markFinalCall(arguments) }
        let answer: Answer
        if BrowserTools.isVault(name) {
            answer = await vault(name, arguments, caller)
        } else if BrowserTools.isSandbox(name) {
            answer = await sandbox(name, arguments, caller)
        } else if name == BrowserTools.setJob {
            answer = await setJob(arguments, caller)
        } else if BrowserTools.wakeTools.contains(name) {
            answer = await wake(name, arguments, caller)
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

    // MARK: Agents writing to each other

    /// list_agents, send_message, read_conversation and the rest: the box answers them
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

    // MARK: A bot's job

    /// set_job: the box keeps it in the bot's record (`PATCH kuvo/bots/<id>` with `job`), for the
    /// bot whose conversation this is (a subagent's, the one that started it).
    private func setJob(_ arguments: [String: Any], _ caller: String?) async -> Answer {
        guard let caller else { return ("This needs a conversation of its own.", true) }
        let root = await rootOf(caller)
        guard let bot = Self.bot(owning: root.session) else { return ("Only a bot keeps a job, and this conversation isn't one.", true) }
        let clear = arguments["clear"] as? Bool == true
        let inputLine = (arguments["summary"] ?? arguments["job"]) as? String
        let details = arguments["details"] as? String
        guard clear || (inputLine?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false && details != nil) else {
            return ("Provide a non-empty summary and details, or clear: true to clear your job.", true)
        }
        let job: [String: Any] = ["line": clear ? "" : inputLine!, "details": clear ? "" : details!]
        guard let answer = try? await box("PATCH", "kuvo/bots/" + Self.escaped(bot.lastPathComponent), body: ["job": job], timeout: 30) else {
            return ("Couldn't keep it: Kuvo Code’s background service on this Mac didn’t answer. Try again in a moment.", true)
        }
        let said = (try? JSONSerialization.jsonObject(with: answer.data)) as? [String: Any]
        guard answer.status == 200 else { return (said?["message"] as? String ?? "Couldn't keep it (\(answer.status)).", true) }
        guard let line = (said?["bot"] as? [String: Any])?["job"] as? String else { return ("The box returned an unreadable job response. Check the job before trying again.", true) }
        return line.isEmpty ? ("Kept: you have no job now.", false) : ("Kept. Kuvo Code shows \"\(line)\" under your name.", false)
    }

    // MARK: Wake-ups

    /// schedule_wake_up, watch_for_change, list_wake_ups, cancel_wake_up: through this Mac's
    /// kuvo-wake, for the conversation the caller is part of (a subagent's, the one that started
    /// it; a bot's, the bot's folder), as `WakeUps.call` runs it with the app open. Never a group
    /// chat's seat: meetings are the chat's.
    private func wake(_ name: String, _ arguments: [String: Any], _ caller: String?) async -> Answer {
        guard let caller else { return ("This needs a conversation of its own.", true) }
        let root = await rootOf(caller)
        let calling = await findSession(caller)
        if Self.isSeat(calling?.data) || Self.isSeat(root.found?.data) {
            return ("Not from a group chat: a chat can meet on a schedule instead (its editor's Meets on a Schedule).", true)
        }
        let bot = Self.bot(owning: root.session)
        guard bot != nil || root.found != nil else { return ("Kuvo Code doesn't know this conversation yet. Try again in a moment.", true) }
        // A coding agent's session: its wake-ups go to the agents' bridge.
        let viaBridge = root.found?.place == "bridge.json"
        func given(_ key: String) -> String? {
            guard let value = (arguments[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
            return value
        }
        var verb: [String]
        switch name {
        case "schedule_wake_up":
            guard let when = given("when") else { return ("Say when (when): +20m, +2h, +1d, or a time like 2026-10-21T09:00.", true) }
            guard let note = given("note") else { return ("Add a note for yourself (note): what to do when you wake up.", true) }
            verb = ["add", when] + (given("every").map { ["--every", $0] } ?? []) + (given("summary").map { ["--summary", $0] } ?? []) + [note]
        case "watch_for_change":
            // A watch runs a command whenever it's due: in Ask First, only once you've been asked
            // (the engine asks for the tool in a conversation made since it does; not for one from
            // before, nor through the coding agents' bridge).
            let found = calling ?? root.found
            let rules = (found?.data["permissions"]).flatMap { try? JSONSerialization.data(withJSONObject: $0) }
                .flatMap { try? JSONDecoder().decode([PermissionRule].self, from: $0) }
            if ToolApproval.watchWentUnasked(rules, agents: found.map { $0.place == "bridge.json" } ?? viaBridge) { return (ToolApproval.watchAsCommand, true) }
            guard let every = given("every"), let check = given("check"), let note = given("note") else {
                return ("Give how often (every), the check (a shell command) and a note for when it changes.", true)
            }
            verb = ["watch", every, check] + (given("summary").map { ["--summary", $0] } ?? []) + [note]
        case "list_wake_ups":
            verb = ["list"]
        case "cancel_wake_up":
            guard let id = given("id") else { return ("Say which one (id), from list_wake_ups.", true) }
            verb = ["cancel", id]
        default:
            return ("Unknown tool \(name).", true)
        }
        // A session's folder is made by kuvo-wake, with the folder it runs in as the session's.
        let folder = ((root.found?.data["location"] as? [String: Any])?["directory"] as? String)
            .flatMap { FileManager.default.fileExists(atPath: $0) ? URL(filePath: $0) : nil }
        var environment = shell()
        environment["KUVO_BOTS"] = Bots.root.path
        environment["KUVO_WAKES"] = WakeUps.root.path
        environment["KUVO_WAKE_TOOL"] = "1"
        environment["KUVO_WAKE_VIA"] = viaBridge ? "bridge" : nil
        environment["OPENCODE_SESSION_ID"] = nil
        try? WakeUps.installCommand()
        do {
            // Never stopped half way by the caller going away: it changes what's kept.
            let result = try await ChildProcess.run("/bin/sh", [WakeUps.command.path, bot?.path ?? root.session] + verb, environment: environment,
                                                    directory: folder ?? FileManager.default.homeDirectoryForCurrentUser,
                                                    errors: .withOutput, limit: .seconds(30), cancellable: false)
            let text = result.outputText.trimmingCharacters(in: .whitespacesAndNewlines)
            return (text.isEmpty ? (result.status == 0 ? "Done." : "That didn't work.") : text, result.status != 0)
        } catch {
            return ("Couldn't run kuvo-wake here: \(error.localizedDescription)", true)
        }
    }

    // MARK: Conversations

    /// A session where it runs: the engine's, or the coding agents' bridge's. Nil when neither
    /// has it (or can't say now).
    private func findSession(_ id: String) async -> (place: String, data: [String: Any])? {
        let known = places[id]
        for place in known.map({ [$0] }) ?? ["engine.json", "bridge.json"] {
            guard let endpoint = record(place),
                  let answer = try? await send("GET", "api/session/" + Self.escaped(id), to: endpoint, timeout: 10), answer.status == 200,
                  let data = ((try? JSONSerialization.jsonObject(with: answer.data)) as? [String: Any])?["data"] as? [String: Any] else { continue }
            places[id] = place
            return (place, data)
        }
        return nil
    }

    /// The conversation a call works for: itself, a subagent's (the one that started it), and a
    /// coding agent's engine run (Auto's) the conversation it runs for (`kuvo.engineFor`), as the
    /// box finds it (`rootOf`). `found`: where it runs, nil when it isn't one here.
    private func rootOf(_ caller: String) async -> (session: String, found: (place: String, data: [String: Any])?) {
        var id = caller
        var top: (session: String, found: (place: String, data: [String: Any])?) = (caller, nil)
        for _ in 0..<6 {
            guard let found = await findSession(id) else { break }
            top = (id, .some(found))
            let kuvo = (found.data["metadata"] as? [String: Any])?["kuvo"] as? [String: Any]
            guard let above = found.data["parentID"] as? String ?? kuvo?["engineFor"] as? String else { break }
            id = above
        }
        return top
    }

    /// A group chat's seat, by its session's record.
    private static func isSeat(_ data: [String: Any]?) -> Bool {
        ((data?["metadata"] as? [String: Any])?["kuvo"] as? [String: Any])?["seat"].map { !($0 is NSNull) } ?? false
    }

    /// The folder of the bot on this Mac whose conversation `session` is.
    private static func bot(owning session: String) -> URL? {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: Bots.root.path)) ?? []
        return names.sorted().first { name in
            name.hasPrefix("bot_") && name.dropFirst(4).allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) } && name.count > 4
                && (try? String(contentsOf: Bots.root.appending(path: name).appending(path: "session"), encoding: .utf8))?
                    .trimmingCharacters(in: .whitespacesAndNewlines) == session
        }.map { Bots.root.appending(path: $0) }
    }

    // MARK: HTTP

    private static func escaped(_ part: String) -> String {
        part.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? part
    }

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
