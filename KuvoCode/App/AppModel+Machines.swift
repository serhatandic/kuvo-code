import AppKit
import OpenCodeKit
import os

extension AppModel {
    /// Connects every machine you've added, each in the background on its own.
    func startMachines() {
        #if DEBUG
        // KUVO_DEMO_MACHINE_ROOT: a folder of its own on machines (like .kuvo-code-demo), so a demo
        // copy's engine and browser there never touch the ones your own copy of the app runs.
        if let root = ProcessInfo.processInfo.environment["KUVO_DEMO_MACHINE_ROOT"], !root.isEmpty { RemoteEngineInstaller.root = root }
        #endif
        // A box a newer Kuvo Code set up is left as it is (`BoxVersion`).
        BoxVersion.mine = AppInfo.version
        workspace.machines = Set(machines.list.map(\.id))
        // Settings' tabs of a machine removed (from another copy of the app, say) close.
        settingsTabs.closeTabs(notOn: Set(machines.list.map(\.id)), machines: machines)
        // An agent on a machine browses with the machine's browser: the panel shows it, as it
        // shows its own browser for an agent here.
        workspace.onMachineBrowsing = { [weak self] machine, session in self?.utilities.revealMachineBrowser(machine, for: session) }
        workspace.onDeleted = { [weak self] session in
            self?.utilities.closeTabs(of: session)
            // A machine's bot's conversation gone there (carried on with the coding agents from a
            // phone, say): what it has now is read from the machine.
            if let self, let machine = bots.list.first(where: { $0.sessionID == session })?.machine {
                Task { await self.bots.adoptMade(on: machine) }
            }
            // Its wake-ups and watches go with it.
            if let found = self?.workspace.session(session) { self?.wakeUps.forget(found) } else { self?.wakeUps.forget(sessionID: session) }
        }
        // An archived session's wake-ups wait, and come back with it.
        workspace.onArchived = { [weak self] session, _ in self?.archivedChanged(session) }
        // A subagent's calls go by the conversation that started it: its folder, its permissions.
        BrowserTools.sessionFolder = { [weak self] session in
            guard let self else { return nil }
            return workspace.session(workspace.root(of: session))?.location.directory
        }
        BrowserTools.readsAnywhere = { [weak self] session in
            guard let self else { return false }
            let root = workspace.root(of: session)
            guard let found = workspace.session(root), !workspace.seats.contains(root) else { return false }
            return ToolApproval(rules: found.permissions) == .approveAll
        }
        BrowserTools.isInView = { [weak self] session in self?.utilities.isInView(session) ?? false }
        // Agents writing to each other, here and on machines.
        AgentMail.shared.app = self
        // And with machines this Mac isn't connected to, by mail through the relay.
        phoneLink.onMail = { machine, payload in
            Task { await AgentMail.shared.mailed(payload, from: machine) }
        }
        if mailTick == nil {
            mailTick = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(60))
                    await AgentMail.shared.tick()
                }
            }
        }
        BrowserTools.mail = { name, arguments, caller in await AgentMail.shared.call(name, arguments: arguments, caller: caller) }
        // A conversation at work, or waiting for you, keeps its tabs (see `Utilities.tidyAgentTabs`).
        utilities.isBusy = { [weak self] id in
            guard let self else { return false }
            let session = bots.bot(id)?.sessionID ?? id
            return [session, workspace.root(of: session)].contains { workspace.isWorking($0) || workspace.needsAttention($0) }
        }
        // Their wake-ups, set with the tools of Kuvo Code's own.
        BrowserTools.wake = { [weak self] name, arguments, caller in
            await self?.wakeUps.call(name, arguments: arguments, caller: caller) ?? ("Kuvo Code isn't ready yet.", true)
        }
        // The browser sends agents from the sites of integrations you added to their tools.
        BrowserTools.integrationSites = { [weak self] in self.map { Integrations.sites(Integrations.added(in: $0.engineConfig)) } ?? [] }
        // An agent on a machine left a message for one elsewhere: on its way at once.
        workspace.onAgentMessage = { [weak self] machine in
            guard let engine = self?.machines.engine(machine) else { return }
            Task { await AgentMail.shared.collect(from: engine) }
        }
        // An agent showing you a file or folder: in the panel, beside its conversation.
        workspace.onShowInPanel = { [weak self] session, machine, path, isFolder in
            let url = machine.map { RemoteFolder.url(RemoteFolder.folder(path, on: $0)) } ?? URL(filePath: path, directoryHint: isFolder ? .isDirectory : .notDirectory)
            self?.utilities.showInPanel(url, isFolder: isFolder, for: session)
        }
        // An agent asks you for something in its browser: who's asking, and on a machine, the
        // connection that brings the ask here.
        browserAsks.onChange = { [weak self] sessions in self?.workspace.askingInBrowser = sessions }
        browserAsks.conversation = { [weak self] session in self?.workspace.root(of: session) ?? session }
        workspace.botName = { [weak self] session in self?.bots.bot(forSession: session)?.name }
        workspace.botMachine = { [weak self] session in self?.bots.bot(forSession: session)?.machine }
        // One machine at two addresses: the one added later is one of the other's addresses, and
        // what's kept under its name is the other's.
        machines.onFolded = { [weak self] address, machine in self?.machineFolded(address, into: machine) }
        // Settings changed here (a mode, a rule): machines take them too, not only when they connect.
        engineConfig.onSaved = { [weak self] in self?.settingsSaved() }
        engineConfig.onRulesChanged = { [weak self] in self?.workspace.syncPermissions() }
        // Each machine's settings are its own: its sessions, bots and group chats go by them.
        EngineConfig.machine = { [weak self] machine in self?.machines.engine(machine)?.config }
        EngineConfig.machines = { [weak self] in self?.machines.engines.values.map(\.config) ?? [] }
        // Your personalities, one library on every computer.
        Personalities.shared.onChange = { [weak self] in self?.personalitiesChanged() }
        // A machine's view of them, by mail, that changed some here (PROTOCOL.md, "Documents"): bots
        // with one of those hear what it is now.
        phoneLink.tookPersonalities = { [weak self] ids in
            guard let self else { return }
            Task { for id in ids { await self.bots.personalityChanged(id) } }
        }
        workspace.onRunEnded = { [weak self] session in
            self?.bots.runEnded(session: session)
            // An ask its agent left in this Mac's browser has no one waiting for it now.
            self?.browserAsks.runEnded(session)
        }
        // A bot on this Mac browses in tabs of its own.
        BrowserAgent.botOwner = { [weak self] session in
            guard let self else { return nil }
            // A bot's subagent browses in the bot's tabs.
            return bots.bot(actingAs: workspace.root(of: session)).flatMap { $0.machine == nil ? $0.id : nil }
        }
        browserAsks.askerName = { [weak self] session in
            self?.bots.bot(forSession: session)?.name ?? self?.workspace.session(session)?.title
        }
        browserAsks.tab = { [weak self] ask in
            guard let session = ask.session else { return nil }
            return self?.chats.group(seat: session).map { BotGroups.tabKey($0.id) } ?? session
        }
        // A group chat's bot at work: what it's thinking, under its name.
        workspace.onUnshownStream = { [weak self] event in self?.groups.streamed(event) }
        // A sign-in that couldn't be renewed: marked in Accounts and the sidebar, where it was.
        workspace.onSignInEnded = { [weak self] provider, machine, ended in
            guard let self else { return }
            let catalog = machine.flatMap { self.machines.engine($0)?.catalog } ?? catalog
            if ended { catalog.signInEnded(provider) } else { catalog.signInWorks(provider) }
        }
        workspace.onBrowserAsk = { [weak self] session, machine in
            guard let self else { return }
            let root = workspace.root(of: session)
            let name = bots.bot(forSession: root)?.name ?? workspace.session(root)?.title ?? "The agent"
            browserAsks.noteAsker(name, session: session, machine: machine)
            if let machine { machines.engine(machine)?.browser.expectAsk() }
        }
        utilities.machineBrowser = { [weak self] machine in self?.machines.engine(machine)?.browser }
        // A subagent shows in the session that started it, a group chat's seat in its chat.
        utilities.shownIn = { [weak self] session in
            guard let self else { return session }
            if let group = chats.group(seat: session) { return BotGroups.tabKey(group.id) }
            return workspace.root(of: session)
        }
        // Each conversation has its own panel: a bot's session's is the bot's, and a seat's or a
        // subagent's is where it shows.
        utilities.panelOf = { [weak self] session in
            guard let self else { return session }
            let shown = utilities.shownIn(session)
            return bots.bot(forSession: shown)?.id ?? shown
        }
        // A machine whose connection dropped while the Mac slept, and that gave up trying, gets
        // another go once it's awake and the network is back. (NSWorkspace says so on its own
        // notification center; watched once, though this runs with each start of the engine.)
        if wakeWatch == nil {
            wakeWatch = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.wakeMachines() }
            }
        }
        for engine in machines.engines.values { connect(engine) }
    }

    private func wakeMachines() {
        for engine in machines.engines.values where !engine.isRetrying {
            if case .failed = engine.state { Task { await reconnect(engine) } }
        }
    }

    /// Adds a machine (a host from `~/.ssh/config`, or `user@host`) and connects to it.
    @discardableResult
    func addMachine(_ destination: String) -> MachineEngine {
        let engine = machines.add(destination)
        workspace.machines = Set(machines.list.map(\.id))
        connect(engine)
        // The first one: this Mac meets it at the relay.
        phoneLink.machinesChanged()
        return engine
    }

    /// Adds the machine at `destination` as Add Machine does, here or from a phone: checked first
    /// (reached with your SSH keys, a Linux its engine runs on), and one already here, at this
    /// address or at another that reaches the same computer, isn't added again: the address
    /// becomes one of its own. Answers its id, and whether it was one already here. Throws why it
    /// can't be added, and `CancellationError` when stopped meanwhile (nothing is added then).
    func addMachine(checking destination: String) async throws -> (id: String, known: Bool) {
        // A machine's folders are named "<destination>/<path>", and an address with a port or
        // a path in it (ssh://…, an IPv6 address) can't be told apart from them.
        if let problem = MachineForm.problem(with: destination) { throw MachineFailure(message: problem) }
        let here = { self.machines.list.first { $0.addresses.contains(destination) } }
        if let known = here() { return (known.id, true) }
        try await RemoteEngineInstaller(connection: SSHConnection(destination: destination), cache: AppInfo.supportDirectory.appending(path: "engine-linux")).check()
        // Canceled meanwhile: not added, nor your accounts copied to it.
        try Task.checkCancellation()
        // Added meanwhile (from a phone and here at once).
        if let known = here() { return (known.id, true) }
        // A machine already here, at another address (its local name, its Tailscale one): one of
        // its addresses, not another machine to set up.
        if let identity = await Machine.identity(at: destination), let known = machines.machine(calling: identity) {
            try Task.checkCancellation()
            machines.addAddress(destination, to: known.id)
            machines.noteAdded(destination, to: known.id)
            return (known.id, true)
        }
        try Task.checkCancellation()
        addMachine(destination)
        return (destination, false)
    }

    /// Why a machine can't be added, in a sentence.
    struct MachineFailure: LocalizedError {
        var message: String
        var errorDescription: String? { message }
    }

    /// Connects again now, rather than waiting for the connection to come back by itself.
    @discardableResult
    func reconnectNow(_ engine: MachineEngine) -> Task<Void, Never>? {
        // Already connecting.
        switch engine.state {
        case .starting, .downloading: return nil
        default: break
        }
        engine.disconnect()
        workspace.forget(engine.machine.id)
        if engine.isStopped { engine.startWanted = true }
        return connect(engine)
    }

    /// Starts engines again, so they take what they read only as they start (accounts brought over
    /// from opencode, say): this Mac's with `mac`, and those of `machines` connected now (each
    /// computer's own settings change only it). Each as soon as nothing's at work in it, now or
    /// when that's done, so no one's work is cut off and nothing waits for you to remember.
    func renewEngines(mac: Bool, machines named: [String] = []) {
        if mac { renewals.insert("") }
        for id in named where machines.engine(id)?.isReady == true { renewals.insert(id) }
        guard renewing == nil else { return }
        renewing = Task { [weak self] in
            while let self, !self.renewals.isEmpty, !Task.isCancelled {
                for id in self.renewals {
                    if id.isEmpty {
                        let busy = self.workspace.running.contains { session in !RemoteFolder.isRemote(self.workspace.session(session)?.location.directory ?? "") }
                        // One that stopped (it fell over reloading, say) starts again too; one
                        // that's on its way up is waited for.
                        let failed = if case .failed = self.engine { true } else { false }
                        guard !busy, self.api != nil || failed else { continue }
                        self.renewals.remove(id)
                        await self.restart()
                    } else if let engine = self.machines.engine(id) {
                        guard !self.workspace.isRunning(on: id) else { continue }
                        self.renewals.remove(id)
                        // Not connected now: it takes them when it connects.
                        if engine.isReady { self.reconnectNow(engine) }
                    } else {
                        self.renewals.remove(id)
                    }
                }
                try? await Task.sleep(for: .seconds(3))
            }
            self?.renewing = nil
        }
    }

    /// Installs and starts a machine's engine over SSH, with what it gets from this Mac, and
    /// feeds its sessions into the workspace.
    /// A demo or test copy's own folder on machines (`KUVO_DEMO_MACHINE_ROOT`): what it starts
    /// there stops when it's done with it, leaving nothing running. Kuvo Code's own runs on its own.
    /// The demo copy's (`.kuvo-code-demo`) runs on too while its phone link is on: it's the copy a
    /// phone is tried with, which reaches its bots there with the Mac shut, as with Kuvo Code's own.
    var leavesMachinesRunning: Bool {
        RemoteEngineInstaller.root == ".kuvo-code" || RemoteEngineInstaller.root == ".kuvo-code-demo" && PhoneLink.isEnabled
    }

    /// A session was archived or brought back (here, from a phone, by another Mac): its wake-ups
    /// wait, or come back, as it is once this runs, so a list read again meanwhile that flipped it
    /// back and forth acts on where it ended up. (A test waits for it.)
    @discardableResult
    func archivedChanged(_ session: String) -> Task<Void, Never> {
        Task {
            guard let found = workspace.session(session) else { return }
            await wakeUps.archived(found, Workspace.isArchived(found))
        }
    }

    /// Starts a machine's engine stopped on purpose (Start), and connects to it.
    func startEngine(_ engine: MachineEngine) {
        engine.disconnect()
        workspace.forget(engine.machine.id)
        engine.startWanted = true
        connect(engine)
    }

    /// Starts a machine's engine over (its Settings › Engine), and connects to it again.
    @discardableResult
    func restartEngine(_ engine: MachineEngine) -> Task<Void, Never> {
        engine.disconnect()
        workspace.forget(engine.machine.id)
        return Task {
            _ = try? await RemoteServer.restartEngine(on: engine.machine.connection)
            await connect(engine).value
        }
    }

    /// What Connect does where you pick a machine: one stopped on purpose starts (Start).
    func connectOrStart(_ engine: MachineEngine) {
        if engine.isStopped { startEngine(engine) } else { connect(engine) }
    }

    /// Connects to `engine`'s machine: the start, and what follows it there, which a test waits for.
    @discardableResult
    func connect(_ engine: MachineEngine) -> Task<Void, Never> {
        let machine = engine.machine.id
        // Its pages are the panel's browser tabs while a session there is in view.
        engine.browser.onPages = { [weak self] pages in self?.utilities.syncMachinePages(machine, pages) }
        engine.browser.onActive = { [weak self] page, byAgent, session in self?.utilities.machinePageActive(machine, page: page, byAgent: byAgent, session: session) }
        engine.browser.sessionInView = { [weak self] in self?.utilities.inView.session }
        // What its agents ask you for, answered in the window, filled in there.
        engine.browser.onAsk = { [weak self, weak browser = engine.browser] ask in
            self?.browserAsks.add(ask) { answer in browser?.answer(ask.id, answer) }
        }
        engine.browser.onAskClosed = { [weak self] id in self?.browserAsks.closed(id) }
        engine.onEvent = { [weak self] event in
            self?.workspace.handle(event, machine: machine)
            // It signed in again, or a sign-in ran out and was renewed there: here too.
            if event.type == "credential.updated" { self?.nudgeSignIns(engine) }
        }
        engine.onReconnect = { [weak self] in _ = await self?.workspace.refresh(engine) }
        // Its Settings › Permissions changed: its open sessions follow, and what its group chats
        // and new bots there start with.
        engine.config.onRulesChanged = { [weak self] in
            guard let self else { return }
            workspace.syncPermissions()
            Task {
                await self.boxGroups.giveSettings(to: machine)
                await self.bots.writeKit(on: machine)
            }
        }
        // Its coding agents, beside its engine: their sessions as its engine's, their accounts,
        // models and Custom Auto lists (its own) in its catalog.
        engine.agents.onEvent = { [weak self, weak engine] event in
            // Its group chats, as it runs them.
            if event.type.hasPrefix("kuvo.group.") { self?.boxGroups.handle(event, machine: machine); return }
            engine?.catalog.handle(event)
            self?.workspace.handleAgents(event, machine: machine)
        }
        engine.agents.onConnected = { [weak self, weak engine] in
            guard let self, let engine else { return }
            Task {
                await engine.catalog.refreshAgents()
                _ = await self.workspace.refresh(engine)
                await self.boxGroups.connected(machine)
                // A move of a group chat to or from it cut short, now it's there to finish.
                await self.moves.recover()
            }
        }
        // (Its watch ends with Disconnect and Remove.)
        engine.onStartedElsewhere = { [weak self, weak engine] in
            guard let self, let engine else { return }
            self.connect(engine)
        }
        engine.onExit = { [weak self] in
            self?.workspace.forget(machine)
            self?.boxGroups.disconnected(machine)
            // One way back at a time: a connection lost while one is tried is that one's to retry.
            guard !engine.isRetrying else { return }
            engine.isRetrying = true
            Task { await self?.reconnect(engine) }
        }
        return Task { await start(engine) }
    }

    /// After a dropped connection (the Mac slept, the machine restarted): tries further apart
    /// each time, for half an hour, while its sessions wait.
    private func reconnect(_ engine: MachineEngine) async {
        engine.isRetrying = true
        defer { engine.isRetrying = false }
        await MachineClock.retry(after: [3, 10, 30, 60, 120, 120, 300, 300, 300, 300, 300]) {
            // Connected again some other way (Try Again), or removed (which disconnects it).
            guard case .failed = engine.state else { return true }
            await start(engine)
            return engine.isReady
        }
    }

    private func start(_ engine: MachineEngine) async {
        #if DEBUG
        // KUVO_DEMO_DISCONNECT=<machine>: left as Disconnect leaves it, running on its own: this
        // copy reaches it only through the relay.
        if ProcessInfo.processInfo.environment["KUVO_DEMO_DISCONNECT"] == engine.machine.id {
            engine.startWanted = false
            print("KUVO_DEMO_DISCONNECT left \(engine.machine.id) alone")
            return
        }
        #endif
        // It takes this Mac's accounts and settings, so this Mac's engine comes first.
        for _ in 0..<240 where api == nil { try? await Task.sleep(for: .milliseconds(250)) }
        // Removed a moment ago and added again: after the removal there has finished.
        await machines.waitForRemoval(of: engine.machine.id)
        // Removed, or disconnected, while it started (or since): its connection ended, and nothing
        // of yours goes there.
        guard let connection = await engine.start(machineLaunch(engine), cache: AppInfo.supportDirectory.appending(path: "engine-linux")) else { return }
        await connection.run("connected") { [weak self] in await self?.connected(engine, connection) }.value
    }

    /// What a machine gets once it's connected, and the syncs that keep it current: each for as
    /// long as its connection lasts.
    private func connected(_ engine: MachineEngine, _ connection: MachineConnection) async {
        let machine = engine.machine.id
        // What waits for it (a bot deleted, an integration removed while it was away), now.
        guard await MachineConnection.inTurn([{ await self.machines.runWaiting(only: machine) }]) else { return }
        // Its sessions, once it's up: tried again a few times, as they're what makes them live.
        await MachineClock.retry(after: [0, 2, 5, 10, 20]) { await workspace.refresh(engine) }
        guard await MachineConnection.inTurn([
            // Phones you've paired reach it directly, through its own bridge.
            { await self.phoneLink.sync(engine) },
            // Bots it made, changed or deleted while this Mac was away, taken in (first, so a
            // deleted one's keys don't go back); and what it needs to make them itself.
            { await self.bots.adoptMade(on: machine) },
            // Its worktrees, as it keeps them (some this Mac made there before, handed over once).
            { await self.workspace.takeWorktrees(from: machine) },
            // Its bots' keys of their own are its own: any this Mac kept from before go to it, and
            // its bots' folders' settings follow its integrations as they are now.
            { await BotKeys.applyAll(on: machine, app: self) },
            // Your personalities, its copy and this Mac's met, before its kit says what they are.
            { await self.syncPersonalities(with: engine) },
            { await self.bots.writeKit(on: machine) },
            // Its bots' jobs as their memories there have them now (kept there by the machine
            // itself), so what this Mac writes of them is current.
            { await self.bots.takeJobs(on: machine) },
            // What its bots are, in their folders there, for what runs there without this Mac.
            { await self.bots.describeAll(on: machine) },
            // A move to or from it cut short (the app quit, it went away) is finished or taken back.
            { await self.moves.recover() },
            // What you signed in to here works there too, kept in step while it's connected.
            { await self.syncSignIns(with: engine) },
            { await self.syncSignInFiles(with: engine) },
            { await AgentMail.shared.share(with: engine) },
            { await AgentMail.shared.collect(from: engine) },
            { await AgentMail.shared.deliverWaiting(to: engine) },
            { await self.wakeUps.share(with: engine) },
            { await Utilities.shareTabTidying(on: machine) },
        ]) else { return }
        connection.every(600, "sign-ins", [
            { await self.syncSignIns(with: engine) },
            { await self.syncSignInFiles(with: engine) },
        ])
        connection.every(60, "agents", [
            { await AgentMail.shared.share(with: engine) },
            { await AgentMail.shared.collect(from: engine) },
            // What waited for it and couldn't go as it connected (its coding agents' bridge was
            // still starting): now, not at its next connection.
            { await AgentMail.shared.deliverWaiting(to: engine) },
            { await self.wakeUps.share(with: engine) },
        ])
        // Settings changed here while it connected, after it took the ones it has.
        connection.run("settings") { [weak self] in await self?.keepSettingsCurrent(engine) }
    }

    /// Closes this Mac's connection to a machine. It runs on, as a box of its own: its sessions,
    /// bots, group chats and phone link carry on, and are there when you connect again. (A demo or
    /// test copy's stops, unless a session there is working.)
    func disconnect(_ engine: MachineEngine) {
        engine.startWanted = false
        engine.browser.reset()
        utilities.closeMachineBrowser(engine.machine.id)
        // What runs for its connection ends now, a test copy's too, whose engine stops after.
        engine.endConnection()
        if leavesMachinesRunning || workspace.isRunning(on: engine.machine.id) { engine.disconnect() } else { Task { await engine.shutDown() } }
        workspace.forget(engine.machine.id)
    }

    /// Stops a machine's engine and forgets the machine, and its sessions' tabs with it. Its
    /// sessions stay on the machine, for when it's added again.
    /// A machine found to be another one here at another address: its live views and asks go,
    /// and what's kept under its name is the other's (nothing there is signed out or stopped).
    func machineFolded(_ address: String, into machine: String) {
        browserAsks.closeAll(on: address)
        utilities.closeMachineBrowser(address)
        phoneLink.forget(machine: address)
        workspace.machines = Set(machines.list.map(\.id))
        workspace.fold(address, into: machine)
        // Settings' tabs of the name that went.
        settingsTabs.closeTabs(notOn: Set(machines.list.map(\.id)), machines: machines)
        bots.fold(address, into: machine)
        AgentMail.shared.fold(address, into: machine)
        moves.fold(address, into: machine)
        boxGroups.fold(address, into: machine)
        // Its sessions listed again, now under one name; not connected (its own address doesn't
        // answer): now, at whichever does.
        if let engine = machines.engine(machine) {
            if engine.isReady {
                Task {
                    _ = await workspace.refresh(engine)
                    await AgentMail.shared.deliverWaiting(to: engine)
                }
            } else {
                reconnectNow(engine)
            }
        }
    }

    /// Remove…: the machine off this Mac, running on there as a box of its own, which your phones
    /// keep; `uninstall`, also stopped there, its sign-ins and keys deleted, and gone from your
    /// phones (`Machines.remove`).
    func removeMachine(_ id: String, uninstall: Bool = false) {
        // Left running, as Disconnect leaves it (a test or demo copy's stops).
        if !uninstall, let engine = machines.engine(id) { disconnect(engine) }
        machines.engine(id)?.browser.reset()
        browserAsks.closeAll(on: id)
        utilities.closeMachineBrowser(id)
        machines.remove(id, uninstall: uninstall)
        if uninstall { phoneLink.forget(machine: id) }
        AgentMail.shared.machineRemoved(id)
        workspace.machines = Set(machines.list.map(\.id))
        workspace.forget(id, forGood: true)
        boxGroups.forget(machine: id)
        // Its pages in Settings.
        settingsTabs.closeTabs(notOn: Set(machines.list.map(\.id)), machines: machines)
        // Your others hear of it: one uninstalled stops being their peer (one only removed stays,
        // as your phones keep it); the last gone, no relay for it.
        phoneLink.machinesChanged()
        Task { await moves.machineRemoved(id) }
    }

    /// When the app quits: each machine runs on, as a box of its own. (A demo or test copy's
    /// stops, unless a session there is working.)
    func stopMachines() {
        // Each machine it's connected to, and a demo or test copy's it reached at all: a connection
        // tried starts the box's keeper there.
        let reached = machines.engines.values.filter { engine in
            if engine.isReady { return true }
            guard !leavesMachinesRunning else { return false }
            if case .preparing = engine.state { return engine.isStopped }
            return true
        }
        // Each stopped at once, side by side: quitting waits a few seconds at most (one gone quiet
        // after a sleep, say), not a few seconds for each.
        var stopping: [SSHConnection] = []
        for engine in reached {
            let busy = workspace.isRunning(on: engine.machine.id)
            engine.disconnect()
            if !leavesMachinesRunning && !busy { stopping.append(engine.machine.connection) }
        }
        let stops = stopping
        DispatchQueue.concurrentPerform(iterations: stops.count) { RemoteServer.stopNow(on: stops[$0]) }
    }

    /// What a machine's engine starts with: this Mac's accounts and settings, and the browser tools
    /// with the machine's own browser.
    /// What a machine's engine starts with from this Mac: never its settings or keys, which are
    /// its own (`MachineBox`), but your time zone, its name as you know it, and the browser tools,
    /// with its own integrations' sites.
    func machineLaunch(_ engine: MachineEngine) async -> MachineEngine.Launch {
        var environment: [String: String] = [:]
        // Your time zone, for times its agents bridge says (when a limit resets).
        environment["KUVO_TZ"] = TimeZone.current.identifier
        // Its name as you know it, for what its agents bridge says ("not signed in on …").
        environment["KUVO_MACHINE_NAME"] = engine.machine.name
        // What some providers need until opencode handles it, as on this Mac.
        let compatibility = ProviderCompatibility.config
        if !compatibility.isEmpty { environment["OPENCODE_CONFIG_CONTENT"] = AppModel.merged(compatibility, into: nil) }
        let base = environment["OPENCODE_CONFIG_CONTENT"]
        var launch = MachineEngine.Launch(environment: environment, helper: MachineBrowserInstaller.helper, agents: MachineEngine.agentsBridge)
        launch.seed = { [weak self] in await self?.machineSeed() ?? .init(settings: [:], keys: [:]) }
        launch.fromBox = { settings in
            let sites = Integrations.sites(Integrations.added(inSettings: settings).filter { !Integrations.macOnly.contains($0) })
            return ["OPENCODE_CONFIG_CONTENT": AppModel.merged(MachineBrowserInstaller.engineConfig(sites: sites), into: base)]
        }
        return launch
    }

    /// Starts `engine` over with this Mac's settings as they are now (an integration's key), if
    /// it has older ones, as soon as nothing runs there: checked again while something does, less
    /// often the longer it takes, for as long as it stays connected. (Disconnected, it's checked
    /// again when it connects.)
    private func keepSettingsCurrent(_ engine: MachineEngine) async {
        var wait = 30
        while !Task.isCancelled, engine.isBehind(await machineLaunch(engine)) {
            if !workspace.isRunning(on: engine.machine.id), !boxGroups.isTalking(on: engine.machine.id),
               (try? await engine.api?.activeSessions())?.isEmpty == true {
                // What it answered is this connection's: one closed meanwhile isn't started over.
                guard !Task.isCancelled else { return }
                // Said in the log, so one that keeps starting over is seen there.
                Logger(subsystem: "run.kuvo.code", category: "machine").info("\(engine.machine.id, privacy: .public)'s engine starts over with this Mac's newer settings")
                // Connecting again starts it over with them, in one start (`MachineEngine.start`),
                // its connection, and this with it, ended first.
                engine.disconnect()
                Task { await self.start(engine) }
                return
            }
            await MachineClock.wait(wait)
            wait = min(wait * 2, 120)
        }
    }

    /// Settings changed here (a mode, a permission rule…): the machines connected now take them
    /// as they would the next time they connect, their engines started over with them once nothing
    /// runs there; a moment after the last change, so typing in a field doesn't start one over
    /// for each letter.
    func settingsSaved() {
        settingsSync?.cancel()
        settingsSync = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, !Task.isCancelled else { return }
            // Machines keep their own settings (`MachineBox`): this Mac's stay here. What their
            // group chats go by (Ask First, what's denied).
            boxGroups.settingsChanged()
        }
    }

    /// This Mac's copy of your personalities met with `engine`'s machine's: both end up as one
    /// (see `Personalities`). One that changed here goes to the other machines too, and bots with
    /// it hear its new words.
    func syncPersonalities(with engine: MachineEngine) async {
        guard let met = try? await MachineBox.personalities(Personalities.shared.library, on: engine.machine.connection) else { return }
        let changed = Personalities.shared.take(met)
        guard !changed.isEmpty else { return }
        personalitiesChanged(except: engine.machine.id)
        for id in changed { await bots.personalityChanged(id) }
    }

    /// Your personalities changed here (made, changed or removed, or taken from one machine): the
    /// machines connected now take them, with what their bots and group chats are told.
    func personalitiesChanged(except machine: String? = nil) {
        // Every machine hears it by mail too, connected or not (PROTOCOL.md, "Documents").
        Task { await phoneLink.tellMachines() }
        for engine in machines.engines.values where engine.machine.id != machine {
            // A moment on, the last change's round only.
            engine.activeConnection?.run("personalities") { [weak self] in
                await MachineClock.wait(1)
                guard let self else { return }
                await MachineConnection.inTurn([
                    { await self.syncPersonalities(with: engine) },
                    { await self.bots.writeKit(on: engine.machine.id) },
                    { await self.boxGroups.giveSettings(to: engine.machine.id) },
                ])
            }
        }
    }

    /// What a machine with no settings yet starts with, once (`MachineBox.adopt`): this Mac's
    /// engine settings, minus what only makes sense here, and its integrations' keys. From then
    /// on they're the machine's own, changed in its own tab in Settings.
    func machineSeed() async -> MachineBox.Seed {
        // Web search that works, as on this Mac, unless the file chose otherwise.
        engineConfig.addDefaults()
        var seed: [String: JSONValue] = [:]
        if let data = try? Data(contentsOf: engineConfig.file),
           var settings = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            // A shell or a worktree folder on this Mac means nothing on the machine, nor do
            // integrations that use this Mac's apps.
            for key in ["$schema", "shell", "worktree"] { settings.removeValue(forKey: key) }
            if var mcp = settings["mcp"] as? [String: Any], var servers = mcp["servers"] as? [String: Any] {
                for id in Integrations.macOnly + MCPCatalog.macOnly { servers.removeValue(forKey: id) }
                // Keys there come in files of their own on the machine, not this Mac's.
                servers = Integrations.keyVariables(in: servers) as? [String: Any] ?? servers
                mcp["servers"] = servers
                settings["mcp"] = mcp
            }
            // Slashes as they are: the engine finds `{file:…}` in the text before it reads it.
            // Files brought over from opencode are on this Mac only: their text goes along.
            if let json = try? JSONSerialization.data(withJSONObject: settings, options: [.sortedKeys, .withoutEscapingSlashes]) {
                seed = (try? JSONDecoder().decode([String: JSONValue].self, from: Data(OpencodeImport.inlined(String(decoding: json, as: UTF8.self)).utf8))) ?? [:]
            }
        }
        // Keys you brought for the integrations machines run: not those that stay on this Mac (an
        // app's secret for a sign-in, say), nor bots' own, which reach only their bot's machine
        // (`BotKeys`).
        let here = Set(Integrations.macOnly.map { IntegrationKeys.variable($0, "") })
        let keys = await Task.detached { IntegrationKeys.environment }.value.filter { name, _ in !here.contains { name.hasPrefix($0) } && !IntegrationKeys.isBots(name) }
        return MachineBox.Seed(settings: seed, keys: keys)
    }
}
