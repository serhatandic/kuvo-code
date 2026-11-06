import Foundation
import OpenCodeKit

// A bot's goal and its plan, as both apps show it (PROTOCOL.md, "Work › Goals"): the card a bot puts
// to you, the goal under way with a track for each step, what waits for you, what's paused at a
// limit and until when, the digest and the report, as its box keeps them (`kuvo/work/goals`). The
// conversation's own goal (OpenCodeKit's `Goal`, the goal bar) is the same goal: this is its plan.

/// A bot's goal with its plan.
public struct GoalPlan: Decodable, Sendable, Hashable, Identifiable {
    public enum State: String, Decodable, Sendable { case proposed, running, done, stopped, declined }

    /// An app on its box's computer something is done in, as the bot named it: with its id once
    /// the box found it there, whose icon the box gives (`kuvo/work/apps/icon?app=<id>`).
    public struct App: Decodable, Sendable, Hashable {
        public let name: String
        public let id: String?

        public init(name: String, id: String? = nil) {
            self.name = name
            self.id = id
        }
    }

    /// Where Start makes a project the plan names: its full path (nil while no projects folder is
    /// picked), the same as people read it (`~/…`), and whether something with files is there
    /// already, which never holds Start back.
    public struct Folder: Decodable, Sendable, Hashable {
        public let project: String
        public let folder: String?
        public let shown: String?
        public let there: Bool

        public init(project: String, folder: String?, shown: String?, there: Bool = false) {
            self.project = project
            self.folder = folder
            self.shown = shown
            self.there = there
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            project = try container.decode(String.self, forKey: .project)
            folder = try container.decodeIfPresent(String.self, forKey: .folder)
            shown = try container.decodeIfPresent(String.self, forKey: .shown)
            there = (try? container.decodeIfPresent(Bool.self, forKey: .there)) ?? false
        }

        private enum CodingKeys: String, CodingKey { case project, folder, shown, there }
    }

    /// A step of the plan, a track of its own.
    public struct Step: Decodable, Sendable, Hashable, Identifiable {
        public enum State: String, Decodable, Sendable { case todo, doing, done, waiting, paused, skipped }
        public let id: String
        public let text: String
        public let state: State
        /// How far along (0 to 1), only where the bot measured it: nil is in progress, not a share.
        public let progress: Double?
        public let note: String?
        /// One line on what's in it ("SDK, paywall and a StoreKit test config"); older goals have none.
        public let detail: String?
        /// Kept from older bots' plans; never shown.
        public let phase: String?
        /// The site it's done at in the browser ("revenuecat.com"), whose icon is its mark; none for
        /// a step done on the computer.
        public let site: String?
        /// The app on the computer it's done in.
        public let app: App?
        /// The steps it waits for, by id.
        public let after: [String]
        /// The sessions working on it.
        public let sessions: [String]
        /// While it's paused at a limit: when it carries on (ms since 1970).
        public let resumes: Double?
        /// When it began and ended (ms since 1970), for a time axis.
        public let began: Double?
        public let ended: Double?

        public init(id: String, text: String, state: State, progress: Double? = nil, note: String? = nil, detail: String? = nil, phase: String? = nil, site: String? = nil, app: App? = nil, after: [String] = [], sessions: [String] = [], resumes: Double? = nil, began: Double? = nil, ended: Double? = nil) {
            self.id = id
            self.text = text
            self.state = state
            self.progress = progress
            self.note = note
            self.detail = detail
            self.phase = phase
            self.site = site
            self.app = app
            self.after = after
            self.sessions = sessions
            self.resumes = resumes
            self.began = began
            self.ended = ended
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            text = try container.decode(String.self, forKey: .text)
            // A state a newer box adds reads as not started.
            state = (try? container.decode(State.self, forKey: .state)) ?? .todo
            progress = (try? container.decodeIfPresent(Double.self, forKey: .progress)).flatMap { $0 }.map { min(1, max(0, $0)) }
            note = try container.decodeIfPresent(String.self, forKey: .note)
            detail = try? container.decodeIfPresent(String.self, forKey: .detail)
            phase = try container.decodeIfPresent(String.self, forKey: .phase)
            site = try container.decodeIfPresent(String.self, forKey: .site)
            app = try? container.decodeIfPresent(App.self, forKey: .app)
            after = (try? container.decodeIfPresent([String].self, forKey: .after)) ?? []
            sessions = (try? container.decodeIfPresent([String].self, forKey: .sessions)) ?? []
            resumes = try container.decodeIfPresent(Double.self, forKey: .resumes)
            began = try container.decodeIfPresent(Double.self, forKey: .began)
            ended = try container.decodeIfPresent(Double.self, forKey: .ended)
        }

        private enum CodingKeys: String, CodingKey { case id, text, state, progress, note, detail, phase, site, app, after, sessions, resumes, began, ended }

        public var resumesDate: Date? { resumes.map { Date(timeIntervalSince1970: $0 / 1000) } }
    }

    public struct Check: Decodable, Sendable, Hashable, Identifiable {
        public enum State: String, Decodable, Sendable { case ok, needs, failed }
        public enum By: String, Decodable, Sendable { case bot, box }
        /// What its button does: open a page, or pick where new projects go.
        public struct Action: Decodable, Sendable, Hashable {
            public enum Kind: String, Decodable, Sendable { case open, projectsFolder }
            public let kind: Kind
            public let label: String
            public let url: URL?

            public init(kind: Kind, label: String, url: URL? = nil) {
                self.kind = kind
                self.label = label
                self.url = url
            }
        }

        public let id: String
        public let text: String
        public let detail: String?
        public let state: State
        public let by: By
        /// The service it's about, by its site, for its icon.
        public let site: String?
        public let action: Action?

        public init(id: String, text: String, detail: String? = nil, state: State, by: By, site: String? = nil, action: Action? = nil) {
            self.id = id
            self.text = text
            self.detail = detail
            self.state = state
            self.by = by
            self.site = site
            self.action = action
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            text = try container.decode(String.self, forKey: .text)
            detail = try container.decodeIfPresent(String.self, forKey: .detail)
            state = (try? container.decode(State.self, forKey: .state)) ?? .needs
            by = (try? container.decode(By.self, forKey: .by)) ?? .bot
            site = try container.decodeIfPresent(String.self, forKey: .site)
            // A button of a kind this client doesn't know isn't shown.
            action = try? container.decodeIfPresent(Action.self, forKey: .action)
        }

        private enum CodingKeys: String, CodingKey { case id, text, detail, state, by, site, action }

        /// The box's own check that this computer can't work on the goal alone yet.
        public var cantWorkAlone: Bool { id == "alone" && by == .box && state == .failed }
    }

    /// What it may spend on one thing, with a cap for a period, what's spent in the period now, and
    /// until when what spends waits once the cap's reached.
    public struct Spend: Decodable, Sendable, Hashable {
        public enum Period: String, Codable, Sendable, CaseIterable { case day, week, month, goal }
        public let what: String
        public let cap: Double
        public let currency: String
        public let per: Period
        public let spent: Double
        public let until: Double?

        public init(what: String, cap: Double, currency: String, per: Period = .goal, spent: Double = 0, until: Double? = nil) {
            self.what = what
            self.cap = cap
            self.currency = currency
            self.per = per
            self.spent = spent
            self.until = until
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            what = try container.decode(String.self, forKey: .what)
            cap = try container.decode(Double.self, forKey: .cap)
            currency = try container.decode(String.self, forKey: .currency)
            per = (try? container.decode(Period.self, forKey: .per)) ?? .goal
            spent = (try? container.decode(Double.self, forKey: .spent)) ?? 0
            until = try container.decodeIfPresent(Double.self, forKey: .until)
        }

        private enum CodingKeys: String, CodingKey { case what, cap, currency, per, spent, until }
    }

    public struct Public: Decodable, Sendable, Hashable, Identifiable {
        public let id: String
        public let text: String
        public let on: Bool

        public init(id: String, text: String, on: Bool) {
            self.id = id
            self.text = text
            self.on = on
        }
    }

    /// Something that waits for you: what only you can fix, a judgment call, something outside the
    /// plan, or an ask one of its sessions has.
    public struct Waiting: Decodable, Sendable, Hashable, Identifiable {
        public enum Kind: String, Decodable, Sendable { case you, judgment, outside, ask }
        public let id: String
        public let kind: Kind
        public let text: String
        public let detail: String?
        public let url: URL?
        /// The service it's about, by its site, for its icon.
        public let site: String?
        /// The app on the computer it's in.
        public let app: App?
        public let session: String?
        public let at: Double

        public init(id: String, kind: Kind, text: String, detail: String? = nil, url: URL? = nil, site: String? = nil, app: App? = nil, session: String? = nil, at: Double) {
            self.id = id
            self.kind = kind
            self.text = text
            self.detail = detail
            self.url = url
            self.site = site
            self.app = app
            self.session = session
            self.at = at
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            kind = (try? container.decode(Kind.self, forKey: .kind)) ?? .you
            text = try container.decode(String.self, forKey: .text)
            detail = try container.decodeIfPresent(String.self, forKey: .detail)
            url = try? container.decodeIfPresent(URL.self, forKey: .url)
            site = try container.decodeIfPresent(String.self, forKey: .site)
            app = try? container.decodeIfPresent(App.self, forKey: .app)
            session = try container.decodeIfPresent(String.self, forKey: .session)
            at = try container.decode(Double.self, forKey: .at)
        }

        private enum CodingKeys: String, CodingKey { case id, kind, text, detail, url, site, app, session, at }
    }

    /// Something paused at a limit (the bot, or one of its sessions), and until when.
    public struct Paused: Decodable, Sendable, Hashable {
        public let why: String
        public let until: Double?
        public let session: String?

        public init(why: String, until: Double? = nil, session: String? = nil) {
            self.why = why
            self.until = until
            self.session = session
        }

        public var untilDate: Date? { until.map { Date(timeIntervalSince1970: $0 / 1000) } }
    }

    public struct Digest: Decodable, Sendable, Hashable {
        public let at: Double
        public let text: String
    }

    public enum Cadence: String, Codable, Sendable, CaseIterable { case day, week, milestones, none }

    /// A call the bot made on its own, or a question that went ahead on what it recommended: what
    /// it was, what it went with and why, the choices there were, the session that asked, and your
    /// choice since.
    public struct Decided: Codable, Sendable, Hashable, Identifiable {
        public struct Yours: Codable, Sendable, Hashable {
            public let choice: String
            public let at: Double
            public init(choice: String, at: Double) {
                self.choice = choice
                self.at = at
            }
        }
        public let id: String
        public let text: String
        public let choice: String
        public let why: String?
        public let options: [String]?
        /// It takes several of `options`, joined in `choice`.
        public let multiple: Bool?
        public let session: String?
        public let at: Double
        public let yours: Yours?
        public init(id: String, text: String, choice: String, why: String? = nil, options: [String]? = nil, multiple: Bool? = nil, session: String? = nil, at: Double, yours: Yours? = nil) {
            self.id = id
            self.text = text
            self.choice = choice
            self.why = why
            self.options = options
            self.multiple = multiple
            self.session = session
            self.at = at
            self.yours = yours
        }
    }

    /// How it runs: asking you the calls that are yours, or on Autopilot, deciding what its research
    /// settles and stopping only at what only you can do. One setting with its bot's conversation.
    public enum Mode: String, Codable, Sendable { case interactive, autopilot }

    public let id: String
    public let bot: String
    /// The bot's name, and its conversation, where the card and the goal bar show.
    public let name: String
    public let session: String
    /// The goal in your words, and a short name for it, when the bot gave one.
    public let goal: String
    public let title: String?
    public let state: State
    public let steps: [Step]
    public let checks: [Check]
    public let spend: [Spend]
    public let `public`: [Public]
    /// The projects it may make without asking.
    public let projects: [String]
    /// Whether what needs you wakes you.
    public let wake: Bool
    /// How often you hear how it goes.
    public let digest: Cadence
    /// When it ends, if you set an end (ms since 1970).
    public let ends: Double?
    public let proposed: Double
    public let started: Double?
    public let ended: Double?
    public let waiting: [Waiting]
    public let paused: [Paused]
    /// How long it has waited at limits, in ms.
    public let waited: Double
    public let watching: [String]
    /// When it goes on next (ms since 1970), while nothing of it is at work and nothing can be
    /// before a time: its bot's wake-up, or the steps it put off.
    public let next: Double?
    public let lastDigest: Digest?
    public let report: String?
    /// Whether its box may work on it alone (else it runs with you there).
    public let alone: Bool
    /// While it's proposed: where Start makes each of its projects.
    public let folders: [Folder]
    /// How it runs (Interactive from a box before Autopilot).
    public let mode: Mode
    /// The calls made on its way, the latest last.
    public let decided: [Decided]

    public init(id: String, bot: String, name: String, session: String, goal: String, title: String? = nil, state: State, steps: [Step], checks: [Check] = [], spend: [Spend] = [], public: [Public] = [], projects: [String] = [], wake: Bool = false, digest: Cadence = .none, ends: Double? = nil, proposed: Double, started: Double? = nil, ended: Double? = nil, waiting: [Waiting] = [], paused: [Paused] = [], waited: Double = 0, watching: [String] = [], next: Double? = nil, lastDigest: Digest? = nil, report: String? = nil, alone: Bool, folders: [Folder] = [], mode: Mode = .interactive, decided: [Decided] = []) {
        self.id = id
        self.bot = bot
        self.name = name
        self.session = session
        self.goal = goal
        self.title = title
        self.state = state
        self.steps = steps
        self.checks = checks
        self.spend = spend
        self.public = `public`
        self.projects = projects
        self.wake = wake
        self.digest = digest
        self.ends = ends
        self.proposed = proposed
        self.started = started
        self.ended = ended
        self.waiting = waiting
        self.paused = paused
        self.waited = waited
        self.watching = watching
        self.next = next
        self.lastDigest = lastDigest
        self.report = report
        self.alone = alone
        self.folders = folders
        self.mode = mode
        self.decided = decided
    }

    private enum CodingKeys: String, CodingKey { case id, bot, name, session, goal, title, state, steps, checks, spend, `public`, projects, wake, digest, ends, proposed, started, ended, waiting, paused, waited, watching, next, lastDigest, report, alone, folders, mode, decided }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        bot = try container.decode(String.self, forKey: .bot)
        name = try container.decode(String.self, forKey: .name)
        session = try container.decode(String.self, forKey: .session)
        goal = try container.decode(String.self, forKey: .goal)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        state = try container.decode(State.self, forKey: .state)
        steps = (try? container.decode([Lenient<Step>].self, forKey: .steps))?.compactMap(\.value) ?? []
        checks = (try? container.decode([Lenient<Check>].self, forKey: .checks))?.compactMap(\.value) ?? []
        spend = (try? container.decode([Lenient<Spend>].self, forKey: .spend))?.compactMap(\.value) ?? []
        self.public = (try? container.decode([Lenient<Public>].self, forKey: .public))?.compactMap(\.value) ?? []
        projects = (try? container.decode([String].self, forKey: .projects)) ?? []
        wake = (try? container.decode(Bool.self, forKey: .wake)) ?? false
        digest = (try? container.decode(Cadence.self, forKey: .digest)) ?? .none
        ends = try container.decodeIfPresent(Double.self, forKey: .ends)
        proposed = try container.decode(Double.self, forKey: .proposed)
        started = try container.decodeIfPresent(Double.self, forKey: .started)
        ended = try container.decodeIfPresent(Double.self, forKey: .ended)
        waiting = (try? container.decode([Lenient<Waiting>].self, forKey: .waiting))?.compactMap(\.value) ?? []
        paused = (try? container.decode([Lenient<Paused>].self, forKey: .paused))?.compactMap(\.value) ?? []
        waited = (try? container.decode(Double.self, forKey: .waited)) ?? 0
        watching = (try? container.decode([String].self, forKey: .watching)) ?? []
        next = try? container.decodeIfPresent(Double.self, forKey: .next)
        lastDigest = try? container.decodeIfPresent(Digest.self, forKey: .lastDigest)
        report = try container.decodeIfPresent(String.self, forKey: .report)
        alone = (try? container.decode(Bool.self, forKey: .alone)) ?? false
        folders = (try? container.decode([Lenient<Folder>].self, forKey: .folders))?.compactMap(\.value) ?? []
        mode = (try? container.decode(Mode.self, forKey: .mode)) ?? .interactive
        decided = (try? container.decode([Lenient<Decided>].self, forKey: .decided))?.compactMap(\.value) ?? []
    }

    /// What only you can do, first on the card: the checks that need you.
    public var yours: [Check] { checks.filter { $0.state == .needs } }
    /// What's ready.
    public var ready: [Check] { checks.filter { $0.state == .ok } }
    /// Steps done (or set aside).
    public var done: Int { steps.filter { $0.state == .done || $0.state == .skipped }.count }
    /// The steps under way now, side by side.
    public var underWay: [Step] { steps.filter { $0.state == .doing } }
    /// Whether its card waits for you.
    public var isProposed: Bool { state == .proposed }
    /// What waits for you, as the bot's own conversation shows it: what the bot asks there is its
    /// question in the composer's place, so it isn't a row as well. (Elsewhere, it's one of them.)
    public var waitingInItsConversation: [Waiting] { waiting.filter { $0.kind != .ask || $0.session != session } }
}

/// The goals on a box (`GET kuvo/work/goals`, and each line of its events).
public struct GoalPlanList: Decodable, Sendable, Equatable {
    public let goals: [GoalPlan]

    private enum CodingKeys: String, CodingKey { case goals }

    public init(goals: [GoalPlan]) { self.goals = goals }

    public init(from decoder: Decoder) throws {
        goals = try decoder.container(keyedBy: CodingKeys.self).decode([Lenient<GoalPlan>].self, forKey: .goals).compactMap(\.value)
    }
}

/// Your answer to a goal (`POST kuvo/work/goals/<id>`): start it with your limits, not
/// now, or stop it; while it runs, change its limits, or put away what waits for you.
public struct GoalPlanAnswer: Encodable, Sendable {
    public enum Action: String, Encodable, Sendable { case start, decline, stop, change, clear, projects, decided }
    /// A spend line's cap and period, as you set them on the card.
    public struct SpendChange: Encodable, Sendable, Equatable {
        public var cap: Double?
        public var per: GoalPlan.Spend.Period?
        public init(cap: Double? = nil, per: GoalPlan.Spend.Period? = nil) {
            self.cap = cap
            self.per = per
        }
    }

    public let action: Action
    public let wake: Bool?
    public let digest: GoalPlan.Cadence?
    /// An end you set, in ms since 1970.
    public let ends: Double?
    /// The end taken away (sent as `"ends": null`); with neither, the end stays as it was.
    public let clearsEnd: Bool
    public let spend: [SpendChange]?
    /// What waits for you, put away (`clear`).
    public let waiting: String?
    /// A proposed goal's projects as you named or moved them (`projects`): names, or full paths.
    public var projects: [String]? = nil
    /// How it runs, as you set it on Start or switch it while it runs.
    public var mode: GoalPlan.Mode? = nil
    /// A call it made, and your choice on it (`decided`).
    public var call: String? = nil
    public var choice: String? = nil

    /// Start it. `ends`: the end you picked; `clearsEnd`: you picked none where the bot had
    /// proposed one, which takes it away (left out, the bot's stays).
    public static func start(wake: Bool, digest: GoalPlan.Cadence? = nil, ends: Date? = nil, clearsEnd: Bool = false, spend: [SpendChange]? = nil, mode: GoalPlan.Mode? = nil) -> GoalPlanAnswer {
        var answer = GoalPlanAnswer(action: .start, wake: wake, digest: digest, ends: ends.map { $0.timeIntervalSince1970 * 1000 }, clearsEnd: ends == nil && clearsEnd, spend: spend, waiting: nil)
        answer.mode = mode
        return answer
    }
    /// A running goal's limits changed: only what's given (`clearsEnd` takes its end away).
    public static func change(wake: Bool? = nil, digest: GoalPlan.Cadence? = nil, ends: Date? = nil, clearsEnd: Bool = false, spend: [SpendChange]? = nil) -> GoalPlanAnswer {
        GoalPlanAnswer(action: .change, wake: wake, digest: digest, ends: ends.map { $0.timeIntervalSince1970 * 1000 }, clearsEnd: ends == nil && clearsEnd, spend: spend, waiting: nil)
    }
    public static func clear(waiting id: String) -> GoalPlanAnswer {
        GoalPlanAnswer(action: .clear, wake: nil, digest: nil, ends: nil, clearsEnd: false, spend: nil, waiting: id)
    }
    /// A proposed goal's projects renamed or moved, in its order: a name, or a full path.
    public static func projects(_ projects: [String]) -> GoalPlanAnswer {
        var answer = GoalPlanAnswer(action: .projects, wake: nil, digest: nil, ends: nil, clearsEnd: false, spend: nil, waiting: nil)
        answer.projects = projects
        return answer
    }
    /// Your choice on a call it made: the same confirms it, another has it go that way.
    public static func decided(_ call: String, choice: String) -> GoalPlanAnswer {
        var answer = GoalPlanAnswer(action: .decided, wake: nil, digest: nil, ends: nil, clearsEnd: false, spend: nil, waiting: nil)
        answer.call = call
        answer.choice = choice
        return answer
    }
    public static let decline = GoalPlanAnswer(action: .decline, wake: nil, digest: nil, ends: nil, clearsEnd: false, spend: nil, waiting: nil)
    public static let stop = GoalPlanAnswer(action: .stop, wake: nil, digest: nil, ends: nil, clearsEnd: false, spend: nil, waiting: nil)

    private enum CodingKeys: String, CodingKey { case action, wake, digest, ends, spend, waiting, projects, mode, choice
        case call = "decided"
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(action, forKey: .action)
        try container.encodeIfPresent(wake, forKey: .wake)
        try container.encodeIfPresent(digest, forKey: .digest)
        if let ends {
            try container.encode(ends, forKey: .ends)
        } else if clearsEnd {
            try container.encodeNil(forKey: .ends)
        }
        try container.encodeIfPresent(spend, forKey: .spend)
        try container.encodeIfPresent(waiting, forKey: .waiting)
        try container.encodeIfPresent(projects, forKey: .projects)
        try container.encodeIfPresent(mode, forKey: .mode)
        try container.encodeIfPresent(call, forKey: .call)
        try container.encodeIfPresent(choice, forKey: .choice)
    }
}

/// What both apps say of a goal: the words the drafts settle are filled in once picked.
public enum GoalPlanWords {
    /// "/goal <words>" in a bot's chat: what's sent to its box.
    public struct Ask: Encodable, Sendable {
        public let session: String
        public let goal: String
        public init(session: String, goal: String) {
            self.session = session
            self.goal = goal
        }
    }

    /// What a goal's Open says of where its page opens: in the bot's browser, where a sign-in is
    /// one it can use, rather than yours. `computer` is a machine's name, nil on this Mac.
    public static func opensIn(bot: String, computer: String?) -> String {
        "Opens in \(bot)’s browser\(computer.map { " on \($0)" } ?? ""), so it can use your sign-in"
    }

    /// "2 of 5".
    public static func progress(_ goal: GoalPlan) -> String { "\(goal.done) of \(goal.steps.count)" }

    /// The goal's name on its bar, in a few words ("Landing page"): the one the bot gave it, or,
    /// for a plan kept before bots named theirs, the goal itself where it's that short.
    public static func name(_ goal: GoalPlan) -> String {
        if let title = goal.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        let words = goal.goal.trimmingCharacters(in: .whitespacesAndNewlines)
        return !words.isEmpty && words.split(whereSeparator: \.isWhitespace).count <= 4 ? words : "Goal"
    }

    /// Why a goal is paused, in a word, beside "Paused".
    public static func pausedBy(_ by: Goal.PausedBy) -> String {
        switch by {
        case .you: "You"
        case .limit: "Limit"
        case .error: "Error"
        case .stalled: "Stalled"
        }
    }

    /// What the bar's line says after the goal's name: "2 of 7 · 3 days", "2 of 7 · Next: Mon
    /// 09:00", "Paused · You" (`pausedBy` set while the conversation's goal is paused), "Done · 2 h",
    /// "Stopped · 2 of 7". With `due`, for the list, which has no axis to show it on: a goal under
    /// way with an end says when, "2 of 7 · 3 days · due Fri 6 Nov".
    public static func line(_ goal: GoalPlan, pausedBy: Goal.PausedBy?? = nil, due: Bool = false, now: Date = .now, timeZone: TimeZone = .current, locale: Locale = .current) -> String {
        let steps = progress(goal)
        var dueWords: String?
        if due, goal.state == .running, let ends = goal.ends {
            let date = Date(timeIntervalSince1970: ends / 1000)
            var style = Date.FormatStyle(timeZone: timeZone).weekday(.abbreviated).day().month(.abbreviated)
            style.locale = locale
            dueWords = "\(date < now ? "was due" : "due") \(date.formatted(style))"
        }
        if goal.state == .running, let pausedBy { return ["Paused", pausedBy.map(Self.pausedBy), dueWords].compactMap { $0 }.joined(separator: " · ") }
        switch goal.state {
        case .done: return ["Done", took(goal, now: now)].compactMap { $0 }.joined(separator: " · ")
        case .stopped, .declined: return "Stopped · \(steps)"
        default: return [steps, next(goal, now: now, timeZone: timeZone, locale: locale) ?? took(goal, now: now), dueWords].compactMap { $0 }.joined(separator: " · ")
        }
    }

    /// How long it has been at it, or took: "under a minute", "40 min", "2 h 5 min", "3 days".
    static func took(_ goal: GoalPlan, now: Date) -> String? {
        guard let started = goal.started else { return nil }
        let end = goal.state == .running ? now : goal.ended.map { Date(timeIntervalSince1970: $0 / 1000) } ?? now
        let seconds = max(0, end.timeIntervalSince(Date(timeIntervalSince1970: started / 1000)))
        if seconds >= 2 * 86400 { return "\(Int(seconds / 86400)) days" }
        let minutes = Int(seconds) / 60
        if minutes < 1 { return "under a minute" }
        if minutes < 60 { return "\(minutes) min" }
        return minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60) min"
    }

    /// Where a step stands, in the few words beside its row.
    public struct Said: Equatable, Sendable {
        public enum Tone: Sendable { case plain, needsYou, quiet }
        /// Nil where its mark says it all (a step done, one with nothing to wait for).
        public let text: String?
        public let tone: Tone
    }

    /// A step's state as its row shows it: once the goal is over, a step it didn't finish is set
    /// aside, never still under way or waiting for you.
    public static func shownState(of step: GoalPlan.Step, in goal: GoalPlan) -> GoalPlan.Step.State {
        let over = goal.state == .done || goal.state == .stopped || goal.state == .declined
        return over && step.state != .done && step.state != .skipped ? .skipped : step.state
    }

    /// What a step's row says beside its name: what the bot counted for one under way ("5 of 8
    /// pages"), "Needs you", until when one's paused, the step one not begun waits for ("After Buy
    /// the domain", "After 2 steps"), "Not done" once the goal is over without it.
    public static func state(of step: GoalPlan.Step, in goal: GoalPlan, now: Date = .now, timeZone: TimeZone = .current, locale: Locale = .current) -> Said {
        if shownState(of: step, in: goal) != step.state { return Said(text: "Not done", tone: .quiet) }
        switch step.state {
        case .doing:
            return Said(text: underWay(step), tone: .plain)
        case .waiting:
            return Said(text: "Needs you", tone: .needsYou)
        case .paused:
            return Said(text: until(step, in: goal).map { "Until \(when($0, now: now, timeZone: timeZone, locale: locale))" } ?? "Paused", tone: .quiet)
        case .todo:
            let after = step.after.compactMap { id in goal.steps.first { $0.id == id && $0.state != .done && $0.state != .skipped } }
            // A short name, or how many: a few words beside the row, never a sentence.
            let words = after.count == 1 && after[0].text.count <= 24 ? "After \(after[0].text)" : after.count == 1 ? "After 1 step" : "After \(after.count) steps"
            return Said(text: after.isEmpty ? nil : words, tone: .quiet)
        case .done:
            return Said(text: step.note, tone: .quiet)
        case .skipped:
            return Said(text: "Set aside", tone: .quiet)
        }
    }

    /// Until when a paused step waits: its own time, or its session's limit's.
    private static func until(_ step: GoalPlan.Step, in goal: GoalPlan) -> Date? {
        step.resumesDate ?? goal.paused.first { $0.session.map(step.sessions.contains) ?? false }?.untilDate
    }

    /// What VoiceOver reads after a step's name, once: "5 of 8 pages", "waiting for you", "paused
    /// until 17:00", "not started, after Buy the domain", "done, 8 pages", "not done".
    public static func spokenState(of step: GoalPlan.Step, in goal: GoalPlan, now: Date = .now) -> String {
        let said = state(of: step, in: goal, now: now).text
        if shownState(of: step, in: goal) != step.state { return "not done" }
        switch step.state {
        case .doing: return said ?? "in progress"
        case .waiting: return "waiting for you"
        case .paused: return until(step, in: goal).map { "paused until \($0.formatted(date: .omitted, time: .shortened))" } ?? "paused"
        case .todo: return ["not started", said.map { $0.prefix(1).lowercased() + $0.dropFirst() }].compactMap { $0 }.joined(separator: ", ")
        case .done: return ["done", said].compactMap { $0 }.joined(separator: ", ")
        case .skipped: return "set aside"
        }
    }

    /// Under a goal's steps, when it's likely done and when it's due, where either is known:
    /// "Likely done Sat · due Mon, Nov 10".
    public static func finish(_ timeline: GoalTimeline, timeZone: TimeZone = .current, locale: Locale = .current) -> String? {
        let said = [
            timeline.finish.map { "Likely done \(when($0, now: timeline.now, timeZone: timeZone, locale: locale))" },
            // Past, it was due: never a weekday that reads as one coming.
            timeline.deadline.map { "\($0 < timeline.now ? "was due" : "due") \(when($0, now: timeline.now, timeZone: timeZone, locale: locale))" },
        ].compactMap { $0 }
        guard let first = said.first else { return nil }
        return ([first.prefix(1).uppercased() + first.dropFirst()] + said.dropFirst()).joined(separator: " · ")
    }

    /// A time as a row says it: "15:20" today, "Sat" within the coming week, "Mon, Nov 10" further
    /// or past.
    static func when(_ date: Date, now: Date, timeZone: TimeZone, locale: Locale) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var style = Date.FormatStyle(timeZone: timeZone)
        style = calendar.isDate(date, inSameDayAs: now) ? style.hour().minute()
            : date > now && date.timeIntervalSince(now) < 6 * 86_400 ? style.weekday(.abbreviated)
            : style.weekday(.abbreviated).month(.abbreviated).day()
        style.locale = locale
        return date.formatted(style)
    }

    /// While it waits for a time, when it goes on: "Next: Mon 09:00", with the date beyond a week
    /// ("Next: Mon 23 Nov at 09:00"); nil while it can go on now.
    public static func next(_ goal: GoalPlan, now: Date = Date(), timeZone: TimeZone = .current, locale: Locale = .current) -> String? {
        guard goal.state == .running, let next = goal.next else { return nil }
        let at = Date(timeIntervalSince1970: next / 1000)
        var style = Date.FormatStyle(timeZone: timeZone).weekday(.abbreviated).hour().minute()
        if at.timeIntervalSince(now) > 6 * 86_400 { style = style.day().month(.abbreviated) }
        style.locale = locale
        return "Next: \(at.formatted(style))"
    }

    /// The plan in a few words, for its card: "6 steps".
    public static func summary(_ goal: GoalPlan) -> String {
        goal.steps.count == 1 ? "1 step" : "\(goal.steps.count) steps"
    }

    /// What the plan does, as a list in words: "Site, Domain, DNS and Deploy".
    public static func outline(_ goal: GoalPlan) -> String {
        let names = goal.steps.map(\.text)
        // A long plan: its first few, and how many more.
        let shown = names.count > 6 ? Array(names.prefix(6)) + ["\(names.count - 6) more"] : names
        return shown.formatted(.list(type: .and))
    }

    /// A service's name from its site, for its mark's letter and its buttons: "stripe.com" is
    /// "Stripe", "dash.cloudflare.com" "Cloudflare".
    public static func service(_ site: String) -> String {
        let labels = site.lowercased().split(separator: ".").filter { $0 != "www" }
        let name = labels.count >= 2 ? labels[labels.count - 2] : labels.first ?? Substring(site)
        return name.prefix(1).uppercased() + name.dropFirst()
    }

    /// The service's name as the words about it write it, where they name it: "RevenueCat" from
    /// "RevenueCat project" at app.revenuecat.com, "App Store Connect" at appstoreconnect.apple.com;
    /// otherwise its name from its site.
    public static func service(_ site: String, in words: [String?]) -> String {
        let labels = site.lowercased().split(separator: ".").filter { $0 != "www" }.map(String.init)
        // The site's own name first, written as a name (capitalized); then a name before it only
        // where it's several words run together ("appstoreconnect"), never a plain word like
        // "billing" or "console", or its ending.
        let named = labels.count >= 2 ? [(labels[labels.count - 2], 1)] + labels.dropLast(2).map { ($0, 2) } : labels.map { ($0, 1) }
        for words in words.compactMap({ $0 }) {
            let tokens = words.split { !$0.isLetter && !$0.isNumber }.map(String.init)
            for (label, least) in named where label.count >= 4 {
                for start in tokens.indices where tokens[start].first?.isUppercase == true {
                    var joined = ""
                    for end in start..<tokens.count {
                        joined += tokens[end].lowercased()
                        if joined == label, end - start + 1 >= least { return tokens[start...end].joined(separator: " ") }
                        if !label.hasPrefix(joined) { break }
                    }
                }
            }
        }
        return service(site)
    }

    /// A step's mark: the icon of the site the plan says it's done at, else of the app on the
    /// computer it's done in, once its box found that app; none otherwise. Never guessed from its
    /// words or its maker.
    public static func mark(of step: GoalPlan.Step) -> StepMark? {
        mark(site: step.site, app: step.app)
    }

    /// The same for what waits for you.
    public static func mark(of item: GoalPlan.Waiting) -> StepMark? {
        mark(site: item.site, app: item.app)
    }

    private static func mark(site: String?, app: GoalPlan.App?) -> StepMark? {
        if let site { return .site(site) }
        if let app, let id = app.id { return .app(id: id, name: app.name) }
        return nil
    }

    public enum StepMark: Equatable, Sendable {
        /// The site's own icon.
        case site(String)
        /// The app's own icon, from its box, by the app's id there; its name for the letter
        /// until it comes.
        case app(id: String, name: String)
    }

    /// A project a plan names, by its name: the last part of a folder named for it ("Sweep" of
    /// "~/Code/Sweep").
    public static func projectName(_ entry: String) -> String {
        isFolder(entry) ? (entry as NSString).lastPathComponent : entry
    }

    /// The project renamed `name`, where it was: a name stays a name, in the projects folder; one
    /// in a folder of its own keeps its parent. Nil for a name that can't be one (empty, or with a
    /// slash) or that's what it was.
    public static func renamed(_ entry: String, to name: String) -> String? {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !name.contains("/"), name != "." && name != "..", name != projectName(entry) else { return nil }
        return isFolder(entry) ? ((entry as NSString).deletingLastPathComponent as NSString).appendingPathComponent(name) : name
    }

    /// The project moved into the folder `parent` (a full path), by its name: nil where it's there
    /// already.
    public static func moved(_ entry: String, into parent: String) -> String? {
        let moved = (parent as NSString).appendingPathComponent(projectName(entry))
        return moved == entry ? nil : moved
    }

    private static func isFolder(_ entry: String) -> Bool { entry.hasPrefix("/") || entry.hasPrefix("~/") }

    /// An amount in its currency, as people write it: "$15", "€9.50".
    public static func money(_ amount: Double, _ currency: String) -> String {
        amount.formatted(FloatingPointFormatStyle<Double>.Currency(code: currency).precision(.fractionLength(amount.rounded() == amount ? 0 : 2)))
    }

    /// A spend line: "driftwood.coffee, up to $15", "ads, up to $20 a day".
    public static func spend(_ line: GoalPlan.Spend) -> String {
        "\(line.what), up to \(money(line.cap, line.currency))\(line.per == .goal ? "" : " a \(line.per.rawValue)")"
    }

    /// How many wait for you: "1 waits for you".
    public static func waiting(_ count: Int) -> String { count == 1 ? "1 waits for you" : "\(count) wait for you" }

    /// What a step under way is at, beside its lane: what the bot counted ("3 of 5 screens"), as
    /// the box asks it to with every share. A plan kept before that has only its share, said roughly
    /// ("About half"), never as a bare percentage.
    public static func underWay(_ step: GoalPlan.Step) -> String {
        if let note = step.note { return note }
        guard let progress = step.progress else { return "Under way" }
        switch progress {
        case ..<0.15: return "Just started"
        case 0.4...0.6: return "About half"
        case 0.85...: return "Nearly done"
        default: return "About \(Int((progress * 10).rounded()) * 10)%"
        }
    }
}
