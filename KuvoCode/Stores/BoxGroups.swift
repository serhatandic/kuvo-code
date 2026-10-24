import Foundation
import KuvoLink
import OpenCodeKit
import os

/// The group chats of one of your computers (a box), as a move between them sees it: the same
/// steps on both ends, wherever each is. Held where it was, brought where it's going and held
/// there, then started there and let go of where it was; or, cut short, taken back.
@MainActor
protocol GroupHome: AnyObject {
    /// Whether it can be asked now (a machine connected, this Mac's bridge up).
    var isReachable: Bool { get }
    /// Its talk stops and nothing more happens to it here; the chat as it is now.
    func hold(_ id: String) async throws -> (group: BotGroup, messages: [GroupMessage])
    /// A copy brought here, held until it's started.
    func bring(_ group: BotGroup, messages: [GroupMessage]) async throws
    /// Started here.
    func activate(_ id: String) async throws
    /// Gone from here, moved away: to the trash where it was, its seats left (its bots live there).
    func letGo(_ id: String) async throws
    /// A copy brought here that didn't get to start: gone, seats and all left as they are.
    /// Whether it is (not if it can't be asked now).
    func takeBack(_ id: String) async -> Bool
}

/// One computer's group chats, as a move sees them (`GroupHome`), through `BoxGroups`: a machine's,
/// or this Mac's (`machine` nil). The same steps either way.
@MainActor
final class BoxGroupHome: GroupHome {
    let machine: String?
    let groups: BoxGroups

    init(machine: String?, groups: BoxGroups) {
        self.machine = machine
        self.groups = groups
    }

    var isReachable: Bool { groups.reachable(machine) }
    func hold(_ id: String) async throws -> (group: BotGroup, messages: [GroupMessage]) { try await groups.hold(id, on: machine) }
    func bring(_ group: BotGroup, messages: [GroupMessage]) async throws { try await groups.bring(group, messages: messages, to: machine) }
    func activate(_ id: String) async throws { try await groups.activate(id, on: machine) }
    func letGo(_ id: String) async throws { try await groups.release(id, on: machine) }
    func takeBack(_ id: String) async -> Bool { await groups.takeBack(id, on: machine) }
}

/// Your group chats, wherever they live. Each computer's coding agents' bridge runs its own
/// (`Agents/src/groups`): this Mac's as a machine's, so they talk, meet and hand out work with
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
    private(set) var chats: [Chat] = []
    private var logs: [String: [GroupMessage]] = [:]
    /// Machines whose bridge runs group chats (an older one doesn't yet).
    private(set) var running: Set<String> = []
    /// What the bot talking is doing, by chat, as its computer last said (see `GroupActivity`).
    private(set) var activity: [String: [GroupActivity]] = [:]
    @ObservationIgnored weak var app: AppModel?
    /// The settings each computer was last given, so they go again only when they change.
    @ObservationIgnored private var settingsGiven: [String: Data] = [:]
    /// Chats being read whole now, and what their computer said of them meanwhile, so the read
    /// (from before) doesn't take it away.
    @ObservationIgnored private var arriving: [String: [GroupMessage]] = [:]
    /// Reads of a chat's messages under way, by ID: what arrives is kept until the last is through.
    @ObservationIgnored private var reloading: [String: Int] = [:]
    /// Chats a computer said something of (changed or gone) while its list was being read.
    @ObservationIgnored private var touchedWhileListing: [String: Set<String>] = [:]
    private let log = Logger(subsystem: "run.kuvo.code", category: "box-groups")

    static var file: URL { AppInfo.supportDirectory.appending(path: "group-chats.json") }
    static var folder: URL { AppInfo.supportDirectory.appending(path: "group-chats") }
    /// Where 0.8.0-beta.1 kept what it saw of machines' chats.
    private static var oldFile: URL { AppInfo.supportDirectory.appending(path: "machine-groups.json") }
    private static var oldFolder: URL { AppInfo.supportDirectory.appending(path: "machine-groups") }

    init() {
        let manager = FileManager.default
        if !manager.fileExists(atPath: Self.file.path), manager.fileExists(atPath: Self.oldFile.path) {
            try? manager.moveItem(at: Self.oldFile, to: Self.file)
            if manager.fileExists(atPath: Self.oldFolder.path), !manager.fileExists(atPath: Self.folder.path) { try? manager.moveItem(at: Self.oldFolder, to: Self.folder) }
        }
        chats = JSONFile.read([Chat].self, from: Self.file, isoDates: true) ?? []
        // As last seen: nothing's talking until its computer says so.
        for index in chats.indices {
            chats[index].discussing = false
            chats[index].speaking = nil
        }
        for id in Set(chats.map(\.group.id)) { logs[id] = JSONFile.read([GroupMessage].self, from: Self.folder.appending(path: "\(id).json"), isoDates: true) ?? [] }
    }

    /// A computer as a key: "" for this Mac (a machine's ID is never empty).
    private static func key(_ machine: String?) -> String { machine ?? "" }

    // MARK: Reading

    func has(_ id: String?) -> Bool { id.map { id in chats.contains { $0.group.id == id } } ?? false }
    /// The chat by its ID, as the window shows it: of two copies (it's moving), the one started,
    /// else the one it's leaving.
    func chat(_ id: String?) -> Chat? {
        guard let id else { return nil }
        let all = chats.filter { $0.group.id == id }
        return all.first { !$0.held } ?? all.first
    }
    /// Each chat once, as the window shows it.
    var shown: [Chat] {
        var seen = Set<String>()
        return chats.compactMap { listed in
            guard seen.insert(listed.group.id).inserted else { return nil }
            return chat(listed.group.id)
        }
    }
    func group(_ id: String?) -> BotGroup? { chat(id)?.group }
    /// The machine a chat lives on; nil for this Mac's (and for none).
    func machine(of id: String?) -> String? { chat(id)?.machine }
    func messages(in id: String) -> [GroupMessage] { logs[id] ?? [] }
    func group(seat: String) -> BotGroup? { chats.first { $0.group.seats.values.contains(seat) }?.group }

    var speaking: [String: String] {
        Dictionary(shown.compactMap { chat in chat.speaking.map { (chat.group.id, $0) } }) { first, _ in first }
    }
    var discussing: Set<String> { Set(shown.filter(\.discussing).map(\.group.id)) }
    var paused: Set<String> { Set(shown.filter(\.paused).map(\.group.id)) }
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
        guard let chat = chat(id) else { return .ready }
        if api(chat.machine) != nil { return .ready }
        guard let machine = chat.machine else { return macReach }
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
        app?.workspace.seats.formUnion(seatIDs)
        app?.workspace.runsOnAgents(agentSeatIDs)
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
        for index in chats.indices where chats[index].machine == address { chats[index].machine = machine }
        running.remove(address)
        save()
    }

    /// Its computer went away (or this Mac's bridge stopped): as last seen, nothing talking.
    func disconnected(_ machine: String?) {
        for index in chats.indices where chats[index].machine == machine {
            chats[index].discussing = false
            chats[index].speaking = nil
            activity[chats[index].group.id] = nil
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
                apply(updated.group, held: updated.status == "held", state: updated.state, on: machine)
                let now = updated.state.speaking == nil ? [] : updated.state.activity ?? []
                if activity[updated.id] ?? [] != now { activity[updated.id] = now.isEmpty ? nil : now }
                app?.workspace.seats.formUnion(updated.group.seats.values)
                if let agentSeats = updated.group.agentSeats { app?.workspace.runsOnAgents(agentSeats) }
            case "kuvo.group.message":
                let changed = try decoded(event, as: Message.self)
                guard chats.contains(where: { $0.group.id == changed.id && $0.machine == machine }) else { return }
                arriving[changed.id]?.append(changed.message)
                var messages = logs[changed.id] ?? []
                if let index = messages.firstIndex(where: { $0.id == changed.message.id }) { messages[index] = changed.message } else { messages.append(changed.message) }
                logs[changed.id] = messages
                saveLog(changed.id)
            case "kuvo.group.reset":
                let id = try decoded(event, as: Named.self).id
                // What arrived before it was taken back isn't kept by a read under way.
                if arriving[id] != nil { arriving[id] = [] }
                Task { await reload(id, on: machine) }
            case "kuvo.group.deleted":
                let id = try decoded(event, as: Named.self).id
                touchedWhileListing[key]?.insert(id)
                forget(id, on: machine)
            case "kuvo.group.met":
                let met = try decoded(event, as: Met.self)
                Analytics.shared.track("group_met")
                guard let last = met.last else {
                    Notifier.shared.notify(session: BotGroups.tabKey(met.id), title: met.name, body: "The meeting came, but no one could take part.",
                                           push: .init(.message, group: met.id, machine: machine))
                    return
                }
                Notifier.shared.notify(session: BotGroups.tabKey(met.id), title: met.name, subtitle: met.who.map { last.kind == .wrapUp ? "\($0)’s wrap-up" : $0 },
                                       body: ReplyPreview.line(last.text), replies: true, push: .init(.message, group: met.id, machine: machine))
            case "kuvo.group.done":
                let done = try decoded(event, as: Done.self)
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

    /// Where this Mac's bridge puts what it deletes and lets go of (`KUVO_TRASH`).
    static var macTrash: URL { BoxProcess.home.appending(path: "trash") }

    /// A chat's folder this Mac's bridge put in its trash, moved on to the Finder's Trash; only one
    /// in that trash folder.
    static func toFinderTrash(_ path: String) {
        let folder = URL(filePath: path).standardizedFileURL
        let trash = macTrash.standardizedFileURL.path + "/"
        guard folder.path.hasPrefix(trash), FileManager.default.fileExists(atPath: folder.path) else { return }
        do {
            try FileManager.default.moveToTrash(folder)
        } catch {
            Logger(subsystem: "run.kuvo.code", category: "box-groups").error("A group chat's folder stayed in Kuvo Code's trash: \(error.localizedDescription, privacy: .public)")
        }
    }

    struct State: Codable, Hashable {
        var speaking: String?
        var discussing: Bool
        var paused: Bool
        /// What the bot talking is doing (see `GroupActivity`).
        var activity: [GroupActivity]? = nil
    }

    struct Listed: Decodable {
        var group: BotGroup
        var status: String
        var state: State
        var last: GroupMessage?
    }

    /// A time as a box says it: whole seconds.
    private static func seconds(_ date: Date) -> TimeInterval { date.timeIntervalSince1970.rounded(.down) }

    private func decoded<Value: Decodable>(_ event: ServerEvent, as type: Value.Type) throws -> Value {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(type, from: JSONEncoder().encode(event.data))
    }

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
        if let index {
            guard chats[index] != chat else { return }
            chats[index] = chat
        } else {
            chats.append(chat)
            if logs[group.id] == nil { logs[group.id] = [] }
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
        // (Another read of it under way keeps what arrives for both.)
        if reloading[id, default: 0] == 0 { arriving[id] = [] }
        reloading[id, default: 0] += 1
        defer {
            reloading[id, default: 1] -= 1
            if reloading[id] == 0 { reloading[id] = nil; arriving[id] = nil }
        }
        guard let read = try? await api.boxGroup(id) else { return }
        apply(read.group, held: read.status == "held", state: read.state, on: machine)
        // What came while it was read: kept (the read is from before it).
        var messages = read.messages
        for message in arriving[id] ?? [] {
            if let index = messages.firstIndex(where: { $0.id == message.id }) { messages[index] = message } else { messages.append(message) }
        }
        logs[id] = messages
        saveLog(id)
    }

    /// Gone from one computer: what's kept of it there goes, and its messages once no computer has it.
    private func forget(_ id: String, on machine: String?) {
        chats.removeAll { $0.group.id == id && $0.machine == machine }
        save()
        guard !has(id) else { return }
        logs[id] = nil
        activity[id] = nil
        try? FileManager.default.removeItem(at: Self.folder.appending(path: "\(id).json"))
    }

    // MARK: Taking part

    /// A new chat on this Mac, as New Group Chat makes it: this Mac's box says what can be (who
    /// can join, its meeting, on its clock), and makes it.
    func create(name: String, purpose: String?, members: [String], meeting: MeetingPlan?) async throws -> BotGroup {
        guard let api = api(nil) else { throw Failure.macStarting }
        var body: [String: JSONValue] = ["name": .string(name), "members": .array(members.map(JSONValue.string))]
        if let purpose { body["purpose"] = .string(purpose) }
        if let meeting { body["meeting"] = meeting.json }
        let answer = try await api.client.send(try api.client.request("POST", "api/kuvo/link/groups", body: JSONValue.object(body)), as: JSONValue.self, patience: .zero)
        guard let id = answer["group"]?["id"]?.string else { throw Failure.unreadable }
        await reload(id, on: nil)
        guard let group = chats.first(where: { $0.group.id == id && $0.machine == nil })?.group else { throw Failure.unreadable }
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
            logs[id, default: []].append(message)
            saveLog(id)
        }
    }

    func stop(_ id: String) {
        act(id, "stop")
    }

    func keepGoing(_ id: String) {
        act(id, "keep-going")
    }

    func startWork(_ wrapUpID: String, in id: String) {
        act(id, "start-work", ["wrapUp": .string(wrapUpID)])
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

    private func act(_ id: String, _ action: String, _ body: [String: JSONValue] = [:]) {
        guard let chat = chat(id), let api = api(chat.machine) else { return }
        Task { _ = try? await api.boxGroupAction(id, action, body) }
    }

    // MARK: Moving one

    /// A chat brought to a computer, with its messages (`Moves`): held there until `activate`.
    func bring(_ group: BotGroup, messages: [GroupMessage], to machine: String?) async throws {
        guard let api = api(machine) else { throw failure(for: machine) }
        try await api.putBoxGroup(group, messages: messages, held: true)
        apply(group, held: true, state: State(discussing: false, paused: false), on: machine)
        if logs[group.id]?.isEmpty != false {
            logs[group.id] = messages
            saveLog(group.id)
        }
    }

    func activate(_ id: String, on machine: String?) async throws {
        guard let api = api(machine) else { throw failure(for: machine) }
        _ = try await api.boxGroupAction(id, "activate")
        await reload(id, on: machine)
    }

    /// Held there for a move away: its talk stops; the chat as it is now.
    func hold(_ id: String, on machine: String?) async throws -> (group: BotGroup, messages: [GroupMessage]) {
        guard let api = api(machine) else { throw failure(for: machine) }
        guard let held = try await api.boxGroupAction(id, "hold"),
              let group = held["group"].flatMap({ try? Self.decode(BotGroup.self, from: $0) }),
              let messages = held["messages"].flatMap({ try? Self.decode([GroupMessage].self, from: $0) }) else { throw Failure.unreadable }
        if let index = chats.firstIndex(where: { $0.group.id == id && $0.machine == machine }) {
            chats[index].held = true
            chats[index].discussing = false
            chats[index].speaking = nil
            save()
        }
        return (group, messages)
    }

    /// Let go there, its seats left (its bots stay there); gone from here.
    func release(_ id: String, on machine: String?) async throws {
        guard let api = api(machine) else { throw failure(for: machine) }
        _ = try await api.boxGroupAction(id, "release")
        forget(id, on: machine)
    }

    /// One brought there that didn't get to start (a move taken back): gone there, seats and all
    /// left as they are (the chat goes on where it was). Whether it is (not if it wasn't there).
    func takeBack(_ id: String, on machine: String?) async -> Bool {
        guard let api = api(machine) else { return false }
        do {
            _ = try await api.boxGroupAction(id, "release")
        } catch let error as ServerError where error.status == 404 {
            // Never got there.
        } catch {
            return false
        }
        forget(id, on: machine)
        return true
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

    /// What every chat on a computer goes by, from this Mac: what each personality tells a bot,
    /// who sets what about a bot, Ask First, what its Settings › Permissions deny, your time zone
    /// and how you write dates.
    func giveSettings(to machine: String?) async {
        guard let api = api(machine) else { return }
        let approval = UserDefaults.standard.string(forKey: ToolApproval.key).flatMap(ToolApproval.init) ?? .approveAll
        let denies = EngineConfig.rules(on: machine).filter { $0.effect == .deny }
        let settings: [String: JSONValue] = [
            "personalities": .object(Dictionary(Personalities.shared.all.map { ($0.id, JSONValue.string($0.instruction)) }) { first, _ in first }),
            "identityNote": .string(Bots.identityNote),
            "askFirst": .bool(approval == .askFirst),
            "denies": Self.json(denies) ?? .array([]),
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

    /// Settings changed here (or your time zone, or how you write dates): each computer that can be
    /// reached now gets them, this Mac's bridge too.
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

    private var macFailure: String? {
        if let stoppedBecause { return stoppedBecause() }
        return app?.agents.failure
    }

    /// Whether a computer's bridge can be reached now.
    func reachable(_ machine: String?) -> Bool { api(machine) != nil }

    private func save() {
        JSONFile.write(chats, to: Self.file, isoDates: true, readable: true)
    }

    private func saveLog(_ id: String) {
        guard let messages = logs[id] else { return }
        JSONFile.write(messages, to: Self.folder.appending(path: "\(id).json"), isoDates: true, readable: true)
    }

    private static func json(_ value: some Encodable) -> JSONValue? {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return (try? encoder.encode(value)).flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
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

    func putBoxGroup(_ group: BotGroup, messages: [GroupMessage], held: Bool) async throws {
        struct Body: Encodable { var group: BotGroup; var messages: [GroupMessage]; var status: String }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let body = try JSONDecoder().decode(JSONValue.self, from: encoder.encode(Body(group: group, messages: messages, status: held ? "held" : "active")))
        _ = try await client.send(try client.request("PUT", "api/kuvo/groups/\(group.id.groupPathEscaped)", body: body), as: JSONValue.self)
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
        _ = try await client.send(try client.request("PUT", "api/kuvo/groups/settings", body: settings), as: JSONValue.self)
    }
}
