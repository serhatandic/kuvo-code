import ClientDesign
import ClientSandbox
import ClientSessions
import ClientText
import Foundation
import KuvoLink
import OpenCodeKit
import os

private let log = Logger(subsystem: "run.kuvo.code", category: "workspace")

/// Projects and their sessions, kept live from engine events.
@Observable
final class Workspace {
    /// This Mac's engine.
    var api: OpenCodeAPI? {
        // The engine started again (it stopped, or you restarted it): this Mac's open
        // conversations go on through the new one, as a machine's do when it reconnects, and
        // read it again once it's live.
        didSet {
            guard let api, let oldValue, oldValue.client.endpoint != api.client.endpoint else { return }
            for model in models.values where !RemoteFolder.isRemote(model.session.location.directory) && !OutsideAgents.isAgentSession(model.session) { model.reconnect(api) }
        }
    }
    /// The main window's tabs, where a fork and a move to the coding agents open (the app sets it;
    /// none in a test of the workspace alone).
    @ObservationIgnored weak var tabs: WindowTabs?

    /// The agents bridge: sessions with Claude Code, Codex, Cursor, Grok and Antigravity go to it,
    /// whatever their folder (on this Mac).
    @ObservationIgnored var agents: OutsideAgents?

    /// A machine's coding agents (the agents bridge beside its engine), by the machine's name.
    @ObservationIgnored var machineAgents: (String) -> OutsideAgents? = { _ in nil }

    /// A conversation's goal, as its computer's agents bridge runs it (where its folder is now), and
    /// its asks settled with no event for them; and what its box says it is.
    private func followGoals(of model: SessionModel) {
        model.listKind = { [weak self, weak model] in model.flatMap { self?.listKind(of: $0.session) } }
        model.goalBridge = { [weak self, weak model] in model.flatMap { self?.agents(forFolder: $0.session.location.directory) } }
        // An ask found settled without a word of it (answered elsewhere first): off the Dock's
        // count and the notifications too.
        model.askSettled = { [weak self] request in
            self?.sharedForms[request] = nil
            self?.settled(request)
        }
    }

    /// The agents bridge a folder's sessions with the coding agents run in: its machine's, or
    /// this Mac's.
    func agents(forFolder folder: String) -> OutsideAgents? {
        if let machine = RemoteFolder.machine(of: folder) { return machineAgents(machine) }
        return agents
    }

    /// A machine's engine, by its name, for projects on it (folders written `ssh://machine/path`).
    @ObservationIgnored var machineAPI: (String) -> OpenCodeAPI? = { _ in nil }
    /// The machine each session's events came from, for sessions without a row (a subagent's).
    @ObservationIgnored private var sessionMachines: [String: String] = [:]
    /// From a box that keeps them to their end, those heard asked that it hasn't listed yet (it lists
    /// each as it hears it): until it does, one is yours should it go quiet first, as nothing would
    /// list it, and told then.
    @ObservationIgnored private var heardUnlisted: [String: PermissionRequest] = [:]
    /// Machines' sessions as last seen, kept across launches so their tabs wait for the machine
    /// to connect instead of closing.
    @ObservationIgnored private var remoteSessions: [String: RemoteSession] = {
        let sessions = Workspace.loadRemoteSessions()
        // Their conversations as last seen, for those tabs meanwhile, and this Mac's sessions';
        // the rest are gone.
        SessionCopies.keep(Set(sessions.keys).union(SessionCopies.localSessions().map(\.id)))
        return sessions
    }()
    /// The machines whose sessions are in the lists.
    private(set) var connectedMachines: Set<String> = []
    /// The machines you've added. A removed machine's projects leave the sidebar but keep their
    /// settings, for when it's added again.
    var machines: Set<String> = [] {
        didSet {
            removedMachines.subtract(machines)
            projectsChanged()
            for machine in machines.subtracting(oldValue) { showLastSeen(machine) }
        }
    }

    struct RemoteSession: Codable {
        var machine: String
        var title: String?
    }

    /// The machine a session is on, while that machine isn't connected; nil once it is (or
    /// for this Mac's sessions, or a machine you removed, which nothing waits for).
    func waitingMachine(for id: String) -> String? {
        // A bot's knows its machine, also before its sessions there were ever listed here.
        guard let machine = session(id).flatMap({ RemoteFolder.machine(of: $0.location.directory) }) ?? remoteSessions[id]?.machine ?? botMachine?(id),
              !removedMachines.contains(machine), !connectedMachines.contains(machine) else { return nil }
        return machine
    }

    /// The machine a bot's conversation lives on, by its session (nil for one on this Mac, or not
    /// a bot's). The app sets it.
    @ObservationIgnored var botMachine: ((String) -> String?)?

    /// A machine's sessions as last seen, in the lists until it connects.
    private func showLastSeen(_ machine: String) {
        // What its box last said its sessions are, for their places in the sidebar meanwhile.
        if sessionLists[machine] == nil, let kept = SessionCopies.list(of: machine) { sessionLists[machine] = kept }
        guard !connectedMachines.contains(machine), !sessions.contains(where: { RemoteFolder.machine(of: $0.location.directory) == machine }) else { return }
        var seen = SessionCopies.sessions(of: machine).filter { !isHidden($0) }
        for session in seen { sessionMachines[session.id] = machine }
        // Read while it was away, before a quit: read here too.
        for index in seen.indices {
            if let idle = unsentViews[seen[index].id], (seen[index].time.viewed ?? 0) < idle { seen[index].time.viewed = idle }
        }
        sessions += seen
    }

    /// A waiting session's title, as last seen.
    func remoteTitle(_ id: String) -> String? {
        remoteSessions[id]?.title ?? botName?(id)
    }

    /// The engine a folder's sessions run on: its machine's, or this Mac's.
    func api(forFolder folder: String) -> OpenCodeAPI? {
        if let machine = RemoteFolder.machine(of: folder) { return machineAPI(machine) }
        // (Attached in place, this Mac's folders are its box's: there's no engine of the app's own.)
        if BoxClient.thisMac != BoxClient.mac { return machineAPI(BoxClient.thisMac) }
        return api
    }

    /// The engine a session runs on.
    func api(forSession id: String) -> OpenCodeAPI? {
        if let session = session(id) { return api(for: session) }
        // One an agents bridge told of before it has a row (made on your phone, say): the
        // bridge of the machine its events came from, or this Mac's.
        if bridgeSessions.contains(id) { return sessionMachines[id].map { machineAgents($0)?.api } ?? agents?.api }
        if let machine = sessionMachines[id] { return machineAPI(machine) }
        return api
    }

    /// Sessions the agents bridge has told of: theirs, wherever they were made.
    @ObservationIgnored private var bridgeSessions: Set<String> = []

    /// An event from an agents bridge (this Mac's, or `machine`'s): its session is the bridge's.
    func handleAgents(_ event: ServerEvent, machine: String? = nil) {
        if let id = event.sessionID ?? Self.formSessionID(event) { bridgeSessions.insert(id) }
        handle(event, machine: machine)
    }

    /// What a session runs on: its folder's agents bridge for an outside agent's, else its
    /// folder's engine.
    func api(for session: Session) -> OpenCodeAPI? {
        OutsideAgents.isAgentSession(session) ? agents(forFolder: session.location.directory)?.api : api(forFolder: session.location.directory)
    }

    /// This Mac's as last listed until its engine lists them (it takes a moment to start), so the
    /// sidebar and the conversation open at launch show at once.
    private(set) var sessions: [Session] = SessionCopies.localSessions() {
        didSet {
            // (A row of one where it lives now just came: the one from the box it left goes.)
            leaveOutMovedAway()
            projectsChanged()
            if isLoaded { keepLocalList() }
        }
    }
    private(set) var running: Set<String> = [] {
        // While one runs on this Mac, it stays awake (unless you turned that off).
        didSet { Awake.shared.agentsWork(running.contains { id in sessionMachines[id] == nil && !(session(id).map { RemoteFolder.isRemote($0.location.directory) } ?? false) }) }
    }
    /// Folders the user opened, even before they have sessions.
    /// A bot's own folder was kept as one by mistake once: it isn't one.
    private(set) var folders: [String] = (UserDefaults.standard.stringArray(forKey: "projectFolders") ?? []).filter { !Workspace.isBotFolder($0) } {
        didSet { projectsChanged() }
    }
    /// Names and other folders of projects, by their primary folder.
    private(set) var settings: [String: ProjectSettings] = Workspace.loadSettings() {
        didSet { projectsChanged() }
    }
    /// Sessions' own git worktrees, by the folder their sessions run in.
    private(set) var worktrees: [String: Worktree] = Workspace.loadWorktrees() {
        didSet {
            worktreesChanged &+= 1
            projectsChanged()
        }
    }
    /// How many times `worktrees` changed: a read of a box's worktrees from before a change since
    /// isn't taken (`takeWorktrees`).
    @ObservationIgnored private var worktreesChanged = 0
    /// The projects of worktrees removed since, by the folder their sessions ran in: an archived
    /// session there still belongs to its project, and comes back to it if you restore it.
    private var removedWorktrees: [String: String] = UserDefaults.standard.dictionary(forKey: "removedWorktrees") as? [String: String] ?? [:] {
        didSet { projectsChanged() }
    }
    /// Worktrees their box removed once their sessions were archived, which can come back, by the
    /// folder their sessions ran in: shown on a session there (Restore or Continue).
    private(set) var restorableWorktrees: [String: RestorableWorktree] = [:]
    /// Being deleted, until its engine answers: out of the sidebar meanwhile (a running one stops
    /// first, a machine's is over SSH), back if it's refused.
    private(set) var deleting: Set<String> = [] {
        didSet { projectsChanged() }
    }
    private(set) var isLoaded = false {
        didSet { if isLoaded { for waiter in loadWaiters.values { waiter.resume() }; loadWaiters = [:] } }
    }
    @ObservationIgnored private var loadWaiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    /// Once its conversations are first loaded from this Mac's engine, or `seconds` have passed.
    func firstLoad(within seconds: Double) async {
        guard !isLoaded else { return }
        let id = UUID()
        await withCheckedContinuation { continuation in
            loadWaiters[id] = continuation
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(seconds))
                self?.loadWaiters.removeValue(forKey: id)?.resume()
            }
        }
    }

    /// Each open conversation's model, made the first time it's asked for: a cache, not what a
    /// view follows (views follow the model itself). Followed, keeping a new one would tell the
    /// window as it's kept, which asks for it again before it's there and keeps a second, empty
    /// one on screen while the conversation goes to the first.
    @ObservationIgnored private var models: [String: SessionModel] = [:]
    /// Current git branch per project folder, when it has one.
    private(set) var branches: [String: String] = [:]
    /// The repository's main branch per project folder, when git knows it.
    private(set) var defaultBranches: [String: String] = [:]
    /// Open permission requests and questions, by ID, with the session they're for.
    private(set) var asking: [String: String] = [:]
    /// What MCP servers ask (in `asking` with the session waiting on it), by form: the folder
    /// the engine files each under, which answering it takes.
    @ObservationIgnored private(set) var sharedForms: [String: String] = [:]
    /// Sessions whose agent asks you for something in its browser (a sign-in, a code, a step).
    var askingInBrowser: Set<String> = []
    /// Conversations asking you before they do something (a bot making a project).
    var askingForWork: Set<String> = []
    /// Conversations asking to run a command outside their computer's sandbox.
    var askingOutsideSandbox: Set<String> = []
    /// Bots' conversations whose goal card waits for you.
    var goalCards: Set<String> = []

    /// Sessions that finished while you were elsewhere, or wait for your answer: the
    /// number on the Dock icon. A subagent's ask is its session's.
    var waitingCount: Int {
        let askers = Set(asking.values.map(root(of:))).union(askingInBrowser.map(root(of:))).union(askingForWork).union(askingOutsideSandbox).union(goalCards).subtracting(seats)
        return Set(sessions.filter { $0.isUnread && !isListedArchived($0) }.map(\.id)).union(askers).count
    }

    struct Project: Identifiable, Hashable {
        /// The primary folder: sessions run here.
        var directory: String
        var sessions: [Session]
        var settings = ProjectSettings()

        var id: String { directory }
        var name: String { settings.name ?? (directory as NSString).lastPathComponent }
        /// Every folder, the primary one first.
        var allFolders: [String] { [directory] + settings.folders }
    }

    /// What a project has beyond its primary folder.
    struct ProjectSettings: Codable, Hashable {
        /// Shown instead of the folder's name.
        var name: String?
        /// Other folders the agent works with, besides the primary one.
        var folders: [String] = []
        /// What Run (⌘R) runs in a terminal: a dev server, say.
        var run: String?
    }

    /// A copy of a project for sessions to work in apart from the rest: a git worktree of its
    /// repository, on a branch of its own.
    struct Worktree: Codable, Hashable {
        /// The project's primary folder.
        var project: String
        /// The worktree's top folder. Sessions run in the same place in it as the project's
        /// folder is in its repository.
        var root: String
        var branch: String
        /// What the project's folder had checked out when it was made: what it merges back into.
        var base: String?
    }

    /// The project each worktree folder belongs to, by the folder its sessions run in, as each box
    /// says (`worktrees` in `kuvo/projects`): the rule every client files sessions by.
    private var boxWorktreeProjects: [String: String] = [:] {
        didSet { projectsChanged() }
    }

    // MARK: Session lists

    /// Each box's session list (`kuvo/sessions/list`, PROTOCOL.md "Session lists"), by box: what
    /// each of its sessions is (a project's, a chat, a bot's, a seat, a subagent's) and the project
    /// it's filed under, as its box says, which the sidebar's projects and chats are drawn from. Kept
    /// across launches and while a machine is away, as its sessions are (`SessionCopies`).
    private(set) var sessionLists: [String: SessionLists.Listing] = [BoxClient.mac: SessionCopies.list(of: BoxClient.mac) ?? .init()] {
        didSet { projectsChanged() }
    }

    /// Where each box's session list is read, where a test gives it apart from `boxes` (whose other
    /// routes it leaves as they are); nil, as in the app: `boxes`.
    @ObservationIgnored var sessionListBoxes: ((String) -> BoxClient?)?

    private func listBox(_ box: String) -> BoxClient? {
        (sessionListBoxes ?? boxes)?(box)
    }

    /// Whether `box` has said what its sessions are (here or before this launch): until then its
    /// projects and chats aren't known, rather than none.
    func isListed(_ box: String) -> Bool {
        sessionLists[box]?.isRead == true
    }

    /// Boxes from before they listed their sessions (`sessions.list` isn't among their features):
    /// none of their sessions is drawn while the update gate brings them up to date (`BoxGates`,
    /// which the sidebar says). Asked again now and then, as it may be updated meanwhile.
    private(set) var outdatedLists: Set<String> = []

    /// What each box says it has (`kuvo/info`'s `features`), read through `boxes`: the app's one
    /// reader of them (`AppModel.boxFeatures`), which tells the update gate what each says
    /// (`AppModel.wireStores`). This Mac's own box, of this version, has them all.
    @ObservationIgnored private(set) lazy var features = BoxFeatures(hasEverything: BoxClient.hasEveryFeature) { [weak self] id in
        guard let box = self?.boxes?(id) else { throw CancellationError() }
        return try await box.send("GET", "kuvo/info")
    }

    /// Whether `box` is held for its update now (`BoxGates`): what it has is asked again each time.
    @ObservationIgnored var isHeld: (String) -> Bool = { _ in false }

    /// Whether `box` lists its sessions, as it says of itself: noted (`outdatedLists`); nil where it
    /// can't be asked now. What it says it has goes to the update gate (`features`), against all
    /// the app needs (`BoxGate.required`), not only its lists. `again`: asked again whatever it said.
    private func checkLists(on box: String, again: Bool = false) async -> Bool? {
        if BoxClient.hasEveryFeature(box) { return true }
        guard boxes?(box) != nil else { return false }
        let said: Set<String>?
        // (One that said it didn't, or is held, asked again: it may have been updated since.)
        if again || outdatedLists.contains(box) || isHeld(box) {
            if case .has(let now) = await features.readAgain(box) { said = now } else { said = nil }
        } else {
            said = await features.features(of: box)
        }
        guard let said else { return nil }
        let lists = said.contains(SessionLists.feature)
        if lists { outdatedLists.remove(box) } else { outdatedLists.insert(box) }
        return lists
    }

    /// `box` is up to date now (the update gate let it go): what it has is asked again, and its
    /// list read at once.
    func boxUpdated(_ box: String) {
        features.forget(box)
        outdatedLists.remove(box)
        if !BoxClient.streams(box), !isRemoved(box) { Task { await readSessionList(on: box) } }
    }

    /// Where `session` shows in the sidebar, as its box says (folders as named here): in its
    /// project, in Chats, or nowhere (a bot's, a seat, one archived, one its box hasn't listed).
    private func listPlace(of session: Session) -> SessionLists.Place? {
        let box = Self.box(of: session.location.directory)
        // A box from before it listed them: none drawn (the sidebar says to update it).
        if outdatedLists.contains(box) { return nil }
        // A machine its box hasn't answered for since this update (away at the first launch with
        // it): its sessions as last seen, where this Mac filed them before, until its box says.
        guard let listing = sessionLists[box] else { return lastFiled(session) }
        let place = SessionLists.place(of: listing.facts(of: session.id))
        if case .project(let project) = place { return .project(Self.here(project, on: box)) }
        return place
    }

    /// Where this Mac filed `session` before its box said (`listPlace`, for a machine away at the
    /// first launch since this update): the rule it went by then.
    private func lastFiled(_ session: Session) -> SessionLists.Place? {
        guard !Self.isArchived(session), !botSessions.contains(session.id), !Self.isBotFolder(session.location.directory), !isHidden(session) else { return nil }
        return Self.isChat(session) ? .chat : .project(projectDirectory(of: session))
    }

    /// A session `box` just made, shown at once where its start answer says (in Chats, or in the
    /// project of its worktree, else `project`'s), until its list says. (A box not listed yet: its sessions
    /// show as last filed, this one with them.)
    private func noteMade(_ session: Session, as started: SessionStart.Started, in project: String, on box: String) {
        guard var listing = sessionLists[box] else { return }
        let filed = started.worktree?.project ?? Self.onBox(projectDirectory(project))
        listing.noteMade(session.id, facts: .init(kind: started.isChat ? .chat : .project, project: started.isChat ? nil : filed, directory: Self.onBox(session.location.directory),
                                                  title: session.title, created: session.time.created, updated: session.time.updated))
        sessionLists[box] = listing
    }

    /// This Mac's sessions, not a machine's, unused since `cutoff` (ms), oldest first: what Settings ›
    /// Storage offers to delete. Only those its box lists as people's conversations (a project's, a
    /// chat): never a bot's (the bot lives on in it, wake-ups and all, however long it's been quiet),
    /// a seat or a subagent's, nor one its box hasn't listed; nor one at work, one with a message you
    /// started writing, or (`keepsPinned`) one pinned.
    func oldSessions(unusedSince cutoff: Double, keepsPinned: Bool) -> [Session] {
        let deletable: Set<SessionLists.Kind> = [.project, .chat]
        return sessions
            .filter { $0.time.updated < cutoff && !RemoteFolder.isRemote($0.location.directory) && !(keepsPinned && Self.isPinned($0)) && !running.contains($0.id) }
            // (Listed now: not as it was before its box let it go.)
            .filter { sessionLists[BoxClient.thisMac]?.sessions[$0.id].map { deletable.contains($0.kind) } == true && Drafts.shared[$0.id].isEmpty }
            .sorted { $0.time.updated < $1.time.updated }
    }

    /// What `session` is, as its box says; nil for one it hasn't listed.
    func listKind(of session: Session) -> SessionLists.Kind? {
        sessionLists[Self.box(of: session.location.directory)]?.facts(of: session.id)?.kind
    }

    /// Whether `session`'s row is in Chats, as its box says.
    func isInChats(_ session: Session) -> Bool {
        listPlace(of: session) == .chat
    }

    /// `box`'s line taken in, and kept for the next launch (a moment after, so a few lines at once
    /// are one write); not one for a machine removed meanwhile.
    private func take(_ line: SessionLists.Line, on box: String) {
        guard !isRemoved(box) else { return }
        var listing = sessionLists[box] ?? .init()
        let changed = listing.take(line)
        // (Where it's at changes with every line: kept, unobserved, for the next read.)
        guard changed || sessionLists[box] == nil else {
            listCursors[box] = listing.at
            return
        }
        sessionLists[box] = listing
        listCursors[box] = nil
        sessionListSaves[box]?.cancel()
        sessionListSaves[box] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, let self, !isRemoved(box), let listing = sessionLists[box] else { return }
            SessionCopies.saveList(listing, of: box, at: listCursors[box])
        }
    }

    /// Where each box's list is at, past its last change (`SessionLists.Listing.at`).
    @ObservationIgnored private var listCursors: [String: String] = [:]
    @ObservationIgnored private var sessionListSaves: [String: Task<Void, Never>] = [:]

    /// Where `box`'s list goes on from: its last line's.
    func listCursor(_ box: String) -> String? {
        listCursors[box] ?? sessionLists[box]?.at
    }

    /// `box`'s session list, followed while it's there: this Mac's box streams it; any other answers
    /// once a read, so it's read again as that box's sessions change here (`listChanged`), and every
    /// half minute besides. Each read goes on from the last (`since`).
    func followSessionList(on box: String = BoxClient.thisMac) async {
        if sessionLists[box] == nil, let kept = SessionCopies.list(of: box) { sessionLists[box] = kept }
        while !Task.isCancelled, !isRemoved(box) {
            // A box from before the route: said, and asked again a while after.
            if await checkLists(on: box) == false {
                try? await Task.sleep(for: BoxClient.readAgainAfter)
                continue
            }
            await handOverRemovedWorktrees(on: box)
            var heard = false
            if BoxClient.streams(box), let client = listBox(box) {
                do {
                    for try await data in client.follow(SessionLists.eventsRoute(since: listCursor(box))) {
                        guard let line = try? JSONDecoder().decode(SessionLists.Line.self, from: data) else { continue }
                        heard = true
                        take(line, on: box)
                    }
                } catch {}
                // This Mac's box restarted, or isn't up yet: followed again in a moment.
                try? await Task.sleep(for: .seconds(heard ? 0.5 : 2))
            } else {
                await readSessionList(on: box)
                try? await Task.sleep(for: BoxClient.readAgainAfter)
            }
        }
    }

    /// COMPAT(0.7 worktrees): worktrees this Mac removed before its boxes kept their records, given to `box` once, so its session lists file their sessions under their projects as this Mac did. Goes 3 months after 0.8.0.
    private func handOverRemovedWorktrees(on box: String) async {
        let key = "removedWorktreesHandedOver." + box
        // (A box held for its update refuses the records: given once it's updated.)
        guard !UserDefaults.standard.bool(forKey: key), boxes?(box) != nil else { return }
        for (folder, project) in removedWorktrees.filter({ Self.isOn($0.key, box) }).sorted(by: { $0.key < $1.key }) {
            do {
                let _: Empty = try await onBox(box, "POST", "kuvo/worktrees/record", ["removed": true, "folder": Self.onBox(folder), "project": Self.onBox(project)])
            } catch let refusal as BoxRefusal where refusal.status < 500 {
                // Not one it takes: as it is there.
                continue
            } catch {
                // Not answering: given next time.
                return
            }
        }
        UserDefaults.standard.set(true, forKey: key)
    }

    /// Boxes whose list is being read now, and whether it's to be read once more after.
    @ObservationIgnored private var listReads: [String: Bool] = [:]

    /// `box`'s list read once, from where it was: one at a time, so an older answer never lands
    /// over a newer one; asked for again meanwhile, it's read once more after.
    private func readSessionList(on box: String) async {
        guard listReads[box] == nil else { listReads[box] = true; return }
        listReads[box] = false
        defer { listReads[box] = nil }
        repeat {
            listReads[box] = false
            guard !isAway(box), let client = listBox(box) else { return }
            do {
                take(try await client.value(SessionLists.Line.self, "GET", SessionLists.route(since: listCursor(box))), on: box)
            } catch let refusal as BoxRefusal where refusal.status == 404 {
                // Not served: as it says of itself now (its features asked again), noted; else
                // read again later.
                _ = await checkLists(on: box, again: true)
            } catch {}
        } while listReads[box] == true
    }

    /// A session of `box` changed (its event came here): a box that doesn't stream is read again,
    /// a moment after, so a few changes at once are one read.
    private func listChanged(on box: String) {
        guard !BoxClient.streams(box), listNudges[box] == nil else { return }
        listNudges[box] = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self else { return }
            listNudges[box] = nil
            await readSessionList(on: box)
        }
    }

    @ObservationIgnored private var listNudges: [String: Task<Void, Never>] = [:]

    /// A session's events after which what its box says of it may have changed.
    private static let listEvents: Set<String> = ["session.created", "session.moved", "session.metadata.updated", "session.deleted"]

    /// A machine gone for good, or found to be another: its list goes with it.
    private func forgetSessionList(of box: String) {
        listNudges.removeValue(forKey: box)?.cancel()
        sessionListSaves.removeValue(forKey: box)?.cancel()
        listCursors[box] = nil
        sessionLists[box] = nil
        SessionCopies.removeList(of: box)
    }

    /// The project a folder sessions run in belongs to: a worktree's as its box says, else as this
    /// Mac keeps them (a box from before: those two can go once every box says, bridge 0.9.207),
    /// else its own.
    func projectDirectory(_ directory: String) -> String {
        boxWorktreeProjects[directory] ?? worktrees[directory]?.project ?? removedWorktrees[directory] ?? directory
    }

    /// The project a session is filed under: its folder's, else the one its box filed it under as
    /// it was made (`SessionProject`: a new worktree its box hasn't listed here yet, a subfolder).
    func projectDirectory(of session: Session) -> String {
        let directory = session.location.directory, box = Self.box(of: directory)
        // (The mark names folders as its box does.)
        let project = SessionProject.project(of: session, folder: Self.onBox(directory)) { folder in
            let here = Self.here(folder, on: box), project = projectDirectory(here)
            return project == here ? nil : Self.onBox(project)
        }
        return project == Self.onBox(directory) ? directory : Self.here(project, on: box)
    }

    /// A worktree of a project's (one of its other folders, which you can open as a project of its
    /// own, isn't).
    private func isWorktree(_ directory: String) -> Bool {
        let project = projectDirectory(directory)
        return project != directory && settings[project]?.folders.contains(directory) != true
    }

    /// The project's other folders, for a folder sessions run in.
    func extraFolders(_ directory: String) -> [String] {
        // Its project's own folder's or one of its worktrees'; one in one of the other folders, or
        // a worktree of one, works there alone, as its box starts it.
        let project = worktrees[directory]?.project ?? removedWorktrees[directory] ?? projectDirectory(directory)
        guard let folders = settings[project]?.folders, !folders.contains(directory) else { return [] }
        return folders
    }

    /// Bots' sessions: each bot's conversation, shown with the bot rather than in its project.
    var botSessions: Set<String> = [] {
        didSet { projectsChanged() }
    }
    /// Bots' seats in group chats: sessions that never get a row, a tab or a notification.
    var seats: Set<String> = [] {
        didSet { sessions.removeAll { seats.contains($0.id) } }
    }

    /// A group chat's conversation for one question (a guest's turn, a work list) that's still
    /// there half an hour on: what was asking it stopped before deleting it (the app quit or
    /// crashed). It goes. (A machine's are its own to clear.)
    static func dropLeftScratch(_ sessions: [Session], api: OpenCodeAPI) {
        let old = Date.now.timeIntervalSince1970 * 1000 - 30 * 60_000
        let left = sessions.filter { $0.metadata?["kuvo"]?["seat"]?["scratch"]?.bool == true && $0.time.updated < old }
        guard !left.isEmpty else { return }
        Task { for session in left { try? await api.deleteSession(session.id) } }
    }

    /// A bot's seat in a group chat, by its metadata, before it's in `seats`.
    static func isSeat(_ session: Session) -> Bool {
        session.metadata?["kuvo"]?["seat"] != nil
    }

    private func isHidden(_ session: Session) -> Bool {
        // As its box says, where it has listed it (a subagent's own kind says nothing of it: a
        // review's part is one too); else as it's marked.
        if seats.contains(session.id) { return true }
        if session.parentID == nil, let kind = listKind(of: session) { return kind == .hidden || kind == .seat }
        return HiddenSessions.isHidden(session)
    }

    /// The engine's session for a model of the engine's run in a session with the agents (Auto's,
    /// say): that session shows what it does, so it never gets a row of its own.
    static func isEngineRun(_ session: Session) -> Bool {
        session.metadata?["kuvo"]?["engineFor"] != nil
    }

    #if DEBUG
    private static let logsEvents = ProcessInfo.processInfo.environment["KUVO_DEMO_LOG_EVENTS"] != nil
    #endif

    /// How many runs of each session have ended since the app started: a run someone is
    /// waiting on has ended once its count goes up.
    @ObservationIgnored private(set) var endedRuns: [String: Int] = [:]

    // MARK: Chats

    /// Where chats run: conversations of no project, on this Mac, in a folder of their own. Once this
    /// Mac's box has moved into a home of its own (`OwnBoxHome`), its chats are its own there
    /// (`attachedChats`), and the app makes no folder for them in its own.
    static let chatsFolder: String = {
        let url = AppInfo.supportDirectory.appending(path: "Chats")
        if !OwnBoxHome.hasMoved { try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
        return url.path
    }()

    /// Whether `session` is a chat: as its box marks it (`kuvo.chat`, PROTOCOL.md "Chats"). One
    /// without the mark goes by its folder (`isChat(_ directory:)`): the old-box path, for a machine
    /// whose box is from before the mark, a chat from before the mark, and one not marked yet.
    static func isChat(_ session: Session) -> Bool {
        // (The mark names its folder as its box does.)
        SessionChat.isChat(session, folder: onBox(session.location.directory)) { isChat($0) }
    }

    /// Whether `directory` is the chats folder: this Mac's, or a machine's in Kuvo Code's folder
    /// there (`Moves`). For a new chat's folder (a draft has no session yet), and the old-box path
    /// of `isChat(_ session:)`: a session is a chat as its box marks it.
    static func isChat(_ directory: String) -> Bool {
        directory == chatsFolder || (RemoteFolder.parse(directory)?.path.hasSuffix("/\(RemoteEngineInstaller.root)/chats") ?? false)
    }

    /// A bot's own folder, on this Mac or a machine: what's there is the bot's, even before the
    /// bot is listed (while it's being made), so it never shows as a project.
    static func isBotFolder(_ directory: String) -> Bool {
        directory.hasPrefix(Bots.root.path + "/") || directory.contains("/\(RemoteEngineInstaller.root)/bots/")
    }

    /// Chats, newest first: those their box says are (`sessionLists`).
    var chats: [Session] {
        SessionLists.newestFirst(sessions.filter { !deleting.contains($0.id) && listPlace(of: $0) == .chat }) { $0.time.updated }
    }

    /// Moves a chat into the project at `directory`: its conversation goes along, and from then on
    /// it works in that project's folders. If it's working, the move comes at its next step.
    func move(_ id: String, toProject directory: String) async throws {
        guard session(id) != nil else { return }
        // Its box moves it and gives it the project's folders (PROTOCOL.md, "Projects"); it says
        // why where it can't (a coding agent's, one moving to another computer).
        guard let box = boxes?(Self.box(of: directory)) else { throw Self.unreachable }
        _ = try await box.value(SessionMove.Moved.self, "POST", SessionMove.route(id), body: SessionMove.Asked(directory: Self.onBox(directory)))
        await reload(id)
        Analytics.shared.track("chat_moved")
    }

    /// Projects with their sessions, most recently active first.
    var projects: [Project] {
        // What they're made of, read here so views showing them are updated as it changes.
        _ = (sessions.count, folders.count, settings.count, sessionLists.count, machines.count, deleting.count)
        if let madeProjects { return madeProjects }
        let projects = makeProjects()
        madeProjects = projects
        return projects
    }

    /// The projects as last made, until what they're made of changes: views showing them (the
    /// sidebar, every time the window is resized) read them often, and making them groups and
    /// sorts every session.
    @ObservationIgnored private var madeProjects: [Project]?

    private func projectsChanged() {
        madeProjects = nil
    }

    /// Each session in the project its box files it under, and each project of the list its boxes
    /// keep (`folders`, as each box's `kuvo/projects` says, a change made here shown at once): the
    /// sidebar's order (`SessionLists`).
    private func makeProjects() -> [Project] {
        let shown = { (directory: String) in RemoteFolder.machine(of: directory).map(self.machines.contains) ?? true }
        let grouped = SessionLists.projects(sessions.filter { !deleting.contains($0.id) }, directories: Set(folders).filter(shown), project: { session in
            guard case .project(let directory) = self.listPlace(of: session), shown(directory) else { return nil }
            return directory
        }, updated: { $0.time.updated }, name: { self.settings[$0]?.name ?? ($0 as NSString).lastPathComponent })
        return grouped.map { Project(directory: $0.directory, sessions: $0.rows, settings: settings[$0.directory] ?? ProjectSettings()) }
    }

    /// Put away: out of Projects and Recents, still found by searching. Archived here (a
    /// note in the session's metadata), or by an older opencode.
    static func isArchived(_ session: Session) -> Bool {
        AtWork.isArchived(session)
    }

    private static let archivedKey = "kuvo.archived"

    /// The session an archived one carries on in, when a box moved it to the coding agents (from a
    /// phone, or on a machine): its box notes it.
    static func carriedTo(_ session: Session) -> String? {
        session.metadata?["kuvo.carriedTo"]?.string
    }

    /// Kept at the top of the sidebar, a note in the session's metadata.
    static func isPinned(_ session: Session) -> Bool {
        session.metadata?[pinnedKey]?.bool == true
    }

    private static let pinnedKey = "kuvo.pinned"

    /// Archives a session, or brings it back. `carriedTo`: archived as it carries on in that
    /// session, which its metadata says, as a box marks one it carried (its box's queue goes on
    /// there). Whether the engine took it.
    @discardableResult
    func setArchived(_ id: String, _ archived: Bool, carriedTo: String? = nil) async -> Bool {
        // Its box's list shows it so at once, until its box says so too; as its box says if the
        // engine doesn't take it.
        changeListing(of: id) { $0.noteArchived(id, archived) }
        // Not archived if the engine didn't take it: its wake-ups aren't held for it.
        guard await setFlag(Self.archivedKey, archived, of: id, also: carriedTo.map { ["kuvo.carriedTo": .string($0)] } ?? [:]) else {
            changeListing(of: id) { $0.forgetArchived(id, archived) }
            return false
        }
        onArchived?(id, archived, nil)
        return true
    }

    /// Whether `session` is archived, as its box says (or as this Mac just made it); as this Mac's
    /// copy says for one its box hasn't listed.
    func isListedArchived(_ session: Session) -> Bool {
        sessionLists[Self.box(of: session.location.directory)]?.facts(of: session.id).map { $0.archived == true } ?? Self.isArchived(session)
    }

    /// `id`'s box's list, as this Mac shows it, changed.
    private func changeListing(of id: String, _ change: (inout SessionLists.Listing) -> Void) {
        guard let session = session(id) else { return }
        let box = Self.box(of: session.location.directory)
        guard var listing = sessionLists[box] else { return }
        change(&listing)
        if listing != sessionLists[box] { sessionLists[box] = listing }
    }

    /// The sessions `box`'s Remove Project `answer` names as archived: so here (their terminals
    /// closed, their wake-ups held), and out of its lists at once.
    private func noteArchived(on box: String, byRemoving answer: Data) {
        for id in SessionLists.archived(byRemoving: answer) { noteArchivedThere(id) }
        guard var listing = sessionLists[box] else { return }
        listing.noteArchived(byRemoving: answer)
        if listing != sessionLists[box] { sessionLists[box] = listing }
    }

    /// A session was archived, or brought back. The app sets it. `carriedTo`: archived as its box
    /// carried it on in that session (moved it to the coding agents) just now, never for one
    /// carried on before, brought back and archived again.
    @ObservationIgnored var onArchived: ((_ session: String, _ isArchived: Bool, _ carriedTo: String?) -> Void)?

    /// The sessions read again: one archived or brought back meanwhile (from a phone, while the
    /// feed was down) is told, as `upsert` tells one.
    private func noteArchiving(since before: [Session]) {
        guard onArchived != nil else { return }
        let was = Dictionary(before.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for session in sessions {
            if let earlier = was[session.id] { noteArchiving(session, was: earlier) }
        }
    }

    /// `session` as it is now, archived or brought back since it was `earlier`: told.
    private func noteArchiving(_ session: Session, was earlier: Session) {
        let archived = Self.isArchived(session)
        guard archived != Self.isArchived(earlier) else { return }
        onArchived?(session.id, archived, archived && Self.carriedTo(earlier) == nil ? Self.carriedTo(session) : nil)
    }

    /// Pins a session to the top of the sidebar, or takes it off.
    func setPinned(_ id: String, _ pinned: Bool) async {
        if pinned { Analytics.shared.track("session_pinned") }
        await setFlag(Self.pinnedKey, pinned, of: id)
    }

    /// Sets a flag in a session's metadata, shown at once; put back as it was if the engine
    /// doesn't take it (it would come back so with the next read). Whether it did.
    @discardableResult
    private func setFlag(_ key: String, _ value: Bool, of id: String, also: [String: JSONValue] = [:]) async -> Bool {
        guard !Moves.isFrozen(id) else { return false }
        guard let index = sessions.firstIndex(where: { $0.id == id }), let api = api(for: sessions[index]) else { return false }
        let before = sessions[index].metadata
        var metadata = before?.object ?? [:]
        // Written either way: the engine may merge metadata rather than replace it.
        metadata[key] = .bool(value)
        metadata.merge(also) { $1 }
        sessions[index].metadata = .object(metadata)
        if let machine = RemoteFolder.machine(of: sessions[index].location.directory) { keepList(of: machine) }
        do {
            try await api.setMetadata(session: id, .object(metadata))
            return true
        } catch {
            // Only this flag goes back: another changed meanwhile (pinned, say) stays.
            if let index = sessions.firstIndex(where: { $0.id == id }), sessions[index].metadata?[key] == .bool(value) {
                var current = sessions[index].metadata?.object ?? [:]
                current[key] = before?[key]
                sessions[index].metadata = current.isEmpty && before == nil ? nil : .object(current)
            }
            return false
        }
    }

    func session(_ id: String?) -> Session? {
        guard let id else { return nil }
        return sessions.first { $0.id == id }
    }

    /// A subagent's session, to show its work inside the step that started it. It has no row
    /// or tab of its own; its model gets its events like any other.
    func subagentModel(for id: String, in folder: String) async -> SessionModel? {
        if let model = models[id] { return model }
        // A coding agent's subagent is its bridge's; any other, the engine's of its folder.
        let bridge = agents(forFolder: folder)?.api
        let places = bridgeSessions.contains(id) ? [bridge, api(forFolder: folder)] : [api(forFolder: folder), bridge]
        var found: (api: OpenCodeAPI, session: Session)?
        for case let place? in places {
            if let session = try? await place.session(id) {
                found = (place, session)
                break
            }
        }
        guard let (api, session) = found else { return nil }
        if OutsideAgents.isAgentSession(session) { bridgeSessions.insert(id) }
        if let model = models[id] { return model }
        let model = SessionModel(session: session, api: api)
        model.isReachable = reachable(folder)
        model.box = box(of: id, else: session.location.directory)
        followGoals(of: model)
        models[id] = model
        return model
    }

    /// The subagent a step handed its task to, as the conversation it's in knows it (with the
    /// session the step started, when the engine didn't say), and that conversation.
    func subagent(forStep call: String) -> (subagent: SessionModel.Subagent, conversation: String)? {
        for (id, model) in models {
            if let subagent = model.subagents.first(where: { $0.call == call }) { return (subagent, id) }
        }
        return nil
    }

    /// A subagent's task, as its session is called, once it's been read.
    func subagentTitle(_ id: String) -> String? {
        models[id]?.session.title
    }

    /// Sessions whose conversation has `query` (archived ones too), the latest first, with the
    /// words around its first mention: each box searches its own (`kuvo/search`), this Mac's and
    /// each machine that's connected, and only what's listed here is shown.
    /// `answered`: each box's finds as it answers (by its id, `BoxClient.thisMac` or a machine's), for
    /// a sidebar that shows them as they come.
    func searchConversations(_ query: String, limit: Int = 20, answered: ((String, [ConversationFind]) -> Void)? = nil) async -> [ConversationFind] {
        nonisolated struct Found: Decodable, Sendable {
            var results: [Hit]
            struct Hit: Decodable, Sendable {
                var session: String
                var snippet: String
                var subagent: Subagent?
                struct Subagent: Decodable, Sendable { var id: String }
            }
            /// Its answer: what it found, or why it couldn't search.
            static func asked(_ client: BoxClient, _ path: String) async -> Result<[Hit], UnsearchedFailure> {
                guard let (status, body) = try? await client.send("GET", path) else { return .failure(.init(reason: .didntAnswer)) }
                // A box from before it could search: it doesn't have the route.
                if status == 404 { return .failure(.init(reason: .needsUpdate)) }
                guard status == 200, let found = try? JSONDecoder().decode(Found.self, from: body) else { return .failure(.init(reason: .didntAnswer)) }
                return .success(found.results)
            }
        }
        let path = "kuvo/search?q=\(Self.queryValue(query))&limit=\(limit)"
        let boxes = searchedBoxes?() ?? Self.thisMacThenMachines(connectedMachines)
        let clients = boxes.compactMap { box in self.boxes?(box).map { (box, $0) } }
        let answers = await withTaskGroup(of: (String, Result<[Found.Hit], UnsearchedFailure>).self) { group in
            for (box, client) in clients { group.addTask { (box, await Found.asked(client, path)) } }
            var answers: [String: Result<[Found.Hit], UnsearchedFailure>] = [:]
            for await answer in group {
                answers[answer.0] = answer.1
                let found = (try? answer.1.get()) ?? []
                answered?(answer.0, found.compactMap { result in session(result.session).map { ConversationFind(session: $0, snippet: result.snippet, subagent: result.subagent?.id) } })
            }
            return answers
        }
        // Who couldn't search, said: machines that aren't connected, and boxes that didn't answer
        // or can't search yet.
        var unsearched: [String: UnsearchedReason] = [:]
        for machine in machines.subtracting(connectedMachines).subtracting(removedMachines) { unsearched[machine] = .notConnected }
        for (box, answer) in answers {
            if case .failure(let failure) = answer { unsearched[BoxClient.isThisMac(box) ? "This Mac" : box] = failure.reason }
        }
        if unsearched != self.unsearched { self.unsearched = unsearched }
        return answers.values.compactMap { try? $0.get() }.flatMap(\.self)
            .compactMap { result in session(result.session).map { ConversationFind(session: $0, snippet: result.snippet, subagent: result.subagent?.id) } }
            .sorted { $0.session.time.updated > $1.session.time.updated }
            .prefix(limit).map { $0 }
    }

    /// A conversation a search of what was said found: the words around the first mention, and
    /// the subagent that said them when it wasn't the conversation itself.
    struct ConversationFind {
        var session: Session
        var snippet: String
        var subagent: String?
    }

    /// The computers the last search of conversations couldn't search, each with why, by name.
    private(set) var unsearched: [String: UnsearchedReason] = [:]
    /// Why a box couldn't search, as an error to carry in a `Result`.
    struct UnsearchedFailure: Error {
        var reason: UnsearchedReason
    }

    /// The boxes a search of conversations asks: this Mac's and each machine that's connected; a
    /// test's stand-in.
    @ObservationIgnored var searchedBoxes: (() -> [String])?

    /// A session's conversation as Markdown, to share.
    func markdown(of id: String) async throws -> String? {
        guard let session = session(id), let api = api(for: session) else { return nil }
        let messages = try await ConversationExport.messages(of: session, api: api)
        // Those from before as their box reads them.
        await SentMessage.read(messages, from: box(of: id, else: session.location.directory)())
        return ConversationExport.markdown(title: session.title ?? "New Session", messages: messages, directory: session.location.directory)
    }

    /// The live model behind a session view. Created on first use, then kept so
    /// switching back is instant.
    func model(for id: String) -> SessionModel? {
        if let model = models[id] { return model }
        guard let session = session(id), let api = api(for: session) else { return copyModel(for: id) }
        let directory = session.location.directory
        // The project's folders where the session is now: a chat moved into a project gets its folders.
        let model = SessionModel(session: session, api: api) { [weak self] in
            guard let self else { return [] }
            return self.extraFolders(self.session(id)?.location.directory ?? directory)
        }
        model.isReachable = reachable(directory)
        model.box = box(of: id, else: directory)
        followGoals(of: model)
        models[id] = model
        // This Mac's conversation as last seen, in its first frame, while the engine's is read
        // (which takes a moment, longer while it starts): read in place, the same messages,
        // nothing moves. Reading a copy takes a few milliseconds.
        if !RemoteFolder.isRemote(directory), let copy = SessionCopies.load(id) { model.preview(copy.messages) }
        Task { await readShellJobs(in: directory) }
        return model
    }

    /// Renames asked of each session, counted: one that waited for a move goes only if none came
    /// after it.
    @ObservationIgnored private var renames: [String: Int] = [:]

    /// A machine's sessions as they are now, kept for when it's away (see `showLastSeen`): a
    /// moment after they change, as several often change together.
    @ObservationIgnored private var listSaves: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var localListSave: Task<Void, Never>?
    /// This Mac's sessions shown as last seen before its engine was there at all (see `copyModel`).
    @ObservationIgnored private var beforeEngine: Set<String> = []

    /// This Mac's sessions as they are now, kept for the next launch (see `sessions`), a moment
    /// after they change.
    private func keepLocalList() {
        localListSave?.cancel()
        localListSave = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, !Task.isCancelled else { return }
            SessionCopies.saveLocalSessions(sessions.filter { !RemoteFolder.isRemote($0.location.directory) })
        }
    }

    private func keepList(of machine: String) {
        guard connectedMachines.contains(machine) else { return }
        listSaves[machine]?.cancel()
        listSaves[machine] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, !Task.isCancelled else { return }
            saveList(of: machine)
        }
    }

    private func saveList(of machine: String) {
        listSaves[machine]?.cancel()
        listSaves[machine] = nil
        SessionCopies.saveSessions(sessions.filter { RemoteFolder.machine(of: $0.location.directory) == machine }, of: machine)
    }

    /// A session's box (this Mac's, or its machine's), where it lives when asked: one shown as last
    /// seen goes on with it once its engine is there, and one that moved with its new computer's.
    private func box(of id: String, else directory: String) -> () -> BoxClient? {
        { [weak self] in
            guard let self else { return nil }
            // (A subagent's has no row: as its model has it, which moves with its conversation.)
            let now = self.session(id)?.location.directory ?? self.models[id]?.session.location.directory ?? directory
            return self.boxes?(Self.box(of: now))
        }
    }

    /// Whether a folder's engine can be reached: a machine's, while it's connected.
    private func reachable(_ folder: String) -> () -> Bool {
        guard let machine = RemoteFolder.machine(of: folder) else { return { true } }
        return { [weak self] in self?.connectedMachines.contains(machine) ?? false }
    }

    /// Whether the machine's sessions are live (it's connected and they've been read).
    func isConnected(_ machine: String) -> Bool { connectedMachines.contains(machine) }

    /// A session on a machine that's connecting, or on this Mac while its engine starts, from its
    /// conversation as last seen, to read meanwhile. It takes the engine once it's there (see
    /// `refresh`).
    private func copyModel(for id: String) -> SessionModel? {
        // An agent's session waits for the bridge as this Mac's do for the engine.
        let isAgents = session(id).map(OutsideAgents.isAgentSession) ?? false
        if isAgents ? agents?.api == nil : api == nil, let session = session(id), !RemoteFolder.isRemote(session.location.directory), let copy = SessionCopies.load(id) {
            // Nothing answers here; nothing's asked of it before the engine is there.
            let offline = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: "http://127.0.0.1:9")!, username: "", password: nil))
            let directory = session.location.directory
            let model = SessionModel(session: session, api: offline) { [weak self] in
                guard let self else { return [] }
                return self.extraFolders(self.session(id)?.location.directory ?? directory)
            }
            model.isReachable = { [weak self] in isAgents ? self?.agents?.api != nil : self?.api != nil }
            model.box = box(of: id, else: directory)
            followGoals(of: model)
            model.show(copy.messages)
            models[id] = model
            beforeEngine.insert(id)
            return model
        }
        guard let machine = waitingMachine(for: id), let copy = SessionCopies.load(id) else { return nil }
        // Nothing answers here; nothing's asked of it before the machine is back.
        let offline = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: "http://127.0.0.1:9")!, username: "", password: nil), folderPrefix: RemoteFolder.prefix(for: machine))
        let directory = copy.session.location.directory
        let model = SessionModel(session: copy.session, api: offline) { [weak self] in
            guard let self else { return [] }
            return self.extraFolders(self.session(id)?.location.directory ?? directory)
        }
        model.isReachable = reachable(directory)
        model.box = box(of: id, else: directory)
        followGoals(of: model)
        model.show(copy.messages)
        models[id] = model
        return model
    }

    func loadBranch(for directory: String) async {
        let read = nextBranchRead(directory)
        guard let api = api(forFolder: directory), let info = try? await api.vcs(directory: directory) else {
            // Asked before its engine answered (the window's folder as the app starts, a machine
            // still connecting): read again once it does.
            branchesUnread.insert(directory)
            return
        }
        // Answers can land out of order (an engine that just started answers no branch, then says
        // it has read one): one older than what's shown doesn't undo it, and one newer that
        // failed doesn't lose it.
        guard read > (branchShown[directory] ?? 0) else { return }
        branchShown[directory] = read
        branchesUnread.remove(directory)
        branches[directory] = info.branch?.current
        defaultBranches[directory] = info.branch?.default
    }

    /// Each folder's branch reads, numbered as they're asked, and the newest one shown.
    @ObservationIgnored private var branchReads: [String: Int] = [:]
    @ObservationIgnored private var branchShown: [String: Int] = [:]
    private func nextBranchRead(_ directory: String) -> Int {
        let read = (branchReads[directory] ?? 0) + 1
        branchReads[directory] = read
        return read
    }
    /// Folders whose branch couldn't be read yet, for `loadBranch` once their engine answers.
    @ObservationIgnored private var branchesUnread: Set<String> = []

    /// The branches asked for before `machine`'s engine answered (nil: this Mac's), read now.
    private func loadUnreadBranches(on machine: String?) {
        for folder in branchesUnread where RemoteFolder.machine(of: folder) == machine {
            Task { await loadBranch(for: folder) }
        }
    }

    /// Waiting on you: a permission, a question or a sign-in, in a conversation you have open or
    /// not (a bot's work in a session of its own, say).
    func needsAttention(_ id: String) -> Bool {
        if askingInBrowser.contains(id) || askingForWork.contains(id) || askingOutsideSandbox.contains(id) || goalCards.contains(id) || asking.values.contains(where: { $0 == id || root(of: $0) == id }) { return true }
        guard let model = models[id] else { return false }
        let box = Self.box(of: model.session.location.directory)
        return model.permissions.contains { Sandboxes.shared.isYours($0, on: box) } || !model.forms.isEmpty
    }

    // MARK: Changes

    /// Adds a project folder; the folder as it's kept (see `folderPath`).
    @discardableResult
    func addFolder(_ directory: String) -> String {
        // (A folder on this Mac is its box's: attached in place, a folder there.)
        let directory = Self.onThisMac(folderPath(directory))
        // Chats aren't a project, nor is a bot's own folder, nor a project's worktree (a session
        // started in one stays its project's).
        guard !folders.contains(directory), !Self.isChat(directory), !Self.isBotFolder(directory), !isWorktree(directory) else { return directory }
        Analytics.shared.track("project_added", ["projects": folders.count + 1])
        folders.insert(directory, at: 0)
        UserDefaults.standard.set(folders, forKey: "projectFolders")
        keepOnBox(directory)
        return directory
    }

    /// A project's folder as it's kept: one already a project as it is; a new one on this Mac by its
    /// real path, links followed (/var/… is /private/var/…, a Dropbox folder is in
    /// ~/Library/CloudStorage). The engine takes a session for outside its project when the two
    /// paths differ, and keeps no snapshots of its changes then, so Undo couldn't bring files back.
    func folderPath(_ directory: String) -> String {
        guard !folders.contains(directory), !RemoteFolder.isRemote(directory), let resolved = realpath(directory, nil) else { return directory }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    /// Remove Project…: every session of the project, its worktrees' too, archived (Archived
    /// Sessions brings them back), and the project off the sidebar. Its files, worktrees included,
    /// stay, and so do its name and folders, for when a session brings it back. Its box does it
    /// (PROTOCOL.md, "Projects"), older sessions too. How many weren't archived: those stay
    /// listed, and the project with them, as it was.
    @discardableResult
    func removeProject(_ directory: String) async throws -> Int {
        let box = Self.box(of: directory)
        let sessions = projects.first { $0.directory == directory }?.sessions ?? []
        guard Self.keepsProjects(box), let client = boxes?(box) else { return await archiveHere(sessions, removing: directory) }
        // Its worktrees as this Mac knows them are its box's too (handed over, if they weren't), so
        // their sessions are archived there with the rest.
        guard await takeWorktrees(from: box) != nil else {
            throw BoxRefusal(status: 503, message: BoxClient.isThisMac(box) ? "Kuvo Code’s background service on this Mac isn’t answering. Try again in a moment." : "\(box) isn’t answering. Try again in a moment.")
        }
        // Its worktrees removed before its box kept them, whose sessions this Mac still shows under it.
        let removed = removedWorktrees.filter { $0.value == directory && Self.isOn($0.key, box) }.keys.map(Self.onBox).sorted()
        let body = try JSONSerialization.data(withJSONObject: ["folders": removed])
        let (status, data) = try await client.send("DELETE", "kuvo/projects?directory=" + Self.queryValue(Self.onBox(directory)), body: body)
        switch status {
        case 200:
            // Those its box archived, its worktrees' among them, as it names them: so here too, and
            // it's off the list.
            noteArchived(on: box, byRemoving: data)
            folders.removeAll { $0 == directory }
            UserDefaults.standard.set(folders, forKey: "projectFolders")
            await loadProjects(on: box)
            return 0
        case 409:
            noteArchived(on: box, byRemoving: data)
            if box == BoxClient.mac { await refresh() }
            await loadProjects(on: box)
            return ((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["kept"] as? Int) ?? 1
        default:
            throw BoxRefusal(status: status, data: data)
        }
    }

    /// Archived here, one by one (a box that doesn't keep its projects yet); `removing`'s folder
    /// off the list once they all are. How many weren't.
    private func archiveHere(_ sessions: [Session], removing directory: String?) async -> Int {
        // Side by side: on a machine, each is a round trip.
        let kept = await withTaskGroup(of: Bool.self) { group in
            for session in sessions {
                group.addTask { await self.setArchived(session.id, true) }
            }
            var kept = 0
            for await archived in group where !archived { kept += 1 }
            return kept
        }
        if kept == 0, let directory {
            folders.removeAll { $0 == directory }
            UserDefaults.standard.set(folders, forKey: "projectFolders")
        }
        return kept
    }

    /// A session its box archived: so here, and told, as one archived here is.
    private func noteArchivedThere(_ id: String) {
        guard let index = sessions.firstIndex(where: { $0.id == id }), !Self.isArchived(sessions[index]) else { return }
        var metadata = sessions[index].metadata?.object ?? [:]
        metadata[Self.archivedKey] = .bool(true)
        sessions[index].metadata = .object(metadata)
        onArchived?(id, true, nil)
    }

    /// The project's name: its own, or its primary folder's. A worktree has its project's.
    func projectName(_ directory: String) -> String {
        if Self.isChat(directory) { return "Chats" }
        let directory = projectDirectory(directory)
        return settings[directory]?.name ?? (directory as NSString).lastPathComponent
    }

    /// The name of the project a session is filed under, as its box says (an archived one's too);
    /// one that's in none (a bot's, a subagent's) by its folder.
    func projectName(of session: Session) -> String {
        guard let directory = listedProject(of: session) else { return "Chats" }
        return settings[directory]?.name ?? (directory as NSString).lastPathComponent
    }

    /// The project `session` is filed under (its folder as named here), archived or not: as its box
    /// says, nil for a chat, its own folder for one its box hasn't listed; for a machine its box
    /// hasn't answered for since this update, as this Mac filed it before (`lastFiled`).
    func listedProject(of session: Session) -> String? {
        let box = Self.box(of: session.location.directory)
        // (A box from before it listed them: its own folder; one not answered yet: as last filed here.)
        if outdatedLists.contains(box) { return session.location.directory }
        guard let listing = sessionLists[box] else { return Self.isChat(session) ? nil : projectDirectory(of: session) }
        let facts = listing.facts(of: session.id)
        if facts?.kind == .chat { return nil }
        return facts?.project.map { Self.here($0, on: box) } ?? session.location.directory
    }

    /// Adds a project, or updates one, and gives its open sessions the new folders.
    /// `shown`: the sessions open in a tab, given the project's new folders by its box at once (you
    /// may write to one next).
    @discardableResult
    func saveProject(_ directory: String, settings project: ProjectSettings, shown: Set<String> = []) -> String {
        let directory = addFolder(directory)
        var project = project
        project.name = project.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        if project.name?.isEmpty == true || project.name == (directory as NSString).lastPathComponent { project.name = nil }
        project.folders = project.folders.filter { $0 != directory }
        project.run = project.run?.trimmingCharacters(in: .whitespacesAndNewlines)
        if project.run?.isEmpty == true { project.run = nil }
        settings[directory] = project == ProjectSettings() ? nil : project
        saveSettings()
        keepOnBox(directory)
        // Sessions not open yet catch up when they open: their box gives each its folders as it
        // next runs or opens, never all at once at rest, which would make each the newest. Only
        // those open in a tab now.
        givingFolders = models.values.filter { shown.contains($0.id) && projectDirectory(of: $0.session) == directory }.map { model in
            Task {
                // (Once its box has them.)
                await projectsWritten()
                await model.syncFolders()
            }
        }
        return directory
    }

    /// The project's folders being given to its loaded sessions after Edit Project (what a test
    /// waits for).
    @ObservationIgnored private(set) var givingFolders: [Task<Void, Never>] = []

    /// Each computer's approvals (`GET kuvo/approval`), by box, as last read: what a new
    /// conversation's composer starts with there.
    var approvalsHere: [String: ApprovalHere] = [:]

    /// Reads the approvals of the computer `directory` is on.
    func readApprovalHere(for directory: String) async {
        let id = Self.box(of: directory)
        guard let box = boxes?(id) else { return }
        guard let here = try? await box.value(ApprovalHere.self, "GET", "kuvo/approval") else { return }
        if approvalsHere[id] != here { approvalsHere[id] = here }
    }

    /// Reads the approvals of the computer `id` (its box).
    func readApprovalHere(onBox id: String) async throws {
        guard let box = boxes?(id) else { throw CancellationError() }
        let here = try await box.value(ApprovalHere.self, "GET", "kuvo/approval")
        if approvalsHere[id] != here { approvalsHere[id] = here }
    }

    /// Whether your other computers may start work on the computer `id`, as you set it there.
    func allowOtherComputers(_ on: Bool, onBox id: String) async throws {
        guard let box = boxes?(id) else { throw CancellationError() }
        approvalsHere[id] = try await box.value(ApprovalHere.self, "PATCH", "kuvo/approval", body: ["otherComputers": on])
    }

    /// Confirms Full Access on the computer `directory` is on (asked the first time it's picked there).
    func allowFullAccess(for directory: String) async throws {
        let id = Self.box(of: directory)
        guard let box = boxes?(id) else { throw CancellationError() }
        approvalsHere[id] = try await box.value(ApprovalHere.self, "PATCH", "kuvo/approval", body: ["fullAccess": true])
    }

    /// A new session in the project at `directory`, or with `worktree`, in a new worktree of it.
    /// `approval`: what it starts with, kept with it on its box (nil: that computer's default).
    /// `autopilot`: it starts on Autopilot, set on its box before its first message goes.
    func createSession(in directory: String, model: ModelRef?, agent: String?, approval: ToolApproval? = nil, autopilot: Bool = false, worktree: Bool = false) async throws -> Session {
        // A model of an outside agent (Claude Code, Codex…), or Auto: the session is the agents
        // bridge's, here.
        let isAgents = OutsideAgents.runsInBridge(model?.providerID)
        // (On a machine, its own bridge, beside its engine.)
        let bridge = agents(forFolder: directory)
        if isAgents, bridge?.api == nil { throw OutsideAgents.Failure.notRunning(bridge?.failure) }
        guard let api = isAgents ? bridge?.api : api(forFolder: directory) else { throw CancellationError() }
        // Its box makes it (PROTOCOL.md, `kuvo/sessions`): its worktree, its project's folders, its
        // approval and Autopilot, all there. (Told before the folder's added, as one that can't be
        // told adds nothing.)
        let boxID = Self.box(of: directory)
        guard let box = boxes?(boxID) else { throw Self.unreachable }
        let directory = addFolder(directory)
        let asked = SessionStart.Asked(folder: Self.onBox(directory), chat: !worktree && Self.isChat(directory), worktree: worktree, agent: agent, model: model, approval: approval?.rawValue, autopilot: autopilot)
        let started = try await box.value(SessionStart.Started.self, "POST", SessionStart.route, body: asked)
        let session: Session
        if var made = started.info {
            made.location.directory = api.appFolder(made.location.directory)
            session = made
        } else {
            session = try await api.session(started.session)
        }
        if let tree = started.worktree {
            let folder = Self.here(tree.folder ?? tree.root, on: boxID)
            worktrees[folder] = Worktree(project: directory, root: Self.here(tree.root, on: boxID), branch: tree.branch, base: tree.base)
            saveWorktrees()
            // (Its box told it it works there.)
            toldWorktree.insert(session.id)
        }
        noteMade(session, as: started, in: directory, on: boxID)
        upsert(session)
        trackCreated(session, model: model, agent: agent, approval: session.metadata?["kuvo"]?["applied"]?.string ?? "default", worktree: worktree)
        return session
    }

    /// What a start or a move says when its computer's box can't be reached.
    private static var unreachable: BoxRefusal { BoxRefusal(status: 503, message: "Its computer can’t be reached now. Try again once it’s connected.") }

    private func trackCreated(_ session: Session, model: ModelRef?, agent: String?, approval: String, worktree: Bool) {
        let used = model ?? session.model
        var props = Analytics.model(provider: used?.providerID, model: used?.id)
        props["mode"] = Analytics.mode(agent)
        props["approval"] = approval
        props["worktree"] = worktree
        if let since = Analytics.shared.sinceInstall { props["since_install"] = since }
        Analytics.shared.track("session_created", props)
    }

    // MARK: Worktrees

    static let worktreeInstructionKey = "kuvo.worktree"

    /// Sessions told they work in a worktree, as they're made.
    @ObservationIgnored private var toldWorktree: Set<String> = []
    /// Telling a session made elsewhere that it works in one of this Mac's worktrees, by session
    /// (what a test waits for).
    @ObservationIgnored private(set) var tellingWorktree: [String: Task<Void, Never>] = [:]

    /// A session just made in one of this Mac's worktrees somewhere else (a phone made it in one
    /// it asked this Mac's box for): told it works there, as one made here is.
    private func tellWorktree(_ session: Session) {
        let folder = session.location.directory
        guard RemoteFolder.machine(of: folder) == nil, Date.now.timeIntervalSince1970 * 1000 - session.time.created < 120_000,
              toldWorktree.insert(session.id).inserted else { return }
        // One this Mac's box made for a phone is known here once its records are read.
        let reading = worktrees[folder] == nil
        guard !reading || (boxes != nil && !folders.contains(folder) && !Self.isChat(folder) && !Self.isBotFolder(folder)) else { return }
        tellingWorktree[session.id] = Task {
            defer { tellingWorktree[session.id] = nil }
            if reading { await learnWorktree(at: folder) }
            guard let tree = worktrees[folder], let api = api(for: session) else { return }
            try? await api.setInstruction(session: session.id, key: Self.worktreeInstructionKey, text: Self.instructions(for: tree))
        }
    }

    /// The worktree this Mac's box keeps at `folder`, read from it and added here: just that one,
    /// so a read that crossed a change the box is telling this Mac about doesn't undo it.
    private func learnWorktree(at folder: String) async {
        struct Listed: Decodable { var worktrees: [BoxWorktree] }
        guard let listed: Listed = try? await onBox(BoxClient.mac, "GET", "kuvo/worktrees?records=1", nil),
              let record = listed.worktrees.first(where: { $0.folder ?? $0.root == folder }), worktrees[folder] == nil else { return }
        worktrees[folder] = Worktree(project: record.project, root: record.root, branch: record.branch, base: record.base)
        saveWorktrees()
    }

    /// (As a machine's bridge says it to a session there: with the checkout's path on it.)
    private static func instructions(for tree: Worktree) -> String {
        """
        You work in a git worktree of this project, on the branch \(tree.branch), so your changes stay apart from \
        the user's own checkout at \(RemoteFolder.parse(tree.project)?.path ?? tree.project) until they merge them. Make your changes here, not there.
        """
    }

    /// A worktree made for a session that wasn't: removed, with its branch, and not recorded as
    /// one you removed.
    /// Whether it went: one the engine couldn't remove stays listed, to remove from Settings.
    @discardableResult
    func discardWorktree(_ folder: String) async -> Bool {
        guard let tree = worktrees[folder] else { return true }
        do {
            let _: Empty = try await onBox(Self.box(of: tree.root), "POST", "kuvo/worktrees/remove", ["path": Self.onBox(tree.root), "forget": true])
        } catch let refusal as BoxRefusal where refusal.status == 404 {
            // Gone there already.
        } catch {
            return false
        }
        worktrees = worktrees.filter { $0.value.root != tree.root }
        saveWorktrees()
        return true
    }

    /// This Mac's worktrees are followed from its box now (`followWorktrees`).
    @ObservationIgnored private var followingWorktrees = false

    /// Worktrees whose new name was read once their session had a title.
    @ObservationIgnored private var namesRead: Set<String> = []

    /// A worktree's branch starts with a made-up name; once its session has a title, its box
    /// names the branch after it (unless it's been pushed, or renamed, already) and tells the
    /// session, as its records are read: so they're read then, once.
    private func nameBranch(of session: Session) {
        let folder = session.location.directory
        guard let tree = worktrees[folder], let title = session.title, !title.isEmpty,
              namesRead.insert(tree.root).inserted else { return }
        Task {
            // Not read (its box didn't answer): read again with the session's next change.
            guard await takeWorktrees(from: Self.box(of: tree.root)) != nil else {
                namesRead.remove(tree.root)
                return
            }
            await loadBranch(for: folder)
        }
    }

    /// Whether another session still working in the worktree (not archived) would lose it.
    func worktreeIsShared(_ directory: String, besides id: String) -> Bool {
        guard let root = worktrees[directory]?.root else { return false }
        return sessions.contains { $0.id != id && !Self.isArchived($0) && worktrees[$0.location.directory]?.root == root }
    }

    /// Whether archived sessions are left in the worktree, besides `id`: its box saves what wasn't
    /// committed for them when it removes it.
    func worktreeHasArchivedSessions(_ directory: String, besides id: String) -> Bool {
        guard let root = worktrees[directory]?.root else { return false }
        return sessions.contains { $0.id != id && Self.isArchived($0) && worktrees[$0.location.directory]?.root == root }
    }

    /// Removes a worktree's folder, and changes that aren't committed with it when
    /// `discardingChanges` (you were told they go); without, one that has some stays. Its branch
    /// stays with its commits, unless it's merged already. Never while an agent works in it.
    func removeWorktree(_ directory: String, discardingChanges: Bool = true) async throws {
        guard let tree = worktrees[directory] else { return }
        // A machine removes it, with its engine. This Mac's box answers with its engine down too,
        // and says why it can't.
        if api(forFolder: directory) == nil, let machine = RemoteFolder.machine(of: tree.root) {
            throw GitFailure(message: "\(machine) isn’t connected, so the worktree of \(tree.branch) can’t be removed now.")
        }
        // Looked at again now: an agent may have written more since you were asked.
        // Any session there, opened or not, with its subagents and background commands.
        if sessions.contains(where: { worktrees[$0.location.directory]?.root == tree.root && isWorking($0.id) }) {
            throw GitFailure(message: "An agent is still working in the worktree of \(tree.branch), so it stays. Stop it first, then remove the worktree.")
        }
        // Its box's own: it checks the same (changes not committed stay unless they're to go), and
        // removes it, its branch with it only if it's merged. One it no longer has (removed from
        // a phone) is gone already.
        do {
            let _: Empty = try await onBox(Self.box(of: tree.root), "POST", "kuvo/worktrees/remove", ["path": Self.onBox(tree.root), "discard": discardingChanges])
        } catch let refusal as BoxRefusal {
            guard refusal.status == 404 else { throw refusal }
        } catch {
            // Not reached at all: said plainly, not as the connection's own words.
            throw GitFailure(message: "\(BoxClient.isThisMac(Self.box(of: tree.root)) ? "Kuvo Code’s background service on this Mac" : Self.box(of: tree.root)) didn’t answer, so the worktree of \(tree.branch) stays. Try again in a moment.")
        }
        for (folder, removed) in worktrees where removed.root == tree.root { removedWorktrees[folder] = removed.project }
        UserDefaults.standard.set(removedWorktrees, forKey: "removedWorktrees")
        worktrees = worktrees.filter { $0.value.root != tree.root }
        saveWorktrees()
        Analytics.shared.track("worktree_removed")
    }

    /// A box's worktrees as it keeps them: this Mac's as its box starts, a machine's as it
    /// connects, each as its Worktrees page opens (`details`: with the room each takes there and
    /// what in it isn't committed or merged, by root as this Mac names it), and as a session in one
    /// gets its title. This Mac shows them
    /// from then on. Ones this Mac kept for it before the box kept them are handed over, and ones
    /// it no longer has (removed from a phone, say) go here too. Nil when it couldn't be asked:
    /// what this Mac had stays.
    @discardableResult func takeWorktrees(from box: String, details: Bool = false) async -> [String: BoxWorktree]? {
        struct Listed: Decodable { var worktrees: [BoxWorktree]; var restorable: [RestorableWorktree]? }
        // The box attached in place answers once a read, and isn't told of what changes here: an
        // answer read before a change here since (a worktree made, removed or restored) would undo
        // it, so it's left for the next read. What this Mac kept there is handed over until it's
        // taken once; after that, one it doesn't list was removed there.
        let attachedHere = box == SSHConnection.thisMac
        let handsOver = !(attachedHere && worktreesHandedOver.contains(box))
        let before = worktreesChanged
        let changedHere = { attachedHere && self.worktreesChanged != before }
        guard let listed: Listed = try? await onBox(box, "GET", details ? "kuvo/worktrees" : "kuvo/worktrees?records=1", nil) else { return nil }
        if box != BoxClient.mac || !followingWorktrees, !changedHere() { takeRestorable(listed.restorable ?? [], from: box) }
        var records = listed.worktrees
        for (folder, tree) in worktrees where handsOver && Self.isOn(tree.root, box) {
            let project = Self.onBox(tree.project), root = Self.onBox(tree.root), path = Self.onBox(folder)
            guard !records.contains(where: { $0.root == root }) else { continue }
            var record: [String: Any] = ["project": project, "root": root, "folder": path, "branch": tree.branch]
            if let base = tree.base { record["base"] = base }
            do {
                // COMPAT(0.7 worktrees): machines' worktrees this Mac kept before their boxes did. Goes 3 months after 0.8.0.
                let _: Empty = try await onBox(box, "POST", "kuvo/worktrees/record", record)
                records.append(BoxWorktree(project: project, root: root, folder: path, branch: tree.branch, base: tree.base))
            } catch let refusal as BoxRefusal where refusal.status == 404 {
                // Not there any more: it goes here too.
            } catch let refusal as BoxRefusal where refusal.status < 500 {
                // Not one it takes (as kept here it doesn't make sense there): it goes here too, as
                // one it doesn't have.
                continue
            } catch {
                // Not asked: kept as it was, for next time.
                return nil
            }
        }
        if attachedHere, handsOver { worktreesHandedOver.insert(box) }
        // While this Mac follows its own, only what it's told changes them: an answer read before
        // a change since would undo it.
        if box != BoxClient.mac || !followingWorktrees, !changedHere() { take(records, from: box) }
        return Dictionary(records.map { (Self.here($0.root, on: box), $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// The boxes attached in place that took what this Mac kept for them (`takeWorktrees`), this
    /// connection.
    @ObservationIgnored private var worktreesHandedOver: Set<String> = []

    /// `box` connected (again): what this Mac kept there is handed over once more, as it's read.
    func connecting(to box: String) {
        worktreesHandedOver.remove(box)
    }

    /// Whether `folder` is on `box`, as it's named here. Attached in place, the box here is this
    /// Mac's, but what the app's own box kept (named as this Mac's own folders) isn't that box's: it's
    /// never handed to it, nor taken for gone when it doesn't list it.
    private static func isOn(_ folder: String, _ box: String) -> Bool {
        box == BoxClient.mac ? Self.box(of: folder) == box : RemoteFolder.machine(of: folder) == box
    }

    /// `records` as `box`'s worktrees, here, in place of what was known of them. One that's gone
    /// with sessions in it (removed from a phone) is noted as removed, so an archived one brought
    /// back is still its project's.
    private func take(_ records: [BoxWorktree], from box: String) {
        let roots = Set(records.map { Self.here($0.root, on: box) })
        let gone = worktrees.filter { Self.isOn($0.value.root, box) && !roots.contains($0.value.root) }
        for (folder, tree) in gone where sessions.contains(where: { $0.location.directory == folder }) { removedWorktrees[folder] = tree.project }
        if !gone.isEmpty { UserDefaults.standard.set(removedWorktrees, forKey: "removedWorktrees") }
        var mine = worktrees.filter { !Self.isOn($0.value.root, box) }
        for record in records {
            let tree = Worktree(project: Self.here(record.project, on: box), root: Self.here(record.root, on: box), branch: record.branch, base: record.base)
            mine[Self.here(record.folder ?? record.root, on: box)] = tree
            // Other sessions' folders in it stay its own.
            for (folder, kept) in worktrees where kept.root == tree.root { mine[folder] = tree }
        }
        if mine != worktrees {
            worktrees = mine
            saveWorktrees()
        }
    }

    /// `box`'s worktrees that can come back, here, in place of what was known of them.
    private func takeRestorable(_ entries: [RestorableWorktree], from box: String) {
        var mine = restorableWorktrees.filter { !Self.isOn($0.value.root, box) }
        for entry in entries {
            var here = entry
            (here.project, here.root, here.folder) = (Self.here(entry.project, on: box), Self.here(entry.root, on: box), Self.here(entry.folder, on: box))
            mine[here.folder] = here
        }
        if mine != restorableWorktrees { restorableWorktrees = mine }
    }

    /// Brings back the worktree its box removed from `folder`, with the changes it saved, where it
    /// was: its sessions work in it again.
    func restoreWorktree(_ folder: String) async throws {
        guard let entry = restorableWorktrees[folder] else { return }
        let box = Self.box(of: entry.root)
        let record: BoxWorktree = try await onBox(box, "POST", "kuvo/worktrees/restore", ["folder": Self.onBox(folder)])
        restorableWorktrees[folder] = nil
        worktrees[folder] = Worktree(project: Self.here(record.project, on: box), root: Self.here(record.root, on: box), branch: record.branch, base: record.base)
        saveWorktrees()
        if removedWorktrees.removeValue(forKey: folder) != nil { UserDefaults.standard.set(removedWorktrees, forKey: "removedWorktrees") }
    }

    /// A session whose worktree its box removed works on in its project's own folder, told it
    /// no longer works in a worktree. The changes saved with the worktree go once no session is left there.
    func continueInProject(_ id: String) async throws {
        guard let session = session(id), let entry = restorableWorktrees[session.location.directory] else { return }
        try await move(id, toProject: entry.project)
        try? await api(forFolder: entry.project)?.removeInstruction(session: id, key: Self.worktreeInstructionKey)
    }

    /// The worktrees of the box `session` is on, read again when it shows one of them: a
    /// machine's box removes and restores them without telling this Mac (this Mac's own it follows).
    func refreshWorktrees(for session: Session) async {
        let folder = session.location.directory
        guard RemoteFolder.machine(of: folder) != nil, worktrees[folder] != nil || restorableWorktrees[folder] != nil else { return }
        await takeWorktrees(from: Self.box(of: folder))
    }

    /// A worktree its box removed: what a session there shows, and whether it can come back.
    struct RestorableWorktree: Decodable, Hashable {
        var project: String
        var root: String
        var folder: String
        var branch: String
        var base: String?
        /// Its branch or the changes it saved are still there.
        var restorable: Bool
        /// Changes that weren't committed were saved, and come back with it.
        var saved: Bool
        var ahead: Int?
    }

    /// This Mac's worktrees as its box keeps them, from now on: one made, renamed or removed for a
    /// phone shows here as it happens. The box attached in place (`box`) streams them too while
    /// it's reached over its server; while it isn't, it answers once a read, and is read again now
    /// and then instead, as slowly as a machine's things are.
    func followWorktrees(on box: String = BoxClient.mac) async {
        struct Listed: Decodable { var worktrees: [BoxWorktree]; var restorable: [RestorableWorktree]? }
        while !Task.isCancelled {
            guard BoxClient.streams(box) else {
                // (Read as it connected, with what this Mac kept handed over then, or now, if it
                // couldn't be then: only read from then on.)
                try? await Task.sleep(for: BoxClient.readAgainAfter)
                guard !Task.isCancelled else { return }
                await takeWorktrees(from: box)
                continue
            }
            if let client = boxes?(box), await takeWorktrees(from: box) != nil {
                do {
                    for try await line in client.follow("kuvo/worktrees/events") {
                        guard let listed = try? JSONDecoder().decode(Listed.self, from: line) else { continue }
                        if box == BoxClient.mac { followingWorktrees = true }
                        take(listed.worktrees, from: box)
                        takeRestorable(listed.restorable ?? [], from: box)
                    }
                } catch {}
                if box == BoxClient.mac { followingWorktrees = false }
            }
            // The box restarted, or isn't up yet: followed again in a moment.
            try? await Task.sleep(for: .seconds(2))
        }
    }

    /// This Mac's sessions' queues as its box carries them, from now on (one it paused as its engine
    /// started, after a session here was read, shows Paused). A machine's session reads its own.
    func followQueues() async {
        struct Listed: Decodable { var queues: [String: SessionModel.BoxQueue] }
        while !Task.isCancelled {
            if let client = boxes?(BoxClient.mac) {
                do {
                    for try await line in client.follow("kuvo/sessions/queues/events") {
                        guard let listed = try? JSONDecoder().decode(Listed.self, from: line) else { continue }
                        for (id, model) in models where RemoteFolder.machine(of: model.session.location.directory) == nil {
                            let queue = listed.queues[id]
                            model.takeQueue(paused: queue?.paused ?? false, held: queue?.held ?? [], waiting: queue?.waiting ?? [])
                        }
                    }
                } catch {}
            }
            // The box restarted, or isn't up yet: followed again in a moment.
            try? await Task.sleep(for: .seconds(2))
        }
    }

    /// What still runs for `box`'s sessions besides their own turns, as it says (PROTOCOL.md, "Work ›
    /// Background work"), from now on, until the task following it ends (a machine disconnecting). What
    /// it said stands through a dropped stream, and goes once it can't be reached: this Mac doesn't say
    /// what it can't know runs.
    func followBackground(_ box: String) async {
        while !Task.isCancelled {
            var older = false
            var heard = false
            if let client = boxes?(box) {
                do {
                    for try await line in client.follow("kuvo/work/background/events") {
                        heard = true
                        guard let list = try? JSONDecoder().decode(BackgroundList.self, from: line), background[box] != list.sessions else { continue }
                        background[box] = list.sessions
                    }
                } catch let refusal as BoxRefusal {
                    older = refusal.status == 404 || refusal.status == 403
                } catch {}
                if !heard, background[box] != nil { background[box] = nil }
            }
            // The box restarted, or the machine went away: followed again in a moment, at once after a
            // stream that dropped. One from before it told this, only now and then.
            try? await Task.sleep(for: .seconds(older ? 300 : heard || BoxClient.streams(box) ? 2 : 30))
        }
        if background[box] != nil { background[box] = nil }
    }

    /// A worktree as a machine keeps it (its bridge's `kuvo/worktrees`), in its own paths; as it
    /// lists them for its Worktrees page, its root is `path` and `size` the room it takes.
    struct BoxWorktree: Decodable {
        var project: String
        var root: String
        var folder: String?
        var branch: String
        var base: String?
        var size: Int64?
        /// Whether it has changes that aren't committed, and how many commits its base doesn't
        /// have; nil when git couldn't say.
        var uncommitted: Bool?
        var ahead: Int?

        init(project: String, root: String, folder: String?, branch: String, base: String?) {
            (self.project, self.root, self.folder, self.branch, self.base) = (project, root, folder, branch, base)
        }

        private enum CodingKeys: String, CodingKey { case project, root, path, folder, branch, base, size, uncommitted, ahead }

        init(from decoder: any Decoder) throws {
            let keys = try decoder.container(keyedBy: CodingKeys.self)
            project = try keys.decode(String.self, forKey: .project)
            root = try keys.decodeIfPresent(String.self, forKey: .root) ?? keys.decode(String.self, forKey: .path)
            folder = try keys.decodeIfPresent(String.self, forKey: .folder)
            branch = try keys.decode(String.self, forKey: .branch)
            base = try keys.decodeIfPresent(String.self, forKey: .base)
            size = try keys.decodeIfPresent(Int64.self, forKey: .size)
            uncommitted = try keys.decodeIfPresent(Bool.self, forKey: .uncommitted)
            ahead = try keys.decodeIfPresent(Int.self, forKey: .ahead)
        }

        /// What removing it does, as far as git could say: whether changes not committed go with
        /// its folder, and the commits its branch keeps.
        var removalNote: String {
            var note = switch uncommitted {
            case true?: "Its folder is deleted, with changes in it that aren’t committed."
            case false?: "Its folder is deleted. Git sees nothing in it that isn’t committed."
            case nil: "Its folder and anything in it that isn’t committed are deleted."
            }
            if let ahead, ahead > 0 { note += " \(branch) keeps its \(ahead.counting("commit")) not merged yet." }
            return note + " Its sessions stay, without a folder to run in."
        }
    }

    private struct Empty: Decodable {}

    /// A request to `box`'s routes (`boxes`): its answer, or what it said when it said no
    /// (`BoxRefusal`).
    private func onBox<Answer: Decodable>(_ box: String, _ method: String, _ path: String, _ body: [String: Any]?) async throws -> Answer {
        guard let client = boxes?(box) else { throw BoxRefusal(status: 503, message: BoxClient.isThisMac(box) ? "Kuvo Code’s background service on this Mac isn’t running." : "\(box) isn’t connected.") }
        let (status, data) = try await client.send(method, path, body: try body.map { try JSONSerialization.data(withJSONObject: $0) })
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        return try JSONDecoder().decode(Answer.self, from: data)
    }

    private static func loadWorktrees() -> [String: Worktree] {
        guard let data = UserDefaults.standard.data(forKey: "worktrees") else { return [:] }
        return (try? JSONDecoder().decode([String: Worktree].self, from: data)) ?? [:]
    }

    // MARK: Projects on their boxes

    /// Each box's routes (`AppModel.box`): every computer keeps its own projects (PROTOCOL.md,
    /// "Projects"), which any client changes. What's here is a copy of theirs, to show at once.
    @ObservationIgnored var boxes: ((String) -> BoxClient?)?

    /// A project as its box keeps it, its folders as the box names them.
    struct BoxProject: Codable, Equatable {
        var directory: String
        var name: String?
        var folders: [String]?
        var run: String?
        var removed: Bool?
        /// The bot that made it, for one a bot made.
        var madeBy: MadeBy?
    }

    /// The bot that made a project (`make_project`): its id and name.
    struct MadeBy: Codable, Equatable {
        var bot: String
        var name: String
    }

    /// The bot that made each project a bot made, by its folder as it's named here.
    var madeBy: [String: MadeBy] {
        #if DEBUG
        return boxMadeBy.merging(demoMadeBy) { _, demo in demo }
        #else
        return boxMadeBy
        #endif
    }
    private var boxMadeBy: [String: MadeBy] = [:]

    #if DEBUG
    /// Projects marked as a bot's, for a look at them (KUVO_DEMO_MADE_BY).
    private var demoMadeBy: [String: MadeBy] = [:]
    func noteMadeBy(_ folder: String, _ maker: MadeBy) { demoMadeBy[folder] = maker }
    #endif

    /// A box's projects, and the project each of its worktrees' folders belongs to (`worktrees`;
    /// nil from a box from before).
    private struct BoxProjects: Decodable { var projects: [BoxProject]; var worktrees: [String: String]? }

    /// The box a folder's on: a machine's id, or this Mac's (`BoxClient.thisMac`: the app's own, or
    /// the one attached in place).
    static func box(of directory: String) -> String { RemoteFolder.machine(of: directory) ?? BoxClient.thisMac }

    /// This Mac's box, then `machines` (without it, where it's one of them: attached in place).
    static func thisMacThenMachines(_ machines: Set<String>) -> [String] {
        [BoxClient.thisMac] + machines.sorted().filter { $0 != BoxClient.thisMac }
    }

    /// `path` on this Mac, as its box names it: as it is on the app's own box; on the one attached
    /// in place, a folder there (as its sessions are kept). One on a machine already stays.
    static func onThisMac(_ path: String) -> String {
        guard BoxClient.thisMac != BoxClient.mac, RemoteFolder.machine(of: path) == nil else { return path }
        return RemoteFolder.folder(path, on: BoxClient.thisMac)
    }

    /// Where this Mac's chats run: the app's own folder for them, or, attached in place, the box's,
    /// as it names it (`attachedChats`); nil until it has.
    var thisMacsChats: String? { BoxClient.thisMac == BoxClient.mac ? Self.chatsFolder : attachedChats }

    /// The chats folder of the box attached in place, as its box names it (`kuvo/info`'s `chats`, a
    /// folder there), read as the app attaches (`AppModel.readChatsHere`).
    var attachedChats: String?
    /// A folder as its box names it, and as it's named here.
    private static func onBox(_ directory: String) -> String { RemoteFolder.parse(directory)?.path ?? directory }
    private static func here(_ path: String, on box: String) -> String { box == BoxClient.mac ? path : RemoteFolder.folder(path, on: box) }

    /// A query's value, written so a box reads it back exactly (a "+" is a space in a query).
    nonisolated static func queryValue(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~/")) ?? text
    }

    /// Whether `box` keeps its projects: once it has answered, it does from then on, and what's
    /// changed here goes there. Before (a machine on an older Kuvo Code), they're kept here.
    static func keepsProjects(_ box: String) -> Bool { UserDefaults.standard.bool(forKey: "projectsOnBox." + box) }

    /// Projects changed here and not yet taken by their box (it was away, or not up yet), by
    /// folder: sent as they are here when it answers, and shown as they are here meanwhile.
    private var unsentProjects: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "projectsUnsent") ?? []) {
        didSet { UserDefaults.standard.set(Array(unsentProjects).sorted(), forKey: "projectsUnsent") }
    }

    /// `box`'s projects, read from it and shown: those it hasn't removed in the sidebar, each with
    /// its settings (a removed one's too, for when a session brings it back). What's changed here
    /// and not sent yet goes first; the first time, everything kept here for it before boxes kept
    /// their own. A box that can't keep them yet, or isn't answering, is left as it was.
    func loadProjects(on box: String) async {
        await inTurn {
            // A machine disconnected or removed while this waited its turn isn't asked.
            guard !self.isAway(box), let client = self.boxes?(box), await Self.projects(of: client) != nil else { return }
            if !Self.keepsProjects(box) {
                // Its projects, and those it removed (their settings), as they were kept here.
                let kept = Set(self.folders.filter { Self.box(of: $0) == box }).union(self.settings.keys.filter { Self.box(of: $0) == box })
                self.unsentProjects.formUnion(kept)
                UserDefaults.standard.set(true, forKey: "projectsOnBox." + box)
            }
            await self.send(on: box, through: client)
            guard let listed = await Self.projects(of: client) else { return }
            self.take(listed.projects, from: box)
            self.take(worktreeProjects: listed.worktrees, from: box)
        }
    }

    /// `box`'s projects as it has them, from now on: each change, wherever it was made (a phone's
    /// too), as it's made. This Mac's for as long as the app runs; a machine's while it's
    /// connected (its connection ends this, and it ends with the machine removed), from half a
    /// minute after it connects (they're read as it does, `refreshOnce`), and again that long
    /// after its stream ends; an older Kuvo Code there, which can't keep them yet, now and then.
    func followProjects(on box: String = BoxClient.thisMac) async {
        // (A box that streams has them followed (the app's own, and the one attached in place while
        // it's reached over its server: asked each round); any other answers once a read, so it's
        // read now and then.)
        var onThisMac: Bool { BoxClient.streams(box) }
        var older = false
        while !Task.isCancelled, !isRemoved(box) {
            if !onThisMac {
                await MachineClock.wait(older ? 300 : 30)
                guard !Task.isCancelled, !isRemoved(box) else { return }
            }
            older = false
            if let client = boxes?(box) {
                // This Mac's are read first.
                if onThisMac { await loadProjects(on: box) }
                do {
                    for try await line in client.follow("kuvo/projects/events") {
                        guard let listed = try? JSONDecoder().decode(BoxProjects.self, from: line) else { continue }
                        // One it couldn't read as it connected: what's kept here goes to it first.
                        guard Self.keepsProjects(box) else { await loadProjects(on: box); continue }
                        await inTurn {
                            guard !self.isAway(box) else { return }
                            self.take(listed.projects, from: box)
                            self.take(worktreeProjects: listed.worktrees, from: box)
                        }
                    }
                } catch let refusal as BoxRefusal {
                    older = refusal.status == 404
                } catch {}
            }
            // This Mac's box restarted, or isn't up yet: followed again in a moment.
            if onThisMac { try? await Task.sleep(for: .seconds(2)) }
        }
    }

    private static func projects(of client: BoxClient) async -> BoxProjects? {
        try? await client.value(BoxProjects.self, "GET", "kuvo/projects")
    }

    /// `box`'s word on which project each of its worktrees' folders belongs to, here, in place of
    /// what it said before; nothing from a box from before, which leaves what this Mac keeps.
    private func take(worktreeProjects listed: [String: String]?, from box: String) {
        guard let listed else { return }
        var mine = boxWorktreeProjects.filter { Self.box(of: $0.key) != box }
        for (folder, project) in listed { mine[Self.here(folder, on: box)] = Self.here(project, on: box) }
        if mine != boxWorktreeProjects { boxWorktreeProjects = mine }
    }

    /// What's changed here for `box`, sent as it is here: taken off the list once the box has it,
    /// or refuses it for good; kept to send again when it's away.
    private func send(on box: String, through client: BoxClient) async {
        for folder in unsentProjects.filter({ Self.box(of: $0) == box }).sorted() {
            let body = Self.boxBody(settings[folder] ?? ProjectSettings(), removed: !folders.contains(folder))
            guard let (status, _) = try? await client.send("PUT", "kuvo/projects?directory=" + Self.queryValue(Self.onBox(folder)), body: body) else { continue }
            // Changed again while it went: still to send, as it is now (its own turn does).
            let now = Self.boxBody(settings[folder] ?? ProjectSettings(), removed: !folders.contains(folder))
            if (200..<300).contains(status) || status == 400, now == body { unsentProjects.remove(folder) }
        }
    }

    /// `listed` as `box`'s, here, in place of what was known of them; what's changed here and not
    /// sent yet stays as it is here.
    private func take(_ listed: [BoxProject], from box: String) {
        var makers = boxMadeBy.filter { Self.box(of: $0.key) != box }
        for project in listed where project.removed != true { if let maker = project.madeBy { makers[Self.here(project.directory, on: box)] = maker } }
        if makers != boxMadeBy { boxMadeBy = makers }
        let unsent = unsentProjects.filter { Self.box(of: $0) == box }
        let theirs = listed.filter { $0.removed != true }.map { Self.here($0.directory, on: box) }.filter { !unsent.contains($0) }
        // New ones first, as one added here is; the rest where they were.
        let updatedFolders = theirs.filter { !folders.contains($0) } + folders.filter { Self.box(of: $0) != box || theirs.contains($0) || unsent.contains($0) }
        if updatedFolders != folders {
            folders = updatedFolders
            UserDefaults.standard.set(folders, forKey: "projectFolders")
        }
        var updated = settings.filter { Self.box(of: $0.key) != box || unsent.contains($0.key) }
        for project in listed where !unsent.contains(Self.here(project.directory, on: box)) {
            let kept = ProjectSettings(name: project.name, folders: (project.folders ?? []).map { Self.here($0, on: box) }, run: project.run)
            if kept != ProjectSettings() { updated[Self.here(project.directory, on: box)] = kept }
        }
        if updated != settings {
            settings = updated
            saveSettings()
        }
    }

    /// What a box is given for a project's settings: all of them, so it ends up as it is here.
    /// Its keys always in one order, so the same settings are the same body: `send` tells by it
    /// whether they changed while they went (without, one sent was sometimes kept to send again,
    /// and undid what a phone changed next).
    private static func boxBody(_ project: ProjectSettings, removed: Bool) -> Data? {
        struct Body: Encodable { var name: String; var folders: [String]; var run: String; var removed: Bool }
        let body = Body(name: project.name ?? "", folders: project.folders.map(onBox), run: project.run ?? "", removed: removed)
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return try? encoder.encode(body)
    }

    /// The project at `directory`, changed here, on its way to its box (when it answers, if it's
    /// away now); a box that doesn't keep its projects yet gets it with the rest the first time.
    private func keepOnBox(_ directory: String) {
        let box = Self.box(of: directory)
        guard Self.keepsProjects(box), boxes != nil else { return }
        unsentProjects.insert(directory)
        projectTurn = Task { [previous = projectTurn] in
            await previous?.value
            guard let client = self.boxes?(box) else { return }
            await self.send(on: box, through: client)
        }
    }

    /// What's done with boxes' projects, one after another, so a list read never undoes a change
    /// on its way, and changes reach a box in the order they were made.
    @ObservationIgnored private var projectTurn: Task<Void, Never>?

    private func inTurn(_ work: @escaping () async -> Void) async {
        let turn = Task { [previous = projectTurn] in
            await previous?.value
            await work()
        }
        projectTurn = turn
        await turn.value
    }

    /// Your machines' projects read again (back in the app, in case following one missed a change
    /// while its connection dropped for a moment).
    func reloadMachinesProjects() {
        for machine in connectedMachines { Task { await loadProjects(on: machine) } }
    }

    /// Once the changes on their way to boxes have gone (or are waiting for a box that's away).
    func projectsWritten() async {
        await projectTurn?.value
    }

    private func saveWorktrees() {
        UserDefaults.standard.set(try? JSONEncoder().encode(worktrees), forKey: "worktrees")
    }

    static func loadSettings(defaults: UserDefaults = .standard) -> [String: ProjectSettings] {
        guard let data = defaults.data(forKey: "projectSettings"),
              let settings = try? JSONDecoder().decode([String: ProjectSettings].self, from: data) else { return [:] }
        return settings
    }

    private func saveSettings() {
        UserDefaults.standard.set(try? JSONEncoder().encode(settings), forKey: "projectSettings")
    }

    /// A handoff done ("/handoff"): its new conversation, opened as a fork's is.
    func openHandoff(_ handoff: Handoff) async {
        guard let to = handoff.to, let api = api(forSession: handoff.from) else { return }
        if session(to) == nil, let session = try? await api.session(to) { upsert(session) }
        tabs?.open(.session(to))
    }

    /// A new session with `id`'s conversation before `message`, opened in a tab with the
    /// message in its composer, ready to try another way. Its box makes it and marks it as
    /// branched from `id`, so it shows under it.
    func fork(_ id: String, from message: Message.User) async throws {
        Analytics.shared.track("session_branched")
        guard let api = api(forSession: id) else { return }
        // What goes in the new composer, known before anything's made.
        guard let parts = await SentMessage.ensure(id: message.id, text: message.text, metadata: message.metadata, from: box(of: id, else: self.session(id)?.location.directory ?? "")()) else {
            throw BoxRefusal(status: 503, message: SessionModel.unread)
        }
        let session = try await branch(id, before: message.id, api: api)
        upsert(session)
        // The engine's copy carries the attachments; one seen arrive live has them as picked.
        let recent = (try? await api.messages(session: id, limit: 100).data) ?? []
        var stored = message
        for case .user(let user) in recent where user.id == message.id { stored = user }
        // What it replied to comes back over the composer, as you wrote it, and so do its comments
        // (a goal as one).
        let (quotes, written) = Quoting.draft(of: parts.words)
        let words = SentWithKeyword.draft(written, keyword: parts.keyword)
        let files = Attachments.restored(SessionModel.files(of: message, stored: stored), noting: parts.paths)
        var draft = Drafts.Draft(text: words, files: files, quotes: quotes)
        draft.comments = parts.reviewComments
        Drafts.shared[session.id] = draft
        tabs?.open(.session(session.id))
    }

    /// `id`'s conversation before `before`, in a new session marked as branched from it: made by
    /// its box, or, by one from before it could (or with its bridge down), by its engine's fork,
    /// marked from here as the box would.
    private func branch(_ id: String, before: String, api: OpenCodeAPI) async throws -> Session {
        if let box = self.session(id).flatMap({ agents(forFolder: $0.location.directory) })?.api {
            do {
                return try await box.branch(session: id, before: before)
            } catch let error as ServerError where error.status == 404 && error.message == "Not available for this agent." {
                // A box from before branches: its route isn't there.
            }
        }
        var session = try await api.forkSession(id, before: before)
        // Its copy may carry where its source came from: that isn't this one's.
        // Nor is its place in the lists: it starts unpinned and not archived.
        var metadata = (session.metadata?.object ?? [:]).filter { $0.key != Self.pinnedKey && $0.key != Self.archivedKey }
        var kuvo = (metadata["kuvo"]?.object ?? [:]).filter { !["branchedFrom", "handoffFrom", "handoffTo", "startedBy", "beside", "carriedFrom"].contains($0.key) }
        kuvo["branchedFrom"] = .string(id)
        metadata["kuvo"] = .object(kuvo)
        session.metadata = .object(metadata)
        try? await api.setMetadata(session: session.id, .object(metadata))
        return session
    }

    /// An engine session you picked a coding agent's model (or Auto) in: its box carries it on with
    /// the agents, in a session of theirs with its conversation (their first agent is handed all of
    /// it), as a phone's pick does (`carryToAgents`); the new one opens in its place, the engine's
    /// goes to Archived, its draft comes along. `opens`: with no tab of it, the new one opens. Nil:
    /// it isn't there.
    @discardableResult
    func moveToAgents(_ id: String, model: ModelRef, opens: Bool = true) async throws -> Session? {
        // Moving to another computer: it goes to the coding agents once it's there.
        if Moves.isFrozen(id) { throw Moves.Failure.moving }
        // A bot's: its box carries it, as Edit Bot's model does, and the bot keeps it.
        if let moved = try await onBotToAgents?(id, model) {
            Analytics.shared.track("session_moved_to_agents", Analytics.model(provider: model.providerID, model: model.id))
            return moved
        }
        // Nothing you send goes to it meanwhile: it would be left in the archived one.
        Moves.toAgents.insert(id)
        defer { Moves.toAgents.remove(id) }
        guard let moved = try await carryToAgents(id, model: model) else { return nil }
        Analytics.shared.track("session_moved_to_agents", Analytics.model(provider: model.providerID, model: model.id))
        // Its tab (or its place beside one) takes the new one, before the old one goes.
        let swapped = tabs?.swap(from: id, to: moved) == true
        // What you wrote goes with it, all of it to the last moment, and isn't also left behind.
        Drafts.shared[moved] = Drafts.shared[id]
        Drafts.shared.remove(id)
        // One something else keeps (a bot's conversation): it takes the new session, in its place.
        let kept = await onMovedToAgents?(id, moved) == true
        // With no tab of it, it opens as any session does; a bot's that wasn't open stays so.
        if !swapped, !kept, opens { tabs?.open(.session(moved)) }
        // Archived by its box, as it's shown here from now on.
        if !kept, let api = api(forSession: id), let archived = try? await api.session(id) { upsert(archived) }
        return session(moved)
    }

    /// A bot's conversation carried on with the coding agents by its box (the new one), nil for one
    /// that isn't a bot's; the app sets it.
    @ObservationIgnored var onBotToAgents: ((_ id: String, _ model: ModelRef) async throws -> Session?)?

    /// Told when a conversation moved to the coding agents (from, to): true when something else
    /// keeps it, which then takes it over; the app sets it.
    @ObservationIgnored var onMovedToAgents: ((_ from: String, _ to: String) async -> Bool)?

    /// Sessions known to be the agents bridge's before it has told of them (a bot's conversation,
    /// a seat in a group chat): asked there from the start.
    func runsOnAgents(_ ids: some Sequence<String>) {
        // Only when it's news: what's drawn from it is drawn again on each change.
        let ids = Set(ids)
        guard !ids.isSubset(of: bridgeSessions) else { return }
        bridgeSessions.formUnion(ids)
    }

    /// An engine session's conversation carried on with the coding agents by its box
    /// (`POST kuvo/sessions/<id>/agents`, PROTOCOL.md), here or on a machine, as a phone's pick has it
    /// carried: the whole conversation and what was waiting, its wake-ups and Autopilot, and the
    /// engine's archived, or nothing at all when it can't (its box says why). The new session's id
    /// (listed here once its bridge says, at once where it can be read); nil: it isn't there.
    func carryToAgents(_ id: String, model: ModelRef) async throws -> String? {
        guard let session = session(id) else { return nil }
        let directory = session.location.directory
        let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id
        let given = try JSONSerialization.jsonObject(with: JSONEncoder().encode(model))
        struct Carried: Decodable { var session: String }
        let carried: Carried = try await onBox(Self.box(of: directory), "POST", "kuvo/sessions/\(escaped)/agents", ["model": given])
        // (On a machine, its own bridge, beside its engine.)
        if let bridge = agents(forFolder: directory)?.api, let moved = try? await bridge.session(carried.session) {
            upsert(moved)
        } else {
            await refreshAgents()
        }
        return carried.session
    }

    /// A session was deleted: its panel goes with it. The app sets it.
    @ObservationIgnored var onDeleted: ((String) -> Void)?

    /// Deleted on its engine, then here; one its engine doesn't have any more goes too. Out of
    /// the sidebar meanwhile. One its engine refused, or on a computer that isn't connected (a
    /// machine that's away, this Mac's engine not up), stays, with what you'd written in it, and
    /// why is thrown.
    func delete(_ id: String) async throws {
        try Moves.checkNotMoving(id)
        guard let api = api(forSession: id) else {
            throw DeleteFailure.notConnected(machine: session(id).flatMap { RemoteFolder.machine(of: $0.location.directory) })
        }
        deleting.insert(id)
        defer { deleting.remove(id) }
        do {
            try await api.deleteSession(id)
        } catch let error as ServerError where error.status == 404 {
            // Gone there already (deleted from your phone while this Mac wasn't listening).
        }
        drop(id)
    }

    enum DeleteFailure: LocalizedError {
        /// Its machine (nil: this Mac, whose engine isn't up yet).
        case notConnected(machine: String?)

        var errorDescription: String? {
            switch self {
            case .notConnected(let machine?): "\(machine) isn’t connected. Connect to it, then try again."
            case .notConnected(nil): "The engine isn’t running yet. Try again in a moment."
            }
        }
    }

    /// A session gone from its engine (deleted by its box, a bot's): what's here of it goes.
    /// `on`: the box a bot that's gone from it was listed on (nil: this Mac's). When that box says
    /// its conversation moved away, a row of it on another box (where it went) stays, and only
    /// that box's goes.
    func drop(_ id: String, on box: String?? = nil) {
        guard !Moves.isFrozen(id) else { return }
        if case let .some(machine) = box, isAway(id, from: machine), sessions.contains(where: { $0.id == id && RemoteFolder.machine(of: $0.location.directory) != machine }) {
            sessions.removeAll { $0.id == id && RemoteFolder.machine(of: $0.location.directory) == machine }
            if let machine { keepList(of: machine) }
            if let model = models[id], RemoteFolder.machine(of: model.session.location.directory) == machine, let there = session(id), let api = api(for: there) {
                moved([there], api: api)
            }
            return
        }
        onDeleted?(id)
        if let machine = session(id).flatMap({ RemoteFolder.machine(of: $0.location.directory) }) { keepList(of: machine) }
        sessions.removeAll { $0.id == id }
        // Its subagents' (and theirs), which have no row: a tab showing one goes with it.
        for key in subSessions.keys where key == id || root(of: key) == id { subSessions[key] = nil }
        models[id] = nil
        if running.contains(id) { running.remove(id) }
        shellJobs[id] = nil
        Notifier.shared.clear(session: id)
        Drafts.shared.remove(id)
    }

    /// Shown at once; put back as it was if the engine doesn't take it (as `setFlag`), unless it
    /// was renamed again meanwhile. One a move to another computer has (a rename begun before it,
    /// or as it ends) is renamed once it's there, on the engine it lives on then.
    func rename(_ id: String, to title: String) async {
        renames[id, default: 0] += 1
        let asked = renames[id]
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { return }
        let before = sessions[index].title
        // Put back as it was, unless it was renamed again meanwhile.
        let putBack = { [weak self] in
            guard let self, let index = sessions.firstIndex(where: { $0.id == id }), sessions[index].title == title else { return }
            sessions[index].title = before
            // A machine's list as it's kept here for while it's away, too.
            if let machine = RemoteFolder.machine(of: sessions[index].location.directory) { keepList(of: machine) }
        }
        sessions[index].title = title
        if let machine = RemoteFolder.machine(of: sessions[index].location.directory) { keepList(of: machine) }
        // A move has it: once it's there (shown so meanwhile), unless it was renamed again.
        guard (try? await Deliveries.settled(id)) != nil else { return putBack() }
        guard renames[id] == asked else { return }
        guard let index = sessions.firstIndex(where: { $0.id == id }), let api = api(forSession: id) else { return putBack() }
        // (As its list where it lives now read meanwhile may have had it.)
        sessions[index].title = title
        do {
            try await api.renameSession(id, title: title)
        } catch {
            putBack()
        }
    }

    // MARK: Sync

    func refresh() async {
        guard let api else { return }
        do {
            // Sub-sessions too, for under their sessions' rows.
            let everything = try await api.allSessions(roots: false)
            let all = everything.filter { $0.parentID == nil }
            Self.dropLeftScratch(all, api: api)
            keepSubSessions(everything.filter { !isAway($0.id, from: nil) }, box: "mac")
            let local = all.filter { !isHidden($0) && !leavesOut($0.id, from: nil) }
            // Moved here from a machine (asked here or from a phone): an open conversation follows it.
            let arrived = everything.filter { session in !isAway(session.id, from: nil) && models[session.id].map { RemoteFolder.isRemote($0.session.location.directory) } == true }
            if !arrived.isEmpty { moved(arrived, api: api) }
            // (This Mac's: a machine's agents' are its own, with its engine's. Not one that moved
            // away from here: its row is the box's it went to, and it isn't kept for the next launch.)
            // (None without a coding agents' bridge wired, which the app does before this first
            // runs: a list kept by another's has nothing to do with this one.)
            let theAgents = agents == nil ? [] : sessions.filter { OutsideAgents.isAgentSession($0) && !RemoteFolder.isRemote($0.location.directory) && !leavesOut($0.id, from: nil) }
            // An engine's conversation moving away that it no longer lists, and listed nowhere else yet.
            let moving = keptWhileMoving(on: nil, listed: Set(local.map(\.id))) { !OutsideAgents.isAgentSession($0) }
            let before = sessions
            sessions = keepingReads(local + theAgents) + moving + sessions.filter { RemoteFolder.isRemote($0.location.directory) }
            noteArchiving(since: before)
            SessionCopies.saveLocalSessions((local + theAgents).filter { !isAway($0.id, from: nil) })
            // Read before the engine was up: so here, and told it now.
            let localIDs = Set(local.map(\.id))
            for (id, idle) in unsentViews where localIDs.contains(id) {
                unsentViews[id] = nil
                if let index = sessions.firstIndex(where: { $0.id == id }), (sessions[index].time.viewed ?? 0) < idle { sessions[index].time.viewed = idle }
                Task { try? await api.markViewed(id, idle: idle) }
            }
            // Conversations shown as last seen while the engine started take it now, and are read
            // in place (the same messages, so nothing on screen moves); one deleted meanwhile goes.
            for id in beforeEngine {
                guard let model = models[id], !OutsideAgents.isAgentSession(model.session) else { continue }
                guard let session = local.first(where: { $0.id == id }) else {
                    models[id] = nil
                    continue
                }
                model.reconnect(api)
                model.session = session
                Task { await model.load() }
            }
            beforeEngine = beforeEngine.filter { models[$0].map { OutsideAgents.isAgentSession($0.session) } ?? false }
            loadUnreadBranches(on: nil)
        } catch { log.error("sessions: \(String(describing: error), privacy: .public)") }
        do {
            let active = try await api.activeSessions()
            // What this Mac's engine doesn't run stays as it was: a machine's sessions and the
            // bridge's, and their subagents (which have no row: by the session they work for).
            running = active.union(running.filter { id in
                (session(id) ?? session(root(of: id))).map { RemoteFolder.isRemote($0.location.directory) || OutsideAgents.isAgentSession($0) }
                    ?? (sessionMachines[id] != nil || bridgeSessions.contains(id))
            })
            findParents(of: active)
        } catch { log.error("active sessions: \(String(describing: error), privacy: .public)") }
        isLoaded = true
    }

    /// The outside agents' sessions, from the bridge (when it starts, or its feed comes back), in
    /// place of what was known of them. Conversations open meanwhile take it and are read again.
    func refreshAgents() async {
        guard let api = agents?.api else { return }
        // (A machine's come with its engine's: `refresh(_ engine:)`.)
        let isMacs = { (session: Session) in OutsideAgents.isAgentSession(session) && !RemoteFolder.isRemote(session.location.directory) }
        do {
            let everything = try await api.allSessions(roots: false)
            let all = everything.filter { $0.parentID == nil }
            Self.dropLeftScratch(all, api: api)
            keepSubSessions(everything.filter { !isAway($0.id, from: nil) }, box: "mac-agents")
            let listed = all.filter { !isHidden($0) && !leavesOut($0.id, from: nil) }
            let moving = keptWhileMoving(on: nil, listed: Set(listed.map(\.id)), isMacs)
            // Moved here from a machine: an open conversation follows it.
            let arrived = listed.filter { session in models[session.id].map { RemoteFolder.isRemote($0.session.location.directory) } == true }
            if !arrived.isEmpty { moved(arrived, api: api) }
            let before = sessions
            sessions = sessions.filter { !isMacs($0) } + keepingReads(listed) + moving
            noteArchiving(since: before)
            // Read while the bridge was away: so here, and told it now.
            let listedIDs = Set(listed.map(\.id))
            for (id, idle) in unsentViews where listedIDs.contains(id) {
                unsentViews[id] = nil
                if let index = sessions.firstIndex(where: { $0.id == id }), (sessions[index].time.viewed ?? 0) < idle { sessions[index].time.viewed = idle }
                Task { try? await api.markViewed(id, idle: idle) }
            }
            for (id, model) in models where isMacs(model.session) {
                // A subagent's isn't one of the conversations listed: among all of the bridge's.
                guard let session = (model.isSubagent ? everything : listed).first(where: { $0.id == id }) else {
                    // Moving away, and listed nowhere else yet: open as it is, until it's there.
                    if !moving.contains(where: { $0.id == id }) { models[id] = nil }
                    continue
                }
                model.reconnect(api)
                model.session = session
                Task { await model.load() }
            }
            beforeEngine = beforeEngine.filter { id in !listed.contains { $0.id == id } }
            if let active = try? await api.activeSessions() {
                running = running.filter { !isBridgeSession($0, on: nil) }.union(active)
            }
            // Questions it asked before starting over went with it (it keeps them in memory): only
            // those it still asks stay.
            for (request, id) in asking where sharedForms[request] == nil && isBridgeSession(id, on: nil) {
                // Not read: as it was.
                guard let asked = await Self.stillAsked(in: id, api: api), !asked.contains(request) else { continue }
                asking[request] = nil
                Notifier.shared.clear(request: request)
            }
        } catch {
            log.error("agents' sessions: \(String(describing: error), privacy: .public)")
        }
    }

    /// What a session asks now: nil when that couldn't be read (its engine out of reach), none
    /// for a session that's gone (deleted elsewhere meanwhile).
    private static func stillAsked(in session: String, api: OpenCodeAPI) async -> Set<String>? {
        do {
            async let permissions = api.permissions(session: session)
            async let forms = api.forms(session: session)
            return Set(try await permissions.map(\.id) + forms.map(\.id))
        } catch let error as ServerError where error.status == 404 {
            return []
        } catch {
            return nil
        }
    }

    /// The session with the coding agents a hidden engine run works for (Auto's engine model, say),
    /// for what it asks in the panel's browser; nil for any other session.
    func engineRunOwner(_ id: String) async -> String? {
        if let known = engineRunOwners[id] { return known.isEmpty ? nil : known }
        guard session(id) == nil else { return nil }
        // Up through its parents (a subagent of the run): the run says whose it is.
        var current = id
        var owner = ""
        for _ in 0..<5 {
            // Not read (the engine was busy, or restarting): asked again next time.
            guard let found = try? await api?.session(current) else { return nil }
            if let run = found.metadata?["kuvo"]?["engineFor"]?.string {
                owner = run
                break
            }
            guard let parent = found.parentID, session(parent) == nil else { break }
            current = parent
        }
        engineRunOwners[id] = owner
        return owner.isEmpty ? nil : owner
    }

    @ObservationIgnored private var engineRunOwners: [String: String] = [:]

    /// What subagents not known yet asked or settled while they're being found, in order.
    @ObservationIgnored private var helperEvents: [String: [ServerEvent]] = [:]

    /// One of the agents bridge's sessions: a session with the coding agents, or a subagent's of
    /// one (which has no row of its own).
    private func isBridgeSession(_ id: String) -> Bool {
        session(id).map(OutsideAgents.isAgentSession) ?? bridgeSessions.contains(id)
    }

    /// One of the bridge's on `machine` (nil: this Mac's).
    private func isBridgeSession(_ id: String, on machine: String?) -> Bool {
        guard isBridgeSession(id) else { return false }
        let place = session(id).map { RemoteFolder.machine(of: $0.location.directory) } ?? sessionMachines[id]
        return place == machine
    }

    /// This Mac's engine stopped for good (it failed, and starting it again did too): its
    /// sessions aren't at work, nor asking anything, nor running commands, as the agents bridge's
    /// aren't once it stops; so they don't show as working, nor keep the Mac awake.
    func macEngineStopped() {
        func isMac(_ id: String) -> Bool {
            !isBridgeSession(id) && sessionMachines[id] == nil && session(id).map { RemoteFolder.isRemote($0.location.directory) } != true
        }
        // Forms its MCP servers asked (one for every session in a folder here) went with it too.
        for (request, id) in asking where sharedForms[request].map { !RemoteFolder.isRemote($0) } ?? isMac(id) {
            asking[request] = nil
            sharedForms[request] = nil
            Notifier.shared.clear(request: request)
        }
        // (What was heard asked here that its box hasn't listed yet.)
        heardUnlisted = heardUnlisted.filter { !isMac($0.value.sessionID) }
        running = running.filter { !isMac($0) }
        dropShellJobs(where: isMac)
        for model in models.values where isMac(model.id) { model.bridgeStopped() }
    }

    /// Commands that ran for these sessions, gone with the engine that ran them.
    private func dropShellJobs(where gone: (String) -> Bool) {
        for (id, jobs) in shellJobs where gone(id) {
            shellJobs[id] = nil
            for job in jobs { lastingShellJobs.remove(job.id) }
        }
    }

    /// This Mac's agents bridge stopped for good: its sessions aren't at work, nor asking anything.
    func agentsStopped() {
        let isMacs = { (id: String) in self.isBridgeSession(id, on: nil) }
        for (request, id) in asking where sharedForms[request] == nil && isMacs(id) {
            asking[request] = nil
            Notifier.shared.clear(request: request)
        }
        // (What was heard asked there that its box hasn't listed yet.)
        heardUnlisted = heardUnlisted.filter { !isMacs($0.value.sessionID) }
        running = running.filter { !isMacs($0) }
        dropShellJobs(where: isMacs)
        for model in models.values where isMacs(model.id) { model.bridgeStopped() }
    }

    /// The folders of the sessions open or at work on `machine` (nil: this Mac): folders its
    /// engine has open, each with its own MCP servers.
    func openFolders(on machine: String?) -> Set<String> {
        let ids = Set(models.keys).union(running)
        return Set(ids.compactMap { session($0)?.location.directory }.filter { RemoteFolder.machine(of: $0) == machine })
    }

    /// The sessions working on this Mac now (not your machines'): the usage item's "Working in
    /// the background" card lists them.
    var runningHere: [String] {
        running.filter { id in sessionMachines[id] == nil && !(session(id).map { RemoteFolder.isRemote($0.location.directory) } ?? false) }.sorted()
    }

    /// Whether a session on the machine is working (or waiting for an answer).
    func isRunning(on machine: String) -> Bool {
        running.contains { id in
            (session(id).map { RemoteFolder.machine(of: $0.location.directory) } ?? sessionMachines[id]) == machine
        } || asking.values.contains { RemoteFolder.machine(of: session($0)?.location.directory ?? "") == machine }
    }

    /// The run end each bot's session was last told about (as its idle time), so news that came
    /// while a machine was out of reach is told once it's back, and only once.
    @ObservationIgnored private var toldIdle: [String: Double] = [:]
    /// Machines connected since launch: a later connection is a reconnection.
    @ObservationIgnored private var connectedOnce: Set<String> = []

    /// Bots on the machine that finished while it was out of reach (your Mac asleep, say): their
    /// news, in notifications, as if you'd been connected.
    /// (A box that tells its news shows what it told while it was out of reach itself, `BoxNotices`.)
    private func tellMissedNews(in sessions: [Session], machine: String) {
        let reconnected = !connectedOnce.insert(machine).inserted && boxTellsNews?(machine) != true
        for session in sessions where botName?(session.id) != nil {
            guard let idle = session.time.idle else { continue }
            let told = toldIdle[session.id]
            toldIdle[session.id] = max(idle, told ?? 0)
            guard reconnected, session.isUnread, idle > (told ?? 0) else { continue }
            Task {
                let page = try? await api(forSession: session.id)?.messages(session: session.id, limit: 6)
                guard let news = Self.missedNews(page?.data ?? [], outcome: session.outcome, told: told ?? 0) else { return }
                let reply = news == .finished ? await lastReply(of: session.id) : nil
                if let reply { replyPreviews[session.id] = reply }
                Notifier.shared.notify(session: session.id, title: botName?(session.id) ?? session.title ?? "New Session",
                                       body: news == .couldntSummarize ? "Couldn't summarize the conversation." : news == .stopped ? "Stopped with an error." : reply ?? "Finished.", replies: true)
            }
        }
    }

    enum MissedNews { case finished, stopped, couldntSummarize }

    /// What's news of a run missed, with its end told up to `told`. A summary it was asked for after
    /// work already told is no news, unless it failed; work not told yet is, however it was
    /// summarized since, and says how it went itself (a summary's run says how that did).
    static func missedNews(_ messages: [Message], outcome: Session.Outcome?, told: Double) -> MissedNews? {
        let end = messages.lastTurnEnd
        if let summary = messages.summaryAtEnd, (end?.time.created ?? 0) <= told {
            return summary.status == "failed" ? .couldntSummarize : nil
        }
        // (A run that died without writing an end has only its session's word.)
        let went = messages.summaryAtEnd == nil ? outcome : end?.outcome ?? outcome
        return went == .failed ? .stopped : .finished
    }

    /// A machine's sessions, when it connects (or reconnects after a gap), in place of what was
    /// known of them.
    /// False when the machine couldn't list its sessions (to try again).
    @discardableResult
    func refresh(_ engine: MachineEngine) async -> Bool {
        // One at a time for a machine (a reconnect's and its start's), each after the one before:
        // two at once each applied what it read before the other's awaits, bringing back an ask
        // just answered. Each with its own engine, saying how its own went.
        let machine = engine.machine.id
        let previous = refreshes[machine]
        let turn = Task { [weak self] () -> Bool in
            _ = await previous?.value
            return await self?.refreshOnce(engine) ?? true
        }
        refreshes[machine] = turn
        let listed = await turn.value
        if refreshes[machine] == turn { refreshes[machine] = nil }
        return listed
    }

    @ObservationIgnored private var refreshes: [String: Task<Bool, Never>] = [:]
    /// Folders a machine had commands running in when it went away, to read again when it's back.
    @ObservationIgnored private var jobFolders: [String: Set<String>] = [:]

    private func refreshOnce(_ engine: MachineEngine) async -> Bool {
        guard let api = engine.api else { return true }
        let machine = engine.machine.id
        // Still the connection it started with: a newer one (or none) takes over from here.
        let isCurrent = { [weak self] in
            engine.isReady && engine.api?.client.endpoint == api.client.endpoint && self?.machines.contains(machine) == true
        }
        do {
            // (Not one that moved away from it: it lives elsewhere now.)
            // Sub-sessions too, for under their sessions' rows.
            let read = try await api.allSessions(roots: false)
            let everything = read.filter { !isAway($0.id, from: machine) }
            let listed = read.filter { $0.parentID == nil && !leavesOut($0.id, from: machine) }
            // Its coding agents' too, from the agents bridge beside its engine; not read (it's
            // starting), those known stay as they were.
            let bridge = engine.agents.api
            let bridgeRead: [Session]? = if let bridge { try? await bridge.allSessions(roots: false) } else { [] }
            let bridgeEverything = bridgeRead?.filter { !isAway($0.id, from: machine) }
            let bridgeListed = bridgeRead?.filter { $0.parentID == nil && !leavesOut($0.id, from: machine) }
            guard isCurrent() else { return true }
            keepSubSessions(everything, box: machine, machine: machine)
            // Its agents' as they were, when they couldn't be read.
            if let bridgeEverything { keepSubSessions(bridgeEverything, box: machine + "-agents", machine: machine) }
            // Moved here from elsewhere (this Mac, another machine): an open conversation follows it.
            let arrived = everything.filter { session in models[session.id].map { RemoteFolder.machine(of: $0.session.location.directory) != machine && !OutsideAgents.isAgentSession($0.session) } == true }
            if !arrived.isEmpty { moved(arrived, api: api) }
            // And a coding agent's, on its agents bridge there (a bot on Claude Code, say).
            let arrivedAgents = (bridgeEverything ?? []).filter { session in models[session.id].map { RemoteFolder.machine(of: $0.session.location.directory) != machine } == true }
            if let bridge, !arrivedAgents.isEmpty { moved(arrivedAgents, api: bridge) }
            // Its open conversations take this connection first, so nothing sent from them goes
            // to the old one.
            for model in models.values where RemoteFolder.machine(of: model.session.location.directory) == machine {
                if !OutsideAgents.isAgentSession(model.session) { model.reconnect(api) } else if let bridge { model.reconnect(bridge) }
            }
            let fromBridge = (bridgeListed ?? []).filter { !isHidden($0) }
            bridgeSessions.formUnion(fromBridge.map(\.id))
            let keptBridge = bridgeListed != nil ? [] : sessions.filter { RemoteFolder.machine(of: $0.location.directory) == machine && OutsideAgents.isAgentSession($0) && !leavesOut($0.id, from: machine) }
            let theirs = listed.filter { !isHidden($0) } + fromBridge + keptBridge
            let reconnected = connectedOnce.contains(machine)
            tellMissedNews(in: theirs, machine: machine)
            let moving = keptWhileMoving(on: machine, listed: Set(theirs.map(\.id))) { _ in true }
            let before = sessions
            sessions = sessions.filter { RemoteFolder.machine(of: $0.location.directory) != machine } + keepingReads(theirs) + moving
            noteArchiving(since: before)
            for session in theirs { sessionMachines[session.id] = machine }
            remoteSessions = remoteSessions.filter { $0.value.machine != machine }
            for session in theirs { remoteSessions[session.id] = RemoteSession(machine: machine, title: session.title) }
            Self.saveRemoteSessions(remoteSessions)
            SessionCopies.saveSessions(theirs, of: machine)
            connectedMachines.insert(machine)
            // Its projects, as it keeps them.
            Task { await loadProjects(on: machine) }
            loadUnreadBranches(on: machine)
            // Read while it was away: so here, and told there now.
            for (id, idle) in unsentViews where sessionMachines[id] == machine {
                // Gone from it since: nothing to tell.
                guard let session = theirs.first(where: { $0.id == id }) else {
                    unsentViews[id] = nil
                    continue
                }
                // A coding agent's to its bridge (once that answers), the rest to its engine.
                guard let target = OutsideAgents.isAgentSession(session) ? bridge : api else { continue }
                unsentViews[id] = nil
                if let index = sessions.firstIndex(where: { $0.id == id }), (sessions[index].time.viewed ?? 0) < idle { sessions[index].time.viewed = idle }
                Task { try? await target.markViewed(id, idle: idle) }
            }
            // Commands its agents left running, as it lists them now (they were forgotten while it
            // was away, and a restart ended some): in its open and working sessions' folders and
            // those that had one running, not every folder (reading one starts its tools there).
            var folders = Set(theirs.filter { models[$0.id] != nil || running.contains($0.id) }.map(\.location.directory))
            folders.formUnion(jobFolders.removeValue(forKey: machine) ?? [])
            Task { [weak self] in for folder in folders { await self?.readShellJobs(in: folder) } }
            if let active = try? await api.activeSessions(), isCurrent() {
                // (No bridge there, none at work; one not read, as they were.)
                let bridgeActive: Set<String>? = if let bridge { bridgeListed == nil ? nil : try? await bridge.activeSessions() } else { [] }
                // A subagent's session has no row: its machine is the one its events came from.
                // (Its agents' as they were, when they couldn't be read.)
                running = running.filter { id in
                    (session(id).map { RemoteFolder.machine(of: $0.location.directory) } ?? sessionMachines[id]) != machine || (bridgeActive == nil && isBridgeSession(id))
                }.union(active).union(bridgeActive ?? [])
                // A subagent's session has no row: its events will come from here.
                for id in active where session(id) == nil && sessionMachines[id] == nil { sessionMachines[id] = machine }
                findParents(of: active)
                var asked = active.map { (id: $0, api: api) }
                if let bridge, let bridgeActive { asked += bridgeActive.map { (id: $0, api: bridge) } }
                await noteAsks(on: machine, in: asked, tell: reconnected, complete: bridgeActive != nil)
            }
            // Its open conversations, kept while it was away, are read again; one deleted there
            // meanwhile goes. (The list has only the newest, so one missing from it is asked about.)
            let known = Set(listed.map(\.id)).union(fromBridge.map(\.id))
            for (id, model) in models where RemoteFolder.machine(of: model.session.location.directory) == machine {
                // Moving away, and listed nowhere else yet: open as it is, until it's there.
                if moving.contains(where: { $0.id == id }) { continue }
                guard isCurrent() else { return true }
                // An agent's, through the bridge (not read now, as it was).
                let isAgents = OutsideAgents.isAgentSession(model.session)
                guard let place = isAgents ? (bridgeListed == nil ? nil : bridge) : api else { continue }
                if !model.isSubagent, !known.contains(id) {
                    do {
                        model.session = try await place.session(id)
                    } catch {
                        // Not there: it goes. Not answered (busy, or the connection still settling): it
                        // stays, read again with the others, and goes on following the agent there.
                        if (error as? ServerError)?.status == 404 {
                            models[id] = nil
                            continue
                        }
                    }
                } else if let session = listed.first(where: { $0.id == id }) {
                    model.session = session
                }
                await model.load()
            }
        } catch {
            log.error("\(machine, privacy: .public) sessions: \(String(describing: error), privacy: .public)")
            return false
        }
        return true
    }

    /// What a machine's sessions at work ask you, once it's back: `asking` as it is there now and,
    /// when it `tell`s (connected again since launch, as for bots' news), each request made while
    /// it was out of reach (a bot's wake-up while your Mac slept) told then, as it would have
    /// been, since no event brings it. One told before isn't told again.
    private func noteAsks(on machine: String, in active: [(id: String, api: OpenCodeAPI)], tell: Bool, complete wholly: Bool = true) async {
        var found: [String: String] = [:]
        // (Some of its sessions not read at all: what they asked stays as it was.)
        var complete = wholly
        for (id, api) in active {
            async let permissions = api.permissions(session: id)
            async let forms = api.forms(session: id)
            // Couldn't read them: its own are left as they were.
            guard let permissions = try? await permissions, let forms = try? await forms else {
                complete = false
                continue
            }
            for request in permissions {
                // (One its box's reviewer takes up isn't yours: not listed, nor told.)
                guard tellsOnceYours(request) else { continue }
                found[request.id] = request.sessionID
                if tell, asking[request.id] == nil { notifyAsk(request.sessionID, body: Self.describe(request, home: askHome(request.sessionID)), request: request.id, isPermission: true, answerable: Self.showsAll(request), always: alwaysWords(request)) }
            }
            for form in forms where form.sessionID != FormRequest.anySession {
                found[form.id] = form.sessionID
                guard tell, asking[form.id] == nil else { continue }
                let question = Self.question(in: form)
                notifyAsk(form.sessionID, body: question?.text ?? (form.isQuestion ? "Has a question for you." : "Needs your answer."), request: form.id, question: question)
            }
        }
        // Answered meanwhile (on your phone, say): no longer asking.
        let isTheirs = { (id: String) in (self.session(id).map { RemoteFolder.machine(of: $0.location.directory) } ?? self.sessionMachines[id]) == machine }
        let kept = complete ? asking.filter { !isTheirs($0.value) || sharedForms[$0.key] != nil } : asking
        // Answered elsewhere meanwhile (on the phone): its notification goes too, rather than
        // offering an answer to a request that's gone.
        for request in asking.keys where kept[request] == nil && found[request] == nil { Notifier.shared.clear(request: request) }
        asking = kept.merging(found) { $1 }
    }

    /// A machine disconnected: its sessions stay as last seen until it's back, their
    /// conversations to read. Removed for good, they're forgotten.
    /// A machine found to be another one here, reached at another address (see `Machines.fold`):
    /// what's kept under its name (projects, their settings and worktrees) is the other's now. Its
    /// sessions are the other's engine's, listed with the other's, and what you'd written in them
    /// stays.
    func fold(_ machine: String, into other: String) {
        func moved(_ folder: String) -> String {
            guard let parsed = RemoteFolder.parse(folder), parsed.machine == machine else { return folder }
            return RemoteFolder.folder(parsed.path, on: other)
        }
        // Its rows go; the same sessions listed under the other's name (its engine's) stay, at
        // work as they were.
        let gone = Set(sessions.filter { RemoteFolder.machine(of: $0.location.directory) == machine }.map(\.id))
        sessions.removeAll { RemoteFolder.machine(of: $0.location.directory) == machine }
        models = models.filter { RemoteFolder.machine(of: $0.value.session.location.directory) != machine }
        running.subtract(gone.subtracting(sessions.map(\.id)))
        connectedMachines.remove(machine)
        listSaves[machine]?.cancel()
        listSaves[machine] = nil
        for (id, at) in sessionMachines where at == machine { sessionMachines[id] = other }
        SessionCopies.removeSessions(of: machine)
        forgetSessionList(of: machine)
        remoteSessions = remoteSessions.filter { $0.value.machine != machine }
        Self.saveRemoteSessions(remoteSessions)
        // Its projects are the other's now: on their way to its box, if it keeps its own.
        let movedProjects = Set(folders.filter { RemoteFolder.machine(of: $0) == machine } + settings.keys.filter { RemoteFolder.machine(of: $0) == machine }).map(moved)
        var kept: [String] = []
        for folder in folders.map(moved) where !kept.contains(folder) { kept.append(folder) }
        folders = kept
        UserDefaults.standard.set(folders, forKey: "projectFolders")
        unsentProjects.subtract(unsentProjects.filter { RemoteFolder.machine(of: $0) == machine })
        if Self.keepsProjects(other) { unsentProjects.formUnion(movedProjects) }
        // A project added under both names keeps the other's settings, its worktrees theirs.
        func isOthers(_ folder: String) -> Bool { RemoteFolder.machine(of: folder) != machine }
        settings = Dictionary(settings.map { folder, project in
            var project = project
            project.folders = project.folders.map(moved)
            return (moved(folder), (project, isOthers(folder)))
        }, uniquingKeysWith: { one, two in two.1 ? two : one }).mapValues(\.0)
        saveSettings()
        worktrees = Dictionary(worktrees.map { folder, tree in
            var tree = tree
            tree.project = moved(tree.project)
            tree.root = moved(tree.root)
            return (moved(folder), (tree, isOthers(folder)))
        }, uniquingKeysWith: { one, two in two.1 ? two : one }).mapValues(\.0)
        saveWorktrees()
        removedWorktrees = Dictionary(removedWorktrees.map { (moved($0.key), (moved($0.value), isOthers($0.key))) },
                                      uniquingKeysWith: { one, two in two.1 ? two : one }).mapValues(\.0)
        UserDefaults.standard.set(removedWorktrees, forKey: "removedWorktrees")
    }

    /// Machines you removed (`forget(_:forGood:)`), which nothing waits for; a bot there among
    /// them.
    private var removedMachines: Set<String> = []

    private func isRemoved(_ box: String) -> Bool { box != BoxClient.mac && removedMachines.contains(box) }

    /// A machine you removed, or one of yours that isn't connected now: nothing is asked of it.
    private func isAway(_ box: String) -> Bool {
        // (This Mac's box, attached in place too, is reached with no connection: never away.)
        isRemoved(box) || !BoxClient.isThisMac(box) && machines.contains(box) && !connectedMachines.contains(box)
    }

    func forget(_ machine: String, forGood: Bool = false) {
        let gone = Set(sessions.filter { RemoteFolder.machine(of: $0.location.directory) == machine }.map(\.id))
        if !forGood, connectedMachines.contains(machine) { saveList(of: machine) }
        running.subtract(gone)
        // Its commands left running (its subagents' too): unknown until it's back, and read again
        // then in the folders they were in.
        for id in shellJobs.keys where gone.contains(id) || sessionMachines[id] == machine {
            if let folder = session(root(of: id))?.location.directory { jobFolders[machine, default: []].insert(folder) }
            shellJobs[id] = nil
        }
        lastingShellJobs.formIntersection(Set(shellJobs.values.joined().map(\.id)))
        // And its subagents', which have no row.
        running = running.filter { sessionMachines[$0] != machine || session($0) != nil }
        connectedMachines.remove(machine)
        if forGood {
            removedMachines.insert(machine)
            forgetSessionList(of: machine)
            listSaves[machine]?.cancel()
            listSaves[machine] = nil
            sessions.removeAll { gone.contains($0.id) }
            for id in gone {
                models[id] = nil
                Drafts.shared.remove(id)
                unsentViews[id] = nil
            }
            for (id, session) in remoteSessions where session.machine == machine { SessionCopies.remove(id) }
            SessionCopies.removeSessions(of: machine)
            models = models.filter { RemoteFolder.machine(of: $0.value.session.location.directory) != machine }
            remoteSessions = remoteSessions.filter { $0.value.machine != machine }
            Self.saveRemoteSessions(remoteSessions)
            // What its sessions asked goes with them, from the Dock's count and the notifications.
            for (request, session) in asking where gone.contains(session) || sessionMachines[session] == machine {
                asking[request] = nil
                Notifier.shared.clear(request: request)
            }
            // (What was heard asked there that its box hasn't listed yet.)
            heardUnlisted = heardUnlisted.filter { !gone.contains($0.value.sessionID) && sessionMachines[$0.value.sessionID] != machine }
            sessionMachines = sessionMachines.filter { $0.value != machine }
        }
    }

    private static func loadRemoteSessions() -> [String: RemoteSession] {
        guard let data = UserDefaults.standard.data(forKey: "remoteSessions") else { return [:] }
        return (try? JSONDecoder().decode([String: RemoteSession].self, from: data)) ?? [:]
    }

    private static func saveRemoteSessions(_ sessions: [String: RemoteSession]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(sessions), forKey: "remoteSessions")
    }

    /// After a reconnect: re-read the list and every open session. Requests asked while
    /// disconnected are known again from the open sessions.
    func resync() async {
        await refresh()
        let before = asking
        // A machine's asks are its own connection's, which may change them while this reads: as they are.
        asking = asking.filter { sessionMachines[$0.value] != nil }
        // A machine's are read again by its own connection when that's back (see `refresh(_ engine:)`):
        // its feed is its own, and waiting on it here would hold up this Mac's.
        let here = models.values.filter { !RemoteFolder.isRemote($0.session.location.directory) }
        for directory in Set(here.map(\.session.location.directory)) { await readShellJobs(in: directory) }
        for model in models.values {
            if !RemoteFolder.isRemote(model.session.location.directory) { await model.load() }
            // (Not what Auto's reviewer checks: told once its box leaves it for you.)
            for request in model.permissions where tellsOnceYours(request) { asking[request.id] = request.sessionID }
            for form in model.forms { note(form, in: model) }
        }
        for (request, session) in before where asking[request] == nil {
            // The coding agents' are the bridge's, which an engine's reconnect doesn't touch.
            if self.session(session).map(OutsideAgents.isAgentSession) ?? false {
                asking[request] = session
                continue
            }
            // On a machine: answered meanwhile, as its connection says.
            guard sessionMachines[session] == nil else { continue }
            // A closed session's: still asked (or not known), it stays; its notification goes otherwise.
            if sharedForms[request] == nil, let api = api(forSession: session) {
                guard let asked = await Self.stillAsked(in: session, api: api), !asked.contains(request) else {
                    asking[request] = session
                    continue
                }
            }
            Notifier.shared.clear(request: request)
        }
        // One heard asked here that its box hasn't listed, gone meanwhile: never told later.
        for (request, permission) in heardUnlisted where sessionMachines[permission.sessionID] == nil && !isBridgeSession(permission.sessionID) {
            guard let api = api(forSession: permission.sessionID), let asked = await Self.stillAsked(in: permission.sessionID, api: api), !asked.contains(request) else { continue }
            heardUnlisted[request] = nil
        }
    }

    /// An agent on a machine started using its browser.
    @ObservationIgnored var onMachineBrowsing: ((_ machine: String, _ session: String) -> Void)?

    /// An agent showed you a file or folder (its show_in_panel tool), at a path on its machine
    /// (nil: this Mac): the window opens it in the panel.
    @ObservationIgnored var onShowInPanel: ((_ session: String, _ machine: String?, _ path: String, _ isFolder: Bool) -> Void)?
    /// Those calls under way, by ID, with their paths once they're known.
    @ObservationIgnored private var panelCalls: [String: String] = [:]

    /// Follows show_in_panel's calls: what they're for when they're made, and once the tool says
    /// the path is there, it's shown.
    private func noteShowInPanel(_ event: ServerEvent, machine: String?) {
        guard let session = event.sessionID else { return }
        switch event.type {
        case "session.tool.input.started":
            if let started = try? event.payload(as: EventPayload.ToolInputStarted.self), started.name == "kuvo-browser_" + BrowserTools.showInPanel {
                panelCalls[started.id] = ""
            }
        case "session.tool.called":
            if let called = try? event.payload(as: EventPayload.ToolCalled.self), panelCalls[called.id] != nil {
                panelCalls[called.id] = called.input["path"]?.string ?? ""
            }
        case "session.tool.success":
            guard let done = try? event.payload(as: EventPayload.ToolSucceeded.self), let path = panelCalls.removeValue(forKey: done.id), !path.isEmpty else { return }
            let said = done.content.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined()
            guard let isFolder = BrowserTools.shownFolder(in: said) else { return }
            onShowInPanel?(session, machine, path, isFolder)
        case "session.tool.failed":
            if let failed = try? event.payload(as: EventPayload.ToolFailed.self) {
                panelCalls[failed.id] = nil
            }
        default:
            break
        }
    }
    /// A bot's name, by its session, for its notifications.
    @ObservationIgnored var botName: ((String) -> String?)?
    /// Whether a box tells its own news (`BoxNotices`), by its id: this Mac words none of it then.
    @ObservationIgnored var boxTellsNews: ((String) -> Bool)?
    /// A session's run ended (a bot's memory may have changed).
    @ObservationIgnored var onRunEnded: ((String) -> Void)?

    /// The start of a bot's last reply, for its row in the sidebar while it's unread, as a chat
    /// list shows a message.
    private(set) var replyPreviews: [String: String] = [:]

    /// Reads a bot's last reply for its row, unless it's known.
    func loadReplyPreview(_ id: String) async {
        guard replyPreviews[id] == nil, let reply = await lastReply(of: id) else { return }
        replyPreviews[id] = reply
    }

    /// The text of a session's last reply, shortened for a notification.
    private func lastReply(of id: String) async -> String? {
        guard let page = try? await api(forSession: id)?.messages(session: id, limit: 6) else { return nil }
        for message in page.data.reversed() {
            guard case .assistant(let reply) = message else { continue }
            let text = reply.content.compactMap { content -> String? in
                if case .text(let text) = content { text.text } else { nil }
            }.joined(separator: " ")
            let plain = ReplyPreview.line(text)
            guard !plain.isEmpty else { continue }
            return plain
        }
        return nil
    }
    /// How a summary asked for (`/compact`, a lead's compact_session) went, if that's what the session did last.
    private func summaryAtEnd(_ id: String) async -> String? {
        guard let page = try? await api(forSession: id)?.messages(session: id, limit: 6) else { return nil }
        return page.data.summaryAtEnd?.status
    }

    /// An agent (in a session, on a machine or this Mac) is asking you for something in its browser.
    @ObservationIgnored var onBrowserAsk: ((_ session: String, _ machine: String?) -> Void)?
    /// A run was refused its model's sign-in (it ran out and couldn't be renewed), or a step on it
    /// ended well (`ended` false): the provider, and the machine whose engine it is (nil: this Mac's).
    @ObservationIgnored var onSignInEnded: ((_ provider: String, _ machine: String?, _ ended: Bool) -> Void)?

    /// An event from this Mac's engine, or from `machine`'s.
    func handle(_ event: ServerEvent, machine: String? = nil) {
        // A machine removed while its engine stops: what it still says isn't kept.
        if let machine, !machines.contains(machine) { return }
        #if DEBUG
        // KUVO_DEMO_LOG_EVENTS: each session event in the log, to see their order.
        if Self.logsEvents, event.sessionID != nil {
            log.notice("event \(event.type, privacy: .public) \(String(decoding: event.raw.prefix(300), as: UTF8.self), privacy: .public)")
        }
        #endif
        // What an MCP server asks (and its answer): for the conversations of its folder there.
        if (event.sessionID ?? Self.formSessionID(event)) == FormRequest.anySession {
            handleShared(event, machine: machine)
            return
        }
        // From where a conversation moved away from, or where it's being copied to (`Moves`): not
        // where it lives, so nothing of it counts here.
        if let id = event.sessionID, isAway(id, from: machine) { return }
        if let machine, let id = event.sessionID { sessionMachines[id] = machine }
        // What its box says the session is may have changed with it (made, moved, marked, gone).
        if event.sessionID != nil, Self.listEvents.contains(event.type) { listChanged(on: machine ?? BoxClient.thisMac) }
        noteShowInPanel(event, machine: machine)
        if event.type == "session.tool.input.started", let id = event.sessionID,
           let started = try? event.payload(as: EventPayload.ToolInputStarted.self), started.name.hasPrefix("kuvo-browser_browser_") {
            if let machine {
                onMachineBrowsing?(machine, id)
                // (The box attached in place's browser runs on this Mac: counted as this Mac's.)
                let place = BoxClient.isMachine(machine) ? "machine" : "mac"
                Analytics.shared.trackOnce("browser_used", key: "agent." + place, ["by": "agent", "place": place])
            }
            if ["kuvo-browser_browser_sign_in", "kuvo-browser_browser_ask_code", "kuvo-browser_browser_ask_user"].contains(started.name) {
                onBrowserAsk?(id, machine)
            }
        }
        if event.type == "vcs.branch.updated", let directory = event.location?.directory {
            struct Branch: Decodable { var branch: String? }
            let folder = machine.map { RemoteFolder.folder(directory, on: $0) } ?? directory
            // Newer than any read asked so far, which can't undo it when it lands.
            branchShown[folder] = nextBranchRead(folder)
            branches[folder] = (try? event.payload(as: Branch.self))?.branch
            // And the branch it goes into, which an engine that just started didn't know at first
            // (read again, as opencode's own client does).
            Task { await loadBranch(for: folder) }
        }
        noteShellJob(event)
        if let id = event.sessionID ?? Self.formSessionID(event), let model = models[id] {
            model.apply(event)
        }
        // A subagent's asks: shown in the conversation it works for (found first, for one at work
        // before the app knew of it, its asks and answers kept in order meanwhile).
        if SessionModel.runEnds.contains(event.type), let id = event.sessionID, helperEvents[id] != nil {
            // Its run ended while it's being found: what it asked goes with it.
            helperEvents[id]?.append(event)
        } else if Self.asksEvents.contains(event.type), let id = event.sessionID ?? Self.formSessionID(event), session(id) == nil, parents[id] == nil, models[id] == nil, id != FormRequest.anySession {
            if helperEvents[id] != nil {
                helperEvents[id]?.append(event)
            } else {
                helperEvents[id] = [event]
                Task {
                    await reload(id)
                    let events = helperEvents.removeValue(forKey: id) ?? []
                    let parent = root(of: id)
                    if parent != id, let model = models[parent] { for event in events { model.applyHelper(event, from: id) } }
                }
            }
        } else if Self.asksEvents.contains(event.type) || SessionModel.runEnds.contains(event.type), let id = event.sessionID ?? Self.formSessionID(event),
                  case let parent = root(of: id), parent != id, let model = models[parent] {
            model.applyHelper(event, from: id)
        }
        noteQuestions(event)
        guard let id = event.sessionID else { return }
        // A sign-in that couldn't be renewed (the engine says only "Request failed: 400" then), and
        // one that works again (a step that ended well).
        if event.type == "session.execution.failed" {
            struct Failed: Decodable { var error: StructuredError? }
            if let error = (try? event.payload(as: Failed.self))?.error, error.type == "provider.auth", error.message.hasPrefix("Request failed"),
               let provider = session(id)?.model?.providerID {
                onSignInEnded?(provider, machine, true)
            }
        } else if event.type == "session.step.ended", let provider = session(id)?.model?.providerID {
            onSignInEnded?(provider, machine, false)
        }
        // A run's first words, thought or tool: how long the model took to start.
        if runStarted[id] != nil, firstOutput[id] == nil, ["session.text.started", "session.reasoning.started", "session.tool.input.started"].contains(event.type) {
            firstOutput[id] = RunInstant(onMachine: machine != nil)
        }

        switch event.type {
        case "session.created", "session.renamed", "session.moved", "session.metadata.updated", "session.revert.staged", "session.revert.cleared", "session.revert.committed":
            reloading[id] = Task {
                await reload(id, from: machine)
                reloading[id] = nil
            }
        case "session.deleted":
            // One moving (`Moves`), let go of by the box it's leaving before that box's word that
            // it's away came: the conversation lives on where it went. Only this box's row of it goes (one listed before
            // it moved), whichever is first, never the row of the box it went to; and while it's
            // moving, not its only row (it stays until it's listed where it went, its tab with it).
            // (One from a box that says it doesn't live there never comes this far.)
            let leaving = Moves.isFrozen(id)
            let elsewhere = sessions.contains { $0.id == id && RemoteFolder.machine(of: $0.location.directory) != machine }
            if leaving, !elsewhere, session(id) != nil { break }
            if leaving, elsewhere {
                let before = sessions.count
                sessions.removeAll { $0.id == id && RemoteFolder.machine(of: $0.location.directory) == machine }
                if sessions.count != before, let machine { keepList(of: machine) }
                // Open on that box's: it goes on where it lives.
                if let model = models[id], RemoteFolder.machine(of: model.session.location.directory) == machine, let there = session(id), let api = api(for: there) {
                    moved([there], api: api)
                }
                break
            }
            // Listed (first) on another box than the one that deleted it: it lives on there.
            if let found = session(id) ?? subSession(id), RemoteFolder.machine(of: found.location.directory) != machine { break }
            // Deleted elsewhere (another Mac, the phone): its panel's tabs go too, a terminal's
            // connection with them.
            onDeleted?(id)
            Drafts.shared.remove(id)
            sessions.removeAll { $0.id == id }
            if let machine { keepList(of: machine) }
            if remoteSessions.removeValue(forKey: id) != nil { Self.saveRemoteSessions(remoteSessions) }
            SessionCopies.remove(id)
            // The files you sent in it, this Mac's copies (this Mac's box lets its own sessions' go).
            if machine != nil { Attachments.forget(session: id) }
            models[id] = nil
            asking = asking.filter { $0.value != id }
            // (What was heard asked in it that its box hasn't listed yet.)
            heardUnlisted = heardUnlisted.filter { $0.value.sessionID != id && root(of: $0.value.sessionID) != id }
            // Deleted while it worked: it isn't working any more (nor keeping the Mac awake).
            if running.contains(id) { running.remove(id) }
            shellJobs[id] = nil
            Notifier.shared.clear(session: id)
            if let parent = parents[id] { subSessions[parent]?.removeAll { $0.id == id } }
            subSessions[id] = nil
        case "session.execution.started":
            running.insert(id)
            // A session with no row may be a subagent's: whose it is, so the one that started it
            // shows working while it does (in the background, after its own turn has ended).
            if session(id) == nil, parents[id] == nil { Task { await reload(id) } }
            runStarted[id] = RunInstant(onMachine: machine != nil)
            firstOutput[id] = nil
            if let session = session(id) { usageAtStart[id] = (Self.tokenCount(session.tokens), session.cost) }
            touch(id)
        case "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted":
            running.remove(id)
            endedRuns[id, default: 0] += 1
            noteTurn(id, event)
            onRunEnded?(id)
            // A subagent's session has no row: the engine names those, and it's not to be renamed.
            if let session = session(id), session.title?.isEmpty != false { nameIfUntitled(id) }
            // Picks up the new idle time (unread state) and outcome.
            Task {
                await reload(id)
                // A run you stopped needs no news.
                if event.type != "session.execution.interrupted", let session = session(id) {
                    let failed = event.type == "session.execution.failed"
                    // What it said last, as a chat app's notification shows the message, and a
                    // bot's row.
                    let isBot = botName?(id) != nil
                    // Only a summary it was asked for: not news, and its row keeps its last reply.
                    // One that failed says only that, whichever way its run ended (the engine's says
                    // it succeeded).
                    let summary = await summaryAtEnd(id)
                    let summaryFailed = summary == "failed"
                    if !failed, summary == "completed" {
                        if let idle = self.session(id)?.time.idle { toldIdle[id] = max(idle, toldIdle[id] ?? 0) }
                        return
                    }
                    let reply = failed || summaryFailed || !(Notifier.isEnabled || isBot) ? nil : await lastReply(of: id)
                    // Read on another client meanwhile: it's news no more.
                    if let idle = self.session(id)?.time.idle, (readElsewhere[id] ?? 0) >= idle { return }
                    if isBot, !summaryFailed { replyPreviews[id] = reply }
                    // Told: a reconnection won't tell it again.
                    if let idle = self.session(id)?.time.idle { toldIdle[id] = max(idle, toldIdle[id] ?? 0) }
                    // Its box tells its news (`BoxNotices`): whether it's news, and how it's said, is
                    // the box's; what follows words it here for a box from before it did, or whose bridge isn't running.
                    // COMPAT(0.7 box-notices): the Mac wording a box's news itself. Goes once a box tells its news without its bridge.
                    let machine = sessionMachines[id] ?? RemoteFolder.machine(of: session.location.directory)
                    if boxTellsNews?(machine ?? BoxClient.mac) == true { return }
                    Notifier.shared.notify(
                        session: id,
                        title: botName?(id) ?? session.title ?? "New Session",
                        subtitle: botName?(id) == nil ? projectName(of: session) : nil,
                        body: summaryFailed ? "Couldn't summarize the conversation." : failed ? "Stopped with an error." : reply ?? "Finished.",
                        replies: true,
                        push: .init(failed || summaryFailed ? .failed : isBot ? .report : .finished, machine: machine)
                    )
                }
            }
        // Read on another client (the phone, another Mac): read here too, its notification gone.
        case "session.viewed":
            if let viewed = try? event.payload(as: EventPayload.Viewed.self) { sawViewed(id, idle: viewed.idle) }
        case "session.usage.updated":
            if let usage = try? event.payload(as: EventPayload.Usage.self), let index = sessions.firstIndex(where: { $0.id == id }) {
                sessions[index].cost = usage.cost
                sessions[index].tokens = usage.tokens
            }
        // Chosen elsewhere too (a bot's editor, the phone, another Mac): the open conversation's
        // composer shows it, and picking the one before works again.
        case "session.model.selected":
            if let selected = try? event.payload(as: EventPayload.ModelSelected.self) {
                if let index = sessions.firstIndex(where: { $0.id == id }) { sessions[index].model = selected.model }
                if let model = models[id], model.session.model != selected.model { model.session.model = selected.model }
            }
        case "session.agent.selected":
            if let selected = try? event.payload(as: EventPayload.AgentSelected.self) {
                if let index = sessions.firstIndex(where: { $0.id == id }) { sessions[index].agent = selected.agent }
                if let model = models[id], model.session.agent != selected.agent { model.session.agent = selected.agent }
            }
        default:
            break
        }
    }

    /// When a run began and first had something to show: never less than nothing when the clock
    /// is set back.
    @ObservationIgnored private var runStarted: [String: RunInstant] = [:]
    @ObservationIgnored private var firstOutput: [String: RunInstant] = [:]

    /// A moment in a run. One here counts while the Mac is awake, as it stops while it sleeps;
    /// one on a machine counts the time the Mac slept too, as it carries on there.
    private struct RunInstant {
        let onMachine: Bool
        let awake = SuspendingClock.now
        let always = ContinuousClock.now

        func seconds(since start: RunInstant) -> Int {
            Int((start.onMachine ? always - start.always : awake - start.awake).components.seconds)
        }
    }
    /// A session's tokens and cost as a run began, to tell what the run used.
    @ObservationIgnored private var usageAtStart: [String: (tokens: Int, cost: Double)] = [:]

    private static func tokenCount(_ tokens: TokenUsage) -> Int {
        tokens.input + tokens.output + tokens.reasoning
    }

    /// A session the engine didn't name after its run (its title model gave nothing back, as
    /// GLM-5.3 Flash's does, or a coding agent can't write one, as Antigravity can't): for a
    /// session with the coding agents (whose bridge tried your title model and your other agents
    /// already), a title from this Mac's engine's default model; else the start of its first
    /// message, as a chat app names one, so the sidebar isn't a column of "New Session". (An
    /// engine session's message goes to no other model than the one you chose for titles.) Saved
    /// in the engine, for every place that shows it.
    private func nameIfUntitled(_ id: String) {
        guard !seats.contains(id), !namingUntitled.contains(id) else { return }
        namingUntitled.insert(id)
        Task {
            defer { namingUntitled.remove(id) }
            // The engine names it a few seconds after the run, when it can.
            try? await Task.sleep(for: .seconds(15))
            guard let session = session(id), session.parentID == nil, session.title?.isEmpty != false, let api = api(forSession: id),
                  let page = try? await api.firstMessages(session: id, limit: 10) else { return }
            // What you wrote first, as it shows in the conversation (its parts, as its box keeps or
            // reads them): a command as you typed it, without the note on attached files, and another
            // agent's message without its header.
            await SentMessage.read(page.data, from: box(of: id, else: session.location.directory)())
            let users = page.data.compactMap { message -> Message.User? in if case .user(let user) = message { user } else { nil } }
            let first = users.lazy.map(SentMessage.parts).first { !$0.words.isEmpty }
            guard let first else { return }
            let written = OutsideAgents.runsInBridge(session.model?.providerID) ? try? await self.api?.generate(Self.titlePrompt(for: first.words)) : nil
            guard let title = written.flatMap(Self.cleanTitle) ?? Self.title(from: first),
                  self.session(id)?.title?.isEmpty != false else { return }
            try? await api.renameSession(id, title: title)
            await reload(id)
        }
    }
    @ObservationIgnored private var namingUntitled: Set<String> = []

    /// What a model is asked for a title, as the agents bridge asks.
    nonisolated static func titlePrompt(for message: String) -> String {
        "Write a title for a conversation that begins with the message below: a few words (six at most) saying what it's about, in the message's language. Reply with the title alone, without quotes or a period at the end.\n\n<message>\n\(message.prefix(4000))\n</message>"
    }

    /// A model's answer as a title: its first line, without quotes or a period around it.
    nonisolated static func cleanTitle(_ answer: String) -> String? {
        var line = answer.split(whereSeparator: \.isNewline).lazy.map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        if line.lowercased().hasPrefix("title:") { line = String(line.dropFirst(6)) }
        let title = line.trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”‘’`*# ")).trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”‘’`* ."))
        return title.isEmpty ? nil : String(title.prefix(80))
    }

    /// A title from a message's parts: its words (or its first comment on the changes) without line
    /// breaks, up to the end of its first sentence or about 48 characters, at a word. A dot in
    /// a word (README.md, a web address) doesn't end a sentence.
    nonisolated static func title(from message: MessageParts) -> String? {
        let words = (message.words.isEmpty ? message.comments.first?.text ?? "" : message.words)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !words.isEmpty else { return nil }
        var title = words
        let end = title.indices.first { index in
            ".?!".contains(title[index]) && (title.index(after: index) == title.endIndex || title[title.index(after: index)] == " ")
        }
        if let end, title.distance(from: title.startIndex, to: end) >= 12 {
            title = String(title[...end])
        }
        if title.count > 48 {
            let cut = title.prefix(48)
            title = (cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? String(cut)) + "…"
        }
        return title.hasSuffix(".") ? String(title.dropLast()) : title
    }

    /// How a run ended, for anonymous usage: the outcome, how long it took, with which model, and
    /// for a failure the engine's error type and status, never its message.
    private func noteTurn(_ id: String, _ event: ServerEvent) {
        let ended = try? event.payload(as: EventPayload.ExecutionEnded.self)
        guard ended?.reason != "shutdown" else { return }
        let session = session(id)
        var props = Analytics.model(provider: session?.model?.providerID, model: session?.model?.id)
        props["outcome"] = switch event.type {
        case "session.execution.succeeded": "done"
        case "session.execution.failed": "failed"
        default: "stopped"
        }
        // A subagent's session has no row of its own.
        props["subagent"] = session == nil
        if let started = runStarted.removeValue(forKey: id) {
            props["seconds"] = RunInstant(onMachine: started.onMachine).seconds(since: started)
            if let first = firstOutput.removeValue(forKey: id) { props["first_token_seconds"] = first.seconds(since: started) }
        }
        if let start = usageAtStart.removeValue(forKey: id), let session {
            props["tokens"] = Analytics.tokens(Double(max(0, Self.tokenCount(session.tokens) - start.tokens)))
            props["cost"] = Analytics.cost(max(0, session.cost - start.cost))
        }
        if event.type == "session.execution.failed", let error = ended?.error {
            props["error"] = String(error.type.lowercased().filter { $0.isLetter || $0 == "_" }.prefix(40))
            if let status = error.status { props["status"] = status }
            // What kind of trouble, from its words, which stay here.
            props["error_type"] = Analytics.trouble(status: error.status, error.type + " " + error.message)
        }
        Analytics.shared.track("turn_finished", props)
        Analytics.shared.noteTurn(in: id)
    }

    private static let asksEvents: Set<String> = ["permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled"]

    /// Keeps `asking` current, and tells you about a new request while you're elsewhere.
    private func noteQuestions(_ event: ServerEvent) {
        switch event.type {
        case "permission.asked":
            // (Told already: its box listed it yours before its event came.)
            guard let request = try? event.payload(as: PermissionRequest.self), asking[request.id] == nil, tellsOnceYours(request) else { return }
            tellYours(request)
        case "permission.replied":
            if let reply = try? event.payload(as: EventPayload.PermissionReplied.self) { settled(reply.requestID) }
        case "form.created":
            guard let form = try? event.payload(as: EventPayload.FormCreated.self).form else { return }
            // (On Autopilot it counts once its box says it waits on you: `notifyAsk`.)
            if !isOnAutopilot(form.sessionID) { asking[form.id] = form.sessionID }
            let question = Self.question(in: form)
            notifyAsk(form.sessionID, body: question?.text ?? (form.isQuestion ? "Has a question for you." : "Needs your answer."), request: form.id, question: question)
        case "form.replied", "form.cancelled":
            if let form = try? event.payload(as: EventPayload.FormSettled.self) { settled(form.id) }
        case _ where SessionModel.runEnds.contains(event.type):
            // The engine lets what a run asked go with it, without a word (the coding agents'
            // bridge says itself). Its permissions are named `per_…`.
            guard let ended = event.sessionID, !isBridgeSession(ended) else { return }
            for (request, session) in asking where session == ended && request.hasPrefix("per_") { settled(request) }
            for (request, permission) in heardUnlisted where permission.sessionID == ended && request.hasPrefix("per_") { heardUnlisted[request] = nil }
        default:
            break
        }
    }

    /// The agent's question as its notification asks it, with its choices; nil for anything
    /// more (the notification opens the conversation).
    private static func question(in form: FormRequest) -> Notifier.Question? {
        form.single.map { single in
            Notifier.Question(session: form.sessionID, form: form.id, key: single.key, text: single.text,
                              choices: single.choices.map { (value: $0.value, label: $0.label) }, allowsText: single.allowsText)
        }
    }

    /// Answers a question from its notification.
    func answerQuestion(_ form: String, in session: String, field: String, with answer: String) {
        Analytics.shared.track("question_answered", ["kind": "question", "from": "notification"])
        Task {
            guard let api = api(forSession: session) else { return answerDidntGo(in: session) }
            do {
                try await api.reply(session: session, form: form, answer: [field: .string(answer)])
            } catch {
                await answerFailed(form, in: session, api: api) { try await $0.forms(session: session).contains { $0.id == form } }
            }
        }
    }

    /// The agent still waits for an answer from a notification that didn't go: says so, rather
    /// than lose the answer.
    private func answerDidntGo(in session: String) {
        Notifier.shared.notify(session: session, title: botName?(session) ?? self.session(session)?.title ?? AppInfo.name,
                               body: "Your answer didn’t go. Open the conversation to answer there.")
    }

    /// A notification's answer that didn't go. An ask gone meanwhile (answered on your phone
    /// first, its word not here yet) just goes, its card too, as a card's does; one still asked,
    /// or that can't be told gone, says the answer didn't go.
    private func answerFailed(_ request: String, in session: String, api: OpenCodeAPI, asked: (OpenCodeAPI) async throws -> Bool) async {
        // A session not known here was answered on this Mac's engine at a guess: its list counts
        // only if it has the session (a machine's subagent, before its events say whose it is).
        var known = self.session(session) != nil || bridgeSessions.contains(session) || sessionMachines[session] != nil
        if !known { known = (try? await api.session(session)) != nil }
        guard known, (try? await asked(api)) == false else { return answerDidntGo(in: session) }
        for id in Set([session, root(of: session)]) { models[id]?.dropAsk(request) }
        settled(request)
    }

    /// Sends a message to a session from outside its conversation (a notification's Reply), with
    /// the model it last used. While it moves to another computer it waits, and goes once it's
    /// there (if the app quits first, it's in the conversation's composer the next time). Says so
    /// in a notification if it didn't go.
    func send(_ text: String, to id: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let failure: String
        // Kept until it's gone: one the app quits on while it waits is in the composer next time.
        let kept = Drafts.shared.onItsWay(text, to: id)
        defer { Drafts.shared.sent(kept) }
        do {
            // Moving to another computer: once it's there.
            try await Deliveries.send(text, to: id, delivery: .queue, on: api(forSession: id))
            Analytics.shared.track("notification_replied")
            return
        } catch {
            failure = error.localizedDescription
        }
        Notifier.shared.notify(session: id, title: botName?(id) ?? session(id)?.title ?? AppInfo.name,
                               body: "Your reply didn’t go: \(failure) Open the conversation to send it again.")
    }

    /// `request` is the permission or the form, for a notification whose buttons answer it.
    /// `answerable`: its buttons answer it (not when the notification can't show all it covers).
    /// Asks whose notification is being made (its session read first), and those of them
    /// answered or gone meanwhile.
    private(set) var notifying: Set<String> = []
    @ObservationIgnored private var settledWhileNotifying: Set<String> = []

    /// An ask answered (here or elsewhere) or gone with its run: off the Dock's count, and its
    /// notification goes, or isn't posted if it's still being made.
    private func settled(_ request: String) {
        asking[request] = nil
        heardUnlisted[request] = nil
        if notifying.contains(request) { settledWhileNotifying.insert(request) }
        Notifier.shared.clear(request: request)
    }

    /// Whether a permission is yours now. One its box's reviewer takes up is told once its box
    /// lists it as yours (`Sandboxes.onYours`), read from its engine then: its box keeps it to its end.
    private func tellsOnceYours(_ request: PermissionRequest) -> Bool {
        guard !Sandboxes.shared.isYours(request, on: box(of: request)) else { return true }
        if Sandboxes.shared.review(of: request.id) == nil { heardUnlisted[request.id] = request }
        return false
    }

    private func box(of request: PermissionRequest) -> String {
        sessionMachines[request.sessionID] ?? session(request.sessionID).map { Self.box(of: $0.location.directory) } ?? BoxClient.thisMac
    }

    /// A permission that's yours: waiting on you, and told.
    private func tellYours(_ request: PermissionRequest) {
        asking[request.id] = request.sessionID
        notifyAsk(request.sessionID, body: Self.describe(request, home: askHome(request.sessionID)), request: request.id, isPermission: true, answerable: Self.showsAll(request), always: alwaysWords(request))
    }

    /// One its box's reviewer took up turned out to be yours (nil: its box not heard now): the one
    /// it lists yours, as its engine still asks it; what it last listed of the rest stands.
    func reviewLeftForYou(_ id: String?) {
        if let id, let listed = Sandboxes.shared.review(of: id), listed.review.state == .yours {
            let session = listed.review.session
            // (As its open conversation has it, at once; else as its engine says.)
            if let request = models[session]?.permissions.first(where: { $0.id == id }) ?? models[root(of: session)]?.permissions.first(where: { $0.id == id }) {
                if asking[id] == nil { tellYours(request) }
            } else {
                Task { await tellLeftForYou(id, in: session) }
            }
            return
        }
        // Heard asked and not listed by a box that keeps them, which went quiet first: yours.
        guard id == nil else { return }
        for (id, request) in heardUnlisted {
            if Sandboxes.shared.review(of: id) != nil {
                heardUnlisted[id] = nil
            } else if Sandboxes.shared.isYours(request, on: box(of: request)) {
                heardUnlisted[id] = nil
                if asking[id] == nil { tellYours(request) }
            }
        }
    }

    /// The asks a box lists now: those heard asked are its word's from now on.
    func reviewsListed(_ ids: Set<String>) {
        guard !heardUnlisted.isEmpty else { return }
        heardUnlisted = heardUnlisted.filter { !ids.contains($0.key) }
    }

    /// One its box's reviewer took up that its box lists as over (answered, or gone with its run
    /// or its engine): off the Dock's count and Notification Center, though its answer or its
    /// run's end wasn't heard here.
    func reviewOver(_ id: String) {
        guard asking[id] != nil || notifying.contains(id) else { return }
        settled(id)
    }

    /// An ask its box lists yours in a conversation not open here, told as its engine asks it now:
    /// one its engine no longer asks (answered, or gone with its run) is never told.
    private func tellLeftForYou(_ id: String, in session: String) async {
        // (Where it's known, its own engine or bridge; else its box's engine, never this Mac's.)
        let known = self.session(session) != nil || bridgeSessions.contains(session) || sessionMachines[session] != nil
        guard asking[id] == nil, let box = Sandboxes.shared.review(of: id)?.box,
              let engine = known ? self.api(forSession: session) : box == BoxClient.mac ? self.api : machineAPI(box) else { return }
        let read: [PermissionRequest]?
        do { read = try await engine.permissions(session: session) } catch let error as ServerError where error.status == 404 && known {
            // (Its session gone from where it is: it asks nothing. One not known here may be its
            // coding agents', which its engine doesn't have: told without its words, below.)
            read = []
        } catch {
            read = nil
        }
        guard asking[id] == nil, Sandboxes.shared.review(of: id)?.review.state == .yours else { return }
        guard let read else {
            // Its engine not read now: yours as its box says, told without its words (opened, the
            // conversation shows them).
            asking[id] = session
            notifyAsk(session, body: "Wants to work outside the project.", request: id, isPermission: true, answerable: false)
            return
        }
        if let request = read.first(where: { $0.id == id }) { tellYours(request) }
    }

    /// A question in a conversation on Autopilot counts and tells you only if its box says it waits
    /// on you: the box decides what goes ahead, and this judges nothing.
    private func notifyAsk(_ id: String, body: String, request: String, isPermission: Bool = false, answerable: Bool = true, always: String? = nil, question: Notifier.Question? = nil) {
        // A seat's requests are answered by its group chat.
        guard !seats.contains(id), !notifying.contains(request) else { return }
        notifying.insert(request)
        Task {
            defer {
                notifying.remove(request)
                settledWhileNotifying.remove(request)
            }
            // A subagent's session has no row or tab of its own; its request shows in the
            // session that started it.
            var session = session(id)
            let api = api(forSession: id)
            let unlisted = session == nil ? try? await api?.session(id) : nil
            var isEngineRun = unlisted.map(Self.isEngineRun) ?? false
            var parent = unlisted?.parentID
            for _ in 0..<5 where session == nil && !isEngineRun {
                guard let next = parent else { break }
                session = self.session(next)
                guard session == nil, let fetched = try? await api?.session(next) else { break }
                isEngineRun = Self.isEngineRun(fetched)
                parent = fetched.parentID
            }
            // The engine's run for a session with the coding agents, or a subagent of it: that
            // session asks you itself, and counts once on the Dock.
            if isEngineRun {
                asking[request] = nil
                return
            }
            if !isPermission, let conversation = session, AutopilotShown.isOn(conversation) {
                asking[request] = nil
                guard await waitsOnYou(request, in: conversation), !settledWhileNotifying.contains(request) else { return }
                asking[request] = id
            }
            // Answered (or gone) while its session was read: no notification for it.
            guard settledWhileNotifying.remove(request) == nil else { return }
            // Buttons only when the notification hides none of what they'd answer.
            let shown = Notifier.showsAll(body) && (question?.choices.allSatisfy { Notifier.showsAll($0.label) } ?? true)
            Notifier.shared.notify(session: session?.id ?? id, title: session.flatMap { botName?($0.id) } ?? session?.title ?? AppInfo.name,
                                   subtitle: session.flatMap { botName?($0.id) == nil ? projectName(of: $0) : nil }, body: body,
                                   permission: isPermission && answerable && shown ? (session: id, request: request) : nil, always: always,
                                   question: shown ? question : nil,
                                   push: .init(isPermission ? .permission : .question, request: (session: id, id: request),
                                               machine: sessionMachines[id] ?? session.flatMap { RemoteFolder.machine(of: $0.location.directory) }, answerable: answerable && shown))
        }
    }

    /// Whether its box says this question waits on you (PROTOCOL.md, "Autopilot"). One that can't say
    /// (unreachable, or from before this) has it tell you, as any question.
    private func waitsOnYou(_ form: String, in conversation: Session) async -> Bool {
        struct Said: Decodable { var waiting: Bool }
        guard let box = boxes?(Self.box(of: conversation.location.directory)) else { return true }
        let said = try? await box.value(Said.self, "POST", "kuvo/sessions/\(conversation.id)/autopilot/asked", body: ["form": form])
        return said?.waiting ?? true
    }

    /// Whether a notification shows all a permission covers: Allow there would allow what it
    /// leaves out, so then it has no buttons, and you answer in the conversation.
    private static func showsAll(_ request: PermissionRequest) -> Bool {
        request.resources.filter { $0 != "*" }.count <= 4
    }

    /// What a permission's Always saves, as its notification's button says it.
    private func alwaysWords(_ request: PermissionRequest) -> String {
        Notifier.masked(AlwaysWords.of(action: request.action, save: request.save, resources: request.resources, home: askHome(request.sessionID)).plain)
    }

    /// The home folder of the computer a session asks on: this Mac's (a machine's isn't known here).
    private func askHome(_ session: String) -> String? {
        sessionMachines[session] == nil && RemoteFolder.parse(self.session(session)?.location.directory ?? "") == nil ? NSHomeDirectory() : nil
    }

    /// "Wants to run a command: npm test".
    private static func describe(_ request: PermissionRequest, home: String?) -> String {
        let what = switch request.action {
        case "edit", "write", "patch": "edit files"
        case "shell", "bash": "run a command"
        case "read": "read a file"
        case "external_directory": "work outside the project"
        case "webfetch": "open a web page"
        default: request.action
        }
        // Every one it covers (a command line's commands each): Allow takes them all. Folders
        // outside the project as people know them ("~/notes", not "/Users/me/notes/*").
        let shown = request.resources.filter { $0 != "*" }.map {
            request.action == "external_directory" ? OutsideFolders.shown($0, home: home) : $0
        }
        guard !shown.isEmpty else { return "Wants to \(what)." }
        let more = shown.count > 4 ? " · and \(shown.count - 4) more" : ""
        return "Wants to \(what): " + shown.prefix(4).joined(separator: " · ") + more
    }

    /// A permission request answered from its notification.
    func answer(_ request: String, in session: String, with answer: Notifier.PermissionAnswer) {
        Analytics.shared.track("permission_answered", ["decision": answer.rawValue, "from": "notification"])
        guard let decision = PermissionRequest.Decision(rawValue: answer.rawValue) else { return }
        Task {
            guard let api = api(forSession: session) else { return answerDidntGo(in: session) }
            do {
                try await api.reply(session: session, permission: request, decision: decision)
            } catch {
                await answerFailed(request, in: session, api: api) { try await $0.permissions(session: session).contains { $0.id == request } }
            }
        }
    }

    func markViewed(_ id: String) {
        clearNews(of: id)
        // Itself, and what its sub-sessions found, once they're done (ClientSessions' rule, the
        // phone's too). Worked on as copies: most looks read nothing, and change nothing.
        var listed = sessions, subs = subSessions
        let read = ReadState.read(id, sessions: &listed, subSessions: &subs) { parents[$0] }
        guard !read.isEmpty else { return }
        sessions = listed
        subSessions = subs
        for (id, idle) in read {
            // A machine's: its copy here keeps the read for the next launch, before it connects.
            if let machine = sessionMachines[id] ?? session(id).flatMap({ RemoteFolder.machine(of: $0.location.directory) }) { keepList(of: machine) }
            // Its engine away (a machine out of reach): told once it's back (see `refresh`).
            guard let api = api(forSession: id) else {
                unsentViews[id] = idle
                continue
            }
            Task { try? await api.markViewed(id, idle: idle) }
        }
    }

    /// `listed` as a box read them, with how far each was read here when that's further: a read
    /// still on its way to the box (or that didn't reach it) isn't taken back.
    private func keepingReads(_ listed: [Session]) -> [Session] {
        let read = Dictionary(sessions.compactMap { session in session.time.viewed.map { (session.id, $0) } }) { max($0, $1) }
        return listed.map { session in
            guard let here = read[session.id], here > (session.time.viewed ?? 0) else { return session }
            var session = session
            session.time.viewed = here
            return session
        }
    }

    /// Mark All as Read on each of `boxes` ("mac", or a machine's id): its box reads everything new
    /// there (`POST kuvo/sessions/read`, KuvoLink's PROTOCOL.md "What's been read"), once a box, and
    /// each read comes back as `session.viewed`, as one made elsewhere does. What asks you stays.
    func markAllRead(on boxes: [String]) async {
        let clients = boxes.compactMap { self.boxes?($0) }
        await withTaskGroup(of: Void.self) { group in
            for client in clients { group.addTask { _ = try? await client.send("POST", "kuvo/sessions/read") } }
        }
    }

    /// Read elsewhere, as its box says: the same as `markViewed`, without telling the box again.
    private func sawViewed(_ id: String, idle: Milliseconds) {
        readElsewhere[id] = max(idle, readElsewhere[id] ?? 0)
        var listed = sessions, subs = subSessions
        guard ReadState.sawRead(id, upTo: idle, sessions: &listed, subSessions: &subs, parent: { parents[$0] }) else { return }
        sessions = listed
        subSessions = subs
        if session(id)?.isUnread == false { clearNews(of: id) }
    }

    /// Read: its notification goes, and its next news is read afresh.
    private func clearNews(of id: String) {
        Notifier.shared.clear(session: id)
        if replyPreviews[id] != nil { replyPreviews[id] = nil }
    }

    /// How far each session was read on another client, for news that was on its way meanwhile.
    @ObservationIgnored private var readElsewhere: [String: Milliseconds] = [:]

    /// Sessions read while their machine was away, with what was read, to tell it when it's back;
    /// kept over a quit, so a read made while it was away isn't lost (nor shown unread again).
    /// (A machine's, kept: this Mac's engine is told as soon as it's up, in the same run.)
    @ObservationIgnored private var unsentViews: [String: Milliseconds] = Workspace.savedUnsentViews() {
        didSet {
            let machines = unsentViews.filter { sessionMachines[$0.key] != nil || keptUnsentViews.contains($0.key) }
            UserDefaults.standard.set(try? JSONEncoder().encode(machines), forKey: Self.unsentViewsKey)
        }
    }

    /// Those kept from before this launch: still a machine's before its sessions are listed.
    @ObservationIgnored private let keptUnsentViews = Set(Workspace.savedUnsentViews().keys)

    private static let unsentViewsKey = "machineUnsentViews"

    private static func savedUnsentViews() -> [String: Milliseconds] {
        guard let data = UserDefaults.standard.data(forKey: unsentViewsKey) else { return [:] }
        return (try? JSONDecoder().decode([String: Milliseconds].self, from: data)) ?? [:]
    }

    /// Sessions being read again as the engine said they changed (what a test waits for).
    @ObservationIgnored private(set) var reloading: [String: Task<Void, Never>] = [:]

    /// `from`: the box an event about it came from (`BoxClient.mac`'s, nil, or a machine's), when
    /// that's where to read it: its row here is another box's, one that box says it moved away
    /// from (listed before it moved), so it's read where it lives now, and its row and an open
    /// conversation go there.
    private func reload(_ id: String, depth: Int = 0, from box: String?? = nil) async {
        if case let .some(machine) = box, let row = session(id), RemoteFolder.machine(of: row.location.directory) != machine,
           isAway(id, from: RemoteFolder.machine(of: row.location.directory)) {
            let there = bridgeSessions.contains(id) ? (machine.map { machineAgents($0)?.api } ?? agents?.api) : (machine.map(machineAPI) ?? api)
            guard let there, let session = try? await there.session(id) else { return }
            guard RemoteFolder.machine(of: session.location.directory) == machine, !isAway(id, from: machine) else { return }
            moved([session], api: there)
            return
        }
        guard let session = try? await api(forSession: id)?.session(id) else { return }
        // Only root sessions get a row; subagent sessions show inside their parent, and under it.
        if let parent = session.parentID {
            // Each written only when it changes (a subagent at work is read again on each update):
            // the sidebar reads them, and a write that changes nothing works it out again.
            if parents[session.id] != parent {
                parents[session.id] = parent
                // (What it asked before it was known whose it is may be a conversation's on Autopilot.)
                autopilotMayHaveChanged?()
            }
            if !isHidden(session) { keepSubSession(session, of: parent) }
            // A subagent's subagent: whose that one is, up to the session with a row.
            if self.session(parent) == nil, parents[parent] == nil, depth < 8 { await reload(parent, depth: depth + 1) }
            return
        }
        upsert(session)
    }

    /// Each subagent's session, by the session that started it.
    private var parents: [String: String] = [:]

    /// The sessions each session's agent started (its subagents'), newest first, by the session
    /// that started them, as each box listed them with its sessions and since: what shows under
    /// its row.
    private(set) var subSessions: [String: [Session]] = [:]
    /// Which box's list each session's sub-sessions came from: a list read again replaces its own.
    @ObservationIgnored private var subSessionBoxes: [String: String] = [:]

    /// A box's sub-sessions, from its list read with them (`allSessions(roots: false)`), in place
    /// of what was known of that box's: by the session that started each, with where to reach
    /// each (its machine, the coding agents' bridge).
    private func keepSubSessions(_ all: [Session], box: String, machine: String? = nil) {
        let children = all.filter { $0.parentID != nil && !isHidden($0) }
        for child in children {
            if parents[child.id] != child.parentID { parents[child.id] = child.parentID }
            if let machine { sessionMachines[child.id] = machine }
            if OutsideAgents.isAgentSession(child) { bridgeSessions.insert(child.id) }
        }
        let grouped = Dictionary(grouping: children) { $0.parentID ?? "" }.mapValues { $0.sorted { $0.time.created > $1.time.created } }
        var kept = subSessions.filter { subSessionBoxes[$0.key] != box }
        kept.merge(grouped) { _, listed in listed }
        // Only a change redraws the rows.
        if kept != subSessions { subSessions = kept }
        subSessionBoxes = subSessionBoxes.filter { $0.value != box }
        for parent in grouped.keys { subSessionBoxes[parent] = box }
    }

    /// The box a session's list comes from: its machine's, or this Mac's engine or bridge.
    private func subSessionBox(of session: Session) -> String {
        (RemoteFolder.machine(of: session.location.directory) ?? "mac") + (OutsideAgents.isAgentSession(session) ? "-agents" : "")
    }

    /// The session whose agent started `id`, once known (or remembered from when you opened it):
    /// a sub-session opens with the way back to it.
    func parent(of id: String) -> String? { parents[id] ?? openedSubSessions[id] }

    /// Whose each sub-session you opened is, kept for its tab as Kuvo Code opens again, before
    /// its list is read (a machine's, or the coding agents' bridge's, come later).
    @ObservationIgnored private var openedSubSessions: [String: String] = UserDefaults.standard.dictionary(forKey: "openedSubSessions") as? [String: String] ?? [:]

    /// Remembers whose sub-session `id` is, for its tab.
    func rememberOpened(_ id: String) {
        guard let parent = parents[id], openedSubSessions[id] != parent else { return }
        openedSubSessions[id] = parent
        // The latest ones are enough: tabs come and go.
        if openedSubSessions.count > 200 { openedSubSessions = Dictionary(uniqueKeysWithValues: openedSubSessions.shuffled().prefix(150).map { ($0.key, $0.value) }) }
        UserDefaults.standard.set(openedSubSessions, forKey: "openedSubSessions")
        if reviewParts.contains(where: { openedSubSessions[$0] == nil }) { reviewParts = reviewParts.filter { openedSubSessions[$0] != nil } }
        UserDefaults.standard.set(Array(reviewParts), forKey: "openedReviewParts")
    }

    /// A review's part, opened from its card: it opens as a sub-session of `parent` (the
    /// conversation reviewed), whose list leaves it out as it does the box's other runs.
    func rememberReviewPart(_ id: String, of parent: String) {
        parents[id] = parent
        reviewParts.insert(id)
        rememberOpened(id)
        UserDefaults.standard.set(Array(reviewParts), forKey: "openedReviewParts")
    }

    /// A review's part, opened: once its review is put away, it's gone, not a subagent missing
    /// (kept, as its tab is, as Kuvo Code opens again).
    func isReviewPart(_ id: String) -> Bool { reviewParts.contains(id) }
    @ObservationIgnored private var reviewParts = Set(UserDefaults.standard.stringArray(forKey: "openedReviewParts") ?? [])

    /// Learns whose sub-session `id` is, when it has no row and that isn't known yet.
    func findParent(of id: String) async {
        guard session(id) == nil, parents[id] == nil else { return }
        await reload(id)
    }

    /// A sub-session as last read.
    func subSession(_ id: String) -> Session? {
        subSessions.values.lazy.flatMap { $0 }.first { $0.id == id }
    }

    private func keepSubSession(_ session: Session, of parent: String) {
        var list = subSessions[parent] ?? []
        list.removeAll { $0.id == session.id }
        list.append(session)
        list.sort { $0.time.created > $1.time.created }
        if list != subSessions[parent] { subSessions[parent] = list }
        subSessionBoxes[parent] = subSessionBox(of: session)
    }

    /// A sub-session finished since you were last in it, or in the session at the top of its
    /// chain, which shows what it found (one from before sub-sessions were marked read has
    /// that only).
    func isNew(_ sub: Session) -> Bool {
        ReadState.isNew(sub, rootViewed: session(root(of: sub.id))?.time.viewed)
    }

    /// One of its sub-sessions, or theirs, is new.
    func hasNewSubSessions(_ id: String) -> Bool {
        ReadState.hasNew(under: id, in: subSessions) { session(root(of: $0.id))?.time.viewed }
    }

    /// Sessions found at work without a row (a subagent, maybe one sent off in the background,
    /// whose start came while the app wasn't there to hear it): whose they are, so its asks and
    /// its place under the session they work for are known.
    private func findParents(of active: Set<String>) {
        for id in active where session(id) == nil && parents[id] == nil {
            Task { await reload(id) }
        }
    }

    /// What still runs for each session besides its own turn, by box, as each box says (never
    /// worked out here: every client shows the same).
    private(set) var background: [String: [String: SessionBackground]] = [:]

    private func leftRunning(by id: String) -> SessionBackground? {
        for list in background.values {
            if let work = list[id] { return work }
        }
        return nil
    }

    /// Subagents a session handed work to that are at it now (through subagents of subagents),
    /// such as those it sent off in the background, which go on after its own turn ends.
    func helpersAtWork(in id: String) -> Int {
        leftRunning(by: id)?.subagents ?? 0
    }

    /// The session works, itself, or its box says something it left running still does (a subagent,
    /// a command in the background): what its row, tab and bot show (`AtWork`, as the phone works it out).
    func isWorking(_ id: String) -> Bool {
        AtWork.isWorking(running: running.contains(id), background: leftRunning(by: id))
    }

    /// Working, or waiting on you: what a bot's sessions count as at work, in its row and its bar.
    func isAtWork(_ id: String) -> Bool {
        isWorking(id) || needsAttention(id)
    }

    // MARK: Commands running for agents

    /// The shell commands the engine runs for each session's agent, while they run: one left
    /// running in the background after its turn ended shows over its composer. (Whether the session
    /// counts as working is the box's to say: `background`.)
    private(set) var shellJobs: [String: [ShellJob]] = [:]
    /// The commands that have run a moment, which the bar over the composer may show: the step
    /// that waits on a command claims it only once it has started, so for its first moment each
    /// one looks like it runs in the background, and most end within it. Shown at once, every
    /// command flashed the bar.
    private(set) var lastingShellJobs: Set<String> = []
    private static let lastingAfter: Milliseconds = 2000

    private func noteShellJob(_ event: ServerEvent) {
        switch event.type {
        case "shell.created":
            struct Created: Decodable { var info: ShellJob }
            guard let job = try? event.payload(as: Created.self).info, job.status == "running", let id = job.sessionID,
                  shellJobs[id]?.contains(where: { $0.id == job.id }) != true else { return }
            shellJobs[id, default: []].append(job)
            // From now: the engine's clock (a machine's) needn't be this Mac's.
            noteLasting(job.id, after: Self.lastingAfter)
        case "shell.exited", "shell.deleted":
            struct Gone: Decodable { var id: String }
            guard let gone = try? event.payload(as: Gone.self).id else { return }
            for (id, jobs) in shellJobs where jobs.contains(where: { $0.id == gone }) {
                let left = jobs.filter { $0.id != gone }
                shellJobs[id] = left.isEmpty ? nil : left
            }
            lastingShellJobs.remove(gone)
        default:
            break
        }
    }

    /// `id` counts as lasting `after` from now, if it's still running then.
    private func noteLasting(_ id: String, after: Milliseconds) {
        guard !lastingShellJobs.contains(id) else { return }
        guard after > 0 else {
            lastingShellJobs.insert(id)
            return
        }
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(after)))
            guard let self, shellJobs.values.contains(where: { $0.contains { $0.id == id } }) else { return }
            lastingShellJobs.insert(id)
        }
    }

    /// What runs in `directory` now, as its engine lists it: commands started while this Mac
    /// wasn't listening (before launch, or while a machine was away) show too.
    func readShellJobs(in directory: String) async {
        guard let api = api(forFolder: directory), let engineJobs = try? await api.shells(directory: directory) else { return }
        // The coding agents' too (commands Claude Code left running), for their sessions; when their
        // list can't be read, those sessions keep what they showed.
        var agentJobs: [ShellJob]? = []
        if let bridge = agents(forFolder: directory)?.api { agentJobs = try? await bridge.shells(directory: directory) }
        let jobs = engineJobs + (agentJobs ?? [])
        for session in sessions where session.location.directory == directory {
            if agentJobs == nil, OutsideAgents.isAgentSession(session) { continue }
            let own = jobs.filter { $0.sessionID == session.id && $0.status == "running" }
            if (shellJobs[session.id] ?? []) != own { shellJobs[session.id] = own.isEmpty ? nil : own }
            // Ones started a while ago show at once.
            let now = Date.now.timeIntervalSince1970 * 1000
            for job in own {
                let age = job.time?.started.map { now - $0 } ?? 0
                noteLasting(job.id, after: min(Self.lastingAfter, max(0, Self.lastingAfter - age)))
            }
        }
        // And none that ended while this Mac wasn't listening.
        let running = Set(shellJobs.values.joined().map(\.id))
        if !lastingShellJobs.isSubset(of: running) { lastingShellJobs.formIntersection(running) }
    }

    /// Stops a command an agent left running, on the box its session's folder is on
    /// (`kuvo/shell/<id>/stop`), as a phone asks it: its process group is sent SIGTERM there, so the
    /// engine sees it end and tells the agent, with what it printed. The engine's own stop deletes
    /// the output too, and the agent hears the command was never found, so the box does that only
    /// when it can't send the signal.
    /// How it went: "signal" or "removed"; why not, in words to show (`BoxRefusal`): none such runs
    /// there any more, or its box couldn't be asked or said no.
    @discardableResult
    func stopShellJob(_ job: ShellJob, in session: String) async throws -> String {
        let directory = self.session(session)?.location.directory ?? ""
        struct Stopped: Decodable { var stopped: String }
        // As JavaScript's `encodeURIComponent` writes them, as the engine reads its folder.
        let plain = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        let id = job.id.addingPercentEncoding(withAllowedCharacters: plain) ?? job.id
        // The engine looks for it in the session's folder, as its box names it.
        let folder = Self.onBox(directory).addingPercentEncoding(withAllowedCharacters: plain) ?? directory
        let command = job.command.count > 60 ? job.command.prefix(59) + "…" : job.command
        let machine = RemoteFolder.machine(of: directory)
        let notAnswered = "Kuvo Code’s background service on this Mac didn’t answer. Try again in a moment."
        guard let client = boxes?(Self.box(of: directory)) else { throw BoxRefusal(status: 503, message: "Couldn’t stop “\(command)”. \(notAnswered)") }
        let status: Int, data: Data
        do {
            (status, data) = try await client.send("POST", "kuvo/shell/\(id)/stop", body: try? JSONSerialization.data(withJSONObject: ["session": session]),
                                                   headers: directory.isEmpty ? [:] : ["x-opencode-directory": folder])
        } catch {
            throw BoxRefusal(status: 503, message: "Couldn’t stop “\(command)”. \(machine == nil ? notAnswered : error.localizedDescription)")
        }
        guard (200..<300).contains(status) else {
            let refused = BoxRefusal(status: status, data: data)
            // None such runs there (`404 {}`): it ended meanwhile.
            let said = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw BoxRefusal(status: status, message: status == 404 && said == nil ? "“\(command)” isn’t running any more." : "Couldn’t stop “\(command)”. \(refused.message)")
        }
        return (try? JSONDecoder().decode(Stopped.self, from: data))?.stopped ?? "signal"
    }

    /// Hears a conversation go on Autopilot, from any client: what it has waiting on you here stops waiting.
    @ObservationIgnored var autopilotMayHaveChanged: (() -> Void)?

    /// Whether the conversation `id` is part of (a subagent's, the one that started it) is on Autopilot.
    func isOnAutopilot(_ id: String) -> Bool {
        session(root(of: id)).map(AutopilotShown.isOn) == true
    }

    /// The session a subagent's shows in (through subagents of subagents): the root one that
    /// started it; any other, itself.
    func root(of id: String) -> String {
        var id = id
        for _ in 0..<5 {
            guard let parent = parents[id] else { break }
            id = parent
        }
        return id
    }

    /// A session made elsewhere (a bot's), so it can be opened right away.
    func add(_ session: Session) {
        upsert(session)
    }

    /// Conversations that moved, or are moving, to another computer (`Moves`), with the computers
    /// whose copy isn't the one they live in (`BoxClient.mac`, or a machine's id), as each box says:
    /// the one they left (while they move, and for two days after: its `moved`), or the one a copy is
    /// being made on. What's listed and heard from there leaves them out, and a row of one from there
    /// that's still here (listed before it moved) goes (`leaveOutMovedAway`). A session can be away
    /// from two boxes at once (the one it left, and the one whose copy isn't switched to yet, as
    /// boxes read at different times say), so each box's word is kept, never one over the other.
    @ObservationIgnored var movedAway: [String: Set<String>] = [:] {
        didSet { if movedAway != oldValue { leaveOutMovedAway() } }
    }

    /// Of those, the copies a move is bringing to a box, not switched to yet (by session, the boxes,
    /// as `movedAway`): never listed from there, whatever it listed before.
    @ObservationIgnored var comingCopies: [String: Set<String>] = [:]

    /// Whether `id` doesn't live on `machine`'s box (nil: this Mac's), as the boxes say.
    func isAway(_ id: String, from machine: String?) -> Bool {
        movedAway[id]?.contains(machine ?? BoxClient.mac) == true
    }

    /// Whether `box`'s list (nil: this Mac's) leaves `id` out as it's read: it doesn't live there,
    /// unless that box's row of it is the only one here (a conversation moving away from it, listed
    /// nowhere else yet: its row stays, its tab with it). A copy coming there, never listed here, or
    /// one with a row from another computer (where it lives, or the one it's leaving while both say
    /// it's away: one row, never two) is left out; `leaveOutMovedAway` decides which row goes once
    /// one computer has it.
    private func leavesOut(_ id: String, from box: String?) -> Bool {
        guard isAway(id, from: box) else { return false }
        // A copy on its way there, not switched to: never that box's row.
        if comingCopies[id]?.contains(box ?? BoxClient.mac) == true { return true }
        let rows = sessions.filter { $0.id == id }.map { RemoteFolder.machine(of: $0.location.directory) }
        return !(rows.contains(box) && rows.allSatisfy { $0 == box })
    }

    /// `box`'s rows (nil: this Mac's) that its list, read now, doesn't have (`listed`), of
    /// conversations moving or moved away from it and listed nowhere else yet: kept as they are,
    /// with an open one's model, until they're listed where they went (`leaveOutMovedAway` then).
    private func keptWhileMoving(on box: String?, listed: Set<String>, _ include: (Session) -> Bool) -> [Session] {
        sessions.filter { row in
            RemoteFolder.machine(of: row.location.directory) == box && include(row) && !listed.contains(row.id)
                && (isAway(row.id, from: box) || Moves.isFrozen(row.id)) && !leavesOut(row.id, from: box)
        }
    }

    /// Rows of conversations from a box they don't live on (the one they left, listed before they
    /// moved), once a row from where they live now is there too: gone, with what's kept of that
    /// box's list, and an open one goes on where it lives, so nothing sent from it goes to the box
    /// it left. Never its only row: until it's listed where it went (a move ends with both
    /// computers' lists read, `Moves.ended`), it stays as it was, its tab with it.
    private func leaveOutMovedAway() {
        guard !movedAway.isEmpty, !leavingOut else { return }
        let boxOf = { (session: Session) in RemoteFolder.machine(of: session.location.directory) }
        let moving = sessions.filter { movedAway[$0.id] != nil }
        guard !moving.isEmpty else { return }
        let lives = Set(moving.filter { !isAway($0.id, from: boxOf($0)) }.map(\.id))
        let isStale = { (session: Session) in lives.contains(session.id) && self.isAway(session.id, from: boxOf(session)) }
        let stale = moving.filter(isStale)
        guard !stale.isEmpty else { return }
        leavingOut = true
        defer { leavingOut = false }
        sessions.removeAll(where: isStale)
        for machine in Set(stale.compactMap { RemoteFolder.machine(of: $0.location.directory) }) { keepList(of: machine) }
        for session in stale {
            if remoteSessions[session.id]?.machine == RemoteFolder.machine(of: session.location.directory), remoteSessions.removeValue(forKey: session.id) != nil {
                Self.saveRemoteSessions(remoteSessions)
            }
            guard let model = models[session.id], boxOf(model.session) == boxOf(session), let there = self.session(session.id), let api = api(for: there) else { continue }
            moved([there], api: api)
        }
    }
    /// While `leaveOutMovedAway` changes the list (it's told of each change).
    @ObservationIgnored private var leavingOut = false

    /// Conversations carried on on another computer (`Moves`), under the same IDs, on `api`: their
    /// rows, and an open one's conversation, go there from now on, whatever's sent from it too.
    func moved(_ moved: [Session], api: OpenCodeAPI) {
        for session in moved {
            let machine = RemoteFolder.machine(of: session.location.directory)
            let before = sessionMachines[session.id] ?? remoteSessions[session.id]?.machine
            // A subagent's has no row of its own, as `reload` has it.
            if session.parentID == nil { upsert(session) }
            sessionMachines[session.id] = machine
            // Come to this Mac: it no longer waits for the machine it left.
            if machine == nil, remoteSessions.removeValue(forKey: session.id) != nil { Self.saveRemoteSessions(remoteSessions) }
            if let before, before != machine { keepList(of: before) }
            guard let model = models[session.id] else { continue }
            model.reconnect(api)
            model.session = session
            model.isReachable = reachable(session.location.directory)
            followGoals(of: model)
            Task { await model.load() }
        }
    }

    private func upsert(_ session: Session) {
        guard !isHidden(session) else {
            sessions.removeAll { $0.id == session.id }
            return
        }
        nameBranch(of: session)
        var session = session
        if let index = sessions.firstIndex(where: { $0.id == session.id }) {
            let earlier = sessions[index]
            // Read since this was asked for (here, or on the phone): that stands, as the box keeps
            // the later look.
            if let seen = sessions[index].time.viewed, seen > (session.time.viewed ?? 0) { session.time.viewed = seen }
            sessions[index] = session
            if AutopilotShown.isOn(session), !AutopilotShown.isOn(earlier) { autopilotMayHaveChanged?() }
            // Archived or brought back elsewhere (from a phone): its wake-ups wait, or come back,
            // as with Archive here. (Archive here notes it first, so it isn't told twice.)
            noteArchiving(session, was: earlier)
        } else {
            sessions.insert(session, at: 0)
            tellWorktree(session)
        }
        models[session.id]?.session = session
        if let machine = RemoteFolder.machine(of: session.location.directory) {
            keepList(of: machine)
            sessionMachines[session.id] = machine
            remoteSessions[session.id] = RemoteSession(machine: machine, title: session.title)
            Self.saveRemoteSessions(remoteSessions)
        }
    }

    private func touch(_ id: String) {
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { return }
        sessions[index].time.updated = Date().timeIntervalSince1970 * 1000
    }

    /// What an MCP server asks belongs to no session: each conversation of its folder on that
    /// engine sees it, and takes it if a tool of that server is running there. Asked, it's noted
    /// for the conversation waiting on it, open or not.
    private func handleShared(_ event: ServerEvent, machine: String?) {
        let folder = event.location.map { location in machine.map { RemoteFolder.folder(location.directory, on: $0) } ?? location.directory }
        for model in models.values where RemoteFolder.machine(of: model.session.location.directory) == machine
            && (folder == nil || model.session.location.directory == folder) {
            model.apply(event)
        }
        switch event.type {
        case "form.created":
            guard let form = try? event.payload(as: EventPayload.FormCreated.self).form, let server = form.server else { return }
            if let model = models.values.first(where: { $0.forms.contains { $0.id == form.id } }) {
                note(form, in: model)
                return
            }
            // A conversation that isn't open: the running one of that folder with that server's
            // tool going.
            Task {
                for id in running where sessionMachines[id] == machine {
                    guard let directory = session(id)?.location.directory ?? folder, folder == nil || directory == folder,
                          let api = api(forSession: id), let page = try? await api.messages(session: id, limit: 8),
                          Transcript.isWaiting(on: server, in: page.data) else { continue }
                    sharedForms[form.id] = directory
                    // (On Autopilot it counts once its box says it waits on you: `notifyAsk`.)
                    if !isOnAutopilot(id) { asking[form.id] = id }
                    notifyAsk(id, body: form.message ?? "Needs your answer.", request: form.id, question: nil)
                    return
                }
            }
        case "form.replied", "form.cancelled":
            guard let form = try? event.payload(as: EventPayload.FormSettled.self) else { return }
            sharedForms[form.id] = nil
            settled(form.id)
        default:
            break
        }
    }

    /// A form `model`'s conversation shows, as one it's asking.
    private func note(_ form: FormRequest, in model: SessionModel) {
        // Told once, not again with each read after a reconnect.
        let isNew = sharedForms[form.id] == nil
        let isShared = form.sessionID == FormRequest.anySession
        // (Shared, on Autopilot, it counts once its box says it waits on you: `notifyAsk`.)
        if !(isShared && isOnAutopilot(model.id)) { asking[form.id] = model.id }
        guard isShared else { return }
        sharedForms[form.id] = model.session.location.directory
        if isNew { notifyAsk(model.id, body: form.message ?? "Needs your answer.", request: form.id, question: nil) }
    }

    /// `form.created` carries its session inside the form.
    private static func formSessionID(_ event: ServerEvent) -> String? {
        guard event.type == "form.created" else { return nil }
        return try? event.payload(as: EventPayload.FormCreated.self).form.sessionID
    }
}
