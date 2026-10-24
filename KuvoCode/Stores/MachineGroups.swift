import Foundation
import KuvoLink
import OpenCodeKit
import os

/// Group chats that live on your machines: each machine's agents bridge runs them
/// (`Agents/src/groups`), so they talk, meet and hand out work while this Mac is off. This Mac
/// shows them as it shows its own (`BotGroups`, which stays as it is), from what each machine says
/// of them as they go (its bridge's event feed), and sends there what you do in them. What it last
/// saw of each is kept here, so they show while their machine is away.
@MainActor @Observable
final class MachineGroups {
    /// A chat as its machine last said it.
    struct Chat: Codable, Hashable {
        var machine: String
        var group: BotGroup
        /// Brought there by a move, not started yet.
        var held: Bool
        var speaking: String?
        var discussing: Bool
        var paused: Bool
    }

    private(set) var chats: [Chat] = []
    private var logs: [String: [GroupMessage]] = [:]
    /// Machines whose bridge runs group chats (an older one doesn't yet).
    private(set) var running: Set<String> = []
    /// What the bot talking is doing, by chat, as its machine last said (see `GroupActivity`).
    private(set) var activity: [String: [GroupActivity]] = [:]
    @ObservationIgnored weak var app: AppModel?
    /// The settings each machine was last given, so they go again only when they change.
    @ObservationIgnored private var settingsGiven: [String: Data] = [:]
    /// Chats being read whole now, and what their machine said of them meanwhile, so the read
    /// (from before) doesn't take it away.
    @ObservationIgnored private var arriving: [String: [GroupMessage]] = [:]
    /// Reads of a chat's messages under way, by ID: what arrives is kept until the last is through.
    @ObservationIgnored private var reloading: [String: Int] = [:]
    /// Chats a machine said something of (changed or gone) while its list was being read, by machine.
    @ObservationIgnored private var touchedWhileListing: [String: Set<String>] = [:]
    private let log = Logger(subsystem: "run.kuvo.code", category: "machine-groups")

    private static var file: URL { AppInfo.supportDirectory.appending(path: "machine-groups.json") }
    private static var folder: URL { AppInfo.supportDirectory.appending(path: "machine-groups") }

    init() {
        chats = JSONFile.read([Chat].self, from: Self.file, isoDates: true) ?? []
        // As last seen: nothing's talking until its machine says so.
        for index in chats.indices {
            chats[index].discussing = false
            chats[index].speaking = nil
        }
        for chat in chats { logs[chat.group.id] = JSONFile.read([GroupMessage].self, from: Self.folder.appending(path: "\(chat.group.id).json"), isoDates: true) ?? [] }
    }

    // MARK: Reading

    func has(_ id: String?) -> Bool { id.map { id in chats.contains { $0.group.id == id } } ?? false }
    func chat(_ id: String?) -> Chat? { id.flatMap { id in chats.first { $0.group.id == id } } }
    func group(_ id: String?) -> BotGroup? { chat(id)?.group }
    func machine(of id: String?) -> String? { chat(id)?.machine }
    func messages(in id: String) -> [GroupMessage] { logs[id] ?? [] }
    func group(seat: String) -> BotGroup? { chats.first { $0.group.seats.values.contains(seat) }?.group }

    var speaking: [String: String] {
        Dictionary(chats.compactMap { chat in chat.speaking.map { (chat.group.id, $0) } }) { first, _ in first }
    }
    var discussing: Set<String> { Set(chats.filter(\.discussing).map(\.group.id)) }
    var paused: Set<String> { Set(chats.filter(\.paused).map(\.group.id)) }
    var seatIDs: Set<String> { Set(chats.flatMap(\.group.seats.values)) }
    var agentSeatIDs: Set<String> { Set(chats.flatMap { $0.group.agentSeats ?? [] }) }

    /// Talk under way on a machine: its engine isn't started over meanwhile.
    func isTalking(on machine: String) -> Bool { chats.contains { $0.machine == machine && $0.discussing } }

    /// The machine a chat lives on, while you can't reach it there (away, or its bridge too old
    /// to run group chats): what you write waits.
    func unreachable(_ id: String) -> String? {
        guard let chat = chat(id) else { return nil }
        return api(chat.machine) == nil ? chat.machine : nil
    }

    // MARK: Following a machine

    /// Its bridge is up: its chats as it has them, and the settings they go by.
    func connected(_ machine: String) async {
        guard let api = api(machine) else { return }
        await giveSettings(to: machine)
        let listed: [Listed]
        touchedWhileListing[machine] = []
        defer { touchedWhileListing[machine] = nil }
        do {
            listed = try await api.machineGroups()
        } catch let error as ServerError where error.status == 404 {
            // An older bridge: none run there yet.
            running.remove(machine)
            return
        } catch {
            log.error("\(machine, privacy: .public)'s group chats couldn't be read: \(error.localizedDescription, privacy: .public)")
            return
        }
        running.insert(machine)
        let ids = Set(listed.map(\.group.id))
        // What it said of a chat since the list was read is newer than the list (asked again for
        // each, as reading their messages takes a while).
        let touched = { self.touchedWhileListing[machine]?.contains($0) == true }
        // Gone there (deleted elsewhere, or moved away): gone here too; not one moving there now.
        for gone in chats.filter({ $0.machine == machine && !ids.contains($0.group.id) && !touched($0.group.id) && app?.moves.isMoving($0.group.id) != true }) {
            forget(gone.group.id)
        }
        for chat in listed {
            if touched(chat.group.id) {
                // Gone meanwhile: stays gone.
                guard has(chat.group.id) else { continue }
            } else {
                // One held there for a move that isn't under way, which this Mac has (a move taken
                // back that couldn't let it go there): let go now, its seats left.
                if chat.status == "held", app?.groups.group(chat.group.id) != nil, app?.moves.isMoving(chat.group.id) != true, app?.moves.isPending(chat.group.id) != true {
                    _ = try? await api.machineGroupAction(chat.group.id, "release")
                    forget(chat.group.id)
                    continue
                }
                apply(chat.group, held: chat.status == "held", state: chat.state, on: machine)
            }
            // Its messages, unless the last one is the one here already.
            if logs[chat.group.id]?.last?.id != chat.last?.id || chat.last == nil { await reload(chat.group.id) }
        }
        app?.workspace.seats.formUnion(seatIDs)
        app?.workspace.runsOnAgents(agentSeatIDs)
    }

    /// A machine you removed: its chats go from here (they stay there, for when you add it again).
    func forget(machine: String) {
        running.remove(machine)
        settingsGiven[machine] = nil
        for chat in chats where chat.machine == machine { forget(chat.group.id) }
    }

    /// A machine found to be another one's address: its chats are the other's.
    func fold(_ address: String, into machine: String) {
        guard chats.contains(where: { $0.machine == address }) else { return }
        for index in chats.indices where chats[index].machine == address { chats[index].machine = machine }
        running.remove(address)
        save()
    }

    /// Its machine went away: as last seen, nothing talking.
    func disconnected(_ machine: String) {
        for index in chats.indices where chats[index].machine == machine {
            chats[index].discussing = false
            chats[index].speaking = nil
            activity[chats[index].group.id] = nil
        }
    }

    /// What its bridge says of its chats as they go.
    func handle(_ event: ServerEvent, machine: String) {
        guard event.type.hasPrefix("kuvo.group.") else { return }
        struct Updated: Decodable { var id: String; var group: BotGroup; var status: String; var state: State }
        struct Message: Decodable { var id: String; var message: GroupMessage }
        struct Named: Decodable { var id: String }
        struct Met: Decodable { var id: String; var name: String; var who: String?; var last: GroupMessage? }
        struct Done: Decodable { var id: String; var name: String; var who: String; var text: String }
        do {
            switch event.type {
            case "kuvo.group.updated":
                let updated = try decoded(event, as: Updated.self)
                touchedWhileListing[machine]?.insert(updated.id)
                apply(updated.group, held: updated.status == "held", state: updated.state, on: machine)
                let now = updated.state.speaking == nil ? [] : updated.state.activity ?? []
                if activity[updated.id] ?? [] != now { activity[updated.id] = now.isEmpty ? nil : now }
                app?.workspace.seats.formUnion(updated.group.seats.values)
                if let agentSeats = updated.group.agentSeats { app?.workspace.runsOnAgents(agentSeats) }
            case "kuvo.group.message":
                let changed = try decoded(event, as: Message.self)
                guard has(changed.id) else { return }
                arriving[changed.id]?.append(changed.message)
                var messages = logs[changed.id] ?? []
                if let index = messages.firstIndex(where: { $0.id == changed.message.id }) { messages[index] = changed.message } else { messages.append(changed.message) }
                logs[changed.id] = messages
                saveLog(changed.id)
            case "kuvo.group.reset":
                let id = try decoded(event, as: Named.self).id
                // What arrived before it was taken back isn't kept by a read under way.
                if arriving[id] != nil { arriving[id] = [] }
                Task { await reload(id) }
            case "kuvo.group.deleted":
                let id = try decoded(event, as: Named.self).id
                touchedWhileListing[machine]?.insert(id)
                forget(id)
            case "kuvo.group.met":
                let met = try decoded(event, as: Met.self)
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
            default:
                break
            }
        } catch {
            log.error("A group chat's event couldn't be read: \(error.localizedDescription, privacy: .public)")
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

    /// A time as a machine says it: whole seconds.
    private static func seconds(_ date: Date) -> TimeInterval { date.timeIntervalSince1970.rounded(.down) }

    private func decoded<Value: Decodable>(_ event: ServerEvent, as type: Value.Type) throws -> Value {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(type, from: JSONEncoder().encode(event.data))
    }

    private func apply(_ group: BotGroup, held: Bool, state: State, on machine: String) {
        var group = group
        // Looked at here while its machine was away: that stands, and it's said there.
        // (In whole seconds, as it's said there.)
        if let seen = chat(group.id)?.group.viewed, Self.seconds(seen) > Self.seconds(group.viewed ?? .distantPast) {
            group.viewed = seen
            if let api = api(machine) {
                let viewed = ISO8601DateFormatter().string(from: seen)
                Task { try? await api.editMachineGroup(group.id, ["viewed": .string(viewed)]) }
            }
        }
        let chat = Chat(machine: machine, group: group, held: held, speaking: state.speaking, discussing: state.discussing, paused: state.paused)
        if let index = chats.firstIndex(where: { $0.group.id == group.id }) {
            guard chats[index] != chat else { return }
            chats[index] = chat
        } else {
            chats.append(chat)
            if logs[group.id] == nil { logs[group.id] = [] }
        }
        save()
    }

    /// A chat's messages, read again whole.
    func reload(_ id: String) async {
        guard let machine = machine(of: id), let api = api(machine) else { return }
        // (Another read of it under way keeps what arrives for both.)
        if reloading[id, default: 0] == 0 { arriving[id] = [] }
        reloading[id, default: 0] += 1
        defer {
            reloading[id, default: 1] -= 1
            if reloading[id] == 0 { reloading[id] = nil; arriving[id] = nil }
        }
        guard let read = try? await api.machineGroup(id) else { return }
        apply(read.group, held: read.status == "held", state: read.state, on: machine)
        // What came while it was read: kept (the read is from before it).
        var messages = read.messages
        for message in arriving[id] ?? [] {
            if let index = messages.firstIndex(where: { $0.id == message.id }) { messages[index] = message } else { messages.append(message) }
        }
        logs[id] = messages
        saveLog(id)
    }

    private func forget(_ id: String) {
        chats.removeAll { $0.group.id == id }
        logs[id] = nil
        activity[id] = nil
        save()
        try? FileManager.default.removeItem(at: Self.folder.appending(path: "\(id).json"))
    }

    // MARK: Taking part

    /// Your message to a chat there. `named`: the block naming the agents it names with &, worked
    /// out here (the machine doesn't know them).
    func send(_ text: String, to id: String) async throws {
        guard let machine = machine(of: id), let api = api(machine) else { throw Failure.away(machine(of: id) ?? "Its machine") }
        let members = Set((chat(id)?.group.members ?? []).compactMap { app?.bots.bot($0)?.sessionID })
        let named = AgentReferences.note(naming: AgentReferences.named(in: [text], excluding: members), here: machine)
        let message = try await api.machineGroupAction(id, "send", ["text": .string(text)].merging(named.map { ["named": .string($0)] } ?? [:]) { $1 })
        Analytics.shared.track("group_message", ["discussing": discussing.contains(id), "place": "machine"])
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
        guard let machine = machine(of: id), let api = api(machine),
              let answer = try? await api.machineGroupAction(id, "undo", ["message": .string(messageID)]) else { return nil }
        await reload(id)
        return answer["text"]?.string
    }

    func markViewed(_ id: String) {
        Notifier.shared.clear(session: BotGroups.tabKey(id))
        guard let index = chats.firstIndex(where: { $0.group.id == id }), isUnread(chats[index].group) else { return }
        let now = Date(timeIntervalSince1970: Self.seconds(.now))
        chats[index].group.viewed = now
        save()
        guard let api = api(chats[index].machine) else { return }
        let viewed = ISO8601DateFormatter().string(from: now)
        Task { try? await api.editMachineGroup(id, ["viewed": .string(viewed)]) }
    }

    func isUnread(_ group: BotGroup) -> Bool {
        guard let last = messages(in: group.id).last(where: { $0.author != nil && $0.kind != .note }) else { return false }
        return last.time > (group.viewed ?? .distantPast)
    }

    /// A new name, purpose, members (the lead first) or meeting, there.
    func update(_ edited: BotGroup) async throws {
        guard let machine = machine(of: edited.id), let api = api(machine) else { throw Failure.away(machine(of: edited.id) ?? "Its machine") }
        var edits: [String: JSONValue] = [
            "name": .string(edited.name), "purpose": edited.purpose.map(JSONValue.string) ?? .null,
            "members": .array(edited.members.map(JSONValue.string)),
        ]
        if let meeting = edited.meeting, let value = Self.json(meeting) { edits["meeting"] = value } else { edits["meeting"] = .null }
        try await api.editMachineGroup(edited.id, edits)
        await reload(edited.id)
    }

    /// Deleted there: its seats, its messages; its bots forget it.
    func delete(_ group: BotGroup) async throws {
        guard let machine = machine(of: group.id), let api = api(machine) else { throw Failure.away(machine(of: group.id) ?? "Its machine") }
        do {
            try await api.deleteMachineGroup(group.id)
        } catch let refused as ServerError where refused.status == 404 && refused.message == "No such chat." {
            // Gone there already: as good as deleted.
        } catch let refused as ServerError where refused.status == 409 {
            // Moving, from another Mac.
            throw Moves.Failure.moving
        }
        forget(group.id)
    }

    /// A bot being deleted leaves its chats there.
    func remove(_ bot: Bot) async {
        for chat in chats where chat.group.members.contains(bot.id) {
            var group = chat.group
            group.members.removeAll { $0 == bot.id }
            try? await update(group)
        }
    }

    private func act(_ id: String, _ action: String, _ body: [String: JSONValue] = [:]) {
        guard let machine = machine(of: id), let api = api(machine) else { return }
        Task { _ = try? await api.machineGroupAction(id, action, body) }
    }

    // MARK: Moving one

    /// A chat brought to a machine, with its messages (`Moves`): held there until `activate`.
    func bring(_ group: BotGroup, messages: [GroupMessage], to machine: String) async throws {
        guard let api = api(machine) else { throw Failure.away(machine) }
        try await api.putMachineGroup(group, messages: messages, held: true)
        apply(group, held: true, state: State(discussing: false, paused: false), on: machine)
        logs[group.id] = messages
        saveLog(group.id)
    }

    func activate(_ id: String) async throws {
        guard let machine = machine(of: id), let api = api(machine) else { throw Failure.away(machine(of: id) ?? "Its machine") }
        _ = try await api.machineGroupAction(id, "activate")
        await reload(id)
    }

    /// Held there for a move away: its talk stops; the chat as it is now.
    func hold(_ id: String) async throws -> (group: BotGroup, messages: [GroupMessage]) {
        guard let machine = machine(of: id), let api = api(machine) else { throw Failure.away(machine(of: id) ?? "Its machine") }
        guard let held = try await api.machineGroupAction(id, "hold"),
              let group = held["group"].flatMap({ try? Self.decode(BotGroup.self, from: $0) }),
              let messages = held["messages"].flatMap({ try? Self.decode([GroupMessage].self, from: $0) }) else { throw Failure.unreadable }
        return (group, messages)
    }

    /// Let go there, its seats left (its bots stay there); gone from here.
    func release(_ id: String) async throws {
        guard let machine = machine(of: id), let api = api(machine) else { throw Failure.away(machine(of: id) ?? "Its machine") }
        _ = try await api.machineGroupAction(id, "release")
        forget(id)
    }

    /// One brought there that didn't get to start (a move taken back): gone there, seats and all
    /// left as they are (the chat goes on where it was). Whether it is (not if it wasn't there).
    func takeBack(_ id: String, on machine: String) async -> Bool {
        guard let api = api(machine) else { return false }
        do {
            _ = try await api.machineGroupAction(id, "release")
        } catch let error as ServerError where error.status == 404 {
            // Never got there.
        } catch {
            return false
        }
        if self.machine(of: id) == machine { forget(id) }
        return true
    }

    enum Failure: LocalizedError {
        case away(String)
        case unreadable
        var errorDescription: String? {
            switch self {
            case .away(let machine): "\(machine) isn’t connected. Connect to it, then try again."
            case .unreadable: "The machine’s answer couldn’t be read."
            }
        }
    }

    // MARK: Settings

    /// What every chat on a machine goes by, from this Mac: what each personality tells a bot,
    /// who sets what about a bot, Ask First, what its Settings › Permissions deny, your time zone.
    func giveSettings(to machine: String) async {
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
        guard let data = try? encoder.encode(settings), settingsGiven[machine] != data else { return }
        do {
            try await api.giveMachineGroupSettings(.object(settings))
            settingsGiven[machine] = data
        } catch {
            log.error("\(machine, privacy: .public)'s group chats didn't get this Mac's settings: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Settings changed here: each machine connected now gets them.
    func settingsChanged() {
        for machine in Set(app?.machines.engines.values.filter(\.isReady).map(\.machine.id) ?? []).union(running) where reachable(machine) {
            Task { await giveSettings(to: machine) }
        }
    }

    // MARK: Plumbing

    /// A machine's bridge, while it's up (tests give their own).
    @ObservationIgnored var bridge: ((String) -> OpenCodeAPI?)?

    private func api(_ machine: String) -> OpenCodeAPI? {
        if let bridge { return bridge(machine) }
        guard let engine = app?.machines.engine(machine), engine.isReady else { return nil }
        return engine.agents.api
    }

    /// Whether a machine's bridge can be reached now.
    func reachable(_ machine: String) -> Bool { api(machine) != nil }

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

private extension String {
    /// A chat's ID in a path (they're letters, digits and "_" anyway).
    var groupPathEscaped: String { addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "_-"))) ?? self }
}

extension OpenCodeAPI {
    struct MachineGroupRead: Decodable {
        var group: BotGroup
        var status: String
        var state: MachineGroups.State
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

    func machineGroups() async throws -> [MachineGroups.Listed] {
        struct Answer: Decodable { var data: [MachineGroups.Listed] }
        return try await groupData(try client.request("GET", "api/kuvo/groups"), as: Answer.self).data
    }

    func machineGroup(_ id: String) async throws -> MachineGroupRead {
        struct Answer: Decodable { var data: MachineGroupRead }
        return try await groupData(try client.request("GET", "api/kuvo/groups/\(id.groupPathEscaped)"), as: Answer.self).data
    }

    func putMachineGroup(_ group: BotGroup, messages: [GroupMessage], held: Bool) async throws {
        struct Body: Encodable { var group: BotGroup; var messages: [GroupMessage]; var status: String }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let body = try JSONDecoder().decode(JSONValue.self, from: encoder.encode(Body(group: group, messages: messages, status: held ? "held" : "active")))
        _ = try await client.send(try client.request("PUT", "api/kuvo/groups/\(group.id.groupPathEscaped)", body: body), as: JSONValue.self)
    }

    func editMachineGroup(_ id: String, _ edits: [String: JSONValue]) async throws {
        _ = try await client.send(try client.request("PATCH", "api/kuvo/groups/\(id.groupPathEscaped)", body: JSONValue.object(edits)), as: JSONValue.self)
    }

    func deleteMachineGroup(_ id: String) async throws {
        _ = try await client.send(try client.request("DELETE", "api/kuvo/groups/\(id.groupPathEscaped)"), as: JSONValue.self)
    }

    /// What `action` answers, its `data`.
    func machineGroupAction(_ id: String, _ action: String, _ body: [String: JSONValue] = [:]) async throws -> JSONValue? {
        let answer = try await client.send(try client.request("POST", "api/kuvo/groups/\(id.groupPathEscaped)/\(action)", body: JSONValue.object(body)), as: JSONValue.self)
        return answer["data"]
    }

    func giveMachineGroupSettings(_ settings: JSONValue) async throws {
        _ = try await client.send(try client.request("PUT", "api/kuvo/groups/settings", body: settings), as: JSONValue.self)
    }
}
