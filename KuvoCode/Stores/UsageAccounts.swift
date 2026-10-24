import Foundation
import OpenCodeKit
import UsageKit
import os

private let log = Logger(subsystem: "run.kuvo.code", category: "usage")

/// Connects the usage panel in the menu bar (UsageKit, our fork of OpenUsage) to this app: accounts
/// connected here (ChatGPT, SuperGrok, Copilot, OpenRouter, Z.ai, OpenCode Go, and the coding
/// agents you're signed in to) count there, and so do the engine's own agent runs, which UsageKit
/// reads from the engine's database like any OpenCode install.
@Observable
final class UsageAccounts {
    var api: OpenCodeAPI?
    private var pending: Task<Void, Never>?
    /// The panel's providers for the engine's accounts, once they've been read.
    @ObservationIgnored private var engineProviders: Set<String>?
    /// The panel's providers for the coding agents you're signed in to (Claude Code's is
    /// `claude`), as the bridge last listed them. Kept between launches: while the bridge starts
    /// they'd drop out of the panel, and come back turned on even if you'd hidden them.
    @ObservationIgnored private var agentProviders = Set(UserDefaults.standard.stringArray(forKey: UsageAccounts.agentsKey) ?? [])
    private static let agentsKey = "usage.agentProviders"

    /// Puts the usage item in the menu bar. `engineData` is the engine's opencode data folder.
    func start(engineData: URL, openApp: @escaping @MainActor () -> Void) {
        HostAccounts.setOpenCodeDataDirectories([engineData.path])
        // The engine renews a sign-in's token without an event; the panel asks when its copy lapses.
        HostAccounts.setReader { [weak self] in await self?.sync() }
        UsageMenuBar.shared.start(openHostApp: openApp)
    }

    /// Hands the engine's active accounts to UsageKit, and which of its providers they stand for:
    /// the panel follows only those. Secrets stay in memory.
    func sync() async {
        guard let api else { return }
        do {
            let credentials = try await api.credentialSecrets()
            HostAccounts.update(credentials.filter(\.active).compactMap { credential in
                guard let secret = credential.value.access ?? credential.value.key, !secret.isEmpty else { return nil }
                // ChatGPT's sign-in names its account, which the usage requests send.
                return HostCredential(integrationID: credential.integrationID, secret: secret,
                                      signedIn: Self.isSignIn(credential),
                                      accountID: credential.value.metadata?["accountID"]?.string)
            } + [Self.cursorAgentKey()].compactMap { $0 })
            engineProviders = Set(credentials.filter(\.active).compactMap {
                Self.usageProvider(for: $0.integrationID, signedIn: Self.isSignIn($0))
            })
            publish()
        } catch {
            log.error("credentials: \(String(describing: error), privacy: .public)")
        }
    }

    /// Follows the coding agents' accounts in `catalog`: one signed in counts in the panel, which
    /// reads the agent's own sign-in on this Mac (Claude Code's, the Codex CLI's) as it does for
    /// anyone using it.
    func follow(_ catalog: Catalog) {
        let accounts = withObservationTracking {
            catalog.codingAgents
        } onChange: { [weak self, weak catalog] in
            Task { @MainActor in
                guard let self, let catalog else { return }
                self.follow(catalog)
            }
        }
        // None listed: the bridge isn't up (starting, or stopped), not signed out of every agent.
        guard !accounts.isEmpty else { return }
        let providers = Set(accounts.filter(\.isConnected).compactMap { Self.usageProvider(forAgent: $0.id) })
        guard providers != agentProviders else { return }
        // A coding agent signed in (or out) of Cursor: the panel reads it with what it has now.
        if providers.contains("cursor") != agentProviders.contains("cursor") { Task { await sync() } }
        agentProviders = providers
        UserDefaults.standard.set(providers.sorted(), forKey: Self.agentsKey)
        publish()
    }

    /// The panel's providers it follows: the engine's accounts' and the coding agents'.
    private(set) var followed: Set<String> = []

    /// Tells the panel which providers it follows, once the engine's accounts are in: before, it
    /// would drop theirs and turn them back on after.
    private func publish() {
        guard let engineProviders else { return }
        followed = engineProviders.union(agentProviders)
        HostAccounts.setConnectedProviders(followed)
    }

    /// The usage panel's provider for a coding agent's account (any of yours with it).
    static func usageProvider(forAgent providerID: String) -> String? {
        switch OutsideAgents.base(providerID) {
        case "claude-code": "claude"
        case "codex-cli": "codex"
        case "grok-cli": "grok"
        case "cursor": "cursor"
        case "antigravity": "antigravity"
        default: nil
        }
    }

    /// Cursor's sign-in for the coding agents (the agents bridge's, yours or the first account
    /// you added), for the panel to read Cursor's usage with when the Cursor app isn't signed in.
    /// Read where the bridge keeps it, while it's good.
    static func cursorAgentKey(in home: URL = OutsideAgents.home, now: Date = .now) -> HostCredential? {
        struct Saved: Decodable { var apiKey: String?; var apiKeyExpiresAtMs: Double? }
        let accounts = home.appending(path: "cursor/accounts")
        let added = ((try? FileManager.default.contentsOfDirectory(atPath: accounts.path)) ?? []).sorted().map { accounts.appending(path: "\($0)/auth.json") }
        for file in [home.appending(path: "cursor/auth.json")] + added {
            guard let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Saved.self, from: data),
                  let key = saved.apiKey, !key.isEmpty, (saved.apiKeyExpiresAtMs ?? .infinity) > now.timeIntervalSince1970 * 1000 else { continue }
            return HostCredential(integrationID: HostCredential.cursorAgent, secret: key, signedIn: true)
        }
        return nil
    }

    private static func isSignIn(_ credential: CredentialSecret) -> Bool {
        credential.value.type == "oauth" || credential.value.access != nil
    }

    /// The usage panel's provider for an account connected here, if it has one: a plan with limits
    /// or spend to follow. ChatGPT's sign-in is Codex; an OpenAI API key has no plan. SuperGrok's
    /// sign-in is Grok's weekly limit; an xAI API key has none. Anthropic only takes API keys here,
    /// and an Ollama key isn't the plan its panel reads, so they don't count.
    static func usageProvider(for integrationID: String, signedIn: Bool) -> String? {
        switch integrationID {
        case "github-copilot": "copilot"
        case "openai": signedIn ? "codex" : nil
        case "xai": signedIn ? "grok" : nil
        case "opencode", "opencode-go": "opencode"
        case "openrouter": "openrouter"
        case "zai", "zai-coding-plan": "zai"
        default: nil
        }
    }

    /// Accounts change in bursts (a sign-in updates integrations and credentials at once).
    func handle(_ event: ServerEvent) {
        switch event.type {
        case "integration.updated", "credential.updated", "credential.switched":
            pending?.cancel()
            pending = Task {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                await sync()
            }
        default:
            break
        }
    }
}
