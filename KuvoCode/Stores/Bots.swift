import AppKit
import ClientDesign
import ClientSessions
import KuvoLink
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
    /// Left out now (its job is its box's): an earlier version, going back to one, takes the job as
    /// written here (it moves it into the bot's memory, where it reads jobs) rather than reading an
    /// older one from its memory.
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
    /// The limits you set on the sessions it runs (Edit Bot › Work), as its box keeps them; nil for
    /// none, and from a box from before bots ran sessions.
    var limits: WorkLimits?
    /// What you allowed it to do without asking ("Always"), as its box keeps it.
    var allowed: WorkActions?

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
    /// The limits you set on its work; nil for none.
    var limits: WorkLimits?
    /// What you allowed it to do without asking; nil for nothing.
    var allowed: WorkActions?
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
    /// How long a machine's bots wait before they're followed (again), over its connection: as it
    /// connects they've just been read. A test's follow at once.
    @ObservationIgnored var machineFollowPause: Duration = .seconds(30)
    /// Reads of each box's bots under way, and the bots made, changed or deleted here meanwhile,
    /// which the read (from before) doesn't take back.
    @ObservationIgnored private var listing: [String: Int] = [:]
    @ObservationIgnored private var touchedWhileListing: [String: Set<String>] = [:]
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

    /// A session the bot oversees is at work (its own conversation may be still), unless its
    /// wake-ups are paused: what its face shows, worked out as the phone does (`AtWork`).
    func isOverseeingWork(_ bot: Bot, in workspace: Workspace) -> Bool {
        AtWork.isOverseeingWork(bot.id, paused: paused.contains(bot.id), in: workspace.sessions, isWorking: workspace.isWorking)
    }

    /// What its row says meanwhile, as the bar over its composer and the phone say it: "3 sessions
    /// at work", counting those waiting on you as the bar does.
    func workLine(_ bot: Bot, in workspace: Workspace) -> String? {
        AtWork.workLine(of: bot.id, paused: paused.contains(bot.id), in: workspace.sessions, isWorking: workspace.isWorking, isAsking: workspace.needsAttention)
    }

    /// What the bot is up to, for how its avatar moves: waiting for you comes first, then working
    /// (in its own conversation, or in the sessions it oversees), then news you haven't seen, then
    /// asleep until a wake-up.
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
        if workspace.isWorking(bot.sessionID) || isOverseeingWork(bot, in: workspace) { return .working }
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
            var bot = Bot(id: entry.id, name: Self.oneLine(entry.name), job: entry.job ?? "", instructions: entry.jobDetails ?? "", jobInMemory: nil, look: entry.look,
                          machine: machine, project: entry.project.map { path in machine.map { RemoteFolder.folder(path, on: $0) } ?? path } ?? (entry.folder == nil ? before?.project : nil),
                          folder: folder, sessionID: entry.session, created: entry.created.flatMap(formatter.date(from:)) ?? before?.created ?? .now,
                          model: entry.model, personality: entry.personality, agents: entry.agents == true ? true : nil, updated: before?.updated, limits: entry.limits, allowed: entry.allowed)
            if entry.jobDetails == nil, let before { bot.instructions = before.instructions }
            return bot
        }
        let ids = Set(made.map(\.id))
        // One of this Mac's whose folder is still here, though its box doesn't list it (its
        // description unreadable, say), stays: it isn't gone, and what's here of it stays with it.
        let kept = { (bot: Bot) in Moves.isFrozen(bot.id) || (box == BoxClient.mac && bot.machine == nil && FileManager.default.fileExists(atPath: bot.folder)) }
        let gone = known.filter { $0.box == box && !ids.contains($0.id) && !kept($0) }
        // Other computers' as they were, and one moving as it is until its move is done; this box's as
        // it has them now (one it lists that was elsewhere has moved here, its move over).
        var next = known.filter { ($0.box != box && !ids.contains($0.id)) || (!ids.contains($0.id) && kept($0)) || (Moves.isFrozen($0.id) && Moves.arriving[$0.id] != box) }
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
        touchedWhileListing[box]?.insert(entry.id)
        var listed = known.filter { $0.box == box }.map(Self.listed)
        listed.removeAll { $0.id == entry.id }
        listed.append(entry)
        take(listed, from: box)
    }

    /// A bot as its box lists it.
    private static func listed(_ bot: Bot) -> ListedBot {
        ListedBot(id: bot.id, session: bot.sessionID, name: bot.name, look: bot.look, job: bot.job, jobDetails: bot.instructions, agents: bot.agents,
                  personality: bot.personality, model: bot.model, folder: bot.folder, project: bot.project.map { RemoteFolder.parse($0)?.path ?? $0 },
                  created: ISO8601DateFormatter().string(from: bot.created), limits: bot.limits, allowed: bot.allowed)
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
        app?.botWork.forget(bot.id)
        app?.utilities.closeTabs(of: bot.id)
        // (Only its row there: one where it lives now, if it moved, stays.)
        app?.workspace.drop(bot.sessionID, on: .some(bot.machine))
        show()
    }

    /// A box's bots as it keeps them, from now on (`kuvo/bots/events`): one made, changed or deleted,
    /// by an agent, a phone or here, shows as it happens. This Mac's always; a machine's while it's
    /// connected (its connection ends this).
    func follow(_ box: String = BoxClient.thisMac) async {
        struct Line: Decodable { var bots: [ListedBot] }
        // (Followed as it changes on the app's own box, which streams; read now and then on any
        // other, the one attached in place too, which answers once a read.)
        let onThisMac = BoxClient.streams(box)
        // (A machine's box from before it had them: asked again only now and then.)
        var older = false
        while !Task.isCancelled {
            if !onThisMac {
                try? await Task.sleep(for: older ? .seconds(300) : machineFollowPause)
                // Not while it's away or starting over: nothing goes to it then.
                guard !Task.isCancelled, canReach(box) else { continue }
            }
            older = false
            // The app gone (a test's): nothing more to follow for it.
            guard let app else { return }
            if let client = onThisMac ? client(box) ?? app.box(box) : client(box) {
                do {
                    for try await data in client.follow("kuvo/bots/events") {
                        guard let line = try? JSONDecoder().decode(Line.self, from: data) else { continue }
                        take(line.bots, from: box)
                    }
                } catch let refusal as BoxRefusal {
                    older = !onThisMac && (refusal.status == 404 || refusal.status == 403)
                } catch {}
            }
            // The box started again, or isn't up yet: followed again in a moment.
            if onThisMac { try? await Task.sleep(for: .seconds(2)) }
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
        if listing[box, default: 0] == 0 { touchedWhileListing[box] = [] }
        listing[box, default: 0] += 1
        defer {
            listing[box, default: 1] -= 1
            if listing[box] == 0 { listing[box] = nil; touchedWhileListing[box] = nil }
        }
        guard let client = client(box), let listed = try? await client.value(Listed.self, "GET", "kuvo/bots") else { return }
        // One changed here meanwhile as it is here (made, as made; deleted, gone).
        let touched = touchedWhileListing[box] ?? []
        take(listed.bots.filter { !touched.contains($0.id) } + known.filter { $0.box == box && touched.contains($0.id) }.map(Self.listed), from: box)
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
        guard let client = client(machine ?? BoxClient.thisMac) else { throw CancellationError() }
        return client
    }

    /// One New Bot, as its sheet keeps it: its own id, sent each time Create is clicked, so its box
    /// makes one bot however often it's sent (an answer lost on the way back, and Create clicked
    /// again). Another sheet is another New Bot.
    struct NewBotRequest {
        let id = "req_" + UUID().uuidString

        @MainActor
        func make(with bots: Bots, name: String, look: BotLook, personality: String? = nil, model: ModelRef?, machine: String?, project: String?,
                  template: String? = nil, shared: (line: String, details: String)? = nil) async throws -> Made {
            try await bots.make(name: name, look: look, personality: personality, model: model, machine: machine, project: project,
                                template: template, shared: shared, request: id)
        }
    }

    /// A bot made, and what to type in its conversation for you (a template's or a shared bot's job;
    /// nil when it writes first).
    struct Made {
        var bot: Bot
        var firstMessage: String?
    }

    /// Makes a bot where it's to live, as New Bot does: its box makes its folder, its conversation
    /// and what it's told. From a template (`template`) or a shared bot's job (`shared`) it waits,
    /// with that job for your composer; otherwise it writes first. `request`: New Bot's own id,
    /// the same each time it's tried, so its box makes one bot however often it's sent.
    func make(name: String, look: BotLook, personality: String? = nil, model: ModelRef?, machine: String?, project: String?,
              template: String? = nil, shared: (line: String, details: String)? = nil, request: String? = nil) async throws -> Made {
        let client = try box(machine)
        if machine == nil { writeMacKit() }
        struct Body: Encodable {
            var name: String, look: BotLook, personality: String?, model: ModelRef?, project: String?, template: String?
            var job: [String: String]?
            var request: String?
        }
        let body = Body(name: Self.oneLine(name), look: look, personality: personality, model: model,
                        project: project.map { RemoteFolder.parse($0)?.path ?? $0 }, template: template,
                        job: shared.map { ["line": $0.line, "details": $0.details] }, request: request)
        struct Answer: Decodable { var bot: ListedBot; var firstMessage: String? }
        let answer = try await client.value(Answer.self, "POST", "kuvo/bots", body: body)
        take(one: answer.bot, from: client.box)
        guard let bot = bot(answer.bot.id) else { throw CancellationError() }
        // Its conversation, there from the start.
        if let api = api(for: bot), let session = try? await api.session(bot.sessionID) { app?.workspace.add(session) }
        Analytics.shared.track("bot_created", ["machine": BoxClient.isMachine(machine), "project": project != nil])
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
        // What waited for it goes with this, yours of now on top: nothing older goes after it.
        let waiting = edits.waiting[edited.id]
        if let waiting, !waiting.delete { fields = waiting.fields.merging(fields) { _, new in new } }
        do {
            try await send(fields, to: current)
            if let waiting, edits.waiting[edited.id] == waiting { edits.drop(edited.id) }
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
        guard let client = client(bot.box) else { throw BoxRefusal(status: 503, data: Data()) }
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
                    // As it waits now: one saved directly meanwhile went already.
                    guard edits.waiting[id] == edit else { continue }
                    try await send(edit.fields, to: bot)
                }
                if edits.waiting[id] == edit { edits.drop(id) }
            } catch let refusal as BoxRefusal where refusal.status != 409 && refusal.status < 500 {
                log.error("A waiting edit to a bot was turned down: \(refusal.message, privacy: .public)")
                if edits.waiting[id] == edit { edits.drop(id) }
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
        touchedWhileListing[bot.box]?.insert(bot.id)
        known.removeAll { $0.id == bot.id }
        save()
        forgetHere(bot)
    }

    /// Your personalities changed: this Mac's box tells its bots with them what they are now, at
    /// their next run (each machine's has your personalities too).
    func personalitiesChanged() {
        writeMacKit()
        // Told at once, as before, rather than at their next run.
        guard let client = client(BoxClient.thisMac) else { return }
        Task { _ = try? await client.send("POST", "kuvo/bots/retell") }
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

    /// Whether a path is a bot's memory file.
    static func isMemory(_ path: String) -> Bool {
        path.hasSuffix("/MEMORY.md") && path.contains("/bots/bot_")
    }

    // MARK: From earlier versions

    /// For an update from a version before bots had descriptions, and as this Mac's box starts keeping
    /// them: each of this Mac's bots has its description (`bot.json`) and its conversation (`session`)
    /// beside its memory, from the app's list, so its box finds it. A readable one is kept; one
    /// whose folder has gone gets none.
    func describeOld() {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        for bot in known where bot.machine == nil {
            var isFolder: ObjCBool = false
            guard FileManager.default.fileExists(atPath: bot.folder, isDirectory: &isFolder), isFolder.boolValue else { continue }
            let folder = URL(filePath: bot.folder)
            let file = folder.appending(path: Bot.Descriptor.file)
            // One its box couldn't read (an earlier version could leave it half written) is written
            // again, as the app's list has the bot.
            let readable = (try? Data(contentsOf: file)).flatMap { try? decoder.decode(Bot.Descriptor.self, from: $0) }
            do {
                if readable?.id != bot.id || readable?.kuvo != Bot.Descriptor.version, let data = Self.descriptorData(bot) { try data.write(to: file, options: .atomic) }
                // Its conversation, which its box finds it by.
                let session = folder.appending(path: "session")
                if (try? String(contentsOf: session, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) != bot.sessionID {
                    try Data(bot.sessionID.utf8).write(to: session, options: .atomic)
                }
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

/// What's a computer's own that a box makes its bots with (its kit): this Mac's box's from this app,
/// a machine's as this Mac connects to it. The words are the box's own (`BotWords`).
extension Bots {
    /// What's a computer's own for its bots, kept in its bots' folder (`kit.json`): the name this
    /// Mac calls a machine (⟦machine⟧ in what its bots are told), the personalities you made, the
    /// projects there and the model a bot starts on, and your time zone. (A new bot's rules its box
    /// makes from its own default and Settings › Permissions.)
    struct MachineKit: Encodable {
        struct Personality: Encodable { var id: String, name: String, description: String, custom = true, instruction: String }
        struct Project: Encodable { var directory: String, name: String }
        var kuvo = 1
        var machine: String?
        var personalities: [Personality]
        var startingModel: ModelRef?
        var projects: [Project]
        var timeZone: String
        /// Its time zone's rules, for a machine without zone files of its own.
        var zoneinfo: String?
    }

    /// The kit for `machine`'s box, or this Mac's (nil).
    func kit(for machine: String?) -> MachineKit {
        let catalog = machine.flatMap { app?.machines.engine($0)?.catalog } ?? (machine == nil ? app?.catalog : nil)
        return MachineKit(
            machine: machine,
            personalities: Personalities.shared.all.filter(\.isCustom).map { .init(id: $0.id, name: $0.name, description: $0.description, instruction: $0.instruction) },
            startingModel: catalog?.startingModel(LastModel.current, scope: .on(machine: machine)),
            projects: (app?.workspace.projects ?? []).filter { RemoteFolder.machine(of: $0.directory) == machine }
                .map { .init(directory: RemoteFolder.parse($0.directory)?.path ?? $0.directory, name: $0.name) },
            timeZone: TimeZone.current.identifier,
            // (This Mac's bots go by its own clock.)
            zoneinfo: machine == nil ? nil : WakeUps.zoneRules(TimeZone.current.identifier)?.base64EncodedString())
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
