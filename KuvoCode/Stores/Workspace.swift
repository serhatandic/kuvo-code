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
    /// The main window's tabs, where a fork, a move to the coding agents and an agent's new session
    /// open (the app sets it; none in a test of the workspace alone).
    @ObservationIgnored weak var tabs: WindowTabs?
    /// Sessions agents started that have been shown (see `noteBeside`).
    @ObservationIgnored private var askedBeside: Set<String> = []

    /// The agents bridge: sessions with Claude Code, Codex, Cursor, Grok and Antigravity go to it,
    /// whatever their folder (on this Mac).
    @ObservationIgnored var agents: OutsideAgents?

    /// A machine's coding agents (the agents bridge beside its engine), by the machine's name.
    @ObservationIgnored var machineAgents: (String) -> OutsideAgents? = { _ in nil }

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
        guard !connectedMachines.contains(machine), !sessions.contains(where: { RemoteFolder.machine(of: $0.location.directory) == machine }) else { return }
        let seen = SessionCopies.sessions(of: machine).filter { !isHidden($0) }
        for session in seen { sessionMachines[session.id] = machine }
        sessions += seen
    }

    /// A waiting session's title, as last seen.
    func remoteTitle(_ id: String) -> String? {
        remoteSessions[id]?.title ?? botName?(id)
    }

    /// The engine a folder's sessions run on: its machine's, or this Mac's.
    func api(forFolder folder: String) -> OpenCodeAPI? {
        if let machine = RemoteFolder.machine(of: folder) { return machineAPI(machine) }
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
        didSet { projectsChanged() }
    }
    /// The projects of worktrees removed since, by the folder their sessions ran in: an archived
    /// session there still belongs to its project, and comes back to it if you restore it.
    private var removedWorktrees: [String: String] = UserDefaults.standard.dictionary(forKey: "removedWorktrees") as? [String: String] ?? [:] {
        didSet { projectsChanged() }
    }
    private(set) var isLoaded = false

    private var models: [String: SessionModel] = [:]
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

    /// Sessions that finished while you were elsewhere, or wait for your answer: the
    /// number on the Dock icon. A subagent's ask is its session's.
    var waitingCount: Int {
        let askers = Set(asking.values.map(root(of:))).union(askingInBrowser.map(root(of:))).subtracting(seats)
        return Set(sessions.filter { $0.isUnread && !Self.isArchived($0) }.map(\.id)).union(askers).count
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
        /// A command that stands in for the chat: a new session in the project opens a terminal
        /// running it (an agent's own interface, like `omp` or `opencode`) instead of a conversation.
        var terminal: String?
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

    /// The project a folder sessions run in belongs to: its own, or a worktree's project.
    func projectDirectory(_ directory: String) -> String {
        worktrees[directory]?.project ?? removedWorktrees[directory] ?? directory
    }

    func projectDirectory(of session: Session) -> String {
        projectDirectory(session.location.directory)
    }

    /// The project's other folders, for a folder sessions run in.
    func extraFolders(_ directory: String) -> [String] {
        settings[projectDirectory(directory)]?.folders ?? []
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
        seats.contains(session.id) || Self.isSeat(session) || Self.isEngineRun(session)
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

    /// Where chats run: conversations of no project, on this Mac, in a folder of their own.
    static let chatsFolder: String = {
        let url = AppInfo.supportDirectory.appending(path: "Chats")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url.path
    }()

    /// This Mac's chats, and those moved to a machine, in Kuvo Code's folder there (`Moves`).
    static func isChat(_ directory: String) -> Bool {
        directory == chatsFolder || (RemoteFolder.parse(directory)?.path.hasSuffix("/\(RemoteEngineInstaller.root)/chats") ?? false)
    }

    /// A bot's own folder, on this Mac or a machine: what's there is the bot's, even before the
    /// bot is listed (while it's being made), so it never shows as a project.
    static func isBotFolder(_ directory: String) -> Bool {
        directory.hasPrefix(Bots.root.path + "/") || directory.contains("/\(RemoteEngineInstaller.root)/bots/")
    }

    /// Chats, newest first.
    var chats: [Session] {
        sessions.filter { Self.isChat($0.location.directory) && !Self.isArchived($0) && !botSessions.contains($0.id) }
            .sorted { $0.time.updated > $1.time.updated }
    }

    /// Moves a chat into the project at `directory`: its conversation goes along, and from then on
    /// it works in that project's folders. If it's working, the move comes at its next step.
    func move(_ id: String, toProject directory: String) async throws {
        guard let session = session(id) else { return }
        if OutsideAgents.isAgentSession(session) { throw OutsideAgents.Failure.unavailable("Moving a chat into a project") }
        // Moving to another computer: what changes it waits until it's there.
        if Moves.isFrozen(id) { throw Moves.Failure.moving }
        guard let api = api(forFolder: directory) else { return }
        try await api.moveSession(id, to: directory)
        let extra = settings[directory]?.folders ?? []
        try? await api.setPermissions(session: id, rules: ProjectFolders.permissions(session.permissions ?? [], folders: extra))
        if extra.isEmpty {
            try? await api.removeInstruction(session: id, key: ProjectFolders.instructionKey)
        } else {
            try? await api.setInstruction(session: id, key: ProjectFolders.instructionKey, text: ProjectFolders.instructions(primary: directory, folders: extra))
        }
        // Its open conversation stays as it is, now in its new place.
        await reload(id)
        Analytics.shared.track("chat_moved")
    }

    /// Projects with their sessions, most recently active first.
    var projects: [Project] {
        // What they're made of, read here so views showing them are updated as it changes.
        _ = (sessions.count, folders.count, settings.count, worktrees.count, removedWorktrees.count, botSessions.count, machines.count)
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

    private func makeProjects() -> [Project] {
        let grouped = Dictionary(grouping: sessions.filter { !Self.isArchived($0) && !botSessions.contains($0.id) && !Self.isChat($0.location.directory) && !Self.isBotFolder($0.location.directory) }, by: projectDirectory(of:))
        let directories = Set(grouped.keys).union(folders).filter { RemoteFolder.machine(of: $0).map(machines.contains) ?? true }
        return directories.map { directory in
            Project(directory: directory, sessions: (grouped[directory] ?? []).sorted { $0.time.updated > $1.time.updated }, settings: settings[directory] ?? ProjectSettings())
        }
        .sorted { lhs, rhs in
            let left = lhs.sessions.first?.time.updated ?? 0
            let right = rhs.sessions.first?.time.updated ?? 0
            return left != right ? left > right : lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }

    /// Put away: out of Projects and Recents, still found by searching. Archived here (a
    /// note in the session's metadata), or by an older opencode.
    static func isArchived(_ session: Session) -> Bool {
        session.time.archived != nil || session.metadata?[archivedKey]?.bool == true
    }

    private static let archivedKey = "kuvo.archived"

    /// Kept at the top of the sidebar, a note in the session's metadata.
    static func isPinned(_ session: Session) -> Bool {
        session.metadata?[pinnedKey]?.bool == true
    }

    private static let pinnedKey = "kuvo.pinned"

    /// Archives a session, or brings it back.
    /// Whether the engine took it.
    @discardableResult
    func setArchived(_ id: String, _ archived: Bool) async -> Bool {
        // Not archived if the engine didn't take it: its wake-ups aren't held for it.
        guard await setFlag(Self.archivedKey, archived, of: id) else { return false }
        onArchived?(id, archived)
        return true
    }

    /// A session was archived, or brought back. The app sets it.
    @ObservationIgnored var onArchived: ((_ session: String, _ isArchived: Bool) -> Void)?

    /// The sessions read again: one archived or brought back meanwhile (from a phone, while the
    /// feed was down) is told, as `upsert` tells one.
    private func noteArchiving(since before: [Session]) {
        guard onArchived != nil else { return }
        let was = Dictionary(before.map { ($0.id, Self.isArchived($0)) }, uniquingKeysWith: { first, _ in first })
        for session in sessions {
            if let wasArchived = was[session.id] { noteArchiving(session, was: wasArchived) }
        }
    }

    /// `session` as it is now, archived or brought back since it was `wasArchived`: told.
    private func noteArchiving(_ session: Session, was wasArchived: Bool) {
        let archived = Self.isArchived(session)
        if archived != wasArchived { onArchived?(session.id, archived) }
    }

    /// Pins a session to the top of the sidebar, or takes it off.
    func setPinned(_ id: String, _ pinned: Bool) async {
        if pinned { Analytics.shared.track("session_pinned") }
        await setFlag(Self.pinnedKey, pinned, of: id)
    }

    /// Sets a flag in a session's metadata, shown at once; put back as it was if the engine
    /// doesn't take it (it would come back so with the next read). Whether it did.
    @discardableResult
    private func setFlag(_ key: String, _ value: Bool, of id: String) async -> Bool {
        guard !Moves.isFrozen(id) else { return false }
        guard let index = sessions.firstIndex(where: { $0.id == id }), let api = api(for: sessions[index]) else { return false }
        let before = sessions[index].metadata
        var metadata = before?.object ?? [:]
        // Written either way: the engine may merge metadata rather than replace it.
        metadata[key] = .bool(value)
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

    /// Each session's conversation as text, for searching it, until the session changes.
    @ObservationIgnored private var conversationTexts: [String: (updated: Double, text: String)] = [:]

    /// Sessions whose conversation has `query` (archived ones too), the latest first, with the
    /// words around its first mention. Reads the conversations it hasn't yet, a few at a time.
    func searchConversations(_ query: String, limit: Int = 20) async -> [(session: Session, snippet: String)] {
        let candidates = sessions.sorted { $0.time.updated > $1.time.updated }
        // Each with its engine; a machine that isn't connected is skipped until it is.
        let missing = candidates.filter { conversationTexts[$0.id]?.updated != $0.time.updated }
            .compactMap { session in api(for: session).map { (session, $0) } }
        await withTaskGroup(of: (Session, [Message])?.self) { group in
            var queue = missing.makeIterator()
            func next() {
                guard let (session, api) = queue.next() else { return }
                group.addTask { (try? await ConversationExport.messages(of: session, api: api)).map { (session, $0) } }
            }
            for _ in 0..<4 { next() }
            for await result in group {
                if let (session, messages) = result {
                    // What was said, without the export's labels: "You" or "Agent" would find every one.
                    let text = ConversationExport.markdown(title: session.title ?? "New Session", messages: messages, directory: session.location.directory, labels: false)
                    conversationTexts[session.id] = (session.time.updated, text)
                }
                if Task.isCancelled { group.cancelAll() } else { next() }
            }
        }
        var found: [(session: Session, snippet: String)] = []
        for session in candidates where found.count < limit {
            guard let text = conversationTexts[session.id]?.text,
                  let range = text.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) else { continue }
            found.append((session, Self.snippet(around: range, in: text)))
        }
        return found
    }

    /// A line's worth of text from just before `range`, without Markdown's marks, so the match
    /// shows in a narrow sidebar.
    private static func snippet(around range: Range<String.Index>, in text: String) -> String {
        let start = text.index(range.lowerBound, offsetBy: -16, limitedBy: text.startIndex) ?? text.startIndex
        let end = text.index(range.upperBound, offsetBy: 80, limitedBy: text.endIndex) ?? text.endIndex
        let words = text[start..<end].filter { !"*`#>".contains($0) }.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return (start > text.startIndex ? "…" : "") + words + (end < text.endIndex ? "…" : "")
    }

    /// A session's conversation as Markdown, to share.
    func markdown(of id: String) async throws -> String? {
        guard let session = session(id), let api = api(for: session) else { return nil }
        let messages = try await ConversationExport.messages(of: session, api: api)
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
        models[id] = model
        // This Mac's conversation as last seen, in its first frame, while the engine's is read
        // (which takes a moment, longer while it starts): read in place, the same messages,
        // nothing moves. Reading a copy takes a few milliseconds.
        if !RemoteFolder.isRemote(directory), let copy = SessionCopies.load(id) { model.preview(copy.messages) }
        Task { await readShellJobs(in: directory) }
        return model
    }

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
        model.show(copy.messages)
        models[id] = model
        return model
    }

    func loadBranch(for directory: String) async {
        guard let api = api(forFolder: directory), let info = try? await api.vcs(directory: directory) else { return }
        branches[directory] = info.branch?.current
        defaultBranches[directory] = info.branch?.default
    }

    /// Waiting on you: a permission, a question or a sign-in, in a conversation you have open or
    /// not (a bot's work in a session of its own, say).
    func needsAttention(_ id: String) -> Bool {
        if askingInBrowser.contains(id) || asking.values.contains(where: { $0 == id || root(of: $0) == id }) { return true }
        guard let model = models[id] else { return false }
        return !model.permissions.isEmpty || !model.forms.isEmpty
    }

    // MARK: Changes

    /// Adds a project folder; the folder as it's kept (see `folderPath`).
    @discardableResult
    func addFolder(_ directory: String) -> String {
        let directory = folderPath(directory)
        // Chats aren't a project, nor is a bot's own folder.
        guard !folders.contains(directory), !Self.isChat(directory), !Self.isBotFolder(directory) else { return directory }
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
            throw BoxRefusal(status: 503, message: box == BoxClient.mac ? "This Mac’s box isn’t answering. Try again in a moment." : "\(box) isn’t answering. Try again in a moment.")
        }
        let (status, data) = try await client.send("DELETE", "kuvo/projects?directory=" + Self.queryValue(Self.onBox(directory)))
        switch status {
        case 200:
            // All of them, there: so here too, as the engine has them now, and it's off the list.
            for session in sessions { noteArchivedThere(session.id) }
            folders.removeAll { $0 == directory }
            UserDefaults.standard.set(folders, forKey: "projectFolders")
            await loadProjects(on: box)
            return 0
        case 409:
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
        onArchived?(id, true)
    }

    /// The project's name: its own, or its primary folder's. A worktree has its project's.
    func projectName(_ directory: String) -> String {
        if Self.isChat(directory) { return "Chats" }
        let directory = projectDirectory(directory)
        return settings[directory]?.name ?? (directory as NSString).lastPathComponent
    }

    /// Adds a project, or updates one, and gives its open sessions the new folders.
    @discardableResult
    func saveProject(_ directory: String, settings project: ProjectSettings) -> String {
        let directory = addFolder(directory)
        var project = project
        project.name = project.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        if project.name?.isEmpty == true || project.name == (directory as NSString).lastPathComponent { project.name = nil }
        project.folders = project.folders.filter { $0 != directory }
        project.run = project.run?.trimmingCharacters(in: .whitespacesAndNewlines)
        project.terminal = project.terminal?.trimmingCharacters(in: .whitespacesAndNewlines)
        if project.terminal?.isEmpty == true { project.terminal = nil }
        if project.run?.isEmpty == true { project.run = nil }
        settings[directory] = project == ProjectSettings() ? nil : project
        saveSettings()
        keepOnBox(directory)
        // Sessions not open yet catch up when they open.
        for model in models.values where projectDirectory(of: model.session) == directory {
            Task { await model.syncFolders() }
        }
        return directory
    }

    /// Settings › Permissions changed: open sessions' rules follow (the others' when they open).
    func syncPermissions() {
        for model in models.values {
            Task { await model.syncFolders() }
        }
    }

    /// A new session in the project at `directory`, or with `worktree`, in a new worktree of it.
    func createSession(in directory: String, model: ModelRef?, agent: String?, approval: ToolApproval = .approveAll, worktree: Bool = false) async throws -> Session {
        // A model of an outside agent (Claude Code, Codex…), or Auto: the session is the agents
        // bridge's, here.
        let isAgents = OutsideAgents.runsInBridge(model?.providerID)
        // (On a machine, its own bridge, beside its engine.)
        let bridge = agents(forFolder: directory)
        if isAgents, bridge?.api == nil { throw OutsideAgents.Failure.notRunning(bridge?.failure) }
        guard let api = isAgents ? bridge?.api : api(forFolder: directory) else { throw CancellationError() }
        let directory = addFolder(directory)
        let folder = worktree ? try await makeWorktree(of: directory) : directory
        let extra = settings[directory]?.folders ?? []
        let rules = ProjectFolders.permissions(approval.rules(settings: EngineConfig.rules(on: RemoteFolder.machine(of: directory))), folders: extra)
        let session: Session
        do {
            session = try await api.createSession(directory: folder, agent: agent, model: model, permissions: rules.isEmpty ? nil : rules)
        } catch {
            // A worktree made for it goes too, with its branch (nothing's on it yet).
            if worktree { await discardWorktree(folder) }
            throw error
        }
        if !extra.isEmpty {
            try? await api.setInstruction(session: session.id, key: ProjectFolders.instructionKey, text: ProjectFolders.instructions(primary: folder, folders: extra))
        }
        if let tree = worktrees[folder] {
            toldWorktree.insert(session.id)
            try? await api.setInstruction(session: session.id, key: Self.worktreeInstructionKey, text: Self.instructions(for: tree))
        }
        upsert(session)
        let used = model ?? session.model
        var props = Analytics.model(provider: used?.providerID, model: used?.id)
        props["mode"] = Analytics.mode(agent)
        props["approval"] = approval == .approveAll ? "all" : "ask"
        props["worktree"] = worktree
        if let since = Analytics.shared.sinceInstall { props["since_install"] = since }
        Analytics.shared.track("session_created", props)
        return session
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

    /// A new worktree of the project's repository on a branch of its own, made by the box the
    /// project's on, which keeps it (PROTOCOL.md, "Worktrees"). Returns the folder for the
    /// session to run in.
    private func makeWorktree(of directory: String) async throws -> String {
        let box = Self.box(of: directory)
        let made: BoxWorktree = try await onBox(box, "POST", "kuvo/worktrees", ["project": Self.onBox(directory), "branchPrefix": GitPreferences.branchPrefix])
        let folder = Self.here(made.folder ?? made.root, on: box)
        worktrees[folder] = Worktree(project: directory, root: Self.here(made.root, on: box), branch: made.branch, base: made.base)
        saveWorktrees()
        return folder
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

    /// Removes a worktree's folder, and changes that aren't committed with it when
    /// `discardingChanges` (you were told they go); without, one that has some stays. Its branch
    /// stays with its commits, unless it's merged already. Never while an agent works in it.
    func removeWorktree(_ directory: String, discardingChanges: Bool = true) async throws {
        guard let tree = worktrees[directory] else { return }
        guard api(forFolder: directory) != nil else {
            // The machine removes it, with its engine.
            if let machine = RemoteFolder.machine(of: tree.root) {
                throw GitFailure(message: "\(machine) isn’t connected, so the worktree of \(tree.branch) can’t be removed now.")
            }
            return
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
        } catch let refusal as BoxRefusal where refusal.status == 404 {}
        for (folder, removed) in worktrees where removed.root == tree.root { removedWorktrees[folder] = removed.project }
        UserDefaults.standard.set(removedWorktrees, forKey: "removedWorktrees")
        worktrees = worktrees.filter { $0.value.root != tree.root }
        saveWorktrees()
        Analytics.shared.track("worktree_removed")
    }

    /// A box's worktrees as it keeps them: this Mac's as its box starts, a machine's as it
    /// connects, each as its Worktrees page opens (`sizes`: with the room each takes there, by
    /// root as this Mac names it), and as a session in one gets its title. This Mac shows them
    /// from then on. Ones this Mac kept for it before the box kept them are handed over, and ones
    /// it no longer has (removed from a phone, say) go here too. Nil when it couldn't be asked:
    /// what this Mac had stays.
    @discardableResult func takeWorktrees(from box: String, sizes: Bool = false) async -> [String: Int64]? {
        struct Listed: Decodable { var worktrees: [BoxWorktree] }
        guard let listed: Listed = try? await onBox(box, "GET", sizes ? "kuvo/worktrees" : "kuvo/worktrees?records=1", nil) else { return nil }
        var records = listed.worktrees
        let onIt = { (folder: String) in Self.box(of: folder) == box }
        for (folder, tree) in worktrees where onIt(tree.root) {
            let project = Self.onBox(tree.project), root = Self.onBox(tree.root), path = Self.onBox(folder)
            guard !records.contains(where: { $0.root == root }) else { continue }
            var record: [String: Any] = ["project": project, "root": root, "folder": path, "branch": tree.branch]
            if let base = tree.base { record["base"] = base }
            do {
                let _: Empty = try await onBox(box, "POST", "kuvo/worktrees/record", record)
                records.append(BoxWorktree(project: project, root: root, folder: path, branch: tree.branch, base: tree.base))
            } catch let refusal as BoxRefusal where refusal.status == 404 {
                // Not there any more: it goes here too.
            } catch let refusal as BoxRefusal where refusal.status < 500 {
                // Not one it takes (as kept here it doesn't make sense there): it stays here, as it was.
                continue
            } catch {
                // Not asked: kept as it was, for next time.
                return nil
            }
        }
        // While this Mac follows its own, only what it's told changes them: an answer read before
        // a change since would undo it.
        if box != BoxClient.mac || !followingWorktrees { take(records, from: box) }
        return Dictionary(records.compactMap { record in record.size.map { (Self.here(record.root, on: box), $0) } }, uniquingKeysWith: { first, _ in first })
    }

    /// `records` as `box`'s worktrees, here, in place of what was known of them. One that's gone
    /// with sessions in it (removed from a phone) is noted as removed, so an archived one brought
    /// back is still its project's.
    private func take(_ records: [BoxWorktree], from box: String) {
        let roots = Set(records.map { Self.here($0.root, on: box) })
        let gone = worktrees.filter { Self.box(of: $0.value.root) == box && !roots.contains($0.value.root) }
        for (folder, tree) in gone where sessions.contains(where: { $0.location.directory == folder }) { removedWorktrees[folder] = tree.project }
        if !gone.isEmpty { UserDefaults.standard.set(removedWorktrees, forKey: "removedWorktrees") }
        var mine = worktrees.filter { Self.box(of: $0.value.root) != box }
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

    /// This Mac's worktrees as its box keeps them, from now on: one made, renamed or removed for a
    /// phone shows here as it happens.
    func followWorktrees() async {
        struct Listed: Decodable { var worktrees: [BoxWorktree] }
        while !Task.isCancelled {
            if let client = boxes?(BoxClient.mac), await takeWorktrees(from: BoxClient.mac) != nil {
                do {
                    for try await line in client.follow("kuvo/worktrees/events") {
                        guard let listed = try? JSONDecoder().decode(Listed.self, from: line) else { continue }
                        followingWorktrees = true
                        take(listed.worktrees, from: BoxClient.mac)
                    }
                } catch {}
                followingWorktrees = false
            }
            // The box restarted, or isn't up yet: followed again in a moment.
            try? await Task.sleep(for: .seconds(2))
        }
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

        init(project: String, root: String, folder: String?, branch: String, base: String?) {
            (self.project, self.root, self.folder, self.branch, self.base) = (project, root, folder, branch, base)
        }

        private enum CodingKeys: String, CodingKey { case project, root, path, folder, branch, base, size }

        init(from decoder: any Decoder) throws {
            let keys = try decoder.container(keyedBy: CodingKeys.self)
            project = try keys.decode(String.self, forKey: .project)
            root = try keys.decodeIfPresent(String.self, forKey: .root) ?? keys.decode(String.self, forKey: .path)
            folder = try keys.decodeIfPresent(String.self, forKey: .folder)
            branch = try keys.decode(String.self, forKey: .branch)
            base = try keys.decodeIfPresent(String.self, forKey: .base)
            size = try keys.decodeIfPresent(Int64.self, forKey: .size)
        }
    }

    private struct Empty: Decodable {}

    /// A request to `box`'s routes (`boxes`): its answer, or what it said when it said no
    /// (`BoxRefusal`).
    private func onBox<Answer: Decodable>(_ box: String, _ method: String, _ path: String, _ body: [String: Any]?) async throws -> Answer {
        guard let client = boxes?(box) else { throw BoxRefusal(status: 503, message: box == BoxClient.mac ? "This Mac’s box isn’t running." : "\(box) isn’t connected.") }
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
        var terminal: String?
        var removed: Bool?
    }

    private struct BoxProjects: Decodable { var projects: [BoxProject] }

    /// The box a folder's on: a machine's id, or this Mac's.
    static func box(of directory: String) -> String { RemoteFolder.machine(of: directory) ?? BoxClient.mac }
    /// A folder as its box names it, and as it's named here.
    private static func onBox(_ directory: String) -> String { RemoteFolder.parse(directory)?.path ?? directory }
    private static func here(_ path: String, on box: String) -> String { box == BoxClient.mac ? path : RemoteFolder.folder(path, on: box) }

    /// A query's value, written so a box reads it back exactly (a "+" is a space in a query).
    static func queryValue(_ text: String) -> String {
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
            guard let client = self.boxes?(box), await Self.projects(of: client) != nil else { return }
            if !Self.keepsProjects(box) {
                // Its projects, and those it removed (their settings), as they were kept here.
                let kept = Set(self.folders.filter { Self.box(of: $0) == box }).union(self.settings.keys.filter { Self.box(of: $0) == box })
                self.unsentProjects.formUnion(kept)
                UserDefaults.standard.set(true, forKey: "projectsOnBox." + box)
            }
            await self.send(on: box, through: client)
            guard let listed = await Self.projects(of: client) else { return }
            self.take(listed, from: box)
        }
    }

    /// This Mac's projects as its box has them, from now on: each change, wherever it was made
    /// (a phone's too), as it's made.
    func followProjects() async {
        while !Task.isCancelled {
            if let client = boxes?(BoxClient.mac) {
                await loadProjects(on: BoxClient.mac)
                do {
                    for try await line in client.follow("kuvo/projects/events") {
                        guard Self.keepsProjects(BoxClient.mac), let listed = try? JSONDecoder().decode(BoxProjects.self, from: line) else { continue }
                        await inTurn { self.take(listed.projects, from: BoxClient.mac) }
                    }
                } catch {}
            }
            // The box restarted, or isn't up yet: followed again in a moment.
            try? await Task.sleep(for: .seconds(2))
        }
    }

    private static func projects(of client: BoxClient) async -> [BoxProject]? {
        try? await client.value(BoxProjects.self, "GET", "kuvo/projects").projects
    }

    /// What's changed here for `box`, sent as it is here: taken off the list once the box has it,
    /// or refuses it for good; kept to send again when it's away.
    private func send(on box: String, through client: BoxClient) async {
        for folder in unsentProjects.filter({ Self.box(of: $0) == box }).sorted() {
            let body = Self.boxBody(settings[folder] ?? ProjectSettings(), removed: !folders.contains(folder))
            guard let (status, _) = try? await client.send("PUT", "kuvo/projects?directory=" + Self.queryValue(Self.onBox(folder)), body: body) else { continue }
            if (200..<300).contains(status) || status == 400 { unsentProjects.remove(folder) }
        }
    }

    /// `listed` as `box`'s, here, in place of what was known of them; what's changed here and not
    /// sent yet stays as it is here.
    private func take(_ listed: [BoxProject], from box: String) {
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
            let kept = ProjectSettings(name: project.name, folders: (project.folders ?? []).map { Self.here($0, on: box) }, run: project.run, terminal: project.terminal)
            if kept != ProjectSettings() { updated[Self.here(project.directory, on: box)] = kept }
        }
        if updated != settings {
            settings = updated
            saveSettings()
        }
    }

    /// What a box is given for a project's settings: all of them, so it ends up as it is here.
    private static func boxBody(_ project: ProjectSettings, removed: Bool) -> Data? {
        struct Body: Encodable { var name: String; var folders: [String]; var run: String; var terminal: String; var removed: Bool }
        let body = Body(name: project.name ?? "", folders: project.folders.map(onBox), run: project.run ?? "", terminal: project.terminal ?? "", removed: removed)
        return try? JSONEncoder().encode(body)
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

    /// Your machines' projects read again (back in the app: a phone may have changed them; a
    /// machine's aren't followed as this Mac's are).
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

    private static func loadSettings() -> [String: ProjectSettings] {
        guard let data = UserDefaults.standard.data(forKey: "projectSettings") else { return [:] }
        return (try? JSONDecoder().decode([String: ProjectSettings].self, from: data)) ?? [:]
    }

    private func saveSettings() {
        UserDefaults.standard.set(try? JSONEncoder().encode(settings), forKey: "projectSettings")
    }

    /// A new session with `id`'s conversation before `message`, opened in a tab with the
    /// message in its composer, ready to try another way.
    func fork(_ id: String, from message: Message.User) async throws {
        Analytics.shared.track("session_branched")
        guard let api = api(forSession: id) else { return }
        let session = try await api.forkSession(id, before: message.id)
        upsert(session)
        let (text, comments, paths, _) = SentMessage.split(CommandMessages.shared.text(of: message))
        // The engine's copy carries the attachments; one seen arrive live has them as picked.
        let recent = (try? await api.messages(session: id, limit: 100).data) ?? []
        var stored = message
        for case .user(let user) in recent where user.id == message.id { stored = user }
        // What it replied to comes back over the composer, as you wrote it, and so do its comments.
        let (quotes, words) = Quoting.draft(of: text)
        let files = Attachments.restored(SessionModel.files(of: message, stored: stored), noting: paths)
        var draft = Drafts.Draft(text: words, files: files, quotes: quotes)
        draft.comments = comments
        Drafts.shared[session.id] = draft
        tabs?.open(.session(session.id))
    }

    /// An engine session you picked a coding agent's model (or Auto) in: it carries on with the
    /// agents, in a session of theirs with its conversation (their first agent is handed all of
    /// it), opened in its place; the engine's goes to Archived, its draft comes along. `opens`:
    /// with no tab of it, the new one opens (not when a phone moved it). Nil: it isn't there.
    @discardableResult
    func moveToAgents(_ id: String, model: ModelRef, opens: Bool = true) async throws -> Session? {
        // Moving to another computer: it goes to the coding agents once it's there.
        if Moves.isFrozen(id) { throw Moves.Failure.moving }
        guard let moved = try await carryToAgents(id, model: model) else { return nil }
        Analytics.shared.track("session_moved_to_agents", Analytics.model(provider: model.providerID, model: model.id))
        // Its tab (or its place beside one) takes the new one, before the old one goes.
        let swapped = tabs?.swap(from: id, to: moved.id) == true
        // One something else keeps (a bot's conversation): it takes the new session, in its place.
        let kept = await onMovedToAgents?(id, moved) == true
        // With no tab of it, it opens as any session does; a bot's that wasn't open stays so.
        if !swapped, !kept, opens { tabs?.open(.session(moved.id)) }
        if !kept { await setArchived(id, true) }
        return moved
    }

    /// Told when a conversation moved to the coding agents (from, to): true when something else
    /// keeps it (a bot), which then takes it over; the app sets it.
    @ObservationIgnored var onMovedToAgents: ((_ from: String, _ to: Session) async -> Bool)?

    /// Sessions known to be the agents bridge's before it has told of them (a bot's conversation,
    /// a seat in a group chat): asked there from the start.
    func runsOnAgents(_ ids: some Sequence<String>) {
        bridgeSessions.formUnion(ids)
    }

    /// An engine session's conversation carried on with the agents (see `moveToAgents`), in a
    /// new session of theirs, with what was waiting and its draft; nothing archived or opened.
    func carryToAgents(_ id: String, model: ModelRef) async throws -> Session? {
        guard let session = session(id), let engine = api(forSession: id) else { return nil }
        // (On a machine, its own bridge, beside its engine.)
        let place = agents(forFolder: session.location.directory)
        guard let bridge = place?.api else { throw OutsideAgents.Failure.notRunning(place?.failure) }
        // What waits stays waiting (it comes along), rather than starting as the run ends; if the
        // session can't move after all, it goes on as before.
        let wasPaused = models[id]?.isQueuePaused ?? true
        var moving = true
        defer { if moving, !wasPaused { models[id]?.resumeQueue() } }
        await models[id]?.holdQueue()
        // Not partway through a turn.
        if running.contains(id) {
            _ = try? await engine.interrupt(session: id)
            try? await engine.wait(session: id)
        }
        // Its whole conversation, page by page (a great many messages at most).
        var page = try await engine.messages(session: id, limit: 200)
        var messages = page.data
        while page.data.count >= 200, messages.count < 20_000, let cursor = page.cursor?.next ?? page.cursor?.previous {
            page = try await engine.messages(session: id, limit: 200, before: cursor)
            if page.data.isEmpty { break }
            messages = page.data + messages
        }
        // An undo waiting to be kept: the conversation as it is now, without what it took back
        // (its files are back already, and its message is in your composer).
        let current = (try? await engine.session(id)) ?? session
        if let revert = current.revert, let cut = messages.firstIndex(where: { $0.id == revert.messageID }) {
            messages = Array(messages[..<cut])
        }
        // What you'd sent that was waiting comes along, still waiting (nothing starts there).
        let waiting = ((try? await engine.inbox(session: id)) ?? []).filter { $0.type == "user" && $0.text != nil }
        let carried = waiting.map { OpenCodeAPI.WaitingPrompt(id: Identifier.message(), text: $0.text ?? "", files: Self.promptFiles(in: $0.payload)) }
        let moved = try await bridge.importSession(directory: session.location.directory, title: session.title, agent: session.agent, model: model,
                                                   permissions: current.permissions, messages: messages, waiting: carried)
        moving = false
        for item in waiting { try? await engine.cancelInbox(session: id, item: item.id) }
        let extra = extraFolders(session.location.directory)
        if !extra.isEmpty {
            try? await bridge.setInstruction(session: moved.id, key: ProjectFolders.instructionKey, text: ProjectFolders.instructions(primary: session.location.directory, folders: extra))
        }
        if let tree = worktrees[session.location.directory] {
            try? await bridge.setInstruction(session: moved.id, key: Self.worktreeInstructionKey, text: Self.instructions(for: tree))
        }
        upsert(moved)
        Drafts.shared[moved.id] = Drafts.shared[id]
        await WakeUps.carry(from: session, to: moved)
        return moved
    }

    /// A waiting message's files as they were sent: on this Mac, or with it (`data:`).
    private static func promptFiles(in payload: JSONValue) -> [OpenCodeAPI.PromptFile] {
        (payload["files"]?.array ?? []).compactMap { file in
            let name = file["name"]?.string
            if let uri = file["source"]?["uri"]?.string ?? file["uri"]?.string { return .init(uri: uri, name: name) }
            guard let data = file["data"]?.string else { return nil }
            return .init(uri: "data:\(file["mime"]?.string ?? "application/octet-stream");base64,\(data)", name: name)
        }
    }

    /// A session was deleted: its panel goes with it. The app sets it.
    @ObservationIgnored var onDeleted: ((String) -> Void)?

    /// Deleted on its engine; one on a machine that's away waits for it (it would come back).
    func delete(_ id: String) async {
        guard !Moves.isFrozen(id), let api = api(forSession: id) else { return }
        onDeleted?(id)
        if let machine = session(id).flatMap({ RemoteFolder.machine(of: $0.location.directory) }) { keepList(of: machine) }
        sessions.removeAll { $0.id == id }
        models[id] = nil
        if running.contains(id) { running.remove(id) }
        shellJobs[id] = nil
        Notifier.shared.clear(session: id)
        Drafts.shared.remove(id)
        try? await api.deleteSession(id)
    }

    func rename(_ id: String, to title: String) async {
        guard !Moves.isFrozen(id), let index = sessions.firstIndex(where: { $0.id == id }), api(forSession: id) != nil else { return }
        sessions[index].title = title
        if let machine = RemoteFolder.machine(of: sessions[index].location.directory) { keepList(of: machine) }
        try? await api(forSession: id)?.renameSession(id, title: title)
    }

    // MARK: Sync

    func refresh() async {
        guard let api else { return }
        do {
            let all = try await api.allSessions()
            Self.dropLeftScratch(all, api: api)
            let local = all.filter { !isHidden($0) && movedAway[$0.id] != .some(nil) }
            // (This Mac's: a machine's agents' are its own, with its engine's.)
            let theAgents = sessions.filter { OutsideAgents.isAgentSession($0) && !RemoteFolder.isRemote($0.location.directory) }
            let before = sessions
            sessions = local + theAgents + sessions.filter { RemoteFolder.isRemote($0.location.directory) }
            noteArchiving(since: before)
            SessionCopies.saveLocalSessions(local + theAgents)
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
            let all = try await api.allSessions()
            Self.dropLeftScratch(all, api: api)
            let listed = all.filter { !isHidden($0) }
            let before = sessions
            sessions = sessions.filter { !isMacs($0) } + listed
            noteArchiving(since: before)
            // Read while the bridge was away: so here, and told it now.
            let listedIDs = Set(listed.map(\.id))
            for (id, idle) in unsentViews where listedIDs.contains(id) {
                unsentViews[id] = nil
                if let index = sessions.firstIndex(where: { $0.id == id }), (sessions[index].time.viewed ?? 0) < idle { sessions[index].time.viewed = idle }
                Task { try? await api.markViewed(id, idle: idle) }
            }
            for (id, model) in models where isMacs(model.session) {
                guard let session = listed.first(where: { $0.id == id }) else {
                    models[id] = nil
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
    private func tellMissedNews(in sessions: [Session], machine: String) {
        let reconnected = !connectedOnce.insert(machine).inserted
        for session in sessions where botName?(session.id) != nil {
            guard let idle = session.time.idle else { continue }
            let told = toldIdle[session.id]
            toldIdle[session.id] = max(idle, told ?? 0)
            guard reconnected, session.isUnread, idle > (told ?? 0) else { continue }
            Task {
                let reply = await lastReply(of: session.id)
                if let reply { replyPreviews[session.id] = reply }
                Notifier.shared.notify(session: session.id, title: botName?(session.id) ?? session.title ?? "New Session",
                                       body: session.outcome == .failed ? "Stopped with an error." : reply ?? "Finished.", replies: true)
            }
        }
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
            let listed = try await api.allSessions().filter { movedAway[$0.id] != .some(machine) }
            // Its coding agents' too, from the agents bridge beside its engine; not read (it's
            // starting), those known stay as they were.
            let bridge = engine.agents.api
            let bridgeListed: [Session]? = if let bridge { try? await bridge.allSessions() } else { [] }
            guard isCurrent() else { return true }
            // Its open conversations take this connection first, so nothing sent from them goes
            // to the old one.
            for model in models.values where RemoteFolder.machine(of: model.session.location.directory) == machine {
                if !OutsideAgents.isAgentSession(model.session) { model.reconnect(api) } else if let bridge { model.reconnect(bridge) }
            }
            let fromBridge = (bridgeListed ?? []).filter { !isHidden($0) }
            bridgeSessions.formUnion(fromBridge.map(\.id))
            let keptBridge = bridgeListed != nil ? [] : sessions.filter { RemoteFolder.machine(of: $0.location.directory) == machine && OutsideAgents.isAgentSession($0) }
            let theirs = listed.filter { !isHidden($0) } + fromBridge + keptBridge
            let reconnected = connectedOnce.contains(machine)
            tellMissedNews(in: theirs, machine: machine)
            let before = sessions
            sessions = sessions.filter { RemoteFolder.machine(of: $0.location.directory) != machine } + theirs
            noteArchiving(since: before)
            for session in theirs { sessionMachines[session.id] = machine }
            remoteSessions = remoteSessions.filter { $0.value.machine != machine }
            for session in theirs { remoteSessions[session.id] = RemoteSession(machine: machine, title: session.title) }
            Self.saveRemoteSessions(remoteSessions)
            SessionCopies.saveSessions(theirs, of: machine)
            connectedMachines.insert(machine)
            // Its projects, as it keeps them.
            Task { await loadProjects(on: machine) }
            // Read while it was away: so here, and told there now.
            for (id, idle) in unsentViews where sessionMachines[id] == machine {
                unsentViews[id] = nil
                if let index = sessions.firstIndex(where: { $0.id == id }), (sessions[index].time.viewed ?? 0) < idle { sessions[index].time.viewed = idle }
                Task { try? await api.markViewed(id, idle: idle) }
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
                guard isCurrent() else { return true }
                // An agent's, through the bridge (not read now, as it was).
                let isAgents = OutsideAgents.isAgentSession(model.session)
                guard let place = isAgents ? (bridgeListed == nil ? nil : bridge) : api else { continue }
                if !model.isSubagent, !known.contains(id) {
                    guard let session = try? await place.session(id) else {
                        models[id] = nil
                        continue
                    }
                    model.session = session
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
                found[request.id] = request.sessionID
                if tell, asking[request.id] == nil { notifyAsk(request.sessionID, body: Self.describe(request), request: request.id, isPermission: true, answerable: Self.showsAll(request)) }
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
            listSaves[machine]?.cancel()
            listSaves[machine] = nil
            sessions.removeAll { gone.contains($0.id) }
            for id in gone {
                models[id] = nil
                Drafts.shared.remove(id)
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
        asking = [:]
        for directory in Set(models.values.map(\.session.location.directory)) { await readShellJobs(in: directory) }
        for model in models.values {
            // A machine's are read when it's connected (see `refresh(_ engine:)`).
            if RemoteFolder.machine(of: model.session.location.directory).map(connectedMachines.contains) ?? true { await model.load() }
            for request in model.permissions { asking[request.id] = request.sessionID }
            for form in model.forms { note(form, in: model) }
        }
        for (request, session) in before where asking[request] == nil {
            // The coding agents' are the bridge's, which an engine's reconnect doesn't touch.
            if self.session(session).map(OutsideAgents.isAgentSession) ?? false {
                asking[request] = session
                continue
            }
            // On a machine not connected now: read again when it is.
            guard sessionMachines[session].map(connectedMachines.contains) ?? true else { continue }
            // A closed session's: still asked (or not known), it stays; its notification goes otherwise.
            if sharedForms[request] == nil, let api = api(forSession: session) {
                guard let asked = await Self.stillAsked(in: session, api: api), !asked.contains(request) else {
                    asking[request] = session
                    continue
                }
            }
            Notifier.shared.clear(request: request)
        }
    }

    /// An agent on a machine started using its browser.
    @ObservationIgnored var onMachineBrowsing: ((_ machine: String, _ session: String) -> Void)?

    /// An agent showed you a file or folder (its show_in_panel tool), at a path on its machine
    /// (nil: this Mac): the window opens it in the panel.
    @ObservationIgnored var onShowInPanel: ((_ session: String, _ machine: String?, _ path: String, _ isFolder: Bool) -> Void)?
    /// An agent on `machine` wrote to one elsewhere (see `AgentMail`): its message waits there.
    @ObservationIgnored var onAgentMessage: ((_ machine: String) -> Void)?
    /// send_message's calls under way on machines, by ID.
    @ObservationIgnored private var mailCalls: Set<String> = []
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
            if machine != nil, let started = try? event.payload(as: EventPayload.ToolInputStarted.self), started.name == "kuvo-browser_send_message" {
                mailCalls.insert(started.id)
            }
        case "session.tool.called":
            if let called = try? event.payload(as: EventPayload.ToolCalled.self), panelCalls[called.id] != nil {
                panelCalls[called.id] = called.input["path"]?.string ?? ""
            }
        case "session.tool.success":
            if let machine, let done = try? event.payload(as: EventPayload.ToolSucceeded.self), mailCalls.remove(done.id) != nil {
                onAgentMessage?(machine)
            }
            guard let done = try? event.payload(as: EventPayload.ToolSucceeded.self), let path = panelCalls.removeValue(forKey: done.id), !path.isEmpty else { return }
            let said = done.content.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined()
            guard let isFolder = BrowserTools.shownFolder(in: said) else { return }
            onShowInPanel?(session, machine, path, isFolder)
        case "session.tool.failed":
            if let failed = try? event.payload(as: EventPayload.ToolFailed.self) {
                panelCalls[failed.id] = nil
                mailCalls.remove(failed.id)
            }
        default:
            break
        }
    }
    /// A bot's name, by its session, for its notifications.
    @ObservationIgnored var botName: ((String) -> String?)?
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
        if let id = event.sessionID, let away = movedAway[id], away == machine { return }
        if let machine, let id = event.sessionID { sessionMachines[id] = machine }
        noteShowInPanel(event, machine: machine)
        if event.type == "session.tool.input.started", let id = event.sessionID,
           let started = try? event.payload(as: EventPayload.ToolInputStarted.self), started.name.hasPrefix("kuvo-browser_browser_") {
            if let machine {
                onMachineBrowsing?(machine, id)
                Analytics.shared.trackOnce("browser_used", key: "agent.machine", ["by": "agent", "place": "machine"])
            }
            if ["kuvo-browser_browser_sign_in", "kuvo-browser_browser_ask_code", "kuvo-browser_browser_ask_user"].contains(started.name) {
                onBrowserAsk?(id, machine)
            }
        }
        if event.type == "vcs.branch.updated", let directory = event.location?.directory {
            struct Branch: Decodable { var branch: String? }
            let folder = machine.map { RemoteFolder.folder(directory, on: $0) } ?? directory
            branches[folder] = (try? event.payload(as: Branch.self))?.branch
        }
        noteShellJob(event)
        if let id = event.sessionID ?? Self.formSessionID(event), let model = models[id] {
            model.apply(event)
        }
        // A subagent's asks: shown in the conversation it works for (found first, for one at work
        // before the app knew of it, its asks and answers kept in order meanwhile).
        if Self.asksEvents.contains(event.type), let id = event.sessionID ?? Self.formSessionID(event), session(id) == nil, parents[id] == nil, models[id] == nil, id != FormRequest.anySession {
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
        } else if Self.asksEvents.contains(event.type), let id = event.sessionID ?? Self.formSessionID(event), case let parent = root(of: id), parent != id, let model = models[parent] {
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
                await reload(id)
                reloading[id] = nil
            }
        case "session.deleted":
            // Its original, left where it was as it moved to another computer (`Moves`): the
            // conversation lives on there, as it is.
            if let found = session(id), RemoteFolder.machine(of: found.location.directory) != machine { break }
            // Deleted elsewhere (another Mac, the phone): its panel's tabs go too, a terminal's
            // connection with them.
            onDeleted?(id)
            Drafts.shared.remove(id)
            sessions.removeAll { $0.id == id }
            if let machine { keepList(of: machine) }
            if remoteSessions.removeValue(forKey: id) != nil { Self.saveRemoteSessions(remoteSessions) }
            SessionCopies.remove(id)
            models[id] = nil
            asking = asking.filter { $0.value != id }
            // Deleted while it worked: it isn't working any more (nor keeping the Mac awake).
            if running.contains(id) { running.remove(id) }
            shellJobs[id] = nil
            Notifier.shared.clear(session: id)
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
                    let reply = failed || !(Notifier.isEnabled || isBot) ? nil : await lastReply(of: id)
                    if isBot { replyPreviews[id] = reply }
                    // Told: a reconnection won't tell it again.
                    if let idle = self.session(id)?.time.idle { toldIdle[id] = max(idle, toldIdle[id] ?? 0) }
                    Notifier.shared.notify(
                        session: id,
                        title: botName?(id) ?? session.title ?? "New Session",
                        subtitle: botName?(id) == nil ? projectName(session.location.directory) : nil,
                        body: failed ? "Stopped with an error." : reply ?? "Finished.",
                        replies: true,
                        push: .init(failed ? .failed : isBot ? .report : .finished, machine: sessionMachines[id] ?? RemoteFolder.machine(of: session.location.directory))
                    )
                }
            }
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
            // What you wrote first, as it shows in the conversation: a command as you typed it,
            // without the note on attached files, and another agent's message without its header.
            let first = page.data.lazy.compactMap { message -> String? in
                guard case .user(let user) = message else { return nil }
                let text = SentMessage.words(of: CommandMessages.shared.text(of: user))
                let words = AgentMail.parse(text)?.text ?? text
                return words.isEmpty ? nil : words
            }.first
            guard let first else { return }
            let written = OutsideAgents.runsInBridge(session.model?.providerID) ? try? await self.api?.generate(Self.titlePrompt(for: first)) : nil
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

    /// A title from a message: its words without review comments, the note of attached files or
    /// line breaks, up to the end of its first sentence or about 48 characters, at a word. A dot in
    /// a word (README.md, a web address) doesn't end a sentence.
    nonisolated static func title(from message: String) -> String? {
        let split = SentMessage.split(message)
        let words = (split.text.isEmpty ? split.comments.first?.text ?? "" : split.text)
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
            guard let request = try? event.payload(as: PermissionRequest.self) else { return }
            asking[request.id] = request.sessionID
            notifyAsk(request.sessionID, body: Self.describe(request), request: request.id, isPermission: true, answerable: Self.showsAll(request))
        case "permission.replied":
            if let reply = try? event.payload(as: EventPayload.PermissionReplied.self) {
                asking[reply.requestID] = nil
                Notifier.shared.clear(request: reply.requestID)
            }
        case "form.created":
            guard let form = try? event.payload(as: EventPayload.FormCreated.self).form else { return }
            asking[form.id] = form.sessionID
            let question = Self.question(in: form)
            notifyAsk(form.sessionID, body: question?.text ?? (form.isQuestion ? "Has a question for you." : "Needs your answer."), request: form.id, question: question)
        case "form.replied", "form.cancelled":
            if let settled = try? event.payload(as: EventPayload.FormSettled.self) {
                asking[settled.id] = nil
                Notifier.shared.clear(request: settled.id)
            }
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
            do {
                guard let api = api(forSession: session) else { throw CancellationError() }
                try await api.reply(session: session, form: form, answer: [field: .string(answer)])
            } catch {
                // The agent still waits: say so, rather than lose the answer.
                Notifier.shared.notify(session: session, title: botName?(session) ?? self.session(session)?.title ?? AppInfo.name,
                                       body: "Your answer didn’t go. Open the conversation to answer there.")
            }
        }
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
    private func notifyAsk(_ id: String, body: String, request: String, isPermission: Bool = false, answerable: Bool = true, question: Notifier.Question? = nil) {
        // A seat's requests are answered by its group chat.
        guard !seats.contains(id) else { return }
        Task {
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
            // Buttons only when the notification hides none of what they'd answer.
            let shown = Notifier.showsAll(body) && (question?.choices.allSatisfy { Notifier.showsAll($0.label) } ?? true)
            Notifier.shared.notify(session: session?.id ?? id, title: session.flatMap { botName?($0.id) } ?? session?.title ?? AppInfo.name,
                                   subtitle: session.flatMap { botName?($0.id) == nil ? projectName($0.location.directory) : nil }, body: body,
                                   permission: isPermission && answerable && shown ? (session: id, request: request) : nil,
                                   question: shown ? question : nil,
                                   push: .init(isPermission ? .permission : .question, request: (session: id, id: request),
                                               machine: sessionMachines[id] ?? session.flatMap { RemoteFolder.machine(of: $0.location.directory) }, answerable: answerable && shown))
        }
    }

    /// Whether a notification shows all a permission covers: Allow there would allow what it
    /// leaves out, so then it has no buttons, and you answer in the conversation.
    private static func showsAll(_ request: PermissionRequest) -> Bool {
        request.resources.filter { $0 != "*" }.count <= 4
    }

    /// "Wants to run a command: npm test".
    private static func describe(_ request: PermissionRequest) -> String {
        let what = switch request.action {
        case "edit", "write", "patch": "edit files"
        case "shell", "bash": "run a command"
        case "read": "read a file"
        case "external_directory": "work outside the project"
        case "webfetch": "open a web page"
        default: request.action
        }
        // Every one it covers (a command line's commands each): Allow takes them all.
        let shown = request.resources.filter { $0 != "*" }
        guard !shown.isEmpty else { return "Wants to \(what)." }
        let more = shown.count > 4 ? " · and \(shown.count - 4) more" : ""
        return "Wants to \(what): " + shown.prefix(4).joined(separator: " · ") + more
    }

    /// A permission request answered from its notification.
    func answer(_ request: String, in session: String, with answer: Notifier.PermissionAnswer) {
        Analytics.shared.track("permission_answered", ["decision": answer.rawValue, "from": "notification"])
        guard let decision = PermissionRequest.Decision(rawValue: answer.rawValue) else { return }
        Task {
            do {
                guard let api = api(forSession: session) else { throw CancellationError() }
                try await api.reply(session: session, permission: request, decision: decision)
            } catch {
                // The agent still waits: say so, as for a question, rather than lose the answer.
                Notifier.shared.notify(session: session, title: botName?(session) ?? self.session(session)?.title ?? AppInfo.name,
                                       body: "Your answer didn’t go. Open the conversation to answer there.")
            }
        }
    }

    func markViewed(_ id: String) {
        Notifier.shared.clear(session: id)
        // Read: its next news is read afresh.
        if replyPreviews[id] != nil { replyPreviews[id] = nil }
        guard let index = sessions.firstIndex(where: { $0.id == id }), sessions[index].isUnread, let idle = sessions[index].time.idle else { return }
        sessions[index].time.viewed = idle
        // Its engine away (a machine out of reach): told once it's back (see `refresh`).
        guard let api = api(forSession: id) else { return unsentViews[id] = idle }
        Task { try? await api.markViewed(id, idle: idle) }
    }

    /// Sessions read while their machine was away, with what was read, to tell it when it's back.
    @ObservationIgnored private var unsentViews: [String: Milliseconds] = [:]

    /// Sessions being read again as the engine said they changed (what a test waits for).
    @ObservationIgnored private(set) var reloading: [String: Task<Void, Never>] = [:]

    private func reload(_ id: String, depth: Int = 0) async {
        guard let session = try? await api(forSession: id)?.session(id) else { return }
        // Only root sessions get a row; subagent sessions show inside their parent.
        if let parent = session.parentID {
            parents[session.id] = parent
            // A subagent's subagent: whose that one is, up to the session with a row.
            if self.session(parent) == nil, parents[parent] == nil, depth < 8 { await reload(parent, depth: depth + 1) }
            return
        }
        upsert(session)
    }

    /// Each subagent's session, by the session that started it.
    private var parents: [String: String] = [:]

    /// Sessions found at work without a row (a subagent, maybe one sent off in the background,
    /// whose start came while the app wasn't there to hear it): whose they are, so the session
    /// they work for shows working.
    private func findParents(of active: Set<String>) {
        for id in active where session(id) == nil && parents[id] == nil {
            Task { await reload(id) }
        }
    }

    /// Subagents a session handed work to that are at it now (through subagents of subagents),
    /// such as those it sent off in the background, which go on after its own turn ends.
    func helpersAtWork(in id: String) -> Int {
        running.count { $0 != id && root(of: $0) == id }
    }

    /// The session works, itself, through subagents still at it, or with a command it left
    /// running in the background: what its row, tab and bot show.
    func isWorking(_ id: String) -> Bool {
        running.contains(id) || helpersAtWork(in: id) > 0 || shellJobs[id] != nil
    }

    // MARK: Commands running for agents

    /// The shell commands the engine runs for each session's agent, while they run: one left
    /// running in the background after its turn ended keeps the session working, and shows over
    /// its composer.
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

    /// Stops a command an agent left running: its process group is sent SIGTERM, on this Mac or
    /// on its machine, so the engine sees it end and tells the agent, with what it printed. The
    /// engine's own stop also deletes the output, and the agent hears the command was never
    /// found, so it's only for when that can't be done.
    /// How it went: "signal" or "removed" (the engine's stop), for a phone that asked.
    @discardableResult
    func stopShellJob(_ job: ShellJob, in session: String) async -> String {
        let directory = self.session(session)?.location.directory ?? ""
        let engine = api(forSession: session)
        // Its process as the engine knows it now: one noted earlier (announced before it had one,
        // or from before a machine restarted, when it can be another process's) isn't signalled.
        let current = try? await engine?.shell(job.id, directory: directory)
        if let current, current.status == "running", let pid = current.pid, pid > 1 {
            let machine = RemoteFolder.machine(of: directory)
            let sent = await Task.detached { () -> Bool in
                guard let machine else { return kill(-pid_t(pid), SIGTERM) == 0 }
                return RemoteShell.run("kill -TERM -\(pid) 2>/dev/null && echo sent", on: machine).map { String(decoding: $0, as: UTF8.self).contains("sent") } ?? false
            }.value
            if sent { return "signal" }
        }
        try? await engine?.removeShell(job.id, directory: directory)
        return "removed"
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

    /// Conversations that moved, or are moving, to another computer (`Moves`), by the computer
    /// whose copy isn't the one they live in (nil: this Mac): the one they left, or the one a copy
    /// is being made on. What's listed and heard from there leaves them out.
    @ObservationIgnored var movedAway: [String: String?] = [:]

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
            Task { await model.load() }
        }
    }

    /// A session an agent started (its start_session tool) shows beside the conversation that
    /// started it or in a tab of its own, as its metadata says (`kuvo.startedBy`, `kuvo.beside`):
    /// once, the first time it's seen, while it's new, wherever it runs.
    private func noteBeside(_ session: Session) {
        guard let kuvo = session.metadata?["kuvo"], let starter = kuvo["startedBy"]?.string,
              Date.now.timeIntervalSince1970 * 1000 - session.time.created < 120_000,
              askedBeside.insert(session.id).inserted else { return }
        tabs?.agentStarted(session.id, by: starter, beside: kuvo["beside"]?.bool != false)
    }

    private func upsert(_ session: Session) {
        guard !isHidden(session) else {
            sessions.removeAll { $0.id == session.id }
            return
        }
        nameBranch(of: session)
        defer { noteBeside(session) }
        if let index = sessions.firstIndex(where: { $0.id == session.id }) {
            let wasArchived = Self.isArchived(sessions[index])
            sessions[index] = session
            // Archived or brought back elsewhere (from a phone): its wake-ups wait, or come back,
            // as with Archive here. (Archive here notes it first, so it isn't told twice.)
            noteArchiving(session, was: wasArchived)
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
                    asking[form.id] = id
                    notifyAsk(id, body: form.message ?? "Needs your answer.", request: form.id, question: nil)
                    return
                }
            }
        case "form.replied", "form.cancelled":
            guard let settled = try? event.payload(as: EventPayload.FormSettled.self) else { return }
            asking[settled.id] = nil
            sharedForms[settled.id] = nil
            Notifier.shared.clear(request: settled.id)
        default:
            break
        }
    }

    /// A form `model`'s conversation shows, as one it's asking.
    private func note(_ form: FormRequest, in model: SessionModel) {
        // Told once, not again with each read after a reconnect.
        let isNew = sharedForms[form.id] == nil
        asking[form.id] = model.id
        guard form.sessionID == FormRequest.anySession else { return }
        sharedForms[form.id] = model.session.location.directory
        if isNew { notifyAsk(model.id, body: form.message ?? "Needs your answer.", request: form.id, question: nil) }
    }

    /// `form.created` carries its session inside the form.
    private static func formSessionID(_ event: ServerEvent) -> String? {
        guard event.type == "form.created" else { return nil }
        return try? event.payload(as: EventPayload.FormCreated.self).form.sessionID
    }
}
