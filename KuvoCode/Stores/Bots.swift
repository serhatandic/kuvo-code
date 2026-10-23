import AppKit
import CryptoKit
import OpenCodeKit
import os

/// A bot: a teammate with a name, a look and one job. It keeps one conversation (an engine
/// session) on this Mac or on one of your machines, remembers what it learns in a file of its own,
/// and can schedule its own wake-ups to carry on later. You give it its job by writing to it: it
/// keeps the job in its memory, under "## Job", and that's where its job is read from.
struct Bot: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    /// What it does, in a few words, under its name ("Keeps CI green"): the first line of the
    /// job in its memory, as last read.
    var job: String
    /// Its job in full, as its memory has it (what to watch, what to make, what never to do), as
    /// last read: it goes in the conversation's instructions.
    var instructions: String
    /// Set once its job is kept in its memory. A bot made before had its job written in Edit Bot,
    /// in the two fields above, which are then moved into its memory.
    var jobInMemory: Bool?
    var look: BotLook
    /// The machine it lives on; nil for this Mac.
    var machine: String?
    /// The project folder it works in, the app's way of writing it; nil for a folder of its own.
    var project: String?
    /// Its own folder, as the engine where it lives knows it: its memory, wake-ups and workspace.
    var folder: String
    /// Its conversation.
    var sessionID: String
    var created: Date
    /// The model it uses unless you pick another in its conversation: in group chats, and for
    /// its conversation when it's made. Nil for one made before bots had one.
    var model: ModelRef?
    /// How it talks (a `Personality`'s ID); nil for the model's own way.
    var personality: String?
    /// Its conversation runs with the coding agents (on this Mac): a model of theirs, or Auto, and
    /// the engine's models through them. Nil for the engine's.
    var agents: Bool?
    /// When its name, look, job, personality or model last changed; nil for none since it was
    /// made, or since an older version changed it.
    var updated: Date?

    /// Where its session runs, the app's way of writing it.
    var directory: String {
        project ?? app((folder as NSString).appendingPathComponent("workspace"))
    }

    var memoryFile: String { (folder as NSString).appendingPathComponent("MEMORY.md") }

    /// A path in its folder, the app's way: on its machine, or here.
    func app(_ path: String) -> String {
        machine.map { RemoteFolder.folder(path, on: $0) } ?? path
    }

    /// What a bot is, kept beside its memory as `bot.json` wherever it lives, so what runs there
    /// knows it without this Mac (a machine's link answers your phone with it while this Mac is
    /// closed): its name, look, job and model. This Mac's list (`bots.json`) stays what the app
    /// goes by; this is written from it when one of these changes, and as its machine connects.
    struct Descriptor: Codable, Equatable {
        /// Goes up only when what's here changes in a way an older reader can't follow.
        static let version = 1
        static let file = "bot.json"

        var kuvo = Descriptor.version
        var id: String
        var name: String
        /// What it does, in a few words, as last read from its memory.
        var job: String
        var look: BotLook
        var personality: String?
        var model: ModelRef?
        /// The project folder it works in, as the computer it lives on writes it; nil for a
        /// folder of its own.
        var project: String?
        var created: Date
        var updated: Date
    }

    var descriptor: Descriptor {
        Descriptor(id: id, name: name, job: job, look: look, personality: personality, model: model,
                   project: project.map { RemoteFolder.parse($0)?.path ?? $0 }, created: created, updated: updated ?? created)
    }
}

/// Your bots, kept in `bots.json`. Their wake-ups are `WakeUps`', as sessions' are.
@Observable
final class Bots {
    private(set) var list: [Bot] = []
    /// Each bot's waiting wake-ups, as last read, by its ID.
    var wakes: [String: [Wakes.Pending]] { app?.wakeUps.wakes ?? [:] }
    /// Each bot's watches, as last read.
    var watches: [String: [Wakes.Watch]] { app?.wakeUps.watches ?? [:] }
    /// Bots whose wake-ups you paused: they wait until you resume them.
    var paused: Set<String> { app?.wakeUps.paused ?? [] }
    @ObservationIgnored weak var app: AppModel?
    /// Bots whose session has this version's instructions.
    @ObservationIgnored private var synced: Set<String> = []
    /// Machines given this copy's kuvo-wake since launch.
    @ObservationIgnored private var wakeInstalled: Set<String> = []
    /// What changed for each bot that hasn't reached its session yet ("instructions", "name",
    /// "model"), as its machine was away: done once it's back (`syncInstructions`), across launches.
    private var waitingEdits: [String: [String]] {
        get { UserDefaults.standard.dictionary(forKey: "botEditsWaiting") as? [String: [String]] ?? [:] }
        set { UserDefaults.standard.set(newValue.isEmpty ? nil : newValue, forKey: "botEditsWaiting") }
    }
    private let log = Logger(subsystem: "run.kuvo.code", category: "bots")

    /// The key under which a bot's job goes to its session.
    static let instructionKey = "kuvo.bot"
    private static var file: URL { AppInfo.supportDirectory.appending(path: "bots.json") }
    /// This Mac's bots' folders.
    static var root: URL { AppInfo.supportDirectory.appending(path: "bots") }
    /// The wake-up command on this Mac.
    static var command: URL { WakeUps.command }
    /// The wake-up command on a machine.
    static var machineCommand: String { WakeUps.machineCommand }

    init() {
        list = Self.load()
    }

    func bot(_ id: String?) -> Bot? {
        id.flatMap { id in list.first { $0.id == id } }
    }

    func bot(forSession id: String?) -> Bot? {
        id.flatMap { id in list.first { $0.sessionID == id } }
    }

    var sessionIDs: Set<String> { Set(list.map(\.sessionID)) }
    /// Those that run with the coding agents.
    var agentSessionIDs: Set<String> { Set(list.filter { $0.agents == true }.map(\.sessionID)) }

    /// What a bot's conversation runs on: the coding agents' bridge where it lives (this Mac's, or
    /// its machine's), or its folder's engine.
    func api(for bot: Bot) -> OpenCodeAPI? {
        bot.agents == true ? app?.workspace.agents(forFolder: bot.directory)?.api : app?.workspace.api(forFolder: bot.directory)
    }

    /// Tells the workspace which sessions are bots' (and which of those run with the agents).
    private func noteSessions() {
        app?.workspace.runsOnAgents(agentSessionIDs)
        app?.workspace.botSessions = sessionIDs
    }

    /// The bot a session acts for: its own conversation, or its seat in a group chat.
    func bot(actingAs id: String?) -> Bot? {
        guard let id else { return nil }
        if let bot = bot(forSession: id) { return bot }
        return bot(app?.chats.group(seat: id)?.seats.first { $0.value == id }?.key)
    }

    /// What the bot is up to, for how its avatar moves: waiting for you comes first, then working,
    /// then news you haven't seen, then asleep until a wake-up.
    func mood(of bot: Bot, in workspace: Workspace) -> BotMood {
        #if DEBUG
        // KUVO_DEMO_BOT_MOODS=<name>=<mood>,…: bots shown in a mood, for screenshots and videos.
        if let moods = ProcessInfo.processInfo.environment["KUVO_DEMO_BOT_MOODS"] {
            for pair in moods.split(separator: ",") {
                let parts = pair.split(separator: "=").map(String.init)
                if parts.count == 2, parts[0] == bot.name {
                    switch parts[1] {
                    case "working": return .working
                    case "waiting": return .waiting
                    case "news": return .news
                    case "sleeping": return .sleeping
                    case "watching": return .watching
                    default: return .idle
                    }
                }
            }
        }
        #endif
        if workspace.needsAttention(bot.sessionID) { return .waiting }
        if workspace.isWorking(bot.sessionID) { return .working }
        if workspace.session(bot.sessionID)?.isUnread == true { return .news }
        if wakes[bot.id]?.isEmpty == false { return .sleeping }
        if watches[bot.id]?.isEmpty == false { return .watching }
        return .idle
    }

    // MARK: Making, changing, deleting

    enum Failure: LocalizedError {
        case notConnected(String)
        case noFolder
        case stillOn(String)
        var errorDescription: String? {
            switch self {
            case .notConnected(let machine): "\(machine) isn’t connected. Connect to it, then try again."
            case .stillOn(let machine): "\(machine) isn’t connected, and the bot would keep running there. Connect to it, then delete the bot."
            case .noFolder: "Couldn’t make the bot’s folder."
            }
        }
    }

    /// Makes a bot: its folder where it lives, its session there, and its place in the list. Its
    /// job comes from the conversation; `job` writes one in its memory from the start (for the
    /// demo copy).
    func create(name: String, job: (line: String, details: String)? = nil, look: BotLook, personality: String? = nil, model: ModelRef?, machine: String?, project: String?) async throws -> Bot {
        let name = Self.oneLine(name)
        let memory = job.map { Self.addingJob($0.line, details: $0.details, to: Self.blankMemory(name)) } ?? Self.blankMemory(name)
        guard let app else { throw CancellationError() }
        let id = "bot_" + String((0..<10).map { _ in "abcdefghijklmnopqrstuvwxyz0123456789".randomElement()! })
        // What's made before something fails is taken back: no folder or session half made.
        var session: (id: String, api: OpenCodeAPI)?
        do {
            return try await create(id: id, name: name, memory: memory, look: look, personality: personality, model: model, machine: machine, project: project, app: app) { session = ($0, $1) }
        } catch {
            if let session {
                try? await session.api.deleteSession(session.id)
                app.workspace.botSessions.remove(session.id)
            }
            await discardFolder(of: id, on: machine)
            throw error
        }
    }

    private func create(id: String, name: String, memory: String, look: BotLook, personality: String?, model: ModelRef?, machine: String?, project: String?, app: AppModel, made: (String, OpenCodeAPI) -> Void) async throws -> Bot {
        let folder: String
        if let machine {
            guard let engine = app.machines.engine(machine), engine.isReady else { throw Failure.notConnected(machine) }
            try await Wakes.install(on: engine.machine.connection)
            let made = try await engine.machine.connection.run("""
                B="$HOME/\(RemoteEngineInstaller.root)/bots/\(id)"
                mkdir -p "$B/workspace" "$B/wakes" && cd "$B" || exit 1
                [ -f MEMORY.md ] || printf '%s' \(SSHConnection.quoted(memory)) >MEMORY.md
                pwd
                """).trimmingCharacters(in: .whitespacesAndNewlines)
            guard made.hasPrefix("/") else { throw Failure.noFolder }
            folder = made
        } else {
            let url = Self.root.appending(path: id)
            try FileManager.default.createDirectory(at: url.appending(path: "workspace"), withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: url.appending(path: "wakes"), withIntermediateDirectories: true)
            try WakeUps.installCommand()
            try Data(memory.utf8).write(to: url.appending(path: "MEMORY.md"))
            folder = url.path
        }

        let kept = Self.job(inMemory: memory)
        var bot = Bot(id: id, name: name, job: kept?.line ?? "", instructions: kept?.section ?? "", look: look, machine: machine, project: project, folder: folder, sessionID: "", created: .now)
        bot.jobInMemory = true
        bot.personality = personality
        let approval = UserDefaults.standard.string(forKey: ToolApproval.key).flatMap(ToolApproval.init) ?? .approveAll
        let rules = approval.rules(settings: EngineConfig.rules(on: machine)) + Self.ownRules(for: bot)
        let catalog = machine.flatMap { app.machines.engine($0)?.catalog } ?? app.catalog
        // The one picked, if you can use it where it lives (on this Mac, a coding agent's too);
        // otherwise the last one used, or that engine's default. Before its models are known (just
        // after launch), the one picked or last used, as it is.
        bot.model = catalog.startingModel(model, LastModel.current, scope: .on(machine: machine))
        // A coding agent's model (or Custom Auto): its conversation runs with the agents.
        if OutsideAgents.runsWithAgents(bot.model, machine: machine) { bot.agents = true }
        guard let api = api(for: bot) else {
            if bot.agents == true { throw OutsideAgents.Failure.notRunning(app.workspace.agents(forFolder: bot.directory)?.failure) }
            throw Failure.notConnected(machine ?? AppInfo.name)
        }
        let session = try await api.createSession(directory: bot.directory, title: name, model: bot.model, permissions: rules)
        made(session.id, api)
        // The bot's from the start: not a project's session for the moment it takes to set up.
        if bot.agents == true { app.workspace.runsOnAgents([session.id]) }
        app.workspace.botSessions.insert(session.id)
        bot.sessionID = session.id
        try? await api.setMetadata(session: session.id, .object(["kuvo": .object(["bot": .string(id)])]))
        try await sendInstructions(of: bot, api: api)
        try await writeSession(of: bot)

        list.append(bot)
        save()
        app.workspace.add(session)
        noteSessions()
        await describe([bot.id])
        Analytics.shared.track("bot_created", ["machine": machine != nil, "project": project != nil])
        return bot
    }

    /// A bot that couldn't be made: its folder, which holds only what making it wrote (on a
    /// machine, to Kuvo Code's trash there).
    private func discardFolder(of id: String, on machine: String?) async {
        if let machine {
            let script = """
                B="$HOME/\(RemoteEngineInstaller.root)/bots/\(id)"
                T="$HOME/\(RemoteEngineInstaller.root)/trash/$(date +%Y%m%d-%H%M%S)-$$"
                [ ! -e "$B" ] || { mkdir -p "$T" && mv -- "$B" "$T/"; }
                """
            _ = await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value
        } else {
            try? FileManager.default.removeItem(at: Self.root.appending(path: id))
        }
    }

    /// A new bot writes first: what it takes its job to be from its name, with what it needs to
    /// know to start, or, for a name that doesn't say, what you'd like it to do. Asked in a note
    /// the conversation doesn't show, so its first message is the bot's own.
    func greet(_ bot: Bot) async {
        guard let api = api(for: bot) else { return }
        try? await api.addSynthetic(session: bot.sessionID, text: Self.greeting, description: "A new bot's first message")
    }

    static let greeting = """
        <system-reminder>
        You were just made, and the person who made you hasn't written yet. Write them your first message, as yourself: short, warm, a few sentences at most.
        - If your name says what you're for (like "Social Media Manager" or "Inbox Helper"), say in a sentence what you take your job to be, then ask the one or two things you need to know to start, like which accounts or sites, how often, or in what tone.
        - If it doesn't, say hello and ask what they'd like you to do.
        Don't use any tools, and don't write your job into your memory until they've answered.
        </system-reminder>
        """

    /// Saves what Edit Bot changes (its name, look, model and personality), and tells its session
    /// about a new name, personality or model; its group chats hear about them too. The rest is
    /// kept as it is now: its job may have changed in its memory while Edit Bot was open.
    /// `time`: when it was changed (on its machine, for a change taken in from there).
    func update(_ edited: Bot, at time: Date = .now) async {
        // Moving to another computer: the edit comes once it's there (for ten minutes at most: a
        // move cut short whose other computer doesn't answer keeps it here, where it's saved).
        for _ in 0..<600 where Moves.isFrozen(edited.id) {
            do { try await Task.sleep(for: .seconds(1)) } catch { break }
        }
        guard let index = list.firstIndex(where: { $0.id == edited.id }) else { return }
        let old = list[index]
        var bot = old
        bot.name = edited.name
        bot.look = edited.look
        bot.model = edited.model
        bot.personality = edited.personality
        if bot != old { bot.updated = time }
        list[index] = bot
        save()
        var edits: Set<String> = []
        if old.name != bot.name || old.job != bot.job || old.instructions != bot.instructions || old.personality != bot.personality { edits.insert("instructions") }
        if old.name != bot.name { edits.insert("name") }
        // A new default model applies to its conversation too; you can still pick another there.
        if old.model != bot.model, bot.model != nil { edits.insert("model") }
        await tell(bot.id, edits)
        await describe([bot.id])
    }

    /// A bot's conversation carried on with the coding agents on `model` (a model of theirs, or
    /// Custom Auto), the way any session's is (`Workspace.moveToAgents`, which tells
    /// `movedToAgents`). Its default model stays as it was.
    @discardableResult
    func moveToAgents(_ bot: Bot, model: ModelRef) async throws -> Bot {
        guard let app, bot.agents != true, OutsideAgents.runsWithAgents(model, machine: bot.machine) else { return bot }
        try await app.workspace.moveToAgents(bot.sessionID, model: model)
        return self.bot(bot.id) ?? bot
    }

    /// A conversation that moved to the coding agents (`Workspace.moveToAgents`): a bot's takes the
    /// new session, set up as its own, and the engine's goes. True when it was a bot's.
    func movedToAgents(from old: String, to moved: Session) async -> Bool {
        guard let app, let index = list.firstIndex(where: { $0.sessionID == old }) else { return false }
        let kept = app.workspace.session(old)?.metadata?["kuvo"]
        list[index].sessionID = moved.id
        list[index].agents = true
        let bot = list[index]
        save()
        noteSessions()
        if let api = app.workspace.agents(forFolder: moved.location.directory)?.api {
            // What marked it as the bot's (and its group chats'), and its instructions.
            try? await api.setMetadata(session: moved.id, .object(["kuvo": kept ?? .object(["bot": .string(bot.id)])]))
            try? await sendInstructions(of: bot, api: api)
        }
        try? await writeSession(of: bot)
        await app.workspace.delete(old)
        return true
    }

    /// Whether `work` got to its engine: one it turned down counts, as asking again wouldn't change
    /// its answer; one that didn't get there (the connection dropped) is tried again.
    private static func reached(_ work: () async throws -> Void) async -> Bool {
        do {
            try await work()
            return true
        } catch {
            return error is ServerError
        }
    }

    /// Tells `id`'s session what changed (`edits`, with any still waiting): its instructions,
    /// its name as its conversation's title, its model; its group chats hear of them too. What
    /// doesn't get there (its machine is away) waits for the next time it can (`syncInstructions`).
    private func tell(_ id: String, _ edits: Set<String> = []) async {
        var waiting = waitingEdits
        let all = edits.union(waiting[id] ?? [])
        guard !all.isEmpty else { return }
        waiting[id] = Array(all)
        waitingEdits = waiting
        guard var bot = bot(id) else { return }
        // A coding agent's model for a bot on the engine: its conversation carries on with them first.
        if all.contains("model"), bot.agents != true, let model = bot.model, OutsideAgents.runsWithAgents(model, machine: bot.machine) {
            do {
                bot = try await moveToAgents(bot, model: model)
            } catch {
                log.error("A bot's conversation didn't move to the coding agents: \(error.localizedDescription, privacy: .public)")
                return
            }
        }
        guard let api = api(for: bot) else { return }
        var left = all
        if all.contains("instructions"), await Self.reached({ try await self.sendInstructions(of: bot, api: api) }) { left.remove("instructions") }
        if all.contains("name"), await Self.reached({ try await api.renameSession(bot.sessionID, title: bot.name) }) { left.remove("name") }
        if all.contains("model") {
            if let model = bot.model {
                if await Self.reached({ try await api.selectModel(session: bot.sessionID, model: model) }) { left.remove("model") }
            } else {
                left.remove("model")
            }
        }
        if !all.isDisjoint(with: ["instructions", "name"]) { await app?.groups.botChanged(bot) }
        if all.contains("model") { await app?.groups.modelChanged(of: bot) }
        // As the list is now: an edit made meanwhile stays on it.
        waiting = waitingEdits
        let still = Set(waiting[id] ?? []).subtracting(all).union(left)
        waiting[id] = still.isEmpty ? nil : Array(still)
        if self.bot(id) == nil { waiting[id] = nil }
        waitingEdits = waiting
    }

    /// Deletes a bot: its conversation and its wake-ups, and its folder goes to the Trash (on a
    /// machine, Kuvo Code's trash folder there), with what it made in it. A project it worked in
    /// stays. A machine's bot goes only once its folder there has, which stops its wake-ups and
    /// watches, so while the machine can't be reached it stays, and this says so. (One whose
    /// machine you removed from Kuvo Code leaves the list, and its folder goes the next time that
    /// machine answers, so adding it again doesn't bring the bot back.)
    func delete(_ bot: Bot) async throws {
        if Moves.isFrozen(bot.id) { throw Moves.Failure.moving }
        if let machine = bot.machine {
            let folder = SSHConnection.quoted(bot.folder)
            // Noted there too (`deletedFile`, as its bridge notes one deleted from a phone), so
            // another Mac lets the bot go as well. A bot's ID is letters and numbers only.
            let deleted = "$HOME/\(RemoteEngineInstaller.root)/bots/\(Self.deletedFile)"
            // Its keys of its own there go too (`BotKeys`), as its bridge's Delete takes them.
            let script = """
                T="$HOME/\(RemoteEngineInstaller.root)/trash/$(date +%Y%m%d-%H%M%S)-$$"
                [ ! -e \(folder) ] || { mkdir -p "$T" && mv -- \(folder) "$T/"; }
                rm -f "$HOME/\(RemoteEngineInstaller.root)/keys/"KUVO_KEY_*\(IntegrationKeys.botSuffix(bot.id))
                D="\(deleted)"; I='"\(bot.id)"'; mkdir -p "$(dirname "$D")"
                items=""; [ -s "$D" ] && items="$(sed -n 's/^{"deleted":\\[\\(.*\\)\\]}$/\\1/p' "$D" | tr ',' '\\n' | grep -vxF "$I" | head -n 499 | paste -sd, -)"
                { if [ -n "$items" ]; then printf '{"deleted":[%s,%s]}' "$I" "$items"; else printf '{"deleted":[%s]}' "$I"; fi; } >"$D.new" && mv -f "$D.new" "$D"
                """
            if let engine = app?.machines.engine(machine) {
                guard engine.isReady else { throw Failure.stillOn(machine) }
                guard await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value != nil else {
                    throw Failure.stillOn(machine)
                }
            } else {
                app?.machines.runLater(script, on: machine)
            }
        }
        await forget(bot)
        if bot.machine == nil, FileManager.default.fileExists(atPath: bot.folder) {
            do {
                try FileManager.default.moveToTrash(URL(filePath: bot.folder))
            } catch {
                log.error("A deleted bot's folder couldn't go to the Trash: \(error.localizedDescription, privacy: .public)")
            }
        }
        Analytics.shared.track("bot_deleted")
    }

    /// What this Mac keeps of a bot that's gone (deleted here, or on its machine from a phone):
    /// its place in the list and its group chats, its wake-ups, tabs, conversation and keys.
    private func forget(_ bot: Bot) async {
        await app?.groups.remove(bot)
        await app?.machineGroups.remove(bot)
        list.removeAll { $0.id == bot.id }
        described[bot.id] = nil
        if seenThere[bot.id] != nil { seenThere[bot.id] = nil }
        save()
        app?.wakeUps.forget(key: bot.id)
        app?.utilities.closeTabs(of: bot.id)
        noteSessions()
        await app?.workspace.delete(bot.sessionID)
        await BotKeys.forget(bot, app: app)
    }

    /// A personality you changed or deleted: the bots with it hear the new words, or go back to
    /// their own way.
    func personalityChanged(_ id: String) async {
        for bot in list.filter({ $0.personality == id }).map(\.id) {
            // Each as it is by then: one edited while another was being told (renamed, given
            // another personality) keeps that.
            guard let index = list.firstIndex(where: { $0.id == bot }), list[index].personality == id else { continue }
            if Personalities.shared.personality(id) == nil {
                list[index].personality = nil
                list[index].updated = .now
            }
            // Saved even when unchanged, so its session hears the new wording.
            save()
            await tell(bot, ["instructions"])
            await describe([bot])
        }
    }

    // MARK: Wake-ups

    /// Sends this Mac's wake-ups (its bots' and sessions', see `WakeUps`) as they come due, while
    /// the app runs, each round after checking the bots' jobs and instructions.
    func startWaking() {
        // Bots made before their memory file was made with them.
        for bot in list where bot.machine == nil && !FileManager.default.fileExists(atPath: bot.memoryFile) {
            try? Data(Self.blankMemory(bot.name).utf8).write(to: URL(filePath: bot.memoryFile))
        }
        app?.wakeUps.beforeRound = { [weak self] launching in
            // A job changed in a Mac bot's memory (or, at launch, each one's), before its
            // conversation's instructions are checked.
            for id in self?.memoryChanged() ?? [] { await self?.syncJob(of: id) }
            // At launch, the instructions first (an update may have changed them), so the first
            // wake-ups go with them; after that apart, so machines slow to answer never hold up
            // this Mac's wake-ups.
            if launching { await self?.syncInstructions() } else { self?.syncInstructionsApart() }
        }
        app?.wakeUps.start()
    }

    /// Whether bots' instructions are being checked, so one check runs at a time.
    @ObservationIgnored private var syncingInstructions = false

    private func syncInstructionsApart() {
        guard !syncingInstructions else { return }
        syncingInstructions = true
        Task { [weak self] in
            await self?.syncInstructions()
            self?.syncingInstructions = false
        }
    }

    /// Writes the bot's session in its folder, and the folder it works in, where `kuvo-wake fire`
    /// reads them on a machine (it waits for the folder's tools before it wakes the bot); and, for
    /// one that runs with the coding agents, that its wake-ups go to their bridge (`via`), which
    /// has its session, not the engine.
    private func writeSession(of bot: Bot) async throws {
        let file = (bot.folder as NSString).appendingPathComponent("session")
        let via = (bot.folder as NSString).appendingPathComponent("via")
        if let machine = bot.machine {
            let directory = (bot.folder as NSString).appendingPathComponent("directory")
            let timezone = (bot.folder as NSString).appendingPathComponent("timezone")
            let path = RemoteFolder.parse(bot.directory)?.path ?? bot.directory
            // Your time zone, which its wake-ups' times are in, and its rules from this Mac, for a
            // machine without zone files of its own.
            var script = "printf '%s' \(SSHConnection.quoted(bot.sessionID)) >\(SSHConnection.quoted(file)) && printf '%s' \(SSHConnection.quoted(path)) >\(SSHConnection.quoted(directory)) && printf '%s' \(SSHConnection.quoted(TimeZone.current.identifier)) >\(SSHConnection.quoted(timezone))"
            script += bot.agents == true ? " && printf bridge >\(SSHConnection.quoted(via))" : " && rm -f \(SSHConnection.quoted(via))"
            if let rules = WakeUps.zoneRules(TimeZone.current.identifier) {
                let zoneFile = (bot.folder as NSString).appendingPathComponent("zoneinfo")
                script += " && { printf '%s' \(SSHConnection.quoted(rules.base64EncodedString())) | base64 -d >\(SSHConnection.quoted(zoneFile)) 2>/dev/null || rm -f \(SSHConnection.quoted(zoneFile)); }"
            }
            guard await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value != nil else { throw Failure.noFolder }
        } else {
            try Data(bot.sessionID.utf8).write(to: URL(filePath: file))
            // Where its watches' checks run.
            try Data(bot.directory.utf8).write(to: URL(filePath: (bot.folder as NSString).appendingPathComponent("directory")))
            if bot.agents == true { try Data("bridge".utf8).write(to: URL(filePath: via)) } else { try? FileManager.default.removeItem(atPath: via) }
        }
    }

    // MARK: Its job, for the engine

    /// A new bot's memory file, so there's one to read from the start.
    /// A name as one line of plain text, as a name field shows it: line breaks, control and
    /// direction characters become spaces.
    static func oneLine(_ name: String, limit: Int = .max) -> String {
        let breaks = CharacterSet.newlines.union(.controlCharacters).union(CharacterSet(charactersIn: "\u{200E}\u{200F}\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}"))
        let words = name.components(separatedBy: breaks).joined(separator: " ")
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return String(words.prefix(limit)).trimmingCharacters(in: .whitespaces)
    }

    static func blankMemory(_ name: String) -> String {
        "# \(name)'s memory\n\nWhat \(name) keeps for next time: preferences, how things are set up, where ongoing work stands. Nothing yet.\n"
    }

    // MARK: Its job, in its memory

    /// The job in a memory file: its "## Job" section (any heading named Job), all of it, and its
    /// first line in a few words, for under the bot's name. Nil when it has none.
    static func job(inMemory text: String) -> (line: String, section: String)? {
        let lines = text.components(separatedBy: "\n")
        guard let (start, end) = jobLines(lines) else { return nil }
        var section = lines[(start + 1)..<end].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        // The job written in its heading ("## Job: Keeps CI green"): its first line. In another
        // heading ("## Job — keeps CI green"), only with nothing under it: else it names the
        // section ("## Job — what I do").
        if let (inline, isColon) = jobInHeading(lines[start]), isColon || section.isEmpty {
            section = [inline, section].filter { !$0.isEmpty }.joined(separator: "\n")
        }
        let first = section.components(separatedBy: "\n").lazy.map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        var line = first
        for mark in ["- ", "* ", "> "] where line.hasPrefix(mark) { line.removeFirst(mark.count) }
        line = line.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "__", with: "")
        if line.lowercased().hasPrefix("job:") { line = String(line.dropFirst(4)) }
        line = line.trimmingCharacters(in: .whitespaces)
        // A first line that goes on (the details written right after it): its first sentence.
        if line.count > 48, let end = line.range(of: ". ") { line = String(line[..<end.lowerBound]) }
        // A sentence's end, not a line's: "Keeps the build green." shows as "Keeps the build green".
        if line.hasSuffix("."), !line.hasSuffix("..") { line.removeLast() }
        return (line, section)
    }

    /// Where the job section is: its heading's line, and the line it ends before. It goes on to the
    /// next heading of its level or above (its own sub-headings, "### Rules", are part of it), not
    /// counting a line in a code block ("# run the tests") or one that isn't a heading ("#1 first").
    private static func jobLines(_ lines: [String]) -> (heading: Int, end: Int)? {
        guard let start = lines.firstIndex(where: isJobHeading) else { return nil }
        let level = headingLevel(lines[start]) ?? 1
        var inCode = false
        for index in (start + 1)..<lines.endIndex {
            let trimmed = lines[index].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { inCode.toggle(); continue }
            if !inCode, let other = headingLevel(lines[index]), other <= level { return (start, index) }
        }
        return (start, lines.endIndex)
    }

    /// A Markdown heading's level ("## Job" is 2), nil for a line that isn't one.
    private static func headingLevel(_ line: String) -> Int? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let marks = trimmed.prefix { $0 == "#" }.count
        guard (1...6).contains(marks) else { return nil }
        let after = trimmed.dropFirst(marks)
        return after.isEmpty || after.first == " " ? marks : nil
    }

    /// `memory` with `details` at the end of its job section (one with nothing under its heading
    /// too).
    static func addingDetails(_ details: String, toJobIn memory: String) -> String {
        var lines = memory.components(separatedBy: "\n")
        guard let (_, end) = jobLines(lines) else { return memory }
        // After its last line with words, with a blank line before the next section.
        var at = end
        while at > 0, lines[at - 1].trimmingCharacters(in: .whitespaces).isEmpty, !isJobHeading(lines[at - 1]) { at -= 1 }
        let blankAfter = at == lines.count || lines[at].trimmingCharacters(in: .whitespaces).isEmpty
        lines.insert(contentsOf: ["", details] + (blankAfter ? [] : [""]), at: at)
        return lines.joined(separator: "\n")
    }

    /// What a job heading says after "Job" ("Job: …", "Job — …", "Job (…)"), and whether after a
    /// colon; nil when nothing.
    private static func jobInHeading(_ line: String) -> (String, isColon: Bool)? {
        let title = line.trimmingCharacters(in: .whitespaces).drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)
        guard title.lowercased().hasPrefix("job") else { return nil }
        var rest = title.dropFirst(3).trimmingCharacters(in: .whitespaces)
        guard let mark = rest.first, ":-–—(".contains(mark) else { return nil }
        rest = rest.dropFirst().trimmingCharacters(in: .whitespaces)
        if mark == "(", rest.hasSuffix(")") { rest = String(rest.dropLast()).trimmingCharacters(in: .whitespaces) }
        return rest.isEmpty ? nil : (rest, mark == ":")
    }

    private static func isJobHeading(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("#") else { return false }
        let title = trimmed.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces).lowercased()
        if title == "job" || title == "my job" || title == "the job" || title.hasPrefix("job:") { return true }
        // "Job — what I do" or "Job (keeps the build green)", not "Job log" or "Job history".
        guard title.hasPrefix("job ") else { return false }
        return title.dropFirst(4).trimmingCharacters(in: .whitespaces).first.map { "-–—:(".contains($0) } ?? false
    }

    /// A memory with a job section: the line, then the details, as its first section (after its
    /// title and what's written under it, which a section would take in).
    static func addingJob(_ line: String, details: String, to memory: String) -> String {
        let body = [line, details].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: "\n\n")
        let section = ["## Job", body, ""]
        var lines = memory.trimmingCharacters(in: .newlines).components(separatedBy: "\n")
        let title = lines.firstIndex { $0.hasPrefix("# ") }
        let first = lines.indices.first { $0 != title && lines[$0].hasPrefix("#") } ?? lines.endIndex
        lines.insert(contentsOf: (first > 0 && !lines[first - 1].isEmpty ? [""] : []) + section, at: first)
        return lines.joined(separator: "\n").trimmingCharacters(in: .newlines) + "\n"
    }

    /// Its memory file's text; nil when it can't be read (its machine isn't connected, say).
    private func memory(of bot: Bot) async -> String? {
        guard let machine = bot.machine else { return try? String(contentsOfFile: bot.memoryFile, encoding: .utf8) }
        let file = SSHConnection.quoted(bot.memoryFile)
        return await Task.detached { RemoteShell.run("cat \(file)", on: machine) }.value.map { String(decoding: $0, as: UTF8.self) }
    }

    private func write(memory text: String, of bot: Bot) async -> Bool {
        guard let machine = bot.machine else { return (try? Data(text.utf8).write(to: URL(filePath: bot.memoryFile), options: .atomic)) != nil }
        // On its input, not its command line (which has a size limit a long memory can pass).
        let file = FileManager.default.temporaryDirectory.appending(path: "kuvo-memory-\(UUID().uuidString).md")
        defer { try? FileManager.default.removeItem(at: file) }
        guard (try? Data(text.utf8).write(to: file)) != nil else { return false }
        let quoted = SSHConnection.quoted(bot.memoryFile)
        return (try? await SSHConnection(destination: machine).run("cat >\(quoted).new && mv -f \(quoted).new \(quoted)", input: file)) != nil
    }

    /// When each Mac bot's memory was last read, so it's read again only once it changes.
    @ObservationIgnored private var memoryRead: [String: Date] = [:]

    /// Reads its job from its memory, as the bot keeps it, and gives a changed one to its
    /// conversation and its group chats. A bot whose job was written in Edit Bot first has it
    /// moved into its memory, once.
    func syncJob(of id: String) async {
        guard let bot = bot(id), var text = await memory(of: bot) else { return }
        var updated = bot
        if bot.jobInMemory != true {
            let old = [bot.job, bot.instructions].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            if !old.allSatisfy(\.isEmpty) {
                if let kept = Self.job(inMemory: text) {
                    // It wrote one of its own: what Edit Bot said goes under it, if it isn't there.
                    let missing = old[1].isEmpty || Self.flat(kept.section).contains(Self.flat(old[1])) ? "" : old[1]
                    if !missing.isEmpty { text = Self.addingDetails(missing, toJobIn: text) }
                } else {
                    text = Self.addingJob(old[0], details: old[1], to: text)
                }
                guard await write(memory: text, of: bot) else { return }
            }
            updated.jobInMemory = true
        }
        let kept = Self.job(inMemory: text)
        updated.job = kept?.line ?? ""
        updated.instructions = kept?.section ?? ""
        // (Not an edit of its description's: a job the bot wrote itself doesn't make this Mac's
        // copy newer than a rename from a phone on its machine, which this Mac takes in.)
        if bot.machine == nil { memoryRead[id] = (try? FileManager.default.attributesOfItem(atPath: bot.memoryFile)[.modificationDate]) as? Date }
        guard updated != bot, let index = list.firstIndex(where: { $0.id == id }) else { return }
        list[index] = updated
        save()
        guard updated.job != bot.job || updated.instructions != bot.instructions else { return }
        await tell(updated.id, ["instructions"])
        if updated.job != bot.job { await describe([id]) }
    }

    /// Text compared without its spacing.
    private static func flat(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Mac bots whose memory changed since it was last read.
    private func memoryChanged() -> [String] {
        list.filter { bot in
            guard bot.machine == nil else { return false }
            let modified = (try? FileManager.default.attributesOfItem(atPath: bot.memoryFile)[.modificationDate]) as? Date
            return modified != nil && modified != memoryRead[bot.id]
        }.map(\.id)
    }

    /// A bot's run ended: its job may have changed in its memory (on a machine, where it can't be
    /// seen changing).
    func runEnded(session: String) {
        guard let bot = bot(forSession: session), bot.machine != nil else { return }
        Task { await syncJob(of: bot.id) }
    }

    /// Whether a path is a bot's memory file.
    static func isMemory(_ path: String) -> Bool {
        path.hasSuffix("/MEMORY.md") && path.contains("/bots/bot_")
    }

    /// For a bot that works in one of the user's projects: the same folder, and checkout, as
    /// their own sessions there.
    private static let projectNote = """
        You work in one of the user's projects, in the same folder their own sessions use, so leave it the way you found \
        it. When you work on a branch of your own, go back to the branch the project was on once you're done, so the \
        user's checkout doesn't move. Never commit or throw away changes you didn't make; leave them and say so.
        """

    /// What the bot's session knows about being a bot: who it is, its job, its memory and how to
    /// wake itself up.
    /// `personality`: what its personality tells it, when not its own (a machine's kit, see
    /// `MachineKit`, has a stand-in there).
    static func instructions(for bot: Bot, personality: String? = nil) -> String {
        let place = bot.machine.map { "the Linux machine \"\($0)\"" } ?? "this Mac"
        let job = bot.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        let told = personality ?? Personalities.shared.personality(bot.personality)?.instruction
        return """
        You are \(bot.name), one of the user's bots in Kuvo Code\(bot.job.isEmpty ? "" : ": \(bot.job)"). A bot is a teammate with one job, \
        who keeps working on it over time in this one conversation. You run on \(place).
        \(told.map { "\n\($0)\n" } ?? "")
        Your job is what the user gives you in this conversation, and it changes as they tell you more. Keep it at the top \
        of your memory file, under a "## Job" heading: first, on a line of its own, what you do in a few words, like "Keeps \
        the build green" (Kuvo Code shows it under your name); then, below it, the details: what to watch, what to make, what \
        never to do without asking. When the user gives you a job or changes it, update that section before anything else.

        \(job.isEmpty ? "You don't have a job yet: ask the user what they'd like you to do, if they haven't said." : "Your job, as your memory has it:\n\(job)")

        You can work on a schedule. Kuvo Code wakes you up at the times you choose, even while the user is away, so you can do \
        things later ("in 2 hours", "tomorrow at 9") or again and again ("every 5 minutes", "every morning"). Never say you can't \
        run in the background, on a timer or on a schedule: schedule a wake-up instead.

        To schedule a wake-up, use schedule_wake_up: <when> is +5m, +2h, +1d, or a time like 2026-10-16T09:00 \
        \(bot.machine == nil ? "on this Mac's clock" : "in the user's time zone, \(TimeZone.current.identifier)"), at least a minute from now. At \
        that time this conversation gets your note as a new message starting with \
        "\(Wakes.marker.trimmingCharacters(in: .whitespaces))", and you carry on. For something that repeats, schedule it once \
        with every (30m, 2h, 1d, 1w, at least 5m, or weekdays; days, weeks and weekdays keep the same time of day), and it \
        keeps coming back until it's canceled: don't schedule the next run yourself each time. list_wake_ups shows what's \
        scheduled, cancel_wake_up cancels one. To change a schedule, cancel it and add the new one; check the list first so \
        you never keep two for the same thing. When it's due now too, also do the first round now.

        To watch for a change (a status page, a build, a price, a file), don't wake up every time just to look: \
        watch_for_change runs a check you give it, a shell command that prints what matters, every 5m or more, 2h or 1d, and \
        wakes you only when what it prints changes, with the new output. Make the check print just what you watch, like \
        `curl -s <url> | grep -o '<the part that matters>'` or `gh run list --limit 1 --json conclusion -q '.[0].conclusion'`, \
        so a clock or an ad on the page doesn't count as a change. It runs in your folder, for at most a minute. Only what it \
        prints counts, not its errors, and printing nothing counts too (grep finding nothing), so you hear when something \
        appears or goes away. A run is skipped when a curl, wget or gh in it fails (the network down, say; an error page \
        still counts), or when it prints nothing and exits 2 or more: make a script of yours do that when it can't tell. To \
        watch whether a site is up, print its status code: `curl -s -o /dev/null -w '%{http_code}' <url>` prints 000 when it \
        can't connect, which counts (though your own network being down looks the same). A page that needs a real browser \
        to show its content can't be watched this way; check it in the browser on a wake-up instead. Keep reports short; \
        the user reads them later.

        Memory: the file "\(bot.memoryFile)" is yours. Read it when you start a piece of work. Keep in it what you'll need next \
        time: lasting preferences, how things are set up, where ongoing work stands, and any schedule you're keeping. Keep it short \
        and current; check facts at their source rather than trusting it.

        You have a web browser, through the browser tools: \(bot.machine == nil ? "tabs of your own in the user's browser on this Mac, signed in where they are" : "one on this machine, which keeps its sign-ins and keeps working while the user's Mac is off"). \
        When a page asks to sign in, for a one-time code, or for something only the user can do (a CAPTCHA, approving on \
        their phone), use browser_sign_in, browser_ask_code or browser_ask_user: they ask the user in Kuvo Code and wait for \
        the answer, which goes straight into the page. If no one answers, carry on with what you can and schedule a wake-up \
        to try again later. But for a service the user connected in Settings › Integrations (their mail or calendar, Notion, \
        GitHub…), use its tools, named after it, never its website.

        The user is usually away while you work. When you need a decision from them, say so plainly in a short message and \
        stop.\(bot.project == nil ? "" : "\n\n" + projectNote)

        \(identityNote)
        """
    }

    /// Who sets what about a bot, so it doesn't claim to have changed them.
    static let identityNote = """
        Your name, look, personality and model are set by the user in Kuvo Code, under Edit Bot. You can't change them, \
        and writing a new name into your memory doesn't change it either. If you're asked to, say so plainly and suggest \
        Edit Bot, which lists the models they can use; don't list models yourself, since you'd see ones they have no \
        account for. Your job is yours to keep, in your memory, as the user gives it to you.
        """

    /// Gives each bot's session the current wording of its instructions, once a run of the app,
    /// as its engine comes up: bots made by an older version learn what this one can do.
    /// A bot's own rules: its folder is its to read and write, wherever it works. Its wake-ups
    /// never ask (they're Kuvo Code's tools); its watches go by the conversation's approval.
    static func ownRules(for bot: Bot) -> [PermissionRule] {
        // Its wake-ups are tools of Kuvo Code's (schedule_wake_up…), which need no rule of their
        // own; an earlier version allowed its kuvo-wake commands, which let one that also wrote
        // a file (a redirect) through (see `isOwnRule`).
        [PermissionRule(action: "external_directory", resource: (bot.folder as NSString).appendingPathComponent("*"), effect: .allow)]
    }

    /// Whether a rule is one of a bot's own, as made now or by an earlier version.
    private static func isOwnRule(_ rule: PermissionRule, of bot: Bot) -> Bool {
        let full = bot.machine == nil ? command.path : machineCommand
        if rule.action == "external_directory" { return rule.resource == (bot.folder as NSString).appendingPathComponent("*") }
        return rule.action == "shell" && (rule.resource.hasPrefix("kuvo-wake \(bot.id) ") || rule.resource.hasPrefix("\"\(full)\" \(bot.id) "))
    }

    /// Puts a bot's own rules back as they're made now, after its approval and any others: an
    /// earlier version lost them when its conversation's approval changed, or its folder when the
    /// project's were synced, and allowed every kuvo-wake command.
    /// Whether its rules are as made now (false while its session isn't listed yet, or they
    /// couldn't be set).
    @discardableResult
    private func repairRules(of bot: Bot, api: OpenCodeAPI) async -> Bool {
        guard let session = app?.workspace.session(bot.sessionID) else { return false }
        let rules = session.permissions ?? []
        // Its approval with Settings › Permissions as they are now, as a conversation that's open gets it.
        let repaired = ToolApproval.refreshed(rules.filter { !Self.isOwnRule($0, of: bot) }, settings: EngineConfig.rules(on: bot.machine)) + Self.ownRules(for: bot)
        guard repaired != rules else { return true }
        return (try? await api.setPermissions(session: bot.sessionID, rules: repaired)) != nil
    }

    /// What each bot's conversation was last given as its instructions, by session. The engine
    /// keeps them; giving them again opens the bot's folder there, with a copy of every MCP server
    /// it has, for an hour, so a launch gives only those that changed.
    private static let sentKey = "botInstructions"

    private func sendInstructions(of bot: Bot, api: OpenCodeAPI) async throws {
        let text = Self.instructions(for: bot)
        try await api.setInstruction(session: bot.sessionID, key: Self.instructionKey, text: text)
        var sent = UserDefaults.standard.dictionary(forKey: Self.sentKey) as? [String: String] ?? [:]
        sent[bot.sessionID] = Self.digest(text)
        // Only conversations that are still bots'.
        sent = sent.filter { id, _ in list.contains { $0.sessionID == id } }
        UserDefaults.standard.set(sent, forKey: Self.sentKey)
    }

    private static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func syncInstructions() async {
        // What was changed while their machines were away, once they're back.
        for id in waitingEdits.keys {
            guard let bot = bot(id) else {
                waitingEdits[id] = nil
                continue
            }
            if api(for: bot) != nil { await tell(id) }
        }
        await app?.groups.catchUp()
        let sent = UserDefaults.standard.dictionary(forKey: Self.sentKey) as? [String: String] ?? [:]
        for listed in list where !synced.contains(listed.id) {
            guard let api = api(for: listed) else { continue }
            // A machine's bot: its job as its memory there has it now.
            if listed.machine != nil { await syncJob(of: listed.id) }
            guard let bot = bot(listed.id) else { continue }
            if sent[bot.sessionID] != Self.digest(Self.instructions(for: bot)) {
                do {
                    try await sendInstructions(of: bot, api: api)
                } catch let error as ServerError where error.status == 404 {
                    // Its conversation is gone from the engine: asking again each time won't
                    // bring it back.
                    synced.insert(bot.id)
                    continue
                } catch {
                    continue
                }
            }
            // Not until its rules are as made now: a machine's sessions are listed a moment after its
            // engine answers, and an earlier version's kuvo-wake rules mustn't stay meanwhile.
            guard await repairRules(of: bot, api: api) else { continue }
            synced.insert(bot.id)
            try? await writeSession(of: bot)
            if let machine = bot.machine {
                // Its kuvo-wake as the instructions describe it, for an engine started before.
                if wakeInstalled.insert(machine).inserted, let engine = app?.machines.engine(machine) {
                    try? await Wakes.install(on: engine.machine.connection)
                }
            }
        }
    }

    // MARK: Moving

    /// A bot that moved to another computer (`Moves`): it lives on `machine` (nil: this Mac) from
    /// now on, in `folder`, with its conversation carried there (`session`, the same ID, on `api`).
    /// Its session there gets its rules for its folder there, and instructions that say where it
    /// runs; its folder, what kuvo-wake reads there; its description.
    func moved(_ id: String, to machine: String?, folder: String, session: Session, api: OpenCodeAPI) async {
        guard let index = list.firstIndex(where: { $0.id == id }) else { return }
        let old = list[index]
        var bot = old
        bot.machine = machine
        bot.folder = folder
        list[index] = bot
        save()
        app?.workspace.add(session)
        noteSessions()
        let rules = (session.permissions ?? []).filter { !Self.isOwnRule($0, of: old) && !Self.isOwnRule($0, of: bot) }
        var done = (try? await api.setPermissions(session: bot.sessionID, rules: ToolApproval.refreshed(rules, settings: EngineConfig.rules(on: bot.machine)) + Self.ownRules(for: bot))) != nil
        done = (try? await sendInstructions(of: bot, api: api)) != nil && done
        done = (try? await writeSession(of: bot)) != nil && done
        // What didn't get there is tried again with the next check of bots' instructions.
        if !done { synced.remove(id) }
        if let machine, wakeInstalled.insert(machine).inserted, let engine = app?.machines.engine(machine) {
            try? await Wakes.install(on: engine.machine.connection)
        }
        described[id] = nil
        await describe([id])
    }

    // MARK: Descriptions

    /// What this run last wrote to each bot's `bot.json`, so one that hasn't changed isn't
    /// written again.
    @ObservationIgnored private var described: [String: Data] = [:]

    static func descriptorData(_ bot: Bot) -> Data? {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try? encoder.encode(bot.descriptor)
    }

    /// Writes bots' descriptions (`Bot.Descriptor`) in their folders, as they are by then: on this
    /// Mac now, on a connected machine in one go; one on a machine that's away gets it as the
    /// machine connects again (`describeAll(on:)`). A bot whose folder has gone gets none: no
    /// folder is made. One round at a time where they live, so an older round's never lands after
    /// a newer one's, and one place never waits on another (this Mac's bots on a slow machine's).
    /// `force` writes them even if this run wrote the same before.
    func describe(_ ids: [String], force: Bool = false) async {
        let places = Dictionary(grouping: ids) { bot($0)?.machine ?? "" }
        await withTaskGroup(of: Void.self) { group in
            for (place, ids) in places {
                let previous = describing[place]
                let round = Task { [weak self] in
                    await previous?.value
                    await self?.writeDescriptions(of: ids, force: force)
                }
                describing[place] = round
                group.addTask { await round.value }
            }
        }
    }

    /// The round of descriptions being written in each place (a machine, or "" for this Mac),
    /// which the next one there waits for.
    @ObservationIgnored private var describing: [String: Task<Void, Never>] = [:]

    private func writeDescriptions(of ids: [String], force: Bool) async {
        let changed = ids.compactMap { id -> (bot: Bot, data: Data)? in
            guard let bot = bot(id), let data = Self.descriptorData(bot), force || described[id] != data else { return nil }
            return (bot, data)
        }
        for (bot, data) in changed where bot.machine == nil {
            var isFolder: ObjCBool = false
            guard FileManager.default.fileExists(atPath: bot.folder, isDirectory: &isFolder), isFolder.boolValue else { continue }
            let file = URL(filePath: bot.folder).appending(path: Bot.Descriptor.file)
            do {
                if (try? Data(contentsOf: file)) != data { try data.write(to: file, options: .atomic) }
                described[bot.id] = data
            } catch {
                log.error("A bot's description wasn't written: \(error.localizedDescription, privacy: .public)")
            }
        }
        let away = Dictionary(grouping: changed.filter { $0.bot.machine != nil }) { $0.bot.machine ?? "" }
        for (machine, entries) in away {
            guard let engine = app?.machines.engine(machine), engine.isReady else { continue }
            guard let kept = await Self.write(entries.map { ($0.bot, $0.data, seenThere[$0.bot.id]) }, on: engine.machine.connection) else {
                log.error("Bots' descriptions weren't written on a machine")
                continue
            }
            for (bot, data) in entries where !kept.contains(bot.folder) {
                described[bot.id] = data
                seenThere[bot.id] = data
            }
            // Edited there since (from a phone, through its bridge): taken in, then written again.
            let again = entries.filter { kept.contains($0.bot.folder) }.map(\.bot.id)
            if !again.isEmpty {
                Task { [weak self] in
                    await self?.adoptMade(on: machine)
                    await self?.describe(again, force: true)
                }
            }
        }
    }

    /// The bots of this Mac (nil) or of a machine, written again whatever this run wrote before:
    /// at the update that brought descriptions, and as a machine connects (where a copy of the
    /// app before them, or one on another Mac, could have left one out of date or none).
    func describeAll(on machine: String?) async {
        await describe(list.filter { $0.machine == machine }.map(\.id), force: true)
    }

    /// Writes descriptions on a machine, through one connection: each folder and description, on
    /// its input (a command line has a size limit), each written whole, never into a folder
    /// that isn't there.
    /// Writes them on a machine, but for one whose description there changed since this Mac last
    /// saw it (`seen`; edited there, from a phone): kept, and named in what this answers (its
    /// folder). Nil: not written.
    private static func write(_ entries: [(bot: Bot, data: Data, seen: Data?)], on connection: SSHConnection) async -> Set<String>? {
        let lines = entries.map { [Data($0.bot.folder.utf8), $0.data, $0.seen ?? Data()].map { $0.base64EncodedString() }.joined(separator: "\t") }.joined(separator: "\n") + "\n"
        let folder = FileManager.default.temporaryDirectory.appending(path: AppInfo.bundleID)
        let input = folder.appending(path: "bot-descriptions-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: input) }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data(lines.utf8).write(to: input)
            let output = try await connection.run("""
                t="$(printf '\\t')"
                while IFS="$t" read -r f j w; do
                  d="$(printf '%s' "$f" | base64 -d)" || exit 1
                  [ -d "$d" ] || continue
                  b="$d/\(Bot.Descriptor.file)"
                  if [ -n "$w" ] && [ -f "$b" ]; then
                    printf '%s' "$w" | base64 -d >"$b.was" || exit 1
                    if ! cmp -s "$b" "$b.was"; then rm -f "$b.was"; printf 'kept\\t%s\\n' "$f"; continue; fi
                    rm -f "$b.was"
                  fi
                  printf '%s' "$j" | base64 -d >"$b.new" && mv -f "$b.new" "$b" || { rm -f "$b.new"; exit 1; }
                done
                echo written
                """, input: input)
            guard output.contains("written") else { return nil }
            let kept = output.split(separator: "\n").compactMap { line -> String? in
                let parts = line.split(separator: "\t", maxSplits: 1).map(String.init)
                guard parts.count == 2, parts[0] == "kept", let folder = Data(base64Encoded: parts[1]).flatMap({ String(data: $0, encoding: .utf8) }) else { return nil }
                return folder
            }
            return Set(kept)
        } catch {
            return nil
        }
    }

    // MARK: Storage

    private static func load() -> [Bot] {
        JSONFile.read([Bot].self, from: file, isoDates: true) ?? []
    }

    /// Each machine bot's description as this Mac last saw it there (wrote it, or took it in), as
    /// it was written: what changed there since is what differs from it, whatever the two clocks
    /// say (`takeIn`, and a description written there keeps one changed since).
    @ObservationIgnored private var seenThere: [String: Data] = JSONFile.read([String: Data].self, from: Bots.seenFile) ?? [:] {
        didSet { _ = JSONFile.write(seenThere, to: Self.seenFile) }
    }
    private static var seenFile: URL { AppInfo.supportDirectory.appending(path: "machine-bots.json") }

    private func save() {
        JSONFile.write(list, to: Self.file, isoDates: true, readable: true)
    }

    /// A machine found to be another one here at another address (see `Machines.fold`): its bots
    /// live on the other, as they did all along.
    func fold(_ machine: String, into other: String) {
        var changed = false
        for index in list.indices where list[index].machine == machine {
            list[index].machine = other
            if let project = list[index].project, let parsed = RemoteFolder.parse(project), parsed.machine == machine {
                list[index].project = RemoteFolder.folder(parsed.path, on: other)
            }
            changed = true
        }
        if changed { save() }
    }
}

// MARK: - Bots a machine makes

/// Bots a machine makes itself, with this Mac closed (New Bot there, from a phone): what it needs to
/// make them as this Mac does, given as it connects, and the bots it made, taken in here as it does.
extension Bots {
    /// What a machine needs to make bots itself, kept in `~/.kuvo-code/bots/kit.json` there: New
    /// Bot's templates, personalities and looks; what a bot is told (with ⟦name⟧, ⟦folder⟧ and
    /// ⟦personality⟧ for its own), its first memory (⟦name⟧) and its greeting; the projects there
    /// and the model a bot starts on; the rules a new conversation gets; and your time zone.
    struct MachineKit: Encodable {
        struct Template: Encodable {
            var id: String, name: String, job: String, instructions: String, look: BotLook, personality: String?, wantsProject: Bool
            /// The template's job, as the first message to the bot, for your composer.
            var firstMessage: String
        }
        struct Personality: Encodable { var id: String, name: String, description: String, custom: Bool, instruction: String }
        struct Looks: Encodable { var colors: [String], shapes: [String], faces: [String] }
        struct Project: Encodable { var directory: String, name: String }
        var kuvo = 1
        var templates: [Template]
        var personalities: [Personality]
        /// What a bot is told of a personality made there, by its name and description.
        var personalityWords = KuvoCode.Personality.words
        var looks: Looks
        var startingModel: ModelRef?
        var projects: [Project]
        var instructions: String
        /// What a bot with a job is told, for one changed there: as `instructions`, with ⟦job⟧ for
        /// its job in a few words and ⟦jobDetails⟧ for all of it, as its memory has them.
        var jobInstructions: String
        var projectNote: String
        var identityNote: String
        var memory: String
        var greeting: String
        /// A new conversation's rules, before a bot's own (its folder).
        var rules: [PermissionRule]
        var timeZone: String
        /// Its time zone's rules, for a machine without zone files of its own.
        var zoneinfo: String?
    }

    func kit(for machine: String) -> MachineKit {
        let sample = Bot(id: "bot_sample", name: "⟦name⟧", job: "", instructions: "", look: .random(), machine: machine, project: nil,
                         folder: "⟦folder⟧", sessionID: "", created: .now)
        var working = sample
        working.job = "⟦job⟧"
        working.instructions = "⟦jobDetails⟧"
        let approval = UserDefaults.standard.string(forKey: ToolApproval.key).flatMap(ToolApproval.init) ?? .approveAll
        let catalog = app?.machines.engine(machine)?.catalog
        return MachineKit(
            templates: BotTemplate.all.map { .init(id: $0.id, name: $0.name, job: $0.job, instructions: $0.instructions, look: $0.look, personality: $0.personality,
                                                   wantsProject: $0.wantsProject, firstMessage: BotTemplate.firstMessage(job: $0.job, instructions: $0.instructions)) },
            personalities: Personalities.shared.all.map { .init(id: $0.id, name: $0.name, description: $0.description, custom: $0.isCustom, instruction: $0.instruction) },
            looks: .init(colors: BotLook.Tint.allCases.map(\.rawValue), shapes: BotLook.Form.allCases.map(\.rawValue), faces: BotLook.Face.allCases.map(\.rawValue)),
            startingModel: catalog?.startingModel(LastModel.current, scope: .on(machine: machine)),
            projects: (app?.workspace.projects ?? []).filter { RemoteFolder.machine(of: $0.directory) == machine }
                .map { .init(directory: RemoteFolder.parse($0.directory)?.path ?? $0.directory, name: $0.name) },
            instructions: Self.instructions(for: sample, personality: "⟦personality⟧"),
            jobInstructions: Self.instructions(for: working, personality: "⟦personality⟧"),
            projectNote: Self.projectNote, identityNote: Self.identityNote, memory: Self.blankMemory("⟦name⟧"), greeting: Self.greeting,
            rules: approval.rules(settings: EngineConfig.rules(on: machine)),
            timeZone: TimeZone.current.identifier, zoneinfo: WakeUps.zoneRules(TimeZone.current.identifier)?.base64EncodedString())
    }

    /// Gives a machine its kit, as it connects.
    func writeKit(on machine: String) async {
        guard let connection = app?.machines.engine(machine)?.machine.connection,
              let data = try? JSONEncoder().encode(kit(for: machine)) else { return }
        let folder = FileManager.default.temporaryDirectory.appending(path: AppInfo.bundleID)
        let input = folder.appending(path: "bot-kit-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: input) }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: input)
            _ = try await connection.run("""
                B="$HOME/\(RemoteEngineInstaller.root)/bots"
                mkdir -p "$B" && cat >"$B/kit.json.new" && mv -f "$B/kit.json.new" "$B/kit.json"
                """, input: input)
        } catch {
            log.error("A machine's bot kit wasn't written: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// A bot's folder on a machine, as read there: its description, its conversation and where
    /// that runs.
    struct Found {
        var folder: String
        var descriptor: Data
        var session: String
        var via: String
    }

    /// Takes in the bots a machine made while this Mac was away (`MachineKit`), from their
    /// folders there; the ones it knows stay as they are. The bots taken in.
    @discardableResult
    func adopt(_ found: [Found], on machine: String) -> [Bot] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        var adopted: [Bot] = []
        for entry in found {
            guard let described = try? decoder.decode(Bot.Descriptor.self, from: entry.descriptor), described.kuvo == Bot.Descriptor.version,
                  described.id.hasPrefix("bot_"), (entry.folder as NSString).lastPathComponent == described.id,
                  !entry.session.isEmpty, bot(described.id) == nil, !adopted.contains(where: { $0.id == described.id }) else { continue }
            var bot = Bot(id: described.id, name: Self.oneLine(described.name), job: described.job, instructions: "", look: described.look, machine: machine,
                          project: described.project.map { RemoteFolder.folder($0, on: machine) }, folder: entry.folder, sessionID: entry.session, created: described.created)
            bot.jobInMemory = true
            bot.model = described.model
            bot.personality = described.personality
            if entry.via == "bridge" { bot.agents = true }
            bot.updated = described.updated
            adopted.append(bot)
            seenThere[described.id] = entry.descriptor
        }
        guard !adopted.isEmpty else { return [] }
        list.append(contentsOf: adopted)
        save()
        noteSessions()
        return adopted
    }

    /// The bots a machine made while this Mac was away, read there and taken in, as it connects,
    /// with what was changed or deleted there meanwhile (`takeIn`).
    func adoptMade(on machine: String) async {
        let deletedFile = "$HOME/\(RemoteEngineInstaller.root)/bots/\(Self.deletedFile)"
        guard let connection = app?.machines.engine(machine)?.machine.connection,
              let output = try? await connection.run("""
                for d in "$HOME/\(RemoteEngineInstaller.root)/bots"/bot_*; do
                  [ -f "$d/\(Bot.Descriptor.file)" ] && [ -s "$d/session" ] || continue
                  printf '%s\t%s\t%s\t%s\n' "$d" "$(base64 <"$d/\(Bot.Descriptor.file)" | tr -d '\n')" "$(head -c 200 "$d/session" | tr -d '\n\t')" "$(head -c 20 "$d/via" 2>/dev/null | tr -d '\n\t')"
                done
                if [ -f "\(deletedFile)" ]; then printf 'deleted\t%s\n' "$(base64 <"\(deletedFile)" | tr -d '\n')"; fi
                """) else { return }
        var deleted: Set<String> = []
        let found = output.split(separator: "\n").compactMap { line -> Found? in
            let parts = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            if parts.count == 2, parts[0] == "deleted" {
                struct Deleted: Decodable { var deleted: [String] }
                deleted = Set(Data(base64Encoded: parts[1]).flatMap { try? JSONDecoder().decode(Deleted.self, from: $0) }?.deleted ?? [])
                return nil
            }
            guard parts.count == 4, let descriptor = Data(base64Encoded: parts[1]) else { return nil }
            return Found(folder: parts[0], descriptor: descriptor, session: parts[2], via: parts[3])
        }
        let adopted = adopt(found, on: machine)
        for bot in adopted { await syncJob(of: bot.id) }
        await takeIn(found, deleted: deleted, on: machine)
    }

    /// The bots a machine's bridge deleted (from a phone, with this Mac closed), kept there in
    /// `~/.kuvo-code/bots/deleted.json` as `{"deleted": [<bot id>…]}`, the latest first.
    static let deletedFile = "deleted.json"

    /// What was changed or deleted on a machine while this Mac was away (from a phone, through its
    /// bridge), taken in as it connects: of a bot's description there, what changed since this Mac
    /// last saw it (its name, look, personality or model, as Edit Bot gives them) is taken in, and
    /// what didn't stays as this Mac has it, however the two computers' clocks differ; one deleted
    /// there, whose folder has gone, goes here too, as Delete Bot… leaves it. One on its way to
    /// another computer is left as it is.
    func takeIn(_ found: [Found], deleted: Set<String>, on machine: String) async {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        for entry in found {
            guard let described = try? decoder.decode(Bot.Descriptor.self, from: entry.descriptor), described.kuvo == Bot.Descriptor.version,
                  (entry.folder as NSString).lastPathComponent == described.id, let known = bot(described.id), known.machine == machine,
                  !Moves.isFrozen(known.id) else { continue }
            let seen = seenThere[known.id]
            guard seen != entry.descriptor else { continue }
            let before = seen.flatMap { try? decoder.decode(Bot.Descriptor.self, from: $0) }
            // Never seen there by this Mac (an older Kuvo Code took it in): the newer, by the clocks.
            if before == nil, described.updated <= (known.updated ?? known.created) {
                seenThere[known.id] = entry.descriptor
                continue
            }
            var edited = known
            let name = Self.oneLine(described.name)
            if !name.isEmpty, described.name != before?.name { edited.name = name }
            if described.look != before?.look { edited.look = described.look }
            if described.personality != before?.personality { edited.personality = described.personality }
            if described.model != before?.model { edited.model = described.model }
            seenThere[known.id] = entry.descriptor
            if edited != known { await update(edited) }
        }
        let there = Set(found.map { ($0.folder as NSString).lastPathComponent })
        for id in deleted where !there.contains(id) {
            guard let known = bot(id), known.machine == machine, !Moves.isFrozen(id) else { continue }
            await forget(known)
        }
    }
}
