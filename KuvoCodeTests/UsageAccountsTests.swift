import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode
@testable import UsageKit

/// Which accounts count in the menu bar's usage panel (K4): the plans connected here (Copilot, a
/// ChatGPT or SuperGrok sign-in, Z.ai, OpenRouter, OpenCode), not API keys without a plan, not
/// accounts you switched away from; and the coding agents you're signed in to, which stay while
/// their bridge starts again and across launches. The panel isn't started here, so nothing asks
/// the providers' services. The engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct UsageAccountsTests {
    let engine = StubEngine(port: 47984)
    let catalog = Catalog(isMac: true)
    let location = ["directory": "/"]

    init() {
        TestEnvironment.prepare()
        UserDefaults.standard.removeObject(forKey: "usage.agentProviders")
        catalog.api = engine.api
        for path in ["/api/model", "/api/agent", "/api/command"] { engine.on("GET", path, json: ["location": location, "data": []]) }
        engine.on("GET", "/api/model/default", json: ["location": location, "data": NSNull()])
    }

    private func done() {
        engine.stop()
        UserDefaults.standard.removeObject(forKey: "usage.agentProviders")
        HostAccounts.update([])
    }

    private static func credential(_ integration: String, key: String? = nil, access: String? = nil, active: Bool = true, metadata: [String: Any]? = nil) -> [String: Any] {
        var value: [String: Any] = ["type": access != nil ? "oauth" : "key"]
        if let key { value["key"] = key }
        if let access { value["access"] = access }
        if let metadata { value["metadata"] = metadata }
        return ["id": "cred_\(integration)_\(active)", "integrationID": integration, "active": active, "value": value]
    }

    /// The accounts the engine lists (the coding agents' among them, as the catalog has them).
    private func integrations(_ connected: [String: Bool]) async {
        engine.on("GET", "/api/integration", json: ["location": location, "data": connected.map { id, isConnected in
            ["id": id, "name": id, "methods": [["type": "key"]],
             "connections": isConnected ? [["type": "credential", "credentialID": "cred_\(id)", "method": "key"]] : []]
        }])
        await catalog.refresh()
    }

    @Test func thePlansConnectedHere() async throws {
        defer { done() }
        engine.on("GET", "/api/credential", json: ["data": [
            Self.credential("github-copilot", key: "gho_copilot"),
            Self.credential("openai", access: "chatgpt-token", metadata: ["accountID": "acct_7"]),
            Self.credential("xai", key: "xai-api-key"),
            Self.credential("anthropic", key: "sk-ant-key"),
            Self.credential("zai-coding-plan", key: "zai-key"),
            Self.credential("openrouter", key: "or-old", active: false),
        ]])
        let usage = UsageAccounts()
        usage.api = engine.api
        await usage.sync()
        #expect(usage.followed == ["copilot", "codex", "zai"], "an API key without a plan, or one switched away from, doesn't count")
        // ChatGPT's sign-in goes with its account, which the panel's requests name.
        #expect(HostAccounts.signIn(for: "openai")?.accountID == "acct_7")
        #expect(HostAccounts.secret(for: ["openrouter"]) == nil)
    }

    @Test func codingAgentsSignedInToStay() async throws {
        defer { done() }
        engine.on("GET", "/api/credential", json: ["data": [Self.credential("github-copilot", key: "gho_copilot")]])
        await integrations(["claude-code": true, "codex-cli": false])
        let usage = UsageAccounts()
        usage.api = engine.api
        usage.follow(catalog)
        #expect(usage.followed.isEmpty, "not before the engine's accounts are in: the panel would drop theirs meanwhile")
        await usage.sync()
        #expect(usage.followed == ["copilot", "claude"])

        // The bridge starting again lists no agents for a while: Claude Code's stays.
        await integrations([:])
        try await Task.sleep(for: .milliseconds(100))
        #expect(usage.followed == ["copilot", "claude"])
        // Signed in to Codex too.
        await integrations(["claude-code": true, "codex-cli": true])
        try await until { usage.followed.contains("codex") }
        #expect(usage.followed == ["copilot", "claude", "codex"])

        // The next launch: there before the bridge has said.
        let next = UsageAccounts()
        next.api = engine.api
        await next.sync()
        #expect(next.followed == ["copilot", "claude", "codex"])
    }
}
