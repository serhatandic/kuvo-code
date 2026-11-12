import AppKit
import ClientDesign
import ClientSessions
import OpenCodeKit
import os

extension AppModel {
    /// Connects every machine you've added, each in the background on its own, but one you
    /// disconnected. The connections it began, which a test waits for.
    @discardableResult
    func startMachines() -> [Task<Void, Never>] {
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
        followSessions()
        // A subagent's calls go by the conversation that started it: its folder, its permissions.
        BrowserTools.sessionFolder = { [weak self] session in
            guard let self else { return nil }
            return workspace.session(workspace.root(of: session))?.location.directory
        }
        BrowserTools.readsAnywhere = { [weak self] session in
            guard let self else { return false }
            let root = workspace.root(of: session)
            guard let found = workspace.session(root), !workspace.seats.contains(root) else { return false }
            return [.auto, .fullAccess].contains(ToolApproval.applied(found))
        }
        BrowserTools.isInView = { [weak self] session in self?.utilities.isInView(session) ?? false }
        // Agents writing to each other: this Mac's box answers its conversations' tools, as every
        // box does, and says who there is, for "&".
        if mailTick == nil {
            mailTick = Task {
                while !Task.isCancelled {
                    await AgentMail.shared.tick()
                    try? await Task.sleep(for: .seconds(60))
                }
            }
        }
        BrowserTools.mail = { name, arguments, caller, inView in await AgentMail.shared.call(name, arguments: arguments, caller: caller, inView: inView) }
        // A conversation at work, or waiting for you, keeps its tabs (see `Utilities.tidyAgentTabs`).
        utilities.isBusy = { [weak self] id in
            guard let self else { return false }
            let session = bots.bot(id)?.sessionID ?? id
            return [session, workspace.root(of: session)].contains { workspace.isWorking($0) || workspace.needsAttention($0) }
        }
        // The vault's tools and fills, through this Mac's box.
        wireVault()
        // The browser sends agents from the sites of integrations you added to their tools.
        BrowserTools.integrationSites = { [weak self] in self.map { Integrations.sites(Integrations.added(in: $0.engineConfig)) } ?? [] }
        // An agent showing you a file or folder: in the panel, beside its conversation.
        workspace.onShowInPanel = { [weak self] session, machine, path, isFolder in
            let url = machine.map { RemoteFolder.url(RemoteFolder.folder(path, on: $0)) } ?? URL(filePath: path, directoryHint: isFolder ? .isDirectory : .notDirectory)
            self?.utilities.showInPanel(url, isFolder: isFolder, for: session)
        }
        // An agent asks you for something in its browser: who's asking, and on a machine, the
        // connection that brings the ask here.
        browserAsks.onChange = { [weak self] sessions in self?.workspace.askingInBrowser = sessions }
        browserAsks.conversation = { [weak self] session in self?.workspace.root(of: session) ?? session }
        // A page in this Mac's browser asked for a passkey: an agent's ask for its site says so.
        PasskeyAsks.shared.onAsked = { [weak self] site in self?.browserAsks.passkeyAsked(host: site, machine: nil) }
        workspace.botName = { [weak self] session in self?.bots.bot(forSession: session)?.name }
        workspace.botMachine = { [weak self] session in self?.bots.bot(forSession: session)?.machine }
        // One machine at two addresses: the one added later is one of the other's addresses, and
        // what's kept under its name is the other's.
        machines.onFolded = { [weak self] address, machine in self?.machineFolded(address, into: machine) }
        engineConfig.onRulesChanged = { [weak self] in self?.workspace.syncPermissions() }
        // Each machine's settings are its own: its sessions, bots and group chats go by them.
        EngineConfig.machine = { [weak self] machine in self?.machines.engine(machine)?.config }
        EngineConfig.machines = { [weak self] in self?.machines.engines.values.map(\.config) ?? [] }
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
        // What an agent downloads in this Mac's browser goes in this Mac's record of what agents
        // made, as that conversation's (the browser is in the app, so the app tells its box).
        utilities.agentDownloaded = { [weak self] file, session in
            guard let api = self?.agents.api else { return }
            let body = JSONValue.object(["path": .string(file.path), "session": .string(session), "via": .string("download")])
            Task { _ = try? await api.client.send(try api.client.request("POST", "api/kuvo/artifacts/noted", body: body), as: JSONValue.self) }
        }
        // A machine whose connection dropped while the Mac slept is tried again soon after it
        // wakes, rather than when its next try comes round. (NSWorkspace says so on its own
        // notification center; watched once, though this runs with each start of the engine.)
        if wakeWatch == nil {
            wakeWatch = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.wakeMachines() }
            }
        }
        return machines.engines.values.filter { !$0.isDisconnected }.map { connect($0) }
    }

    /// What waking does: each machine that couldn't connect is tried again in a moment, from the
    /// start of its tries (one waiting minutes for its next is back soon after the network is), a
    /// failure that won't pass by itself too, once (a key in an agent, refused while it was
    /// locked, may work now). Not one whose try is under way.
    func wakeMachines() {
        for engine in machines.engines.values {
            guard case .failed = engine.state, !engine.isDisconnected else { continue }
            retry(engine)
        }
    }

    /// Tries to connect `engine` again by itself, from the first of its waits; a round already
    /// waiting ends.
    private func retry(_ engine: MachineEngine) {
        engine.retryLoop?.cancel()
        engine.retryRound += 1
        let round = engine.retryRound
        engine.isRetrying = true
        engine.retryLoop = Task { await reconnect(engine, round: round) }
    }

    /// No more tries by itself (Disconnect, Remove).
    private func stopRetrying(_ engine: MachineEngine) {
        engine.retryLoop?.cancel()
        engine.retryLoop = nil
        engine.retryRound += 1
        engine.isRetrying = false
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
    /// (reached with your SSH keys, a system its engine runs on), and one already here, at this
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
        connectionClosed(engine.machine.id)
        // COMPAT(0.7 engine-stop): Connect Now starts an engine an older Mac stopped. Goes 3 months after 0.8.0.
        if engine.isStopped { engine.startWanted = true }
        return connect(engine)
    }

    /// Starts engines again, so they take what they read only as they start (accounts brought over
    /// from opencode, say): this Mac's with `mac`, and those of `machines` connected now (each
    /// computer's own settings change only it). Each as soon as nothing's at work in it, now or
    /// when that's done, so no one's work is cut off and nothing waits for you to remember.
    func renewEngines(mac: Bool, machines named: [String] = []) {
        // (Attached in place, this Mac's engine is that box's, which is renewed as a machine's is:
        // the app has none of its own to wait for.)
        if mac, attached == nil { renewals.insert("") }
        for id in named + (mac && attached != nil ? [SSHConnection.thisMac] : []) where machines.engine(id)?.isReady == true { renewals.insert(id) }
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

    /// A session gone (deleted) or put away (archived), here, from a phone or by another Mac:
    /// what's here of it follows.
    func followSessions() {
        workspace.onDeleted = { [weak self] session in
            self?.utilities.closeTabs(of: session)
            // A machine's bot's conversation gone there (carried on with the coding agents from a
            // phone, say): what it has now is read from its box.
            if let self, let machine = bots.list.first(where: { $0.sessionID == session })?.machine {
                Task { await self.bots.refresh(machine) }
            }
            // Its wake-ups and watches go with it.
            if let found = self?.workspace.session(session) { self?.wakeUps.forget(found) } else { self?.wakeUps.forget(sessionID: session) }
        }
        workspace.onArchived = { [weak self] session, archived, carriedTo in
            guard let self else { return }
            if archived {
                // Carried on in another just now (moved to the coding agents by its box): its panel
                // goes with it, its Run still running. Otherwise (one carried on before, brought
                // back and archived again too), out of sight in the archive, nothing of it goes on
                // running in the panel.
                if let carried = carriedTo {
                    utilities.handOver(from: session, to: carried)
                    // Its tab and what you were writing go to the new one too, whoever moved it (a
                    // phone, say): once it's listed here, so its tab has it to show.
                    Task { await self.carriedOn(from: session, to: carried) }
                } else {
                    utilities.closeTerminals(of: session)
                }
            }
            // Its wake-ups wait, and come back with it.
            archivedChanged(session)
        }
    }

    /// A conversation its box carried on in another (moved to the coding agents, from a phone, say):
    /// the new one takes its tab, and what you were writing in it, as when you move it here.
    func carriedOn(from old: String, to new: String) async {
        if workspace.session(new) == nil { await workspace.refreshAgents() }
        _ = tabs.swap(from: old, to: new)
        if Drafts.shared[new].isEmpty, !Drafts.shared[old].isEmpty {
            Drafts.shared[new] = Drafts.shared[old]
            Drafts.shared.remove(old)
        }
    }

    /// A session was archived or brought back (here, from a phone, by another Mac): its wake-ups
    /// wait, or come back, as it is once this runs, so a list read again meanwhile that flipped it
    /// back and forth acts on where it ended up. Archived, its panel's terminals close, and what
    /// runs in them (a dev server holding its port, in a worktree that may be gone) ends with them;
    /// its other tabs stay for when it comes back. (A test waits for it.)
    @discardableResult
    func archivedChanged(_ session: String) -> Task<Void, Never> {
        Task {
            guard let found = workspace.session(session) else { return }
            if Workspace.isArchived(found) { utilities.closeTerminals(of: session) }
            await wakeUps.archived(found, Workspace.isArchived(found))
        }
    }

    // COMPAT(0.7 engine-stop): Start, for an engine an older Mac stopped. Goes 3 months after 0.8.0.
    /// Starts a machine's engine stopped on purpose (Start), and connects to it.
    func startEngine(_ engine: MachineEngine) {
        // (This Mac's own box starts by its own keeper: connected again, as it is.)
        if engine.machine.isThisMac { reconnectNow(engine); return }
        engine.disconnect()
        connectionClosed(engine.machine.id)
        engine.startWanted = true
        connect(engine)
    }

    /// Starts a machine's engine over (its Settings › Engine), and connects to it again. Connect
    /// pressed meanwhile (it shows as not connected while it starts over), Disconnect or Remove
    /// ends it: nothing more of it goes there, and it doesn't connect again itself.
    @discardableResult
    func restartEngine(_ engine: MachineEngine) -> Task<Void, Never> {
        // This Mac's own box restarts by its own keeper, never from the app (which would run it as
        // Kuvo Code's): it's connected again as it is.
        if engine.machine.isThisMac { return reconnectNow(engine) ?? Task {} }
        engine.disconnect()
        connectionClosed(engine.machine.id)
        // Restart asks for it to be connected, as Connect does.
        engine.isDisconnected = false
        engine.restarts += 1
        let round = engine.restarts
        let current = engine.stillWanted()
        let wanted: @Sendable () async -> Bool = { @MainActor in
            guard engine.restarts == round else { return false }
            return await current()
        }
        return Task {
            _ = try? await RemoteServer.restartEngine(on: engine.machine.connection, while: wanted)
            guard await wanted() else { return }
            await connect(engine).value
        }
    }

    // COMPAT(0.7 engine-stop): Connect starts an engine an older Mac stopped. Goes 3 months after 0.8.0.
    /// What Connect does where you pick a machine: one stopped on purpose starts (Start).
    func connectOrStart(_ engine: MachineEngine) {
        if engine.isStopped { startEngine(engine) } else { connect(engine) }
    }

    /// This Mac runs `engine`'s machine from now on (Make This Mac Its Home): the engine another Mac
    /// started there starts again as this Mac's, with this Mac's accounts, and that Mac steps back
    /// the next time it connects. Its sessions, bots and settings stay there. Not while its agents
    /// are at work (they'd stop), nor over a box a newer Kuvo Code set up: why not, then.
    func makeHome(_ engine: MachineEngine) async -> String? {
        let name = engine.machine.name
        // This Mac's own box: making this Mac the main one is the setup's to do (#183), not this.
        if engine.machine.isThisMac { return "This is this Mac’s own box already." }
        guard engine.isReady else { return "\(name) isn’t connected. Connect it first." }
        guard engine.isAnotherMacsEngine else { return nil }
        guard engine.movingHomeFrom == nil else { return "\(name) is moving to this Mac already." }
        if engine.boxIsNewer || engine.engineIsNewer { return "A newer Kuvo Code runs \(name). Update Kuvo Code on this Mac first." }
        let atWork = { [self] () async -> Bool in
            if workspace.isRunning(on: engine.machine.id) { return true }
            return (try? await engine.api?.activeSessions())?.isEmpty == false
        }
        if await atWork() { return "\(name)’s agents are at work. Try again once they’re done." }
        // Asked twice meanwhile (here and from a phone): the first goes on.
        guard engine.movingHomeFrom == nil else { return "\(name) is moving to this Mac already." }
        engine.movingHomeFrom = engine.otherMac ?? .init()
        defer { engine.movingHomeFrom = nil }
        engine.disconnect()
        connectionClosed(engine.machine.id)
        engine.takingHome = true
        await connect(engine).value
        engine.takingHome = false
        // Connected again: as this Mac's, or still the other one's (its agents began meanwhile).
        guard engine.isReady else { return engine.failure.map { "\(name) couldn’t be reached: \($0)" } ?? "\(name) couldn’t be reached. Try again in a moment." }
        guard engine.isAnotherMacsEngine else { return nil }
        return await atWork() ? "\(name)’s agents are at work. Try again once they’re done." : "\(name) couldn’t be started from this Mac. Try again in a moment."
    }

    /// Connects to `engine`'s machine: the start, and what follows it there, which a test waits for.
    @discardableResult
    func connect(_ engine: MachineEngine) -> Task<Void, Never> {
        let machine = engine.machine.id
        engine.isDisconnected = false
        // A start over under way ends: this connection goes on in its place.
        engine.restarts += 1
        // Its pages are the panel's browser tabs while a session there is in view.
        engine.browser.onPages = { [weak self] pages in self?.utilities.syncMachinePages(machine, pages) }
        engine.browser.onActive = { [weak self] page, byAgent, session in self?.utilities.machinePageActive(machine, page: page, byAgent: byAgent, session: session) }
        engine.browser.sessionInView = { [weak self] in self?.utilities.inView.session }
        // What its agents ask you for, answered in the window, filled in there.
        engine.browser.onAsk = { [weak self, weak browser = engine.browser] ask in
            self?.browserAsks.add(ask) { answer in browser?.answer(ask.id, answer) }
        }
        engine.browser.onAskClosed = { [weak self] id in self?.browserAsks.closed(id) }
        engine.browser.onPasskeyAsked = { [weak self, weak browser = engine.browser] host in
            guard let browser else { return }
            self?.browserAsks.passkeyAsked(host: host, machine: browser.machine.id)
        }
        engine.onEvent = { [weak self] event in
            self?.workspace.handle(event, machine: machine)
            // It signed in again, or a sign-in ran out and was renewed there: here too.
            if event.type == "credential.updated" { self?.nudgeSignIns(engine) }
        }
        engine.onReconnect = { [weak self] in _ = await self?.workspace.refresh(engine) }
        // Its Settings › Permissions changed: its open sessions follow. (Its group chats and new
        // bots go by them as its box has them.)
        engine.config.onRulesChanged = { [weak self] in self?.workspace.syncPermissions() }
        // Its coding agents, beside its engine: their sessions as its engine's, their accounts,
        // models and Custom Auto lists (its own) in its catalog.
        engine.agents.onEvent = { [weak self, weak engine] event in
            // Its group chats, as it runs them.
            if event.type.hasPrefix("kuvo.group.") { self?.boxGroups.handle(event, machine: machine); return }
            self?.planLimits.handle(event, machine: machine)
            // This Mac's own box, attached in place: its usage is this Mac's.
            if machine == SSHConnection.thisMac { self?.usageHistory.handle(event) }
            engine?.catalog.handle(event)
            self?.workspace.handleAgents(event, machine: machine)
        }
        engine.agents.onHandoff = { [weak self] handoff in Task { await self?.workspace.openHandoff(handoff) } }
        engine.agents.onConnected = { [weak self, weak engine] in
            guard let self, let engine else { return }
            planLimits.connected(machine, api: engine.agents.api)
            if machine == SSHConnection.thisMac { usageHistory.connected(api: engine.agents.api) }
            Task {
                await engine.catalog.refreshAgents()
                _ = await self.workspace.refresh(engine)
                await self.boxGroups.connected(machine)
                // COMPAT(0.7 mac-group-chats): seats the app's own group chats made before `GroupMigration`. Goes 3 months after 0.8.0.
                // Seats an older version made there for its bots, which its group chats don't use.
                if let api = engine.api { await GroupMigration.dropOrphanSeats(on: machine, api: api) }
                // What it says is moving to or from it.
                await self.moves.reload(machine)
            }
        }
        // (Its watch ends with Disconnect and Remove.)
        engine.onStartedElsewhere = { [weak self, weak engine] in
            guard let self, let engine else { return }
            self.connect(engine)
        }
        engine.onExit = { [weak self] in
            self?.connectionClosed(machine)
            // One way back at a time: a connection lost while one is tried is that one's to retry.
            guard !engine.isRetrying else { return }
            self?.retry(engine)
        }
        return Task {
            await start(engine)
            switch engine.state {
            // Settled by this start (Connect Now while tries waited): they end, and what's shown
            // is how it is now, not "Reconnecting…" until the next try comes round.
            case .ready:
                if engine.isRetrying { stopRetrying(engine) }
            case .failed where !engine.failureMayPass:
                if engine.isRetrying { stopRetrying(engine) }
            // Not reached (the app opened before the network was up, a start over that failed, a
            // Connect Now that didn't get there): tried again as a dropped connection is, from
            // the first of its waits, while what waited for this goes on.
            case .failed:
                retry(engine)
            default:
                break
            }
        }
    }

    /// Who else uses a machine, as its box says (`kuvo/info`'s `macs` and `phones`): your other
    /// Macs, by name, and your phones. What Uninstall would stop it for, so its dialog says so.
    /// And which version its pieces run (`pieces`), for the line under it while one is behind.
    func readAlsoUsedBy(_ engine: MachineEngine) async {
        struct Info: Decodable {
            struct Mac: Decodable { var key: String; var name: String? }
            var macs: [Mac]?
            var phones: Int?
            var pieces: MachinePieces?
            private enum Keys: String, CodingKey { case macs, phones, pieces }
            init(from decoder: any Decoder) throws {
                let info = try decoder.container(keyedBy: Keys.self)
                macs = try info.decodeIfPresent([Mac].self, forKey: .macs)
                phones = try info.decodeIfPresent(Int.self, forKey: .phones)
                // (One it can't read leaves the rest as it is.)
                pieces = try? info.decodeIfPresent(MachinePieces.self, forKey: .pieces)
            }
        }
        guard let info = try? await box(engine.machine.id).value(Info.self, "GET", "kuvo/info") else { return }
        if engine.pieces != info.pieces { engine.pieces = info.pieces }
        // (Which of them is this Mac: its key, as they know it.)
        guard let own = phoneLink.macKey, let macs = info.macs else { return }
        engine.alsoUsedBy = .init(macs: macs.filter { $0.key != own }.map { $0.name ?? "another Mac" }, phones: info.phones ?? 0)
    }

    /// How long a machine coming back may answer without its engine coming up before that's said,
    /// with Try Again (a restart takes a few minutes at most), in seconds.
    static let comingBackFor = 15 * 60

    /// After a dropped connection (the Mac slept, the machine restarted, the network changed):
    /// tries further apart each time, while its sessions wait, and it's connected again the first
    /// time it answers. For as long as it doesn't answer; for a while, while it answers but its
    /// engine doesn't come up (`FailureKind.comingBack`); not again for what trying won't change.
    private func reconnect(_ engine: MachineEngine, round: Int) async {
        defer {
            if engine.retryRound == round {
                engine.isRetrying = false
                engine.retryLoop = nil
            }
        }
        for wait in MachineClock.reconnectWaits {
            await MachineClock.wait(wait)
            guard !Task.isCancelled else { return }
            if let since = engine.comingBackWaited { engine.comingBackWaited = since + wait }
            switch engine.state {
            // Connected again some other way (Connect Now), or disconnected or removed meanwhile.
            case .ready, .preparing: return
            // Connect Now's try under way: how it ends is seen at the next.
            case .starting, .downloading: continue
            case .failed: break
            }
            guard !engine.isRetired, !engine.isDisconnected else { return }
            await start(engine)
            guard !engine.isReady, !Task.isCancelled else { return }
            switch engine.failureKind {
            case .away:
                engine.comingBackWaited = nil
            case .comingBack:
                // Answering, but not coming up, for a while now (over every round of tries):
                // that's said, with Try Again.
                if let since = engine.comingBackWaited, since >= Self.comingBackFor { return }
                engine.comingBackWaited = engine.comingBackWaited ?? 0
            case .lasting:
                return
            }
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
        // KUVO_DEMO_MACHINE: a stand-in shows its state, and nothing goes to it (`DemoMachines`).
        if let standIn = DemoMachines.standIn(engine.machine.id) {
            engine.showStandIn(standIn.status)
            return
        }
        #endif
        // It takes this Mac's accounts and settings, so this Mac's engine comes first; attached to
        // the box already here, there's none of the app's own to wait for.
        for _ in 0..<240 where api == nil && attached == nil { try? await Task.sleep(for: .milliseconds(250)) }
        // Removed a moment ago and added again: after the removal there has finished.
        await machines.waitForRemoval(of: engine.machine.id)
        // Disconnected while it waited (its tries ended): nothing goes there.
        guard !Task.isCancelled, !engine.isDisconnected else { return }
        // Removed, or disconnected, while it started (or since): its connection ended, and nothing
        // of yours goes there.
        guard let connection = await engine.start(machineLaunch(engine), cache: AppInfo.supportDirectory.appending(path: "engine-linux")) else { return }
        #if DEBUG
        // KUVO_DEMO_AWAY=<machine>: a few seconds after it connected (its accounts are read as it
        // connects), disconnected as Disconnect does, so its pages show it away, as last seen.
        if ProcessInfo.processInfo.environment["KUVO_DEMO_AWAY"] == engine.machine.id {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(5))
                self?.disconnect(engine)
            }
        }
        #endif
        await connection.run("connected") { [weak self] in await self?.connected(engine, connection) }.value
    }

    /// What a machine gets once it's connected, and the syncs that keep it current: each for as
    /// long as its connection lasts.
    private func connected(_ engine: MachineEngine, _ connection: MachineConnection) async {
        let machine = engine.machine.id
        // This Mac's own box, attached in place: its engine is this Mac's, at once.
        if engine.machine.isThisMac { thisMacsBoxConnected(engine) }
        // What waits for it (a bot deleted, an integration removed while it was away), now.
        guard await MachineConnection.inTurn([{ await self.machines.runWaiting(only: machine) }]) else { return }
        // Its sessions, once it's up: tried again a few times, as they're what makes them live.
        await MachineClock.retry(after: [0, 2, 5, 10, 20]) { await workspace.refresh(engine) }
        engine.sessionsRead()
        guard await MachineConnection.inTurn([
            // Phones you've paired reach it directly, through its own bridge; then who else uses it.
            {
                await self.phoneLink.sync(engine)
                await self.readAlsoUsedBy(engine)
            },
            // Its worktrees, as it keeps them (some this Mac made there before, handed over once).
            { await self.workspace.takeWorktrees(from: machine) },
            // COMPAT(0.7 mac-git-settings): Settings › Git as this Mac kept it before, to its box once. Goes 3 months after 0.8.0.
            { await GitPreferences.move(to: self.box(machine)) },
            // Its bots' keys of their own are its own: any this Mac kept from before go to it, and
            // its bots' folders' settings follow its integrations as they are now.
            { await BotKeys.applyAll(on: machine, app: self) },
            // Your personalities, its copy and this Mac's met, before its kit says what they are.
            { await self.syncPersonalities(with: engine) },
            { await self.bots.writeKit(on: machine) },
            // Its bots as its box keeps them, with what you changed of them while it was away.
            { await self.bots.refresh(machine) },
            // What it says is moving to or from it.
            { await self.moves.reload(machine) },
            // What you signed in to here works there too, kept in step while it's connected. (This
            // Mac's own box, attached, is where this Mac's sign-ins are: none to bring.)
            { if !engine.machine.isThisMac { await self.syncSignIns(with: engine) } },
            { if !engine.machine.isThisMac { await self.syncSignInFiles(with: engine) } },
            { await self.wakeUps.share(with: engine) },
            // Its vault, read as it connects: an older copy of its files put back while it was
            // away is caught now, not only when its page is opened.
            { await Vaults.shared.refresh(machine) },
            { await Utilities.shareTabTidying(on: machine) },
            // What its bots ask you (making a project), then followed while it's connected.
            { await self.botAsks.read(machine) },
            // Its bots' goals, the same way.
            { await self.goalPlans.read(machine) },
        ]) else { return }
        if !engine.machine.isThisMac {
            connection.every(600, "sign-ins", [
                { await self.syncSignIns(with: engine) },
                { await self.syncSignInFiles(with: engine) },
            ])
        }
        connection.every(60, "wake-ups", [
            { await self.wakeUps.share(with: engine) },
        ])
        // Settings changed here while it connected, after it took the ones it has.
        connection.run("settings") { [weak self] in await self?.keepSettingsCurrent(engine) }
        // Its bots, followed while it's connected: made, changed or deleted there (from a phone, say).
        connection.run("bots") { [weak self] in await self?.bots.follow(machine) }
        connection.run("bot-asks") { [weak self] in await self?.botAsks.follow(machine) }
        // What its agents ask to run outside its sandbox, followed while it's connected.
        connection.run("sandbox-asks") { await Sandboxes.shared.follow(machine) }
        connection.run("goal-plans") { [weak self] in await self?.goalPlans.follow(machine) }
        // What its bots do to the sessions they oversee, as they do it.
        connection.run("oversight") { [weak self] in await self?.botOversight.follow(machine) }
        // What it told you (its runs' news, its group chats', what its agents sent you), shown here.
        connection.run("notices") { [weak self] in await self?.boxNotices.follow(machine) }
        // What its sessions left running, as its box says.
        connection.run("background") { [weak self] in await self?.workspace.followBackground(machine) }
        // Its projects as its box has them, changed from a phone too.
        connection.run("projects") { [weak self] in await self?.workspace.followProjects(on: machine) }
        // This Mac's own box, attached in place: what the app's own box is followed for as it runs
        // is followed there too (its wake-ups and worktrees, and your personalities, which it keeps
        // for this Mac), read now and then as it answers once a read.
        if engine.machine.isThisMac {
            connection.run("follow-wakes") { [weak self] in await self?.wakeUps.follow(on: machine) }
            connection.run("follow-worktrees") { [weak self] in await self?.workspace.followWorktrees(on: machine) }
            connection.run("follow-personalities") { await Personalities.shared.follow() }
        }
    }

    /// Closes this Mac's connection to a machine. It runs on, as a box of its own: its sessions,
    /// bots, group chats and phone link carry on, and are there when you connect again. (A demo or
    /// test copy's stops, unless a session there is working.)
    func disconnect(_ engine: MachineEngine) {
        // The window is on this Mac's own box: it stays connected.
        guard !engine.machine.isThisMac else { return }
        engine.startWanted = false
        engine.isDisconnected = true
        // It isn't tried again by itself now, nor does Settings offer Connect Now for it.
        stopRetrying(engine)
        engine.browser.reset()
        utilities.closeMachineBrowser(engine.machine.id)
        // What runs for its connection ends now, a test copy's too, whose engine stops after.
        engine.endConnection()
        // (This Mac's own box runs this Mac: never stopped from here.)
        if leavesMachinesRunning || engine.machine.isThisMac || workspace.isRunning(on: engine.machine.id) { engine.disconnect() } else { Task { await engine.shutDown() } }
        connectionClosed(engine.machine.id)
    }

    /// Its connection closed here, lost or on purpose: its sessions' live state goes, and its group
    /// chats show as last seen, nothing talking, until it's back.
    private func connectionClosed(_ machine: String) {
        workspace.forget(machine)
        boxGroups.disconnected(machine)
        planLimits.stopped(machine)
    }

    /// Stops a machine's engine and forgets the machine, and its sessions' tabs with it. Its
    /// sessions stay on the machine, for when it's added again.
    /// A machine found to be another one here at another address: its live views and asks go,
    /// and what's kept under its name is the other's (nothing there is signed out or stopped).
    func machineFolded(_ address: String, into machine: String) {
        browserAsks.closeAll(on: address)
        utilities.closeMachineBrowser(address)
        planLimits.stopped(address)
        phoneLink.forget(machine: address)
        workspace.machines = Set(machines.list.map(\.id))
        workspace.fold(address, into: machine)
        // Settings' tabs of the name that went.
        settingsTabs.closeTabs(notOn: Set(machines.list.map(\.id)), machines: machines)
        bots.fold(address, into: machine)
        boxGroups.fold(address, into: machine)
        // Its sessions listed again, now under one name; not connected (its own address doesn't
        // answer): now, at whichever does.
        if let engine = machines.engine(machine) {
            if engine.isReady {
                Task { _ = await workspace.refresh(engine) }
            } else {
                reconnectNow(engine)
            }
        }
    }

    /// Remove…: the machine off this Mac, running on there as a box of its own, which your phones
    /// keep; `uninstall`, also stopped there, its sign-ins and keys deleted, and gone from your
    /// phones (`Machines.remove`).
    func removeMachine(_ id: String, uninstall: Bool = false) {
        // This Mac's own box runs this Mac: it isn't removed from here.
        guard id != SSHConnection.thisMac else { return }
        planLimits.stopped(id)
        // Left running, as Disconnect leaves it (a test or demo copy's stops).
        if !uninstall, let engine = machines.engine(id) { disconnect(engine) }
        closeAll(on: id)
        machines.remove(id, uninstall: uninstall)
        if uninstall { phoneLink.forget(machine: id) } else { phoneLink.machineRemoved(id) }
        forgetAll(of: id)
        // Your others hear of it: one uninstalled stops being their peer (one only removed stays,
        // as your phones keep it); the last gone, no relay for it.
        phoneLink.machinesChanged()
        moves.forget(id)
    }

    /// What's open here on machine `id`, closed: its browser, browser asks and terminals.
    func closeAll(on id: String) {
        if let engine = machines.engine(id) {
            stopRetrying(engine)
            engine.browser.reset()
        }
        browserAsks.closeAll(on: id)
        utilities.closeMachineBrowser(id)
        utilities.closeTerminals(on: id)
        mainTerminals.close(on: id)
    }

    /// What this Mac keeps of machine `id` (once it's off the list), forgotten: its sessions and
    /// their tabs, group chats, vault and sandbox, and its pages in Settings.
    func forgetAll(of id: String) {
        workspace.machines = Set(machines.list.map(\.id))
        workspace.forget(id, forGood: true)
        boxGroups.forget(machine: id)
        Vaults.shared.forget(id)
        Sandboxes.shared.forget(id)
        // Its pages in Settings.
        settingsTabs.closeTabs(notOn: Set(machines.list.map(\.id)), machines: machines)
    }

    /// When the app quits: each machine runs on, as a box of its own. (A demo or test copy's
    /// stops, unless a session there is working.)
    func stopMachines() {
        // Each machine it's connected to, and a demo or test copy's it reached at all: a connection
        // tried starts the box's keeper there.
        let reached = machines.engines.values.filter { engine in
            if engine.isReady { return true }
            guard !leavesMachinesRunning else { return false }
            // COMPAT(0.7 engine-stop): an engine an older Mac stopped counts as stopped here. Goes 3 months after 0.8.0.
            if case .preparing = engine.state { return engine.isStopped }
            return true
        }
        // Each stopped at once, side by side: quitting waits a few seconds at most (one gone quiet
        // after a sleep, say), not a few seconds for each.
        var stopping: [SSHConnection] = []
        for engine in reached {
            let busy = workspace.isRunning(on: engine.machine.id)
            engine.disconnect()
            if !leavesMachinesRunning && !busy && !engine.machine.isThisMac { stopping.append(engine.machine.connection) }
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
        // (What some providers need from its engine, it adds itself: its box learns it.)
        var launch = MachineEngine.Launch(environment: environment, helper: MachineBrowserInstaller.helper, agents: MachineEngine.agentsBridge)
        launch.seed = { [weak self] in try await self?.machineSeed() ?? .init(settings: [:], keys: [:]) }
        launch.fromBox = { settings in
            let sites = Integrations.sites(Integrations.added(inSettings: settings).filter { !Integrations.macOnly.contains($0) })
            return ["OPENCODE_CONFIG_CONTENT": AppModel.merged(MachineBrowserInstaller.engineConfig(sites: sites), into: nil)]
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
                // its connection, and this with it, ended first; tried again by itself if that
                // start fails, as a dropped connection is.
                engine.disconnect()
                connect(engine)
                return
            }
            await MachineClock.wait(wait)
            wait = min(wait * 2, 120)
        }
    }

    /// This Mac's copy of your personalities met with `engine`'s machine's: both end up as one
    /// (see `Personalities`). One that changed here goes to the other machines too, and bots with
    /// it hear its new words.
    func syncPersonalities(with engine: MachineEngine) async {
        // This Mac's own box, attached in place, keeps the library this Mac shows (`Personalities.box`):
        // read, not met with itself.
        if engine.machine.isThisMac {
            await Personalities.shared.refresh()
            return
        }
        guard let met = try? await MachineBox.personalities(Personalities.shared.library, on: engine.machine.connection) else { return }
        // Where this Mac keeps them: what changed there is told (`Personalities.onChange`).
        await Personalities.shared.take(met)
    }

    /// Your personalities changed here (made, changed or removed, or taken from one machine): the
    /// machines connected now take them, with what their bots and group chats are told.
    func personalitiesChanged(except machine: String? = nil) {
        // (Every machine hears it by mail too, connected or not: this Mac's box tells them,
        // PROTOCOL.md "Documents".)
        // This Mac's bots with one of them are told what it is now, by its box. (Its group chats
        // hear it from its box too.)
        bots.personalitiesChanged()
        for engine in machines.engines.values where engine.machine.id != machine {
            // A moment on, the last change's round only.
            engine.activeConnection?.run("personalities") { [weak self] in
                await MachineClock.wait(1)
                guard let self else { return }
                await MachineConnection.inTurn([
                    { await self.syncPersonalities(with: engine) },
                    { await self.bots.writeKit(on: engine.machine.id) },
                ])
            }
        }
    }

    /// What a machine with no settings yet starts with, once (`MachineBox.adopt`): this Mac's
    /// engine settings, minus what only makes sense here, and its integrations' keys. From then
    /// on they're the machine's own, changed in its own tab in Settings.
    /// Refused while this Mac's settings can't be read (its box isn't up): a copy of nothing would
    /// stay the machine's for good.
    func machineSeed() async throws -> MachineBox.Seed {
        await prepareSettings()
        guard engineConfig.isLoaded else {
            throw MachineBox.Failure.refused("This Mac’s settings can’t be read now, and a new machine starts with a copy of them. Try again in a moment.")
        }
        var seed: [String: JSONValue] = [:]
        if engineConfig.isLoaded, engineConfig.problem == nil, let data = try? JSONEncoder().encode(engineConfig.settings),
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
