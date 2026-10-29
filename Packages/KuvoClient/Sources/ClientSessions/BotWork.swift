import Foundation
import OpenCodeKit

// A bot's work, as both apps show it (PROTOCOL.md, "Work"): which sessions a bot runs (their
// `kuvo.by`), the asks it answered for them (`kuvo.answers`), and its work as its box tells it
// (`kuvo/work`).

/// The bot a session works for, as its box marks every session under it.
public struct WorksFor: Sendable, Hashable {
    public let bot: String
    public let name: String

    /// The bot `session` works for, or nil for one of yours.
    public init?(_ session: Session) {
        guard let by = session.metadata?["kuvo"]?["by"], let bot = by["bot"]?.string, let name = by["name"]?.string, !bot.isEmpty else { return nil }
        self.bot = bot
        self.name = name
    }
}

/// An ask a session had, as a bot (or the conversation that started it) answered it: kept on the
/// session for every client to show on its step.
public struct WorkAnswer: Decodable, Sendable, Hashable, Identifiable {
    public enum Decision: String, Decodable, Sendable { case allow, deny, answer }
    public struct By: Decodable, Sendable, Hashable {
        public let bot: String?
        public let name: String
    }

    /// The session it was in: given in a bot's work, left out on the session itself.
    public var session: String?
    public let ask: String
    /// The tool call it was for, when the engine said.
    public let call: String?
    public let what: String
    public let decision: Decision
    public let reason: String
    public let by: By
    /// When, in ms since 1970.
    public let at: Double

    public var id: String { (session ?? "") + ask }
    public var date: Date { Date(timeIntervalSince1970: at / 1000) }

    /// The answers kept on `session`, oldest first.
    public static func on(_ session: Session) -> [WorkAnswer] {
        (try? session.metadata?["kuvo"]?["answers"]?.decode(as: [Lenient].self))?.compactMap(\.answer) ?? []
    }

    /// The answer to the ask a tool call made, in `session`.
    public static func forCall(_ call: String, in session: Session) -> WorkAnswer? {
        on(session).last { $0.call == call }
    }

    /// Each answer by the tool call that asked it, the latest for each, in `session`.
    public static func byCall(_ session: Session) -> [String: WorkAnswer] {
        var byCall: [String: WorkAnswer] = [:]
        for answer in on(session) { if let call = answer.call { byCall[call] = answer } }
        return byCall
    }

    /// One answer, or nothing for one that doesn't read as one (an older or newer box's).
    private struct Lenient: Decodable {
        let answer: WorkAnswer?
        init(from decoder: Decoder) throws { answer = try? WorkAnswer(from: decoder) }
    }

    /// What its step says: "Allowed by Pixel", "Denied by Pixel", "Answered by Pixel".
    public var verdict: String {
        switch decision {
        case .allow: "Allowed by \(by.name)"
        case .deny: "Denied by \(by.name)"
        case .answer: "Answered by \(by.name)"
        }
    }
}

/// Limits you set for a bot's work (Edit Bot › Work): each nil for none.
public struct WorkLimits: Codable, Sendable, Hashable {
    public var atOnce: Int?
    public var perDay: Int?
    public var depth: Int?
    public var tokensPerDay: Int?

    public init(atOnce: Int? = nil, perDay: Int? = nil, depth: Int? = nil, tokensPerDay: Int? = nil) {
        self.atOnce = atOnce
        self.perDay = perDay
        self.depth = depth
        self.tokensPerDay = tokensPerDay
    }

    public var isEmpty: Bool { atOnce == nil && perDay == nil && depth == nil && tokensPerDay == nil }
}

/// A bot's work, as its box tells it (`GET kuvo/work?bot=`).
public struct BotWorkReport: Decodable, Sendable, Equatable {
    public struct Item: Decodable, Sendable, Equatable, Identifiable {
        public enum State: String, Decodable, Sendable { case working, asking, finished, failed, stopped, idle }
        public struct Model: Decodable, Sendable, Equatable {
            public let id: String
            public let providerID: String
            public let variant: String?
        }

        public let session: String
        public let title: String
        public let folder: String
        public let project: String?
        public let startedBy: String
        public let depth: Int
        public let model: Model?
        public let mode: String?
        public let state: State
        /// What it asks, in words, while it asks.
        public let asks: String?
        /// When it started, in ms since 1970.
        public let started: Double
        public let tokens: Int
        public let cost: Double?
        public let lastReply: String?

        public var id: String { session }
        /// Working, or waiting on an answer: still at it.
        public var isAtWork: Bool { state == .working || state == .asking }
    }

    public struct Today: Decodable, Sendable, Equatable {
        public let started: Int
        public let working: Int
        public let tokens: Int
        public let cost: Double?
    }

    public let bot: String
    public let sessions: [Item]
    public let answered: [WorkAnswer]
    public let today: Today
    public let limits: WorkLimits?

    /// Its sessions still at it, the latest first.
    public var atWork: [Item] { sessions.filter(\.isAtWork) }
}

/// What both apps say of a bot's work.
public enum WorkWords {
    /// The line under a bot's name while its sessions work: "At work in Tidepool: 3 sessions".
    public static func atWork(count: Int, projects: [String]) -> String {
        let sessions = count == 1 ? "1 session" : "\(count) sessions"
        let places = Array(NSOrderedSet(array: projects)) as? [String] ?? projects
        guard let first = places.first else { return "At work: " + sessions }
        return places.count == 1 ? "At work in \(first): \(sessions)" : "At work in \(places.count) projects: \(sessions)"
    }

    /// What a session asks, as its bot's work says it: "Asks to run npx expo install".
    public static func asking(_ what: String) -> String {
        for (said, says) in [("Wants to run a command: ", "Asks to run "), ("Wants to edit files: ", "Asks to edit "), ("Wants to ", "Asks to ")] where what.hasPrefix(said) {
            return says + what.dropFirst(said.count)
        }
        return what
    }

    /// A count of tokens, short: "412k", "1.2M".
    public static func tokens(_ count: Int) -> String {
        switch count {
        case ..<1000: "\(count)"
        case ..<1_000_000: "\(Int((Double(count) / 1000).rounded()))k"
        default: String(format: "%.1fM", Double(count) / 1_000_000)
        }
    }
}
