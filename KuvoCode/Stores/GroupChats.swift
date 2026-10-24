import Foundation
import OpenCodeKit

/// Every group chat, wherever it lives, as the window and the phone show them: this Mac's
/// (`BotGroups`, which runs them) and your machines' (`BoxGroups`, which their machines run).
/// What you do in one goes to where it lives.
@MainActor @Observable
final class GroupChats {
    let mac: BotGroups
    let machines: BoxGroups

    init(mac: BotGroups, machines: BoxGroups) {
        self.mac = mac
        self.machines = machines
    }

    /// One that lives on a machine: not this Mac's (while both have it, as it moves, this Mac's is the one).
    private func onMachine(_ id: String) -> Bool { machines.has(id) && mac.group(id) == nil }
    /// The machine a group chat lives on; nil for this Mac's.
    func machine(of id: String) -> String? { onMachine(id) ? machines.chats.first { $0.group.id == id }?.machine : nil }
    private var machineChats: [BoxGroups.Chat] { machines.chats.filter { mac.group($0.group.id) == nil } }

    var list: [BotGroup] { mac.list + machineChats.map(\.group) }
    var speaking: [String: String] { mac.speaking.merging(machines.speaking.filter { onMachine($0.key) }) { first, _ in first } }
    /// What the bot talking is doing, by chat (see `GroupActivity`).
    var activity: [String: [GroupActivity]] { mac.activity.merging(machines.activity.filter { onMachine($0.key) }) { first, _ in first } }
    var discussing: Set<String> { mac.discussing.union(machines.discussing.filter(onMachine)) }
    var paused: Set<String> { mac.paused.union(machines.paused.filter(onMachine)) }
    var seatIDs: Set<String> { mac.seatIDs.union(machines.seatIDs) }

    func group(_ id: String?) -> BotGroup? { mac.group(id) ?? machines.group(id) }
    func group(seat: String) -> BotGroup? { mac.group(seat: seat) ?? machines.group(seat: seat) }
    func messages(in id: String) -> [GroupMessage] { onMachine(id) ? machines.messages(in: id) : mac.messages(in: id) }
    /// The machine a chat lives on; nil for this Mac.
    func machine(of id: String?) -> String? { id.flatMap { onMachine($0) ? machines.machine(of: $0) : nil } }
    func isUnread(_ group: BotGroup) -> Bool { onMachine(group.id) ? machines.isUnread(group) : mac.isUnread(group) }
    func name(of author: String?) -> String { mac.name(of: author) }

    /// The machine a chat lives on while you can't reach it there: what you write waits.
    func unreachable(_ id: String) -> String? { onMachine(id) ? machines.unreachable(id) : nil }

    func markViewed(_ id: String) {
        if onMachine(id) { machines.markViewed(id) } else { mac.markViewed(id) }
    }

    /// Your message, unless it's moving (it waits then, where it was written). To a chat on a
    /// machine it goes there, and back in the composer (with why) if it can't. Whether it went.
    @discardableResult
    func send(_ text: String, to id: String) -> Bool {
        guard !Moves.isFrozen(id) else { return false }
        guard onMachine(id) else {
            mac.send(text, to: id)
            return true
        }
        Task {
            do {
                try await machines.send(text, to: id)
            } catch {
                let key = BotGroups.tabKey(id)
                let draft = Drafts.shared[key].text
                Drafts.shared[key].text = [text, draft].filter { !$0.isEmpty }.joined(separator: "\n\n")
                Modal.show(error)
            }
        }
        return true
    }

    /// The same, once it's there: for the phone, which says what came of it.
    func sendNow(_ text: String, to id: String) async -> Bool {
        guard !Moves.isFrozen(id) else { return false }
        guard onMachine(id) else {
            mac.send(text, to: id)
            return true
        }
        return (try? await machines.send(text, to: id)) != nil
    }

    func stop(_ id: String) {
        if onMachine(id) { machines.stop(id) } else { mac.stop(id) }
    }

    func keepGoing(_ id: String) {
        if onMachine(id) { machines.keepGoing(id) } else { mac.keepGoing(id) }
    }

    func startWork(_ wrapUpID: String, in id: String) {
        if onMachine(id) { machines.startWork(wrapUpID, in: id) } else { mac.startWork(wrapUpID, in: id) }
    }

    /// Takes the chat back to before one of your messages; its words, for the composer.
    func undo(from messageID: String, in id: String) async -> String? {
        guard !Moves.isFrozen(id) else { return nil }
        return onMachine(id) ? await machines.undo(from: messageID, in: id) : mac.undo(from: messageID, in: id)
    }

    /// A change from elsewhere (a phone) to a chat on a machine, as it was asked: that machine
    /// decides what it can be. What stops it is said there, not here.
    func changeThere(_ id: String, _ fields: JSONValue) async throws {
        guard !Moves.isFrozen(id) else { throw Moves.Failure.moving }
        try await machines.edit(id, fields)
    }

    /// Who can be in a chat, as the computer it lives on says; nil for this Mac's (any bot), or
    /// when its machine can't say now.
    func joinable(for id: String) async -> [String]? {
        guard let machine = machine(of: id) else { return nil }
        return await machines.joinable(machine)
    }

    /// A new chat, on this Mac.
    func create(name: String, purpose: String? = nil, members: [String], meeting: BotGroup.Meeting? = nil) -> BotGroup {
        mac.create(name: name, purpose: purpose, members: members, meeting: meeting)
    }

    func update(_ edited: BotGroup) async {
        do { try await change(edited) } catch { Modal.show(error) }
    }

    /// As `update`, for a change from elsewhere (a phone): what stops it is said there, not here.
    func change(_ edited: BotGroup) async throws {
        // Moving: what you changed would be left behind.
        guard !Moves.isFrozen(edited.id) else { throw Moves.Failure.moving }
        guard onMachine(edited.id) else { return await mac.update(edited) }
        try await machines.update(edited)
    }

    func delete(_ group: BotGroup) async {
        do { try await deleteNow(group) } catch { Modal.show(error) }
    }

    /// As `delete`, for one deleted from elsewhere (a phone): what stops it is said there, not here.
    func deleteNow(_ group: BotGroup) async throws {
        guard !Moves.isFrozen(group.id) else { throw Moves.Failure.moving }
        guard onMachine(group.id) else { return await mac.delete(group) }
        try await machines.delete(group)
    }
}
