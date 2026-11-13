import Foundation
import OpenCodeKit

/// What a typed message means, as its conversation's box decides it (`kuvo/sessions/<id>/typed`,
/// PROTOCOL.md, "What a typed message means"): the box does what's its own (a goal, a side
/// question, a handoff, a review, a /loop's wake-up, Autopilot on) and says what the client does
/// with the rest. A client keeps the draft, puts back what it's told to, and draws.
public enum Typed {
    /// What a box answers the route with in `kuvo/info`'s `features`: a box without it can't say.
    public static let feature = "typed"

    /// The route that answers for `session` (its path part escaped).
    public static func route(_ session: String) -> String {
        "kuvo/sessions/" + (session.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#+"))) ?? session) + "/typed"
    }

    /// Whether the box is to be asked what `text` means: one whose first character that isn't a
    /// space is "/" or "!". Any other is a plain message, which the box would only say to send (or,
    /// with a model that can't run, to keep, saying why): a client sends it without asking.
    public static func asksBox(_ text: String) -> Bool {
        guard let first = text.first(where: { !$0.isWhitespace }) else { return false }
        return first == "/" || first == "!"
    }

    /// What's sent: the text as typed, whether pictures or files are attached, whether the side
    /// thread's tag is on the composer, why the conversation's model can't run (as the client shows
    /// it), and the model picked last in "Who reads it".
    public struct Ask: Encodable, Sendable {
        public var text: String
        public var files: Bool
        public var side: Bool
        public var refusal: String?
        public var reviewer: ModelRef?

        public init(text: String, files: Bool, side: Bool = false, refusal: String? = nil, reviewer: ModelRef? = nil) {
            self.text = text
            self.files = files
            self.side = side
            self.refusal = refusal
            self.reviewer = reviewer
        }
    }

    /// What goes back to the composer: `text` into an empty one; beside words written since,
    /// `beside` in front of them where it's given, else `text`.
    public struct Restore: Decodable, Equatable, Sendable {
        public var text: String
        public var beside: String?

        /// What goes in front of the composer's `draft`.
        public func text(beside draft: String) -> String { draft.isEmpty ? text : beside ?? text }
    }

    public struct Run: Decodable, Equatable, Sendable {
        public var name: String
        public var arguments: String
    }

    /// A message to send: its words, the keyword it was sent with as typed ("/plan"), whether the
    /// composer's quotes go with it (they stay otherwise), and whether it goes to the agent now,
    /// never to wait in the queue (a /loop's first).
    public struct Send: Decodable, Equatable, Sendable {
        public var text: String
        public var typed: String?
        public var quoted: Bool?
        public var steer: Bool?

        /// Whether it waits for the agent's run, as `queue` asks (Send's long press, ⌘Return).
        public func queues(_ queue: Bool) -> Bool { steer == true ? false : queue }
    }

    public struct WakeUp: Decodable, Equatable, Sendable {
        /// Seconds since 1970.
        public var due: Double
        public var every: String
        public var note: String
    }

    public enum Plan: String, Decodable, Sendable { case toggle, on }

    /// The box's answer. `Autopilot` is how the client reads a conversation's Autopilot (as
    /// `kuvo/sessions/<id>/autopilot` answers). In the order a client applies it: what the box did,
    /// then what the client does, then what goes back. The composer's files go with `send` or
    /// `command` (they stay otherwise).
    public struct Answer<Autopilot: Decodable>: Decodable {
        /// The keyword it ran ("plan"), for what a client counts.
        public var keyword: String?
        public var goal: Goal?
        public var goalCleared: Bool?
        public var askedBot: Bool?
        public var autopilot: Autopilot?
        public var wakeUp: WakeUp?
        public var sideQuestion: SideQuestion?
        public var handoff: Handoff?
        public var review: Review?
        public var showGoal: Bool?
        public var plan: Plan?
        public var toggleAutopilot: Bool?
        public var compact: Bool?
        public var shell: String?
        public var command: Run?
        public var send: Send?
        public var sideThread: Bool?
        public var restore: Restore?
        public var error: String?

        /// The composer's files go (with what's sent or run).
        public var takesFiles: Bool { send != nil || command != nil }
    }

    /// A keyword "/" offers in a conversation, as its box words it.
    public struct OfferedKeyword: Decodable, Equatable, Sendable {
        public var name: String
        public var title: String
        public var summary: String
        public var argument: String?
    }

    /// What "/" offers in a conversation: its keywords (and, for a client that draws the list from
    /// its box, the engine's commands as "/" lists them).
    public struct Offers: Decodable, Equatable, Sendable {
        public var keywords: [OfferedKeyword]
        public var commands: [Command]

        /// The keywords this client knows how to draw, in the box's order.
        public var known: [Keyword] { keywords.compactMap { Keyword(rawValue: $0.name) } }
    }
}
