import Foundation
import OpenCodeKit

// How you can write to a subagent, the same in both apps. Its box says, on the subagent's session
// (`kuvo.messages`), and a client shows the composer, the composer with where a message goes, or,
// in its place, why it can't take one.

/// How you can write to a subagent: to it, through the agent that started it, or not at all.
public enum SubagentMessages: Equatable, Sendable {
    /// To it: the engine's subagents, and Codex's.
    case direct
    /// Through the agent that started it, which passes it on (Claude Code's): the conversation
    /// that started it shows that step.
    case throughParent
    /// Not at all, and why: "Antigravity can't take messages for its subagents."
    case unavailable(String)

    /// What a coding agent's subagent says on a box from before boxes said how to write to one.
    public static let fromOlderBox = "Its agent runs it for the conversation that started it: write there to steer it, or stop it."

    /// How you can write to the subagent whose session this is.
    public static func of(_ session: Session) -> SubagentMessages {
        let route = session.metadata?["kuvo"]?["messages"]
        switch route?["via"]?.string {
        case "direct": return .direct
        case "parent": return .throughParent
        case "none": return .unavailable(route?["note"]?.string ?? fromOlderBox)
        default:
            // A coding agent's (its box marks whose it is), from a box that doesn't say: not at
            // all, as before. The engine's: to it.
            return session.metadata?["kuvoAgent"]?.string != nil ? .unavailable(fromOlderBox) : .direct
        }
    }

    /// Whether there's a composer for it.
    public var takesMessages: Bool {
        if case .unavailable = self { false } else { true }
    }

    /// The line a client shows: over the composer, where a message goes through the conversation
    /// that started it ("Goes through Fix the login bug"); in the composer's place, why it can't
    /// take one. None when it goes to it.
    public func line(parentTitle: String) -> String? {
        switch self {
        case .direct: nil
        case .throughParent: "Goes through \(parentTitle)"
        case .unavailable(let why): why
        }
    }
}
