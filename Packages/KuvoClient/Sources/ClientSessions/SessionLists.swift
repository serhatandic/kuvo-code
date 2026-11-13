import Foundation

// The session lists every client draws (the Mac's sidebar, the phone's computer page), from what a
// box says of its sessions (`kuvo/sessions/list`, PROTOCOL.md "Session lists"): what each one is
// and the project it's filed under, worked out on the box so no client has the rule. What's here is
// only taking the box's lines in and the drawing's order, which a client in another language does
// the same from PROTOCOL.md and `Packages/KuvoLink/Vectors/session-lists.json`.

public enum SessionLists {
    /// The box's feature for the route: every box the app uses has it (the app brings a box up to
    /// date before using it).
    public static let feature = "sessions.list"

    /// The list now (`since`: only what changed after it, where the box can still say).
    public static func route(since: String? = nil) -> String {
        "kuvo/sessions/list" + query(since)
    }

    /// The list now, then a line for each change.
    public static func eventsRoute(since: String? = nil) -> String {
        "kuvo/sessions/list/events" + query(since)
    }

    private static func query(_ since: String?) -> String {
        guard let since, !since.isEmpty else { return "" }
        return "?since=" + (since.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._"))) ?? since)
    }

    /// What a session is. One a newer box names that this doesn't know shows nowhere.
    public struct Kind: RawRepresentable, Codable, Hashable, Sendable {
        public let rawValue: String
        public init(rawValue: String) { self.rawValue = rawValue }
        public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }

        /// A project's session.
        public static let project = Kind(rawValue: "project")
        /// A conversation of no project.
        public static let chat = Kind(rawValue: "chat")
        /// A bot's conversation (shown with the bot).
        public static let bot = Kind(rawValue: "bot")
        /// A bot's seat in a group chat (its chat shows what matters).
        public static let seat = Kind(rawValue: "seat")
        /// A run kept out of sight (an engine run for a coding agents' session, a review's part).
        public static let hidden = Kind(rawValue: "hidden")
        /// A subagent's session (shown in the conversation it works for).
        public static let subagent = Kind(rawValue: "subagent")
    }

    /// One session, as its box says.
    public struct Facts: Codable, Hashable, Sendable {
        public var kind: Kind
        /// The project it's filed under (a project's session's), the folder as its box names it.
        public var project: String?
        public var directory: String
        public var title: String?
        public var created: Double
        /// When it last changed (ms): the lists' order.
        public var updated: Double
        /// The session it works for (a subagent's).
        public var parent: String?
        public var pinned: Bool?
        public var archived: Bool?
        public var running: Bool?
        /// Since when it's waited on you (ms).
        public var asked: Double?
        /// This copy isn't its box's own (it moved, or is on its way there).
        public var away: Bool?

        public init(kind: Kind, project: String? = nil, directory: String, title: String? = nil, created: Double = 0, updated: Double, parent: String? = nil, pinned: Bool? = nil, archived: Bool? = nil, running: Bool? = nil, asked: Double? = nil, away: Bool? = nil) {
            (self.kind, self.project, self.directory, self.title, self.created, self.updated) = (kind, project, directory, title, created, updated)
            (self.parent, self.pinned, self.archived, self.running, self.asked, self.away) = (parent, pinned, archived, running, asked, away)
        }
    }

    /// A project the lists show: its name where its list gives one, and when its newest session
    /// changed (none for one with none).
    public struct Project: Codable, Hashable, Sendable {
        public var name: String?
        public var updated: Double?

        public init(name: String? = nil, updated: Double? = nil) {
            (self.name, self.updated) = (name, updated)
        }
    }

    /// A line from the box: whole (`full`), or what changed since the line before.
    public struct Line: Codable, Hashable, Sendable {
        public var at: String
        public var full: Bool?
        public var sessions: [String: Facts]
        public var gone: [String]?
        public var projects: [String: Project]
    }

    /// A box's list as a client keeps it, line after line (and across launches, to show until its
    /// box answers again).
    public struct Listing: Codable, Hashable, Sendable {
        /// Where it's at: given back as `since` to resume after a dropped stream.
        public private(set) var at: String?
        public private(set) var sessions: [String: Facts] = [:]
        public private(set) var projects: [String: Project] = [:]
        /// What it said of sessions it has let go since (deleted there, or moved away), the latest
        /// few hundred: for a row a client still holds as a conversation moves, which it places as
        /// it was until it's listed where it went (`facts(of:)`).
        public private(set) var former: [String: Facts] = [:]

        public init() {}

        /// What its box says of session `id`: as it's listed, else as it was before it was let go.
        public func facts(of id: String) -> Facts? {
            sessions[id] ?? former[id]
        }

        /// Whether its box has said it yet.
        public var isRead: Bool { at != nil }

        /// Where it's at moved on with nothing else changed (a line that changed nothing, kept apart
        /// so taking it in isn't a change to what's drawn).
        public mutating func move(to at: String) {
            self.at = at
        }

        /// A session its box just made, as its box answered the start (`kuvo/sessions`), shown at
        /// once until its list says (a line naming it, or a whole one without it).
        public mutating func noteMade(_ id: String, facts: Facts) {
            if sessions[id] == nil { sessions[id] = facts }
        }

        /// A session this client just archived (or brought back), shown so at once until its box's
        /// next line about it says.
        public mutating func noteArchived(_ id: String, _ archived: Bool) {
            sessions[id]?.archived = archived ? true : nil
        }

        /// `line` taken in: a whole one in place of what was, else what changed. Whether anything did.
        @discardableResult
        public mutating func take(_ line: Line) -> Bool {
            let before = self
            at = line.at
            if line.full == true {
                for (id, facts) in sessions where line.sessions[id] == nil { former[id] = facts }
                sessions = line.sessions
            } else {
                sessions.merge(line.sessions) { _, new in new }
                for id in line.gone ?? [] { former[id] = sessions.removeValue(forKey: id) ?? former[id] }
            }
            for id in line.sessions.keys { former[id] = nil }
            if former.count > 500 { former = [:] }
            projects = line.projects
            // (Its first line changes it either way: it's read now.)
            return before.at == nil || sessions != before.sessions || projects != before.projects
        }
    }

    /// Where a session shows in the lists: under its project, or in Chats.
    public enum Place: Hashable, Sendable {
        case project(String)
        case chat
    }

    /// Where `facts`' session shows: a project's session under its project, a chat in Chats, unless
    /// its box says it's archived (or this client just archived it: `Listing.noteArchived`); any
    /// other kind, or one its box hasn't listed (nil), nowhere.
    public static func place(of facts: Facts?) -> Place? {
        guard let facts, facts.archived != true else { return nil }
        switch facts.kind {
        case .project: return .project(facts.project ?? facts.directory)
        case .chat: return .chat
        default: return nil
        }
    }

    /// `rows`, newest first.
    public static func newestFirst<Row>(_ rows: [Row], updated: (Row) -> Double) -> [Row] {
        rows.sorted { updated($0) > updated($1) }
    }

    /// The projects with their rows: each project a row is filed under (`project`), and those in
    /// `directories` with none; the one with the newest row first, those with none last, ties by
    /// name (`name`, Finder's order), each one's rows newest first.
    public static func projects<Row>(_ rows: [Row], directories: some Sequence<String>, project: (Row) -> String?, updated: (Row) -> Double, name: (String) -> String) -> [(directory: String, rows: [Row])] {
        var grouped: [String: [Row]] = [:]
        for row in rows {
            guard let directory = project(row) else { continue }
            grouped[directory, default: []].append(row)
        }
        for directory in directories where grouped[directory] == nil { grouped[directory] = [] }
        return grouped.map { (directory: $0.key, rows: newestFirst($0.value, updated: updated)) }
            .sorted { lhs, rhs in
                let left = lhs.rows.first.map(updated) ?? 0, right = rhs.rows.first.map(updated) ?? 0
                return left != right ? left > right : name(lhs.directory).localizedStandardCompare(name(rhs.directory)) == .orderedAscending
            }
    }

    /// A project's name: as its box's list names it, else its folder's.
    public static func name(of directory: String, in projects: [String: Project]) -> String {
        projects[directory]?.name ?? (directory as NSString).lastPathComponent
    }
}
