import Foundation

/// A goal a conversation's agent works toward on its own, turn after turn, until a check after
/// each turn finds it met ("/goal all tests in test/auth pass"). The box the conversation lives on
/// runs it (its agents bridge, beside its engine), with no client there: this is what a client
/// shows of it and how it changes it (PROTOCOL.md, "Goals").
public struct Goal: Codable, Sendable, Hashable, Identifiable {
    public enum State: String, Codable, Sendable, Hashable {
        /// The agent is at work on it, or about to be.
        case working
        /// Held: by you, or by the box (a turn failed, the agent stopped making progress, a long
        /// run of turns). Resume lets it go on.
        case paused
        /// A check found it met.
        case met
        /// A check found it can't be met as asked.
        case unmet
    }

    public enum PausedBy: String, Codable, Sendable, Hashable {
        case you, error, stalled, limit
    }

    public enum Verdict: String, Codable, Sendable, Hashable {
        case met
        case notMet = "not_met"
        case impossible
    }

    public struct Check: Codable, Sendable, Hashable {
        public var verdict: Verdict
        /// What's left, or the proof it's met.
        public var reason: String
        /// In ms since 1970.
        public var at: Double
    }

    public var session: String
    public var condition: String
    public var state: State
    /// Why it's paused, or why it can't be met.
    public var note: String?
    public var pausedBy: PausedBy?
    /// When it was set, and when it was met or found impossible, in ms since 1970.
    public var started: Double
    public var ended: Double?
    /// Turns the agent has taken toward it, each one checked.
    public var turns: Int
    /// A check is under way.
    public var checking: Bool
    public var last: Check?

    public var id: String { session }

    public var startedDate: Date { Date(timeIntervalSince1970: started / 1000) }
    public var endedDate: Date? { ended.map { Date(timeIntervalSince1970: $0 / 1000) } }
    /// Over: met, or it can't be.
    public var isOver: Bool { state == .met || state == .unmet }

    /// What marks a goal's messages to the agent ("[Goal] …"), which a conversation shows as the goal's.
    public static let marker = "[Goal] "

    /// "/goal" in the composer's command list.
    public static let command = Command(name: "goal", description: "Keep working until a goal is met")
}

/// What "/goal …" asks for: a goal set (what follows), or the one there paused, resumed or taken
/// away. "/goal" alone shows it.
public enum GoalCommand: Equatable, Sendable {
    case set(String)
    case show
    case pause
    case resume
    case clear

    /// The words that take a goal away (as Claude Code's /goal takes them).
    static let clearing: Set<String> = ["clear", "stop", "off", "reset", "none", "cancel"]

    /// "/goal …" as typed, or nil for anything else.
    public init?(_ text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.lowercased().hasPrefix("/goal"), text.dropFirst("/goal".count).first.map(\.isWhitespace) ?? true else { return nil }
        let rest = text.dropFirst("/goal".count).trimmingCharacters(in: .whitespacesAndNewlines)
        switch rest.lowercased() {
        case "": self = .show
        case "pause": self = .pause
        case "resume": self = .resume
        case let word where Self.clearing.contains(word): self = .clear
        default: self = .set(rest)
        }
    }

    /// Whether it needs the conversation's model to run (setting a goal starts the agent on it).
    public var needsModel: Bool {
        if case .set = self { true } else { false }
    }
}

extension OpenCodeAPI {
    // A box's goals live in its agents bridge: these go to the bridge's API (on this Mac,
    // `/api/kuvo/goals`; from a phone, `kuvo/agents/api/kuvo/goals`).

    /// Every goal on the box, met ones too until they're taken away.
    public func goals() async throws -> [Goal] {
        try await client.send(try client.request("GET", "api/kuvo/goals"), as: DataEnvelope<[Goal]>.self).data
    }

    /// Sets a conversation's goal, in place of one it had, and starts its agent on it.
    @discardableResult
    public func setGoal(session: String, condition: String) async throws -> Goal {
        struct Body: Encodable { var condition: String }
        return try await client.send(try client.request("PUT", "api/kuvo/goals/\(session.pathEscaped)", body: Body(condition: condition)), as: DataEnvelope<Goal>.self).data
    }

    @discardableResult
    public func pauseGoal(session: String) async throws -> Goal {
        try await client.send(try client.request("POST", "api/kuvo/goals/\(session.pathEscaped)/pause"), as: DataEnvelope<Goal>.self).data
    }

    @discardableResult
    public func resumeGoal(session: String) async throws -> Goal {
        try await client.send(try client.request("POST", "api/kuvo/goals/\(session.pathEscaped)/resume"), as: DataEnvelope<Goal>.self).data
    }

    /// Takes the goal away (or the one it met).
    public func clearGoal(session: String) async throws {
        _ = try await client.send(try client.request("DELETE", "api/kuvo/goals/\(session.pathEscaped)"), as: Empty.self)
    }
}

/// `kuvo.goal.updated`: a goal changed (`goal`), or went (`goal` null).
public struct GoalUpdate: Decodable, Sendable {
    public var sessionID: String
    public var goal: Goal?
}
