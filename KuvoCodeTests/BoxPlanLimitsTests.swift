import Foundation
import OpenCodeKit
import Testing
import UsageKit
@testable import KuvoCode

/// Each box's plan limits in the usage panel: one row per login from what this Mac's box and each
/// machine's state (`api/kuvo/limits`), this Mac's own logins marked as the panel's own, a
/// machine's named after it, gone when it goes, and nothing covered by a box from before them.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BoxPlanLimitsTests {
    private static let mac = "http://127.0.0.1:47961"
    private static let devbox = "http://127.0.0.1:47962"

    private static func limits(_ accounts: [[String: Any]], services: [String] = ["claude", "codex", "copilot"]) -> [String: Any] {
        ["data": ["services": services, "accounts": accounts]]
    }

    private static func account(_ provider: String, _ service: String, agent: String? = nil, label: String? = nil, identity: String? = nil, used: Double, minutesAgo: Double = 0) -> [String: Any] {
        let now = Date().timeIntervalSince1970 * 1000
        var account: [String: Any] = ["provider": provider, "service": service, "windows": [
            ["id": "five_hour", "used": used, "minutes": 300, "resetsAt": now + 3_600_000, "read": now - minutesAgo * 60_000, "source": "turn"],
        ]]
        if let identity { account["identity"] = identity }
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

    /// The panel as it was in 0.8.0-beta.11: the same accounts once per computer ("Codex · hetzner",
    /// "Codex · lokum"…). Now one row per account, with the newest numbers any computer read.
    @Test func oneAccountOnSeveralComputersIsOneRow() async throws {
        defer { StubWeb.stop(); HostLimits.shared.update(rows: [], covered: []); UserDefaults.standard.removeObject(forKey: "usage.boxServices") }
        let hetzner = "http://127.0.0.1:47963"
        let mini = "http://127.0.0.1:47964"
        try StubWeb.answer(Self.mac + "/api/kuvo/limits", json: Self.limits([
            Self.account("codex-cli", "codex", agent: "codex", identity: "c0dec0dec0dec0de", used: 0.80, minutesAgo: 20),
            Self.account("openai", "codex", identity: "c0dec0dec0dec0de", used: 0.82, minutesAgo: 10),
        ]))
        try StubWeb.answer(hetzner + "/api/kuvo/limits", json: Self.limits([
            Self.account("claude-code", "claude", agent: "claude", identity: "c1a0dec1a0dec1a0", used: 0.53),
            Self.account("claude-code@a7", "claude", agent: "claude", label: "Athas", identity: "a7a7a7a7a7a7a7a7", used: 0.2),
            Self.account("codex-cli", "codex", agent: "codex", identity: "c0dec0dec0dec0de", used: 0.85, minutesAgo: 1),
        ]))
        // mini's Grok doesn't say who it is (as from an older box): its row stays its own.
        try StubWeb.answer(mini + "/api/kuvo/limits", json: Self.limits([
            Self.account("claude-code", "claude", agent: "claude", identity: "c1a0dec1a0dec1a0", used: 0.50, minutesAgo: 5),
            Self.account("grok-cli", "grok", agent: "grok", used: 0.97),
        ]))
        let planLimits = BoxPlanLimits()
        planLimits.connected(nil, api: api(Self.mac))
        planLimits.connected("hetzner", api: api(hetzner))
        planLimits.connected("mini-local", api: api(mini))
        // (Before, the rows never came to this: each box's own, named after it.)
        try await until { HostLimits.shared.rows.map(\.name) == ["Codex", "Claude", "Claude · Athas", "Grok"] }

        let rows = HostLimits.shared.rows
        // The newest reading: hetzner's Codex, read a minute ago.
        #expect(rows[0].meters.map(\.fraction) == [0.85])
        #expect(rows[1].meters.map(\.fraction) == [0.53])
        // Codex is this Mac's too, and its engine sign-in is the one the panel's own card takes.
        #expect(rows.map(\.isLocal) == [true, false, false, false])
        #expect(rows.filter(\.isOwnLogin).map(\.name) == ["Codex"])
        // This Mac has no Claude of its own here: where it's beside a bar of the panel's own of its
        // name, the account's says which computers it's from (HostLimits.entries; Claude's own bar,
        // which has no limits, gives way to it instead).
        #expect(rows.map(\.place) == [nil, "hetzner, mini-local", "hetzner", "mini-local"])
    }

    /// One of the box's rows of every computer's accounts (`rows`): `boxes`, each `(key, name, here)`.
    private static func row(_ id: String, _ provider: String, agent: String, label: String? = nil, identity: String, used: Double, minutesAgo: Double = 0, boxes: [(String, String, Bool)], away: Bool = false) -> [String: Any] {
        var row = account(provider, "claude", agent: agent, label: label, identity: identity, used: used, minutesAgo: minutesAgo)
        row["id"] = id
        row["boxes"] = boxes.map { key, name, here in ["key": key, "name": name, "provider": provider, "agent": agent, "here": here] as [String: Any] }
        if away { row["away"] = true }
        return row
    }

    /// #210: this Mac's box lists every computer's accounts itself, one row each with the newest
    /// reading any of them made: the panel shows its rows as they are, merges nothing, and a refresh
    /// asks only this Mac's box (which asks the others for what it hasn't).
    @Test func thisMacsBoxListsEveryComputersAccountsAsTheyAre() async throws {
        defer { StubWeb.stop(); HostLimits.shared.update(rows: [], covered: []); UserDefaults.standard.removeObject(forKey: "usage.boxServices") }
        let hetzner = "http://127.0.0.1:47965"
        // This Mac's Claude, read on hetzner a moment ago, not here; and hetzner's Athas, whose
        // computer isn't heard from now.
        try StubWeb.answer(Self.mac + "/api/kuvo/limits", json: ["data": [
            "services": ["claude"],
            "accounts": [Self.account("claude-code", "claude", agent: "claude", identity: "c1a0dec1a0dec1a0", used: 0.1, minutesAgo: 40)],
            "rows": [
                Self.row("claude#c1a0dec1a0dec1a0", "claude-code", agent: "claude", identity: "c1a0dec1a0dec1a0", used: 0.53, minutesAgo: 1, boxes: [("kmac", "MacBook Pro", true), ("khetzner", "hetzner", false)]),
                Self.row("claude#a7a7a7a7a7a7a7a7", "claude-code@a7", agent: "claude", label: "Athas", identity: "a7a7a7a7a7a7a7a7", used: 0.2, minutesAgo: 2, boxes: [("khetzner", "hetzner", false)], away: true),
            ],
        ] as [String: Any]])
        // hetzner's box lists them too; its own numbers aren't merged in here.
        try StubWeb.answer(hetzner + "/api/kuvo/limits", json: ["data": [
            "services": ["claude"],
            "accounts": [Self.account("claude-code", "claude", agent: "claude", identity: "c1a0dec1a0dec1a0", used: 0.99)],
            "rows": [] as [Any],
        ] as [String: Any]])
        try StubWeb.answer(Self.mac + "/api/kuvo/limits/refresh", json: ["data": ["services": ["claude"], "accounts": [] as [Any], "rows": [] as [Any]] as [String: Any]])
        try StubWeb.answer(hetzner + "/api/kuvo/limits/refresh", json: ["data": ["services": ["claude"], "accounts": [] as [Any], "rows": [] as [Any]] as [String: Any]])
        let planLimits = BoxPlanLimits()
        planLimits.connected(nil, api: api(Self.mac))
        planLimits.connected("hetzner", api: api(hetzner))
        try await until { HostLimits.shared.rows.map(\.name) == ["Claude", "Claude · Athas"] && StubWeb.asked.contains(hetzner + "/api/kuvo/limits") }

        let rows = HostLimits.shared.rows
        #expect(rows.map { $0.meters.map(\.fraction) } == [[0.53], [0.2]])
        #expect(rows.map(\.isLocal) == [true, false])
        #expect(rows.map(\.place) == [nil, "hetzner"])
        // Its computer isn't heard from: "As of …", however recent its reading.
        #expect(rows.map(\.isAway) == [false, true])

        planLimits.refreshAll()
        try await until { StubWeb.asked.contains(Self.mac + "/api/kuvo/limits/refresh") }
        #expect(!StubWeb.asked.contains(hetzner + "/api/kuvo/limits/refresh"))
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
