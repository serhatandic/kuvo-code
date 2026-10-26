import Foundation
import OpenCodeKit
import os

private let log = Logger(subsystem: "run.kuvo.code", category: "catalog")

/// What the engine offers: providers to sign in to, models, agents, commands.
/// All of it comes from the engine, so new providers appear without an app update.
@Observable
final class Catalog {
    var api: OpenCodeAPI?
    /// This Mac's engine's, whose list of models says what every engine is started with
    /// (`ProviderCompatibility`); a machine's would make the two take turns, and the machine's
    /// engine look out of date each time.
    let isMac: Bool

    init(isMac: Bool = false) {
        self.isMac = isMac
    }

    /// The outside agents' bridge (Claude Code, Codex…), on this Mac's catalog: their accounts and
    /// models join the engine's.
    @ObservationIgnored var outsideAgents: OutsideAgents?
    /// The machine whose engine this is (nil: this Mac's): sign-ins to its agents finish in this
    /// Mac's browser.
    @ObservationIgnored var machine: String?

    /// The engine's integrations, and the outside agents' after them.
    private(set) var integrations: [Integration] = []
    /// The engine's models, and the outside agents' after them.
    private(set) var models: [Model] = []
    @ObservationIgnored private var engineIntegrations: [Integration] = []
    @ObservationIgnored private var engineModels: [Model] = []
    @ObservationIgnored private var agentIntegrations: [Integration] = []
    @ObservationIgnored private var agentModels: [Model] = []
    private(set) var defaultModel: Model?
    private(set) var agents: [Agent] = []
    private(set) var commands: [Command] = []
    /// The plugins its settings add, as the engine has them: loaded, or failed and why. One being
    /// installed isn't among them yet. Nil until read.
    private(set) var plugins: [PluginInfo]?
    /// Commands by project folder, with the project's own.
    private(set) var projectCommands: [String: [Command]] = [:]
    private(set) var isLoaded = false
    /// The coding agents' accounts and models have been read (or their bridge couldn't start):
    /// until then, theirs and Auto's aren't known.
    private(set) var areAgentsLoaded = false
    /// True while a refresh has been waiting more than a few seconds.
    private(set) var isSlow = false

    private var refreshTask: Task<Void, Never>?

    /// While the engine starts up it answers 503 ("Location plugins did not finish activating"),
    /// and the models come later: they're asked for again every few seconds, so they show once
    /// it's ready (after you answer a macOS prompt for folder access it was waiting on, say).
    /// Past `stallLimit` the engine is taken for stuck (a fetch of its own that never ends
    /// leaves it so for good), and the app starts it over.
    @ObservationIgnored var onStalled: (() -> Void)?
    @ObservationIgnored private var unavailableSince: ContinuousClock.Instant?
    private static let stallLimit: Duration = .seconds(60)

    /// AI providers only: no MCP servers or web-search services.
    var providers: [Integration] {
        integrations.filter { !$0.isMCP && !Self.searchServices.contains($0.id) }
    }

    var connectedProviders: [Integration] {
        providers.filter(\.isConnected)
    }

    /// The outside agents (Claude Code, Codex, Cursor, Grok, Antigravity), as the bridge lists them.
    var codingAgents: [Integration] {
        integrations.filter { OutsideAgents.isAgent($0.id) }
    }

    var primaryAgents: [Agent] {
        agents.filter(\.isPrimary)
    }

    /// The mode a new session starts in: the one chosen in Settings, if it's still a mode you
    /// can pick; otherwise Build, or the first mode there is when Build is turned off.
    func startingAgent(chosen: String?) -> String {
        let modes = primaryAgents.map(\.id)
        if let chosen, modes.contains(chosen) { return chosen }
        return modes.isEmpty || modes.contains("build") ? "build" : modes[0]
    }

    /// The models you can use now, offered in pickers: those of an account you connected,
    /// OpenCode Zen's free ones (they need no account), and those of a provider with nothing to
    /// sign in to (a local one). The engine lists every provider it knows, connected or not, and
    /// one that isn't only fails ("missing required Authorization header"); its models show once
    /// it's connected.
    var offered: [Model] {
        let byID = Dictionary(integrations.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return models.filter { model in
            guard model.enabled else { return false }
            if model.providerID == "opencode", model.isFree { return true }
            guard let provider = byID[model.providerID] else { return true }
            return provider.isConnected || provider.methods.isEmpty
        }
    }

    /// The engine's models grouped by provider, providers in the order people tend to look for them.
    var modelsByProvider: [(provider: String, models: [Model])] {
        let groups = Dictionary(grouping: offered.filter { !OutsideAgents.isAgent($0.providerID) }, by: \.providerID)
        return groups.keys
            .sorted { (Self.featuredOrder[$0] ?? 99, $0) < (Self.featuredOrder[$1] ?? 99, $1) }
            .map { id in (providerName(id), groups[id]!.sorted { $0.time.released > $1.time.released }) }
    }

    /// A provider in the model picker's rail: one of your accounts with a coding agent, or one of
    /// the engine's providers you can use.
    struct PickerProvider: Identifiable {
        let id: String
        let name: String
        /// Its mark: the agent's maker's, or the provider's.
        let logo: String
        /// Newest first.
        let models: [Model]
        /// An account with a coding agent.
        let isAgent: Bool
        /// Why it has no models now (not signed in, not installed), for an agent's account.
        let unavailable: String?
        /// Its program is behind, in words: the newest models may need the new version.
        var outdated: String? = nil
    }

    /// The picker's providers: your coding agents' accounts (each its own), then the engine's
    /// providers you can use. An agent's account without models shows, to say why.
    func pickerProviders(_ scope: ModelScope) -> [PickerProvider] {
        var agents: [PickerProvider] = []
        if scope == .all {
            let accounts = codingAgents.sorted { lhs, rhs in
                let left = OutsideAgents.order.firstIndex(of: OutsideAgents.base(lhs.id)) ?? 99
                let right = OutsideAgents.order.firstIndex(of: OutsideAgents.base(rhs.id)) ?? 99
                // An agent's own sign-in before the accounts you added, in the order you added them.
                return (left, OutsideAgents.account(lhs.id) == nil ? 0 : 1) < (right, OutsideAgents.account(rhs.id) == nil ? 0 : 1)
            }
            for account in accounts {
                let models = offered.filter { $0.providerID == account.id }.sorted { $0.time.released > $1.time.released }
                // An agent you don't have and haven't signed in to stays out of the way.
                if models.isEmpty, account.metadata?["installed"]?.bool == false, OutsideAgents.account(account.id) == nil { continue }
                let why = models.isEmpty ? (account.isConnected ? "Its models are loading." : account.metadata?["message"]?.string ?? "Sign in to it in Settings › Accounts.") : nil
                var outdated: String?
                if account.metadata?["outdated"]?.bool == true, let latest = account.metadata?["latestVersion"]?.string {
                    let installed = account.metadata?["version"]?.string.map { " \($0)" } ?? ""
                    outdated = "\(OutsideAgents.name(account.id))\(installed) may not list the newest models: version \(latest) is out."
                }
                agents.append(PickerProvider(id: account.id, name: account.name, logo: OutsideAgents.logo(account.id), models: models, isAgent: true, unavailable: why, outdated: outdated))
            }
        }
        let engine = modelsByProvider.compactMap { group -> PickerProvider? in
            guard let first = group.models.first else { return nil }
            return PickerProvider(id: first.providerID, name: group.provider, logo: first.providerID, models: group.models, isAgent: false, unavailable: nil)
        }
        return agents + engine
    }

    func model(_ ref: ModelRef?) -> Model? {
        guard let ref else { return nil }
        if ref.providerID == OutsideAgents.autoProvider { return autoModel(ref.id) }
        return models.first { $0.id == ref.id && $0.providerID == ref.providerID }
    }

    /// The model, if it's one you can use now (see `offered`).
    func offeredModel(_ ref: ModelRef?) -> Model? {
        guard let ref else { return nil }
        if ref.providerID == OutsideAgents.autoProvider { return isAutoAvailable(ref.id) ? autoModel(ref.id) : nil }
        return offered.first { $0.id == ref.id && $0.providerID == ref.providerID }
    }

    // MARK: Auto

    /// Your Auto lists, and what's held back at a limit.
    var auto: AutoList { outsideAgents?.auto ?? AutoList() }

    /// Auto can be picked: the bridge is up and one of your lists has models in it.
    var isAutoAvailable: Bool { outsideAgents?.api != nil && auto.all.contains { !$0.entries.isEmpty } }

    /// That Auto list can be picked: the bridge is up and it has models in it.
    func isAutoAvailable(_ id: String?) -> Bool {
        outsideAgents?.api != nil && auto.list(id)?.entries.isEmpty == false
    }

    /// An Auto list, as a model the composer's chip and the picker show: by its name.
    func autoModel(_ id: String?) -> Model? {
        guard let list = auto.list(id) else { return nil }
        var model = Self.autoTemplate
        model.id = list.id
        model.name = list.name
        return model
    }

    /// Your Auto lists, as models, in your order.
    var autoModels: [Model] { auto.all.compactMap { autoModel($0.id) } }

    private static let autoTemplate: Model = {
        let json = #"{"id":"auto","providerID":"auto","name":"Custom Auto","capabilities":{"tools":true,"input":["text","image"],"output":["text"]},"variants":[],"time":{"released":0},"cost":[{"input":0,"output":0}],"status":"active","enabled":true,"limit":{"context":200000,"output":32000}}"#
        return try! JSONDecoder().decode(Model.self, from: Data(json.utf8))
    }()

    static var autoRef: ModelRef { ModelRef(id: AutoList.firstID, providerID: OutsideAgents.autoProvider) }

    /// A model picked that you can't use now (gone from its provider, or its account signed out
    /// of): it would only fail. Not before the models are known.
    func isUnavailable(_ ref: ModelRef?) -> Bool {
        guard let ref else { return false }
        return isKnown(ref) && offeredModel(ref) == nil
    }

    /// A model whose account you signed out of (its provider has a sign-in, and isn't signed in):
    /// the engine would drop a message on it without a word, so it's said before it's sent.
    /// Only then: a model missing from a list for a moment (a coding agent's, as it starts) goes
    /// to its agent, which says for itself if it can't run it.
    func needsSignIn(_ ref: ModelRef?) -> Bool {
        guard let ref, isUnavailable(ref) else { return false }
        return integrations.contains { $0.id == ref.providerID && !$0.isConnected && !$0.methods.isEmpty }
    }

    /// Why `ref` can't run here, and what to do, for one `isUnavailable` turned down: its account
    /// to sign in to (on the machine named `on`, as Settings › Accounts lists it), or another
    /// model. Without it, the engine takes the message and drops it without a word.
    func unavailable(_ ref: ModelRef, on machine: String? = nil) -> String {
        let name = model(ref)?.name ?? ref.id
        let there = machine.map { " on \($0)" } ?? ""
        if let provider = integrations.first(where: { $0.id == ref.providerID }), !provider.isConnected, !provider.methods.isEmpty {
            return "\(name) needs a sign-in\(there): sign in to \(signInName(ref.providerID)) in Settings › Accounts, or choose another model."
        }
        return "\(name) isn’t available\(there) now: choose another model."
    }

    /// A provider's refusal that means it isn't signed in (a request sent without its credentials,
    /// or ones it turned down), in words saying what to do, for `ref`'s provider (on the machine
    /// named `on`, or its model's when it's not known); any other error as it was said.
    func plain(_ error: String, for ref: ModelRef?, on machine: String? = nil) -> String {
        guard Self.isSignInRefusal(error) else { return error }
        let there = machine.map { " on \($0)" } ?? ""
        return "\(ref.map { signInName($0.providerID) } ?? "Its model’s account") isn’t signed in\(there): sign in to it again in Settings › Accounts, or choose another model."
    }

    /// Whether a provider's error means it isn't signed in.
    static func isSignInRefusal(_ error: String) -> Bool {
        error.range(of: #"authorization header|unauthori[sz]ed|\b401\b|\b403\b|forbidden|invalid api key"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Whether the models `ref` would be among are known yet: the engine's, or the coding agents'
    /// (this Mac's, or the machine's beside its engine).
    private func isKnown(_ ref: ModelRef) -> Bool {
        OutsideAgents.runsInBridge(ref.providerID) ? areAgentsLoaded : isLoaded
    }

    /// What the composer's chip shows for `ref`: its model; one whose models aren't known yet
    /// (the coding agents still starting) as it is, by its ID, not the default as if that were
    /// the one in use; nothing picked, the default.
    func shownModel(_ ref: ModelRef?) -> Model? {
        if let model = model(ref) { return model }
        guard let ref, !isKnown(ref) else { return ref == nil ? defaultModel : nil }
        var placeholder = Self.autoTemplate
        placeholder.id = ref.id
        placeholder.providerID = ref.providerID
        placeholder.name = ref.providerID == OutsideAgents.autoProvider ? "Custom Auto" : ref.id
        return placeholder
    }

    /// The model a new session or bot starts on: the first of `wanted` (the one picked, the one
    /// picked last) you can use now; else the engine's default, if you can; else the first model
    /// you can use. A model whose account you signed out of would only fail. Before the models are
    /// known (just after launch; the coding agents' come after the engine's), the first of `wanted`
    /// as it is.
    func startingModel(_ wanted: ModelRef?..., scope: ModelScope = .all) -> ModelRef? {
        let wanted = wanted.compactMap(\.self).filter { scope.allows($0.providerID) }
        guard isLoaded else { return wanted.first ?? defaultModel?.ref }
        if let ref = wanted.first(where: { offeredModel($0) != nil || !isKnown($0) }) { return ref }
        if let model = offeredModel(defaultModel?.ref) { return model.ref }
        // Only coding agents' accounts: one of theirs.
        return modelsByProvider.first?.models.first?.ref ?? offered.first { OutsideAgents.isAgent($0.providerID) && scope.allows($0.providerID) }?.ref
    }

    /// What to sign in to again for an account opencode had: a ChatGPT or SuperGrok plan is
    /// signed in to as its coding agent here.
    func signInName(_ id: String) -> String {
        Self.planName(id) ?? providerName(id)
    }

    static func planName(_ id: String) -> String? {
        switch id {
        case "openai": "Codex (your ChatGPT plan, under Subscriptions)"
        case "xai": "Grok (your SuperGrok plan, under Subscriptions)"
        default: nil
        }
    }

    func providerName(_ id: String) -> String {
        if id == "opencode" { return "OpenCode Zen" }
        if id == OutsideAgents.autoProvider { return "Custom Auto" }
        return integrations.first { $0.id == id }?.name ?? id
    }

    func refresh() async {
        await refreshEngine()
        // Apart from the engine's: an agent slow to answer (Codex starting) isn't the engine
        // still loading.
        await refreshAgents()
    }

    private func refreshEngine() async {
        guard let api else { return }
        let slowness = Task {
            try await Task.sleep(for: .seconds(3))
            isSlow = true
        }
        defer {
            slowness.cancel()
            isSlow = false
        }
        async let integrations = api.integrations()
        async let models = api.models()
        async let defaultModel = api.defaultModel()
        async let agents = api.agents()
        async let commands = api.commands()
        async let plugins = api.plugins()
        do { engineIntegrations = try await integrations } catch { log.error("integrations: \(String(describing: error), privacy: .public)") }
        var starting = false
        var modelsRead = false
        do {
            engineModels = try await models
            modelsRead = true
            if isMac { ProviderCompatibility.learn(from: engineModels) }
            LogoImages.shared.prefetch(engineModels.flatMap { [$0.makerLogoID, $0.providerID] })
        } catch {
            log.error("models: \(String(describing: error), privacy: .public)")
            starting = (error as? ServerError)?.status == 503
        }
        do { self.defaultModel = try await defaultModel } catch { log.error("default model: \(String(describing: error), privacy: .public)") }
        do { self.agents = try await agents } catch { log.error("agents: \(String(describing: error), privacy: .public)") }
        do { self.commands = try await commands } catch { log.error("commands: \(String(describing: error), privacy: .public)") }
        do { self.plugins = try await Self.added(plugins) } catch { log.error("plugins: \(String(describing: error), privacy: .public)") }
        // What's new shows at once; each folder's own commands follow (reading one can start its
        // tools there, so not before).
        merge()
        // Loaded once the models have been read: a new bot's model is checked against them.
        if modelsRead { isLoaded = true }
        for directory in projectCommands.keys { await loadCommands(in: directory) }
        merge()
        if starting { waitForEngine() } else { unavailableSince = nil }
    }

    func refreshPlugins() async {
        guard let api else { return }
        do { plugins = try Self.added(await api.plugins()) } catch { log.error("plugins: \(String(describing: error), privacy: .public)") }
    }

    /// The plugins the settings add, without the engine's own.
    private static func added(_ plugins: [PluginInfo]) -> [PluginInfo] {
        plugins.filter { $0.source.type != "builtin" }
    }

    /// The outside agents' accounts and models, from their bridge.
    /// `fresh`: each agent is asked anew whether it's installed and signed in (you refreshed, or
    /// came back to the app: you may have installed one or signed in meanwhile), rather than
    /// answering from what it knew a moment ago.
    func refreshAgents(fresh: Bool = false) async {
        guard let api = outsideAgents?.api else { return }
        if fresh {
            isRefreshingAgents = true
            lastFreshAgents = .now
        }
        defer { if fresh { isRefreshingAgents = false } }
        // The accounts first: one that changed has other models.
        var read = false
        do {
            agentIntegrations = try await api.agentIntegrations(fresh: fresh)
            read = true
        } catch { log.error("agents: \(String(describing: error), privacy: .public)") }
        do { agentModels = try await api.models() } catch { log.error("agents' models: \(String(describing: error), privacy: .public)") }
        merge()
        if read { areAgentsLoaded = true }
    }

    /// The agents bridge stopped for good, or isn't there (a machine's engine started without
    /// it): its agents and their models aren't there to use. `untilBack`: it's away for now (its
    /// machine disconnected), and they're unknown until it's back, not gone.
    func forgetAgents(untilBack: Bool = false) {
        agentIntegrations = []
        agentModels = []
        merge()
        areAgentsLoaded = !untilBack
    }

    /// True while the agents are being asked anew.
    private(set) var isRefreshingAgents = false
    @ObservationIgnored private var lastFreshAgents: ContinuousClock.Instant?

    /// The agents asked anew, unless they were a moment ago: when you come back to the app.
    func refreshAgentsIfStale() {
        if let lastFreshAgents, ContinuousClock.now - lastFreshAgents < .seconds(60) { return }
        Task { await refreshAgents(fresh: true) }
    }

    private func merge() {
        integrations = engineIntegrations + agentIntegrations
        models = engineModels + agentModels
    }

    /// Where an account signs in: the agents bridge for an outside agent's, else the engine.
    func api(forIntegration id: String) -> OpenCodeAPI? {
        OutsideAgents.isAgent(id) ? outsideAgents?.api : api
    }

    /// The engine is still starting: the models again in a moment, or, when it's been too long,
    /// the engine started over (once a launch, see AppModel), and the models asked for again, less
    /// often: one waiting on a macOS prompt finishes when it's answered.
    private func waitForEngine() {
        let since = unavailableSince ?? .now
        unavailableSince = since
        var wait = Duration.seconds(5)
        if ContinuousClock.now - since >= Self.stallLimit {
            log.error("the engine hasn't finished starting in \(Self.stallLimit, privacy: .public): starting it over")
            unavailableSince = nil
            onStalled?()
            wait = .seconds(15)
        }
        refreshTask?.cancel()
        refreshTask = Task {
            try? await Task.sleep(for: wait)
            guard !Task.isCancelled else { return }
            await refresh()
        }
    }

    /// The commands a session in `directory` can run.
    func commands(in directory: String) -> [Command] {
        projectCommands[directory] ?? commands
    }

    func loadCommands(in directory: String) async {
        guard let api else { return }
        do { projectCommands[directory] = try await api.commands(directory: directory) } catch { log.error("commands: \(String(describing: error), privacy: .public)") }
    }

    /// Sign-ins that ran out and couldn't be renewed (the service refused them), by provider: the
    /// one a run on its model was refused.
    private var endedSignIns: [String: String] = [:]

    /// A run on `provider`'s model was refused its account: its sign-in in use, if that's one (a
    /// key refused says why itself).
    func signInEnded(_ provider: String) {
        guard !OutsideAgents.runsInBridge(provider), let active = activeCredential(of: provider),
              active.method == "oauth", let id = active.credentialID, endedSignIns[provider] != id else { return }
        endedSignIns[provider] = id
    }

    /// A step on `provider`'s model ended well: its sign-in works (renewed after all).
    func signInWorks(_ provider: String) {
        if endedSignIns[provider] != nil { endedSignIns[provider] = nil }
    }

    /// The plans whose sign-in in use ended.
    var endedProviders: [String] { endedSignIns.keys.filter(hasEndedSignIn).sorted() }

    /// `provider`'s sign-in in use ended: the one refused is still the one in use (signed in again,
    /// it's another).
    func hasEndedSignIn(_ provider: String) -> Bool {
        guard let id = endedSignIns[provider] else { return false }
        return activeCredential(of: provider)?.credentialID == id
    }

    private func activeCredential(of provider: String) -> Integration.Connection? {
        integrations.first { $0.id == provider }?.connections.first { $0.type == "credential" }
    }

    func handle(_ event: ServerEvent) {
        switch event.type {
        case "integration.updated", "credential.updated", "credential.switched", "provider.updated",
             "model.updated", "agent.updated", "command.updated", "config.updated":
            scheduleRefresh()
        case "plugin.updated":
            // One installed or failing to: its plugins alone.
            Task { await refreshPlugins() }
        default:
            break
        }
    }

    /// Catalog events come in bursts (a sign-in updates integrations, providers and
    /// models at once), so refresh once they settle.
    private func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await refresh()
        }
    }

    /// Plans you sign in to with an account, as you do a coding agent: shown with them in
    /// Accounts' Subscriptions, not among the providers.
    static let planProviders = ["github-copilot", "gitlab", "poe", "opencode"]

    /// Shown first, in this order. Everything else follows alphabetically.
    /// (The outside agents have their own place, before these: `OutsideAgents.order`.)
    static let featured = ["openai", "github-copilot", "anthropic", "google", "xai", "openrouter", "opencode", "deepseek", "mistral", "groq"]
    static let featuredOrder = Dictionary(uniqueKeysWithValues: featured.enumerated().map { ($1, $0) })
    private static let searchServices: Set = ["exa", "firecrawl", "parallel", "tavily", "tinyfish"]
}

/// Which models a picker offers: the engine's (a session on it, a bot, a machine's), or every
/// model with the coding agents' and Auto (a session with the agents, a new one on this Mac),
/// which the agents bridge runs.
enum ModelScope: Equatable {
    case engine
    case all

    /// What a conversation that lives in `directory` can run on, whatever it is (a project's
    /// session, a chat, a bot's): every model where it lives, the coding agents' and Custom Auto
    /// too, on this Mac and on a machine alike (each machine has its own agents bridge, beside its
    /// engine, with the agents signed in there). One rule for all of them, so they never drift
    /// apart.
    static func at(_ directory: String?) -> ModelScope {
        .all
    }

    /// The same, by the machine it lives on (nil for this Mac).
    static func on(machine: String?) -> ModelScope {
        .all
    }

    func allows(_ providerID: String) -> Bool {
        switch self {
        case .all: true
        case .engine: !OutsideAgents.runsInBridge(providerID)
        }
    }
}
