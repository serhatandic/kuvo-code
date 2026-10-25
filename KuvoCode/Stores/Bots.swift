import AppKit
import OpenCodeKit
import os

/// A bot: a teammate with a name, a look and one job. It keeps one conversation (an engine
/// session) on this Mac or on one of your machines, remembers what it learns in a file of its own,
/// and can schedule its own wake-ups to carry on later. Each computer's box keeps its own bots
/// (KuvoLink's PROTOCOL.md, `kuvo/bots`); this is what the app shows of one.
struct Bot: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    /// What it does, in a few words, under its name ("Keeps CI green"): the bot keeps it with its
    /// set_job tool, in its box's record.
    var job: String
    /// Its job in full: what to watch, what to make, what never to do.
    var instructions: String
    /// Always true now (its job is its box's): an earlier version, going back to it, reads the job
    /// as written here rather than moving it into its memory.
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
    /// Its conversation runs with the coding agents: a model of theirs, or Auto, and the engine's
    /// models through them. Nil for the engine's.
    var agents: Bool?
    /// When an earlier version noted it changed; kept as it was.
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

    /// The box it lives on: "mac", or its machine's id.
    var box: String { machine ?? BoxClient.mac }

    /// What a bot is, beside its memory as `bot.json` where it lives, as versions before boxes kept
    /// their bots wrote it: kept for an update from one of those (`Calibration`), whose bots on this
    /// Mac have none yet.
    struct Descriptor: Codable, Equatable {
        static let version = 1
        static let file = "bot.json"

        var kuvo = Descriptor.version
        var id: String
        var name: String
        var job: String
        var look: BotLook
        var personality: String?
        var model: ModelRef?
        var project: String?
        var created: Date
        var updated: Date
    }

    var descriptor: Descriptor {
        Descriptor(id: id, name: name, job: job, look: look, personality: personality, model: model,
                   project: project.map { RemoteFolder.parse($0)?.path ?? $0 }, created: created, updated: updated ?? created)
    }
}

/// A bot as its box lists it (`kuvo/bots`).
struct ListedBot: Decodable, Equatable {
    var id: String
    var session: String
    var name: String
    var look: BotLook
    var job: String?
    var jobDetails: String?
    var agents: Bool?
    var personality: String?
    var model: ModelRef?
    /// Its folder and its project, as its box names them.
    var folder: String?
    var project: String?
    var created: String?
}

/// Your bots, wherever each lives, as their computers' boxes keep them: this Mac's followed as they
/// change (`kuvo/bots/events`), a machine's read as it connects, after a change from here, and as
/// one of its bots' runs ends. What each box last said is kept (`bots.json`) to show while its
/// computer is away, in the form an earlier version reads, so going back to one finds them. An
/// edit for a computer that's away waits for it (`BotEdits`), shown as made meanwhile.
@Observable
final class Bots {
    /// Your bots as you see them: as their boxes last said, with your edits waiting for their
    /// computer as made.
    private(set) var list: [Bot] = []
    /// As their boxes last said.
    @ObservationIgnored private var known: [Bot] = []
    /// Edits waiting for their computer.
    let edits: BotEdits
    /// Each bot's waiting wake-ups, as last read, by its ID.
    var wakes: [String: [Wakes.Pending]] { app?.wakeUps.wakes ?? [:] }
    /// Each bot's watches, as last read.
    var watches: [String: [Wakes.Watch]] { app?.wakeUps.watches ?? [:] }
    /// Bots whose wake-ups you paused: they wait until you resume them.
    var paused: Set<String> { app?.wakeUps.paused ?? [] }
    @ObservationIgnored weak var app: AppModel?
    /// A box's routes, by its id ("mac", or a machine's), as the app reaches them (`AppModel.box`);
    /// a test's stand-ins.
    @ObservationIgnored var boxes: ((String) -> BoxClient)?
    /// Whether a machine's box can be asked now (connected); a test's stand-in.
    @ObservationIgnored var reachable: ((String) -> Bool)?
    private let log = Logger(subsystem: "run.kuvo.code", category: "bots")

    /// The key under which a bot's job goes to its session.
    static let instructionKey = "kuvo.bot"
    static var file: URL { AppInfo.supportDirectory.appending(path: "bots.json") }
    /// This Mac's bots' folders.
    static var root: URL { AppInfo.supportDirectory.appending(path: "bots") }
    /// The wake-up command on this Mac.
    static var command: URL { WakeUps.command }
    /// The wake-up command on a machine.
    static var machineCommand: String { WakeUps.machineCommand }

    init(edits: BotEdits = BotEdits()) {
        self.edits = edits
        known = Self.load()
        show()
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

    private func client(_ box: String) -> BoxClient? {
        boxes?(box) ?? app?.box(box)
    }

    private func canReach(_ machine: String) -> Bool {
        reachable?(machine) ?? (app?.machines.engine(machine)?.isReady == true)
    }

    /// The computer an edit of `bot`'s waits for, by name, while one does.
    func waitingFor(_ bot: Bot) -> String? {
        guard edits.waiting[bot.id] != nil else { return nil }
        return bot.machine.map { app?.machines.engine($0)?.machine.name ?? $0 } ?? AppInfo.name
    }

    /// The model a bot talks on, as its editor shows it: the one picked for it in Edit Bot while
    /// that can run where it lives; otherwise (its account signed out of, which takes its models
    /// away, so Edit Bot shows none) what its own conversation is on now, as its group chats do.
    func talkingModel(of bot: Bot) -> ModelRef? {
        let conversation = app?.workspace.session(bot.sessionID)?.model
        guard let picked = bot.model else { return conversation }
        let catalog = bot.machine.flatMap { app?.machines.engine($0)?.catalog } ?? app?.catalog
        return catalog?.isUnavailable(picked) == true ? (conversation ?? picked) : picked
    }

    /// What a bot's conversation runs on: the coding agents' bridge where it lives (this Mac's, or
    /// its machine's), or its folder's engine.
    func api(for bot: Bot) -> OpenCodeAPI? {
        bot.agents == true ? app?.workspace.agents(forFolder: bot.directory)?.api : app?.workspace.api(forFolder: bot.directory)
    }

    /// Tells the workspace which sessions are bots' (and which of those run with the agents).
    private func noteSessions() {
        app?.workspace.runsOnAgents(agentSessionIDs)
        if app?.workspace.botSessions != sessionIDs { app?.workspace.botSessions = sessionIDs }
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

    // MARK: What each box says

    /// A box's list (`kuvo/bots`) taken in: its bots as it has them now. One it no longer lists is
    /// gone (deleted there, from a phone say), but for one on its way to another computer, which
    /// stays as it is until its move is done.
    func take(_ listed: [ListedBot], from box: String) {
        let machine = box == BoxClient.mac ? nil : box
        let formatter = ISO8601DateFormatter()
        let made = listed.map { entry -> Bot in
            let before = known.first { $0.id == entry.id }
            let folder = entry.folder ?? before?.folder ?? (machine == nil ? Self.root.appending(path: entry.id).path : "$HOME/\(RemoteEngineInstaller.root)/bots/\(entry.id)")
            var bot = Bot(id: entry.id, name: Self.oneLine(entry.name), job: entry.job ?? "", instructions: entry.jobDetails ?? "", jobInMemory: true, look: entry.look,
                          machine: machine, project: entry.project.map { path in machine.map { RemoteFolder.folder(path, on: $0) } ?? path } ?? (entry.folder == nil ? before?.project : nil),
                          folder: folder, sessionID: entry.session, created: entry.created.flatMap(formatter.date(from:)) ?? before?.created ?? .now,
                          model: entry.model, personality: entry.personality, agents: entry.agents == true ? true : nil, updated: before?.updated)
            if entry.jobDetails == nil, let before { bot.instructions = before.instructions }
            return bot
        }
        let ids = Set(made.map(\.id))
        let gone = known.filter { $0.box == box && !ids.contains($0.id) && !Moves.isFrozen($0.id) }
        // Other computers' as they were, and one moving as it is until its move is done; this box's as
        // it has them now (one it lists that was elsewhere has moved here).
        var next = known.filter { ($0.box != box && !ids.contains($0.id)) || Moves.isFrozen($0.id) }
        for bot in made where !next.contains(where: { $0.id == bot.id }) { next.append(bot) }
        next.sort { $0.created < $1.created }
        guard next != known else { return }
        known = next
        save()
        show()
        for bot in gone { forgetHere(bot) }
    }

    /// One of a box's bots, as it answered a change: taken in at once.
    private func take(one entry: ListedBot, from box: String) {
        var listed = known.filter { $0.box == box }.compactMap { bot -> ListedBot? in
            ListedBot(id: bot.id, session: bot.sessionID, name: bot.name, look: bot.look, job: bot.job, jobDetails: bot.instructions, agents: bot.agents,
                      personality: bot.personality, model: bot.model, folder: bot.folder, project: bot.project.map { RemoteFolder.parse($0)?.path ?? $0 },
                      created: ISO8601DateFormatter().string(from: bot.created))
        }
        listed.removeAll { $0.id == entry.id }
        listed.append(entry)
        take(listed, from: box)
    }

    /// The list as you see it: as the boxes said, with your waiting edits as made.
    private func show() {
        let shown = known.map { edits.applied(to: $0) }
        if shown != list { list = shown }
        noteSessions()
    }

    /// What's here of a bot its box no longer has: its tabs, wake-ups and conversation.
    private func forgetHere(_ bot: Bot) {
        edits.drop(bot.id)
        app?.wakeUps.forget(key: bot.id)
        app?.utilities.closeTabs(of: bot.id)
        app?.workspace.drop(bot.sessionID)
        show()
    }

    /// This Mac's bots as its box keeps them, from now on (`kuvo/bots/events`): one made, changed or
    /// deleted, by an agent, a phone or here, shows as it happens.
    func follow() async {
        struct Line: Decodable { var bots: [ListedBot] }
        while !Task.isCancelled {
            if let app {
                do {
                    for try await data in (client(BoxClient.mac) ?? app.box(BoxClient.mac)).follow("kuvo/bots/events") {
                        guard let line = try? JSONDecoder().decode(Line.self, from: data) else { continue }
                        take(line.bots, from: BoxClient.mac)
                    }
                } catch {}
            }
            // The box started again, or isn't up yet: followed again in a moment.
            try? await Task.sleep(for: .seconds(2))
        }
    }

    /// A box's bots as it has them now (a machine's while it's connected, with what you changed of
    /// them while it was away sent first).
    func refresh(_ box: String) async {
        if box != BoxClient.mac {
            guard canReach(box) else { return }
            await sendWaiting(to: box)
        }
        struct Listed: Decodable { var bots: [ListedBot] }
        guard let client = client(box), let listed = try? await client.value(Listed.self, "GET", "kuvo/bots") else { return }
        take(listed.bots, from: box)
    }

    /// A bot's run ended: on a machine, its box may have changed it meanwhile (its job, kept with
    /// set_job), which is read from there. (This Mac's are followed as they change.)
    func runEnded(session: String) {
        guard let machine = bot(forSession: session)?.machine else { return }
        Task { await refresh(machine) }
    }

    // MARK: Making, changing, deleting

    enum Failure: LocalizedError {
        case notConnected(String)
        case stillOn(String)
        var errorDescription: String? {
            switch self {
            case .notConnected(let machine): "\(machine) isn’t connected. Connect to it, then try again."
            case .stillOn(let machine): "\(machine) isn’t connected, and the bot would keep running there. Connect to it, then delete the bot."
            }
        }
    }

    /// The name you know a machine by.
    private func placeName(_ machine: String?) -> String {
        machine.map { app?.machines.engine($0)?.machine.name ?? $0 } ?? AppInfo.name
    }

    /// The box `machine` (nil: this Mac) keeps its bots on, while it can be asked.
    private func box(_ machine: String?) throws -> BoxClient {
        if let machine, !canReach(machine) { throw Failure.notConnected(placeName(machine)) }
        guard let client = client(machine ?? BoxClient.mac) else { throw CancellationError() }
        return client
    }

    /// A bot made, and what to type in its conversation for you (a template's or a shared bot's job;
    /// nil when it writes first).
    struct Made {
        var bot: Bot
        var firstMessage: String?
    }

    /// Makes a bot where it's to live, as New Bot does: its box makes its folder, its conversation
    /// and what it's told. From a template (`template`) or a shared bot's job (`shared`) it waits,
    /// with that job for your composer; otherwise it writes first.
    func make(name: String, look: BotLook, personality: String? = nil, model: ModelRef?, machine: String?, project: String?,
              template: String? = nil, shared: (line: String, details: String)? = nil) async throws -> Made {
        let client = try box(machine)
        if machine == nil { writeMacKit() }
        struct Body: Encodable {
            var name: String, look: BotLook, personality: String?, model: ModelRef?, project: String?, template: String?
            var job: [String: String]?
        }
        let body = Body(name: Self.oneLine(name), look: look, personality: personality, model: model,
                        project: project.map { RemoteFolder.parse($0)?.path ?? $0 }, template: template,
                        job: shared.map { ["line": $0.line, "details": $0.details] })
        struct Answer: Decodable { var bot: ListedBot; var firstMessage: String? }
        let answer = try await client.value(Answer.self, "POST", "kuvo/bots", body: body)
        take(one: answer.bot, from: client.box)
        guard let bot = bot(answer.bot.id) else { throw CancellationError() }
        // Its conversation, there from the start.
        if let api = api(for: bot), let session = try? await api.session(bot.sessionID) { app?.workspace.add(session) }
        Analytics.shared.track("bot_created", ["machine": machine != nil, "project": project != nil])
        return Made(bot: bot, firstMessage: answer.firstMessage)
    }

    /// Makes a bot as `make` does, with `job` as its job from the start (for the demo copy and
    /// the perf runs).
    func create(name: String, job: (line: String, details: String)? = nil, look: BotLook, personality: String? = nil, model: ModelRef?, machine: String?, project: String?) async throws -> Bot {
        let made = try await make(name: name, look: look, personality: personality, model: model, machine: machine, project: project)
        guard let job else { return made.bot }
        var edited = made.bot
        edited.job = job.line
        edited.instructions = job.details
        try await update(edited, job: true)
        return bot(made.bot.id) ?? made.bot
    }

    static let greeting = """
        <system-reminder>
        You were just made, and the person who made you hasn't written yet. Write them your first message, as yourself: short, warm, a few sentences at most.
        - If your name says what you're for (like "Social Media Manager" or "Inbox Helper"), say in a sentence what you take your job to be, then ask the one or two things you need to know to start, like which accounts or sites, how often, or in what tone.
        - If it doesn't, say hello and ask what they'd like you to do.
        Don't use any tools, and don't keep a job until they've answered.
        </system-reminder>
        """

    /// What Edit Bot changes (its name, look, model and personality, and its job with `job`), sent to
    /// its box, which tells its conversation and its group chats. One for a computer that's away
    /// waits for it (`BotEdits`), shown as made meanwhile, and goes as soon as it's back. Throws
    /// what its box said no to.
    func update(_ edited: Bot, job: Bool = false) async throws {
        guard let current = known.first(where: { $0.id == edited.id }) else { return }
        // As you see it, with what waits for it.
        let shown = edits.applied(to: current)
        var fields: [String: JSONValue] = [:]
        if edited.name != shown.name { fields["name"] = .string(edited.name) }
        if edited.look != shown.look { fields["look"] = Self.value(edited.look) }
        if edited.personality != shown.personality { fields["personality"] = edited.personality.map(JSONValue.string) ?? .null }
        if edited.model != shown.model, let model = edited.model { fields["model"] = Self.value(model) }
        if job, edited.job != shown.job || edited.instructions != shown.instructions {
            fields["job"] = .object(["line": .string(edited.job), "details": .string(edited.instructions)])
        }
        guard !fields.isEmpty else { return }
        if Moves.isFrozen(edited.id) { throw Moves.Failure.moving }
        if let machine = current.machine, !canReach(machine) {
            edits.put(edited.id, box: current.box, fields: fields)
            show()
            return
        }
        do {
            try await send(fields, to: current)
        } catch let refusal as BoxRefusal {
            throw refusal
        } catch where current.machine != nil {
            // It didn't get there (the connection dropped): it waits for its computer.
            edits.put(edited.id, box: current.box, fields: fields)
            show()
        } catch {
            // This Mac's box not answering (starting again): said, and nothing waits.
            throw BoxRefusal(status: 503, message: "Kuvo Code’s background service on this Mac isn’t answering. Try again in a moment.")
        }
    }

    /// `fields` changed on `bot`'s box (`PATCH kuvo/bots/<id>`), and what it answered taken in.
    private func send(_ fields: [String: JSONValue], to bot: Bot) async throws {
        guard let client = client(bot.box) else { return }
        struct Answer: Decodable { var bot: ListedBot }
        let path = "kuvo/bots/" + (bot.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? bot.id)
        let answer = try await client.value(Answer.self, "PATCH", path, body: JSONValue.object(fields))
        let before = self.bot(bot.id)
        take(one: answer.bot, from: bot.box)
        // A conversation carried on with the coding agents: the new one, in the old one's place.
        if let before, before.sessionID != answer.bot.session, let now = self.bot(bot.id) { await carried(from: before.sessionID, to: now) }
    }

    /// Edits that waited for `box`'s computer, sent now it's back: one at a time, its box's answer
    /// then what shows. One its box says no to (a name it won't take, a bot that's gone) is let go.
    func sendWaiting(to box: String) async {
        for (id, edit) in edits.waiting where edit.box == box {
            if Moves.isFrozen(id) { continue }
            do {
                if edit.delete {
                    // One deleted while its machine was removed: it's gone from the list already.
                    guard let client = client(box) else { continue }
                    let (status, data) = try await client.send("DELETE", "kuvo/bots/" + (id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id))
                    guard (200..<300).contains(status) || status == 404 else { throw BoxRefusal(status: status, data: data) }
                } else {
                    guard let bot = known.first(where: { $0.id == id }) else {
                        edits.drop(id)
                        continue
                    }
                    try await send(edit.fields, to: bot)
                }
                edits.drop(id)
            } catch let refusal as BoxRefusal where refusal.status != 409 && refusal.status < 500 {
                log.error("A waiting edit to a bot was turned down: \(refusal.message, privacy: .public)")
                edits.drop(id)
            } catch {
                // Still not there: it waits on.
            }
        }
        show()
    }

    /// A bot's conversation that its box carried on with the coding agents (a model of theirs): the
    /// new one takes the old one's place here, its tab, its draft, and the old one goes.
    private func carried(from old: String, to bot: Bot) async {
        guard let app else { return }
        if let api = api(for: bot), let session = try? await api.session(bot.sessionID) { app.workspace.add(session) }
        Drafts.shared[bot.sessionID] = Drafts.shared[old]
        _ = app.tabs.swap(from: old, to: bot.sessionID)
        app.workspace.drop(old)
        noteSessions()
    }

    /// A bot's conversation carried on with the coding agents on `model` (a model of theirs, or
    /// Custom Auto), as picking it in its conversation does: its box carries it, as Edit Bot's
    /// model does. Nil for a conversation that isn't a bot's.
    func moveToAgents(session: String, model: ModelRef) async throws -> Session? {
        guard let bot = bot(forSession: session) else { return nil }
        if bot.agents == true { return app?.workspace.session(bot.sessionID) }
        try await send(["model": Self.value(model)], to: bot)
        guard let now = self.bot(bot.id), now.sessionID != session else { return nil }
        return app?.workspace.session(now.sessionID)
    }

    /// Deletes a bot as Delete Bot… does: its box deletes its conversation, wake-ups and keys, and
    /// its folder goes to the Trash (on a machine, Kuvo Code's trash folder there), with what it made
    /// in it. A project it worked in stays. A machine's bot goes only once it's gone there, so while
    /// that machine can't be reached it stays, and this says so. One whose machine you removed from
    /// Kuvo Code leaves the list, and goes there the next time that machine answers.
    func delete(_ bot: Bot) async throws {
        if Moves.isFrozen(bot.id) { throw Moves.Failure.moving }
        if let machine = bot.machine {
            guard reachable != nil || app?.machines.engine(machine) != nil else {
                // A machine you removed: it goes there if you add it again.
                edits.put(bot.id, box: bot.box, delete: true)
                known.removeAll { $0.id == bot.id }
                save()
                forgetHere(bot)
                return
            }
            guard canReach(machine) else { throw Failure.stillOn(placeName(machine)) }
        }
        try await deleteOnBox(bot)
        Analytics.shared.track("bot_deleted")
    }

    private func deleteOnBox(_ bot: Bot) async throws {
        guard let client = client(bot.box) else { return }
        let path = "kuvo/bots/" + (bot.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? bot.id)
        let (status, data) = try await client.send("DELETE", path)
        guard (200..<300).contains(status) || status == 404 else { throw BoxRefusal(status: status, data: data) }
        known.removeAll { $0.id == bot.id }
        save()
        forgetHere(bot)
    }

    /// A bot on this Mac keeping its job with its set_job tool (`BrowserTools.job`): its box keeps it,
    /// and tells it. What it answers is what the bot hears.
    func setJob(_ arguments: [String: Any], caller: String?) async -> (text: String, isError: Bool) {
        guard let shown = bot(forSession: caller), let bot = known.first(where: { $0.id == shown.id }) else {
            return ("Only a bot keeps a job, and this conversation isn't one.", true)
        }
        let job: JSONValue = .object(["line": .string(arguments["summary"] as? String ?? ""), "details": .string(arguments["details"] as? String ?? "")])
        do {
            try await send(["job": job], to: bot)
        } catch {
            return ("Couldn't keep it: \(error.localizedDescription)", true)
        }
        let line = self.bot(bot.id)?.job ?? ""
        return (line.isEmpty ? "Kept: you have no job now." : "Kept. Kuvo Code shows \"\(line)\" under your name.", false)
    }

    /// Your personalities changed: this Mac's box tells its bots with them what they are now, at
    /// their next run (each machine's has your personalities too).
    func personalitiesChanged() {
        writeMacKit()
    }

    // MARK: Moving (until moves go through the boxes)

    /// A bot that moved to another computer (`Moves`): it lives on `machine` (nil: this Mac) from
    /// now on, in `folder`, with its conversation carried there (`session`, the same ID, on `api`).
    /// Its session there gets its rules for its folder there, and what it's told there; its folder,
    /// what kuvo-wake reads there.
    func moved(_ id: String, to machine: String?, folder: String, session: Session, api: OpenCodeAPI) async {
        guard let index = known.firstIndex(where: { $0.id == id }) else { return }
        let old = known[index]
        var bot = old
        bot.machine = machine
        bot.folder = folder
        known[index] = bot
        save()
        show()
        app?.workspace.add(session)
        let rules = (session.permissions ?? []).filter { !Self.isOwnRule($0, of: old) && !Self.isOwnRule($0, of: bot) }
        _ = try? await api.setPermissions(session: bot.sessionID, rules: ToolApproval.refreshed(rules, settings: EngineConfig.rules(on: bot.machine)) + Self.ownRules(for: bot))
        _ = try? await api.setInstruction(session: bot.sessionID, key: Self.instructionKey, text: Self.instructions(for: bot))
        try? await writeSession(of: bot)
        if let machine, let engine = app?.machines.engine(machine) { try? await Wakes.install(on: engine.machine.connection) }
        if let machine { await refresh(machine) }
    }

    /// Writes the bot's session in its folder, and the folder it works in, where `kuvo-wake fire`
    /// reads them; on a machine, your time zone, which its wake-ups' times are in.
    private func writeSession(of bot: Bot) async throws {
        let file = (bot.folder as NSString).appendingPathComponent("session")
        let via = (bot.folder as NSString).appendingPathComponent("via")
        if let machine = bot.machine {
            let directory = (bot.folder as NSString).appendingPathComponent("directory")
            let timezone = (bot.folder as NSString).appendingPathComponent("timezone")
            let path = RemoteFolder.parse(bot.directory)?.path ?? bot.directory
            var script = "printf '%s' \(SSHConnection.quoted(bot.sessionID)) >\(SSHConnection.quoted(file)) && printf '%s' \(SSHConnection.quoted(path)) >\(SSHConnection.quoted(directory)) && printf '%s' \(SSHConnection.quoted(TimeZone.current.identifier)) >\(SSHConnection.quoted(timezone))"
            script += bot.agents == true ? " && printf bridge >\(SSHConnection.quoted(via))" : " && rm -f \(SSHConnection.quoted(via))"
            // What its box lists it by, for one that came without it.
            if let data = Self.descriptorData(bot) {
                let described = SSHConnection.quoted((bot.folder as NSString).appendingPathComponent(Bot.Descriptor.file))
                script += " && { [ -f \(described) ] || printf '%s' \(SSHConnection.quoted(data.base64EncodedString())) | base64 -d >\(described); }"
            }
            if let rules = WakeUps.zoneRules(TimeZone.current.identifier) {
                let zoneFile = (bot.folder as NSString).appendingPathComponent("zoneinfo")
                script += " && { printf '%s' \(SSHConnection.quoted(rules.base64EncodedString())) | base64 -d >\(SSHConnection.quoted(zoneFile)) 2>/dev/null || rm -f \(SSHConnection.quoted(zoneFile)); }"
            }
            guard await Task.detached(operation: { RemoteShell.run(script, on: machine) }).value != nil else { throw CancellationError() }
        } else {
            try Data(bot.sessionID.utf8).write(to: URL(filePath: file))
            try Data(bot.directory.utf8).write(to: URL(filePath: (bot.folder as NSString).appendingPathComponent("directory")))
            // What its box lists it by, for one that came without it.
            let described = URL(filePath: bot.folder).appending(path: Bot.Descriptor.file)
            if !FileManager.default.fileExists(atPath: described.path), let data = Self.descriptorData(bot) { try data.write(to: described, options: .atomic) }
            // This Mac's go by its own clock.
            for name in ["timezone", "zoneinfo"] { try? FileManager.default.removeItem(atPath: (bot.folder as NSString).appendingPathComponent(name)) }
            if bot.agents == true { try Data("bridge".utf8).write(to: URL(filePath: via)) } else { try? FileManager.default.removeItem(atPath: via) }
        }
    }

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

    // MARK: Words

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
    /// `personality`: what its personality tells it, when not its own (a kit, see `MachineKit`, has
    /// a stand-in there). The words a box fills in for each of its bots, from its kit.
    static func instructions(for bot: Bot, personality: String? = nil, timeZone: String = TimeZone.current.identifier) -> String {
        let place = bot.machine.map { "the Linux machine \"\($0)\"" } ?? "this Mac"
        let job = bot.instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        let told = personality ?? Personalities.shared.personality(bot.personality)?.instruction
        let keeping = """
            Your job is what the user gives you in this conversation, and it changes as they tell you more. Keep it with \
            set_job: what you do in a few words, like "Keeps the build green" (Kuvo Code shows it under your name), and the \
            details: what to watch, what to make, what never to do without asking. When the user gives you a job or changes it, \
            call set_job before anything else, with the whole job as it is now.
            """
        return """
        You are \(bot.name), one of the user's bots in Kuvo Code\(bot.job.isEmpty ? "" : ": \(bot.job)"). A bot is a teammate with one job, \
        who keeps working on it over time in this one conversation. You run on \(place).
        \(told.map { "\n\($0)\n" } ?? "")
        \(keeping)

        \(job.isEmpty ? "You don't have a job yet: ask the user what they'd like you to do, if they haven't said." : "Your job:\n\(job)")

        You can work on a schedule. Kuvo Code wakes you up at the times you choose, even while the user is away, so you can do \
        things later ("in 2 hours", "tomorrow at 9") or again and again ("every 5 minutes", "every morning"). Never say you can't \
        run in the background, on a timer or on a schedule: schedule a wake-up instead.

        To schedule a wake-up, use schedule_wake_up: <when> is +5m, +2h, +1d, or a time like 2026-10-16T09:00 \
        \(bot.machine == nil ? "on this Mac's clock" : "in the user's time zone, \(timeZone)"), at least a minute from now. At \
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
        account for. Your job is yours to keep, as the user gives it to you.
        """

    // MARK: From earlier versions

    /// For an update from a version before bots had descriptions: each of this Mac's bots gets its
    /// description beside its memory (`bot.json`), from the app's list, so its box finds it. One
    /// that has one keeps it; one whose folder has gone gets none.
    func describeOld() {
        for bot in known where bot.machine == nil {
            var isFolder: ObjCBool = false
            let file = URL(filePath: bot.folder).appending(path: Bot.Descriptor.file)
            guard FileManager.default.fileExists(atPath: bot.folder, isDirectory: &isFolder), isFolder.boolValue,
                  !FileManager.default.fileExists(atPath: file.path), let data = Self.descriptorData(bot) else { continue }
            do {
                try data.write(to: file, options: .atomic)
            } catch {
                log.error("A bot's description wasn't written: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// For an update from a version that kept what you changed of a machine's bots while it was
    /// away in its own list, still to tell the machine (`botEditsWaiting`): each such bot's edit
    /// waits for its machine, as the list has it.
    func takeOldWaitingEdits() {
        let old = UserDefaults.standard.dictionary(forKey: "botEditsWaiting") as? [String: [String]] ?? [:]
        for id in old.keys {
            guard let bot = known.first(where: { $0.id == id }), bot.machine != nil, edits.waiting[id] == nil else { continue }
            var fields: [String: JSONValue] = ["name": .string(bot.name), "look": Self.value(bot.look), "personality": bot.personality.map(JSONValue.string) ?? .null]
            if let model = bot.model { fields["model"] = Self.value(model) }
            edits.put(id, box: bot.box, fields: fields)
        }
        show()
    }

    /// A bot's description, as `bot.json` has it.
    static func descriptorData(_ bot: Bot) -> Data? {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try? encoder.encode(bot.descriptor)
    }

    // MARK: Storage

    private static func load() -> [Bot] {
        JSONFile.read([Bot].self, from: file, isoDates: true) ?? []
    }

    /// What the boxes said, kept for while they're away, as an earlier version reads it.
    private func save() {
        JSONFile.write(known, to: Self.file, isoDates: true, readable: true)
    }

    /// A machine found to be another one here at another address (see `Machines.fold`): its bots
    /// live on the other, as they did all along.
    func fold(_ machine: String, into other: String) {
        var changed = false
        for index in known.indices where known[index].machine == machine {
            known[index].machine = other
            if let project = known[index].project, let parsed = RemoteFolder.parse(project), parsed.machine == machine {
                known[index].project = RemoteFolder.folder(parsed.path, on: other)
            }
            changed = true
        }
        edits.fold(machine, into: other)
        if changed {
            save()
            show()
        }
    }

    private static func value(_ value: some Encodable) -> JSONValue {
        (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))) ?? .null
    }
}

// MARK: - What a box makes bots with

/// What a box makes its bots with and tells them (its kit): this Mac's box from this app, a machine's
/// as this Mac connects to it, or from its own release.
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
        /// The Kuvo Code it's from: a box takes the newer of a Mac's and its own release's words.
        var version = AppInfo.version
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

    /// The kit for `machine`'s box, or this Mac's (nil).
    func kit(for machine: String?) -> MachineKit {
        var kit = Self.kitWords(machine: machine, timeZone: TimeZone.current.identifier)
        let approval = UserDefaults.standard.string(forKey: ToolApproval.key).flatMap(ToolApproval.init) ?? .approveAll
        kit.personalities = Personalities.shared.all.map { .init(id: $0.id, name: $0.name, description: $0.description, custom: $0.isCustom, instruction: $0.instruction) }
        let catalog = machine.flatMap { app?.machines.engine($0)?.catalog } ?? (machine == nil ? app?.catalog : nil)
        kit.startingModel = catalog?.startingModel(LastModel.current, scope: .on(machine: machine))
        kit.projects = (app?.workspace.projects ?? []).filter { RemoteFolder.machine(of: $0.directory) == machine }
            .map { .init(directory: RemoteFolder.parse($0.directory)?.path ?? $0.directory, name: $0.name) }
        kit.rules = approval.rules(settings: EngineConfig.rules(on: machine))
        // (This Mac's bots go by its own clock.)
        if machine != nil { kit.zoneinfo = WakeUps.zoneRules(TimeZone.current.identifier)?.base64EncodedString() }
        return kit
    }

    /// The kit as a release for boxes has it (`BoxRelease`): its words, with ⟦machine⟧ and
    /// ⟦timeZone⟧ for the box to fill in, and none of what's a machine's own (its starting model,
    /// projects and rules): a box that updated itself makes bots with this version's words, and
    /// one no Mac gave a kit to can make them at all.
    static func releaseKit() -> MachineKit {
        kitWords(machine: "⟦machine⟧", timeZone: "⟦timeZone⟧")
    }

    /// The kit as this Mac's box makes its own bots with it: the words for a bot on this Mac, and
    /// none of what's this Mac's own (its starting model, projects, rules and time zone).
    static func macKitWords() -> MachineKit {
        kitWords(machine: nil, timeZone: "UTC")
    }

    /// What every machine's kit has alike, for `machine` (nil: this Mac), in `timeZone`; the preset
    /// personalities.
    private static func kitWords(machine: String?, timeZone: String) -> MachineKit {
        let sample = Bot(id: "bot_sample", name: "⟦name⟧", job: "", instructions: "", look: .random(), machine: machine, project: nil,
                         folder: "⟦folder⟧", sessionID: "", created: .now)
        var working = sample
        working.job = "⟦job⟧"
        working.instructions = "⟦jobDetails⟧"
        return MachineKit(
            templates: BotTemplate.all.map { .init(id: $0.id, name: $0.name, job: $0.job, instructions: $0.instructions, look: $0.look, personality: $0.personality,
                                                   wantsProject: $0.wantsProject, firstMessage: BotTemplate.firstMessage(job: $0.job, instructions: $0.instructions)) },
            personalities: Personalities.presets.map { .init(id: $0.id, name: $0.name, description: $0.description, custom: false, instruction: $0.instruction) },
            looks: .init(colors: BotLook.Tint.allCases.map(\.rawValue), shapes: BotLook.Form.allCases.map(\.rawValue), faces: BotLook.Face.allCases.map(\.rawValue)),
            startingModel: nil, projects: [],
            instructions: instructions(for: sample, personality: "⟦personality⟧", timeZone: timeZone),
            jobInstructions: instructions(for: working, personality: "⟦personality⟧", timeZone: timeZone),
            projectNote: projectNote, identityNote: identityNote, memory: blankMemory("⟦name⟧"), greeting: greeting,
            rules: [], timeZone: timeZone, zoneinfo: nil)
    }

    /// Gives this Mac's box its kit, in its bots' folder (`KUVO_BOTS/kit.json`), as it starts and as
    /// what's this Mac's own in it changes (your personalities, the model a bot starts on): what it
    /// makes and tells this Mac's bots with.
    func writeMacKit() {
        guard let data = try? JSONEncoder().encode(kit(for: nil)) else { return }
        do {
            try FileManager.default.createDirectory(at: Self.root, withIntermediateDirectories: true)
            let file = Self.root.appending(path: "kit.json")
            if (try? Data(contentsOf: file)) != data { try data.write(to: file, options: .atomic) }
        } catch {
            log.error("This Mac's bot kit wasn't written: \(error.localizedDescription, privacy: .public)")
        }
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

}
