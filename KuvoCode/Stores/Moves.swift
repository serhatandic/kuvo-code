import ClientDesign
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
    /// What's moving now, a bot's ID, a chat's session ID or a group chat's ID, where to and how far
    /// it is: its row says so.
    private(set) var underWay: [String: Going] = [:]
    @ObservationIgnored weak var app: AppModel?
    /// A box's routes (a test's own), else the app's.
    @ObservationIgnored var boxes: ((String) -> BoxClient)?

    /// What each box says is moving there (by "mac" or a machine's id), and its conversations that
    /// don't live there.
    @ObservationIgnored private var told: [String: BoxMoves] = [:]
    /// Moves asked for from here, until their box answers: shown at once, before it says so.
    @ObservationIgnored private var asked: [String: Going] = [:]

    /// Where each thing can go, as the box it lives on last said (`kuvo/moves/places`), by its ID:
    /// its Move to Computer menu. Set only when what a box says differs, since every row's menu
    /// reads it: reading the same again draws nothing (it's read ahead, as the panel slides in, say).
    private var places: [String: Known] = [:]
    private struct Known: Equatable {
        /// The box that said it.
        var box: String
        var list: [Place]
    }
    /// When each thing's places were last read: they're kept for its menu a while.
    @ObservationIgnored private var placesRead: [String: Date] = [:]
    /// Each thing's reads of its places, numbered.
    @ObservationIgnored private var placeReads: [String: Int] = [:]
    /// The read of each thing's places kept last (or begun last as it moved): older ones aren't.
    @ObservationIgnored private var placesKept: [String: Int] = [:]
    @ObservationIgnored private var prefetching: Task<Void, Never>?

    /// A move of something, as its row shows it: the computer it's going to, by name, and how far.
    struct Going: Equatable {
        var place: String
        var stage = "holding"
        var sent: Int?
        var size: Int?
        /// "Moving to lab… 12 of 30 MB".
        var words: String { MoveWords.status(stage: stage, place: place, sent: sent, size: size) }
    }

    /// A computer something can go to, as the box it lives on says: its box's key, its name, and
    /// whether it can go there now (with why not).
    struct Place: Decodable, Equatable, Hashable {
        var key: String
        var name: String
        var kind: String
        var ok: Bool
        var why: String?
        /// The same, in a few words, for beside its name.
        var note: String?
    }

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
            /// The other computer's name, when its box knows it.
            var place: String?
            var sent: Int?
            var size: Int?
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

    #if DEBUG
    /// `KUVO_DEMO_MOVES`: moves on their way and places, as boxes would say them (`DemoMoves`).
    func showDemo(going: [String: Going] = [:], places demo: [String: (machine: String?, list: [Place])] = [:]) {
        asked.merge(going) { _, new in new }
        for (id, known) in demo {
            places[id] = Known(box: known.machine ?? BoxClient.mac, list: known.list)
            placesRead[id] = .distantFuture
        }
        show()
    }
    #endif

    // MARK: Where it can go

    /// Where `id` can go from the box it lives on (`machine`, nil: this Mac), as that box last said,
    /// if it has lately.
    func places(of id: String, from machine: String?) -> [Place]? {
        places[id].flatMap { $0.box == (machine ?? BoxClient.mac) ? $0.list : nil }
    }

    /// Where `id` can go from the box it lives on (`machine`, nil: this Mac), as that box says now;
    /// kept for its menu a while. Nil when it can't be asked (`whyNotAsked`), or didn't answer.
    @discardableResult
    func loadPlaces(_ kind: String, _ id: String, from machine: String?, fresh: Bool = false) async -> [Place]? {
        guard let read = await readPlaces(kind, id, from: machine, fresh: fresh) else { return nil }
        if let heard = read.heard { keep([id: heard]) }
        return read.list
    }

    /// A box's answer, numbered among its thing's reads, to keep once it's heard.
    private struct Heard {
        var known: Known
        var read: Int
        var at = Date.now
    }

    /// Where `id` can go, as kept still (a while), or as its box says now: then `heard`, to keep.
    private func readPlaces(_ kind: String, _ id: String, from machine: String?, fresh: Bool) async -> (list: [Place], heard: Heard?)? {
        let box = machine ?? BoxClient.mac
        if !fresh, let known = places[id], known.box == box, let read = placesRead[id], Date.now.timeIntervalSince(read) < 30 { return (known.list, nil) }
        guard whyNotAsked(from: machine) == nil, let client = client(box) else { return nil }
        placeReads[id, default: 0] += 1
        let read = placeReads[id, default: 0]
        struct Answer: Decodable { var places: [Place] }
        let query = "kind=\(kind)&id=" + (id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)
        guard let answer = try? await client.value(Answer.self, "GET", "kuvo/moves/places?" + query) else { return nil }
        return (answer.places, Heard(known: Known(box: box, list: answer.places), read: read))
    }

    /// What boxes said of where things can go, kept all at once and only where it differs, since
    /// every row's menu reads it; an answer older than one kept already isn't.
    private func keep(_ heard: [String: Heard]) {
        var next = places
        for (id, said) in heard where said.read > placesKept[id, default: 0] {
            placesKept[id] = said.read
            placesRead[id] = said.at
            next[id] = said.known
        }
        if next != places { places = next }
    }

    /// The bots', chats' and group chats' places, read ahead so their menus open with them (a menu
    /// that's open isn't drawn again): as Kuvo Code starts or a machine connects, and as moves change.
    /// Kept once each box's are read (or as far as they got, when read ahead again), so the sidebar
    /// is drawn again once a box at most, and not at all when nothing changed.
    private func readPlacesAhead() {
        prefetching?.cancel()
        prefetching = Task { [weak self] in
            guard let app = self?.app else { return }
            let chats = app.workspace.sessions.filter { $0.parentID == nil && Workspace.isChat($0.location.directory) && !Workspace.isArchived($0) }
            let things = app.bots.list.map { ("bot", $0.id, $0.machine) } + app.chats.list.map { ("group", $0.id, app.chats.machine(of: $0.id)) }
                + chats.map { ("chat", $0.id, RemoteFolder.machine(of: $0.location.directory)) }
            let byBox = things.sorted { ($0.2 ?? "") < ($1.2 ?? "") }
            var heard: [String: Heard] = [:]
            for (index, (kind, id, machine)) in byBox.enumerated() {
                guard !Task.isCancelled, let self else { break }
                heard[id] = await self.readPlaces(kind, id, from: machine, fresh: false)?.heard
                if index == byBox.count - 1 || byBox[index + 1].2 != machine {
                    self.keep(heard)
                    heard = [:]
                }
            }
            self?.keep(heard)
        }
    }

    /// Why the box of `machine` can't be asked to move something now (this Mac's, nil, always can:
    /// it says itself why not).
    func whyNotAsked(from machine: String?) -> String? {
        machine.flatMap(cantAsk)?.errorDescription
    }

    /// This Mac reaches a machine's box over SSH, one another Mac set up too (it says itself what
    /// it can move).
    private func cantAsk(_ machine: String) -> Failure? {
        guard let app else { return nil }
        let name = placeName(machine)
        if app.machines.engine(machine)?.isReady != true { return .notConnected(name) }
        if !app.phoneLink.machineIsAnotherMacs(machine), app.phoneLink.key(of: machine) == nil { return .needsUpdate(name) }
        return nil
    }

    /// Your other computers this Mac knows of, for a menu opened before its box has said (each is
    /// asked again as it's picked): this Mac, and each machine you added (one whose box is from
    /// before moves, with why). One another Mac set up is that Mac's to tell: the box says.
    func knownPlaces(from machine: String?) -> [Place] {
        guard let app else { return [] }
        var known: [Place] = []
        if machine != nil, let key = app.phoneLink.macKey { known.append(Place(key: key, name: PhoneLink.computerName, kind: "mac", ok: true)) }
        for other in app.machines.list where other.id != machine {
            let name = placeName(other.id)
            if app.phoneLink.machineIsAnotherMacs(other.id) {
                continue
            } else if let key = app.phoneLink.key(of: other.id) {
                known.append(Place(key: key, name: name, kind: "machine", ok: true))
            } else {
                known.append(Place(key: "?" + other.id, name: name, kind: "machine", ok: false, why: Failure.needsUpdate(name).errorDescription, note: "Needs a newer Kuvo Code"))
            }
        }
        return known
    }

    // MARK: Moving

    /// A bot, a chat or a group chat to this Mac (nil) or one of your machines, by its id.
    func move(bot id: String, to machine: String?) async throws {
        guard let bot = app?.bots.bot(id), bot.machine != machine, let key = try boxKey(of: machine) else { return }
        try await move("bot", id, from: bot.machine, to: Place(key: key, name: machine.map(placeName) ?? "this Mac", kind: machine == nil ? "mac" : "machine", ok: true))
    }

    func move(chat id: String, to machine: String?) async throws {
        guard let chat = app?.workspace.session(id) else { return }
        let from = RemoteFolder.machine(of: chat.location.directory)
        guard from != machine, let key = try boxKey(of: machine) else { return }
        try await move("chat", id, from: from, to: Place(key: key, name: machine.map(placeName) ?? "this Mac", kind: machine == nil ? "mac" : "machine", ok: true))
    }

    func move(group id: String, to machine: String?) async throws {
        let from = app?.boxGroups.machine(of: id)
        guard from != machine, let key = try boxKey(of: machine) else { return }
        try await move("group", id, from: from, to: Place(key: key, name: machine.map(placeName) ?? "this Mac", kind: machine == nil ? "mac" : "machine", ok: true))
    }

    /// Asks the box it lives on (`from`, nil: this Mac) to move it to `place`, and waits until it's
    /// there (or why not); then it's shown where it went (`ended`), as a move asked from elsewhere is.
    func move(_ kind: String, _ id: String, from: String?, to place: Place) async throws {
        if let failure = from.flatMap(cantAsk) { throw failure }
        guard underWay[id] == nil else { throw Failure.moving }
        let own = if let from { app?.phoneLink.key(of: from) } else { app?.phoneLink.macKey }
        if place.key == own { throw Failure.refused("It’s on \(place.name) already.") }
        let key = place.key
        asked[id] = Going(place: place.name)
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
        let events = ["bot": "bot_moved", "chat": "chat_moved_computer", "group": "group_moved"]
        if let event = events[kind] { Analytics.shared.track(event, ["to": place.kind == "mac" ? "mac" : "machine"]) }
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
        if let failure = cantAsk(machine) { throw failure }
        return app.phoneLink.key(of: machine)
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
        readPlacesAhead()
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
        // Where things can go changed with them ("moving already", where one lives now): read again,
        // and the things that moved shown as they are once their boxes say (they may live elsewhere).
        placesRead = [:]
        let moved = Set(((said?.moves ?? []) + (before?.moves ?? [])).flatMap { [$0.thing] + $0.sessions })
        // Reads begun before aren't kept: they'd say where those could go from where they were.
        for id in moved { placesKept[id] = placeReads[id, default: 0] }
        if places.keys.contains(where: moved.contains) { places = places.filter { !moved.contains($0.key) } }
        readPlacesAhead()
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
                guard move.role == "from" else { continue }
                // Its name as the box says it, else as this Mac knows the machine.
                let name = move.to == app?.phoneLink.macKey ? "this Mac" : move.place ?? place(move.to).map { $0.map(placeName) ?? "this Mac" } ?? "another computer"
                moving[move.thing] = Going(place: name, stage: move.stage, sent: move.sent, size: move.size)
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
