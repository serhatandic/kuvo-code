import AppKit
import OpenCodeKit
import os

/// Owns the engine (the opencode server) and the stores fed by it.
@Observable
final class AppModel {
    enum EngineState: Equatable {
        case preparing
        case downloading(progress: Double)
        case starting
        case ready
        case failed(String)
    }

    private(set) var engine = EngineState.preparing
    private(set) var api: OpenCodeAPI?
    /// False while the live event feed is down (the UI shows it, and re-syncs after).
    private(set) var isLive = false

    /// The login shell's environment (PATH and the like), for the engine and terminals.
    private(set) var shellEnvironment = ProcessInfo.processInfo.environment

    let catalog = Catalog(isMac: true)
    /// The right panel's tools; one window, so one set.
    let utilities = Utilities()
    /// Terminals that are tabs of the window, in place of a conversation; they end with it.
    let mainTerminals = MainTerminals()
    /// What the agent asks you for while it browses: sign-ins, codes, steps only you can do.
    let browserAsks = BrowserAsks()
    /// The panel's browser as MCP tools for the agent.
    @ObservationIgnored private(set) lazy var browserTools = BrowserToolServer(agent: BrowserAgent(utilities: utilities, asks: browserAsks))
    let workspace = Workspace()
    /// The main window's tabs; one window, so one set. Stores open tabs in it, also while the
    /// window is closed.
    @ObservationIgnored private(set) lazy var tabs = WindowTabs(app: self)
    /// Other computers whose engines run over SSH, next to this Mac's.
    let machines = Machines()
    let usage = UsageAccounts()
    /// Bots: named agents with one job each, on this Mac or a machine.
    let bots = Bots()
    /// Bots' and sessions' wake-ups and watches.
    let wakeUps = WakeUps()
    let groups = BotGroups()
    /// Group chats that live on your machines, which their machines run.
    let machineGroups = MachineGroups()
    /// Every group chat, this Mac's and your machines', as the window and the phone show them.
    @ObservationIgnored private(set) lazy var chats = GroupChats(mac: groups, machines: machineGroups)
    /// What this Mac keeps, brought up to date with this version once, as it launches.
    let calibration = Calibration()
    /// Bots and chats moving to another computer.
    let moves = Moves()
    /// Kuvo Code for iPhone's way in (off until it's switched on; see PhoneLink).
    let phoneLink = PhoneLink()
    /// You using Kuvo Code here, told to this Mac's box and your machines, so notices for your
    /// phones wait a little while you are; started with the app.
    @ObservationIgnored private(set) lazy var attention = Attention { [weak self] in
        guard let self, !showsSettings else { return [] }
        return utilities.conversationsOnScreen
    } tell: { [weak self] sessions, shown in
        self?.phoneLink.attend(sessions, shown: shown)
    }
    /// The coding agents you already have (Claude Code, Codex, Cursor, Grok, Antigravity), run by
    /// the agents bridge beside the engine.
    let agents = OutsideAgents()
    /// This Mac's box (`kuvo-link.js serve`), which answers the areas that have moved onto it.
    let box = BoxProcess()
    /// This Mac's projects followed from its box, once started.
    @ObservationIgnored private var projectsFollowed: Task<Void, Never>?
    @ObservationIgnored private var agentsActivation: (any NSObjectProtocol)?
    /// The engine's settings file, for Settings.
    @ObservationIgnored private(set) lazy var engineConfig = EngineConfig(file: engineFolders.configFile)
    /// Machines taking settings changed here, a moment after the last change (`settingsSaved`).
    @ObservationIgnored var settingsSync: Task<Void, Never>?
    /// Engines to start again with new settings once nothing's at work in them: "" for this Mac's,
    /// else a machine's ID (see `renewEngines`).
    @ObservationIgnored var renewals: Set<String> = []
    @ObservationIgnored var renewing: Task<Void, Never>?
    /// Skills added in Settings, beside the settings file: the engine reads them for every project.
    var skillsFolder: URL { engineFolders.configFile.deletingLastPathComponent().appending(path: "skills") }
    /// Brings the main window back (set by the window itself; the usage menu's "Open Kuvo Code").
    var openMainWindow: (() -> Void)?
    /// Opened at login (Open at Login): this Mac's box runs in the background, its engine, bots and
    /// phone link at work, and the window waits until you open Kuvo Code.
    var startedAtLogin = false
    /// A start under way, from launch or from the window: one at a time.
    @ObservationIgnored private var isStarting = false
    /// Settings fill the main window in place of the sessions while this is on.
    var showsSettings = false
    /// Settings › Accounts of `machine` (nil: this Mac): each computer signs in on its own.
    func openAccounts(on machine: String?) {
        openSettings(.accounts, on: SidebarBox(machine: machine))
    }

    /// A conversation carried on with the coding agents (`Workspace.moveToAgents`): a bot's goes on
    /// as the bot's, which keeps it (true); any other's panel goes with it, its terminals, pages
    /// and files as they were.
    func movedToAgents(from old: String, to new: Session) async -> Bool {
        if await bots.movedToAgents(from: old, to: new) { return true }
        utilities.handOver(from: old, to: new.id)
        return false
    }

    /// Settings › Custom Auto of `machine` (nil: this Mac): each has its own lists.
    func openAuto(on machine: String?) {
        openSettings(.auto, on: SidebarBox(machine: machine))
    }
    /// Settings' tabs: the page, and the sites you're signing in to.
    let settingsTabs = SettingsTabs()

    /// Shows Settings in the main window, on `page` of `box` if one is given (otherwise the last
    /// one open).
    func openSettings(_ page: SettingsPage? = nil, on box: SidebarBox = .mac) {
        if let page { settingsTabs.show(page, on: box) }
        if page == .accounts { Analytics.shared.onboardingStep("accounts") }
        #if DEBUG
        let background = ProcessInfo.processInfo.environment["KUVO_DEMO_BACKGROUND"] != nil
        #else
        let background = false
        #endif
        if !background {
            openMainWindow?()
            NSApp.activate()
        }
        showsSettings = true
    }

    /// Something to open from outside the window: a folder dropped on the Dock icon or opened with
    /// Kuvo Code, a pick from the Dock menu, a notification clicked.
    enum Request: Equatable {
        case folder(String)
        /// A session's tab, or any other's by its key (`group:<id>`).
        case session(String)
        case newSession
        /// A shared bot's file, opened in Finder: New Bot, from it.
        case bot(BotRecipe)
    }

    init() {
        // The window's own: where a fork or a move opens, and where the panel adds to a message.
        workspace.tabs = tabs
        utilities.addToMessage = { [weak self] in self?.tabs.addToMessage($0) }
        utilities.attachToMessage = { [weak self] in self?.tabs.attachToMessage($0) }
    }

    /// Shows the main window, with `request` open in it.
    func open(_ request: Request) {
        #if DEBUG
        // A demo copy launched with KUVO_DEMO_BACKGROUND stays behind, so it never takes the keyboard
        // (opening the window activates the app too).
        let background = ProcessInfo.processInfo.environment["KUVO_DEMO_BACKGROUND"] != nil
        #else
        let background = false
        #endif
        if !background {
            openMainWindow?()
            NSApp.activate()
        }
        switch request {
        case .folder(let path): tabs.newSession(in: workspace.addFolder(path))
        case .session(let id): tabs.open(TabKey(id))
        case .newSession: tabs.newSession(in: nil)
        case .bot(let recipe): tabs.openBotEditor(bot: nil, recipe: recipe)
        }
    }

    private(set) var server: ServerProcess?
    private var eventTask: Task<Void, Never>?
    /// When the engine was last started again on its own, after stopping while it ran.
    private var automaticRestarts: [Date] = []
    /// The engine had been running when it failed (it stopped, rather than couldn't start).
    private(set) var engineStoppedWhileRunning = false
    /// This start of the engine, new with each start and each stop: an earlier engine's exit,
    /// coming in late as it stops, isn't taken for this one's, and a start that was stopped or
    /// started over while it waited gives up.
    private var launch = UUID()
    /// The Mac waking from sleep, watched once for the machines (see `startMachines`).
    @ObservationIgnored var wakeWatch: (any NSObjectProtocol)?
    /// Each minute: agents' letters by mail, again until they're there, and this Mac's agents told.
    @ObservationIgnored var mailTick: Task<Void, Never>?
    /// This launch started the engine over once already for getting stuck starting.
    @ObservationIgnored var restartedStuckEngine = false
    private let log = Logger(subsystem: "run.kuvo.code", category: "engine")

    private var engineFolders: EngineFolders {
        EngineFolders(root: AppInfo.supportDirectory.appending(path: "opencode"))
    }

    /// The stores told of each other, and of the machines' engines, once this Mac's engine is up.
    /// Also what the route scenarios run with (RouteContractTests).
    func wireStores() {
        workspace.boxes = { [weak self] id in self?.box(id) }
        workspace.machineAPI = { [weak self] machine in self?.machines.engine(machine)?.api }
        workspace.machineAgents = { [weak self] machine in self?.machines.engine(machine)?.agents }
        bots.app = self
        wakeUps.app = self
        groups.app = self
        machineGroups.app = self
        moves.app = self
        workspace.onMovedToAgents = { [weak self] from, to in await self?.movedToAgents(from: from, to: to) ?? false }
        workspace.runsOnAgents(bots.agentSessionIDs)
        workspace.botSessions = bots.sessionIDs
        workspace.runsOnAgents(groups.agentSeatIDs.union(machineGroups.agentSeatIDs))
        workspace.seats = groups.seatIDs.union(machineGroups.seatIDs)
    }

    /// What a phone's request reaches on this Mac (`PhoneLink`): its stores, as they are now, and
    /// what it does with them. Also what the route scenarios run against (RouteContractTests).
    func wirePhoneLink() {
        phoneLink.readyMachines = { [weak self] in self?.machines.engines.values.filter(\.isReady) ?? [] }
        // With machines, this Mac meets them at the relay, phone or not.
        phoneLink.hasMachines = { [weak self] in !(self?.machines.list.isEmpty ?? true) }
        phoneLink.movedSessions = { [weak self] in self?.moves.livePlaces ?? [:] }
        Machines.linkKey = { [weak self] in self?.phoneLink.macKey }
        phoneLink.bots = bots
        phoneLink.wakeUps = wakeUps
        phoneLink.browserAsks = browserAsks
        phoneLink.groups = chats
        phoneLink.workspace = workspace
        phoneLink.machineName = { [weak self] id in self?.machines.list.first { $0.id == id }?.name }
        phoneLink.agents = agents
        phoneLink.endedSignIns = { [weak self] in self?.catalog.endedProviders ?? [] }
        phoneLink.forgetSignIn = { [weak self] provider in
            // One of your plans, as Settings › Accounts lists them; never an integration's server.
            guard let self, catalog.integrations.contains(where: { $0.id == provider && !$0.isMCP }) else { return false }
            forgetSignIn(provider)
            return true
        }
        phoneLink.isMoving = { [weak self] id in self?.moves.underWay[id] != nil || Moves.isFrozen(id) }
        phoneLink.engineConfig = engineConfig
        phoneLink.engineStarted = { [weak self] in self?.engineStarted }
        phoneLink.restartEngine = { [weak self] in Task { await self?.restart() } }
    }

    /// Puts the usage panel in the menu bar. It reads the engine's database for spend, so it
    /// starts with the app, not with the engine.
    func startUsage() {
        usage.start(engineData: engineFolders.dataDirectory) { [weak self] in
            self?.openMainWindow?()
        }
    }

    /// The engine this Mac runs (KUVO_OPENCODE_BINARY's, or the one installed), once it has started.
    private(set) var engineBinary: URL?
    /// When the engine running now came up, for a phone to tell it from the one before a restart.
    @ObservationIgnored private(set) var engineStarted: Date?

    /// A macOS prompt is on screen, like "would like to access files in your Desktop folder":
    /// those come from UserNotificationCenter, whose windows show only while it asks.
    static var systemPromptShowing: Bool {
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return windows.contains { $0[kCGWindowOwnerName as String] as? String == "UserNotificationCenter" }
    }

    private var installer: EngineInstaller {
        EngineInstaller(root: AppInfo.supportDirectory.appending(path: "engine"))
    }

    /// Downloads the engine if needed, starts it, and connects the stores. At launch, whether or
    /// not the window opens (this Mac is a box of its own, at work in the background too).
    func start() async {
        // Already on its way (restart stops it first).
        switch engine {
        case .ready, .starting, .downloading: return
        case .preparing, .failed: break
        }
        // Asked twice before the first got as far as saying so (launch, and the window opening).
        guard !isStarting else { return }
        isStarting = true
        defer { isStarting = false }
        // What you keep here, up to date with this version (once, after an update), before the
        // engine starts.
        await calibration.run(self)
        let launch = UUID()
        self.launch = launch
        engineStoppedWhileRunning = false
        // How far it got, for analytics when it fails: the download, the launch, or the connection.
        var stage = "download"
        let began = SuspendingClock.now
        var downloaded = false
        do {
            // Set KUVO_OPENCODE_BINARY to run a local opencode build instead of the pinned download.
            async let environment = ShellEnvironment.load()
            let binary: URL
            if let override = ProcessInfo.processInfo.environment["KUVO_OPENCODE_BINARY"] {
                binary = URL(filePath: override)
            } else if let installed = await Task.detached(operation: { [installer] in installer.installed() }).value {
                // Checking its signature reads all of it, a second or so: off the main thread.
                binary = installed
            } else {
                engine = .downloading(progress: 0)
                downloaded = true
                binary = try await installer.install { progress in
                    Task { @MainActor in
                        if case .downloading = self.engine { self.engine = .downloading(progress: progress) }
                    }
                }
                // Stopped, or started over, while it waited: the newer start carries on.
                guard launch == self.launch else { return }
            }

            engineBinary = binary
            engine = .starting
            stage = "launch"
            var shell = await environment
            guard launch == self.launch else { return }
            shellEnvironment = shell
            // Bots' wake-up command, by name, and where their folders are; and the launcher
            // integrations' servers run with.
            try? Launcher.install(in: Bots.command.deletingLastPathComponent(), engine: binary)
            shell["PATH"] = Bots.command.deletingLastPathComponent().path + ":" + (shell["PATH"] ?? "/usr/bin:/bin")
            shell["KUVO_BOTS"] = Bots.root.path
            shell["KUVO_WAKES"] = WakeUps.root.path
            // Keys you brought for integrations, in the files their settings name with {file:…}
            // (not the engine's environment, where the agent's commands would see them), and a
            // folder for what their servers keep (a sign-in).
            #if DEBUG
            // KUVO_DEMO_INTEGRATION_KEY=<id>|<NAME>|<value>: saves that key as Add Key… does
            // (no value removes it).
            if let spec = ProcessInfo.processInfo.environment["KUVO_DEMO_INTEGRATION_KEY"] {
                let parts = spec.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
                if parts.count == 3 { IntegrationKeys.set(parts[2], for: IntegrationKeys.variable(parts[0], parts[1])) }
            }
            #endif
            // Read off the main thread: the keychain can wait on you (a prompt to allow it).
            await Task.detached { IntegrationKeys.writeFiles() }.value
            IntegrationKeys.keepFresh()
            let integrations = AppInfo.supportDirectory.appending(path: "integrations")
            try? FileManager.default.createDirectory(at: integrations, withIntermediateDirectories: true)
            shell["KUVO_INTEGRATIONS"] = integrations.path
            // The settings file as it is now (it can change while the engine is down), with web
            // search that works unless it chose otherwise.
            engineConfig.addDefaults()
            Integrations.upgrade(engineConfig)
            MCPCatalog.upgrade(engineConfig)
            MCPSettings.upgrade(engineConfig)
            // What some providers need until opencode handles it (see ProviderCompatibility).
            let compatibility = ProviderCompatibility.config
            if !compatibility.isEmpty { shell["OPENCODE_CONFIG_CONTENT"] = Self.merged(compatibility, into: shell["OPENCODE_CONFIG_CONTENT"]) }
            // The browser tools, for the engine to connect to. Without them the agent
            // still works, just without the browser.
            do {
                _ = try await browserTools.start()
                if let config = browserTools.engineConfig { shell["OPENCODE_CONFIG_CONTENT"] = Self.merged(config, into: shell["OPENCODE_CONFIG_CONTENT"]) }
                agents.toolServer = browserTools.agentsServer
                browserTools.owner = { [weak self] id in await self?.workspace.engineRunOwner(id) }
            } catch {
                log.error("Browser tools didn't start: \(error.localizedDescription, privacy: .public)")
            }
            guard launch == self.launch else { return }
            let server = try await ServerProcess.start(
                executable: binary,
                folders: engineFolders,
                environment: shell,
                onExit: { status in Task { @MainActor in self.engineExited(status: status, launch: launch) } }
            )
            guard launch == self.launch else {
                server.stop()
                return
            }
            self.server = server
            stage = "connect"
            let api = OpenCodeAPI(endpoint: server.endpoint)
            try await waitUntilReady(api)
            // It stopped (and said why), or was stopped, while it loaded.
            guard launch == self.launch else { return }
            self.api = api
            catalog.api = api
            // An engine stuck starting (one of its own fetches never ended) is started over, once
            // a launch: after that, a stall is left to show. Not while macOS asks you something
            // (access to a folder the engine reads): it waits on your answer, and starting it over
            // would only take the prompt away and ask again. The catalog fills once it's answered.
            catalog.onStalled = { [weak self] in
                guard let self, !restartedStuckEngine, !Self.systemPromptShowing else { return }
                restartedStuckEngine = true
                Analytics.shared.track("engine_failed", ["reason": "stalled"])
                Task { await self.restart() }
            }
            Analytics.shared.catalog = catalog
            workspace.api = api
            wireStores()
            // A move cut short (the app quit) is finished or taken back.
            Task { await moves.recover() }
            // Bots' keys of their own, in their folders' settings as integrations are now.
            Task { await BotKeys.applyAll(on: nil, app: self) }
            usage.api = api
            engineStarted = .now
            engine = .ready
            #if DEBUG
            E2E.note(server.endpoint)
            #endif
            wirePhoneLink()
            phoneLink.start(endpoint: server.endpoint)
            // This Mac's box finds the engine as a machine's does, and starts once.
            BoxProcess.engineChanged(server.endpoint, version: OpenCodeEngine.version, pid: server.processID)
            let boxEnvironment = shell
            Task {
                await box.start(engine: binary, environment: boxEnvironment)
                // Its projects, as this Mac's box keeps them, from now on.
                if projectsFollowed == nil { projectsFollowed = Task { await workspace.followProjects() } }
            }
            Analytics.shared.trackOnce("engine_ready", ["seconds": Int((SuspendingClock.now - began).components.seconds), "downloaded": downloaded])
            listen(to: api)
            agents.engineEndpoint = server.endpoint
            startAgents(engine: binary)
            Task { await usage.sync() }
            // In parallel: the catalog can wait on the engine's plugins (and they on a
            // macOS permission prompt); sessions shouldn't wait with it.
            async let catalogLoaded: Void = catalog.refresh()
            async let workspaceLoaded: Void = workspace.refresh()
            // Machines start once this Mac's engine is up (they get its accounts and settings),
            // without waiting on its catalog.
            await workspaceLoaded
            guard launch == self.launch else { return }
            startMachines()
            bots.startWaking()
            groups.startMeetings()
            groups.resumeWork()
            await catalogLoaded
        } catch {
            // Stopped, or started over, meanwhile.
            guard launch == self.launch else { return }
            // One that stopped while it loaded says so, with what it wrote, rather than that it
            // can't be reached.
            var reason = error.localizedDescription
            if let server {
                let output = String(server.recentOutput.trimmingCharacters(in: .whitespacesAndNewlines).suffix(600))
                if let status = server.exitStatus {
                    reason = ServerProcessError.exited(status: status, output: output).localizedDescription
                } else if !output.isEmpty {
                    reason += "\n\n" + output
                }
            }
            log.error("Engine failed to start: \(reason, privacy: .public)")
            Analytics.shared.track("engine_failed", ["reason": stage, "kind": EngineInstallError.kind(of: error)])
            // Nothing is left running (a server that never got ready is stopped). A start after an
            // automatic restart failing means the engine stopped.
            stop()
            automaticRestarts.removeAll { $0 < .now.addingTimeInterval(-300) }
            engineStoppedWhileRunning = !automaticRestarts.isEmpty
            engine = .failed(reason)
            workspace.macEngineStopped()
        }
    }

    /// An account you signed in to again, or switched to another of: Custom Auto tries it again,
    /// here and on your machines (each holds its own limits).
    func releaseLimit(_ provider: String) {
        Task {
            await agents.releaseLimit(provider)
            for engine in machines.engines.values where engine.isReady { await engine.agents.releaseLimit(provider) }
        }
    }

    /// The agents bridge, with the engine's Bun, once: it goes on through the engine's restarts.
    private func startAgents(engine binary: URL) {
        workspace.agents = agents
        catalog.outsideAgents = agents
        usage.follow(catalog)
        agents.onEvent = { [weak self] event in
            self?.catalog.handle(event)
            self?.workspace.handleAgents(event)
        }
        agents.onStopped = { [weak self] in
            self?.catalog.forgetAgents()
            self?.workspace.agentsStopped()
        }
        agents.onConnected = { [weak self] in
            Task {
                await self?.catalog.refreshAgents()
                await self?.workspace.refreshAgents()
            }
        }
        var environment = shellEnvironment
        // Bots' wake-up command by name, and where their folders are, for their sessions with the
        // coding agents too, as the engine's commands have them.
        let bin = Bots.command.deletingLastPathComponent().path
        environment["PATH"] = bin + ":" + (environment["PATH"] ?? "/usr/bin:/bin")
        environment["KUVO_BOTS"] = Bots.root.path
        environment["KUVO_WAKES"] = WakeUps.root.path
        environment["KUVO_BIN"] = bin
        Task { await agents.start(engine: binary, environment: environment) }
        // Back in the app, you may have installed an agent or signed in to one in Terminal.
        if agentsActivation == nil {
            agentsActivation = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.catalog.refreshAgentsIfStale() }
            }
        }
    }

    /// `config` merged over any inline config already in the environment.
    static func merged(_ config: [String: Any], into existing: String?) -> String {
        var base = existing.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] } ?? [:]
        func merge(_ new: [String: Any], into old: inout [String: Any]) {
            for (key, value) in new {
                if let value = value as? [String: Any], var current = old[key] as? [String: Any] {
                    merge(value, into: &current)
                    old[key] = current
                } else {
                    old[key] = value
                }
            }
        }
        merge(config, into: &base)
        // Sorted, so the same settings read the same each time (a machine's engine is started
        // over when what it started with reads differently).
        let data = (try? JSONSerialization.data(withJSONObject: base, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    func restart() async {
        stop()
        engine = .preparing
        await start()
    }

    func stop() {
        // A start still on its way gives up, and the stopped engine's exit is expected.
        launch = UUID()
        #if DEBUG
        E2E.forget()
        #endif
        eventTask?.cancel()
        eventTask = nil
        server?.stop()
        server = nil
        BoxProcess.engineChanged(nil, version: nil, pid: nil)
        api = nil
        isLive = false
        phoneLink.stop()
    }

    #if DEBUG
    /// For tests: this Mac's engine is the one at `api`, as if it had started (no feed, nothing
    /// else connected to it). Its stores are told of each other as a start tells them, in the
    /// same step: without, a machine's bots steps (its kit, the bots it made) would do nothing.
    func standIn(engine api: OpenCodeAPI) {
        self.api = api
        wireStores()
    }
    #endif

    /// The server answers 503 until it has loaded.
    private func waitUntilReady(_ api: OpenCodeAPI) async throws {
        let deadline = ContinuousClock.now + .seconds(60)
        while true {
            do {
                _ = try await api.info()
                return
            } catch let error as ServerError where error.status == 503 {
                if ContinuousClock.now > deadline { throw error }
                try await Task.sleep(for: .milliseconds(150))
            }
        }
    }

    private func listen(to api: OpenCodeAPI) {
        eventTask = Task { [weak self] in
            for await update in api.events.updates() {
                guard let self else { return }
                switch update {
                case .connected:
                    // Missed events aren't replayed: re-read everything on screen.
                    let wasLive = isLive
                    isLive = true
                    if !wasLive {
                        await catalog.refresh()
                        await workspace.resync()
                    }
                case .disconnected:
                    isLive = false
                case .event(let event):
                    // The file changed, here or elsewhere: show what it says now.
                    if event.type == "config.updated" { engineConfig.reload() }
                    // An account or sign-in added, renewed or switched to here reaches the machines.
                    if event.type == "credential.updated" || event.type == "credential.switched" { syncSignIns() }
                    catalog.handle(event)
                    workspace.handle(event)
                    usage.handle(event)
                }
            }
        }
    }

    private func engineExited(status: Int32, launch: UUID) {
        // One stopped (for a restart, or as the app quits) exits a moment later, after the stop.
        guard launch == self.launch else { return }
        // One still starting fails `start` as it stops (its handshake or first call does), which
        // says why with what it wrote.
        guard engine == .ready else { return }
        let output = server?.recentOutput.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        log.error("Engine exited with status \(status): \(output, privacy: .public)")
        stop()
        // It's started again, as it was, unless it has stopped like this a few times in the last
        // minutes: then it's for you to see why.
        automaticRestarts.removeAll { $0 < .now.addingTimeInterval(-300) }
        if automaticRestarts.count < 3 {
            automaticRestarts.append(.now)
            Task { await restart() }
            return
        }
        engineStoppedWhileRunning = true
        engine = .failed("It stopped unexpectedly (exit code \(status)), and again after starting over.\(output.isEmpty ? "" : "\n\n" + String(output.suffix(600)))")
        workspace.macEngineStopped()
    }
}

