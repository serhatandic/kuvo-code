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

        public init(bot: String?, name: String) {
            self.bot = bot
            self.name = name
        }
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

    /// What its step says: "Allowed by Pixel", "Not allowed by Pixel", "Answered by Pixel",
    /// "Allowed by you".
    public var verdict: String {
        switch decision {
        case .allow: "Allowed by \(by.name)"
        case .deny: "Not allowed by \(by.name)"
        case .answer: "Answered by \(by.name)"
        }
    }

    /// Given by you rather than an agent (`yours(in:)`).
    public var isYours: Bool { by.bot == nil && by.name == Self.you }
    static let you = "you"

    public init(session: String? = nil, ask: String, call: String?, what: String, decision: Decision, reason: String, by: By, at: Double) {
        self.session = session
        self.ask = ask
        self.call = call
        self.what = what
        self.decision = decision
        self.reason = reason
        self.by = by
        self.at = at
    }

    /// What you approved after Auto's reviewer held it back, by the step it's about, for its mark
    /// ("Allowed by you") in place of the box's word to the agent ("You approved: <what>", which
    /// shows nothing): the first step after that word that does what it names. One that matches no
    /// step (in a conversation from before) shows nowhere.
    public static func yours(in messages: [Message]) -> [String: WorkAnswer] {
        var byCall: [String: WorkAnswer] = [:]
        var approved: [(what: String, at: Double)] = []
        for message in messages {
            switch message {
            case .user(let user):
                guard user.metadata?["kuvo"]?["note"]?["from"]?.string == "Your answer",
                      let line = user.metadata?["kuvo"]?["note"]?["line"]?.string, line.hasPrefix(approvedLine) else { continue }
                approved.append((String(line.dropFirst(approvedLine.count)), user.time.created))
            case .assistant(let assistant) where !approved.isEmpty:
                for case .tool(let call) in assistant.content {
                    guard let index = approved.firstIndex(where: { does(call, $0.what) }) else { continue }
                    let found = approved.remove(at: index)
                    byCall[call.id] = WorkAnswer(ask: "you-" + call.id, call: call.id, what: found.what, decision: .allow, reason: "",
                                                 by: By(bot: nil, name: you), at: found.at)
                }
            default:
                break
            }
        }
        return byCall
    }

    private static let approvedLine = "You approved: "

    /// Whether `call` does `what`, as the reviewer named it: its command, or the file it's about.
    private static func does(_ call: Message.ToolCall, _ what: String) -> Bool {
        let what = what.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !what.isEmpty, let input = call.state.input?.object else { return false }
        let home = what.hasPrefix("~/") ? String(what.dropFirst()) : nil
        return input.values.contains { value in
            guard let value = value.string?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
            return value == what || home.map { value.hasSuffix($0) } == true
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
    /// Using one of a plan's rate-limit resets (an agent's `use_limit_reset`): its Always is kept
    /// with the account, never with a bot.
    case resetLimits
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
/// project, or cloning one into a new project; or using one of a plan's resets (`reset`).
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
    /// For a reset: the account, what it has, and where it's used.
    public let reset: ResetAsk?
    /// What a notification of it says, in its box's words (a reset's).
    public let words: Words?

    public struct Words: Decodable, Sendable, Hashable {
        public let title: String
        public let body: String
    }

    /// The reset an agent asks to use: the account (its row in the plan limits), how many resets it
    /// has, what one refills, and the computer of yours that uses it where that isn't the asking one.
    public struct ResetAsk: Decodable, Sendable, Hashable {
        public let row: String
        /// "Codex", "Claude Code (Work)".
        public let account: String
        public let service: String
        public let count: Int
        public let refills: [String]?
        public let on: String?

        public init(row: String, account: String, service: String, count: Int, refills: [String]? = nil, on: String? = nil) {
            self.row = row
            self.account = account
            self.service = service
            self.count = count
            self.refills = refills
            self.on = on
        }
    }

    public init(id: String, action: WorkAction, session: String, name: String, bot: String?, project: String, clone: String? = nil, folderName: String, folder: String?, suggested: String? = nil, at: Double, reset: ResetAsk? = nil, words: Words? = nil) {
        self.reset = reset
        self.words = words
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
    public var needsFolder: Bool { action != .resetLimits && folder == nil }
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
        switch ask.action {
        case .cloneProject: "Allow cloning a project?"
        case .makeProject: "Allow making a project?"
        case .resetLimits: "Allow using a reset?"
        }
    }

    /// Who asks, and for what: "Pixel wants to make Tidepool."; "Mira wants to use 1 of 2 resets on Codex."
    public static func askLine(_ ask: WorkAsk) -> String {
        switch ask.action {
        case .cloneProject: "\(ask.name) wants to clone a repository as \(ask.project)."
        case .makeProject: "\(ask.name) wants to make \(ask.project)."
        case .resetLimits: "\(ask.name) wants to use \(ResetWords.oneOf(ask.reset?.count ?? 1)) on \(ask.reset?.account ?? ask.project)."
        }
    }

    /// What Allow does, under where it goes: "A new git repository, added to your projects."; for a
    /// reset, what starts over, and where it's used.
    public static func askDoes(_ ask: WorkAsk) -> String {
        switch ask.action {
        case .cloneProject: "Cloned from \(ask.clone ?? "its repository"), added to your projects."
        case .makeProject: "A new git repository, added to your projects."
        case .resetLimits: ResetWords.consequence(ask.reset?.refills ?? []) + (ask.reset?.on.map { " " + ResetWords.usedOn($0) } ?? "")
        }
    }

    /// The button that allows it from now on: "Always for Pixel"; for a reset, the account's: "Always Allow for Codex".
    public static func always(_ ask: WorkAsk) -> String {
        ask.action == .resetLimits ? "Always Allow for \(ask.reset?.account ?? ask.project)" : "Always for \(ask.name)"
    }

    /// What Always does, for its help: where it's kept, and where it's taken back.
    public static func alwaysHelp(_ ask: WorkAsk) -> String {
        ask.action == .resetLimits
            ? "Let agents use \(ask.reset?.account ?? ask.project)'s resets without asking from now on. Each use still shows in its conversation. Settings › Accounts takes it back."
            : "Let \(ask.name) \(allowed(ask.action).lowercased()) without asking from now on. Edit Bot › Work takes it back."
    }

    /// What a bot may do without asking, as Edit Bot › Work lists it.
    public static func allowed(_ action: WorkAction) -> String {
        switch action {
        case .makeProject: "Make projects"
        case .cloneProject: "Clone projects"
        case .resetLimits: "Use resets"
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
