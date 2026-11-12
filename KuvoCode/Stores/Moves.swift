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
    /// `frozen`, observed: what's shown of it (a menu's items off) changes as it does, and a test
    /// waits on it (the static one isn't observed).
    private(set) var held: Set<String> = []
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
        /// What of it stays on that box as it moves.
        var stays: MoveWords.Stays? = nil
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
        /// The computer it waits for, by name, while that one has gone quiet (its box says so, or
        /// the box holding the move can't be read): nothing of it moves until it's back.
        var waitingFor: String?
        /// "Moving to lab… 12 of 30 MB", or "Waiting for lab".
        var words: String { waitingFor.map { MoveWords.waiting(for: $0) } ?? MoveWords.status(stage: stage, place: place, sent: sent, size: size) }
        /// The same for VoiceOver, with what comes next while it waits.
        var spoken: String { waitingFor.map { MoveWords.waitingSpoken(for: $0, place: place) } ?? words }
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

    /// What moves that are over still hold, until it's shown where it lives now, and the box each
    /// went to (this Mac's or a machine's id): where that box lists it, that's where it is (it's
    /// held only so it isn't let go of meanwhile as gone). The box it left may list it a while yet.
    private(set) static var arriving: [String: String] = [:]

    /// Conversations carrying on with the coding agents now (`Workspace.moveToAgents`): what you
    /// send stays in the composer, and goes to the new session with the rest of what you wrote.
    static var toAgents: Set<String> = []

    /// Throws when something sent to `id` can't go now: it's moving, to another computer or to
    /// the coding agents.
    static func checkNotMoving(_ id: String) throws {
        if isFrozen(id) { throw Failure.moving }
        if toAgents.contains(id) { throw Failure.movingToAgents }
    }

    enum Failure: LocalizedError {
        case notConnected(String)
        /// A machine whose box doesn't talk to your other computers yet.
        case needsUpdate(String)
        /// What the box said.
        case refused(String)
        /// The connection to its box lost before it answered: what that box says now.
        case lost(String, words: String)
        /// Something sent to one that's moving.
        case moving
        /// Something sent to one carrying on with the coding agents.
        case movingToAgents
        var errorDescription: String? {
            switch self {
            case .notConnected(let place): "\(place) isn’t connected. Connect to it, then try again."
            case .needsUpdate(let place): "\(place) needs a newer Kuvo Code before things can move to or from it. It updates by itself overnight, or connect to it from this Mac."
            case .refused(let message): message
            case .lost(let place, _): "Lost touch with \(place)"
            case .moving: "It’s moving to another computer. Try again once it’s there."
            case .movingToAgents: "It’s moving to the coding agents. What you wrote goes with it: send it once it’s there."
            }
        }
        var recoverySuggestion: String? {
            if case .lost(_, let words) = self { words } else { nil }
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
            /// Its other computer has gone quiet about it a while (on the box it leaves).
            var waiting: Bool?
        }
        var moves: [Move]
        var away: [String]
        /// The conversations that moved away from that box lately (two days), and where each went:
        /// rows of them from that box, listed before they moved, go (bridge 0.9.208).
        var moved: [Moved]?

        struct Moved: Decodable, Equatable {
            var session: String
            /// The box it went to.
            var key: String
            var at: Double
        }
        /// Your other computers' moves, as each told this box: a machine's box answers this Mac
        /// over SSH only when asked, so one that's moving is read from here.
        var elsewhere: [Elsewhere]?

        struct Elsewhere: Decodable, Equatable {
            /// The box's key.
            var box: String
            var moves: [Move]
        }
    }

    // COMPAT(0.7 mac-moves-under-way): moves an earlier Kuvo Code ran itself, forgotten (its boxes lift what they left held). Goes 3 months after 0.8.0.
    init() {
        UserDefaults.standard.removeObject(forKey: "movesUnderWay")
    }

    func isMoving(_ id: String) -> Bool { underWay[id] != nil }

    /// Moving, or just moved and not yet shown where it lives now: what would change it waits.
    func isHeld(_ id: String) -> Bool { isMoving(id) || held.contains(id) }

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

    /// What of `id` stays on the box it lives on as it moves, as that box last said with its places.
    func stays(of id: String, from machine: String?) -> MoveWords.Stays? {
        places[id].flatMap { $0.box == (machine ?? BoxClient.mac) ? $0.stays : nil }
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
        struct Answer: Decodable { var places: [Place]; var stays: MoveWords.Stays? }
        let query = "kind=\(kind)&id=" + (id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)
        guard let answer = try? await client.value(Answer.self, "GET", "kuvo/moves/places?" + query) else { return nil }
        return (answer.places, Heard(known: Known(box: box, list: answer.places, stays: answer.stays), read: read))
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
            let chats = app.workspace.sessions.filter { $0.parentID == nil && Workspace.isChat($0) && !Workspace.isArchived($0) }
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
        } catch where !(error is CancellationError) {
            // Lost on the way (the connection went): the boxes see it through all the same, and
            // whether it's moving is as its box says now.
            let said = try? await source.value(BoxMoves.self, "GET", "kuvo/moves")
            await reload(box)
            let place = from.map(placeName) ?? "this Mac’s background work"
            throw Failure.lost(place, words: MoveWords.lost(from: place, moving: said.map { $0.moves.contains { $0.thing == id && $0.role == "from" } }))
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
        // (Only the app's own box streams them: one attached in place is read as a machine's is,
        // as it connects and while something's moving.)
        guard BoxClient.streams(BoxClient.thisMac) else { return }
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
    /// Each box's latest read, which one before it waits for.
    @ObservationIgnored private var latest: [String: Task<Void, Never>] = [:]
    /// What moves just over hold (each move's, by the end that said so), until they're shown where
    /// they live now.
    @ObservationIgnored private var settling: [String: (things: [String], to: String?)] = [:]
    /// Boxes whose moves couldn't be read last time (a machine out of reach): what they said stands.
    @ObservationIgnored private var unread: Set<String> = []
    /// Moves a box said were over: one end saying so is enough, whatever a box out of reach said.
    @ObservationIgnored private var endedMoves: Set<String> = []
    /// Machines read again every few seconds while they say something's moving (a machine's box
    /// answers this Mac once over SSH, not as it changes).
    @ObservationIgnored private var rereading: [String: Task<Void, Never>] = [:]

    /// What `box` (this Mac's, or a machine's id) says of its moves now. Read again meanwhile, it
    /// returns once that's taken: what's moving is known then, as its callers expect.
    func reload(_ box: String) async {
        guard let app, let client = client(box) else { return }
        // A machine out of reach for now: what it said last stands (a move isn't over for that).
        // (This Mac's box, attached in place too, is reached with no connection.)
        if !BoxClient.isThisMac(box), boxes == nil, app.machines.engine(box)?.isReady != true {
            // (A read begun before isn't taken: it would say it's back.)
            reads[box, default: 0] += 1
            return outOfReach(box)
        }
        reads[box, default: 0] += 1
        let read = reads[box]
        let reading = Task {
            let said = try? await client.value(BoxMoves.self, "GET", "kuvo/moves")
            guard reads[box] == read else { return }
            // Nor a read that failed (its connection dropped, say).
            guard let said else { return outOfReach(box) }
            // Back: what's moving from it no longer waits for it (said the same, `take` shows nothing).
            let back = unread.remove(box) != nil
            take(said, from: box)
            if back { show() }
        }
        latest[box] = reading
        var waited = reading
        await reading.value
        while let newer = latest[box], newer != waited {
            waited = newer
            await newer.value
        }
    }

    /// Each machine's moves read again (as the app starts, or a machine connects).
    func reloadAll() async {
        // (Attached in place, this Mac's box is one of the machines.)
        if BoxClient.thisMac == BoxClient.mac { await reload(BoxClient.mac) }
        for machine in app?.machines.list.map(\.id) ?? [] { await reload(machine) }
        readPlacesAhead()
    }

    /// A machine you removed: what it said goes.
    func forget(_ machine: String) {
        rereading.removeValue(forKey: machine)?.cancel()
        unread.remove(machine)
        take(nil, from: machine)
    }

    /// A box whose moves can't be read now: what it said stands, but for moves over at their other
    /// end (it may have restarted mid-move, and won't say so until it's back).
    private func outOfReach(_ box: String) {
        let newly = unread.insert(box).inserted
        // (What's moving from it now waits for it.)
        if dropEnded() || newly { show() }
    }

    /// Moves over at one end left out of what boxes out of reach said last. Whether any were.
    private func dropEnded() -> Bool {
        var dropped = false
        for box in unread where told[box]?.moves.contains(where: { endedMoves.contains($0.id) }) == true {
            told[box]?.moves.removeAll { endedMoves.contains($0.id) }
            dropped = true
        }
        return dropped
    }

    private func take(_ said: BoxMoves?, from box: String) {
        let before = told[box]
        if before == said { return }
        told[box] = said
        let over = (before?.moves ?? []).filter { old in !(said?.moves ?? []).contains { $0.id == old.id } }
        endedMoves.formUnion(over.map(\.id))
        // A move that's back under way (taken again) isn't over.
        endedMoves.subtract((said?.moves ?? []).map(\.id))
        _ = dropEnded()
        // Held a moment longer, until each is shown where it lives now: what's here of it (a bot's
        // draft) isn't let go of meanwhile as gone, its box saying it no longer has it.
        for move in over {
            let to = place(move.to).map { $0 ?? BoxClient.thisMac }
            settling[box + " " + move.id] = ([move.thing] + move.sessions, to)
            // (A minute at most, should a computer at its other end not answer: what waits to go
            // to it isn't held for ever.)
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(60))
                self?.settled(move, on: box)
            }
        }
        show()
        if !BoxClient.streams(box) { keepReading(box) }
        // A machine whose moves started, went on or ended, as it told this Mac's box: read there.
        if box == BoxClient.mac {
            // (One of this Mac's own is read through its own list: each move once.)
            let stages = { (said: BoxMoves?) in
                let own = Set((said?.moves ?? []).map(\.id))
                return Dictionary((said?.elsewhere ?? []).map { ($0.box, Set($0.moves.filter { !own.contains($0.id) }.map { $0.id + " " + $0.stage })) }) { $1 }
            }
            let (then, now) = (stages(before), stages(said))
            let changed = Set(then.keys).union(now.keys).filter { then[$0] ?? [] != now[$0] ?? [] }
            if !changed.isEmpty {
                Task {
                    for machine in machinesOf(keys: changed) {
                        await reload(machine)
                        // And again while it's said to be moving, should that read not have come.
                        keepReading(machine)
                    }
                }
            }
        }
        // What changed of its moves (not how far one's copy went): the boxes at their other ends read
        // too, and one that's over shown where it is now.
        let stages = { (moves: [BoxMoves.Move]) in Set(moves.map { $0.id + " " + $0.stage }) }
        guard stages(before?.moves ?? []) != stages(said?.moves ?? []) else { return }
        let ends = Set(((said?.moves ?? []) + (before?.moves ?? [])).map(\.peer))
        // Where they can go changed with them ("moving already", where one lives now): read again,
        // and the things that moved shown as they are once their boxes say (they may live elsewhere).
        // A bot's move changes where group chats can go too (to a machine only where their bots
        // live), and a group chat's where its bots can; everything else's is as it was.
        let moved = Set(((said?.moves ?? []) + (before?.moves ?? [])).flatMap { [$0.thing] + $0.sessions })
        for id in moved { placesRead[id] = nil }
        if ((said?.moves ?? []) + (before?.moves ?? [])).contains(where: { $0.kind == "bot" }) {
            for chat in app?.chats.list ?? [] { placesRead[chat.id] = nil }
        }
        if ((said?.moves ?? []) + (before?.moves ?? [])).contains(where: { $0.kind == "group" }) {
            for bot in app?.bots.list ?? [] { placesRead[bot.id] = nil }
        }
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
        let heard = app?.phoneLink.key(of: machine).map { key in told[BoxClient.thisMac]?.elsewhere?.contains { $0.box == key && !$0.moves.isEmpty } == true } ?? false
        guard told[machine]?.moves.isEmpty == false || heard else {
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
    /// so it shows where it lives now, its wake-ups with it. What it held is let go of once the
    /// lists are read, not after its wake-ups.
    private func ended(_ move: BoxMoves.Move, on box: String) async {
        guard let app else { return }
        defer { settled(move, on: box) }
        let here: String? = box == BoxClient.mac ? nil : box
        // Where it lives now read first: listed nowhere for a moment, what's here of it would go.
        var ends: [String?] = [here]
        if let there = place(move.peer) { ends.insert(there, at: move.role == "from" ? 0 : 1) }
        switch move.kind {
        case "bot":
            for end in ends { await app.bots.refresh(end ?? BoxClient.thisMac) }
            // Its conversation too, on both: a coding agent's (on the agents bridges) as well.
            await rereadSessions(on: ends)
            settled(move, on: box)
            // Its tabs here go with it, once it doesn't live here.
            let bot = app.bots.bot(move.thing)
            if bot.map({ $0.machine != nil }) ?? true { app.utilities.closeTabs(of: move.thing, refills: bot != nil) }
            app.wakeUps.forget(key: move.thing)
            if let bot = app.bots.bot(move.thing) { await app.wakeUps.read(bot.wakeOwner) }
        case "chat":
            await rereadSessions(on: ends)
            settled(move, on: box)
            app.wakeUps.forget(key: move.thing)
            if let chat = app.workspace.session(move.thing) { await app.wakeUps.read(WakeUps.owner(of: chat)) }
        default:
            for end in ends { await app.boxGroups.reload(move.thing, on: end) }
        }
    }

    /// The conversations each end lists (nil: this Mac), its engine's and its coding agents'.
    private func rereadSessions(on ends: [String?]) async {
        guard let app else { return }
        for end in ends {
            if let end {
                if let engine = app.machines.engine(end) { _ = await app.workspace.refresh(engine) }
            } else {
                await app.workspace.refresh()
                await app.workspace.refreshAgents()
            }
        }
    }

    /// A move's things no longer held for it by `box`, one of its ends (each end's saying it's over
    /// holds them until that end's lists are read; once only, as the minute's cap may come first).
    private func settled(_ move: BoxMoves.Move, on box: String) {
        guard settling.removeValue(forKey: box + " " + move.id) != nil else { return }
        show()
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
        var frozen = Set(settling.values.flatMap(\.things))
        var away: [String: Set<String>] = [:]
        var copies: [String: Set<String>] = [:]
        // What this Mac's own box has coming here: it says itself whether it hears from where it comes.
        let incoming = Dictionary((told[BoxClient.thisMac]?.moves ?? []).filter { $0.role == "to" }.map { ($0.id, $0) }) { $1 }
        // What a box read now says of a thing wins over what one out of reach said last (it's taken last).
        for (box, said) in told.sorted(by: { unread.contains($0.key) && !unread.contains($1.key) }) {
            let machine: String? = box == BoxClient.mac ? nil : box
            for move in said.moves {
                frozen.formUnion([move.thing] + move.sessions)
                guard move.role == "from" else { continue }
                // Its name as the box says it, else as this Mac knows the machine.
                let name = move.to == app?.phoneLink.macKey ? "this Mac" : move.place ?? place(move.to).map { $0.map(placeName) ?? "this Mac" } ?? "another computer"
                // Waiting for the machine it leaves: coming here, as this Mac's box says; going elsewhere,
                // while that machine is away (what it said last stands meanwhile). Or for the one it's
                // going to, quiet, as the box it leaves says (never this Mac: its own box says).
                let waiting: String? = if let coming = incoming[move.id] {
                    coming.waiting == true ? coming.place ?? placeName(machine) : nil
                } else if let machine, isAway(machine) {
                    placeName(machine)
                } else if move.waiting == true, move.to != app?.phoneLink.macKey {
                    name
                } else {
                    nil
                }
                // (How much of it came here, as this Mac's box says, when that's further: the machine's
                // word may be old.)
                let sent = incoming[move.id]?.sent.map { max($0, move.sent ?? 0) } ?? move.sent
                moving[move.thing] = Going(place: name, stage: move.stage, sent: sent, size: move.size, waitingFor: waiting)
            }
            // Each box's own word: one away from two boxes at once is away from both.
            for session in said.away + (said.moved ?? []).map(\.session) { away[session, default: []].insert(box) }
            for move in said.moves where move.role == "to" {
                for session in move.sessions where said.away.contains(session) { copies[session, default: []].insert(box) }
            }
        }
        // Coming here from a machine that's away and hasn't said what it moves (not since this app
        // started, say): as this Mac's box has it.
        for move in incoming.values where moving[move.thing] == nil {
            guard case let machine?? = place(move.from), move.waiting == true || isAway(machine) else { continue }
            moving[move.thing] = Going(place: "this Mac", stage: move.stage, sent: move.sent, size: move.size, waitingFor: move.place ?? placeName(machine))
        }
        if moving != underWay { underWay = moving }
        var arriving: [String: String] = [:]
        for (things, to) in settling.values { if let to { for thing in things { arriving[thing] = to } } }
        if arriving != Self.arriving { Self.arriving = arriving }
        if frozen != Self.frozen { Self.frozen = frozen }
        if frozen != held { held = frozen }
        if let app, app.workspace.comingCopies != copies { app.workspace.comingCopies = copies }
        if let app, app.workspace.movedAway != away {
            // A box that no longer says one doesn't live there (it came back, or its copy there was
            // let go of): its list read again, which left it out till now.
            let before = app.workspace.movedAway
            let back = Set(before.flatMap { session, boxes in boxes.subtracting(away[session] ?? []) })
            app.workspace.movedAway = away
            if !back.isEmpty { Task { await rereadSessions(on: back.sorted().map { $0 == BoxClient.mac ? nil : $0 }) } }
        }
    }

    /// A machine out of reach, its moves unread: not a read that failed a moment (its connection up).
    private func isAway(_ machine: String) -> Bool {
        unread.contains(machine) && app?.machines.engine(machine)?.isReady != true
    }

    private func client(_ box: String) -> BoxClient? {
        boxes?(box) ?? app?.box(box)
    }
}

private extension Moves.BoxMoves.Move {
    /// The other box's key.
    var peer: String { role == "from" ? to : from }
}
