import Foundation
import OpenCodeKit
@testable import KuvoCode

/// An engine at its HTTP API, for tests of sessions: it lists the sessions it's given, says which
/// are running, answers what a test sets up, and records every request the app makes of it, with
/// its body, to check what the app asked for. Anything not set up answers 404, as an engine
/// without it would.
nonisolated final class StubEngine: @unchecked Sendable {
    let url: String
    let api: OpenCodeAPI

    struct Request: CustomStringConvertible {
        var method: String
        var path: String
        var query: [String: String]
        var headers: [String: String]
        var body: [String: Any]
        var description: String { "\(method) \(path) \(body)" }
    }

    private let lock = NSLock()
    private var log: [Request] = []
    private var sessions: [[String: Any]] = []
    private var running: Set<String> = []
    private var answers: [String: (Request) -> StubWeb.Answer] = [:]

    /// An engine on `port` (a port of the test's own; nothing listens there). `alongside`: another
    /// beside one made first (an agents bridge beside an engine), which keeps answering.
    @MainActor init(port: Int, alongside: Bool = false) {
        TestEnvironment.prepare()
        url = "http://127.0.0.1:\(port)"
        api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: url)!, password: "test"))
        if !alongside { StubWeb.start(hosts: ["127.0.0.1"]) }
        StubWeb.handle(url + "/api/") { [weak self] request, body in
            self?.answer(request, body) ?? StubWeb.Answer(status: 503)
        }
    }

    func stop() { StubWeb.stop() }

    /// A session as the engine lists it.
    static func session(_ id: String, title: String = "Session", directory: String, created: Double = 1, extra: [String: Any] = [:]) -> [String: Any] {
        [
            "id": id, "projectID": "p", "cost": 0, "title": title,
            "tokens": ["input": 0, "output": 0, "reasoning": 0, "cache": ["read": 0, "write": 0]],
            "time": ["created": created, "updated": created + 1], "location": ["directory": directory],
        ].merging(extra) { $1 }
    }

    /// The sessions it lists, and those of them at work.
    func list(_ sessions: [[String: Any]], running: Set<String> = []) {
        lock.withLock {
            self.sessions = sessions
            self.running = running
        }
    }

    /// A session's conversation, oldest first: answered as the engine pages it, newest first.
    func conversation(_ session: String, _ messages: [[String: Any]]) {
        on("GET", "/api/session/\(session)/message", json: ["data": Array(messages.reversed())])
    }

    /// What `method` `path` (without its query) answers: the same each time. A path ending in `*`
    /// stands for every path starting with what's before it.
    func on(_ method: String, _ path: String, json: Any, status: Int = 200) {
        let answer = StubWeb.json(json, status: status)
        on(method, path) { _ in answer }
    }

    /// What `method` `path` answers, made from each request.
    func on(_ method: String, _ path: String, _ answer: @escaping (Request) -> StubWeb.Answer) {
        lock.withLock { answers["\(method) \(path)"] = answer }
    }

    /// The requests made so far, oldest first: those with `method` to a path ending in `path`.
    func requests(_ method: String, _ path: String) -> [Request] {
        lock.withLock { log.filter { $0.method == method && $0.path.hasSuffix(path) } }
    }

    /// Every request made so far, oldest first, as "METHOD path".
    var asked: [String] { lock.withLock { log.map { "\($0.method) \($0.path)" } } }

    /// An event from it, as its feed sends them.
    func event(_ type: String, session: String? = nil, _ data: [String: Any] = [:]) throws -> ServerEvent {
        var data = data
        if let session { data["sessionID"] = session }
        let id = "evt_" + Identifier.message().dropFirst("msg_".count)
        return try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": id, "type": type, "created": Date().timeIntervalSince1970 * 1000, "data": data]))
    }

    private func answer(_ request: URLRequest, _ data: Data) -> StubWeb.Answer {
        let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
        let query = Dictionary((components?.queryItems ?? []).map { ($0.name, $0.value ?? "") }) { first, _ in first }
        let method = request.httpMethod ?? "GET"
        let path = request.url!.path()
        let body = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        let headers = Dictionary((request.allHTTPHeaderFields ?? [:]).map { ($0.key.lowercased(), $0.value) }) { first, _ in first }
        let recorded = Request(method: method, path: path, query: query, headers: headers, body: body)
        let key = "\(method) \(path)"
        let answer = lock.withLock {
            log.append(recorded)
            return answers[key] ?? answers.first(where: { $0.key.hasSuffix("*") && key.hasPrefix($0.key.dropLast()) })?.value
        }
        // Outside the lock: an answer may wait (see `Gate`) while other requests go on.
        if let answer { return answer(recorded) }
        return lock.withLock {
            switch (method, path) {
            case ("GET", "/api/session"):
                // As the engine lists them: a session's subagents' for `parentID`, the root ones
                // for "null".
                let parent = query["parentID"]
                return StubWeb.json(["data": sessions.filter { session in
                    guard let parent else { return true }
                    let own = session["parentID"] as? String
                    return parent == "null" ? own == nil : own == parent
                }])
            case ("GET", "/api/session/active"):
                return StubWeb.json(["data": Dictionary(uniqueKeysWithValues: running.map { ($0, ["type": "busy"]) })])
            default:
                return StubWeb.Answer(status: 404)
            }
        }
    }
}

/// Holds an answer back until the test opens it: a request on its way while something else
/// happens, as a slow network has it.
/// Once open, it lets every answer through, those waiting and any after.
nonisolated final class Gate: @unchecked Sendable {
    private let condition = NSCondition()
    private var opened = false

    func wait() {
        condition.lock()
        while !opened { condition.wait() }
        condition.unlock()
    }

    /// Whether it's open yet, without waiting: for an answer that says "not yet" until it is,
    /// leaving other requests to go on meanwhile (`wait` holds every request behind it).
    var isOpen: Bool {
        condition.lock()
        defer { condition.unlock() }
        return opened
    }

    func open() {
        condition.lock()
        opened = true
        condition.broadcast()
        condition.unlock()
    }
}

/// Until `condition` holds (the app's work goes on off the main thread and in tasks), five
/// seconds at most; then the test's own expectations say what didn't happen.
@MainActor
func eventually(_ condition: () -> Bool) async throws {
    for _ in 0..<500 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
}
