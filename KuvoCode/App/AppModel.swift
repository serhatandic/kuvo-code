import AppKit
import ClientNews
import ClientSessions
import KuvoVoice
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

    private(set) var engine = EngineState.preparing {
        didSet {
            if engine == .ready { engineWentDown = false } else if case .failed = engine { engineWentDown = true }
        }
    }
    /// It stopped after running, or couldn't start, and isn't back yet (starting over by itself or
    /// from Try Again meanwhile): what needs it, like a sign-in, can't work until it is.
    var engineIsDown: Bool {
        #if DEBUG
        // KUVO_DEMO_ENGINE_STOPPED: said stopped over the accounts, for a look at it.
        if ProcessInfo.processInfo.environment["KUVO_DEMO_ENGINE_STOPPED"] != nil { return true }
        #endif
        return engineWentDown && engine != .ready
    }
    private var engineWentDown = false
    private(set) var api: OpenCodeAPI?
    /// False while the live event feed is down (the UI shows it, and re-syncs after).
    private(set) var isLive = false

    /// The login shell's environment (PATH and the like), for the engine and terminals.
    private(set) var shellEnvironment = ProcessInfo.processInfo.environment

    let catalog = Catalog()
    /// The right panel's tools; one window, so one set.
    let utilities = Utilities()
    /// What the agent asks you for while it browses: sign-ins, codes, steps only you can do.
    let browserAsks = BrowserAsks()
    /// The panel's browser as MCP tools for the agent.
    @ObservationIgnored private(set) lazy var browserTools: BrowserToolServer = {
        browserAsks.isOnAutopilot = { [weak workspace] id in workspace?.isOnAutopilot(id) == true }
        workspace.autopilotMayHaveChanged = { [weak browserAsks] in browserAsks?.leaveUndone() }
        return BrowserToolServer(agent: BrowserAgent(utilities: utilities, asks: browserAsks))
    }()
    let workspace = Workspace()
    /// What each box says it has (`kuvo/info`'s `features`): the app's one reader of them
    /// (`Workspace.features`), which tells the update gate what each says.
    var boxFeatures: BoxFeatures { workspace.features }
    /// The main window's tabs; one window, so one set. Stores open tabs in it, also while the
    /// window is closed.
    @ObservationIgnored private(set) lazy var tabs = WindowTabs(app: self)
    /// Other computers whose engines run over SSH, next to this Mac's.
    let machines = Machines()
    let usage = UsageAccounts()
    /// Each box's plan limits, one row per login in the usage panel.
    let planLimits = BoxPlanLimits()
    /// What your accounts used, as this Mac's box states it, for the usage panel.
    let usageHistory = BoxUsageHistory()
    /// Bots: named agents with one job each, on this Mac or a machine.
    let bots = Bots()
    /// Bots' and sessions' wake-ups and watches.
    let wakeUps = WakeUps()
    /// What sessions' rows on screen show beyond the sessions: their pull requests, branches and
    /// accounts, as their boxes say.
    let glances = RowGlances()
    /// The sessions bots run, as their boxes tell it.
    let botWork = BotWork()
    /// What bots ask you before they do it (making a project), on every box.
    let botAsks = BotAsks()
    let goalPlans = GoalPlans()
    /// What each box told you lately, shown as this Mac's notifications.
    let boxNotices = BoxNotices()
    let botOversight = BotOversight()
    let workQueues = WorkQueues()
    /// Voice input, for whichever composer listens.
    let dictation = Dictation()
    // COMPAT(0.7 mac-group-chats): `GroupMigration.run` before the box's group chats start. Goes 3 months after 0.8.0.
    /// Your group chats, wherever they live: each computer's coding agents' bridge runs its own,
    /// this Mac's too (what an older version kept here moves into it first, `GroupMigration`).
    let boxGroups: BoxGroups = {
        GroupMigration.run()
        return BoxGroups()
    }()
    /// Every group chat, as the window shows them.
    @ObservationIgnored private(set) lazy var chats = GroupChats(boxes: boxGroups)
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
    /// The first launch: the bots while it gets ready, your subscriptions, screen access. Not for
    /// a copy that's run before, and not for tests, demos and measurements (they start where they
    /// say; `KUVO_DEMO_ONBOARDING` shows it).
    let onboarding = Onboarding(launchedBefore: AppInfo.isHostingTests || !Analytics.shared.isFirstLaunch
        || ProcessInfo.processInfo.environment.keys.contains { $0.hasPrefix("KUVO_DEMO_") || $0.hasPrefix("KUVO_PERF_") || $0 == "KUVO_E2E" })
    /// This Mac's box (`kuvo-link.js serve`), which answers the areas that have moved onto it.
    let box = BoxProcess()
    /// What this Mac's box asks the app for (your Keychain's keys).
    let host = HostInterface()
    /// This Mac's worktrees and projects followed from its box, once started.
    @ObservationIgnored private var boxFollowed: Task<Void, Never>?
    @ObservationIgnored private var agentsActivation: (any NSObjectProtocol)?
    /// This Mac's bridge connected before the stores were told of each other: its group chats
    /// are read once they are.
    @ObservationIgnored private var chatsWaitForStores = false
    /// Your time zone and how you write dates, followed for this Mac's group chats.
    @ObservationIgnored private var clockObservers: [any NSObjectProtocol] = []
    /// This Mac's engine settings, for Settings, as its box keeps them (in the engine's settings
    /// file, where they've always been).
    @ObservationIgnored private(set) lazy var engineConfig = EngineConfig(remote: BoxSettings(client: box(BoxClient.mac)), file: engineFolders.configFile)
    /// This Mac's settings being read (`prepareSettings`).
    @ObservationIgnored private var settingsPreparation: Task<Void, Never>?
    /// Engines to start again with new settings once nothing's at work in them: "" for this Mac's,
    /// else a machine's ID (see `renewEngines`).
    @ObservationIgnored var renewals: Set<String> = []
    @ObservationIgnored var renewing: Task<Void, Never>?
    /// Brings the main window back (set by the window itself; the usage menu's "Open Kuvo Code").
    var openMainWindow: (() -> Void)?
    /// Opened at login (Open at Login): this Mac's box runs in the background, its engine, bots and
    /// phone link at work, and the window waits until you open Kuvo Code.
    var startedAtLogin = false
    /// The start under way, from launch or from the window: one at a time. A stop gives it up
    /// (`stop`), so a start after it (a restart, the engine started again after it stopped while
    /// its start was still finishing) isn't turned away by it.
    @ObservationIgnored private var starting: UUID?
    /// Settings fill the main window in place of the sessions while this is on.
    var showsSettings = false
    /// Settings › Machines opens on Add a Machine, asked for from outside it (the sidebar's
    /// computers).
    var addsMachine = false
    /// Help › Report a Problem…'s sheet, over the main window.
    var showsProblemReport = false
    /// What's New: the highlights over the main window, once after an update or from Help.
    var whatsNew: WhatsNew.Release?
    /// What this copy carries of what's new, and its "New" marks (kept by this app).
    let newMarks: NewMarks
    /// This release's highlights to show once the window is up, as the app opened.
    @ObservationIgnored private var newAfterLaunch: WhatsNew.Release?
    @ObservationIgnored private var lookedForWhatsNew = false


    /// As the window first shows: this release's highlights, after an update to it.
    func whatsNewAfterLaunch() {
        guard !lookedForWhatsNew else { return }
        lookedForWhatsNew = true
        // Not over a demo, a test or a measurement, which never ask to be shown it; nor in place
        // of Help › What's New, picked while the first launch's steps showed.
        let scripted = ProcessInfo.processInfo.environment.keys.contains { $0.hasPrefix("KUVO_DEMO_") || $0.hasPrefix("KUVO_PERF_") || $0 == "KUVO_E2E" }
        if !scripted, let shown = newAfterLaunch { whatsNew = shown }
        newAfterLaunch = nil
        #if DEBUG
        // KUVO_DEMO_WHATS_NEW: the sheet, for a look at it.
        if ProcessInfo.processInfo.environment["KUVO_DEMO_WHATS_NEW"] != nil { whatsNew = newMarks.news?.latestHighlights }
        #endif
    }

    /// Help › What's New: this release's highlights, or the last ones a release had; every
    /// release's notes, for a copy that carries none.
    func showWhatsNew() {
        guard let news = newMarks.news, let release = news.release(of: AppInfo.version).flatMap({ $0.highlights.isEmpty ? nil : $0 }) ?? news.latestHighlights else {
            NSWorkspace.shared.open(AppInfo.releases)
            return
        }
        openMainWindow?()
        NSApp.activate()
        whatsNew = release
    }
    /// Help › Report a Problem…: its sheet, over the main window, opened if it was closed.
    func reportProblem() {
        openMainWindow?()
        NSApp.activate()
        showsProblemReport = true
    }
    /// Settings › Accounts of `machine` (nil: this Mac): each computer signs in on its own.
    func openAccounts(on machine: String?) {
        openSettings(.accounts, on: machine.map(SidebarBox.machine) ?? thisMacsBox)
    }

    /// A conversation carried on with the coding agents (`Workspace.moveToAgents`): its panel goes
    /// with it, its terminals, pages and files as they were. (A bot's is carried by its box.)
    func movedToAgents(from old: String, to new: String) async -> Bool {
        utilities.handOver(from: old, to: new)
        return false
    }

    /// Settings › Custom Auto of `machine` (nil: this Mac): each has its own lists.
    func openAuto(on machine: String?) {
        openSettings(.auto, on: machine.map(SidebarBox.machine) ?? thisMacsBox)
    }
    /// Settings' tabs: the page, and the sites you're signing in to.
    let settingsTabs = SettingsTabs()

    /// Shows Settings in the main window, on `page` of `box` if one is given (otherwise the last
    /// one open).
    func openSettings(_ page: SettingsPage? = nil, on box: SidebarBox? = nil) {
        if let page { settingsTabs.show(page, on: box ?? thisMacsBox) }
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

    /// `launch`: how the app opened (it had opened before; its version), for What's New, looked for
    /// at once, before a first launch's steps: one quit partway through them (macOS's Quit & Reopen
    /// for Screen Recording) was still the first, and the next isn't an update. None in tests.
    init(newMarks: NewMarks = NewMarks(news: WhatsNew.bundled(), memory: NewsMemory()),
         launch: (ranBefore: Bool, version: String)? = AppInfo.isHostingTests ? nil : (!Analytics.shared.isFirstLaunch, AppInfo.version)) {
        self.newMarks = newMarks
        if let launch { newAfterLaunch = newMarks.memory.afterLaunch(newMarks.news, version: launch.version, ranBefore: launch.ranBefore) }
        // The window's own: where a fork or a move opens, and where the panel adds to a message.
        workspace.tabs = tabs
        utilities.addToMessage = { [weak self] in self?.tabs.addToMessage($0) }
        utilities.attachToMessage = { [weak self] in self?.tabs.attachToMessage($0) }
        // Before the window can show a conversation, which it does at launch before this Mac's
        // sessions are read: a subagent shows in the session that started it, a group chat's seat
        // in its chat, and each conversation has its own panel (a bot's session's is the bot's, and
        // a seat's or a subagent's is where it shows).
        utilities.shownIn = { [weak self] session in
            guard let self else { return session }
            if let group = chats.group(seat: session) { return BotGroups.tabKey(group.id) }
            return workspace.root(of: session)
        }
        utilities.panelOf = { [weak self] session in
            guard let self else { return session }
            let shown = utilities.shownIn(session)
            return bots.bot(forSession: shown)?.id ?? shown
        }
        // This Mac's box up (at the engine's start, late, or again): its settings read.
        box.onStarted = { [weak self] in Task { await self?.prepareSettings() } }
        // Hold ⇧⌘Space to talk instead of typing; Whisper, once it's downloaded, kept with the app's data.
        if !AppInfo.isHostingTests { dictation.installShortcut() }
        SpeechModel.shared.use(folder: AppInfo.supportDirectory.appending(path: "Speech", directoryHint: .isDirectory))
        #if DEBUG
        // `download` starts the real one, as voice input's first use does.
        if let sample = ProcessInfo.processInfo.environment["KUVO_DEMO_WHISPER"] {
            if sample == "download" { SpeechModel.shared.download() } else { SpeechModel.shared.showSample(sample) }
        }
        #endif
    }

    /// Shows the main window, with `request` open in it.
    func open(_ request: Request) {
        showWindow()
        switch request {
        case .folder(let path): tabs.newSession(in: workspace.addFolder(path))
        case .session(let id): openFresh(TabKey(id))
        case .newSession: tabs.newSession(in: nil)
        case .bot(let recipe): tabs.openBotEditor(bot: nil, recipe: recipe)
        }
    }

    /// A conversation opened from inside `origin`, the one a view is in (`conversationTab`): in its
    /// place, with the way back to it (`WindowTabs.go`). With ⌘ held (`newTab`), or its menu's
    /// Open in New Tab, in a tab of its own next to the one in view instead, as in Safari and the
    /// Finder. From no conversation, as from outside.
    func open(_ key: TabKey, from origin: TabKey?, newTab: Bool = AppModel.wantsNewTab(NSApp.currentEvent)) {
        guard origin != nil else {
            showWindow()
            return openFresh(key)
        }
        guard !newTab else { return openFresh(key) }
        tabs.go(to: key, from: origin)
    }

    /// The click (or key) that opens something asks for a tab of its own: ⌘ is held.
    static func wantsNewTab(_ event: NSEvent?) -> Bool {
        guard let event, [.leftMouseUp, .leftMouseDown, .keyDown].contains(event.type) else { return false }
        return event.modifierFlags.contains(.command)
    }

    /// From outside the conversations (a notification, the menu bar): no way back.
    private func openFresh(_ key: TabKey) {
        tabs.open(key)
        tabs.startFresh(key)
    }

    /// The main window in front, unless a demo copy keeps to the background.
    private func showWindow() {
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
    }

    private var eventTask: Task<Void, Never>?
    /// The engine had been running when it failed (it stopped, rather than couldn't start).
    private(set) var engineStoppedWhileRunning = false {
        didSet { if engineStoppedWhileRunning { engineWentDown = true } }
    }
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

    /// This Mac's engine's folders (its box keeps its settings and reads its skills there too: `BoxProcess`).
    nonisolated static var engineFolders: EngineFolders {
        EngineFolders(root: AppInfo.supportDirectory.appending(path: "opencode"))
    }
    private var engineFolders: EngineFolders { Self.engineFolders }

    /// The stores told of each other, and of the machines' engines, once this Mac's engine is up.
    /// Also what the route scenarios run with (RouteContractTests).
    func wireStores() {
        workspace.boxes = { [weak self] id in self?.box(id) }
        // The update gate (#679): a box found older than this app needs, as it says what it has,
        // is held; let go, it's read again.
        usageHistory.settings.features = boxFeatures
        boxFeatures.onSaid = { [weak self] box, features in
            guard let self else { return }
            machines.gates.said(box, features: features, name: BoxClient.isThisMac(box) ? "this Mac" : machines.engine(box)?.machine.name ?? box)
        }
        workspace.isHeld = { [weak self] box in self?.machines.gates.state(of: box) != nil }
        machines.gates.onLetGo = { [weak self] box in
            self?.workspace.boxUpdated(box)
            // This Mac's own box, up to date now: the app registers there (again), as it held off
            // while the box couldn't say what it has.
            if box == SSHConnection.thisMac, self?.attachedIsOwnBox == true { Task { await self?.registerWithOwnBox() } }
        }
        BoxClient.routes = { [weak self] id in self?.box(id) ?? .unwired(id) }
        // Your personalities, one library on every computer, kept by this Mac's box. However one
        // changed there (here, from a phone, taken from a machine's copy), the machines take it,
        // and this Mac's bots with it are told what it is now, by its box.
        Personalities.shared.box = { [weak self] in self?.box(BoxClient.thisMac) }
        Personalities.shared.onChange = { [weak self] _ in self?.personalitiesChanged() }
        workspace.machineAPI = { [weak self] machine in self?.machines.engine(machine)?.api }
        workspace.machineAgents = { [weak self] machine in self?.machines.engine(machine)?.agents }
        bots.app = self
        wakeUps.app = self
        glances.boxes = { [weak self] id in self?.box(id) }
        botWork.app = self
        botAsks.app = self
        botAsks.onChange = { [weak self] sessions in self?.workspace.askingForWork = sessions }
        Sandboxes.shared.onChange = { [weak self] sessions in self?.workspace.askingOutsideSandbox = sessions }
        Sandboxes.shared.onYours = { [weak self] id in self?.workspace.reviewLeftForYou(id) }
        Sandboxes.shared.onOver = { [weak self] id in self?.workspace.reviewOver(id) }
        Sandboxes.shared.onListed = { [weak self] ids in self?.workspace.reviewsListed(ids) }
        goalPlans.app = self
        botOversight.app = self
        workQueues.app = self
        boxNotices.app = self
        workspace.boxTellsNews = { [weak self] box in self?.boxNotices.tells(box) ?? false }
        boxGroups.boxTellsNews = { [weak self] box in self?.boxNotices.tells(box) ?? false }
        ServiceIcons.shared.boxes = { [weak self] box in self?.goalPlans.client(box) }
        goalPlans.onChange = { [weak self] sessions in self?.workspace.goalCards = sessions }
        boxGroups.app = self
        moves.app = self
        // What this Mac's box says is moving, as it changes.
        Task { [moves] in await moves.follow() }
        // This Mac's bridge connected before now, when its group chats couldn't be read: read now,
        // after what's moving there (a chat moving away isn't taken for gone).
        if chatsWaitForStores {
            chatsWaitForStores = false
            Task { [moves, boxGroups] in
                await moves.reload(BoxClient.thisMac)
                await boxGroups.connected(nil)
            }
        }
        workspace.onMovedToAgents = { [weak self] from, to in await self?.movedToAgents(from: from, to: to) ?? false }
        workspace.onBotToAgents = { [weak self] id, model in try await self?.bots.moveToAgents(session: id, model: model) }
        workspace.runsOnAgents(bots.agentSessionIDs)
        workspace.botSessions = bots.sessionIDs
        workspace.runsOnAgents(boxGroups.agentSeatIDs)
        // COMPAT(0.7 mac-group-chats): seats `GroupMigration` took out of chats, kept out of the lists. Goes 3 months after 0.8.0.
        // Seats an older version left on machines too, until they're gone there.
        workspace.seats = boxGroups.seatIDs.union(GroupMigration.orphanSeats)
    }

    /// What a phone's request reaches on this Mac (`PhoneLink`): its stores, as they are now, and
    /// what it does with them. Also what the route scenarios run against (RouteContractTests).
    func wirePhoneLink() {
        phoneLink.readyMachines = { [weak self] in self?.machines.engines.values.filter(\.isReady) ?? [] }
        // With machines, this Mac meets them at the relay, phone or not.
        phoneLink.hasMachines = { [weak self] in self.map { !$0.machines.list.isEmpty || $0.machines.fileDidntRead } ?? false }
        // (Attached in place to a machine's box, the app has no link of its own (the box here keeps
        // its own), so it's on no machine's bridge to leave; to this Mac's own box, moved, its key is
        // that box's.)
        Machines.linkKey = { [weak self] in self.flatMap { $0.attached == nil || $0.attachedIsOwnBox ? $0.phoneLink.macKey : nil } }
        // This Mac's box, moved into a home of its own: its key, as it says (its keys are its own).
        phoneLink.boxKey = { [weak self] in self?.attached?.box.flatMap { $0.kind == "mac" ? $0.key : nil } }
        // Attached in place to any box, the app reads none of this Mac's keys and makes none (#689):
        // they're that box's, or (a machine's set up here) none of the app's to use there.
        phoneLink.keysOnBox = { [weak self] in self?.attached != nil || OwnBoxHome.hasMoved }
        phoneLink.bots = bots
        phoneLink.browserAsks = browserAsks
        phoneLink.workspace = workspace
        phoneLink.machineName = { [weak self] id in self?.machines.list.first { $0.id == id }?.name }
        phoneLink.agents = agents
        // Agents writing to each other, and what an earlier Kuvo Code kept of their letters, to
        // this Mac's box before its link meets your other computers (it starts before the machines).
        AgentMail.shared.app = self
        AgentMail.shared.box = { [weak self] in self?.box(BoxClient.thisMac) }
        // COMPAT(beta.1 mac-letters): letters an earlier Kuvo Code kept, handed to the box. Goes 3 months after 0.8.0.
        phoneLink.handOver = { await AgentMail.shared.handOver(to: $0) }
        // This Mac's link is its box's: the app tells it what's wanted, and answers what it asks; this
        // Mac's own box moved into a home of its own too, attached in place (#333 piece 6b). Attached
        // to a machine's box (the Mini's), the box there keeps its own link (set up by the Mac that
        // added it), which only its own Macs change: the app has none to tell (`noBox`).
        // (This Mac's own box takes its link's words from its app over its server alone: while it
        // isn't up, there's none to tell, and the link waits, rather than ask its CLI, which refuses.)
        phoneLink.box = { [weak self] in
            guard let self else { return nil }
            if attached == nil { return box(BoxClient.mac) }
            return attachedIsOwnBox && OwnBoxHome.streamsNow ? box(SSHConnection.thisMac) : nil
        }
        phoneLink.noBox = { [weak self] in self.flatMap { $0.attached == nil || $0.attachedIsOwnBox ? nil : PhoneLink.keptByTheBoxHere } }
        host.phoneLink = phoneLink
        phoneLink.restartEngine = { [weak self] in Task { await self?.restartThisMacsEngine() } }
    }

    /// This Mac's engine started over: the app's own (`restart`), or, attached in place, that box's,
    /// which its own keeper restarts: connected again, as Settings › Engine's Restart does there.
    func restartThisMacsEngine() async {
        if attached != nil, let here = machines.engine(SSHConnection.thisMac) {
            await restartEngine(here).value
        } else {
            await restart()
        }
    }

    /// Puts the usage panel in the menu bar. It reads the engine's database for spend, so it
    /// starts with the app, not with the engine.
    /// Whether it started (a copy that never prompts leaves it out, unless a demo asks for one of
    /// its screens by name).
    @discardableResult func startUsage() -> Bool {
        if AppInfo.isHostingTests || AppInfo.demoUsageScreen(ProcessInfo.processInfo.environment) == nil {
            guard AppInfo.mayPrompt("the usage panel (it reads other apps' sign-ins from your Keychain)") else { return false }
        }
        usage.start(engineData: engineFolders.dataDirectory) { [weak self] in
            self?.openMainWindow?()
        }
        return true
    }

    /// A local opencode build to run instead of the pinned download (KUVO_OPENCODE_BINARY), in a
    /// debug build only: in the app you use, anything that can set its environment
    /// (`launchctl setenv`) could have it run a program of its own as its engine and box.
    static var engineOverride: String? {
        #if DEBUG
        ProcessInfo.processInfo.environment["KUVO_OPENCODE_BINARY"]
        #else
        nil
        #endif
    }

    /// The engine this Mac runs (KUVO_OPENCODE_BINARY's, or the one installed), once it has started.
    private(set) var engineBinary: URL?

    /// A macOS prompt is on screen, like "would like to access files in your Desktop folder":
    /// those come from UserNotificationCenter, whose windows show only while it asks.
    static var systemPromptShowing: Bool {
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return windows.contains { $0[kCGWindowOwnerName as String] as? String == "UserNotificationCenter" }
    }

    /// A macOS prompt is open, on screen or not (the screen locked, a Mac no one's at): for the box's
    /// watch of its servers, which holds off for it, so this goes by any window of that program.
    static var systemPromptOpen: Bool {
        let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
        return windows.contains { $0[kCGWindowOwnerName as String] as? String == "UserNotificationCenter" }
    }

    private var installer: EngineInstaller {
        EngineInstaller(root: AppInfo.supportDirectory.appending(path: "engine"))
    }

    /// Downloads the engine if needed, finds this Mac's box (the keeper's, or starts its own), and
    /// connects the stores. At launch, whether or not the window opens (this Mac is a box of its
    /// own, at work in the background too).
    func start() async {
        // Already on its way (restart stops it first).
        switch engine {
        case .ready, .starting, .downloading: return
        case .preparing, .failed: break
        }
        // Asked twice before the first got as far as saying so (launch, and the window opening).
        guard starting == nil else { return }
        let start = UUID()
        starting = start
        defer { if starting == start { starting = nil } }
        // What you keep here, up to date with this version (once, after an update), before the
        // engine starts.
        await calibration.run(self)
        // Stopped meanwhile (the app quitting, a restart begun): this start gives up.
        guard starting == start else { return }
        let launch = UUID()
        self.launch = launch
        engineStoppedWhileRunning = false
        // How far it got, for analytics when it fails: the download, the launch, or the connection.
        var stage = "download"
        let began = SuspendingClock.now
        var downloaded = false
        do {
            async let environment = ShellEnvironment.load()
            let binary: URL?
            if let override = Self.engineOverride {
                binary = URL(filePath: override)
            } else if let installed = await Task.detached(operation: { [installer] in installer.installed() }).value {
                // Checking its signature reads all of it, a second or so: off the main thread.
                binary = installed
            } else if KeeperRecord.read()?.isOtherVersion == true {
                // An older keeper making way for this version's runs the engine it came with, which
                // a download here would take away (one keeps only its own version): the keeper that
                // replaces it downloads this version's.
                binary = nil
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
            // As this Mac's box gives its engine (`MacBoxRunner`): the terminals you open get the same.
            if AppInfo.neverPrompts { shell["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"] = "1" }
            shellEnvironment = shell
            // A box already on this Mac (one you set up as a machine): the app attaches to it in
            // place, and starts, claims and registers nothing of its own, so there's never a second.
            // (One that couldn't tell, with a box here, starts nothing: its own would be a second, for good.)
            if Self.attachesInPlace || Self.movesOwnBox, keeperBox == nil, !ownBoxStarted {
                // (Attached already, it stays so while it's looked at again: this Mac doesn't show
                // up twice, nor do Settings' tabs move, as it starts again.)
                BackgroundWork.heldBack = nil
                // A new Mac (no box of the app's ever ran in its folder): its box made in its home of
                // its own from the start, by the box, and started there by its helper (#333).
                if Self.movesOwnBox, let move = OwnBoxMove.forThisMac(), await move.makeNew() {
                    OwnBoxHome.recheck()
                }
                guard launch == self.launch else { return }
                var outcome = await Here.gate(engine: binary, script: BoxProcess.script, appBox: BoxProcess.home, engineData: engineFolders.dataDirectory,
                                              home: Self.hereHome, checked: Self.engineOverride == nil)
                // (Its home's box just made, its helper starting it: a moment for it to be there.)
                for _ in 0..<5 where outcome == .own && BackgroundWork.boxStartsOnItsOwn {
                    try? await Task.sleep(for: .seconds(1))
                    outcome = await Here.gate(engine: binary, script: BoxProcess.script, appBox: BoxProcess.home, engineData: engineFolders.dataDirectory,
                                              home: Self.hereHome, checked: false)
                }
                // Moving into its home of its own (the keeper does it): nothing starts here meanwhile.
                // The window says it's moving (and why it's held up, as the box says), still
                // starting, and only `here` is asked again, less often as it goes on.
                var wait = 5
                while outcome == .wait, Self.movesOwnBox, launch == self.launch {
                    detachHere()
                    // Its keeper switched off (in Login Items): nothing finishes the move, so it says
                    // so rather than wait for good.
                    BackgroundWork.shared.refresh()
                    // (Not registered at all, the copy that registered it moved say: registered
                    // again, so it starts and finishes the move.)
                    if BackgroundWork.shared.state == .off {
                        BackgroundWork.heldBack = nil
                        BackgroundWork.shared.register()
                    }
                    if BackgroundWork.shared.state != .on {
                        boxMoving = nil
                        BackgroundWork.heldBack = "This Mac’s box is moving into its own home."
                        throw MachineFailure(message: BackgroundWork.shared.state == .needsApproval
                            ? "This Mac’s box is moving into its own home, but Kuvo Code’s background work is turned off, so it can’t finish. Turn it on in System Settings › General › Login Items, then try again."
                            : "This Mac’s box is moving into its own home, but Kuvo Code’s background work couldn’t be set up, so it can’t finish. \(BackgroundWork.shared.failure ?? "Try again in a moment.")")
                    }
                    BackgroundWork.heldBack = "This Mac’s box is moving into its own home."
                    boxMoving = await OwnBoxMove.forThisMac()?.movingNow() ?? ""
                    try? await Task.sleep(for: .seconds(wait))
                    wait = min(wait * 2, 60)
                    guard launch == self.launch else { return }
                    outcome = await Here.gate(engine: binary, script: BoxProcess.script, appBox: BoxProcess.home, engineData: engineFolders.dataDirectory,
                                              home: Self.hereHome, checked: false)
                }
                boxMoving = nil
                guard launch == self.launch else { return }
                switch outcome {
                case .attach(var here):
                    attached = here
                    BackgroundWork.heldBack = "This Mac’s box is the one already here, which starts on its own."
                    // Stopped (its keeper ended: only a login or a restart starts it again by
                    // itself): started again in place, by launchd where its agent is there.
                    if here.runs == .stopped, let binary, let script = BoxProcess.script,
                       let now = await Here.started(engine: binary, script: script, appBox: BoxProcess.home,
                                                    engineData: engineFolders.dataDirectory, home: Self.hereHome),
                       now.use == .attach {
                        here = now
                    }
                    guard launch == self.launch else { return }
                    attached = here
                    // One that won't start is said so, to try again, rather than waited on.
                    guard here.runs == .running else {
                        // Its login item there, which launchd wouldn't start: turned off, it stays off.
                        throw MachineFailure(message: BackgroundWork.boxStartsOnItsOwn
                            ? Here.startTrouble.map { "This Mac’s box didn’t start. \($0)" }
                                ?? "This Mac’s box didn’t start. If Kuvo Code Box is turned off in System Settings › General › Login Items, turn it on, then try again."
                            : Here.startsByLaunchd(home: Self.hereHome)
                            ? "The box already on this Mac didn’t start. If its login item (“sh”) is turned off in System Settings › General › Login Items, turn it on, then try again."
                            : "The box already on this Mac didn’t start. Try again in a moment.")
                    }
                    // Running, it's told the app is here, for good.
                    await Here.sayAttached(home: Self.hereHome)
                    guard launch == self.launch else { return }
                    openOnAttached(began: began, downloaded: downloaded)
                    return
                case .unknown(let why):
                    detachHere()
                    let couldnt = "Kuvo Code couldn’t check the box already on this Mac, so it didn’t start one of its own."
                    BackgroundWork.heldBack = couldnt
                    throw MachineFailure(message: why ?? couldnt)
                case .wait:
                    // (Only a copy that doesn't move boxes, attaching in place: nothing of its own
                    // finishes the move, so it says so, once.)
                    detachHere()
                    BackgroundWork.heldBack = "This Mac’s box is moving into its own home."
                    throw MachineFailure(message: "This Mac’s box is moving into its own home. Try again in a minute.")
                case .own, .two:
                    // None here now: the box that was is no longer this Mac's.
                    detachHere()
                    // Its box in its home of its own (as the box said as it opened): never a second
                    // one in the app's folder.
                    if BackgroundWork.boxStartsOnItsOwn {
                        BackgroundWork.heldBack = "This Mac’s box starts on its own."
                        throw MachineFailure(message: outcome == .two
                            ? "This Mac has two boxes: Kuvo Code’s own, in its folder, and the one in ~/.kuvo-code, which runs on its own. Kuvo Code doesn’t start its own beside it."
                            : "This Mac’s box is starting in its own home. Try again in a moment.")
                    }
                }
            }
            guard launch == self.launch else { return }
            followAgents()
            let endpoint = try await boxEngine()
            guard launch == self.launch else { return }
            // The settings as they are now; a box slow to answer holds this up a few seconds at most.
            await Self.atMost(.seconds(10)) { [weak self] in await self?.prepareSettings() }
            guard launch == self.launch else { return }
            // COMPAT(0.7 provider-compatibility): what the app learned before its box did, gone. Goes 3 months after 0.8.0.
            UserDefaults.standard.removeObject(forKey: "copilotClaudeModels")
            stage = "connect"
            let api = OpenCodeAPI(endpoint: endpoint)
            try await MacBoxRunner.waitUntilReady(api)
            // It stopped (and said why), or was stopped, while it loaded.
            guard launch == self.launch else { return }
            self.api = api
            catalog.api = api
            catalog.box = box(BoxClient.mac)
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
            // What this Mac's box and your machines say is moving, from now on.
            Task { await moves.reloadAll() }
            usage.api = api
            engine = .ready
            #if DEBUG
            E2E.note(endpoint)
            #endif
            wirePhoneLink()
            phoneLink.start(endpoint: endpoint)
            // What it makes and tells this Mac's bots with, as this version has it.
            bots.writeMacKit()
            Task {
                // COMPAT(0.7 mac-git-settings): Settings › Git as this Mac kept it before, to its box once. Goes 3 months after 0.8.0.
                await GitPreferences.move(to: box(BoxClient.mac))
                // Your personalities, as it keeps them, before they're followed.
                await Personalities.shared.refresh()
                // Its worktrees, projects and wake-ups, as this Mac's box keeps them, from now on
                // (what was kept here before goes there); not for a start given up meanwhile,
                // whose stop has ended them.
                if boxFollowed == nil, launch == self.launch {
                    boxFollowed = Task {
                        async let worktrees: Void = workspace.followWorktrees()
                        async let queues: Void = workspace.followQueues()
                        async let background: Void = workspace.followBackground(BoxClient.mac)
                        // What its sessions are and where they're filed: the sidebar's projects and chats.
                        async let sessionList: Void = workspace.followSessionList(on: BoxClient.mac)
                        async let wakes: Void = wakeUps.follow()
                        async let personalities: Void = Personalities.shared.follow()
                        async let bots: Void = bots.follow()
                        async let asks: Void = botAsks.follow(BoxClient.mac)
                        async let sandboxAsks: Void = Sandboxes.shared.follow(BoxClient.mac)
                        async let goalsFollowed: Void = goalPlans.follow(BoxClient.mac)
                        async let oversight: Void = botOversight.follow(BoxClient.mac)
                        async let notices: Void = boxNotices.follow(BoxClient.mac)
                        // COMPAT(0.7 mac-personalities): what an earlier Kuvo Code changed in its own copy, taken in. Goes 3 months after 0.8.0.
                        // What a 0.8.0 beta changed of your personalities where it kept them.
                        await Personalities.shared.takeFromOld()
                        await workspace.followProjects()
                        await worktrees
                        await queues
                        await background
                        await sessionList
                        await wakes
                        await personalities
                        await bots
                        await asks
                        await sandboxAsks
                        await goalsFollowed
                        await oversight
                        await notices
                    }
                }
            }
            Analytics.shared.trackOnce("engine_ready", ["seconds": Int((SuspendingClock.now - began).components.seconds), "downloaded": downloaded])
            listen(to: api)
            agents.engineEndpoint = endpoint
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
            await catalogLoaded
        } catch {
            // Stopped, or started over, meanwhile.
            guard launch == self.launch else { return }
            let reason = error.localizedDescription
            log.error("Engine failed to start: \(reason, privacy: .public)")
            Analytics.shared.track("engine_failed", ["reason": stage, "kind": EngineInstallError.kind(of: error)])
            // Its box stopped the engine already, and said why (`run/engine-stopped`), which stopping
            // it here again would take away.
            disconnect()
            engine = .failed(reason)
            workspace.macEngineStopped()
        }
    }

    // MARK: This Mac's box

    /// This Mac's box when the app runs it itself: while macOS doesn't let the keeper run
    /// (`BackgroundWork`), and in a copy that never asks macOS (tests, demos left on their own).
    /// It stops when you quit.
    @ObservationIgnored private(set) lazy var ownBox = MacBoxRunner(box: box, agents: agents, host: host)
    /// This Mac's keeper's box, followed: nil while the app runs its own.
    private(set) var keeperBox: KeeperFollower?
    /// The keeper running now is an older app's, making way for this one's the first moment nothing
    /// is under way (a running session is never stopped for an update): until then the app follows
    /// it, and Settings › General and the menu bar's card say the update waits.
    private(set) var keeperMakesWay = false
    /// This Mac's own box looked at while the update gate holds it (`followOwnBoxGate`).
    @ObservationIgnored private var ownBoxGateFollow: Task<Void, Never>?
    /// Another version's keeper runs this Mac's box now (`KeeperFollower.runsOtherVersion`).
    @ObservationIgnored private var keeperRunsOtherVersion = false
    /// This Mac's box moving into its home of its own (#333): why it holds on, where it went wrong
    /// part way, "" while it just moves; nil otherwise. The window says so while it starts.
    private(set) var boxMoving: String?

    /// Whether quitting leaves this Mac's work going (the keeper runs it): Quit takes Kuvo Code to
    /// the menu bar (`InBackground`), and Stop Background Work is there.
    /// The keeper's turned on while the app ran its own box counts too: the app's goes on in the
    /// menu bar until it quits for real, and the keeper takes over then.
    /// Switched off in Login Items & Extensions, it's off at once, keeper followed or not; and so
    /// is one launchd couldn't start this time, or a demo's, test's or measurement's copy's.
    var keepsWorkingAfterQuit: Bool {
        #if DEBUG
        // A test's keeper, followed without asking macOS.
        if keeperBox != nil, ProcessInfo.processInfo.environment["KUVO_KEEPER"] == "follow" { return true }
        #endif
        let work = BackgroundWork.shared
        return work.state == .on && work.registersHere && !work.didntStart
    }
    /// The own box was started this launch (restarting it is starting its engine over).
    @ObservationIgnored private var ownBoxStarted = false

    /// The box already on this Mac that the app attached to in place as it opened (`Here`), rather
    /// than starting one of its own: a Mac you set up as a machine, your Mac mini say.
    private(set) var attached: Here? {
        // What has no computer of its own is on this box from now on (`BoxClient.thisMac`), and
        // Settings' pages on this Mac go with it.
        didSet {
            // (Whether this Mac's box has moved into a home of its own, looked at again.)
            OwnBoxHome.recheck()
            BoxClient.thisMac = thisMacsBox.id
            settingsTabs.thisMac = thisMacsBox
        }
    }
    /// Whether the app attaches to a box already on this Mac (#183): on with the screen that says
    /// so, which the window shows instead of starting (with a state of its own, not `.starting`,
    /// which it stays in meanwhile); the tests' until then.
    nonisolated(unsafe) static var attachesInPlace = false
    /// Whether this Mac's box moves out of the app's folder to a home of its own, `~/.kuvo-code`,
    /// laid out as a machine's (#333; its box says it can with `box.ownHome`). Off until the move
    /// and the app's side of it are built: nothing turns it on yet.
    nonisolated(unsafe) static var movesOwnBox = false
    /// The home folder `here` looks in: a folder of the tests' own while they run, which they set.
    nonisolated(unsafe) static var hereHome = defaultHereHome
    nonisolated static var defaultHereHome: URL {
        AppInfo.isHostingTests ? AppInfo.testRoot.appending(path: "here-home") : FileManager.default.homeDirectoryForCurrentUser
    }

    /// The window opens on the box already here, attached in place: this Mac is that box, reached as
    /// a machine with no SSH (`SSHConnection.thisMac`), from its own home folder, its engine at its
    /// own ports, its keys, paths and start at login as they are. The app has no engine, box or
    /// keeper of its own (`api` stays nil), so `.ready` here says the window can open on it.
    /// Its link to your phones is that box's own; what the app's own box is followed for as it runs
    /// (its wake-ups, worktrees and your personalities) is followed there once it's connected, as
    /// a machine's things are (`connected`, `thisMacsBoxConnected`). Nothing after the attach in
    /// `start` runs for it: that starts the app's own box, a second one.
    /// `began`, `downloaded`: as `start` counts them, for when its engine's ready.
    private func openOnAttached(began: SuspendingClock.Instant, downloaded: Bool) {
        attachStarted = (began, downloaded)
        SSHConnection.thisMacHome = Self.hereHome.path(percentEncoded: false)
        machines.attachHere()
        // Its stores told of each other, as a start of the app's own box tells them (what follows
        // the app's own box finds none, and waits); and what a phone's request would reach here,
        // with agents' letters (`AgentMail`) going to the box here. The app's link isn't started:
        // the box here has its own.
        wireStores()
        wirePhoneLink()
        followClock()
        followActivation()
        engine = .ready
        startMachines()
        // Where its chats go, as it says, for a new chat with no project.
        Task { try? await readChatsHere() }
    }

    /// When the start that attached in place began, and whether it downloaded the engine first:
    /// `engine_ready` is counted once the box's engine connects.
    @ObservationIgnored private var attachStarted: (began: SuspendingClock.Instant, downloaded: Bool)?

    /// The box attached in place connected (again): it's this Mac's engine, so the usage panel reads
    /// its spend (its engine's database, beside what the app's own engine kept before) and its
    /// accounts, and analytics its models; its start is counted once, as the app's own engine's is.
    func thisMacsBoxConnected(_ here: MachineEngine) {
        guard attached != nil else { return }
        usage.api = here.api
        if let root = Here.root {
            usage.readEngineData([engineFolders.dataDirectory, EngineFolders(root: Self.hereHome.appending(path: root)).dataDirectory])
        }
        if usageFollows !== here.catalog {
            usageFollows = here.catalog
            usage.follow(here.catalog)
        }
        Task { await usage.sync() }
        if attachedIsOwnBox {
            // This Mac's own box, moved (#333 piece 6b): its link is followed and told what's wanted,
            // as the app's own box's was (what a phone asks of the Mac's own routes comes to the app
            // through its host); and the app registers there: its browser's tools, where it answers,
            // the release it carries.
            if let endpoint = here.api?.client.endpoint { phoneLink.start(endpoint: endpoint) }
            Task { await registerWithOwnBox() }
        } else {
            // A machine's box (one you set up on this Mac): its server kept for the app while it's
            // attached, so what follows it streams (`OwnBoxHome.client`).
            Task { await askForServer() }
        }
        Analytics.shared.catalog = here.catalog
        if let started = attachStarted {
            Analytics.shared.trackOnce("engine_ready", ["seconds": Int((SuspendingClock.now - started.began).components.seconds),
                                                        "downloaded": started.downloaded, "attached": true])
        }
    }

    /// The box attached in place's catalog, once the usage panel follows its coding agents.
    @ObservationIgnored private weak var usageFollows: Catalog?
    /// This Mac's own box was offered the release the app carries, this launch (`registerWithOwnBox`).
    @ObservationIgnored var offeredOwnBoxRelease = false
    /// The app registering with this Mac's own box now (`registerWithOwnBox`): one at a time.
    @ObservationIgnored var ownBoxRegistering: Task<Void, Never>?

    /// No longer attached to a box here (none now, or it can't be told): it's no longer listed or
    /// followed, and what has no computer of its own is the app's own box's again.
    /// What this Mac showed of it goes as a removed machine's does (`removeMachine`), with nothing
    /// run there.
    private func detachHere() {
        let id = SSHConnection.thisMac
        // This Mac's own box's link, followed while attached, and what answers it for the app.
        if attachedIsOwnBox { phoneLink.stop() }
        leaveOwnBox()
        OwnBoxHome.servesAsMac.withLock { $0 = false }
        attached = nil
        workspace.attachedChats = nil
        guard machines.engine(id) != nil else { return }
        // The usage panel and analytics go back to the app's own engine (set again as it starts).
        usage.api = nil
        usage.readEngineData([engineFolders.dataDirectory])
        Analytics.shared.catalog = catalog
        planLimits.stopped(id)
        closeAll(on: id)
        machines.detachHere()
        forgetAll(of: id)
        moves.forget(id)
        // Its sessions' tabs go with them; a new one not sent yet, in a folder there, too.
        for key in tabs.keys {
            if case .draft(let folder) = key, RemoteFolder.machine(of: folder) == id { tabs.close(key, remember: false) }
        }
    }

    /// This Mac's own box, as the update gate holds it (#679): while an older app's keeper still runs
    /// it (making way for this app's once the work under way ends), it's held, and asked what it has
    /// every ten seconds: let go once it has all this app needs (the keeper of this version runs it,
    /// or the older one turns out to have it). One that can't be asked just then is asked again.
    func followOwnBoxGate(again: Bool = false) {
        // Looked at again at once (its box answering somewhere new), from the start.
        if again {
            ownBoxGateFollow?.cancel()
            ownBoxGateFollow = nil
        }
        guard ownBoxGateFollow == nil, keeperRunsOtherVersion || machines.gates.state(of: BoxClient.mac) != nil else { return }
        ownBoxGateFollow = Task { [weak self] in
            while !Task.isCancelled, let self {
                if await self.ownBoxIsCurrent() == true {
                    self.machines.gates.letGo(BoxClient.mac)
                    break
                }
                // (Cut short meanwhile, a newer look in its place.)
                guard !Task.isCancelled else { return }
                if self.machines.gates.state(of: BoxClient.mac) == nil {
                    self.machines.gates.updating(BoxClient.mac, detail: BoxGate.Words.thisMacFinishing)
                }
                do { try await Self.ownBoxLookAgain() } catch { return }
            }
            guard !Task.isCancelled else { return }
            self?.ownBoxGateFollow = nil
        }
    }

    /// How long it waits between looks at this Mac's own box while it's held (a test's own).
    nonisolated(unsafe) static var ownBoxLookAgain: @Sendable () async throws -> Void = { try await Task.sleep(for: .seconds(10)) }

    /// Whether this Mac's own box has all this app needs, as it says (`kuvo/info`; a 404 or 405:
    /// from before it said); nil when it couldn't be asked.
    private func ownBoxIsCurrent() async -> Bool? {
        guard let (status, data) = try? await box(BoxClient.mac).send("GET", "kuvo/info"),
              case .has(let features) = BoxFeatures.said(status: status, body: data) else { return nil }
        return BoxGate.isCurrent(features)
    }

    /// The chats folder of the box attached in place, as it names it (`kuvo/info`'s `chats`), as a
    /// machine's is read for a new chat there. Throws why not: it didn't answer, or the update gate
    /// holds it (the gate's refusal: it starts nothing until it's up to date, and every box that
    /// isn't held names its chats folder).
    func readChatsHere() async throws {
        guard attached != nil, workspace.attachedChats == nil else { return }
        let here = box(SSHConnection.thisMac)
        if let held = BoxGates.held(here.box) { throw held }
        struct Info: Decodable { var chats: String }
        let info = try await here.value(Info.self, "GET", "kuvo/info")
        // (Let go of meanwhile: nothing of it is kept.)
        guard attached != nil else { return }
        workspace.attachedChats = RemoteFolder.folder(info.chats, on: SSHConnection.thisMac)
    }

    /// This Mac's engine once it's up: the keeper's (started, or made way for after an update, as
    /// needed), or the app's own. What becomes of it later comes to `boxEngineChanged`.
    private func boxEngine() async throws -> ServerEndpoint {
        // The keeper's, unless macOS doesn't let it run; and the keeper's anyway when it runs the
        // box already (one allowed while the app ran its own waits for the app to quit). Never one
        // registered (a copy that never asks macOS), there's no keeper to share it with. One that
        // didn't come up this launch isn't waited on again: the app runs the box itself.
        if keeperBox == nil, !ownBoxStarted, (keeperRuns() && !BackgroundWork.shared.didntStart) || (BackgroundWork.shared.state != .off && !ownBox.claim()) {
            let follower = KeeperFollower(box: box, agents: agents)
            follower.onEngine = { [weak self] state in self?.boxEngineChanged(state) }
            follower.onKeeper = { [weak self] in Task { await self?.tellKeeper() } }
            follower.onGone = { [weak self] in self?.keeperGone() }
            follower.onMakingWay = { [weak self] makingWay in self?.keeperMakesWay = makingWay }
            // Another version's keeper runs this Mac's box (an older app's, after an update): held
            // at once, whatever it answered when asked to make way, until it's asked what it has
            // (nothing reaches it on a path it may not have meanwhile); looked at again as soon as
            // its box answers somewhere new.
            follower.onOtherVersion = { [weak self] other in
                guard let self else { return }
                keeperRunsOtherVersion = other
                if other, machines.gates.state(of: BoxClient.mac) == nil {
                    machines.gates.updating(BoxClient.mac, detail: BoxGate.Words.thisMacFinishing)
                }
                followOwnBoxGate(again: true)
            }
            follower.onServe = { [weak self] in self?.followOwnBoxGate(again: true) }
            follower.onMoving = { [weak self] moving in self?.boxMoving = moving }
            host.tellsBox = false
            // Answering again at a new address (its listener failed by itself): the keeper is told.
            host.restarted = { [weak self] in Task { await self?.tellKeeper() } }
            // The keeper keeps this Mac awake while agents work, so the app holds nothing besides.
            Awake.shared.keeper = { (try? await KeeperControl.send(.status))?["awake"] as? Bool ?? false }
            keeperBox = follower
            if !(await follower.start()) {
                keeperBox = nil
                Awake.shared.keeper = nil
                host.tellsBox = true
            }
        }
        if let keeperBox { return try await keeperBox.ready() }
        if !ownBoxStarted {
            ownBoxStarted = true
            // The browser tools, for the engine and the agents to connect to. Without them the
            // agent still works, just without the browser.
            do {
                _ = try await browserTools.start()
                if let config = browserTools.engineConfig, let agentsServer = browserTools.agentsServer {
                    ownBox.tools = MacBoxRunner.Tools(engineConfig: config, agents: agentsServer)
                }
                browserTools.owner = { [weak self] id in await self?.workspace.engineRunOwner(id) }
            } catch {
                log.error("Browser tools didn't start: \(error.localizedDescription, privacy: .public)")
            }
            ownBox.onEngine = { [weak self] state in self?.boxEngineChanged(state) }
            Task { await ownBox.start() }
        }
        return try await ownBox.ready()
    }

    /// The keeper isn't coming (background work switched off in Login Items & Extensions, or
    /// macOS doesn't let it run): the app runs this Mac's box itself from now on, which stops when
    /// you quit, and connects to it.
    private func keeperGone() {
        guard let keeperBox else { return }
        log.notice("Background work is off: this Mac's box runs in the app")
        keeperBox.stop()
        self.keeperBox = nil
        keeperMakesWay = false
        // The app runs this Mac's box itself now, of this version: looked at, and let go.
        keeperRunsOtherVersion = false
        followOwnBoxGate(again: true)
        // The app keeps this Mac awake itself now, while it runs the box.
        Awake.shared.keeper = nil
        box.unfollow()
        agents.unfollow()
        host.tellsBox = true
        // A start waiting on the keeper gives up (disconnected), and one starts with the app's own.
        disconnect()
        keeperBox.giveUp("Kuvo Code’s background work is off.")
        engine = .preparing
        Task { await start() }
    }

    /// The keeper told of the open app: where the panel's browser tools answer, for its engine's and
    /// agents' browser calls, and the app's host interface, for what only the app answers its box.
    private func tellKeeper() async {
        do {
            _ = try await browserTools.start()
            browserTools.owner = { [weak self] id in await self?.workspace.engineRunOwner(id) }
            browserTools.ready = { [weak self] in await self?.workspace.firstLoad(within: 20) }
        } catch {
            log.error("Browser tools didn't start: \(error.localizedDescription, privacy: .public)")
        }
        try? await host.start()
        var app: [String: Any] = [:]
        if let tools = browserTools.agentsServer { app["tools"] = ["url": tools.url, "token": tools.token] }
        if let address = host.address { app["host"] = address }
        do {
            try await KeeperControl.send(.app, app)
        } catch {
            log.error("The keeper wasn't told of the app: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Whether this Mac's box is the keeper's: registered with macOS and allowed to run (the first
    /// launch registers it, once the engine it runs is here). In a debug build, KUVO_KEEPER=off
    /// keeps it the app's own, and KUVO_KEEPER=follow follows a keeper that runs already (a test's)
    /// without asking macOS.
    private func keeperRuns() -> Bool {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["KUVO_KEEPER"] {
        case "off": return false
        case "follow": return true
        default: break
        }
        #endif
        return BackgroundWork.shared.register()
    }

    /// This Mac's engine, as its box says, after the app connected to it: started over (by its
    /// box, after it stopped, or after an update), stopped, or given up on.
    private func boxEngineChanged(_ state: MacBoxRunner.Engine) {
        switch state {
        case .ready(let endpoint):
            // (A newer keeper's box, say, in place of one an older app's keeper ran: looked at at
            // once, not after the look under way waits its ten seconds.)
            followOwnBoxGate(again: true)
            // Up again, somewhere new: connected anew (a start under way, waiting for it, takes it).
            if engine == .ready, api?.client.endpoint == endpoint { return }
            guard starting == nil else { return }
            if engine == .ready { disconnect() }
            engine = .preparing
            Task { await start() }
        case .starting, .downloading:
            // Stopped while it ran: the window says it's starting again, and connects once it has.
            if engine == .ready {
                engineStoppedWhileRunning = true
                disconnect()
                engine = .starting
                return
            }
            // Tried again by itself, downloading the engine: its progress rather than the failure
            // before it (and Try Again, which would download beside it).
            guard starting == nil else { return }
            switch (state, engine) {
            case (.downloading(let progress), .failed), (.downloading(let progress), .downloading): engine = .downloading(progress: progress)
            case (.starting, .downloading): engine = .starting
            default: break
            }
        case .failed(let reason):
            // A start under way hears it itself.
            guard starting == nil else { return }
            if engine == .ready { engineStoppedWhileRunning = true }
            disconnect()
            engine = .failed(reason)
            workspace.macEngineStopped()
        }
    }

    /// The window's Try Again and Settings › Engine's Restart: this Mac's engine started over by
    /// its box, and connected anew.
    func restart() async {
        disconnect()
        engine = .preparing
        engineStoppedWhileRunning = false
        if let keeperBox {
            try? await keeperBox.restartEngine()
        } else if ownBoxStarted {
            ownBox.restartEngine()
        }
        await start()
    }

    /// Stop Background Work: the keeper stops this Mac's box (a session under way pauses, and a
    /// wake-up due meanwhile comes when it starts again), and the app quits with it. It all starts
    /// again when you open Kuvo Code or log in.
    func stopBackgroundWork() async throws {
        // Not followed meanwhile, which would start it again.
        keeperBox?.stop()
        do {
            try await BackgroundWork.shared.stop()
        } catch {
            await keeperBox?.start()
            throw error
        }
        NSApplication.shared.terminate(nil)
    }

    /// The app quits: its own box stops with it; the keeper's goes on, and keeps this Mac awake
    /// while agents work there.
    func stopBox() {
        keeperBox?.stop()
        // Only a box the app started: before then, what runs (and its records) is the keeper's.
        if keeperBox == nil, ownBoxStarted { ownBox.stop() }
        Awake.shared.agentsWork(false)
        Awake.shared.keeper = nil
    }

    /// This Mac's settings read from its box, which keeps them up to date itself: one at a time,
    /// whoever asks (the engine's start, the box up late or again, a new machine's copy).
    func prepareSettings() async {
        if let settingsPreparation { return await settingsPreparation.value }
        let config = engineConfig
        let preparing = Task { @MainActor in
            await config.refresh()
            _ = await config.settled()
        }
        settingsPreparation = preparing
        await preparing.value
        settingsPreparation = nil
    }

    /// `work`, waited for `limit` at most: past that it goes on by itself.
    static func atMost(_ limit: Duration, _ work: @escaping @MainActor () async -> Void) async {
        @MainActor final class Once { var done = false }
        let once = Once()
        await withCheckedContinuation { (finished: CheckedContinuation<Void, Never>) in
            let finish = { @MainActor in
                guard !once.done else { return }
                once.done = true
                finished.resume()
            }
            Task { @MainActor in
                await work()
                finish()
            }
            Task { @MainActor in
                try? await Task.sleep(for: limit)
                finish()
            }
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

    /// The coding agents' bridge, as this Mac's box runs it (`MacBoxRunner`): what it says reaches the
    /// window's stores. Wired once; the bridge stays up through the engine's restarts.
    func followAgents() {
        workspace.agents = agents
        catalog.outsideAgents = agents
        usage.follow(catalog)
        agents.onEvent = { [weak self] event in
            // This Mac's group chats, as it runs them.
            if event.type.hasPrefix("kuvo.group.") { self?.boxGroups.handle(event, machine: nil); return }
            self?.planLimits.handle(event, machine: nil)
            self?.usageHistory.handle(event)
            self?.catalog.handle(event)
            self?.workspace.handleAgents(event)
        }
        // A handoff asked for here, done: its new conversation opens, wherever the window is.
        agents.onHandoff = { [weak self] handoff in Task { await self?.workspace.openHandoff(handoff) } }
        agents.onStopped = { [weak self] in
            self?.planLimits.stopped(nil)
            self?.usageHistory.stopped()
            self?.catalog.forgetAgents()
            self?.workspace.agentsStopped()
            self?.boxGroups.disconnected(nil)
        }
        agents.onConnected = { [weak self] in
            Task { [weak self] in
                guard let self else { return }
                // This Mac's group chats first: they're what shows from the cache meanwhile. Up
                // before this Mac's engine (it usually is), they're read once the stores are told
                // of each other (`wireStores`).
                planLimits.connected(nil, api: agents.api)
                usageHistory.connected(api: agents.api, box: BoxClient.mac)
                if boxGroups.app == nil { chatsWaitForStores = true } else { await boxGroups.connected(nil) }
                await catalog.refreshAgents()
                await workspace.refreshAgents()
            }
        }
        followClock()
        followActivation()
    }

    /// Your time zone or how you write dates changed: each computer's group chats go by the new
    /// ones (this Mac's, or, attached in place, the box here's). Once, from either start.
    func followClock() {
        guard clockObservers.isEmpty else { return }
        for name in [Notification.Name.NSSystemTimeZoneDidChange, NSLocale.currentLocaleDidChangeNotification] {
            clockObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.boxGroups.settingsChanged() }
            })
        }
    }

    /// Back in the app, you may have installed an agent or signed in to one in Terminal: this Mac's
    /// agents are read again (its own engine's, or, attached in place, the box here's), and your
    /// machines' projects. Once, from either start.
    func followActivation() {
        guard agentsActivation == nil else { return }
        agentsActivation = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.catalog(for: self.thisMacsBox).refreshAgentsIfStale()
                self.workspace.reloadMachinesProjects()
            }
        }
    }

    /// This Mac's group chats running again (Restart, where they say they stopped): its coding
    /// agents' bridge started again, or the engine whose Bun runs it, if that's what never started.
    func restartGroupChats() async {
        if agents.wasStarted { await agents.startAgain() } else { await restart() }
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

    /// The app's own box's engine stopped too (the keeper's goes on), and the app disconnected.
    func stop() {
        disconnect()
        if keeperBox == nil, ownBoxStarted { ownBox.stopEngine() }
    }

    /// Disconnected from this Mac's engine (it goes on): a start still on its way gives up.
    private func disconnect() {
        launch = UUID()
        starting = nil
        #if DEBUG
        E2E.forget()
        #endif
        eventTask?.cancel()
        eventTask = nil
        // What it followed of this Mac's box (its projects, worktrees, wake-ups and bots) stops
        // with it, and starts again with the next start.
        boxFollowed?.cancel()
        boxFollowed = nil
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
}

