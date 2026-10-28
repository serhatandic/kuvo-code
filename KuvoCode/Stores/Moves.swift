import Foundation
import OpenCodeKit

/// Moving a bot, a chat or a group chat to another computer: this Mac, or one of your machines. The
/// boxes do it between themselves (KuvoLink's PROTOCOL.md, `kuvo/moves`): this app asks the box it
/// lives on once, and shows what each box says of its moves. It goes whole (a bot with its memory,
/// workspace, wake-ups and watches; a chat with its wake-ups; a group chat with its messages), with
/// its conversation and its subagents', which carry on there under the same IDs.
///
/// While it moves, nothing goes to it (`isFrozen`): what you send stays in the composer, agents'
/// messages wait (`Deliveries`), its wake-ups are held. A move cut short (a computer restarting) is
/// finished or taken back by the box it was leaving, with no client there too.
@MainActor @Observable
final class Moves {
    /// What's moving now, a bot's ID, a chat's session ID or a group chat's ID, and where to (nil:
    /// this Mac): its row says so.
    private(set) var underWay: [String: String?] = [:]
    @ObservationIgnored weak var app: AppModel?
    /// A box's routes (a test's own), else the app's.
    @ObservationIgnored var boxes: ((String) -> BoxClient)?

    /// What each box says is moving there (by "mac" or a machine's id), and its conversations that
    /// don't live there.
    @ObservationIgnored private var told: [String: BoxMoves] = [:]
    /// Moves asked for from here, until their box answers: shown at once, before it says so.
    @ObservationIgnored private var asked: [String: String?] = [:]

    /// Conversations moving now (a bot's, a chat's, their subagents') and the bots and group chats
    /// moving: nothing goes to them until they're where they're going; what waited goes then
    /// (`Deliveries`).
    private(set) static var frozen: Set<String> = [] {
        didSet { Deliveries.movesChanged() }
    }

    static func isFrozen(_ id: String) -> Bool { frozen.contains(id) }

    enum Failure: LocalizedError {
        case notConnected(String)
        /// A machine whose box doesn't talk to your other computers yet.
        case needsUpdate(String)
        /// What the box said.
        case refused(String)
        /// Something sent to one that's moving.
        case moving
        var errorDescription: String? {
            switch self {
            case .notConnected(let place): "\(place) isn’t connected. Connect to it, then try again."
            case .needsUpdate(let place): "\(place) needs a newer Kuvo Code before things can move to or from it. It updates by itself overnight, or connect to it from this Mac."
            case .refused(let message): message
            case .moving: "It’s moving to another computer. Try again once it’s there."
            }
        }
    }

    /// A box's moves, as `kuvo/moves` says them.
    struct BoxMoves: Decodable, Equatable {
        struct Move: Decodable, Equatable {
            var id: String
            var kind: String
            var thing: String
            var from: String
            var to: String
            var role: String
            var stage: String
            var sessions: [String]
        }
        var moves: [Move]
        var away: [String]
    }

    // COMPAT(0.7 mac-moves-under-way): moves an earlier Kuvo Code ran itself, forgotten (its boxes lift what they left held). Goes 3 months after 0.8.0.
    init() {
        UserDefaults.standard.removeObject(forKey: "movesUnderWay")
    }

    func isMoving(_ id: String) -> Bool { underWay[id] != nil }

    /// A move of it that its box hasn't finished yet.
    func isPending(_ id: String) -> Bool { told.values.contains { $0.moves.contains { $0.thing == id } } }

    /// Where something can move: this Mac, and each machine you've added, but where it is.
    func destinations(from machine: String?) -> [String?] {
        ([nil] + (app?.machines.list.map(\.id) ?? []).map(Optional.some)).filter { $0 != machine }
    }

    // MARK: Moving

    func move(bot id: String, to machine: String?) async throws {
        guard let bot = app?.bots.bot(id) else { return }
        try await move("bot", id, from: bot.machine, to: machine)
        Analytics.shared.track("bot_moved", ["to": machine == nil ? "mac" : "machine"])
    }

    func move(chat id: String, to machine: String?) async throws {
        guard let chat = app?.workspace.session(id) else { return }
        try await move("chat", id, from: RemoteFolder.machine(of: chat.location.directory), to: machine)
        Analytics.shared.track("chat_moved_computer", ["to": machine == nil ? "mac" : "machine"])
    }

    func move(group id: String, to machine: String?) async throws {
        try await move("group", id, from: app?.boxGroups.machine(of: id), to: machine)
        Analytics.shared.track("group_moved", ["to": machine == nil ? "mac" : "machine"])
    }

    /// Asks the box it lives on to move it, and waits until it's there (or why not); then it's shown
    /// where it went (`ended`), as a move asked from elsewhere is.
    private func move(_ kind: String, _ id: String, from: String?, to: String?) async throws {
        guard from != to, underWay[id] == nil else { return }
        guard let key = try boxKey(of: to) else { return }
        _ = try boxKey(of: from)
        asked[id] = .some(to)
        show()
        defer {
            asked[id] = nil
            show()
        }
        struct Body: Encodable { var kind: String; var id: String; var to: String }
        struct Answer: Decodable { var move: BoxMoves.Move }
        let box = from ?? BoxClient.mac
        guard let source = client(box) else { return }
        let answer: Answer
        do {
            answer = try await source.value(Answer.self, "POST", "kuvo/moves", body: Body(kind: kind, id: id, to: key))
        } catch let refusal as BoxRefusal {
            await reload(box)
            // A box from before moves were the box's.
            if refusal.status == 404, refusal.message.hasPrefix("It said no") { throw Failure.needsUpdate(placeName(from)) }
            throw Failure.refused(refusal.message)
        } catch {
            // Lost on the way (the connection went): the boxes see it through all the same.
            await reload(box)
            if isPending(id) { throw Failure.refused("Kuvo Code lost touch with \(placeName(from)) while it moved. It goes on there, and shows where it went once it’s there.") }
            throw error
        }
        await reload(box)
        await ended(answer.move, on: box)
    }

    private func placeName(_ machine: String?) -> String {
        machine.map { app?.machines.engine($0)?.machine.name ?? $0 } ?? AppInfo.name
    }

    /// The key a computer's box goes by among your computers (nil: this Mac's).
    private func boxKey(of machine: String?) throws -> String? {
        guard let app else { return nil }
        guard let machine else {
            guard let key = app.phoneLink.macKey else { throw Failure.refused("This Mac’s link to your other computers isn’t ready yet. Try again in a moment.") }
            return key
        }
        let name = placeName(machine)
        guard app.machines.engine(machine)?.isReady == true else { throw Failure.notConnected(name) }
        if app.phoneLink.machineIsAnotherMacs(machine) { throw Failure.refused("\(name) is run from another Mac. Move things to or from it there.") }
        guard let key = app.phoneLink.key(of: machine) else { throw Failure.needsUpdate(name) }
        return key
    }

    // MARK: What the boxes say

    /// This Mac's box's moves, from now on, as they change (your machines', as below).
    func follow() async {
        while !Task.isCancelled, app != nil {
            do {
                for try await line in client(BoxClient.mac)?.follow("kuvo/moves/events") ?? AsyncThrowingStream { $0.finish() } {
                    guard app != nil else { return }
                    if let said = try? JSONDecoder().decode(BoxMoves.self, from: line) { take(said, from: BoxClient.mac) }
                }
            } catch {}
            // Its box restarted, or isn't up yet: followed again in a moment.
            try? await Task.sleep(for: .seconds(2))
        }
    }

    /// Each box's reads, numbered: an answer older than one taken already isn't taken.
    @ObservationIgnored private var reads: [String: Int] = [:]
    /// Machines read again every few seconds while they say something's moving (a machine's box
    /// answers this Mac once over SSH, not as it changes).
    @ObservationIgnored private var rereading: [String: Task<Void, Never>] = [:]

    /// What `box` (this Mac's, or a machine's id) says of its moves now.
    func reload(_ box: String) async {
        guard let app, let client = client(box) else { return }
        if box != BoxClient.mac, boxes == nil, app.machines.engine(box)?.isReady != true {
            take(nil, from: box)
            return
        }
        reads[box, default: 0] += 1
        let read = reads[box]
        let said = try? await client.value(BoxMoves.self, "GET", "kuvo/moves")
        guard reads[box] == read else { return }
        take(said, from: box)
    }

    /// Each machine's moves read again (as the app starts, or a machine connects).
    func reloadAll() async {
        await reload(BoxClient.mac)
        for machine in app?.machines.list.map(\.id) ?? [] { await reload(machine) }
    }

    /// A machine you removed: what it said goes.
    func forget(_ machine: String) {
        rereading.removeValue(forKey: machine)?.cancel()
        take(nil, from: machine)
    }

    private func take(_ said: BoxMoves?, from box: String) {
        let before = told[box]
        if before == said { return }
        told[box] = said
        show()
        if box != BoxClient.mac { keepReading(box) }
        // What changed of its moves (not how far one's copy went): the boxes at their other ends read
        // too, and one that's over shown where it is now.
        let stages = { (moves: [BoxMoves.Move]) in Set(moves.map { $0.id + " " + $0.stage }) }
        guard stages(before?.moves ?? []) != stages(said?.moves ?? []) else { return }
        let over = (before?.moves ?? []).filter { old in !(said?.moves ?? []).contains { $0.id == old.id } }
        let ends = Set(((said?.moves ?? []) + (before?.moves ?? [])).map(\.peer))
        Task {
            for machine in machinesOf(keys: ends) where machine != box { await reload(machine) }
            for move in over { await ended(move, on: box) }
        }
    }

    private func keepReading(_ machine: String) {
        guard told[machine]?.moves.isEmpty == false else {
            rereading.removeValue(forKey: machine)?.cancel()
            return
        }
        guard rereading[machine] == nil else { return }
        rereading[machine] = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard let self, !Task.isCancelled else { return }
                await self.reload(machine)
            }
        }
    }

    /// A move that's over, wherever it was asked (here, a phone): both computers' lists read again,
    /// so it shows where it lives now, its wake-ups with it.
    private func ended(_ move: BoxMoves.Move, on box: String) async {
        guard let app else { return }
        let here: String? = box == BoxClient.mac ? nil : box
        var ends: [String?] = [here]
        if let there = place(move.peer) { ends.append(there) }
        switch move.kind {
        case "bot":
            for end in ends { await app.bots.refresh(end ?? BoxClient.mac) }
            // Its tabs here go with it, once it doesn't live here.
            if app.bots.bot(move.thing).map({ $0.machine != nil }) ?? true { app.utilities.closeTabs(of: move.thing) }
            app.wakeUps.forget(key: move.thing)
            if let bot = app.bots.bot(move.thing) { await app.wakeUps.read(bot.wakeOwner) }
        case "chat":
            for end in ends {
                if let end { if let engine = app.machines.engine(end) { _ = await app.workspace.refresh(engine) } } else { await app.workspace.refresh() }
            }
            app.wakeUps.forget(key: move.thing)
            if let chat = app.workspace.session(move.thing) { await app.wakeUps.read(WakeUps.owner(of: chat)) }
        default:
            for end in ends { await app.boxGroups.reload(move.thing, on: end) }
        }
    }

    /// The machines whose boxes have these keys.
    private func machinesOf(keys: Set<String>) -> [String] {
        (app?.machines.list.map(\.id) ?? []).filter { machine in app?.phoneLink.key(of: machine).map(keys.contains) == true }
    }

    /// The machine (or this Mac, nil) a box key names, as you know it.
    private func place(_ key: String) -> String?? {
        if key == app?.phoneLink.macKey { return .some(nil) }
        return machinesOf(keys: [key]).first.map { .some($0) }
    }

    /// What the window shows of it all: what's moving where, what's frozen, and the conversations
    /// each computer lists that don't live there.
    private func show() {
        var moving = asked
        var frozen: Set<String> = []
        var away: [String: String?] = [:]
        for (box, said) in told {
            let machine: String? = box == BoxClient.mac ? nil : box
            for move in said.moves {
                frozen.formUnion([move.thing] + move.sessions)
                if move.role == "from", let to = place(move.to) { moving[move.thing] = to }
            }
            for session in said.away { away[session] = .some(machine) }
        }
        if moving != underWay { underWay = moving }
        if frozen != Self.frozen { Self.frozen = frozen }
        if app?.workspace.movedAway != away { app?.workspace.movedAway = away }
    }

    private func client(_ box: String) -> BoxClient? {
        boxes?(box) ?? app?.box(box)
    }
}

private extension Moves.BoxMoves.Move {
    /// The other box's key.
    var peer: String { role == "from" ? to : from }
}
