import Foundation
import OpenCodeKit
import Testing
import UsageKit
@testable import KuvoCode

/// Each box's plan limits in the usage panel: one row per login from what this Mac's box and each
/// machine's state (`api/kuvo/limits`), this Mac's own logins marked as the panel's own, a
/// machine's named after it, gone when it goes, and nothing covered by a box from before them.
@MainActor
@Suite(.serialized) struct BoxPlanLimitsTests {
    private static let mac = "http://127.0.0.1:47961"
    private static let devbox = "http://127.0.0.1:47962"

    private static func limits(_ accounts: [[String: Any]], services: [String] = ["claude", "codex", "copilot"]) -> [String: Any] {
        ["data": ["services": services, "accounts": accounts]]
    }

    private static func account(_ provider: String, _ service: String, agent: String? = nil, label: String? = nil, used: Double) -> [String: Any] {
        let now = Date().timeIntervalSince1970 * 1000
        var account: [String: Any] = ["provider": provider, "service": service, "windows": [
            ["id": "five_hour", "used": used, "minutes": 300, "resetsAt": now + 3_600_000, "read": now, "source": "turn"],
        ]]
        if let agent { account["agent"] = agent; account["account"] = provider.contains("@") ? String(provider.split(separator: "@")[1]) : "default" }
        if let label { account["label"] = label }
        return account
    }

    init() {
        StubWeb.start(hosts: ["127.0.0.1"])
    }

    private func api(_ url: String) -> OpenCodeAPI {
        OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: url)!, password: "test"))
    }

    @Test func eachLoginIsARowAndAMachinesCarryItsName() async throws {
        defer { StubWeb.stop(); HostLimits.shared.update(rows: [], covered: []); UserDefaults.standard.removeObject(forKey: "usage.boxServices") }
        try StubWeb.answer(Self.mac + "/api/kuvo/limits", json: Self.limits([
            Self.account("claude-code", "claude", agent: "claude", used: 0.42),
            Self.account("claude-code@1f2e", "claude", agent: "claude", label: "Work", used: 0.9),
            Self.account("codex-cli", "codex", agent: "codex", used: 0.2),
            Self.account("openai", "codex", used: 0.3),
        ]))
        try StubWeb.answer(Self.devbox + "/api/kuvo/limits", json: Self.limits([Self.account("claude-code", "claude", agent: "claude", used: 0.1)]))
        let planLimits = BoxPlanLimits()
        planLimits.connected(nil, api: api(Self.mac))
        planLimits.connected("devbox", api: api(Self.devbox))
        try await until { HostLimits.shared.rows.count == 5 }

        let rows = HostLimits.shared.rows
        #expect(rows.map(\.name) == ["Claude", "Claude · Work", "Codex", "ChatGPT", "Claude · devbox"])
        // The panel's own card of each service takes this Mac's own login's: Claude's agent's own
        // sign-in; for Codex the engine's ChatGPT sign-in, as the panel reads Codex.
        #expect(rows.filter(\.isOwnLogin).map(\.name) == ["Claude", "ChatGPT"])
        #expect(rows.map(\.isLocal) == [true, true, true, true, false])
        #expect(HostLimits.shared.covered == ["claude", "codex", "copilot"])

        // The machine goes: its rows with it.
        planLimits.stopped("devbox")
        #expect(HostLimits.shared.rows.map(\.name) == ["Claude", "Claude · Work", "Codex", "ChatGPT"])
    }

    @Test func aBoxFromBeforeThemCoversNothing() async throws {
        defer { StubWeb.stop(); HostLimits.shared.update(rows: [], covered: []); UserDefaults.standard.removeObject(forKey: "usage.boxServices") }
        try StubWeb.answer(Self.mac + "/api/kuvo/limits", json: Self.limits([Self.account("claude-code", "claude", agent: "claude", used: 0.42)]))
        let planLimits = BoxPlanLimits()
        planLimits.connected(nil, api: api(Self.mac))
        try await until { HostLimits.shared.covered.contains("claude") }
        // The box is replaced by one from before plan limits: it answers 404.
        try StubWeb.answer(Self.mac + "/api/kuvo/limits", status: 404, json: ["message": "Not available for this agent."])
        planLimits.stopped(nil)
        planLimits.connected(nil, api: api(Self.mac))
        try await until { HostLimits.shared.covered.isEmpty }
        #expect(HostLimits.shared.rows.isEmpty)
    }
}
