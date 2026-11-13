import ClientAccounts
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
    /// Its process while it runs: waited for as this Mac's box stops (`MacBoxRunner.stop`).
    var processID: Int32? { server.map(\.processID) }

    /// Tells this Mac's box where it is again (a box whose folder started afresh, a test's).
    func recordForBox() {
        guard let server, server.exitStatus == nil else { return }
        BoxProcess.agentsChanged(server.endpoint, pid: server.processID)
    }
    /// The start under way: a second start meanwhile (the engine restarted) waits for this one,
    /// and one stopped meanwhile (`stop`) leaves nothing running when it comes back.
    @ObservationIgnored private var startInFlight: UUID?
    /// Which start the server running now came from: one before it, slow to go, says nothing of it.
    @ObservationIgnored private var runningStart: UUID?
    /// Its process starting: stopping it ends that at once.
    @ObservationIgnored private var starting: Task<ServerProcess, Error>?
    /// One whose start failed, or that keeps stopping, tried again by itself: `stop` calls off the
    /// next try.
    @ObservationIgnored let retries = StartRetries()
    /// When it came up, this time.
    @ObservationIgnored private var upSince: Date?
    /// How long it's given to say where it listens (a test's is short).
    @ObservationIgnored var startTimeout: Duration = .seconds(60)
    /// An exit heard, whichever server's (a test waits on it).
    @ObservationIgnored var onExitHeard: () -> Void = {}
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

    /// The goals conversations on its computer work toward, by session: the bridge runs them,
    /// for the engine's sessions there and the agents' alike (`Goal`). As last heard while its
    /// machine is away: they go on there.
    private(set) var goals: [String: Goal] = [:]
    /// False for one from before goals (a machine's not set up again); nil until it has said.
    private(set) var runsGoals: Bool?

    /// Side questions ("/btw"), by conversation, oldest first: each conversation's read when it's
    /// opened (`loadSideQuestions`), and how many each has for the sidebar, all kept current
    /// from its events.
    private(set) var sideQuestions: [String: [SideQuestion]] = [:]
    private(set) var sideQuestionCounts: [String: Int] = [:]
    /// Each conversation's latest review with fresh eyes ("/review"), until it's put away.
    private(set) var reviews: [String: Review] = [:]
    /// Each conversation's handoff ("/handoff") under way or just done, while this runs.
    private(set) var handoffs: [String: Handoff] = [:]
    /// False for one from before side questions, handoffs and reviews; nil until it has said.
    private(set) var runsKeywords: Bool?
    /// A handoff asked for from this Mac, done: its new conversation, to open (`kuvo.handoff`).
    /// One asked for elsewhere (the phone) opens nothing here.
    @ObservationIgnored var onHandoff: ((Handoff) -> Void)?
    /// The conversations handed off from this Mac, until theirs is done or failed.
    @ObservationIgnored private var opensWhenDone: Set<String> = []

    /// The agents' providers (their models' and accounts' IDs), as the bridge names them: an
    /// account you added is `<agent's>@<id>` ("claude-code@1f2e3d4c").
    nonisolated static let order = Plans.agents
    nonisolated static let providers = Set(order)
    /// Auto's provider: a session on it runs down your list.
    nonisolated static let autoProvider = "auto"

    /// The agent's own provider, without the account: "claude-code" for "claude-code@1f2e3d4c".
    nonisolated static func base(_ providerID: String) -> String { Plans.base(providerID) }

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
        Plans.providers[base(providerID)] ?? providerID
    }

    /// One of your accounts with a coding agent.
    nonisolated static func isAgent(_ providerID: String?) -> Bool {
        providerID.map { providers.contains(base($0)) } ?? false
    }

    /// A model the bridge runs a session on: an agent's, or Auto.
    nonisolated static func runsInBridge(_ providerID: String?) -> Bool {
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

    /// The bridge's script: KUVO_AGENTS_SCRIPT's (a checkout's `Packages/Box/src/agents/main.ts`) in a debug
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
        guard server == nil, startInFlight == nil else { return }
        let start = UUID()
        startInFlight = start
        defer { if startInFlight == start { startInFlight = nil } }
        let began = ContinuousClock.now
        upSince = nil
        self.engine = engine
        self.environment = environment
        // Why it was down isn't why it is now: a phone hears it's starting while it is.
        BoxProcess.forgetAgentsStopped()
        guard let script = Self.script else {
            down("The agents bridge is missing from the app.")
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
            let directory = home, environmentNow = env, timeout = startTimeout
            let starting = Task {
                try await ServerProcess.start(
                    executable: engine,
                    // (No `.env` from its folder, which an agent's command can write.)
                    arguments: ["run", "--config=/dev/null", "--no-env-file", script.path],
                    environment: environmentNow,
                    directory: directory,
                    timeout: timeout,
                    onExit: { [weak self] status in Task { @MainActor in self?.exited(status: status, of: start) } }
                )
            }
            self.starting = starting
            let server = try await withTaskCancellationHandler { try await starting.value } onCancel: { starting.cancel() }
            // Stopped meanwhile: it stays stopped.
            guard startInFlight == start else {
                server.stop()
                return
            }
            self.server = server
            runningStart = start
            // Stopped already, its exit heard before this: as `exited` would have it then.
            if let status = server.exitStatus {
                exited(status: status, of: start)
                return
            }
            let api = OpenCodeAPI(endpoint: server.endpoint)
            self.api = api
            failure = nil
            upSince = .now
            retries.cameUp(since: began)
            // This Mac's box finds it as a machine's does.
            BoxProcess.agentsChanged(server.endpoint, pid: server.processID)
            listen(to: api)
            tellEngine()
            tellTools()
            // Not waited for here: one that stops meanwhile is started again (see `exited`).
            Task { await loadAuto() }
        } catch {
            guard startInFlight == start else { return }
            log.error("The agents bridge didn't start: \(error.localizedDescription, privacy: .public)")
            guard StartRetries.canHelp(error) else {
                down(Self.reason(error))
                return
            }
            tryAgain(Self.reason(error), asked: retries.wasAsked(error, since: began))
        }
    }

    /// Down, for a reason another try can help: it says so, and goes on trying.
    private func tryAgain(_ reason: String, asked: Bool = false) {
        guard let engine else { return }
        let wait = retries.next(asked: asked)
        down(StartRetries.noted(reason, asked: asked), retrying: true)
        log.info("Trying the agents bridge again in \(wait) seconds")
        let environment = environment
        retries.schedule(after: wait, orAnswered: asked) { [weak self] in
            await self?.start(engine: engine, environment: environment)
        }
    }

    /// Down: why, here and for whoever asks this Mac's box (`run/agents-stopped`).
    private func down(_ reason: String, retrying: Bool = false) {
        failure = reason
        BoxProcess.agentsStopped(reason, retrying: retrying)
        onStopped?()
    }

    /// Whether it was started (there was a Bun to run it with), so it can be started again.
    var wasStarted: Bool { engine != nil || follows }

    /// Started again at once (Restart where that shows), as it was started: by
    /// this Mac's keeper, when it's the keeper's.
    func startAgain() async {
        if follows {
            do { try await KeeperControl.send(.restartAgents) } catch { failure = error.localizedDescription }
            return
        }
        guard server == nil, let engine else { return }
        // Whatever it's doing by itself: a try waiting its turn, or one that's held up.
        callOffStart()
        restarts.removeAll()
        retries.reset()
        failure = nil
        await start(engine: engine, environment: environment)
    }

    #if DEBUG
    /// KUVO_DEMO_AGENTS_FAILED: as if it had stopped for good, to see how that shows.
    func showFailure(_ text: String) {
        stop()
        failure = text
        onStopped?()
    }
    #endif

    /// Why it didn't start, in the words of what's shown (ServerProcess's own say "the engine",
    /// which may be fine, and this comes after "The coding agents couldn't start").
    private static func reason(_ error: any Error) -> String {
        switch error {
        case ServerProcessError.exited(let status, let output):
            "It stopped (exit code \(status)).\(output.isEmpty ? "" : "\n\n\(output)")"
        case ServerProcessError.unreadableHandshake(let line):
            "It said something unexpected when starting: \(line)"
        case ServerProcessError.timedOut:
            "It took too long to start."
        default:
            error.localizedDescription
        }
    }

    /// A start under way ended, and the next try called off.
    private func callOffStart() {
        retries.callOff()
        starting?.cancel()
        starting = nil
        startInFlight = nil
    }

    func stop() {
        callOffStart()
        eventTask?.cancel()
        eventTask = nil
        if server != nil { BoxProcess.agentsChanged(nil, pid: nil) }
        // Stopped, nothing's trying any more, and there's no failure to tell.
        failure = nil
        BoxProcess.forgetAgentsStopped()
        server?.stop()
        server = nil
        api = nil
        goals = [:]
        forgetKeywords()
    }

    private func forgetKeywords() {
        sideQuestions = [:]
        sideQuestionCounts = [:]
        reviews = [:]
        handoffs = [:]
    }

    /// Whether it's this Mac's keeper's (`Keeper`), which runs it whether or not the app is open:
    /// this follows it, by its record (`run/bridge.json`), rather than starting it.
    private(set) var follows = false

    /// Not the keeper's any more (background work switched off): the app runs it itself from now on.
    func unfollow() {
        follow(nil, failure: nil)
        follows = false
    }

    /// The keeper's bridge, as its record and the keeper say: where it answers, or why it doesn't.
    func follow(_ endpoint: ServerEndpoint?, failure: String?) {
        follows = true
        guard let endpoint else {
            self.failure = failure
            guard api != nil else { return }
            eventTask?.cancel()
            eventTask = nil
            api = nil
            goals = [:]
            forgetKeywords()
            onStopped?()
            return
        }
        self.failure = nil
        guard endpoint != api?.client.endpoint else { return }
        eventTask?.cancel()
        let api = OpenCodeAPI(endpoint: endpoint)
        self.api = api
        listen(to: api)
        Task { await loadAuto() }
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
        let api = OpenCodeAPI(endpoint: endpoint, session: MachineEngine.patient, folderPrefix: folderPrefix)
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
        runsGoals = nil
        runsKeywords = nil
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
                    await loadGoals()
                    await loadKeywords()
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
                    if event.type == "kuvo.goal.updated", let update = try? event.payload(as: GoalUpdate.self) { goals[update.sessionID] = update.goal }
                    keywordEvent(event)
                    onEvent?(event)
                }
            }
        }
    }

    /// It stopped by itself: started again, at once unless it keeps stopping.
    private func exited(status: Int32, of start: UUID) {
        defer { onExitHeard() }
        guard server != nil, start == runningStart else { return }
        let output = server?.recentOutput.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        log.error("The agents bridge stopped (\(status)): \(output, privacy: .public)")
        retries.stopped(ranFor: upSince.map { -$0.timeIntervalSinceNow } ?? 0)
        stop()
        restarts.removeAll { $0 < .now.addingTimeInterval(-300) }
        guard restarts.count < 3, !retries.isBackingOff, let engine else {
            tryAgain("It stopped unexpectedly (exit code \(status)).\(output.isEmpty ? "" : "\n\n" + String(output.suffix(600)))")
            return
        }
        restarts.append(.now)
        let environment = environment
        retries.schedule(after: nil) { [weak self] in
            await self?.start(engine: engine, environment: environment)
        }
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

    /// Its goals, as its bridge has them (each change comes as `kuvo.goal.updated` after).
    func loadGoals() async {
        guard let api else { return }
        do {
            let read = Dictionary(try await api.goals().map { ($0.session, $0) }, uniquingKeysWith: { $1 })
            runsGoals = true
            if read != goals { goals = read }
        } catch let error as ServerError where error.status == 404 {
            // From before goals: nothing of them to show.
            runsGoals = false
            goals = [:]
        } catch {}
    }

    /// A goal as a change to it answered, before its event comes.
    func took(_ goal: Goal) { goals[goal.session] = goal }

    // MARK: Side questions, handoffs and reviews

    /// Its reviews and how many side questions each conversation has (each change comes as an event after).
    func loadKeywords() async {
        guard let api else { return }
        do {
            let read = Dictionary(try await api.reviews().map { ($0.session, $0) }, uniquingKeysWith: { $1 })
            runsKeywords = true
            if read != reviews { reviews = read }
            let counts = Dictionary(try await api.sideQuestionSummary().map { ($0.session, $0.count) }, uniquingKeysWith: { $1 })
            if counts != sideQuestionCounts { sideQuestionCounts = counts }
            // Each one's list, for the sidebar's Side Questions menu (which can't read as it opens).
            for session in counts.keys.prefix(40) where sideQuestions[session] == nil { await loadSideQuestions(of: session) }
            // A conversation's list read before is read again: some may have come meanwhile.
            for session in sideQuestions.keys { await loadSideQuestions(of: session) }
            // A handoff whose end came while this was away: as the box has it now (gone, after
            // the box restarted).
            for (session, handoff) in handoffs where handoff.state == .writing {
                // Unchanged when it can't be read now; gone (nil) after the box restarted.
                let now: Handoff?
                do { now = try await api.handoff(session: session) } catch { continue }
                handoffs[session] = now
                if let now { ended(now) } else { opensWhenDone.remove(session) }
            }
        } catch let error as ServerError where error.status == 404 {
            // From before them.
            runsKeywords = false
            forgetKeywords()
        } catch {}
    }

    /// A conversation's side questions, as its box keeps them.
    func loadSideQuestions(of session: String) async {
        guard let api, runsKeywords != false, let read = try? await api.sideQuestions(of: session) else { return }
        if read != sideQuestions[session] { sideQuestions[session] = read }
        // Each session opened loads its own: written only when it changes, as every sidebar row
        // reads the counts, and a write that changes nothing works them all out again.
        let count = read.isEmpty ? nil : read.count
        if count != sideQuestionCounts[session] { sideQuestionCounts[session] = count }
    }

    /// One as its route answered, before its event comes.
    func took(_ question: SideQuestion) {
        guard var list = sideQuestions[question.session] else {
            // A conversation whose list isn't read here (asked from the phone): its count, one more
            // for a new one.
            if question.state == .answering { sideQuestionCounts[question.session, default: 0] += 1 }
            return
        }
        if let index = list.firstIndex(where: { $0.id == question.id }) {
            // The ask's own answer can come after its answer's event (a quick model): what it
            // says, still answering, doesn't take the answer away.
            guard !(question.state == .answering && list[index].state != .answering) else { return }
            list[index] = question
        } else {
            list.append(question)
        }
        sideQuestions[question.session] = list
        sideQuestionCounts[question.session] = list.count
    }

    /// A side question shown while its box says what the text sent means (`SessionModel.submit`):
    /// in a list read already, and counted nowhere. Whether it shows.
    @discardableResult
    func showAsking(_ question: SideQuestion) -> Bool {
        guard var list = sideQuestions[question.session] else { return false }
        list.append(question)
        sideQuestions[question.session] = list
        return true
    }

    /// That one gone, once its box has said.
    func dropAsking(_ id: String, of session: String) {
        guard let list = sideQuestions[session], list.contains(where: { $0.id == id }) else { return }
        sideQuestions[session] = list.filter { $0.id != id }
    }

    func dropSideQuestion(_ id: String?, of session: String) {
        guard let id else {
            sideQuestions[session] = sideQuestions[session].map { _ in [] }
            sideQuestionCounts[session] = nil
            return
        }
        guard let list = sideQuestions[session] else {
            let left = (sideQuestionCounts[session] ?? 1) - 1
            sideQuestionCounts[session] = left > 0 ? left : nil
            return
        }
        let left = list.filter { $0.id != id }
        sideQuestions[session] = left
        sideQuestionCounts[session] = left.isEmpty ? nil : left.count
    }

    func took(_ review: Review) { reviews[review.session] = review }
    func dropReview(_ session: String) { reviews[session] = nil }
    /// One just asked for here: the box's answer, before its events.
    func startedHandoff(_ handoff: Handoff) {
        handoffs[handoff.from] = handoff
        opensWhenDone.insert(handoff.from)
        ended(handoff)
    }

    private func ended(_ handoff: Handoff) {
        guard handoff.state != .writing, opensWhenDone.remove(handoff.from) != nil, handoff.state == .done else { return }
        onHandoff?(handoff)
    }

    private func keywordEvent(_ event: ServerEvent) {
        switch event.type {
        case "kuvo.btw.updated":
            if let update = try? event.payload(as: SideQuestionUpdate.self) { took(update.question) }
        case "kuvo.btw.removed":
            struct Removed: Decodable { var sessionID: String; var id: String? }
            if let removed = try? event.payload(as: Removed.self) { dropSideQuestion(removed.id, of: removed.sessionID) }
        case "kuvo.review.updated":
            if let update = try? event.payload(as: ReviewUpdate.self) { reviews[update.sessionID] = update.review }
        case "kuvo.handoff":
            guard let update = try? event.payload(as: HandoffUpdate.self) else { return }
            handoffs[update.sessionID] = update.handoff
            ended(update.handoff)
        default:
            break
        }
    }

    /// A goal put away, as its route answered.
    func dropGoal(_ session: String) { goals[session] = nil }

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

    /// The agents another account is being added to: one at a time each, so a second tap adds none.
    private(set) var addingAccount: Set<String> = []

    /// Another account with an agent: its provider, to sign in to; nil while one's being added.
    func addAccount(agent: String, label: String) async throws -> String? {
        guard let api else { throw Failure.unavailable("Adding an account") }
        guard addingAccount.insert(agent).inserted else { return nil }
        defer { addingAccount.remove(agent) }
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

    /// The program updates whose outcome you've seen here (`ProgramUpdate.id`), gone from view at
    /// once while their box forgets them for every device (`seen`). How each stands is its box's
    /// (`Integration.programUpdate`).
    private var seenUpdates: Set<String> = []
    /// The programs (`metadata.agent`) whose update, or Update All, is being asked of the box: said
    /// to be updating until it says so itself. (A box from before `kuvo/updates` answers only once
    /// they're done, and says nothing meanwhile.)
    private var askedUpdates: Set<String> = []

    private static func program(_ integration: Integration) -> String {
        integration.metadata?["agent"]?.string ?? integration.id
    }

    /// Whether its program's update, or Update All, is being asked of its box now.
    func isAskedToUpdate(_ integration: Integration) -> Bool {
        askedUpdates.contains(Self.program(integration))
    }

    /// How an agent's program stands, as its row or tile in Settings › Accounts says it.
    enum UpdateStatus: Equatable {
        /// A newer version is out.
        case available(String)
        case updating
        /// Updated just now, to this version.
        case updated(String)
        /// Asked to update, it was already on the newest, this version.
        case current(String)
        /// Why it couldn't be updated.
        case failed(String)
    }

    /// As its box says it: under way (whoever asked), how it went until you've seen it, else
    /// whether a newer version is out.
    func updateStatus(_ integration: Integration) -> UpdateStatus? {
        if isAskedToUpdate(integration) { return .updating }
        if let update = integration.programUpdate {
            switch update.state {
            case .updating: return .updating
            case .failed(let message) where !seenUpdates.contains(update.id): return .failed(message)
            case .updated(let version) where !seenUpdates.contains(update.id): return .updated(version)
            case .current(let version) where !seenUpdates.contains(update.id): return .current(version)
            default: break
            }
        }
        let metadata = integration.metadata
        if metadata?["outdated"]?.bool == true, let latest = metadata?["latestVersion"]?.string { return .available(latest) }
        return nil
    }

    /// Why its program's update didn't work, until you've seen it.
    func updateFailure(_ integration: Integration) -> String? {
        if case .failed(let message) = updateStatus(integration) { return message }
        return nil
    }

    func dismissUpdateFailure(_ integration: Integration) {
        seen(integration)
    }

    /// How its update went, seen: its box forgets it, for your other devices too.
    private func seen(_ integration: Integration) {
        guard let update = integration.programUpdate, seenUpdates.insert(update.id).inserted, let api else { return }
        Task { try? await api.sawProgramUpdate(integration.id, at: update.at) }
    }

    /// Updates an agent's program (Claude Code, Codex, Grok's CLI) through the installer that owns
    /// it, on its computer, whose box says how it goes (`programUpdate`); then `refresh`es what
    /// the app shows of it. Throws only when it couldn't be asked.
    func update(_ integration: Integration, then refresh: () async -> Void) async throws {
        guard let api else { throw Failure.notRunning(failure) }
        // Asked already (a second click): once is enough.
        guard !isAskedToUpdate(integration) else { return }
        try await asking([integration], then: refresh) { try await api.updateProgram(integration.id) }
    }

    /// Update All on its computer, as its box picks it from `accounts` (its coding agents as last
    /// read); then `refresh`es what the app shows. Throws only when it couldn't be asked, or (a box
    /// from before `kuvo/updates`) why those that didn't update didn't.
    func updateAll(_ accounts: [Integration], then refresh: () async -> Void) async throws {
        guard let api else { throw Failure.notRunning(failure) }
        // COMPAT(0.7 update-answer): not one being asked already, which a box from before `kuvo/updates` would run twice. Goes 3 months after 0.8.0.
        let accounts = accounts.filter { !isAskedToUpdate($0) }
        try await asking(accounts.filter(\.isInUpdateAll), then: refresh) { try await api.updateAllPrograms(accounts) }
    }

    /// `ask`s the box to update `integrations`' programs, which say they're updating meanwhile;
    /// then `refresh`es, before they say what their box says.
    private func asking(_ integrations: [Integration], then refresh: () async -> Void, _ ask: () async throws -> Void) async throws {
        let programs = Set(integrations.map(Self.program)).subtracting(askedUpdates)
        askedUpdates.formUnion(programs)
        defer { askedUpdates.subtract(programs) }
        do {
            try await ask()
        } catch {
            await refresh()
            throw error
        }
        await refresh()
    }

    /// What updates brought, said once: gone when you leave the page that said it (why one failed
    /// stays until you've seen it). Once for each program, by its agent's own sign-in.
    func forgetUpdates(_ integrations: [Integration]) {
        for integration in integrations where Self.account(integration.id) == nil {
            switch integration.programUpdate?.state {
            case .updated, .current: seen(integration)
            default: break
            }
        }
    }

    /// Agents whose program is installing, by the account it was asked for.
    private(set) var installing: Set<String> = []
    /// Why an install didn't work, until you've seen it.
    var installFailures: [String: String] = [:]
    /// Installed from the first launch after you'd gone on from it: their sign-in, which would
    /// have followed there, opens in Settings › Accounts.
    var signInsAfterInstall: Set<String> = []

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
        guard let api else { throw Failure.notRunning(failure) }
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

nonisolated struct AgentInstall: Decodable, Sendable {
    var installed: Bool
    var version: String?
    /// What went wrong, in the installer's words.
    var message: String?
}

nonisolated private struct AddedAccount: Decodable, Sendable {
    var providerID: String
}

nonisolated extension String {
    /// As one part of a path: "claude-code@1f2e" stays readable, anything else is escaped.
    var pathComponentEscaped: String {
        addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~@"))) ?? self
    }
}

#if DEBUG
extension OutsideAgents {
    /// KUVO_DEMO_BARS: sample bars in the card over `session`'s composer, for a look at it:
    /// `all` a goal, a handoff, a review that found three things and a side question answered (a
    /// full card); `two` the review and the side question.
    func showDemoBars(_ which: String, for session: String) {
        func decode<T: Decodable>(_ json: String) -> T? { try? JSONDecoder().decode(T.self, from: Data(json.utf8)) }
        let started = Date.now.timeIntervalSince1970 * 1000 - 720_000
        reviews[session] = decode(#"{"id":"rev_demo","session":"\#(session)","state":"done","summary":"Two problems in the login changes","findings":[{"id":"f1","title":"The cookie is set after the redirect","explanation":"So the first request has no session.","severity":"bug","locations":[{"file":"src/auth/session.ts","line":42}]},{"id":"f2","title":"The error from fetchUser is swallowed","explanation":"","severity":"risk","locations":[{"file":"src/auth/login.ts","line":18}]},{"id":"f3","title":"The test's name says logout","explanation":"","severity":"nit","locations":[{"file":"test/auth.test.ts"}]}],"fix":"Fix these","started":0}"#)
        let question: SideQuestion? = decode(#"{"id":"btw_demo","session":"\#(session)","question":"Which file sets the cookie?","state":"answered","answer":"`src/auth/session.ts`, in `startSession()`, after the redirect.","asked":0}"#)
        sideQuestions[session] = question.map { [$0] } ?? []
        guard which == "all" else { return }
        goals[session] = decode(#"{"session":"\#(session)","condition":"All tests in test/auth pass","state":"working","started":\#(started),"turns":3,"checking":false}"#)
        handoffs[session] = Handoff(from: session, state: .writing)
    }
}
#endif
