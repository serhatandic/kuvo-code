import Foundation
import OpenCodeKit
import os

/// Moving a bot or a chat to another computer: this Mac, or one of your machines, say a new one
/// you've set up. It goes whole (a bot with its memory, workspace, wake-ups and watches; a chat
/// with its wake-ups), with its conversation and its subagents', which carry on there under the
/// same IDs.
///
/// While it moves, nothing goes to it (`isFrozen`): what you send stays in the composer, agents'
/// messages wait (`Deliveries`), its wake-ups are held. Its conversation is copied once it's
/// settled, and read again right before it switches: what reached it meanwhile (a wake-up on its
/// way) goes along.
/// Nothing of the original is touched until the copy is set up where it's going. Then the app
/// switches to the copy, and the original goes: its conversation from its engine, its folder to
/// the trash where it was (the Mac's Trash, or Kuvo Code's trash folder on its machine), with
/// its conversation saved in it as `conversation.json`. A move is noted as it goes (`Record`), so
/// one cut short (the app quit, a machine away) is taken back, or finished once it had switched,
/// the next time both computers are there (`recover`).
@MainActor @Observable
final class Moves {
    /// What's moving now, a bot's ID or a chat's session ID, and where to (nil: this Mac): its
    /// row says so.
    private(set) var underWay: [String: String?] = [:]
    @ObservationIgnored weak var app: AppModel?
    /// How files get where they're going: over SSH, or (in tests) a folder standing in for a machine.
    @ObservationIgnored var transport: any MoveTransport = SSHMoveTransport()
    private let log = Logger(subsystem: "run.kuvo.code", category: "moves")

    /// Conversations moving now (a bot's, a chat's, their subagents') and the bots moving: nothing
    /// goes to them until they're where they're going; what waited goes then (`Deliveries`).
    private(set) static var frozen: Set<String> = [] {
        didSet { Deliveries.movesChanged() }
    }
    /// A bot whose move was cut short after it switched, before the bot itself went over to its
    /// copy: nothing goes to it where it was (it would be lost with the original) until it's there.
    private(set) static var pending: Set<String> = []

    static func isFrozen(_ id: String) -> Bool { frozen.contains(id) || pending.contains(id) }
    /// In a move under way now (not one cut short): one that ends by itself.
    static func isUnderWay(_ id: String) -> Bool { frozen.contains(id) }

    /// What a move writes in a folder's pause file while it holds the wake-ups there: only a move
    /// takes it away (`MoveTransport.unpause`), never a pause of yours.
    static let hold = "moving"

    enum Failure: LocalizedError {
        case notConnected(String)
        case working(String)
        case inProject(String)
        case withAgents(String)
        case waiting(String)
        case busy(String)
        case unfinished(String)
        case sameComputer
        /// A bot in a group chat that lives with its bots on its machine.
        case inMachineGroup(name: String, chat: String, machine: String)
        /// A group chat whose bots don't all live where it would go, or whose work is under way.
        case botsElsewhere(chat: String)
        case workUnderWay(chat: String)
        /// A machine whose engine started before it could run group chats.
        case notYet(machine: String)
        /// Something sent to one that's moving.
        case moving
        var errorDescription: String? {
            switch self {
            case .notConnected(let place): "\(place) isn’t connected. Connect to it, then try again."
            case .working(let name): "\(name) is working. Move it once it’s done."
            case .inProject(let name): "\(name) works in one of your projects, which stays where it is. Only a bot with a folder of its own can move."
            case .withAgents(let name): "\(name) talks with a coding agent, which keeps its conversation on this computer, so it can’t move yet."
            case .waiting(let name): "\(name) still has messages on their way. Try again in a moment."
            case .busy(let name): "\(name) kept getting messages while it moved, so it stayed where it is. Try again in a moment."
            case .unfinished(let name): "\(name)’s last move isn’t finished yet. It finishes once both computers are connected; try again then."
            case .sameComputer: "That’s the computer it’s on now, at another address."
            case .botsElsewhere(let chat): "\(chat)’s bots live on different computers, so it stays on this Mac."
            case .workUnderWay(let chat): "\(chat) has work under way. Move it once its parts are done."
            case .notYet(let machine): "\(machine) can take group chats once its engine starts over, when nothing runs there. Try again then."
            case .inMachineGroup(let name, let chat, let machine): "\(name) is in “\(chat)”, which lives on \(machine) with its bots. Move the chat to this Mac first, or take \(name) out of it."
            case .moving: "It’s moving to another computer. Try again once it’s there."
            }
        }
    }

    /// A move as it goes, kept in the app's settings until it's done.
    struct Record: Codable, Equatable {
        enum Kind: String, Codable { case bot, chat, group }
        /// Copying, with the original as it was: taken back if cut short. Switched: the app goes
        /// by the copy; the original is to go.
        enum Stage: String, Codable { case copying, switched }
        var kind: Kind
        /// The bot's ID, the chat's session, or the group chat's ID.
        var id: String
        /// Its conversation, and its subagents', root first, once they're read.
        var sessions: [String]
        var from: String?
        var to: String?
        /// Its folder where it was, and where it's going: a bot's own, a chat's wake-ups' (nil
        /// for a chat that keeps none).
        var original: String?
        var copy: String?
        var wasPaused: Bool
        var stage: Stage
    }

    private static let key = "movesUnderWay"

    private var records: [Record] {
        get { UserDefaults.standard.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([Record].self, from: $0) } ?? [] }
        set {
            UserDefaults.standard.set(newValue.isEmpty ? nil : try? JSONEncoder().encode(newValue), forKey: Self.key)
            noteMovedAway(newValue)
        }
    }

    private func save(_ record: Record) {
        var record = record
        if let from = record.from, let now = renamed[from] { record.from = now }
        if let to = record.to, let now = renamed[to] { record.to = now }
        // One naming a machine you removed meanwhile ended with it (`machineRemoved`).
        if [record.from, record.to].contains(where: { $0.map(removed.contains) == true }) { return forget(record) }
        records = records.filter { $0.id != record.id } + [record]
    }

    private func forget(_ record: Record) {
        records = records.filter { $0.id != record.id }
    }

    /// Conversations whose original went, by the computer they left, while the app runs: what that
    /// computer still says of them (that they're gone) isn't about the one that lives on.
    @ObservationIgnored private var left: [String: String?] = [:]
    /// Whether moves cut short are being finished or taken back now (`recover`), and whether to
    /// look again once that's done.
    @ObservationIgnored private var recovers = false
    @ObservationIgnored private var recoverAgain = false
    /// Machines found to be another's address, and machines you removed, while the app runs: a
    /// move under way then is noted under the other's name, or not at all.
    @ObservationIgnored private var renamed: [String: String] = [:]
    @ObservationIgnored private var removed: Set<String> = []

    /// What's listed and heard from where a conversation isn't the one that lives: where it left
    /// (once it switched, until the original's gone, and what's said of it after), and where it's
    /// being copied (until it switches).
    private func noteMovedAway(_ records: [Record]) {
        var away = left
        for record in records {
            let place = record.stage == .switched ? record.from : record.to
            for session in record.sessions { away[session] = .some(place) }
        }
        app?.workspace.movedAway = away
        // Your machines hear where moved conversations live now.
        if let app { Task { await app.phoneLink.tellMachines() } }
        Self.pending = Set(records.filter { record in
            record.kind == .bot && record.stage == .switched && underWay[record.id] == nil && app?.bots.bot(record.id).map { $0.machine == record.from } == true
        }.flatMap { [$0.id] + $0.sessions })
    }

    func isMoving(_ id: String) -> Bool { underWay[id] != nil }

    /// Where each conversation being moved lives now (nil: this Mac), until its move is done: the
    /// computer it left may still list it.
    var livePlaces: [String: String?] {
        var places: [String: String?] = [:]
        for record in records {
            let live = record.stage == .switched ? record.to : record.from
            for session in record.sessions { places[session] = .some(live) }
        }
        return places
    }
    /// A move of it cut short, still to be finished or taken back.
    func isPending(_ id: String) -> Bool { records.contains { $0.id == id } }

    /// A machine's name, as you see it.
    private func placeName(_ machine: String?) -> String {
        machine.map { app?.machines.engine($0)?.machine.name ?? $0 } ?? AppInfo.name
    }

    /// Where something can move: this Mac, and each machine you've added, but where it is.
    func destinations(from machine: String?) -> [String?] {
        ([nil] + (app?.machines.list.map(\.id) ?? []).map(Optional.some)).filter { $0 != machine }
    }

    // MARK: Bots

    /// Moves a bot to `machine` (nil: this Mac): its folder and conversation go there, and from
    /// then on it lives there. Its group chats get a seat for it there at its next turn.
    func move(bot id: String, to machine: String?) async throws {
        guard let app, let asked = app.bots.bot(id), asked.machine != machine, underWay[id] == nil else { return }
        if asked.project != nil { throw Failure.inProject(asked.name) }
        if asked.agents == true { throw Failure.withAgents(asked.name) }
        try await finishEarlier(id, name: asked.name)
        // As it is now: an earlier move just finished may have taken it there already.
        guard let bot = app.bots.bot(id), bot.machine != machine, underWay[id] == nil else { return }
        if app.workspace.isWorking(bot.sessionID) || app.chats.speaking.values.contains(bot.id) { throw Failure.working(bot.name) }
        // One in a group chat moving now: once that's where it's going.
        if let moving = app.chats.list.first(where: { $0.members.contains(bot.id) && underWay[$0.id] != nil }) { throw Failure.working("“\(moving.name)”") }
        // One in a group chat that lives with its bots on a machine stays with it.
        if let chat = app.chats.list.first(where: { $0.members.contains(bot.id) && app.chats.machine(of: $0.id) != nil }), let there = app.chats.machine(of: chat.id) {
            throw Failure.inMachineGroup(name: bot.name, chat: chat.name, machine: app.machines.engine(there)?.machine.name ?? there)
        }
        guard let source = app.workspace.api(forFolder: bot.directory) else { throw Failure.notConnected(bot.machine ?? AppInfo.name) }
        guard let target = api(on: machine) else { throw Failure.notConnected(machine ?? AppInfo.name) }
        var record = Record(kind: .bot, id: id, sessions: [], from: bot.machine, to: machine, original: bot.folder, copy: nil, wasPaused: true, stage: .copying)
        underWay[id] = .some(machine)
        Self.frozen.formUnion([bot.id, bot.sessionID])
        defer {
            underWay[id] = nil
            Self.frozen.subtract(record.sessions + [bot.id, bot.sessionID])
        }
        let copied: (exports: [JSONValue], sessions: [Session])
        do {
            let here = try await transport.home(on: bot.machine)
            let home = try await transport.home(on: machine)
            try await checkApart(here, on: bot.machine, home, on: machine)
            var moved = bot
            moved.machine = machine
            moved.folder = home.bots + "/" + bot.id
            let folder = moved.folder
            record.copy = folder
            record.wasPaused = try await transport.exists(bot.folder + "/paused", on: bot.machine)
            save(record)
            // Its wake-ups wait while it moves (as Pause does), so none goes on the way, and none twice.
            if !record.wasPaused { try await transport.write(Data(Self.hold.utf8), to: bot.folder + "/paused", on: bot.machine) }
            try await settle([bot.sessionID], on: source, name: bot.name)
            copied = try await carry(bot.sessionID, from: source, to: target, directory: moved.directory, name: bot.name, record: &record) {
                // One left there by a move cut short, or by the copy before this one, goes first.
                if try await self.transport.exists(folder, on: machine) { try await self.transport.trash(folder, on: machine) }
                try await self.copy(bot.folder, from: bot.machine, into: home.bots, on: machine)
            }
        } catch {
            await takeBack(record, target: target)
            log.error("A bot didn't move: \(error.localizedDescription, privacy: .public)")
            throw error
        }

        // The switch: from here on it lives there.
        switched(&record)
        await switchBot(bot, record: record, sessions: copied.sessions, target: target)
        noteMovedAway(records)
        // The original goes.
        await finish(record, exports: copied.exports, source: source, leaving: bot)
        app.wakeUps.forget(key: id)
        if let now = app.bots.bot(id) { await app.wakeUps.read(now.wakeOwner) }
        Analytics.shared.track("bot_moved", ["to": machine == nil ? "mac" : "machine"])
    }

    /// From here on the bot lives where it went: its group chats' seats, its row and tabs, its
    /// record, and its keys there (read where it was, given where it is; those where it was go as
    /// the move finishes).
    private func switchBot(_ bot: Bot, record: Record, sessions: [Session], target: OpenCodeAPI) async {
        guard let app, let folder = record.copy, let session = sessions.first else { return }
        await app.groups.botMoving(bot)
        let keys = await BotKeys.carried(bot, app: app) ?? [:]
        app.workspace.moved(sessions, api: target)
        await app.bots.moved(bot.id, to: record.to, folder: folder, session: session, api: target)
        if let now = app.bots.bot(bot.id) { await BotKeys.give(keys, to: now, app: app) }
        if bot.machine == nil { app.utilities.closeTabs(of: bot.id) }
    }

    // MARK: Chats

    /// Moves a chat to `machine` (nil: this Mac): its conversation and wake-ups go there, into
    /// that computer's chats.
    func move(chat id: String, to machine: String?) async throws {
        guard let app, let asked = app.workspace.session(id), Workspace.isChat(asked.location.directory) else { return }
        let name = (asked.title ?? "").isEmpty ? "This chat" : "“\(asked.title ?? "")”"
        if OutsideAgents.isAgentSession(asked) { throw Failure.withAgents(name) }
        try await finishEarlier(id, name: name)
        // As it is now: an earlier move just finished may have taken it there already.
        guard let chat = app.workspace.session(id), Workspace.isChat(chat.location.directory) else { return }
        let from = RemoteFolder.machine(of: chat.location.directory)
        guard from != machine, underWay[id] == nil else { return }
        if app.workspace.isWorking(id) { throw Failure.working(name) }
        guard let source = app.workspace.api(forSession: id) else { throw Failure.notConnected(from ?? AppInfo.name) }
        guard let target = api(on: machine) else { throw Failure.notConnected(machine ?? AppInfo.name) }
        var record = Record(kind: .chat, id: id, sessions: [], from: from, to: machine, original: nil, copy: nil, wasPaused: true, stage: .copying)
        underWay[id] = .some(machine)
        Self.frozen.insert(id)
        defer {
            underWay[id] = nil
            Self.frozen.subtract(record.sessions + [id])
        }
        let copied: (exports: [JSONValue], sessions: [Session])
        do {
            let there = try await transport.home(on: machine)
            let here = try await transport.home(on: from)
            try await checkApart(here, on: from, there, on: machine)
            let directory = machine.map { RemoteFolder.folder(there.chats, on: $0) } ?? there.chats
            let wakes = here.wakes + "/" + id
            let copy = there.wakes + "/" + id
            let hasWakes = try await transport.exists(wakes, on: from)
            if hasWakes {
                record.original = wakes
                record.copy = copy
                record.wasPaused = try await transport.exists(wakes + "/paused", on: from)
            }
            save(record)
            if hasWakes, !record.wasPaused { try await transport.write(Data(Self.hold.utf8), to: wakes + "/paused", on: from) }
            try await settle([id], on: source, name: name)
            copied = try await carry(id, from: source, to: target, directory: directory, name: name, record: &record) {
                guard hasWakes else { return }
                if try await self.transport.exists(copy, on: machine) { try await self.transport.trash(copy, on: machine) }
                try await self.copy(wakes, from: from, into: there.wakes, on: machine)
                // Where its watches' checks run there.
                try await self.transport.write(Data(there.chats.utf8), to: copy + "/directory", on: machine)
            }
        } catch {
            await takeBack(record, target: target)
            log.error("A chat didn't move: \(error.localizedDescription, privacy: .public)")
            throw error
        }

        switched(&record)
        app.workspace.moved(copied.sessions, api: target)
        await finish(record, exports: copied.exports, source: source, leaving: nil)
        app.wakeUps.forget(key: id)
        if let now = app.workspace.session(id) { await app.wakeUps.read(WakeUps.owner(of: now)) }
        Analytics.shared.track("chat_moved_computer", ["to": machine == nil ? "mac" : "machine"])
    }

    // MARK: Group chats

    /// Moves a group chat to the machine its bots all live on, where it carries on while this Mac
    /// is off; or from a machine to this Mac (its bots stay where they are). Its messages, seats,
    /// meeting and what each bot heard go along. It's held where it goes until the copy where it
    /// was is let go, so nothing said while it moves is lost.
    func move(group id: String, to machine: String?) async throws {
        guard let app, underWay[id] == nil, let asked = app.chats.group(id) else { return }
        let name = "“\(asked.name)”"
        try await finishEarlier(id, name: name)
        // Where it lives: this Mac while it has it (a copy left on a machine isn't the one).
        let from = app.groups.group(id) == nil ? app.machineGroups.machine(of: id) : nil
        guard from != machine, let group = app.chats.group(id) else { return }
        if app.chats.discussing.contains(id) { throw Failure.working(name) }
        if app.chats.messages(in: id).contains(where: { $0.tasks?.contains { $0.state == .working || $0.state == .waiting } == true }) {
            throw Failure.workUnderWay(chat: name)
        }
        if let machine {
            // Its bots all live there, and stay there while it moves.
            guard group.members.allSatisfy({ app.bots.bot($0)?.machine == machine }) else { throw Failure.botsElsewhere(chat: name) }
            if let moving = group.members.first(where: { underWay[$0] != nil }), let bot = app.bots.bot(moving) { throw Failure.working(bot.name) }
            guard app.machineGroups.reachable(machine) else { throw Failure.notConnected(placeName(machine)) }
            guard app.machineGroups.running.contains(machine) else { throw Failure.notYet(machine: placeName(machine)) }
        } else if let from, !app.machineGroups.reachable(from) {
            throw Failure.notConnected(placeName(from))
        }
        var record = Record(kind: .group, id: id, sessions: [], from: from, to: machine, original: nil, copy: nil, wasPaused: true, stage: .copying)
        underWay[id] = .some(machine)
        Self.frozen.insert(id)
        defer {
            underWay[id] = nil
            Self.frozen.remove(id)
        }
        save(record)
        do {
            if let machine {
                app.groups.stop(id)
                try await app.machineGroups.bring(app.groups.group(id) ?? group, messages: app.groups.messages(in: id), to: machine)
            } else {
                let held = try await app.machineGroups.hold(id)
                app.groups.adopt(held.group, messages: held.messages)
            }
        } catch {
            if await !takeBackGroup(record) { recoverSoon() }
            log.error("A group chat didn't move: \(error.localizedDescription, privacy: .public)")
            throw error
        }
        switched(&record)
        if await !completeGroup(record) { recoverSoon() }
        Analytics.shared.track("group_moved", ["to": machine == nil ? "mac" : "machine"])
    }

    /// A group chat's move that didn't get as far as switching: the copy where it was going goes,
    /// and it carries on where it was. Whether that's done (its machine was there).
    private func takeBackGroup(_ record: Record) async -> Bool {
        guard let app else { return false }
        if goneElsewhere(record) { return true }
        if let to = record.to {
            guard await app.machineGroups.takeBack(record.id, on: to) else { return false }
        } else if let from = record.from {
            guard app.machineGroups.reachable(from) else { return false }
            await app.groups.release(record.id, toTrash: false)
            do { try await app.machineGroups.activate(record.id) } catch { return false }
        }
        forget(record)
        return true
    }

    /// After it switched: where it went, it starts; where it was, it's let go (to this Mac's
    /// Trash, or the machine's trash folder, with its seats left, as its bots live there).
    private func completeGroup(_ record: Record) async -> Bool {
        guard let app else { return false }
        if goneElsewhere(record) { return true }
        if let to = record.to {
            await app.groups.release(record.id, toTrash: true)
            guard app.machineGroups.reachable(to) else { return false }
            do { try await app.machineGroups.activate(record.id) } catch { return false }
        } else if let from = record.from {
            guard app.machineGroups.reachable(from) else { return false }
            do { try await app.machineGroups.release(record.id) } catch { return false }
        }
        forget(record)
        return true
    }

    /// A group chat's move to or from a machine you removed meanwhile: nothing's left to do there
    /// (this Mac keeps what it has; a copy held there is let go if you add it again).
    private func goneElsewhere(_ record: Record) -> Bool {
        guard let machine = record.to ?? record.from, removed.contains(machine) else { return false }
        forget(record)
        return true
    }

    /// A step that failed with its machine still there (a moment's trouble): tried again soon,
    /// rather than at the next launch or connection.
    private func recoverSoon() {
        Task {
            try? await Task.sleep(for: .seconds(30))
            await recover()
        }
    }

    // MARK: The conversation

    /// A move of it cut short earlier is finished or taken back first; until it can be, it stays
    /// where it is.
    private func finishEarlier(_ id: String, name: String) async throws {
        guard records.contains(where: { $0.id == id }) else { return }
        // Moves cut short being seen to already (at launch, a machine connecting): once that's through.
        for _ in 0..<300 where recovers { try await Task.sleep(for: .milliseconds(200)) }
        await recover()
        if records.contains(where: { $0.id == id }) { throw Failure.unfinished(name) }
    }

    /// That where it is and where it's going aren't one computer at two addresses (not yet found
    /// to be one): a mark left in Kuvo Code's folder where it is, looked for where it's going.
    private func checkApart(_ here: MoveHome, on from: String?, _ there: MoveHome, on to: String?) async throws {
        let mark = "/.move-" + UUID().uuidString
        try await transport.write(Data(), to: here.root + mark, on: from)
        let seen: Bool
        do {
            seen = try await transport.exists(there.root + mark, on: to)
        } catch {
            try? await transport.remove(here.root + mark, on: from)
            throw error
        }
        try? await transport.remove(here.root + mark, on: from)
        if seen { throw Failure.sameComputer }
    }

    /// Until none of the conversations is at work (as the app hears it, and as its engine says)
    /// and nothing waits to go to it (a wake-up on its way, a message that went just before it
    /// froze): a minute at most.
    private func settle(_ sessions: [String], on api: OpenCodeAPI, name: String) async throws {
        guard let root = sessions.first else { return }
        for _ in 0..<60 {
            let heard = sessions.contains { app?.workspace.isWorking($0) ?? false }
            let active = try await !api.activeSessions().isDisjoint(with: sessions)
            let waiting = try await !api.inbox(session: root).isEmpty
            if !heard, !active, !waiting { return }
            try await Task.sleep(for: .seconds(1))
        }
        throw Failure.waiting(name)
    }

    /// Copies the conversation (and its subagents') to `target`, at `directory`, after `files`
    /// (its folder); then, once it's settled, reads the original again: if anything reached it
    /// meanwhile, it all goes again, folder too. One there already (an earlier copy, from a move
    /// cut short) gives way.
    private func carry(_ session: String, from source: OpenCodeAPI, to target: OpenCodeAPI, directory: String, name: String, record: inout Record,
                       files: () async throws -> Void) async throws -> (exports: [JSONValue], sessions: [Session]) {
        var exports = try await exportAll(session, from: source)
        for attempt in 0..<3 {
            record.sessions = Self.ids(exports)
            save(record)
            Self.frozen.formUnion(record.sessions)
            try await files()
            let sessions = try await importAll(exports, into: target, directory: directory)
            try await settle(record.sessions, on: source, name: name)
            let again = try await exportAll(session, from: source)
            if Self.same(again, exports) { return (exports, sessions) }
            guard attempt < 2 else { break }
            for id in record.sessions.reversed() { try? await target.deleteSession(id) }
            exports = again
        }
        throw Failure.busy(name)
    }

    /// The conversation and every subagent's under it, root first, as the engine exports them.
    private func exportAll(_ session: String, from api: OpenCodeAPI) async throws -> [JSONValue] {
        var exports = [try await api.exportSession(session)]
        var next = [session]
        while let parent = next.popLast() {
            for child in try await api.allChildren(of: parent) {
                exports.append(try await api.exportSession(child.id))
                next.append(child.id)
            }
        }
        return exports
    }

    /// Each into `api` at `directory`, under its own ID; one there already (an earlier copy, from
    /// a move cut short, while the original is still where it was) gives way.
    private func importAll(_ exports: [JSONValue], into api: OpenCodeAPI, directory: String) async throws -> [Session] {
        var sessions: [Session] = []
        for exported in exports {
            do {
                sessions.append(try await api.importSession(exported: exported, directory: directory))
            } catch let error as ServerError where error.status == 409 {
                guard let id = exported["info"]?["id"]?.string else { throw error }
                try await api.deleteSession(id)
                sessions.append(try await api.importSession(exported: exported, directory: directory))
            }
        }
        return sessions
    }

    private static func ids(_ exports: [JSONValue]) -> [String] {
        exports.compactMap { $0["info"]?["id"]?.string }
    }

    /// Whether two reads of a conversation hold the same sessions with the same messages, word for word.
    private static func same(_ one: [JSONValue], _ other: [JSONValue]) -> Bool {
        func conversation(_ exports: [JSONValue]) -> [JSONValue] {
            exports.map { .array([$0["info"]?["id"] ?? .null, $0["messages"] ?? .null]) }
        }
        return conversation(one) == conversation(other)
    }

    // MARK: Ending

    /// The copy is the one from now on: what's heard from where it left isn't about it, and what's
    /// heard from where it went is.
    private func switched(_ record: inout Record) {
        for session in record.sessions where left[session] == .some(record.to) { left[session] = nil }
        record.stage = .switched
        save(record)
    }

    /// A move that didn't get as far as switching: what it made where it was going goes, and the
    /// original's wake-ups go on, as it was. Kept to try again (`recover`) until all that's done.
    private func takeBack(_ record: Record, target: OpenCodeAPI?) async {
        var done = target != nil || record.sessions.isEmpty
        if let target {
            for id in record.sessions.reversed() {
                do {
                    try await target.deleteSession(id)
                } catch let error as ServerError where error.status == 404 {
                    // Never got there.
                } catch {
                    done = false
                }
            }
        }
        if let copy = record.copy {
            do { try await transport.trash(copy, on: record.to) } catch { done = false }
        }
        if let original = record.original {
            do { try await transport.unpause(original, on: record.from) } catch { done = false }
        }
        if done {
            forget(record)
        } else {
            log.error("A move that didn't finish is still to be taken back")
        }
    }

    /// After it switched: its wake-ups go on where it went, and the original goes, its
    /// conversation saved in its folder (or one of its own, for a chat that kept none), which goes
    /// to the trash where it was. Kept to try again (`recover`) until that's all done.
    private func finish(_ record: Record, exports: [JSONValue]?, source: OpenCodeAPI, leaving bot: Bot?) async {
        var done = true
        if let copy = record.copy {
            do { try await transport.unpause(copy, on: record.to) } catch { done = false }
        }
        var place = record.original
        if place == nil, let home = try? await transport.home(on: record.from) { place = home.root + "/moved-" + record.id }
        if let place, let exports, let data = Self.data(.array(exports)) {
            try? await transport.write(data, to: place + "/conversation.json", on: record.from)
        }
        for id in record.sessions.reversed() {
            do {
                try await source.deleteSession(id)
            } catch let error as ServerError where error.status == 404 {
                // Gone already.
            } catch {
                done = false
                log.error("A moved conversation's original stayed where it was: \(error.localizedDescription, privacy: .public)")
            }
        }
        guard done else { return }
        // Its keys where it was, while that computer still finds it there.
        if let bot { await BotKeys.leave(bot, app: app) }
        if let place { try? await transport.trash(place, on: record.from) }
        for session in record.sessions { left[session] = .some(record.from) }
        forget(record)
    }

    /// Moves cut short (the app quit, a computer away): those that switched finish, the rest are
    /// taken back, once both computers are there. At launch, and as a machine connects; one at a
    /// time, each as it is when its turn comes.
    func recover() async {
        noteMovedAway(records)
        guard !recovers else {
            recoverAgain = true
            return
        }
        recovers = true
        defer { recovers = false }
        repeat {
            recoverAgain = false
            for id in records.map(\.id) {
                guard underWay[id] == nil, let record = records.first(where: { $0.id == id }) else { continue }
                if record.kind == .group {
                    _ = record.stage == .copying ? await takeBackGroup(record) : await completeGroup(record)
                    continue
                }
                guard let source = api(on: record.from), let target = api(on: record.to) else { continue }
                switch record.stage {
                case .copying: await takeBack(record, target: target)
                case .switched: await complete(record, source: source, target: target)
                }
            }
        } while recoverAgain
    }

    /// A move cut short after it switched: a bot not yet switched over to its copy is now; then
    /// the original goes.
    private func complete(_ record: Record, source: OpenCodeAPI, target: OpenCodeAPI) async {
        guard let app, let root = record.sessions.first else { return forget(record) }
        var leaving: Bot?
        if record.kind == .bot, let bot = app.bots.bot(record.id) {
            if bot.machine == record.from {
                // Its conversation there, with its subagents', so all of it goes by the copy.
                var sessions: [Session] = []
                for id in record.sessions {
                    if let session = try? await target.session(id) { sessions.append(session) }
                }
                guard sessions.first?.id == root else { return }
                await switchBot(bot, record: record, sessions: sessions, target: target)
                noteMovedAway(records)
                leaving = bot
            } else {
                var original = bot
                original.machine = record.from
                if let folder = record.original { original.folder = folder }
                leaving = original
            }
        }
        let exports = try? await exportAll(root, from: source)
        await finish(record, exports: exports, source: source, leaving: leaving)
        if record.kind == .bot, let now = app.bots.bot(record.id) {
            app.wakeUps.forget(key: record.id)
            await app.wakeUps.read(now.wakeOwner)
        }
    }

    /// A machine found to be another one's address: moves noted under its name go under the
    /// other's. One with that computer at both ends is let go: there's nothing to finish or take
    /// back there that wouldn't touch what lives on.
    func fold(_ address: String, into machine: String) {
        renamed[address] = machine
        for (session, place) in left where place == address { left[session] = .some(machine) }
        records = records.compactMap { record in
            var record = record
            if record.from == address { record.from = machine }
            if record.to == address { record.to = machine }
            return record.from == record.to ? nil : record
        }
    }

    /// A machine you removed: moves to or from it end. What's on this side goes back as it was (an
    /// original's wake-ups go on, a copy made here goes); what's there stays there.
    func machineRemoved(_ machine: String) async {
        removed.insert(machine)
        left = left.filter { $0.value != .some(machine) }
        // A move under way ends by itself (it can't reach the machine), noted no more (`save`).
        for record in records where (record.from == machine || record.to == machine) && underWay[record.id] == nil {
            if record.stage == .copying, record.to == machine, let original = record.original {
                try? await transport.unpause(original, on: record.from)
            }
            if record.stage == .copying, record.from == machine {
                if let target = api(on: record.to) { for id in record.sessions.reversed() { try? await target.deleteSession(id) } }
                if let copy = record.copy { try? await transport.trash(copy, on: record.to) }
            }
            forget(record)
        }
        noteMovedAway(records)
    }

    // MARK: Plumbing

    /// The engine on `machine` (nil: this Mac's), while it's up.
    private func api(on machine: String?) -> OpenCodeAPI? {
        guard let machine else { return app?.workspace.api }
        if let engine = app?.machines.engine(machine) { return engine.isReady ? engine.api : nil }
        return app?.workspace.machineAPI(machine)
    }

    /// Copies `path` (a folder) from where it is into `parent` on `machine`, through an archive in
    /// Kuvo Code's temporary folder, gone once it's there.
    private func copy(_ path: String, from source: String?, into parent: String, on machine: String?) async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: AppInfo.bundleID)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let archive = folder.appending(path: "move-\(UUID().uuidString).tar")
        defer { try? FileManager.default.removeItem(at: archive) }
        try await transport.pack(path, on: source, into: archive)
        try await transport.unpack(archive, into: parent, on: machine)
    }

    private static func data(_ exported: JSONValue) -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try? encoder.encode(exported)
    }
}

/// Kuvo Code's folders on a computer, as that computer writes them: where bots, sessions' wake-ups
/// and chats are kept.
struct MoveHome: Equatable {
    var root: String
    var bots: String
    var wakes: String
    var chats: String
}

/// How a move's files get from one computer to another (`Moves`).
protocol MoveTransport {
    /// Kuvo Code's folders on `machine` (nil: this Mac), made if they aren't there.
    func home(on machine: String?) async throws -> MoveHome
    func exists(_ path: String, on machine: String?) async throws -> Bool
    /// `path` (a folder) as an archive at `archive`, named by its last part.
    func pack(_ path: String, on machine: String?, into archive: URL) async throws
    /// What `archive` holds, unpacked in `parent`.
    func unpack(_ archive: URL, into parent: String, on machine: String?) async throws
    /// `path` to the trash: this Mac's, or Kuvo Code's trash folder on `machine`.
    func trash(_ path: String, on machine: String?) async throws
    func write(_ data: Data, to path: String, on machine: String?) async throws
    /// A file, if it's there.
    func remove(_ path: String, on machine: String?) async throws
    /// The hold a move put on the wake-ups in `folder` (its pause file saying `Moves.hold`), taken
    /// away; a pause of yours stays.
    func unpause(_ folder: String, on machine: String?) async throws
}

/// This Mac's folders, and a machine's over SSH, in `~/.kuvo-code`.
nonisolated struct SSHMoveTransport: MoveTransport {
    private var root: String { RemoteEngineInstaller.root }

    func home(on machine: String?) async throws -> MoveHome {
        guard let machine else {
            return MoveHome(root: AppInfo.supportDirectory.path, bots: Bots.root.path, wakes: WakeUps.root.path, chats: Workspace.chatsFolder)
        }
        let output = try await SSHConnection(destination: machine).run("""
            K="$HOME/\(root)"; mkdir -p "$K/bots" "$K/wakes" "$K/chats" "$K/trash" && chmod 700 "$K" && cd "$K" && pwd
            """)
        let path = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard path.hasPrefix("/") else { throw URLError(.cannotOpenFile) }
        return MoveHome(root: path, bots: path + "/bots", wakes: path + "/wakes", chats: path + "/chats")
    }

    func exists(_ path: String, on machine: String?) async throws -> Bool {
        guard let machine else { return FileManager.default.fileExists(atPath: path) }
        let output = try await SSHConnection(destination: machine).run("[ -e \(SSHConnection.quoted(path)) ] && echo yes || echo no")
        return output.trimmingCharacters(in: .whitespacesAndNewlines) == "yes"
    }

    func pack(_ path: String, on machine: String?, into archive: URL) async throws {
        let parent = (path as NSString).deletingLastPathComponent, name = (path as NSString).lastPathComponent
        guard let machine else {
            // Without this Mac's own metadata (extended attributes, ACLs), which Linux's tar
            // doesn't know.
            try await Self.tar(["--no-xattrs", "--no-mac-metadata", "--no-acls", "--no-fflags", "--format", "gnutar", "-C", parent, "-cf", archive.path, name])
            return
        }
        try await SSHConnection(destination: machine).run("cd \(SSHConnection.quoted(parent)) && tar -cf - \(SSHConnection.quoted(name))", output: archive)
    }

    func unpack(_ archive: URL, into parent: String, on machine: String?) async throws {
        guard let machine else {
            try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
            try await Self.tar(["-C", parent, "-xf", archive.path])
            return
        }
        try await SSHConnection(destination: machine).run("mkdir -p \(SSHConnection.quoted(parent)) && tar -xf - -C \(SSHConnection.quoted(parent))", input: archive)
    }

    func trash(_ path: String, on machine: String?) async throws {
        guard let machine else {
            guard FileManager.default.fileExists(atPath: path) else { return }
            try FileManager.default.moveToTrash(URL(filePath: path))
            return
        }
        try await SSHConnection(destination: machine).run("""
            P=\(SSHConnection.quoted(path)); T="$HOME/\(root)/trash/$(date +%Y%m%d-%H%M%S)-$$"
            [ ! -e "$P" ] || { mkdir -p "$T" && mv -- "$P" "$T/"; }
            """)
    }

    func write(_ data: Data, to path: String, on machine: String?) async throws {
        guard let machine else {
            try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            try data.write(to: URL(filePath: path), options: .atomic)
            return
        }
        let folder = FileManager.default.temporaryDirectory.appending(path: AppInfo.bundleID)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let input = folder.appending(path: "move-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: input) }
        FileManager.default.createFile(atPath: input.path, contents: data, attributes: [.posixPermissions: 0o600])
        let quoted = SSHConnection.quoted(path)
        try await SSHConnection(destination: machine).run("mkdir -p \"$(dirname \(quoted))\" && (umask 077; cat >\(quoted).new) && mv -f \(quoted).new \(quoted)", input: input)
    }

    func remove(_ path: String, on machine: String?) async throws {
        guard let machine else {
            if FileManager.default.fileExists(atPath: path) { try FileManager.default.removeItem(atPath: path) }
            return
        }
        try await SSHConnection(destination: machine).run("rm -f \(SSHConnection.quoted(path))")
    }

    func unpause(_ folder: String, on machine: String?) async throws {
        let path = folder + "/paused"
        guard let machine else {
            guard let data = FileManager.default.contents(atPath: path), String(decoding: data, as: UTF8.self) == Moves.hold else { return }
            try FileManager.default.removeItem(atPath: path)
            return
        }
        let quoted = SSHConnection.quoted(path)
        try await SSHConnection(destination: machine).run("[ \"$(cat \(quoted) 2>/dev/null)\" != \(Moves.hold) ] || rm -f \(quoted)")
    }

    /// This Mac's tar, as it is.
    private static func tar(_ arguments: [String]) async throws {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/tar")
        process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment["COPYFILE_DISABLE"] = "1"
        process.environment = environment
        let errors = Pipe()
        process.standardError = errors
        process.standardOutput = FileHandle.nullDevice
        let status: Int32 = try await withCheckedThrowingContinuation { continuation in
            process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
            do { try process.run() } catch { continuation.resume(throwing: error) }
        }
        guard status == 0 else {
            let message = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            throw NSError(domain: "tar", code: Int(status), userInfo: [NSLocalizedDescriptionKey: message.isEmpty ? "tar failed (\(status))" : message])
        }
    }
}
