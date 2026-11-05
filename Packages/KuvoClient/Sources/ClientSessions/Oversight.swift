import Foundation
import OpenCodeKit

// A bot overseeing its sessions, as both apps show it in the sidebar (PROTOCOL.md, "Work"): its face
// on each project it has sessions in, a line in its colour from the project's folder to each of
// them, and, as it does something to one (`kuvo/work/oversight`), a light running down its line to
// that session. The sessions stay yours: they keep their own titles and marks.

/// What a bot just did to one of its sessions (`kuvo/work/oversight`).
public struct OversightMark: Decodable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Decodable, Sendable {
        /// Started it, wrote to it, read it, answered what it asked, stopped it.
        case started, told, read, answered, stopped
        /// It finished well.
        case finished
    }

    public let id: String
    public let bot: String
    public let session: String
    public let kind: Kind
    /// When, in ms since 1970.
    public let at: Double

    public init(id: String, bot: String, session: String, kind: Kind, at: Double) {
        self.id = id
        self.bot = bot
        self.session = session
        self.kind = kind
        self.at = at
    }
}

/// A box's latest marks (`GET kuvo/work/oversight`, and each line of its events): those of a kind
/// a newer box makes that this client doesn't know are left out.
public struct OversightMarks: Decodable, Sendable, Equatable {
    public let marks: [OversightMark]

    private enum CodingKeys: String, CodingKey { case marks }

    public init(from decoder: Decoder) throws {
        marks = try decoder.container(keyedBy: CodingKeys.self).decode([Lenient<OversightMark>].self, forKey: .marks).compactMap(\.value)
    }
}

/// Which of a box's marks to play, line by line as its events come: none of the first (they
/// happened before you looked), then each new one once, however often a line repeats it. A new
/// follow (a reconnect) starts again, so nothing is played twice or late.
public struct OversightPlayer: Sendable {
    private var seen: Set<String>?

    public init() {}

    /// The marks in `marks` to play now, the oldest first.
    public mutating func take(_ marks: [OversightMark]) -> [OversightMark] {
        guard let seen else {
            self.seen = Set(marks.map(\.id))
            return []
        }
        let new = marks.filter { !seen.contains($0.id) }
        // Each line has all the box keeps: one gone from it never comes back.
        self.seen = Set(marks.map(\.id))
        return new
    }
}

/// A bot overseeing sessions in one project: who, and its sessions there in the order shown.
public struct Overseer: Sendable, Hashable, Identifiable {
    public let bot: String
    public let name: String
    public let sessions: [String]
    public var id: String { bot }

    public init(bot: String, name: String, sessions: [String]) {
        self.bot = bot
        self.name = name
        self.sessions = sessions
    }
}

public enum Oversight {
    /// The bots overseeing `sessions` (a project's, in the order shown), each with its sessions
    /// among them: in `ranked`'s order (the bots' own, so they keep their places as their sessions
    /// take turns at the top), any it doesn't name after, the first to show first.
    public static func overseers(of sessions: [Session], ranked: [String] = []) -> [Overseer] {
        var order: [String] = [], names: [String: String] = [:], theirs: [String: [String]] = [:]
        for session in sessions {
            guard let by = WorksFor(session) else { continue }
            if theirs[by.bot] == nil {
                order.append(by.bot)
                names[by.bot] = by.name
            }
            theirs[by.bot, default: []].append(session.id)
        }
        let rank = Dictionary(ranked.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        return order.enumerated()
            .sorted { (rank[$0.element] ?? ranked.count + $0.offset, $0.offset) < (rank[$1.element] ?? ranked.count + $1.offset, $1.offset) }
            .map { Overseer(bot: $0.element, name: names[$0.element] ?? "", sessions: theirs[$0.element] ?? []) }
    }

    /// What a project's row says of the bots overseeing it, for VoiceOver and its tooltip:
    /// "Overseen by Pixel" or "Overseen by Pixel and Ada".
    public static func overseenBy(_ names: [String]) -> String {
        "Overseen by " + ListFormatter.localizedString(byJoining: names)
    }

    /// What a session's row says of the bot overseeing it: "Overseen by Pixel".
    public static func overseenBy(_ name: String) -> String { "Overseen by \(name)" }

    /// A bot's line in Bots: every session it oversees, as its lanes show them. "Overseeing 4
    /// sessions".
    public static func overseeing(count: Int) -> String {
        count == 1 ? "Overseeing 1 session" : "Overseeing \(count) sessions"
    }
}
