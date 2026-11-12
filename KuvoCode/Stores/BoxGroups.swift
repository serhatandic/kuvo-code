import Foundation
import KuvoLink
import OpenCodeKit
import os

/// What a chat says now, for the window: one object a chat, so what one of them says redraws only
/// what shows that chat.
@MainActor @Observable
final class GroupLive {
    var messages: [GroupMessage] = []
    var speaking: String?
    var discussing = false
    var paused = false
    /// What the bot talking is doing (see `GroupActivity`).
    var activity: [GroupActivity] = []
    /// The bots whose part waits on their conversation, stopped by you.
    var stopped: Set<String> = []
}

/// A bridge event's `data`.
private struct EventData<Value: Decodable>: Decodable {
    var data: Value
}

/// Your group chats, wherever they live. Each computer's coding agents' bridge runs its own
/// (`Packages/Box/src/agents/groups`): this Mac's as a machine's, so they talk, meet and hand out work with
/// no window open, and a machine's with this Mac off. The window shows them from what each
/// computer says of them as they go (its bridge's event feed), and sends there what you do in
/// them. What it last saw of each is kept here, so they show while their computer is away or
/// this Mac's bridge is starting. It holds no rules of its own: what can be, and what comes of
/// it, is the box's to say.
@MainActor @Observable
final class BoxGroups {
    /// A chat as its computer last said it.
    struct Chat: Codable, Hashable {
        /// The machine it lives on; nil for this Mac.
        var machine: String?
        var group: BotGroup
        /// Brought there by a move, not started yet (or held there for a move away).
        var held: Bool
        var speaking: String?
        var discussing: Bool
        var paused: Bool
    }

    /// What's kept of each computer's chats, one entry per chat on each (a chat moving is on two).
    private(set) var chats: [Chat] = [] {
        didSet { reindex() }
    }
    /// Each chat once, as the window shows it (of two copies, the one started, else the one it's
    /// leaving), and who's talking where: worked out once each time what's kept changes, as the
    /// window reads them for every row of every frame.
    @ObservationIgnored private(set) var shown: [Chat] = []
    @ObservationIgnored private var byID: [String: Chat] = [:]
    /// The chats as the window lists them: the window hears of a change only when something it
    /// shows of one changes, not with each turn's bookkeeping (who heard what, a bot's seat),
    /// which comes with nearly every word a chat's computer says of it.
    var groups: [BotGroup] {
        access(keyPath: \.groups)
        return listed
    }
    @ObservationIgnored private var listed: [BotGroup] = []
    @ObservationIgnored private var groupsByID: [String: BotGroup] = [:]
    /// Where each lives (a machine; none for this Mac).
    private var machines: [String: String] = [:]
    /// Each chat's messages as kept, by ID (one read whole has an entry, even empty); the window
    /// reads them from each chat's `GroupLive`.
    @ObservationIgnored private var logs: [String: [GroupMessage]] = [:]
    /// What each chat says now, for the window, one object a chat: what one of them says redraws
    /// only what shows that chat (its conversation, its row, its tab), not every chat's.
    @ObservationIgnored private var live: [String: GroupLive] = [:]
    /// Machines whose bridge runs group chats (an older one doesn't yet).
    private(set) var running: Set<String> = []
    @ObservationIgnored weak var app: AppModel?
    /// Whether a box tells its own news (`BoxNotices`), by its id: a group chat's isn't worded here then.
    @ObservationIgnored var boxTellsNews: ((String) -> Bool)?
    /// The settings each computer was last given, so they go again only when they change.
    @ObservationIgnored private var settingsGiven: [String: Data] = [:]
    /// Chats being read whole now, and what their computer said of them meanwhile, so the read
    /// (from before) doesn't take it away.
    @ObservationIgnored private var arriving: [String: [GroupMessage]] = [:]
    /// Reads of a chat's messages under way, by computer and ID: what arrives is kept until the
    /// last is through.
    @ObservationIgnored private var reloading: [Read: Int] = [:]
    /// Chats being read whole whose computer said meanwhile how they are now (changed or gone),
    /// which the read, from before, doesn't take back. Another computer's word (the one a chat
    /// leaves as it moves) isn't the one being read's.
    @ObservationIgnored private var touchedWhileReading: Set<Read> = []
    /// A chat on one computer.
    private struct Read: Hashable { var machine: String?; var id: String }
    /// Chats a computer said something of (changed or gone) while its list was being read.
    @ObservationIgnored private var touchedWhileListing: [String: Set<String>] = [:]
    private let log = Logger(subsystem: "run.kuvo.code", category: "box-groups")

    static var file: URL { AppInfo.supportDirectory.appending(path: "group-chats.json") }
    static var folder: URL { AppInfo.supportDirectory.appending(path: "group-chats") }
    // COMPAT(0.7 machine-group-cache): `machine-groups.json` (0.7.0 to 0.8.0-beta.1). Goes 3 months after 0.8.0.
    /// Where 0.8.0-beta.1 kept what it saw of machines' chats.
    private static var oldFile: URL { AppInfo.supportDirectory.appending(path: "machine-groups.json") }
    private static var oldFolder: URL { AppInfo.supportDirectory.appending(path: "machine-groups") }

    init() {
        // COMPAT(0.7 machine-group-cache): `machine-groups.json` taken in. Goes 3 months after 0.8.0.
        Self.takeOldCache()
        // As last seen: nothing's talking until its computer says so.
        chats = (JSONFile.read([Chat].self, from: Self.file, isoDates: true) ?? []).map { chat in
            var chat = chat
            chat.discussing = false
            chat.speaking = nil
            return chat
        }
        for id in Set(chats.map(\.group.id)) { setLog(id, JSONFile.read([GroupMessage].self, from: Self.folder.appending(path: "\(id).json"), isoDates: true) ?? []) }
        // (An observer doesn't run for what's set in `init`.)
        reindex()
    }

    // COMPAT(0.7 machine-group-cache): `machine-groups.json` taken in. Goes 3 months after 0.8.0.
    /// What 0.8.0-beta.1 kept of machines' chats (`machine-groups.json`, and their messages), taken
    /// into what's kept now, alongside what's there (this Mac's own, seeded as they moved), then
    /// gone.
    static func takeOldCache() {
        let manager = FileManager.default
        guard manager.fileExists(atPath: oldFile.path) else { return }
        let old = JSONFile.read([Chat].self, from: oldFile, isoDates: true) ?? []
        var kept = JSONFile.read([Chat].self, from: file, isoDates: true) ?? []
        for chat in old where !kept.contains(where: { $0.group.id == chat.group.id && $0.machine == chat.machine }) { kept.append(chat) }
        guard JSONFile.write(kept, to: file, isoDates: true, readable: true) else { return }
        try? manager.createDirectory(at: folder, withIntermediateDirectories: true)
        for chat in old {
            let from = oldFolder.appending(path: "\(chat.group.id).json"), to = folder.appending(path: "\(chat.group.id).json")
            if !manager.fileExists(atPath: to.path) { try? manager.moveItem(at: from, to: to) }
        }
        try? manager.removeItem(at: oldFolder)
        try? manager.removeItem(at: oldFile)
    }

    /// A computer as a key: "" for this Mac (a machine's ID is never empty).
    private static func key(_ machine: String?) -> String { machine ?? "" }

    // MARK: Reading

    func has(_ id: String?) -> Bool { id.map { byID[$0] != nil } ?? false }
    /// The chat by its ID, as the window shows it: of two copies (it's moving), the one started,
    /// else the one it's leaving.
    func chat(_ id: String?) -> Chat? { id.flatMap { byID[$0] } }

    private func reindex() {
        var byID: [String: Chat] = [:]
        var order: [String] = []
        for chat in chats {
            if let kept = byID[chat.group.id] {
                if kept.held, !chat.held { byID[chat.group.id] = chat }
            } else {
                byID[chat.group.id] = chat
                order.append(chat.group.id)
            }
        }
        self.byID = byID
        let shown = order.compactMap { byID[$0] }
        self.shown = shown
        let groups = shown.map(\.group)
        if groups != listed {
            let news = !Self.sameAsShown(groups, listed)
            let byID = Dictionary(groups.map { ($0.id, $0) }) { first, _ in first }
            if news {
                withMutation(keyPath: \.groups) {
                    listed = groups
                    groupsByID = byID
                }
            } else {
                listed = groups
                groupsByID = byID
            }
        }
        let machines = Dictionary(shown.compactMap { chat in chat.machine.map { (chat.group.id, $0) } }) { first, _ in first }
        if machines != self.machines { self.machines = machines }
        // Each chat's own: who's talking, whether it's talking it over or paused. (A chat not
        // shown any more says none.)
        for id in Set(live.keys).union(byID.keys) {
            let chat = byID[id]
            let live = live(id)
            if live.speaking != chat?.speaking { live.speaking = chat?.speaking }
            if live.discussing != (chat?.discussing ?? false) { live.discussing = chat?.discussing ?? false }
            if live.paused != (chat?.paused ?? false) { live.paused = chat?.paused ?? false }
        }
    }

    /// The same as the window shows them: what differs is only a turn's bookkeeping, which no
    /// view shows (what each bot heard last, its seat, what it was told to set aside).
    private static func sameAsShown(_ a: [BotGroup], _ b: [BotGroup]) -> Bool {
        guard a.count == b.count else { return false }
        func shown(_ group: BotGroup) -> BotGroup {
            var group = group
            group.seats = [:]
            group.heard = [:]
            group.agentSeats = nil
            group.retracted = nil
            return group
        }
        return zip(a, b).allSatisfy { shown($0) == shown($1) }
    }

    /// A chat's own, made the first time it's asked for (a view can follow one before its
    /// computer says anything of it). Never let go of: a view following it hears it come back.
    private func live(_ id: String) -> GroupLive {
        if let kept = live[id] { return kept }
        let made = GroupLive()
        live[id] = made
        return made
    }

    /// A chat's messages as kept (nil: none read, as for one gone), and as the window shows them:
    /// without kinds a newer Kuvo Code says.
    private func setLog(_ id: String, _ messages: [GroupMessage]?) {
        logs[id] = messages
        // Set outright: a message event changes them, so comparing all of them first only costs.
        live(id).messages = (messages ?? []).filter(\.kind.isKnown)
    }

    /// What the bot talking in a chat is doing, as its computer last said (see `GroupActivity`).
    private func setActivity(_ id: String, _ activity: [GroupActivity]) {
        let live = live(id)
        if live.activity != activity { live.activity = activity }
    }

    /// The bots in a chat whose part waits on their conversation, stopped by you, as its computer last said.
    private func setStopped(_ id: String, _ stopped: Set<String>) {
        let live = live(id)
        if live.stopped != stopped { live.stopped = stopped }
    }

    func group(_ id: String?) -> BotGroup? {
        access(keyPath: \.groups)
        return id.flatMap { groupsByID[$0] }
    }
    /// The machine a chat lives on; nil for this Mac's (and for none).
    func machine(of id: String?) -> String? { id.flatMap { machines[$0] } }
    /// A chat's messages: whoever reads them hears of that chat's alone.
    func messages(in id: String) -> [GroupMessage] { live(id).messages }
    /// Who's talking in a chat, its talk under way, Keep Going waiting, what the one talking is
    /// doing: each heard of for that chat alone.
    func speaker(in id: String) -> String? { live(id).speaking }
    func isDiscussing(_ id: String) -> Bool { live(id).discussing }
    func isPaused(_ id: String) -> Bool { live(id).paused }
    func activity(in id: String) -> [GroupActivity] { live(id).activity }
    func stopped(in id: String) -> Set<String> { live(id).stopped }
    /// Every chat's, for what asks of them all (whoever reads one of these hears of every chat).
    var speaking: [String: String] {
        access(keyPath: \.groups)
        return Dictionary(uniqueKeysWithValues: live.compactMap { id, live in live.speaking.map { (id, $0) } })
    }
    var discussing: Set<String> {
        access(keyPath: \.groups)
        return Set(live.filter(\.value.discussing).keys)
    }
    var paused: Set<String> {
        access(keyPath: \.groups)
        return Set(live.filter(\.value.paused).keys)
    }
    func group(seat: String) -> BotGroup? { chats.first { $0.group.seats.values.contains(seat) }?.group }

    var seatIDs: Set<String> { Set(chats.flatMap(\.group.seats.values)) }
    var agentSeatIDs: Set<String> { Set(chats.flatMap { $0.group.agentSeats ?? [] }) }

    /// Talk under way on a machine: its engine isn't started over meanwhile.
    func isTalking(on machine: String) -> Bool { chats.contains { $0.machine == machine && $0.discussing } }

    /// Whether you can reach a chat where it lives now, and if not, why: what you write waits.
    enum Reach: Equatable {
        case ready
        /// This Mac's bridge is starting.
        case starting
        /// This Mac's bridge stopped, and why.
        case stopped(String)
        /// Its machine is away, or its bridge too old to run group chats.
        case away(String)
    }

    func reach(_ id: String) -> Reach {
        access(keyPath: \.groups)
        guard groupsByID[id] != nil else { return .ready }
        return reach(on: machines[id])
    }

    /// Whether a computer's group chats can be reached now: this Mac's (nil), or a machine's.
    func reach(on machine: String?) -> Reach {
        if api(machine) != nil { return .ready }
        guard let machine else { return macReach }
        return .away(machine)
    }

    /// This Mac's bridge: up, starting, or stopped.
    var macReach: Reach {
        if api(nil) != nil { return .ready }
        if let failure = macFailure { return .stopped(failure) }
        return .starting
    }

    /// The machine a chat lives on, while you can't reach it there: what you write waits.
    func unreachable(_ id: String) -> String? {
        if case .away(let machine) = reach(id) { return machine }
        return nil
    }

    // MARK: Following a computer

    /// Its bridge is up: its chats as it has them, and the settings they go by.
    func connected(_ machine: String?) async {
        guard let api = api(machine) else { return }
        await giveSettings(to: machine)
        let key = Self.key(machine)
        let listed: [Listed]
        touchedWhileListing[key] = []
        defer { touchedWhileListing[key] = nil }
        do {
            listed = try await api.boxGroups()
        } catch let error as ServerError where error.status == 404 {
            // COMPAT(0.7 engine-stop): a 404 from an older Mac's agents bridge, taken as none. Goes 3 months after 0.8.0.
            // An older bridge: none run there yet.
            if let machine { running.remove(machine) }
            return
        } catch {
            log.error("\(machine ?? "This Mac", privacy: .public)'s group chats couldn't be read: \(error.localizedDescription, privacy: .public)")
            return
        }
        if let machine { running.insert(machine) }
        let ids = Set(listed.map(\.group.id))
        // What it said of a chat since the list was read is newer than the list (asked again for
        // each, as reading their messages takes a while).
        let touched = { self.touchedWhileListing[key]?.contains($0) == true }
        // Gone there (deleted elsewhere, or moved away): gone here too; not one moving there now.
        for gone in chats.filter({ $0.machine == machine && !ids.contains($0.group.id) && !touched($0.group.id) && app?.moves.isMoving($0.group.id) != true }) {
            forget(gone.group.id, on: machine)
        }
        for chat in listed {
            if touched(chat.group.id) {
                // Gone meanwhile: stays gone.
                guard chats.contains(where: { $0.group.id == chat.group.id && $0.machine == machine }) else { continue }
            } else {
                // One held there for a move that isn't under way, which another of your computers
                // has started (a move taken back that couldn't let it go there): let go now, its
                // seats left.
                if chat.status == "held", chats.contains(where: { $0.group.id == chat.group.id && $0.machine != machine && !$0.held }),
                   app?.moves.isMoving(chat.group.id) != true, app?.moves.isPending(chat.group.id) != true {
                    _ = try? await api.boxGroupAction(chat.group.id, "release")
                    forget(chat.group.id, on: machine)
                    continue
                }
                apply(chat.group, held: chat.status == "held", state: chat.state, on: machine)
            }
            // Its messages, unless the last one is the one here already.
            if logs[chat.group.id]?.last?.id != chat.last?.id || chat.last == nil { await reload(chat.group.id, on: machine) }
        }
        noteSeats(seatIDs, agents: agentSeatIDs)
    }

    /// What a meeting's notification says: what was said last, or only that it came when that's
    /// of a kind a newer Kuvo Code says (left out of the chat).
    static func metLine(_ last: GroupMessage) -> String {
        last.kind.isKnown ? ReplyPreview.line(last.text) : "The meeting came."
    }

    /// A machine you removed: its chats go from here (they stay there, for when you add it again).
    func forget(machine: String) {
        running.remove(machine)
        settingsGiven[machine] = nil
        for chat in chats where chat.machine == machine { forget(chat.group.id, on: machine) }
    }

    /// A machine found to be another one's address: its chats are the other's.
    func fold(_ address: String, into machine: String) {
        guard chats.contains(where: { $0.machine == address }) else { return }
        // One listed under both names is the other's, as it said last.
        let there = Set(chats.filter { $0.machine == machine }.map(\.group.id))
        chats.removeAll { $0.machine == address && there.contains($0.group.id) }
        for index in chats.indices where chats[index].machine == address { chats[index].machine = machine }
        running.remove(address)
        // Not connected under the name kept: as last seen, nothing talking (a copy kept from before
        // could say so), until it's read again. One being read now keeps what it said meanwhile.
        if !running.contains(machine) { disconnected(machine, keeping: touchedWhileListing[Self.key(machine)] ?? []) }
        save()
    }

    /// Its computer went away (or this Mac's bridge stopped): as last seen, nothing talking.
    /// `keeping`: chats it said something of since, left as it said.
    func disconnected(_ machine: String?, keeping: Set<String> = []) {
        for index in chats.indices where chats[index].machine == machine && !keeping.contains(chats[index].group.id) {
            chats[index].discussing = false
            chats[index].speaking = nil
            setActivity(chats[index].group.id, [])
            setStopped(chats[index].group.id, [])
        }
        settingsGiven[Self.key(machine)] = nil
    }

    /// What its bridge says of its chats as they go.
    func handle(_ event: ServerEvent, machine: String?) {
        guard event.type.hasPrefix("kuvo.group.") else { return }
        struct Updated: Decodable { var id: String; var group: BotGroup; var status: String; var state: State }
        struct Message: Decodable { var id: String; var message: GroupMessage }
        struct Named: Decodable { var id: String }
        struct Met: Decodable { var id: String; var name: String; var who: String?; var last: GroupMessage? }
        struct Done: Decodable { var id: String; var name: String; var who: String; var text: String }
        struct Trashed: Decodable { var id: String; var path: String }
        let key = Self.key(machine)
        do {
            switch event.type {
            case "kuvo.group.updated":
                let updated = try decoded(event, as: Updated.self)
                touchedWhileListing[key]?.insert(updated.id)
                if reloading[Read(machine: machine, id: updated.id)] != nil { touchedWhileReading.insert(Read(machine: machine, id: updated.id)) }
                apply(updated.group, held: updated.status == "held", state: updated.state, on: machine)
                let now = updated.state.speaking == nil ? [] : updated.state.activity ?? []
                setActivity(updated.id, now)
                noteSeats(Set(updated.group.seats.values), agents: Set(updated.group.agentSeats ?? []))
            case "kuvo.group.message":
                let changed = try decoded(event, as: Message.self)
                guard chats.contains(where: { $0.group.id == changed.id && $0.machine == machine }) else { return }
                arriving[changed.id]?.append(changed.message)
                var messages = logs[changed.id] ?? []
                if let index = messages.firstIndex(where: { $0.id == changed.message.id }) { messages[index] = changed.message } else { messages.append(changed.message) }
                setLog(changed.id, messages)
                saveLog(changed.id)
            case "kuvo.group.reset":
                let id = try decoded(event, as: Named.self).id
                // What arrived before it was taken back isn't kept by a read under way.
                if arriving[id] != nil { arriving[id] = [] }
                Task { await reload(id, on: machine) }
            case "kuvo.group.deleted":
                let id = try decoded(event, as: Named.self).id
                touchedWhileListing[key]?.insert(id)
                if reloading[Read(machine: machine, id: id)] != nil { touchedWhileReading.insert(Read(machine: machine, id: id)) }
                forget(id, on: machine)
            case "kuvo.group.met":
                let met = try decoded(event, as: Met.self)
                Analytics.shared.track("group_met")
                // Its box tells its news (`BoxNotices`), and what follows words it here for a box from before it did, or whose bridge isn't running.
                // COMPAT(0.7 box-notices): the Mac wording a box's news itself. Goes once a box tells its news without its bridge.
                if boxTellsNews?(machine ?? BoxClient.mac) == true { return }
                guard let last = met.last else {
                    Notifier.shared.notify(session: BotGroups.tabKey(met.id), title: met.name, body: "The meeting came, but no one could take part.",
                                           push: .init(.message, group: met.id, machine: machine))
                    return
                }
                Notifier.shared.notify(session: BotGroups.tabKey(met.id), title: met.name, subtitle: met.who.map { last.kind == .wrapUp ? "\($0)’s wrap-up" : $0 },
                                       body: Self.metLine(last), replies: true, push: .init(.message, group: met.id, machine: machine))
            case "kuvo.group.done":
                let done = try decoded(event, as: Done.self)
                if boxTellsNews?(machine ?? BoxClient.mac) == true { return }
                Notifier.shared.notify(session: BotGroups.tabKey(done.id), title: done.name, subtitle: "\(done.who) finished its part",
                                       body: ReplyPreview.line(done.text), replies: true, push: .init(.message, group: done.id, machine: machine))
            case "kuvo.group.trashed":
                // This Mac's: where you look for what you deleted, the Finder's Trash. (A machine's
                // stays in its own trash folder.)
                guard machine == nil else { return }
                let trashed = try decoded(event, as: Trashed.self)
                Self.toFinderTrash(trashed.path)
            default:
                break
            }
        } catch {
            log.error("A group chat's event couldn't be read: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Seats stay out of the lists, and those on the coding agents' models go to their bridge: told
    /// only when it's news (a chat's talk says its seats again and again).
    private func noteSeats(_ seats: Set<String>, agents: Set<String>) {
        guard let workspace = app?.workspace else { return }
        if !seats.isSubset(of: workspace.seats) { workspace.seats.formUnion(seats) }
        if !agents.isEmpty { workspace.runsOnAgents(agents) }
    }

    /// Where this Mac's bridge puts what it deletes and lets go of (`KUVO_TRASH`).
    static var macTrash: URL { BoxProcess.home.appending(path: "trash") }

    /// A folder this Mac's box or bridge put in its trash (a chat's, a deleted bot's), moved on to
    /// the Finder's Trash; only one in that trash folder.
    static func toFinderTrash(_ path: String) {
        // Links followed on both sides, so one can't lead out of the trash folder.
        let folder = URL(filePath: path).resolvingSymlinksInPath().standardizedFileURL
        let trash = macTrash.resolvingSymlinksInPath().standardizedFileURL.path + "/"
        guard folder.path.hasPrefix(trash), FileManager.default.fileExists(atPath: folder.path) else { return }
        do {
            try FileManager.default.moveToTrash(folder)
        } catch {
            Logger(subsystem: "run.kuvo.code", category: "box-groups").error("A folder stayed in Kuvo Code's trash: \(error.localizedDescription, privacy: .public)")
        }
    }

    struct State: Codable, Hashable {
        var speaking: String?
        var discussing: Bool
        var paused: Bool
        /// What the bot talking is doing (see `GroupActivity`).
        var activity: [GroupActivity]? = nil
        /// The bots whose part waits on their conversation, stopped by you (none: left out).
        var stopped: [String]? = nil
    }

    struct Listed: Decodable {
        var group: BotGroup
        var status: String
        var state: State
        var last: GroupMessage?
    }

    /// A time as a box says it: whole seconds.
    private static func seconds(_ date: Date) -> TimeInterval { date.timeIntervalSince1970.rounded(.down) }

    /// An event's `data`, read once from the event as it came.
    private func decoded<Value: Decodable>(_ event: ServerEvent, as type: Value.Type) throws -> Value {
        try Self.eventDecoder.decode(EventData<Value>.self, from: event.raw).data
    }

    private static let eventDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    private func apply(_ group: BotGroup, held: Bool, state: State, on machine: String?) {
        var group = group
        let index = chats.firstIndex { $0.group.id == group.id && $0.machine == machine }
        // Looked at here while its computer was away: that stands, and it's said there.
        // (In whole seconds, as it's said there.)
        if let index, let seen = chats[index].group.viewed, Self.seconds(seen) > Self.seconds(group.viewed ?? .distantPast) {
            group.viewed = seen
            if let api = api(machine) {
                let viewed = ISO8601DateFormatter().string(from: seen)
                Task { try? await api.editBoxGroup(group.id, ["viewed": .string(viewed)]) }
            }
        }
        let chat = Chat(machine: machine, group: group, held: held, speaking: state.speaking, discussing: state.discussing, paused: state.paused)
        // (A copy held while it moves says nothing of the chat's parts: the chat says that.)
        if !held { setStopped(group.id, Set(state.stopped ?? [])) }
        if let index {
            guard chats[index] != chat else { return }
            let wasUnread = isUnread(chats[index].group)
            chats[index] = chat
            // Read on another client (the phone, another Mac): its notifications go here too.
            if wasUnread, !isUnread(group) { Notifier.shared.clear(session: BotGroups.tabKey(group.id)) }
        } else {
            chats.append(chat)
            if logs[group.id] == nil { setLog(group.id, []) }
        }
        save()
    }

    /// A chat's messages, read again whole, from where it lives (or `machine`).
    func reload(_ id: String) async {
        guard let chat = chat(id) else { return }
        await reload(id, on: chat.machine)
    }

    func reload(_ id: String, on machine: String?) async {
        guard let api = api(machine) else { return }
        // (Another read of it under way, there or on another computer, keeps what arrives for both.)
        let key = Read(machine: machine, id: id)
        if !reloading.keys.contains(where: { $0.id == id }) { arriving[id] = [] }
        reloading[key, default: 0] += 1
        defer {
            reloading[key, default: 1] -= 1
            if reloading[key] == 0 { reloading[key] = nil; touchedWhileReading.remove(key) }
            if !reloading.keys.contains(where: { $0.id == id }) { arriving[id] = nil }
        }
        guard let read = try? await api.boxGroup(id) else { return }
        if touchedWhileReading.contains(key) {
            // Gone meanwhile: stays gone.
            guard chats.contains(where: { $0.group.id == id && $0.machine == machine }) else { return }
        } else {
            apply(read.group, held: read.status == "held", state: read.state, on: machine)
        }
        // What came while it was read: kept (the read is from before it).
        var messages = read.messages
        for message in arriving[id] ?? [] {
            if let index = messages.firstIndex(where: { $0.id == message.id }) { messages[index] = message } else { messages.append(message) }
        }
        setLog(id, messages)
        saveLog(id)
    }

    /// Gone from one computer: what's kept of it there goes, and its messages once no computer has it.
    private func forget(_ id: String, on machine: String?) {
        chats.removeAll { $0.group.id == id && $0.machine == machine }
        save()
        guard !has(id) else { return }
        setLog(id, nil)
        savingLogs.removeValue(forKey: id)?.cancel()
        setActivity(id, [])
        try? FileManager.default.removeItem(at: Self.folder.appending(path: "\(id).json"))
    }

    // MARK: Taking part

    /// A new chat on this Mac, or on `machine`, as New Group Chat makes it: the box it lives on says
    /// what can be (who can join, its meeting, on its clock), and makes it.
    func create(name: String, purpose: String?, members: [String], meeting: MeetingPlan?, on machine: String? = nil) async throws -> BotGroup {
        guard let api = api(machine) else { throw failure(for: machine) }
        var body: [String: JSONValue] = ["name": .string(name), "members": .array(members.map(JSONValue.string))]
        if let purpose { body["purpose"] = .string(purpose) }
        if let meeting { body["meeting"] = meeting.json }
        let answer = try await api.client.send(try api.client.request("POST", "api/kuvo/link/groups", body: JSONValue.object(body)), as: JSONValue.self, patience: .zero)
        guard let id = answer["group"]?["id"]?.string else { throw Failure.unreadable }
        await reload(id, on: machine)
        guard let group = chats.first(where: { $0.group.id == id && $0.machine == machine })?.group else { throw Failure.unreadable }
        Analytics.shared.track("group_created", ["members": members.count])
        return group
    }

    /// A meeting as you set it up: its time, how often, its topic. The computer the chat lives on
    /// works out when it comes, on its clock.
    struct MeetingPlan: Equatable {
        var next: Date
        var every: String?
        var topic: String

        var json: JSONValue {
            .object(["next": .number(next.timeIntervalSince1970.rounded(.down)), "every": every.map(JSONValue.string) ?? .null, "topic": .string(topic)])
        }
    }

    /// Your message to a chat, where it lives. Who it names with & is worked out there.
    func send(_ text: String, to id: String) async throws {
        guard let chat = chat(id) else { throw Failure.gone }
        guard let api = api(chat.machine) else { throw failure(for: chat.machine) }
        let message = try await api.boxGroupAction(id, "send", ["text": .string(text)])
        Analytics.shared.track("group_message", ["discussing": discussing.contains(id), "place": chat.machine == nil ? "mac" : "machine"])
        if let message = message.flatMap({ try? Self.message(from: $0) }), !(logs[id] ?? []).contains(where: { $0.id == message.id }) {
            setLog(id, (logs[id] ?? []) + [message])
            saveLog(id)
        }
    }

    func stop(_ id: String) async throws {
        try await act(id, "stop")
    }

    func keepGoing(_ id: String) async throws {
        try await act(id, "keep-going")
    }

    func startWork(_ wrapUpID: String, in id: String) async throws {
        try await act(id, "start-work", ["wrapUp": .string(wrapUpID)])
    }

    /// Takes the chat back to before one of your messages; its words, for the composer.
    func undo(from messageID: String, in id: String) async -> String? {
        guard let machine = chat(id).map(\.machine), let api = api(machine),
              let answer = try? await api.boxGroupAction(id, "undo", ["message": .string(messageID)]) else { return nil }
        Analytics.shared.track("group_undo")
        await reload(id, on: machine)
        return answer["text"]?.string
    }

    func markViewed(_ id: String) {
        Notifier.shared.clear(session: BotGroups.tabKey(id))
        guard let chat = chat(id), isUnread(chat.group),
              let index = chats.firstIndex(where: { $0.group.id == id && $0.machine == chat.machine }) else { return }
        let now = Date(timeIntervalSince1970: Self.seconds(.now))
        chats[index].group.viewed = now
        save()
        guard let api = api(chat.machine) else { return }
        let viewed = ISO8601DateFormatter().string(from: now)
        Task { try? await api.editBoxGroup(id, ["viewed": .string(viewed)]) }
    }

    func isUnread(_ group: BotGroup) -> Bool {
        guard let last = messages(in: group.id).last(where: { $0.author != nil && $0.kind != .note }) else { return false }
        return last.time > (group.viewed ?? .distantPast)
    }

    /// A new name, purpose, members (the lead first) or meeting, where it lives, as Edit Group Chat
    /// changes them: that computer says what can be (who can join, a meeting on its clock), and
    /// what it refuses throws its `ServerError`.
    func update(_ id: String, name: String, purpose: String?, members: [String], meeting: MeetingPlan?) async throws {
        guard let chat = chat(id) else { throw Failure.gone }
        guard let api = api(chat.machine) else { throw failure(for: chat.machine) }
        let body: [String: JSONValue] = [
            "name": .string(name), "purpose": .string(purpose ?? ""), "members": .array(members.map(JSONValue.string)), "meeting": meeting?.json ?? .null,
        ]
        _ = try await api.client.send(try api.client.request("PATCH", "api/kuvo/link/groups/\(id.groupPathEscaped)", body: JSONValue.object(body)), as: JSONValue.self, patience: .zero)
        await reload(id, on: chat.machine)
    }

    /// Who can be in a chat on a computer, as it says (its own bots, and those of your other
    /// computers that take a chat's turns), by id; nil when it can't say now (away, or older).
    func joinable(_ machine: String?) async -> [String]? {
        guard let api = api(machine) else { return nil }
        struct Answer: Decodable {
            struct Listed: Decodable { var id: String }
            var bots: [Listed]
        }
        guard let answer = try? await api.client.send(try api.client.request("GET", "api/kuvo/link/groups/joinable"), as: JSONValue.self),
              let data = try? JSONEncoder().encode(answer), let decoded = try? JSONDecoder().decode(Answer.self, from: data) else { return nil }
        return decoded.bots.map(\.id)
    }

    /// Deleted where it lives: its seats, its messages; its bots forget it.
    func delete(_ group: BotGroup) async throws {
        guard let chat = chat(group.id) else { return }
        guard let api = api(chat.machine) else { throw failure(for: chat.machine) }
        do {
            try await api.deleteBoxGroup(group.id)
        } catch let refused as ServerError where refused.status == 404 && refused.message == "No such chat." {
            // Gone there already: as good as deleted.
        } catch let refused as ServerError where refused.status == 409 {
            throw Moves.Failure.moving
        }
        forget(group.id, on: chat.machine)
        Analytics.shared.track("group_deleted")
    }

    /// A bot being deleted leaves its chats, wherever they live.
    func remove(_ bot: Bot) async {
        for chat in shown where chat.group.members.contains(bot.id) {
            guard let api = api(chat.machine) else { continue }
            let members = chat.group.members.filter { $0 != bot.id }
            _ = try? await api.editBoxGroup(chat.group.id, ["members": .array(members.map(JSONValue.string))])
            await reload(chat.group.id, on: chat.machine)
        }
    }

    /// What you did to a chat, where it lives; why it couldn't, as `send` says it (moving, or its
    /// computer's agents not answering yet).
    private func act(_ id: String, _ action: String, _ body: [String: JSONValue] = [:]) async throws {
        guard let chat = chat(id) else { throw Failure.gone }
        guard let api = api(chat.machine) else { throw failure(for: chat.machine) }
        do {
            _ = try await api.boxGroupAction(id, action, body)
        } catch let refused as ServerError where refused.status == 409 {
            throw Moves.Failure.moving
        }
    }

    enum Failure: LocalizedError {
        case away(String)
        case macStarting
        case macStopped
        case gone
        case unreadable
        var errorDescription: String? {
            switch self {
            case .away(let machine): "\(machine) isn’t connected. Connect to it, then try again."
            case .macStarting: "Group chats on this Mac are still starting. Try again in a moment."
            case .macStopped: "Group chats on this Mac stopped. Restart them, then try again."
            case .gone: "That group chat isn’t there any more."
            case .unreadable: "The answer couldn’t be read."
            }
        }
    }

    private func failure(for machine: String?) -> Failure {
        guard let machine else { return macFailure == nil ? .macStarting : .macStopped }
        return .away(machine)
    }

    // MARK: Settings

    /// Your clock, for every chat on a computer: your time zone and how you write dates, which a
    /// machine can't know. (The rest they go by, each computer's box works out itself.)
    func giveSettings(to machine: String?) async {
        guard let api = api(machine) else { return }
        let settings: [String: JSONValue] = [
            "timeZone": .string(TimeZone.current.identifier),
            "locale": .string(Locale.current.identifier(.bcp47)),
        ]
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let key = Self.key(machine)
        guard let data = try? encoder.encode(settings), settingsGiven[key] != data else { return }
        do {
            try await api.giveBoxGroupSettings(.object(settings))
            settingsGiven[key] = data
        } catch {
            log.error("\(machine ?? "This Mac", privacy: .public)'s group chats didn't get this Mac's settings: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Your time zone, or how you write dates, changed: each computer that can be reached now gets
    /// them, this Mac's bridge too.
    func settingsChanged() {
        let machines = Set(app?.machines.engines.values.filter(\.isReady).map(\.machine.id) ?? []).union(running)
        for machine in [nil] + machines.map(Optional.some) where reachable(machine) {
            Task { await giveSettings(to: machine) }
        }
    }

    // MARK: Plumbing

    /// A computer's bridge, while it's up (tests give their own): this Mac's (nil), or a machine's.
    @ObservationIgnored var bridge: ((String?) -> OpenCodeAPI?)?
    /// Why this Mac's bridge stopped for good (tests give their own).
    @ObservationIgnored var stoppedBecause: (() -> String?)?

    private func api(_ machine: String?) -> OpenCodeAPI? {
        if let bridge { return bridge(machine) }
        guard let machine else { return app?.agents.api }
        guard let engine = app?.machines.engine(machine), engine.isReady else { return nil }
        return engine.agents.api
    }

    /// Why this Mac's bridge isn't running, when it won't by itself: it stopped, or it never could
    /// start (the engine, whose Bun runs it, didn't).
    private var macFailure: String? {
        if let stoppedBecause { return stoppedBecause() }
        if let failure = app?.agents.failure { return failure }
        if app?.agents.wasStarted == false, case .failed(let reason)? = app?.engine { return reason }
        return nil
    }

    /// Whether a computer's bridge can be reached now.
    func reachable(_ machine: String?) -> Bool { api(machine) != nil }

    /// What's kept, written a moment after the last change (a chat's talk changes it often), off
    /// the main thread: it's only what shows until each computer says how its chats are now.
    private func save() {
        guard saving == nil else { return }
        saving = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard let self, !Task.isCancelled else { return }
            self.saving = nil
            guard let data = self.encoded(self.chats) else { return }
            let file = Self.file
            await Task.detached { Self.write(data, to: file) }.value
        }
    }

    private func saveLog(_ id: String) {
        guard savingLogs[id] == nil else { return }
        savingLogs[id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard let self, !Task.isCancelled else { return }
            self.savingLogs[id] = nil
            guard let messages = self.logs[id], let data = self.encoded(messages) else { return }
            let file = Self.folder.appending(path: "\(id).json")
            await Task.detached { Self.write(data, to: file) }.value
        }
    }

    /// What's waiting to be written, written now (the app quitting, or a test reading it back).
    func flush() {
        if saving != nil {
            saving?.cancel()
            saving = nil
            if let data = encoded(chats) { Self.write(data, to: Self.file) }
        }
        for (id, task) in savingLogs {
            task.cancel()
            if let messages = logs[id], let data = encoded(messages) { Self.write(data, to: Self.folder.appending(path: "\(id).json")) }
        }
        savingLogs = [:]
    }

    private func encoded(_ value: some Encodable) -> Data? {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try? encoder.encode(value)
    }

    @ObservationIgnored private var saving: Task<Void, Never>?
    @ObservationIgnored private var savingLogs: [String: Task<Void, Never>] = [:]

    nonisolated private static func write(_ data: Data, to file: URL) {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }

    private static func decode<Value: Decodable>(_ type: Value.Type, from value: JSONValue) throws -> Value {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(type, from: JSONEncoder().encode(value))
    }

    private static func message(from value: JSONValue) throws -> GroupMessage {
        try decode(GroupMessage.self, from: value)
    }
}

// MARK: The bridge's group chat routes

extension String {
    /// A chat's ID in a path (they're letters, digits and "_" anyway).
    var groupPathEscaped: String { addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "_-"))) ?? self }
}

extension OpenCodeAPI {
    struct BoxGroupRead: Decodable {
        var group: BotGroup
        var status: String
        var state: BoxGroups.State
        var messages: [GroupMessage]
    }

    private static var groupDecoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    private func groupData<Value: Decodable>(_ request: URLRequest, as type: Value.Type) async throws -> Value {
        let value = try await client.send(request, as: JSONValue.self)
        return try Self.groupDecoder.decode(type, from: JSONEncoder().encode(value))
    }

    func boxGroups() async throws -> [BoxGroups.Listed] {
        struct Answer: Decodable { var data: [BoxGroups.Listed] }
        return try await groupData(try client.request("GET", "api/kuvo/groups"), as: Answer.self).data
    }

    func boxGroup(_ id: String) async throws -> BoxGroupRead {
        struct Answer: Decodable { var data: BoxGroupRead }
        return try await groupData(try client.request("GET", "api/kuvo/groups/\(id.groupPathEscaped)"), as: Answer.self).data
    }

    func editBoxGroup(_ id: String, _ edits: [String: JSONValue]) async throws {
        _ = try await client.send(try client.request("PATCH", "api/kuvo/groups/\(id.groupPathEscaped)", body: JSONValue.object(edits)), as: JSONValue.self)
    }

    func deleteBoxGroup(_ id: String) async throws {
        _ = try await client.send(try client.request("DELETE", "api/kuvo/groups/\(id.groupPathEscaped)"), as: JSONValue.self)
    }

    /// What `action` answers, its `data`.
    func boxGroupAction(_ id: String, _ action: String, _ body: [String: JSONValue] = [:]) async throws -> JSONValue? {
        let answer = try await client.send(try client.request("POST", "api/kuvo/groups/\(id.groupPathEscaped)/\(action)", body: JSONValue.object(body)), as: JSONValue.self)
        return answer["data"]
    }

    func giveBoxGroupSettings(_ settings: JSONValue) async throws {
        _ = try await client.send(try client.request("PUT", "api/kuvo/groups/clock", body: settings), as: JSONValue.self)
    }
}
