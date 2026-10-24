import Foundation
import OpenCodeKit

/// Every group chat, wherever it lives, as the window shows them: each computer's, which that
/// computer's bridge runs (`BoxGroups`). What you do in one goes to where it lives, and what it
/// can't take comes back to you here: your words to the composer, and why.
@MainActor @Observable
final class GroupChats {
    let boxes: BoxGroups

    init(boxes: BoxGroups) {
        self.boxes = boxes
    }

    var list: [BotGroup] { boxes.shown.map(\.group) }
    var speaking: [String: String] { boxes.speaking }
    /// What the bot talking is doing, by chat (see `GroupActivity`).
    var activity: [String: [GroupActivity]] { boxes.activity }
    var discussing: Set<String> { boxes.discussing }
    var paused: Set<String> { boxes.paused }
    var seatIDs: Set<String> { boxes.seatIDs }

    func group(_ id: String?) -> BotGroup? { boxes.group(id) }
    func group(seat: String) -> BotGroup? { boxes.group(seat: seat) }
    func messages(in id: String) -> [GroupMessage] { boxes.messages(in: id) }
    /// The machine a chat lives on; nil for this Mac.
    func machine(of id: String?) -> String? { boxes.machine(of: id) }
    func isUnread(_ group: BotGroup) -> Bool { boxes.isUnread(group) }

    /// Whether you can reach a chat where it lives now (see `BoxGroups.Reach`).
    func reach(_ id: String) -> BoxGroups.Reach { boxes.reach(id) }
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
        // Who it names with & is worked out where it lives: this Mac's box from the list as it is now.
        if boxes.machine(of: id) == nil { AgentMail.shared.writeBoxDirectory() }
        Task {
            do {
                try await boxes.send(text, to: id)
            } catch {
                let key = BotGroups.tabKey(id)
                let draft = Drafts.shared[key].text
                Drafts.shared[key].text = [text, draft].filter { !$0.isEmpty }.joined(separator: "\n\n")
                Modal.show(error)
            }
        }
        return true
    }

    func stop(_ id: String) { boxes.stop(id) }
    func keepGoing(_ id: String) { boxes.keepGoing(id) }
    func startWork(_ wrapUpID: String, in id: String) { boxes.startWork(wrapUpID, in: id) }

    /// Takes the chat back to before one of your messages; its words, for the composer.
    func undo(from messageID: String, in id: String) async -> String? {
        await boxes.undo(from: messageID, in: id)
    }

    /// Who can be in a chat on a computer (nil: this Mac), as it says; nil when it can't say now.
    func joinable(on machine: String?) async -> [String]? {
        await boxes.joinable(machine)
    }

    /// A new chat, on this Mac.
    func create(name: String, purpose: String?, members: [String], meeting: BoxGroups.MeetingPlan?) async throws -> BotGroup {
        try await boxes.create(name: name, purpose: purpose, members: members, meeting: meeting)
    }

    /// Its name, purpose, bots or meeting changed, where it lives; what stops it is said.
    func update(_ id: String, name: String, purpose: String?, members: [String], meeting: BoxGroups.MeetingPlan?) async {
        do { try await boxes.update(id, name: name, purpose: purpose, members: members, meeting: meeting) } catch { Modal.show(error) }
    }

    func delete(_ group: BotGroup) async {
        do { try await boxes.delete(group) } catch { Modal.show(error) }
    }
}
