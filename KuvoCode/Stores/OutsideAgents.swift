import Foundation
import OpenCodeKit
import os

private let log = Logger(subsystem: "run.kuvo.code", category: "agents")

/// The coding agents you already have, beside the engine: Claude Code, Codex, Cursor, Grok and
/// Antigravity, each signed in as you (your plan or key with its maker), as T3 Code runs them.
///
/// A small server of Kuvo Code's own, the agents bridge (`kuvo-agents.js`, run by the engine's
/// Bun), drives each agent through its maker's SDK or CLI and answers in the engine's own API, so
/// their sessions, models and sign-ins show where the engine's do. This Mac's sessions run in the
/// one it starts, which keeps what it has in `agents` beside the engine's folder; each machine's
/// in one beside its engine there, which this connects to (`connect`).
@Observable
final class OutsideAgents {
    /// The machine whose bridge this is (nil: this Mac's).
    let machine: String?

    init(machine: String? = nil) {
        self.machine = machine
    }

    /// The bridge, once it has started.
    private(set) var api: OpenCodeAPI? {
        didSet { address.endpoint = api?.client.endpoint }
    }
    /// Its address, for the phone link's own threads.
    @ObservationIgnored let address = Address()

    nonisolated final class Address: @unchecked Sendable {
        private let lock = NSLock()
        private var value: ServerEndpoint?

        var endpoint: ServerEndpoint? {
            get { lock.withLock { value } }
            set { lock.withLock { value = newValue } }
        }
    }
    /// It couldn't start, and why.
    private(set) var failure: String?

    @ObservationIgnored private var server: ServerProcess?
    /// Starting: a second start meanwhile (the engine restarted) waits for this one.
    @ObservationIgnored private var isStarting = false
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var restarts: [Date] = []
    @ObservationIgnored private var engine: URL?
    @ObservationIgnored private var environment: [String: String] = [:]
    /// Each event it sends (to the catalog and the sessions, as the engine's go).
    @ObservationIgnored var onEvent: ((ServerEvent) -> Void)?
    /// Its feed is connected (again): what it has is read anew.
    @ObservationIgnored var onConnected: (() -> Void)?
    /// It couldn't start, or stopped for good: what it listed is gone.
    @ObservationIgnored var onStopped: (() -> Void)?

    /// Where this Mac's engine is, for the engine's own models in the bridge's sessions (Auto's,
    /// or one you pick in a session with an agent). Told to the bridge each time either starts.
    @ObservationIgnored var engineEndpoint: ServerEndpoint? {
        didSet { if engineEndpoint != oldValue { tellEngine() } }
    }

    /// Kuvo Code's own tools (the side panel's browser, show_in_panel, messages to other agents)
    /// as an MCP server, which the bridge gives each agent with its session.
    struct ToolServer: Encodable, Equatable, Sendable {
        var url: String
        var token: String
        /// How long a call may take, in milliseconds (one that asks you waits for you).
        var timeout: Int
    }

    @ObservationIgnored var toolServer: ToolServer? {
        didSet { if toolServer != oldValue { tellTools() } }
    }

    /// Auto: your list of models, and those held back at a limit until it resets.
    private(set) var auto = AutoList()

    /// The agents' providers (their models' and accounts' IDs), as the bridge names them: an
    /// account you added is `<agent's>@<id>` ("claude-code@1f2e3d4c").
    static let order = ["claude-code", "codex-cli", "cursor", "grok-cli", "antigravity"]
    static let providers = Set(order)
    /// Auto's provider: a session on it runs down your list.
    static let autoProvider = "auto"

    /// The agent's own provider, without the account: "claude-code" for "claude-code@1f2e3d4c".
    static func base(_ providerID: String) -> String {
        providerID.split(separator: "@", maxSplits: 1).first.map(String.init) ?? providerID
    }

    /// The account part of an added account's provider, if it is one.
    static func account(_ providerID: String) -> String? {
        let parts = providerID.split(separator: "@", maxSplits: 1)
        return parts.count == 2 && providers.contains(String(parts[0])) ? String(parts[1]) : nil
    }

    /// An agent's name, by its provider.
    static func name(_ providerID: String?) -> String {
        switch providerID.map(base) {
        case "claude-code": "Claude Code"
        case "codex-cli": "Codex"
        case "cursor": "Cursor"
        case "grok-cli": "Grok"
        case "antigravity": "Antigravity"
        default: "That agent"
        }
    }

    /// The mark an agent goes by: its maker's.
    static func logo(_ providerID: String) -> String {
        switch base(providerID) {
        case "claude-code": "anthropic"
        case "codex-cli": "openai"
        case "grok-cli": "xai"
        case "antigravity": "google"
        default: providerID
        }
    }

    /// One of your accounts with a coding agent.
    static func isAgent(_ providerID: String?) -> Bool {
        providerID.map { providers.contains(base($0)) } ?? false
    }

    /// A model the bridge runs a session on: an agent's, or Auto.
    static func runsInBridge(_ providerID: String?) -> Bool {
        providerID == autoProvider || isAgent(providerID)
    }

    /// A conversation on `model` that lives on `machine` (nil for this Mac) runs with the coding
    /// agents: a session's, a chat's, a bot's, a seat in a group chat alike.
    static func runsWithAgents(_ model: ModelRef?, machine: String?) -> Bool {
        ModelScope.on(machine: machine) == .all && runsInBridge(model?.providerID)
    }

    /// A session one of these agents runs: the bridge marks its own.
    static func isAgentSession(_ session: Session) -> Bool {
        session.metadata?["kuvoAgent"]?.string != nil
    }

    /// Where the bridge keeps its sessions, the agents' SDKs and its cache.
    static var home: URL { AppInfo.supportDirectory.appending(path: "agents") }
    /// This one's (a test's bridge keeps its own).
    @ObservationIgnored var home = OutsideAgents.home

    /// The bridge's script: KUVO_AGENTS_SCRIPT's (a checkout's `Agents/src/main.ts`) in a debug
    /// build, else the app's own.
    private static var script: URL? {
        #if DEBUG
        if let path = ProcessInfo.processInfo.environment["KUVO_AGENTS_SCRIPT"] { return URL(filePath: path) }
        #endif
        return Bundle.main.url(forResource: "kuvo-agents", withExtension: "js")
    }

    /// Starts the bridge with the engine's Bun, in your login shell's environment (so it finds
    /// `claude`, `codex` and `grok` where your terminal does).
    func start(engine: URL, environment: [String: String]) async {
        guard server == nil, !isStarting else { return }
        isStarting = true
        defer { isStarting = false }
        self.engine = engine
        self.environment = environment
        guard let script = Self.script else {
            failure = "The agents bridge is missing from the app."
            onStopped?()
            return
        }
        var env = environment
        env["BUN_BE_BUN"] = "1"
        // Bun would otherwise keep a copy of the script, compiled, in ~/Library/Caches/bun.
        env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"] = "0"
        env["KUVO_AGENTS_HOME"] = home.path
        // Its temporary files (and the agents'), in the app's own temporary folder.
        let temporary = FileManager.default.temporaryDirectory.appending(path: Bundle.main.bundleIdentifier ?? "run.kuvo.code").appending(path: "agents")
        env["TMPDIR"] = temporary.path + "/"
        do {
            try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
            let server = try await ServerProcess.start(
                executable: engine,
                arguments: ["run", script.path],
                environment: env,
                directory: home,
                onExit: { [weak self] status in Task { @MainActor in self?.exited(status: status) } }
            )
            self.server = server
            // Stopped already, its exit heard before this: as `exited` would have it then.
            if let status = server.exitStatus {
                exited(status: status)
                return
            }
            let api = OpenCodeAPI(endpoint: server.endpoint)
            self.api = api
            failure = nil
            listen(to: api)
            tellEngine()
            tellTools()
            // Not waited for here: one that stops meanwhile is started again (see `exited`).
            Task { await loadAuto() }
        } catch {
            log.error("The agents bridge didn't start: \(error.localizedDescription, privacy: .public)")
            failure = error.localizedDescription
            onStopped?()
        }
    }

    func stop() {
        eventTask?.cancel()
        eventTask = nil
        server?.stop()
        server = nil
        api = nil
    }

    /// A machine's bridge, through its engine's tunnel (`endpoint`; nil when that engine started
    /// without one): its sessions, accounts and Custom Auto, as this Mac's. Its folders are the
    /// machine's (`folderPrefix`).
    func connect(_ endpoint: ServerEndpoint?, folderPrefix: String) {
        guard endpoint != api?.client.endpoint || api == nil else { return }
        eventTask?.cancel()
        eventTask = nil
        guard let endpoint else {
            api = nil
            failure = "this machine's engine started without them. They come with it when it next starts, once nothing runs there."
            return
        }
        let api = OpenCodeAPI(endpoint: endpoint, folderPrefix: folderPrefix)
        self.api = api
        failure = nil
        listen(to: api)
        Task { await loadAuto() }
    }

    /// Its machine disconnected: nothing to reach until it's back.
    func disconnect() {
        eventTask?.cancel()
        eventTask = nil
        downSince?.cancel()
        downSince = nil
        isDown = false
        api = nil
    }

    /// A machine's bridge hasn't answered for a while (it stopped there, and didn't start again).
    private(set) var isDown = false
    @ObservationIgnored private var downSince: Task<Void, Never>?

    private func listen(to api: OpenCodeAPI) {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            for await update in api.events.updates() {
                guard let self else { return }
                switch update {
                case .connected:
                    downSince?.cancel()
                    downSince = nil
                    isDown = false
                    onConnected?()
                    await loadAuto()
                case .disconnected:
                    // A machine's: said once it stays away (it starts again by itself after a crash).
                    guard machine != nil, downSince == nil else { break }
                    downSince = Task { [weak self] in
                        try? await Task.sleep(for: .seconds(30))
                        guard !Task.isCancelled else { return }
                        self?.isDown = true
                    }
                case .event(let event):
                    if event.type == "kuvo.auto.updated" { await loadAuto() }
                    onEvent?(event)
                }
            }
        }
    }

    /// It stopped by itself: started again, unless it keeps stopping.
    private func exited(status: Int32) {
        guard server != nil else { return }
        let output = server?.recentOutput.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        log.error("The agents bridge stopped (\(status)): \(output, privacy: .public)")
        stop()
        restarts.removeAll { $0 < .now.addingTimeInterval(-300) }
        guard restarts.count < 3, let engine else {
            failure = "It stopped unexpectedly (exit code \(status)).\(output.isEmpty ? "" : "\n\n" + String(output.suffix(600)))"
            onStopped?()
            return
        }
        restarts.append(.now)
        let environment = environment
        Task { await start(engine: engine, environment: environment) }
    }

    /// Tells the bridge where the engine is.
    /// Tells the bridge where Kuvo Code's tools are.
    private func tellTools() {
        guard let api, let toolServer else { return }
        Task { try? await api.setAgentsTools(toolServer) }
    }

    private func tellEngine() {
        guard let api, let engineEndpoint else { return }
        Task { try? await api.setAgentsEngine(engineEndpoint) }
    }

    // MARK: Auto

    /// Its Custom Auto lists, as its bridge keeps them: this Mac's and each machine's are their
    /// own, made from the models each has (a machine's agents are signed in there).
    func loadAuto() async {
        guard let api, let list = try? await api.autoList() else { return }
        if list != auto { auto = list }
    }

    /// A Custom Auto list to show in Settings › Custom Auto as it opens (one picked to edit, or
    /// just made), with these agents' lists in view.
    var autoFocus: String?

    /// Its lists as you arranged them.
    func saveAuto(_ lists: [AutoList.Named]) async throws {
        guard let api else { throw Failure.unavailable("Custom Auto") }
        let saved = auto
        let arranged = AutoList(entries: lists.first?.entries ?? [], lists: lists, limits: auto.limits)
        auto = arranged
        do {
            auto = try await api.saveAutoLists(lists)
        } catch {
            // Not saved, as far as it heard: the list Auto uses, which may have come meanwhile (a
            // save that went through, its answer lost), else the one before.
            if auto == arranged { auto = saved }
            await loadAuto()
            throw error
        }
    }

    /// An account you just signed in to again, or switched to another of: Custom Auto tries it
    /// again, rather than waiting out a limit the account before reached.
    func releaseLimit(_ provider: String) async {
        guard let api, auto.limits.contains(where: { $0.key == provider || $0.key.hasPrefix(provider + "/") }) else { return }
        try? await api.releaseAutoLimit(provider)
        await loadAuto()
    }

    /// Every model at a limit tried again.
    func clearAutoLimits() async throws {
        guard let api else { throw Failure.unavailable("Custom Auto") }
        try await api.clearAutoLimits()
        await loadAuto()
    }

    // MARK: Accounts

    /// Another account with an agent: its provider, to sign in to.
    func addAccount(agent: String, label: String) async throws -> String {
        guard let api else { throw Failure.unavailable("Adding an account") }
        return try await api.addAgentAccount(agent: agent, label: label)
    }

    func renameAccount(_ providerID: String, label: String) async throws {
        guard let api else { throw Failure.unavailable("Renaming an account") }
        try await api.renameAgentAccount(providerID, label: label)
    }

    func removeAccount(_ providerID: String) async throws {
        guard let api else { throw Failure.unavailable("Removing an account") }
        try await api.removeAgentAccount(providerID)
    }

    /// Agents whose program is updating, by the account it was asked for: updating wherever you
    /// look (Settings closed and opened again), and not asked twice.
    private(set) var updating: Set<String> = []
    /// Why an update didn't work, until you've seen it (where you look next, when you'd gone).
    var updateFailures: [String: String] = [:]

    /// Updates an agent's program (Claude Code, Codex, Grok's CLI) through the installer that owns
    /// it, then `refresh`es what the app shows of it; it's updating until then.
    @discardableResult
    func update(_ providerID: String, then refresh: @escaping () async -> Void) -> Task<Void, Never>? {
        guard let api, !updating.contains(providerID) else { return nil }
        updating.insert(providerID)
        updateFailures[providerID] = nil
        return Task {
            do {
                let result = try await api.updateAgent(providerID)
                if !result.updated, let message = result.message { updateFailures[providerID] = message }
            } catch {
                updateFailures[providerID] = error.localizedDescription
            }
            // Its version and models, as they are now, before its button comes back.
            await refresh()
            updating.remove(providerID)
        }
    }

    /// Agents whose program is installing, by the account it was asked for.
    private(set) var installing: Set<String> = []
    /// Why an install didn't work, until you've seen it.
    var installFailures: [String: String] = [:]

    /// Installs an agent's program (Claude Code, Codex, Grok's CLI) with its maker's own installer,
    /// the command it shows, on the computer its bridge is on, as you'd run it in a terminal there;
    /// then `refresh`es what the app shows of it. Whether it's there after (`then` gets true) is
    /// what counts.
    func install(_ providerID: String, then refresh: @escaping (Bool) async -> Void) {
        guard let api, !installing.contains(providerID) else { return }
        installing.insert(providerID)
        installFailures[providerID] = nil
        Task {
            var installed = false
            do {
                let result = try await api.installAgent(providerID)
                installed = result.installed
                if !result.installed { installFailures[providerID] = result.message ?? "It isn't installed." }
            } catch {
                installFailures[providerID] = error.localizedDescription
            }
            await refresh(installed)
            installing.remove(providerID)
        }
    }

    /// Signs out of an agent, where the agent lets an app do that (Cursor's browser sign-in).
    func signOut(_ providerID: String) async throws {
        guard let api else { return }
        try await api.disconnectAgent(providerID)
    }

    enum Failure: LocalizedError {
        case unavailable(String)
        /// The bridge isn't up (yet): why, if it couldn't start.
        case notRunning(String?)

        var errorDescription: String? {
            switch self {
            case .unavailable(let what): "\(what) isn't available in sessions with this agent."
            case .notRunning(let why): why.map { "The coding agents couldn't start: \($0)" } ?? "The coding agents are still starting. Try again in a moment."
            }
        }
    }
}

/// One model in your Auto list, with its effort.
nonisolated struct AutoEntry: Codable, Hashable, Identifiable, Sendable {
    var providerID: String
    var modelID: String
    var variant: String?

    var id: String { "\(providerID)/\(modelID)/\(variant ?? "")" }
    var ref: ModelRef { ModelRef(id: modelID, providerID: providerID, variant: variant) }

    init(_ ref: ModelRef) {
        providerID = ref.providerID
        modelID = ref.id
        variant = ref.variant
    }
}

/// A model, or an account's every model, held back at a limit until it resets.
nonisolated struct AutoLimit: Codable, Hashable, Sendable {
    /// `<provider>` for an account's limit, `<provider>/<model>` for a model's.
    var key: String
    /// Milliseconds since 1970.
    var until: Double
    var scope: String
    /// Its reset is the agent's word, rather than a guess.
    var known: Bool

    var resets: Date { Date(timeIntervalSince1970: until / 1000) }
    var isWholeAccount: Bool { scope == "provider" }

    /// It holds back this entry.
    func holds(_ entry: AutoEntry) -> Bool {
        key == entry.providerID || key == "\(entry.providerID)/\(entry.modelID)"
    }
}

/// Your Auto lists, and what's held back at a limit (for every list).
nonisolated struct AutoList: Codable, Hashable, Sendable {
    /// The first list's models (all a bridge from before lists says).
    var entries: [AutoEntry] = []
    var lists: [Named]?
    var limits: [AutoLimit] = []

    /// One of your lists, with its name (one for bugfixes, one for features): a session on Auto
    /// runs on one, named by its model's ID.
    struct Named: Codable, Hashable, Identifiable, Sendable {
        var id: String
        var name: String
        var entries: [AutoEntry]
    }

    /// The first list's ID, which Auto had before there were lists.
    static let firstID = "auto"

    /// Every list, in your order.
    var all: [Named] { lists ?? [Named(id: Self.firstID, name: "Custom Auto", entries: entries)] }

    /// The list a session's model names: that one, or the first (for one deleted since).
    func list(_ id: String?) -> Named? {
        all.first { $0.id == id } ?? all.first
    }

    /// When the account `provider` is held back at its usage limit (all its models), if it is.
    func limit(for provider: String, now: Date = .now) -> Date? {
        limits.filter { $0.isWholeAccount && $0.key == provider && $0.resets > now }.map(\.resets).max()
    }
}

/// An account that needs you, as Accounts and the sidebar show it: its sign-in ended, or Custom
/// Auto holds it back at its usage limit.
nonisolated enum AccountProblem: Hashable, Sendable {
    case signInEnded
    case atLimit(until: Date)

    /// "Sign-in ended", "Usage limit · Resets in 3 hr".
    var text: String {
        switch self {
        case .signInEnded: "Sign-in ended"
        case .atLimit(let until): "Usage limit · " + ContextGauge.resets(until)
        }
    }

    /// "sign in again", "at its usage limit": after its name, in a list.
    var short: String {
        switch self {
        case .signInEnded: "sign in again"
        case .atLimit: "at its usage limit"
        }
    }
}

extension Catalog {
    /// Your accounts that need you, by name: a coding agent's or a plan's whose sign-in ended, and
    /// those Custom Auto holds back at their usage limit.
    @MainActor func accountProblems(limits auto: AutoList) -> [(name: String, problem: AccountProblem)] {
        var found: [(name: String, problem: AccountProblem)] = []
        for agent in codingAgents {
            let name = [OutsideAgents.name(agent.id), agent.metadata?["accountLabel"]?.string].compactMap(\.self).joined(separator: " ")
            if agent.metadata?["signInEnded"]?.bool == true { found.append((name, .signInEnded)) }
            else if let until = auto.limit(for: agent.id) { found.append((name, .atLimit(until: until))) }
        }
        for plan in providers where plan.isConnected || plan.connections.contains(where: { $0.status?.status == "needs_auth" }) {
            if plan.connections.contains(where: { $0.status?.status == "needs_auth" }) || hasEndedSignIn(plan.id) { found.append((plan.name, .signInEnded)) }
            else if let until = auto.limit(for: plan.id) { found.append((plan.name, .atLimit(until: until))) }
        }
        return found
    }
}

extension OpenCodeAPI {
    /// The agents' accounts; `fresh` asks each agent anew (with your shell's PATH read again).
    func agentIntegrations(fresh: Bool) async throws -> [Integration] {
        let request = try client.request("GET", "api/integration", query: ["fresh": fresh ? "1" : nil])
        return try await client.send(request, as: LocatedEnvelope<[Integration]>.self).data
    }

    /// The agents bridge's own: where the engine is, for its models in the bridge's sessions.
    func setAgentsTools(_ server: OutsideAgents.ToolServer) async throws {
        _ = try await client.send(try client.request("PUT", "api/kuvo/tools", body: server), as: Empty.self)
    }

    func setAgentsEngine(_ endpoint: ServerEndpoint) async throws {
        struct Body: Encodable { var url: String; var password: String? }
        _ = try await client.send(try client.request("PUT", "api/kuvo/engine", body: Body(url: endpoint.url.absoluteString, password: endpoint.password)), as: Empty.self)
    }

    func autoList() async throws -> AutoList {
        try await client.send(try client.request("GET", "api/kuvo/auto"), as: DataEnvelope<AutoList>.self).data
    }

    func saveAutoLists(_ lists: [AutoList.Named]) async throws -> AutoList {
        struct Body: Encodable { var lists: [AutoList.Named] }
        return try await client.send(try client.request("PUT", "api/kuvo/auto", body: Body(lists: lists)), as: DataEnvelope<AutoList>.self).data
    }

    func clearAutoLimits() async throws {
        _ = try await client.send(try client.request("DELETE", "api/kuvo/auto/limits"), as: Empty.self)
    }

    /// One account's limits (`provider`), let go.
    func releaseAutoLimit(_ provider: String) async throws {
        _ = try await client.send(try client.request("DELETE", "api/kuvo/auto/limits", query: ["provider": provider]), as: Empty.self)
    }

    /// Another account with an agent (`claude`, `codex`…): its provider ID.
    func addAgentAccount(agent: String, label: String) async throws -> String {
        struct Body: Encodable { var agent: String; var label: String }
        return try await client.send(try client.request("POST", "api/kuvo/accounts", body: Body(agent: agent, label: label)), as: DataEnvelope<AddedAccount>.self).data.providerID
    }

    func renameAgentAccount(_ providerID: String, label: String) async throws {
        struct Body: Encodable { var label: String }
        _ = try await client.send(try client.request("PATCH", "api/kuvo/accounts/\(providerID.pathComponentEscaped)", body: Body(label: label)), as: Empty.self)
    }

    /// Runs the agent's update, which can take minutes (a download, Homebrew updating itself first).
    func updateAgent(_ providerID: String) async throws -> AgentUpdate {
        var request = try client.request("POST", "api/integration/\(providerID.pathComponentEscaped)/update")
        request.timeoutInterval = 15 * 60
        return try await client.send(request, as: DataEnvelope<AgentUpdate>.self).data
    }

    func installAgent(_ providerID: String) async throws -> AgentInstall {
        var request = try client.request("POST", "api/integration/\(providerID.pathComponentEscaped)/install")
        request.timeoutInterval = 15 * 60
        return try await client.send(request, as: DataEnvelope<AgentInstall>.self).data
    }

    func removeAgentAccount(_ providerID: String) async throws {
        _ = try await client.send(try client.request("DELETE", "api/kuvo/accounts/\(providerID.pathComponentEscaped)"), as: Empty.self)
    }

    /// The agents bridge's own: signs out of an agent it signed in to itself.
    func disconnectAgent(_ providerID: String) async throws {
        _ = try await client.send(try client.request("POST", "api/integration/\(providerID.pathComponentEscaped)/disconnect"), as: Empty.self)
    }
}

/// How updating an agent's program went.
nonisolated struct AgentUpdate: Decodable, Sendable {
    var updated: Bool
    var version: String?
    /// What went wrong, in the installer's words.
    var message: String?
}

nonisolated struct AgentInstall: Decodable, Sendable {
    var installed: Bool
    var version: String?
    /// What went wrong, in the installer's words.
    var message: String?
}

nonisolated private struct AddedAccount: Decodable, Sendable {
    var providerID: String
}

nonisolated private extension String {
    /// As one part of a path: "claude-code@1f2e" stays readable, anything else is escaped.
    var pathComponentEscaped: String {
        addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~@"))) ?? self
    }
}
