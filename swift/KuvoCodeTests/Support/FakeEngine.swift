import Foundation
import OpenCodeKit

/// An engine's accounts as its API keeps them, in memory: its integrations, and the credentials
/// stored, switched and removed through `api/credential`, answered through StubWeb. For syncing
/// sign-ins between this Mac's engine and a machine's without either running.
nonisolated final class FakeEngine: @unchecked Sendable {
    let url: String
    let api: OpenCodeAPI
    private let lock = NSLock()
    private var credentials: [[String: Any]] = []
    private var integrations: [[String: Any]]
    private var servers: [[String: Any]] = []
    private var refused: Set<String> = []
    private var next = 1

    /// An engine on `port` offering `accounts` (integration IDs).
    init(port: Int, accounts: [String]) {
        url = "http://127.0.0.1:\(port)"
        api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: url)!, password: "test"))
        integrations = accounts.map { ["id": $0, "name": $0, "methods": [["type": "key"]], "connections": []] }
        StubWeb.handle(url + "/api/") { [weak self] request, body in
            self?.answer(request, body) ?? StubWeb.Answer(status: 503)
        }
    }

    /// An integration's MCP server it runs, connected, signing in through `integration`.
    func serve(_ name: String, integration: String) {
        lock.withLock { servers.append(["name": name, "integrationID": integration, "status": ["status": "connected"]]) }
    }

    /// A credential as the engine stores it; its ID.
    @discardableResult
    func store(_ integration: String, label: String? = nil, value: [String: Any], active: Bool = true) -> String {
        lock.withLock { add(integration, label: label ?? integration, value: value, active: active) }
    }

    /// Removing this credential is refused, as an engine that can't write its file refuses it.
    func refuseRemoving(_ id: String) {
        lock.withLock { _ = refused.insert(id) }
    }

    /// What it has, by integration: each credential's ID, whether it's in use, and its refresh
    /// token or key (to tell copies apart).
    func stored(_ integration: String) -> [(id: String, active: Bool, secret: String)] {
        lock.withLock {
            credentials.filter { $0["integrationID"] as? String == integration }.map { entry in
                let value = entry["value"] as? [String: Any] ?? [:]
                return (entry["id"] as! String, entry["active"] as! Bool, (value["refresh"] ?? value["key"]) as? String ?? "")
            }
        }
    }

    private func add(_ integration: String, label: String, value: [String: Any], active: Bool) -> String {
        let id = "cred_\(port)_\(next)"
        next += 1
        if active {
            for index in credentials.indices where credentials[index]["integrationID"] as? String == integration { credentials[index]["active"] = false }
        }
        credentials.append(["id": id, "integrationID": integration, "label": label, "active": active, "value": value])
        return id
    }

    private var port: String { String(url.split(separator: ":").last ?? "") }

    private func answer(_ request: URLRequest, _ body: Data) -> StubWeb.Answer {
        let path = request.url!.path()
        let location: [String: Any] = ["directory": "/"]
        return lock.withLock {
            switch (request.httpMethod ?? "GET", path) {
            case ("GET", "/api/credential"):
                return StubWeb.json(["data": credentials])
            case ("POST", "/api/credential"):
                guard let sent = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                      let integration = sent["integrationID"] as? String, let value = sent["value"] as? [String: Any] else { return StubWeb.Answer(status: 400) }
                let id = add(integration, label: sent["label"] as? String ?? integration, value: value, active: sent["activate"] as? Bool ?? true)
                return StubWeb.json(["data": credentials.first { $0["id"] as? String == id }!])
            case ("DELETE", let path) where path.hasPrefix("/api/credential/"):
                let id = String(path.dropFirst("/api/credential/".count))
                guard credentials.contains(where: { $0["id"] as? String == id }) else { return StubWeb.Answer(status: 404) }
                if refused.contains(id) { return StubWeb.json(["message": "The credentials file couldn't be written."], status: 500) }
                credentials.removeAll { $0["id"] as? String == id }
                return StubWeb.json([:])
            case ("GET", "/api/integration"):
                return StubWeb.json(["location": location, "data": integrations])
            case ("GET", let path) where path.hasPrefix("/api/integration/"):
                let id = String(path.dropFirst("/api/integration/".count)).removingPercentEncoding ?? ""
                guard let found = integrations.first(where: { $0["id"] as? String == id }) else { return StubWeb.json(["message": "Integration not found"], status: 404) }
                return StubWeb.json(["location": location, "data": found])
            // Its plugins set up: its lists are whole (the box asks before it trusts one).
            case ("GET", "/api/provider"):
                return StubWeb.json(["data": [] as [Any]])
            // No folder open, nothing running: a refresh of its models has nothing to wait for.
            case ("GET", "/api/debug/location"):
                return StubWeb.json([] as [Any])
            case ("GET", "/api/session/active"):
                return StubWeb.json(["data": [:] as [String: Any]])
            case ("GET", "/api/mcp"):
                return StubWeb.json(["location": location, "data": servers])
            default:
                return StubWeb.Answer(status: 404)
            }
        }
    }
}
