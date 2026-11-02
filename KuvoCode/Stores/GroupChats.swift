import ClientText
import Foundation
import OpenCodeKit

/// Every group chat, wherever it lives, as the window shows them: each computer's, which that
/// computer's bridge runs (`BoxGroups`). What you do in one goes to where it lives, and what it
/// can't take comes back to you here: your words to the composer, and why.
@MainActor @Observable
final class GroupChats {
    let boxes: BoxGroups
    /// Your last message on its way to each chat: the next to that chat goes after it.
    @ObservationIgnored private var sending: [String: Task<Void, Never>] = [:]

    init(boxes: BoxGroups) {
        self.boxes = boxes
    }

    var list: [BotGroup] { boxes.groups }
    /// Every chat's (whoever reads these hears of every chat's talk): a view of one chat reads
    /// that chat's own below, so the others' talk doesn't redraw it.
    var speaking: [String: String] { boxes.speaking }
    var discussing: Set<String> { boxes.discussing }
    var paused: Set<String> { boxes.paused }
    var seatIDs: Set<String> { boxes.seatIDs }

    /// The bot talking in a chat.
    func speaker(in id: String) -> String? { boxes.speaker(in: id) }
    /// Its talk under way.
    func isDiscussing(_ id: String) -> Bool { boxes.isDiscussing(id) }
    /// Keep Going waiting, after the wrap-up at the limit.
    func isPaused(_ id: String) -> Bool { boxes.isPaused(id) }
    /// What the bot talking is doing (see `GroupActivity`).
    func activity(in id: String) -> [GroupActivity] { boxes.activity(in: id) }
    /// The bots whose part of the work waits on their conversation, stopped by you.
    func stopped(in id: String) -> Set<String> { boxes.stopped(in: id) }

    func group(_ id: String?) -> BotGroup? { boxes.group(id) }
    func group(seat: String) -> BotGroup? { boxes.group(seat: seat) }
    func messages(in id: String) -> [GroupMessage] { boxes.messages(in: id) }
    /// The machine a chat lives on; nil for this Mac.
    func machine(of id: String?) -> String? { boxes.machine(of: id) }
    func isUnread(_ group: BotGroup) -> Bool { boxes.isUnread(group) }

    /// Whether you can reach a chat where it lives now (see `BoxGroups.Reach`).
    func reach(_ id: String) -> BoxGroups.Reach { boxes.reach(id) }
    /// Whether a computer's chats can be reached now: this Mac's (nil), or a machine's.
    func reach(on machine: String?) -> BoxGroups.Reach { boxes.reach(on: machine) }
    /// The machine a chat lives on while you can't reach it there: what you write waits.
    func unreachable(_ id: String) -> String? { boxes.unreachable(id) }
    /// This Mac's group chats: running, starting, or stopped.
    var macReach: BoxGroups.Reach { boxes.macReach }

    func markViewed(_ id: String) { boxes.markViewed(id) }

    /// Your message, where the chat lives; back in the composer (with why) if it can't go. Whether
    /// it went on its way (not while its computer can't be reached: it waits in the composer).
    @discardableResult
    func send(_ text: String, to id: String) -> Bool {
        // Held for a move (its computer's status): it waits too, until it's where it's going.
        guard boxes.reach(id) == .ready, boxes.chat(id)?.held != true else { return false }
        // Who it names with & is worked out where it lives: this Mac's box from the list as it is
        // now. In the order you sent them, each after the one before.
        let refresh = boxes.machine(of: id) == nil && text.contains(AgentReferences.trigger)
        let before = sending[id]
        sending[id] = Task {
            await before?.value
            do {
                if refresh { await AgentMail.shared.refreshBoxDirectory() }
                try await boxes.send(text, to: id)
            } catch {
                let key = BotGroups.tabKey(id)
                let draft = Drafts.shared[key].text
                Drafts.shared[key].text = [WidgetAnswer.split(text).text, draft].filter { !$0.isEmpty }.joined(separator: "\n\n")
                Modal.show(error)
            }
        }
        return true
    }

    func stop(_ id: String) { saying { try await $0.stop(id) } }
    func keepGoing(_ id: String) { saying { try await $0.keepGoing(id) } }
    func startWork(_ wrapUpID: String, in id: String) { saying { try await $0.startWork(wrapUpID, in: id) } }

    /// Done where the chat lives; why it couldn't be, said.
    private func saying(_ action: @escaping (BoxGroups) async throws -> Void) {
        let boxes = boxes
        Task {
            do { try await action(boxes) } catch { Modal.show(error) }
        }
    }

    /// Takes the chat back to before one of your messages; its words, for the composer.
    func undo(from messageID: String, in id: String) async -> String? {
        await boxes.undo(from: messageID, in: id)
    }

    /// Who can be in a chat on a computer (nil: this Mac), as it says; nil when it can't say now.
    func joinable(on machine: String?) async -> [String]? {
        await boxes.joinable(machine)
    }

    /// A new chat, on this Mac or `machine`.
    func create(name: String, purpose: String?, members: [String], meeting: BoxGroups.MeetingPlan?, on machine: String? = nil) async throws -> BotGroup {
        try await boxes.create(name: name, purpose: purpose, members: members, meeting: meeting, on: machine)
    }

    /// Its name, purpose, bots or meeting changed, where it lives; what it refuses throws.
    func change(_ id: String, name: String, purpose: String?, members: [String], meeting: BoxGroups.MeetingPlan?) async throws {
        try await boxes.update(id, name: name, purpose: purpose, members: members, meeting: meeting)
    }

    func delete(_ group: BotGroup) async {
        do { try await boxes.delete(group) } catch { Modal.show(error) }
    }
}
