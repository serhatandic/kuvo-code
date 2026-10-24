import Foundation
import OpenCodeKit

/// A group chat: you and some of your bots, talking something through. Each bot takes part from
/// a seat of its own, a session where it lives with its job and memory, hidden from the lists.
/// The computer the chat lives on runs it (its coding agents' bridge, `Agents/src/groups`): it
/// passes the floor around one bot at a time, so no two ever talk at once. This is the chat as that
/// computer says it, for the window to show (`BoxGroups`).
struct BotGroup: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    /// What it's for, in a few words: "Plan each week's release". Nil or empty for nothing in particular.
    var purpose: String?
    /// Its bots, in order; the first leads.
    var members: [String]
    /// Each member's seat: its session for this chat, made at its first turn.
    var seats: [String: String] = [:]
    /// The last message each member's seat has been given.
    var heard: [String: String] = [:]
    /// Seats that run with the coding agents (their bot's model is one of theirs, or Auto).
    var agentSeats: Set<String>?
    var created: Date
    /// When you last looked at it.
    var viewed: Date?
    /// Bots that heard messages you since took back, with the start of the first of them: they're
    /// told to set it aside at their next turn.
    var retracted: [String: String]?
    /// When it meets on its own, like a standup every weekday at 9; nil for a chat that only
    /// talks when you write.
    var meeting: Meeting?

    var lead: String? { members.first }

    /// A meeting you scheduled: at `next`, its topic goes to the chat and the bots talk it through.
    /// The computer the chat lives on works out its times, on its clock.
    struct Meeting: Codable, Hashable {
        var next: Date
        /// How often it comes back, as kuvo-wake writes it (1d, weekdays…); nil for once.
        var every: String?
        var topic: String
        /// The time of day one that repeats by days keeps, in minutes, from its first time, so
        /// daylight saving or a new time zone doesn't move it for good.
        var at: Int?
        /// The day of the week a weekly one keeps, likewise (1 is Sunday).
        var weekday: Int?

        var repeats: Wakes.Repeat? { every.flatMap(Wakes.Repeat.init) }
    }
}

/// What a bot is doing on its turn, as its seat shows it: the chat shows its last step under
/// who's talking, so a long turn doesn't look stuck. The computer the chat lives on says it as it runs.
enum GroupActivity: Codable, Hashable {
    /// A tool it called (without what it gave back).
    case step(Message.ToolCall)
    /// Its thinking, the line it's on.
    case thinking(String)
    /// Its reply, being written.
    case writing

    private enum Key: String, CodingKey { case kind, call, text }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "tool": self = .step(try c.decode(Message.ToolCall.self, forKey: .call))
        case "thinking": self = .thinking(try c.decodeIfPresent(String.self, forKey: .text) ?? "")
        default: self = .writing
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case .step(let call):
            try c.encode("tool", forKey: .kind)
            try c.encode(call, forKey: .call)
        case .thinking(let text):
            try c.encode("thinking", forKey: .kind)
            try c.encode(text, forKey: .text)
        case .writing:
            try c.encode("writing", forKey: .kind)
        }
    }
}

struct GroupMessage: Codable, Identifiable, Hashable {
    var id: String
    /// The bot that wrote it; nil for you.
    var author: String?
    var text: String
    var time: Date
    var kind: Kind = .message
    /// What the bot did on its turn before it wrote this: its searches, reads and commands.
    var steps: [Message.ToolCall]?
    /// On a wrap-up: the work it split up, who does what. Each bot does its part in its own
    /// conversation, once you say go (or straight away, if you already had).
    var tasks: [GroupTask]?
    /// On a bot's message: the part of the work it's reporting back on, from its own conversation.
    var report: String?

    enum Kind: String, Codable {
        /// Said in the chat.
        case message
        /// The lead's sum-up at the end of a discussion.
        case wrapUp
        /// From Kuvo Code: a bot that couldn't take part.
        case note
        /// A meeting you scheduled, come due: its topic.
        case meeting
    }
}

/// A part of the work a chat split up: who does it, what it is, and how it's going.
struct GroupTask: Codable, Hashable, Identifiable {
    var id: String
    /// The bot doing it.
    var bot: String
    var task: String
    var state: State = .proposed
    /// Its message in the bot's own conversation, once it went there.
    var prompt: String?
    var started: Date?
    var finished: Date?
    /// The bots whose parts come first: it starts once theirs are done, with what they reported.
    var after: [String]?

    enum State: String, Codable {
        /// In the wrap-up, waiting for you to say go.
        case proposed
        /// Started, but waiting for the parts it comes after.
        case waiting
        /// In the bot's own conversation, under way.
        case working
        /// The bot reported back.
        case done
        /// It couldn't be done: the bot's machine away, an error.
        case failed
    }
}

/// A part of a chat's work, as it reaches the bot's own conversation: which chat it's from and
/// what the part is, then what was decided and how to report back (for the bot, not shown). The
/// chat's computer writes it (`compose` in `Agents/src/groups/rules.ts`); the bot's conversation
/// shows it as a card.
enum GroupWork {
    private static let opening = "[Work from "
    private static let divider = "\n\n---\n"

    /// The chat a message came from and the part it hands over. Its first line is
    /// "[Work from <name> · <chat>]", read from the end, as a name can hold anything.
    static func parse(_ text: String) -> (chat: String, id: String, task: String)? {
        guard text.hasPrefix(opening) else { return nil }
        let first = text.prefix { $0 != "\n" }
        guard first.hasSuffix("]"), let dot = first.range(of: " · ", options: .backwards), dot.lowerBound > first.index(first.startIndex, offsetBy: opening.count) else { return nil }
        let name = String(first[first.index(first.startIndex, offsetBy: opening.count)..<dot.lowerBound])
        let id = String(first[dot.upperBound..<first.index(before: first.endIndex)])
        var task = String(text.dropFirst(first.count))
        if let cut = task.range(of: divider) { task = String(task[..<cut.lowerBound]) }
        return (name, id, task.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

/// Group chats in the window's tabs.
enum BotGroups {
    /// The key under which a bot's own conversation remembers this Mac's chats.
    static let memoryKey = "kuvo.groups"

    static func tabKey(_ id: String) -> String { TabKey.group(id).text }

    static func groupID(fromTab key: String) -> String? {
        TabKey(key).groupID
    }
}
