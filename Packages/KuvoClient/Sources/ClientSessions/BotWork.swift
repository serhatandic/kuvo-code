import ClientAccounts
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

/// What still runs for a session besides its own turn, as its box says (`kuvo/work/background`): how
/// many commands it left running, subagents at work under it and other tasks its agent keeps going,
/// and since when (ms since 1970). A session with nothing running isn't listed.
public struct SessionBackground: Decodable, Sendable, Hashable {
    public let commands: Int
    public let subagents: Int
    public let tasks: Int
    public let since: Double

    public init(commands: Int, subagents: Int, tasks: Int, since: Double) {
        self.commands = commands
        self.subagents = subagents
        self.tasks = tasks
        self.since = since
    }
}

/// A box's sessions with something running besides their own turns, by session.
public struct BackgroundList: Decodable, Sendable, Hashable {
    public let sessions: [String: SessionBackground]
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

        /// An account: its provider's name ("Claude Code", "GitHub Copilot"), and its own name where
        /// that tells it apart from the provider's others ("Work").
        public struct Account: Decodable, Sendable, Equatable {
            public let name: String
            public let label: String?

            public init(name: String, label: String? = nil) {
                self.name = name
                self.label = label
            }
        }

        public let session: String
        public let title: String
        public let folder: String
        public let project: String?
        public let startedBy: String
        public let depth: Int
        public let model: Model?
        public let mode: String?
        /// The account it runs on, as its box's Settings › Accounts names it: none on Custom Auto,
        /// or from a box from before it said.
        public let account: Account?
        /// Where it stands: as its box said when the report was read, and, once a client has
        /// `standing` it, as it knows now.
        public internal(set) var state: State
        /// What it asks, in words, while it asks.
        public internal(set) var asks: String?
        /// When it started, in ms since 1970.
        public let started: Double
        public let tokens: Int
        public let cost: Double?
        public let lastReply: String?

        public var id: String { session }
        /// Working, or waiting on an answer: still at it.
        public var isAtWork: Bool { state == .working || state == .asking }
    }

    /// What it did today. (Its box says how many were working too, for clients from before
    /// `AtWork`: read none of it here, as both apps work that out from the facts.)
    public struct Today: Decodable, Sendable, Equatable {
        public let started: Int
        public let tokens: Int
        public let cost: Double?
    }

    public let bot: String
    public internal(set) var sessions: [Item]
    public let answered: [WorkAnswer]
    public let today: Today
    public let limits: WorkLimits?
    /// What it asks you now (a box from before projects says nothing).
    public let asks: [WorkAsk]
    /// The projects it made here.
    public let projects: [MadeProject]

    /// A project a bot made: its folder and its name (the folder's when it has none of its own).
    public struct MadeProject: Decodable, Sendable, Equatable, Identifiable {
        public let directory: String
        public let name: String?
        public var id: String { directory }
        public var title: String { name ?? (directory as NSString).lastPathComponent }
    }

    private enum CodingKeys: String, CodingKey { case bot, sessions, answered, today, limits, asks, projects }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        bot = try container.decode(String.self, forKey: .bot)
        sessions = try container.decode([Item].self, forKey: .sessions)
        answered = try container.decode([WorkAnswer].self, forKey: .answered)
        today = try container.decode(Today.self, forKey: .today)
        limits = try container.decodeIfPresent(WorkLimits.self, forKey: .limits)
        asks = (try? container.decodeIfPresent([Lenient<WorkAsk>].self, forKey: .asks))?.compactMap(\.value) ?? []
        projects = (try? container.decodeIfPresent([Lenient<MadeProject>].self, forKey: .projects))?.compactMap(\.value) ?? []
    }

    /// Its sessions still at it, the latest first: read from a report `standing` as the client
    /// knows them now.
    public var atWork: [Item] { sessions.filter(\.isAtWork) }
}

/// One that reads as `Value`, or nothing for one that doesn't (an older or newer box's).
struct Lenient<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
}

/// What a bot can do once you allow it, and what "Always" keeps for it (`work.allowed`).
public enum WorkAction: String, Codable, Sendable, Hashable, CaseIterable {
    case makeProject, cloneProject
}

/// What you let a bot do without asking, as its box lists it (`allowed` in `kuvo/bots`): what a
/// newer box adds that this client doesn't know is left out, so the bot list still reads.
public struct WorkActions: Codable, Sendable, Hashable {
    public var actions: [WorkAction]

    public init(_ actions: [WorkAction]) { self.actions = actions }

    public init(from decoder: Decoder) throws {
        actions = try decoder.singleValueContainer().decode([String].self).compactMap(WorkAction.init(rawValue:))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(actions)
    }
}

/// What a bot (or another conversation) asks you before it does it (`kuvo/work/asks`): making a
/// project, or cloning one into a new project.
public struct WorkAsk: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let action: WorkAction
    /// The conversation asking (a bot's own), and its name.
    public let session: String
    public let name: String
    /// The bot asking, for a bot's.
    public let bot: String?
    /// The project's name.
    public let project: String
    /// The repository to clone, for a clone.
    public let clone: String?
    /// The name of the folder it gets ("tidepool").
    public let folderName: String
    /// Where it would go; nil while no projects folder is picked on its box.
    public let folder: String?
    /// A projects folder to offer while none is picked (`~/Developer`, `~/Projects`).
    public let suggested: String?
    /// When it was asked, in ms since 1970.
    public let at: Double

    public init(id: String, action: WorkAction, session: String, name: String, bot: String?, project: String, clone: String? = nil, folderName: String, folder: String?, suggested: String? = nil, at: Double) {
        self.id = id
        self.action = action
        self.session = session
        self.name = name
        self.bot = bot
        self.project = project
        self.clone = clone
        self.folderName = folderName
        self.folder = folder
        self.suggested = suggested
        self.at = at
    }

    /// Whether answering it picks where projects go on its box too: none is picked yet.
    public var needsFolder: Bool { folder == nil }
}

/// What's asked on a box (`GET kuvo/work/asks`, and each line of its events): those of a kind a
/// newer box asks that this client can't answer are left out.
public struct WorkAskList: Decodable, Sendable, Equatable {
    public let asks: [WorkAsk]

    private enum CodingKeys: String, CodingKey { case asks }

    public init(from decoder: Decoder) throws {
        asks = try decoder.container(keyedBy: CodingKeys.self).decode([Lenient<WorkAsk>].self, forKey: .asks).compactMap(\.value)
    }
}

/// Your answer to what a bot asks: this once, from now on for that bot ("Always"), or no.
public enum WorkAskAnswer: String, Encodable, Sendable {
    case allow, always, deny
}

/// What both apps say of a bot's work.
public enum WorkWords {
    /// The asking card's title: "Allow making a project?"
    public static func askTitle(_ ask: WorkAsk) -> String {
        ask.action == .cloneProject ? "Allow cloning a project?" : "Allow making a project?"
    }

    /// Who asks, and for what: "Pixel wants to make Tidepool."
    public static func askLine(_ ask: WorkAsk) -> String {
        ask.action == .cloneProject ? "\(ask.name) wants to clone a repository as \(ask.project)." : "\(ask.name) wants to make \(ask.project)."
    }

    /// What Allow does, under where it goes: "A new git repository, added to your projects."
    public static func askDoes(_ ask: WorkAsk) -> String {
        ask.action == .cloneProject ? "Cloned from \(ask.clone ?? "its repository"), added to your projects." : "A new git repository, added to your projects."
    }

    /// The button that allows it from now on: "Always for Pixel".
    public static func always(_ ask: WorkAsk) -> String { "Always for \(ask.name)" }

    /// What a bot may do without asking, as Edit Bot › Work lists it.
    public static func allowed(_ action: WorkAction) -> String {
        switch action {
        case .makeProject: "Make projects"
        case .cloneProject: "Clone projects"
        }
    }

    /// The mark on a project a bot made: "Made by Pixel".
    public static func madeBy(_ name: String) -> String { "Made by \(name)" }

    /// What a session asks, as its bot's work says it: "Asks to run npx expo install".
    public static func asking(_ what: String) -> String {
        for (said, says) in [("Wants to run a command: ", "Asks to run "), ("Wants to edit files: ", "Asks to edit "), ("Wants to ", "Asks to ")] where what.hasPrefix(said) {
            return says + what.dropFirst(said.count)
        }
        return what
    }

    /// A bar's line over a bot's composer: "3 sessions at work", or, with none at work, how many
    /// it started today.
    public static func barTitle(atWork: Int, today: Int) -> String {
        if atWork == 1 { return "A session is at work" }
        if atWork > 1 { return "\(atWork) sessions at work" }
        return today == 1 ? "1 session today, none at work" : "\(today) sessions today, none at work"
    }

    /// The same in a word, for the chip on a goal's line: "2 working", else "4 today". Its help
    /// and VoiceOver say `barTitle`.
    public static func chipTitle(atWork: Int, today: Int) -> String {
        atWork > 0 ? "\(atWork) working" : "\(today) today"
    }

    /// The account a session runs on, in a word or two, as the usage panel names it (`AccountNames`:
    /// "Claude" for Claude Code's, "Copilot"), else as its box names its provider, then the name
    /// you gave it, where you did: "Claude · Athas".
    public static func account(_ account: BotWorkReport.Item.Account, provider: String?) -> String {
        let name = provider.flatMap(AccountNames.short(provider:)) ?? account.name
        guard let label = account.label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty, label != name else { return name }
        return "\(name) · \(label)"
    }

    /// What a session's row says of it while it works, in a few words, the longest first: its model
    /// (`model`, as the client names it), effort and mode, the account it runs on and its project
    /// ("Opus 5.5 · high · Claude · Athas · Tidepool"); then, for a row too short for that, the
    /// same without the account (it goes whole, before the project). A row shows the first that
    /// fits beside the title, which always keeps its room, and cuts the last at its end.
    public static func about(_ item: BotWorkReport.Item, model: String?) -> [String] {
        let head = [model, item.model?.variant, item.mode == "plan" ? "Plan" : nil]
        let account = item.account.map { Self.account($0, provider: item.model?.providerID) }
        let full = (head + [account, item.project]).compactMap { $0 }.joined(separator: " · ")
        guard account != nil else { return [full] }
        return [full, (head + [item.project]).compactMap { $0 }.joined(separator: " · ")]
    }

    /// The depth limit, as Edit Bot › Work and the work list both say it: how deep the sessions a
    /// bot starts may start their own.
    public static func depth(_ depth: Int) -> String {
        switch depth {
        case ...1: "None"
        case 2: "One level"
        default: "\(depth - 1) levels"
        }
    }

    /// The limits you set, in a line, for the work list.
    public static func limits(_ limits: WorkLimits) -> String {
        let parts = [limits.atOnce.map { "\($0) at once" }, limits.perDay.map { "\($0) a day" },
                     limits.depth.map { "sessions they start: \(depth($0).lowercased())" }, limits.tokensPerDay.map { "\(tokens($0)) tokens a day" }].compactMap { $0 }
        return "Your limits: " + parts.joined(separator: ", ") + " (Edit Bot › Work)"
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
