import ClientAccounts
import ClientSessions
import Foundation
import OpenCodeKit
import os

private let log = Logger(subsystem: "run.kuvo.code", category: "catalog")

/// What the engine offers: providers to sign in to, models, agents, commands.
/// All of it comes from the engine, so new providers appear without an app update.
@Observable
final class Catalog {
    var api: OpenCodeAPI?

    /// The outside agents' bridge (Claude Code, Codex…), on this Mac's catalog: their accounts and
    /// models join the engine's.
    @ObservationIgnored var outsideAgents: OutsideAgents?
    /// The machine whose engine this is (nil: this Mac's): sign-ins to its agents finish in this
    /// Mac's browser.
    @ObservationIgnored var machine: String?
    /// Its computer's box, which keeps what its engine's accounts don't say (the plans whose
    /// sign-in ended), and decides which models run there (`offeredSaid`).
    @ObservationIgnored var box: BoxClient? {
        didSet {
            guard box?.box != oldValue?.box else { return }
            boxOffers = nil
            offeredAsked = [:]
            offeredSaid = nil
            startingSaid = [:]
        }
    }

    /// The engine's integrations, and the outside agents' after them.
    private(set) var integrations: [Integration] = []
    /// The engine's models, and the outside agents' after them.
    private(set) var models: [Model] = []
    /// Each model as it was last listed: a coding agent's are listed only while you're signed in.
    @ObservationIgnored private var lastListed: [ModelRef: Model] = [:]
    @ObservationIgnored private var engineIntegrations: [Integration] = []
    @ObservationIgnored private var engineModels: [Model] = []
    @ObservationIgnored private var agentIntegrations: [Integration] = []
    /// The coding agents' accounts as the bridge last listed them, kept when it stops.
    private var lastAgentAccounts: [Integration] = []
    @ObservationIgnored private var agentModels: [Model] = []
    private(set) var defaultModel: Model?
    private(set) var agents: [Agent] = []
    private(set) var commands: [Command] = []
    /// The plugins its settings add, as the engine has them: loaded, or failed and why. One being
    /// installed isn't among them yet. Nil until read.
    private(set) var plugins: [PluginInfo]?
    /// Commands by project folder, with the project's own.
    private(set) var projectCommands: [String: [Command]] = [:]
    /// The folders whose commands were asked for, read or not yet.
    @ObservationIgnored private var commandFolders: Set<String> = []
    private(set) var isLoaded = false
    /// When the engine last said which accounts it has: what a machine's Accounts page shows
    /// while it's away is as of then (nil: never, so there's nothing to show).
    private(set) var integrationsRead: Date?
    /// The coding agents' accounts and models have been read (or their bridge couldn't start):
    /// until then, theirs and Auto's aren't known.
    private(set) var areAgentsLoaded = false
    /// True while the first load has been waiting on the engine more than `slowAfter`.
    private(set) var isSlow = false
    static var slowAfter = Duration.seconds(3)

    private var refreshTask: Task<Void, Never>?

    /// While the engine starts up it answers 503 ("Location plugins did not finish activating"),
    /// and the models come later: they're asked for again every few seconds, so they show once
    /// it's ready (after you answer a macOS prompt for folder access it was waiting on, say).
    /// Past `stallLimit` the engine is taken for stuck (a fetch of its own that never ends
    /// leaves it so for good), and the app starts it over.
    @ObservationIgnored var onStalled: (() -> Void)?
    @ObservationIgnored private var unavailableSince: ContinuousClock.Instant?
    private static let stallLimit: Duration = .seconds(60)

    /// AI providers only: no MCP servers or web-search services, nor the engine's Claude Agent
    /// unless you added it (`EngineProviders`).
    var providers: [Integration] {
        integrations.filter { !$0.isMCP && EngineProviders.lists($0.id, connected: $0.isConnected) }
    }

    var connectedProviders: [Integration] {
        providers.filter(\.isConnected)
    }

    /// The accounts you're signed in to, for the sidebar's footer: the connected ones, and the
    /// coding agents' as last read while their bridge is stopped (still signed in, only not
    /// running; the stopped bridge says so itself).
    var signedInAccounts: [Integration] {
        let connected = connectedProviders
        return connected + lastAgentAccounts.filter { account in account.isConnected && !connected.contains { $0.id == account.id } }
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

    /// The models you can use now, offered in pickers, as its box says (`offeredSaid`). One its
    /// provider has deprecated (it's retired soon) isn't, as the engine's own picker leaves it out;
    /// a conversation already on one carries on (`usable`).
    var offered: [Model] {
        usable.filter { !$0.isDeprecated }
    }

    /// The models you can run now, as its box says: those offered, and deprecated ones of the same
    /// accounts. None of a side (the engine's, or the coding agents') its box hasn't said yet.
    private var usable: [Model] {
        guard boxDecides else { return reckonedUsable }
        askOffered(LastModel.current)
        guard let said = offeredSaid else { return [] }
        return models.filter { said.runs($0.ref, isAgent: OutsideAgents.runsInBridge) == true }
    }

    // COMPAT(0.7 model-rule): which models run, worked out here for a box without `models.offered` (0.7.x and 0.8.0-beta.1 Macs' bridges). Goes 3 months after 0.8.0.
    /// Those of an account you connected, OpenCode Zen's free ones (they need no account), and those
    /// of a provider with nothing to sign in to (a local one).
    private var reckonedUsable: [Model] {
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
                // An agent you don't have and haven't signed in to stays out of the way (as the first
                // launch leaves it out).
                if models.isEmpty, !Plans.shows(installed: account.metadata?["installed"]?.bool != false, signedIn: account.isConnected, providerID: account.id) { continue }
                let installed = account.metadata?["installed"]?.bool != false
                let why = models.isEmpty ? (account.isConnected && installed ? "Its models are loading." : account.metadata?["message"]?.string ?? "Sign in to it in Settings › Accounts.") : nil
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
        return models.first { $0.isNamed(by: ref) }
    }

    /// Whether `ref` and `other` are one model, even where one names it by another name the box
    /// knows it by (Claude Code's `default` and the model it stands for), the effort aside.
    func isSameModel(_ ref: ModelRef, _ other: ModelRef?) -> Bool {
        ref.sameModel(as: other) || model(other)?.isNamed(by: ref) == true
    }

    /// The model, if it's one you can use now (see `offered`).
    func offeredModel(_ ref: ModelRef?) -> Model? {
        guard let ref else { return nil }
        if ref.providerID == OutsideAgents.autoProvider {
            guard boxDecides else { return isAutoAvailable(ref.id) ? autoModel(ref.id) : nil }
            return offeredSaid?.runs(ref, isAgent: OutsideAgents.runsInBridge) == true ? autoModel(ref.id) : nil
        }
        return usable.first { $0.isNamed(by: ref) }
    }

    // MARK: What its box offers

    /// What its box says of the models there (`kuvo/models/offered`, KuvoClient's `OfferedModels`):
    /// those that run now, which pickers offer, and whether the engine's and the coding agents'
    /// could be said. Nil until read; a side its box couldn't say keeps what it said before.
    private(set) var offeredSaid: OfferedModels?
    /// The model a new session starts on, as its box said it, by the model wanted (`startKey`).
    private(set) var startingSaid: [String: ModelRef?] = [:]
    /// Its box answers `models.offered`: nil until known.
    @ObservationIgnored private var boxOffers: Bool?
    /// The lists (`listsKey`) its box was last asked about, by the model wanted.
    @ObservationIgnored private var offeredAsked: [String: Int] = [:]

    /// Its box decides which models run and which one a new session starts on: one with
    /// `models.offered`, or not known yet. Without a box (nothing to ask), or with one from before
    /// it, this Mac works them out as it did (the 0.7 model-rule path, PROTOCOL.md "For released Macs").
    private var boxDecides: Bool {
        guard let box else { return false }
        return BoxClient.hasEveryFeature(box.box) || boxOffers != false
    }

    private static func startKey(_ wanted: ModelRef?) -> String { OfferedModels.path(wanted: wanted) }

    /// Asks its box what it offers, and what a new session would start on for `wanted`, where what
    /// it said is of lists read before (or it wasn't asked for `wanted`); what it said stands
    /// meanwhile, and the answer shows once it comes.
    private func askOffered(_ wanted: ModelRef?) {
        let key = Self.startKey(wanted), lists = listsKey
        guard boxDecides, offeredAsked[key] != lists else { return }
        offeredAsked[key] = lists
        // (Out of a view's drawing: it changes what's observed.)
        Task { await readOffered(wanted, key: key) }
    }

    /// A box found to be from before `models.offered` is asked again as the lists are read anew
    /// (a machine's, updated since): once it answers it, its word is taken from then on. Until
    /// then, nothing changes, so the picker doesn't empty while it's asked.
    private func recheckOlderBox() async {
        guard boxOffers == false, let box else { return }
        struct Info: Decodable { var features: [String]? }
        guard let info = try? await box.value(Info.self, "GET", "kuvo/info"), info.features?.contains(OfferedModels.feature) == true,
              self.box?.box == box.box else { return }
        boxOffers = true
        offeredAsked = [:]
        listsRead += 1
    }

    private func readOffered(_ wanted: ModelRef?, key: String) async {
        guard let box else { return }
        if boxOffers == nil, !BoxClient.hasEveryFeature(box.box) {
            struct Info: Decodable { var features: [String]? }
            guard let info = try? await box.value(Info.self, "GET", "kuvo/info") else { return }
            boxOffers = info.features?.contains(OfferedModels.feature) == true
            // (From before it: drawn as this Mac works them out, from the lists it has.)
            guard boxOffers == true else {
                listsRead += 1
                return
            }
        }
        guard let said = try? await box.value(OfferedModels.self, "GET", OfferedModels.path(wanted: wanted)), self.box?.box == box.box else { return }
        let kept = said.keeping(offeredSaid, isAgent: OutsideAgents.runsInBridge)
        if kept != offeredSaid { offeredSaid = kept }
        if let starting = said.starting, startingSaid[key] != .some(starting) { startingSaid[key] = starting }
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
    /// The old-box path, with `refusal`, `unavailable`, `chipModel` and `signInHelp`: a box with
    /// `sessions.models` says this itself (`SessionModelState`, the `said:` versions below), and
    /// one with `models.offered` says which run (`offeredSaid`), the chip going by that alone.
    // COMPAT(0.7 model-rule): a conversation's model worked out here for a box without `sessions.models` and `models.offered`. Goes 3 months after 0.8.0.
    func needsSignIn(_ ref: ModelRef?) -> Bool {
        guard let ref, isUnavailable(ref) else { return false }
        return integrations.contains { $0.id == ref.providerID && !$0.isConnected && !$0.methods.isEmpty }
    }

    /// Why a message on `ref` can't be sent (on the machine named `on`), said before it's sent;
    /// nil when it can go.
    /// A model gone from an account the engine has (retired, turned off) is said too, as the engine
    /// would only fail it. Not one of a provider it doesn't list here (one a project's own settings
    /// add, listed only in that project), nor a coding agent's missing from their list while its
    /// account is signed in: those go to the engine or the agents.
    func refusal(_ ref: ModelRef, on machine: String? = nil) -> String? {
        guard isUnavailable(ref), integrations.contains(where: { $0.id == ref.providerID }) else { return nil }
        if OutsideAgents.runsInBridge(ref.providerID), !needsSignIn(ref) { return nil }
        return unavailable(ref, on: machine)
    }

    /// Why `ref` can't run here, and what to do, for one `isUnavailable` turned down: its account
    /// to sign in to (on the machine named `on`, as Settings › Accounts lists it), or another
    /// model. Without it, the engine takes the message and drops it without a word.
    func unavailable(_ ref: ModelRef, on machine: String? = nil) -> String {
        let name = model(ref)?.name ?? ref.id
        let there = machine.map { " on \($0)" } ?? ""
        if let provider = integrations.first(where: { $0.id == ref.providerID }), !provider.isConnected, !provider.methods.isEmpty {
            // A ChatGPT or SuperGrok plan is signed in to as its coding agent, which never makes
            // the engine's own OpenAI or xAI models run: those need a key.
            if let key = PlanSignIns.needsKey(model: name, provider: ref.providerID, providerName: provider.name, there: there, accounts: "Settings › Accounts") { return key }
            return "\(name) needs a sign-in\(there): sign in to \(signInName(ref.providerID)) in Settings › Accounts, or choose another model."
        }
        return "\(name) isn’t available\(there) now: choose another model."
    }

    /// Whether a run that failed with `type` (the engine's kind of error) and `message` was turned
    /// down for want of a sign-in, whatever the engine calls it; not one it knows was for something
    /// else (your input flagged, a limit reached), though the provider's words say 403.
    static func isSignInRefusal(type: String?, message: String) -> Bool {
        if type == "provider.auth" { return true }
        if let type, notSignIn.contains(type) { return false }
        return isSignInRefusal(message)
    }

    private static let notSignIn: Set<String> = ["provider.content-filter", "provider.quota", "provider.rate-limit", "provider.free-limit", "provider.budget-limit", "provider.model-budget-limit"]

    /// Whether a provider's error means it isn't signed in.
    private static func isSignInRefusal(_ error: String) -> Bool {
        error.range(of: #"authorization header|unauthori[sz]ed|\b401\b|\b403\b|forbidden|invalid api key"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Whether the models `ref` would be among are known yet: the engine's, or the coding agents'
    /// (this Mac's, or the machine's beside its engine), as its box has said them.
    private func isKnown(_ ref: ModelRef) -> Bool {
        let listed = OutsideAgents.runsInBridge(ref.providerID) ? areAgentsLoaded : isLoaded
        guard boxDecides else { return listed }
        return listed && offeredSaid?.runs(ref, isAgent: OutsideAgents.runsInBridge) != nil
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

    /// What a conversation's chip shows for `ref`: the model it's on, even while that model's
    /// account needs a sign-in (its card says so, and how), or while a coding agent signed in
    /// doesn't list it (its agent says whether it can run it); nil for one that's gone, which asks
    /// you to choose another; nothing picked, the default.
    /// With a box that decides (`models.offered`), by what it offers alone: the model while it runs
    /// there, else "Choose a Model" (a conversation's own chip names it as its box says, `said:`).
    func chipModel(_ ref: ModelRef?) -> Model? {
        if !boxDecides, needsSignIn(ref) || goesToItsAgent(ref), let ref {
            if let model = model(ref) ?? lastListed[ModelRef(id: ref.id, providerID: ref.providerID)] { return model }
            var placeholder = Self.autoTemplate
            placeholder.id = ref.id
            placeholder.providerID = ref.providerID
            placeholder.name = ref.id
            return placeholder
        }
        return isUnavailable(ref) ? nil : shownModel(ref) ?? defaultModel
    }

    /// A coding agent's model missing from its list while its account is signed in and its program
    /// installed (one it dropped after an update, say): it's sent, and the agent says for itself
    /// whether it can run it, as `refusal` lets it go.
    private func goesToItsAgent(_ ref: ModelRef?) -> Bool {
        guard let ref, OutsideAgents.isAgent(ref.providerID), isUnavailable(ref) else { return false }
        return integrations.contains { $0.id == ref.providerID && $0.isConnected && $0.metadata?["installed"]?.bool != false }
    }

    /// The same, for a chip that offers `scope`'s models: none for one outside them.
    func chipModel(_ ref: ModelRef?, in scope: ModelScope) -> Model? {
        ref.map { !scope.allows($0.providerID) } == true ? nil : chipModel(ref)
    }

    // MARK: What a session's box says of its model

    /// What a conversation's chip shows for `ref`, from what its box says of its model (`said`,
    /// `kuvo/sessions/models`): the model while it runs or its account needs something; nil for
    /// one gone, or none chosen, which asks for another. Where the box hasn't said it of `ref` (a
    /// box from before `sessions.models`, not read yet, or another model just picked), the old-box
    /// path: as this Mac works it out (`chipModel`).
    func chipModel(_ ref: ModelRef?, in scope: ModelScope, said: SessionModelState?) -> Model? {
        guard let said, said.isAbout(ref) else { return chipModel(ref, in: scope) }
        // None of its own, and none it runs on: "Choose a Model" (one it can't say yet, as here).
        guard let shown = ref ?? said.model else { return said.namesModel ? chipModel(ref, in: scope) : nil }
        guard scope.allows(shown.providerID), said.namesModel else { return nil }
        if let model = model(shown) ?? lastListed[ModelRef(id: shown.id, providerID: shown.providerID)] { return model }
        var placeholder = Self.autoTemplate
        placeholder.id = shown.id
        placeholder.providerID = shown.providerID
        placeholder.name = said.name ?? shown.id
        return placeholder
    }

    /// The model a conversation's composer is given: its own; else the one its box says it runs on
    /// (`said`); none where its box says it has none, so the chip asks for one, as the phone's does;
    /// else (a box from before `sessions.models`, or not read yet) the one a new one would start on.
    func composerModel(_ own: ModelRef?, said: SessionModelState?, lastModel: ModelRef?) -> ModelRef? {
        if let own { return own }
        if said?.missing == .model { return nil }
        return said?.model ?? startingModel(lastModel)
    }

    /// Why a message on `ref` can't be sent (on the machine named `on`), from what its box says
    /// (`said`); nil when it can go. Where the box hasn't said it of `ref`, the old-box path
    /// (`refusal`).
    func refusal(_ ref: ModelRef, on machine: String? = nil, said: SessionModelState?) -> String? {
        guard let said, said.isAbout(ref) else { return boxDecides ? nil : refusal(ref, on: machine) }
        return said.refusal(there: machine.map { " on \($0)" } ?? "", accounts: "Settings › Accounts", shownName: shownName(ref))
    }

    /// The chip's help for `ref`: why it can't run and what to do, else what it is. Where the box
    /// hasn't said it of `ref`, the old-box path.
    func chipHelp(_ ref: ModelRef?, in scope: ModelScope, on machine: String? = nil, said: SessionModelState?) -> String {
        if let said, said.isAbout(ref), let shown = ref ?? said.model, scope.allows(shown.providerID) {
            return said.refusal(there: machine.map { " on \($0)" } ?? "", accounts: "Settings › Accounts", shownName: shownName(shown)) ?? "Model and effort"
        }
        if let said, ref == nil, said.model == nil, !said.namesModel { return said.refusal(accounts: "Settings › Accounts") ?? "Model and effort" }
        if !boxDecides, let ref, needsSignIn(ref) { return unavailable(ref, on: machine) }
        let unavailable = isUnavailable(ref) || ref.map { !scope.allows($0.providerID) } == true
        return unavailable && chipModel(ref, in: scope) == nil ? "\(model(ref)?.name ?? ref?.id ?? "") isn't available now: choose another model" : "Model and effort"
    }

    /// What a sign-in card's Sign In for `id` does (on the machine named `on`), from what the
    /// box says of the conversation's model where that's this account's; else the old-box path.
    func signInHelp(_ id: String, on machine: String? = nil, said: SessionModelState?) -> String {
        said?.signInHelp(id, there: machine.map { " on \($0)" } ?? "") ?? signInHelp(id, on: machine)
    }

    /// Whether `ref`'s account needs a sign-in, a key or its agent installed now, from what the
    /// box says where it's said of `ref`; else the old-box path (`needsSignIn`).
    func needsAccount(_ ref: ModelRef, said: SessionModelState?) -> Bool {
        guard let said, said.isAbout(ref) else { return boxDecides ? false : needsSignIn(ref) }
        return said.needsAccount
    }

    /// `ref`'s name as last listed here, for one its box no longer names.
    private func shownName(_ ref: ModelRef) -> String? {
        model(ref)?.name ?? lastListed[ModelRef(id: ref.id, providerID: ref.providerID)]?.name
    }

    /// Changes each time the accounts or models are read anew (and Custom Auto's lists change):
    /// what a session's box says of its model is asked again then.
    var listsKey: Int {
        var hasher = Hasher()
        hasher.combine(listsRead)
        hasher.combine(auto)
        hasher.combine(defaultModel?.key)
        return hasher.finalize()
    }
    /// How many times the accounts and models were read.
    private(set) var listsRead = 0

    /// The model a new session or bot starts on, as its box decides it for `wanted` (the one
    /// picked last; of several, the first given): that one where it runs there, else the engine's
    /// default, else the first model that runs (`kuvo/models/offered`'s `starting`). Until its box
    /// says (just after launch, a model just picked, its engine still loading), `wanted` as it is.
    func startingModel(_ wanted: ModelRef?..., scope: ModelScope = .all) -> ModelRef? {
        guard boxDecides else { return reckonedStartingModel(wanted, scope: scope) }
        let wanted = wanted.compactMap(\.self).first { scope.allows($0.providerID) }
        askOffered(wanted)
        if let said = startingSaid[Self.startKey(wanted)] { return said.flatMap { scope.allows($0.providerID) ? $0 : nil } }
        return wanted ?? defaultModel?.ref
    }

    // COMPAT(0.7 model-rule): a new session's model, worked out here for a box without `models.offered`. Goes 3 months after 0.8.0.
    private func reckonedStartingModel(_ wanted: [ModelRef?], scope: ModelScope) -> ModelRef? {
        // Under the id the box lists it by, one picked by another name (Claude Code's `default`).
        let wanted = wanted.compactMap(\.self).filter { scope.allows($0.providerID) }.map { ref in
            ref.providerID == OutsideAgents.autoProvider ? ref : model(ref).map { ModelRef(id: $0.id, providerID: $0.providerID, variant: ref.variant) } ?? ref
        }
        guard isLoaded else { return wanted.first ?? defaultModel?.ref }
        // Not one being retired, for a new conversation.
        if let ref = wanted.first(where: { offeredModel($0).map { !$0.isDeprecated } ?? !isKnown($0) }) { return ref }
        if let model = offeredModel(defaultModel?.ref), !model.isDeprecated { return model.ref }
        // Only coding agents' accounts: one of theirs.
        return modelsByProvider.first?.models.first?.ref ?? offered.first { OutsideAgents.isAgent($0.providerID) && scope.allows($0.providerID) }?.ref
    }

    /// What to sign in to again for an account opencode had: a ChatGPT or SuperGrok plan is
    /// signed in to as its coding agent here.
    func signInName(_ id: String) -> String {
        Self.planName(id) ?? providerName(id)
    }

    /// What signing in to `id` from a card does (on the machine named `on`), as its button's help
    /// says it: its sign-in, or adding a key for the engine's OpenAI or xAI where the sheet offers
    /// only that (their plans sign in through Codex or Grok).
    func signInHelp(_ id: String, on machine: String? = nil) -> String {
        if let provider = integrations.first(where: { $0.id == id }),
           !provider.offeredSignInMethods.contains(where: { if case .oauth = $0 { true } else { false } }),
           let key = PlanSignIns.keyHelp(provider: id, providerName: provider.name, there: machine.map { " on \($0)" } ?? "") {
            return key
        }
        return "Sign in to \(signInName(id))\(machine.map { " on \($0): its sign-ins are its own" } ?? "")"
    }

    /// It has a way to sign in that the sign-in sheet offers (a key, a sign-in page, or its own).
    func offersSignIn(_ id: String) -> Bool {
        integrations.first { $0.id == id }?.offeredSignInMethods.contains { method in
            switch method {
            case .oauth, .key, .external: true
            default: false
            }
        } ?? false
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
        await recheckOlderBox()
        await refreshEngine()
        // Apart from the engine's: an agent slow to answer (Codex starting) isn't the engine
        // still loading.
        await refreshAgents()
    }

    private func refreshEngine() async {
        guard let api else { return }
        // Only while the first load waits on the engine (a macOS prompt it's waiting on, say): a
        // later refresh is in the background, and what's shown meanwhile is still right.
        let slowness = isLoaded ? nil : Task {
            try await Task.sleep(for: Self.slowAfter)
            // Loaded just as the wait ran out: not slow after all.
            guard !Task.isCancelled, !isLoaded else { return }
            isSlow = true
        }
        defer {
            slowness?.cancel()
            isSlow = false
        }
        async let integrations = api.integrations()
        async let models = api.models()
        async let defaultModel = api.defaultModel()
        async let agents = api.agents()
        async let commands = api.commands()
        async let plugins = api.plugins()
        do {
            engineIntegrations = try await integrations
            integrationsRead = .now
        } catch { log.error("integrations: \(String(describing: error), privacy: .public)") }
        var starting = false
        var modelsRead = false
        do {
            engineModels = try await models
            modelsRead = true
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
        if modelsRead {
            isLoaded = true
            slowness?.cancel()
            isSlow = false
        }
        await readEndedSignIns()
        await readUnanswering()
        for directory in commandFolders { await loadCommands(in: directory) }
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
        agentReads += 1
        let order = agentReads
        if fresh {
            freshAgentReads += 1
            isRefreshingAgents = true
            lastFreshAgents = .now
        }
        defer {
            if fresh {
                freshAgentReads -= 1
                isRefreshingAgents = freshAgentReads > 0
            }
        }
        // The accounts first: one that changed has other models.
        var listed: [Integration]?
        var models: [Model]?
        do { listed = try await api.agentIntegrations(fresh: fresh) } catch { log.error("agents: \(String(describing: error), privacy: .public)") }
        do { models = try await api.models() } catch { log.error("agents' models: \(String(describing: error), privacy: .public)") }
        // A read asked before one that's answered already (a fresh one, slow to check every agent,
        // overtaken by the one after you removed an account) is out of date.
        guard listed != nil || models != nil else { return }
        guard order > agentReadShown else {
            // What every agent said just now is the bridge's to answer from: read again, after
            // what overtook this one.
            if fresh { await refreshAgents() }
            return
        }
        agentReadShown = order
        if let listed {
            agentIntegrations = listed
            lastAgentAccounts = listed
        }
        if let models { agentModels = models }
        merge()
        if listed != nil { areAgentsLoaded = true }
    }

    /// The agents bridge stopped for good, or isn't there (a machine's engine started without
    /// it): its agents and their models aren't there to use. `untilBack`: it's away for now (its
    /// machine disconnected), and they're unknown until it's back, not gone.
    func forgetAgents(untilBack: Bool = false) {
        // Nor does a read still on its way bring them back.
        agentReadShown = agentReads
        agentIntegrations = []
        agentModels = []
        // Gone for good, the sidebar stops naming their accounts too; only while they're on their
        // way back does it keep them.
        if !untilBack { lastAgentAccounts = [] }
        merge()
        areAgentsLoaded = !untilBack
    }

    /// True while the agents are being asked anew.
    private(set) var isRefreshingAgents = false
    /// The coding agents' reads, as asked, and the latest whose answer shows.
    @ObservationIgnored private var agentReads = 0
    @ObservationIgnored private var agentReadShown = 0
    @ObservationIgnored private var freshAgentReads = 0
    @ObservationIgnored private var lastFreshAgents: ContinuousClock.Instant?

    /// The agents asked anew, unless they were a moment ago: when you come back to the app.
    func refreshAgentsIfStale() {
        if let lastFreshAgents, ContinuousClock.now - lastFreshAgents < .seconds(60) { return }
        Task { await refreshAgents(fresh: true) }
    }

    private func merge() {
        let integrations = engineIntegrations + agentIntegrations
        let models = engineModels + agentModels
        if integrations != self.integrations || models != self.models { listsRead += 1 }
        self.integrations = integrations
        self.models = models
        for model in models { lastListed[ModelRef(id: model.id, providerID: model.providerID)] = model }
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
        // Read again with the rest (`refresh`), though this read can't be made or fails: one
        // opened while the engine starts gets its commands once it's up.
        commandFolders.insert(directory)
        guard let api else { return }
        do { projectCommands[directory] = try await api.commands(directory: directory) } catch { log.error("commands: \(String(describing: error), privacy: .public)") }
    }

    /// Sign-ins that ran out and couldn't be renewed (the service refused them), by provider: the
    /// one a run on its model was refused. As the box keeps them, and as this Mac sees them end.
    private var endedSignIns: [String: String] = [:]
    /// The plans the box last listed as ended: one it no longer lists works again.
    @ObservationIgnored private var boxEnded: Set<String> = []
    /// Plans the box listed as ended that this Mac saw work again since: the box may be a moment
    /// behind, so the next read of its list doesn't mark them again. Only that one: by the read
    /// after, the box has heard, and one it lists then ended again (a run refused while the Mac
    /// slept).
    @ObservationIgnored private var worksAhead: Set<String> = []

    /// A run on `provider`'s model was refused its account: its sign-in in use, if that's one (a
    /// key refused says why itself).
    func signInEnded(_ provider: String) {
        guard !OutsideAgents.runsInBridge(provider), let active = activeCredential(of: provider),
              active.method == "oauth", let id = active.credentialID, endedSignIns[provider] != id else { return }
        endedSignIns[provider] = id
        worksAhead.remove(provider)
    }

    /// A step on `provider`'s model ended well: its sign-in works (renewed after all).
    func signInWorks(_ provider: String) {
        if endedSignIns[provider] != nil { endedSignIns[provider] = nil }
        if boxEnded.contains(provider) { worksAhead.insert(provider) }
    }

    /// The plans whose sign-in ended, as the box keeps them (`kuvo/accounts/ended`): one noted
    /// while no app watched (a bot's run overnight, with the Mac closed) is marked too, and one the
    /// box no longer lists works again. One this Mac saw end stays marked until it works (the box
    /// may not have noted it yet).
    private func readEndedSignIns() async {
        guard let box else { return }
        struct Ended: Decodable { var providers: [String] }
        let ahead = worksAhead
        guard let ended = try? await box.value(Ended.self, "GET", "kuvo/accounts/ended") else { return }
        let listed = Set(ended.providers)
        var now = endedSignIns
        for provider in boxEnded.subtracting(listed) { now[provider] = nil }
        for provider in listed.subtracting(worksAhead) {
            if let id = activeCredential(of: provider)?.credentialID { now[provider] = id }
        }
        worksAhead.subtract(ahead)
        boxEnded = listed
        if now != endedSignIns { endedSignIns = now }
    }

    /// Models that can't answer now, as the box holds them back after a turn failed (out of funds,
    /// at a limit, signed out: `kuvo/work/unanswering`): the picker marks them, and still offers them.
    private var unanswering: [Unanswering] = []

    struct Unanswering: Decodable, Equatable {
        var provider: String
        /// One model's own limit; nil for the account's.
        var model: String?
        /// Only the account's paid models (out of funds) or its free ones (free usage spent).
        var only: String?
        /// The ids that covers, as the engine prices them, when the box could say.
        var models: [String]?
        /// In the engine's words.
        var why: String
        /// Milliseconds.
        var until: Double

        func covers(_ model: Model) -> Bool {
            guard provider == model.providerID else { return false }
            if let held = self.model { return held == model.id || model.aliases?.contains(held) == true }
            guard let only else { return true }
            if let models { return models.contains(model.id) }
            return (only == "free") == model.isFree
        }

        /// What happened, in a few words.
        var what: String {
            if model != nil { return "At its limit" }
            switch only {
            case "paid": return "Out of funds"
            case "free": return "Free usage spent"
            default: return "Signed out"
            }
        }
    }

    /// Reads them again: with the rest, and as a picker opens.
    func readUnanswering() async {
        guard let box else { return }
        struct Held: Decodable { var held: [Unanswering] }
        guard let read = try? await box.value(Held.self, "GET", "kuvo/work/unanswering") else { return }
        if read.held != unanswering { unanswering = read.held }
    }

    /// The providers its box brings new models to with Refresh Models, as it lists them
    /// (`kuvo/accounts/refreshable`): those whose models come from your account. Empty from a box
    /// from before it; nil until read.
    private(set) var refreshableProviders: Set<String>?
    /// The providers whose models are being asked of again now, by how many asks.
    private(set) var refreshingModels: [String: Int] = [:]

    /// Reads which providers its box refreshes; as Accounts opens, so an updated box is seen.
    func readRefreshable() async {
        guard let box else { return }
        struct Listed: Decodable { var providers: [String] }
        do {
            refreshableProviders = Set(try await box.value(Listed.self, "GET", "kuvo/accounts/refreshable").providers)
        } catch let refusal as BoxRefusal where refusal.status == 404 {
            // A box from before Refresh Models.
            refreshableProviders = []
        } catch {}
    }

    /// Whether Refresh Models is offered for `provider` here.
    func refreshesModels(_ provider: String) -> Bool { refreshableProviders?.contains(provider) == true }

    /// Refresh Models: `provider`'s models asked of again by its computer's box, which makes the
    /// engine's lists afresh without restarting it (`kuvo/accounts/<provider>/refresh`). The pickers
    /// follow as the engine says its models changed. Says whether some folders get them only once
    /// their work is done; throws what the box said when it couldn't.
    @discardableResult
    func refreshModels(_ provider: String) async throws -> Bool {
        guard let box else { throw BoxRefusal(status: 503, message: "This computer's box isn't running.") }
        refreshingModels[provider, default: 0] += 1
        defer {
            let left = (refreshingModels[provider] ?? 1) - 1
            refreshingModels[provider] = left > 0 ? left : nil
        }
        struct Refreshed: Decodable { var waiting: [String] }
        let refreshed = try await box.value(Refreshed.self, "POST", "kuvo/accounts/\(provider.pathComponentEscaped)/refresh")
        return !refreshed.waiting.isEmpty
    }

    /// Why `model` can't answer now, if it can't: what happened and until when, for its row; the
    /// engine's words; and whether the line says it's free already (its free usage spent).
    func unanswering(_ model: Model, now: Date = .now) -> (line: String, why: String, saysFree: Bool)? {
        guard let held = unanswering.first(where: { $0.covers(model) && $0.until > now.timeIntervalSince1970 * 1000 }) else { return nil }
        let why = held.why.trimmingCharacters(in: .whitespacesAndNewlines)
        let said = why.hasSuffix(".") ? why : why + "."
        // Signed out or out of funds, it answers once you sign in or add funds, not at a time: its
        // `until` is only when the box tries it again.
        guard held.model != nil || held.only == "free" else { return (held.what, said, false) }
        let until = Date(timeIntervalSince1970: held.until / 1000)
        let calendar = Calendar.current
        // Today's by its time, this week's by its weekday too, a later one by its date.
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: until)).day ?? 0
        let time = days == 0 ? until.formatted(date: .omitted, time: .shortened)
            : days < 7 ? until.formatted(.dateTime.weekday(.abbreviated).hour().minute())
            : until.formatted(.dateTime.month(.abbreviated).day().hour().minute())
        return ("\(held.what) until \(time)", said, held.only == "free")
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
    static let planProviders = Plans.engine

    /// Shown first, in this order. Everything else follows alphabetically.
    /// (The outside agents have their own place, before these: `OutsideAgents.order`.)
    static let featured = ["openai", "github-copilot", "anthropic", "google", "xai", "openrouter", "opencode", "deepseek", "mistral", "groq"]
    static let featuredOrder = Dictionary(uniqueKeysWithValues: featured.enumerated().map { ($1, $0) })
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

extension Catalog {
    /// The models a review can be read by ("/review with <name>"): the engine's you can use now,
    /// as the review runs beside it; a coding agent's conversation is read by its own agent.
    var reviewReaders: [ReviewCommand.Reader] {
        offered.filter { !OutsideAgents.runsInBridge($0.providerID) }.map { ReviewCommand.Reader(name: $0.name, ref: $0.ref, provider: providerName($0.providerID)) }
    }

    /// The model picked last in "Who reads it", kept as `Model.key`.
    static let lastReviewerKey = "reviewerModel"

    /// The one picked last, as a reference.
    static var lastReviewer: ModelRef? {
        let parts = (UserDefaults.standard.string(forKey: lastReviewerKey) ?? "").split(separator: "/", maxSplits: 1).map(String.init)
        return parts.count == 2 ? ModelRef(id: parts[1], providerID: parts[0]) : nil
    }
}
