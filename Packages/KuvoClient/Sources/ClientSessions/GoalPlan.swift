import Foundation

// A bot's goal and its plan, as both apps show it (PROTOCOL.md, "Work › Goals"): the card a bot puts
// to you, the goal under way with a track for each step, what waits for you, what's paused at a
// limit and until when, the digest and the report, as its box keeps them (`kuvo/work/goals`). The
// conversation's own goal (OpenCodeKit's `Goal`, the goal bar) is the same goal: this is its plan.

/// A bot's goal with its plan.
public struct GoalPlan: Decodable, Sendable, Hashable, Identifiable {
    public enum State: String, Decodable, Sendable { case proposed, running, done, stopped, declined }

    /// A step of the plan, a track of its own.
    public struct Step: Decodable, Sendable, Hashable, Identifiable {
        public enum State: String, Decodable, Sendable { case todo, doing, done, waiting, paused, skipped }
        public let id: String
        public let text: String
        public let state: State
        /// How far along (0 to 1), only where the bot measured it: nil is in progress, not a share.
        public let progress: Double?
        public let note: String?
        public let phase: String?
        /// The service it's done at, by its site ("stripe.com"), for its icon.
        public let site: String?
        /// The steps it waits for, by id.
        public let after: [String]
        /// The sessions working on it.
        public let sessions: [String]
        /// While it's paused at a limit: when it carries on (ms since 1970).
        public let resumes: Double?
        /// When it began and ended (ms since 1970), for a time axis.
        public let began: Double?
        public let ended: Double?

        public init(id: String, text: String, state: State, progress: Double? = nil, note: String? = nil, phase: String? = nil, site: String? = nil, after: [String] = [], sessions: [String] = [], resumes: Double? = nil, began: Double? = nil, ended: Double? = nil) {
            self.id = id
            self.text = text
            self.state = state
            self.progress = progress
            self.note = note
            self.phase = phase
            self.site = site
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
            phase = try container.decodeIfPresent(String.self, forKey: .phase)
            site = try container.decodeIfPresent(String.self, forKey: .site)
            after = (try? container.decodeIfPresent([String].self, forKey: .after)) ?? []
            sessions = (try? container.decodeIfPresent([String].self, forKey: .sessions)) ?? []
            resumes = try container.decodeIfPresent(Double.self, forKey: .resumes)
            began = try container.decodeIfPresent(Double.self, forKey: .began)
            ended = try container.decodeIfPresent(Double.self, forKey: .ended)
        }

        private enum CodingKeys: String, CodingKey { case id, text, state, progress, note, phase, site, after, sessions, resumes, began, ended }

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
        public let session: String?
        public let at: Double

        public init(id: String, kind: Kind, text: String, detail: String? = nil, url: URL? = nil, site: String? = nil, session: String? = nil, at: Double) {
            self.id = id
            self.kind = kind
            self.text = text
            self.detail = detail
            self.url = url
            self.site = site
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
            session = try container.decodeIfPresent(String.self, forKey: .session)
            at = try container.decode(Double.self, forKey: .at)
        }

        private enum CodingKeys: String, CodingKey { case id, kind, text, detail, url, site, session, at }
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
    public let lastDigest: Digest?
    public let report: String?
    /// Whether its box may work on it alone (else it runs with you there).
    public let alone: Bool

    public init(id: String, bot: String, name: String, session: String, goal: String, title: String? = nil, state: State, steps: [Step], checks: [Check] = [], spend: [Spend] = [], public: [Public] = [], projects: [String] = [], wake: Bool = false, digest: Cadence = .none, ends: Double? = nil, proposed: Double, started: Double? = nil, ended: Double? = nil, waiting: [Waiting] = [], paused: [Paused] = [], waited: Double = 0, watching: [String] = [], lastDigest: Digest? = nil, report: String? = nil, alone: Bool) {
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
        self.lastDigest = lastDigest
        self.report = report
        self.alone = alone
    }

    private enum CodingKeys: String, CodingKey { case id, bot, name, session, goal, title, state, steps, checks, spend, `public`, projects, wake, digest, ends, proposed, started, ended, waiting, paused, waited, watching, lastDigest, report, alone }

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
        lastDigest = try? container.decodeIfPresent(Digest.self, forKey: .lastDigest)
        report = try container.decodeIfPresent(String.self, forKey: .report)
        alone = (try? container.decode(Bool.self, forKey: .alone)) ?? false
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
    /// Its phases, in the plan's order (none for a plan without them).
    public var phases: [String] {
        var seen: [String] = []
        for step in steps { if let phase = step.phase, !seen.contains(phase) { seen.append(phase) } }
        return seen
    }
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

/// Your answer to a goal (`POST kuvo/work/goals/<id>`): start it with your switches and limits, not
/// now, or stop it; while it runs, change its limits, or put away what waits for you.
public struct GoalPlanAnswer: Encodable, Sendable {
    public enum Action: String, Encodable, Sendable { case start, decline, stop, change, clear }
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
    public let `public`: [String: Bool]?
    public let wake: Bool?
    public let digest: GoalPlan.Cadence?
    /// An end you set, in ms since 1970.
    public let ends: Double?
    /// The end taken away (sent as `"ends": null`); with neither, the end stays as it was.
    public let clearsEnd: Bool
    public let spend: [SpendChange]?
    /// What waits for you, put away (`clear`).
    public let waiting: String?

    /// Start it. `ends`: the end you picked; `clearsEnd`: you picked none where the bot had
    /// proposed one, which takes it away (left out, the bot's stays).
    public static func start(public switches: [String: Bool], wake: Bool, digest: GoalPlan.Cadence? = nil, ends: Date? = nil, clearsEnd: Bool = false, spend: [SpendChange]? = nil) -> GoalPlanAnswer {
        GoalPlanAnswer(action: .start, public: switches, wake: wake, digest: digest, ends: ends.map { $0.timeIntervalSince1970 * 1000 }, clearsEnd: ends == nil && clearsEnd, spend: spend, waiting: nil)
    }
    /// A running goal's limits changed: only what's given (`clearsEnd` takes its end away).
    public static func change(public switches: [String: Bool]? = nil, wake: Bool? = nil, digest: GoalPlan.Cadence? = nil, ends: Date? = nil, clearsEnd: Bool = false, spend: [SpendChange]? = nil) -> GoalPlanAnswer {
        GoalPlanAnswer(action: .change, public: switches, wake: wake, digest: digest, ends: ends.map { $0.timeIntervalSince1970 * 1000 }, clearsEnd: ends == nil && clearsEnd, spend: spend, waiting: nil)
    }
    public static func clear(waiting id: String) -> GoalPlanAnswer {
        GoalPlanAnswer(action: .clear, public: nil, wake: nil, digest: nil, ends: nil, clearsEnd: false, spend: nil, waiting: id)
    }
    public static let decline = GoalPlanAnswer(action: .decline, public: nil, wake: nil, digest: nil, ends: nil, clearsEnd: false, spend: nil, waiting: nil)
    public static let stop = GoalPlanAnswer(action: .stop, public: nil, wake: nil, digest: nil, ends: nil, clearsEnd: false, spend: nil, waiting: nil)

    private enum CodingKeys: String, CodingKey { case action, `public`, wake, digest, ends, spend, waiting }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(action, forKey: .action)
        try container.encodeIfPresent(self.public, forKey: .public)
        try container.encodeIfPresent(wake, forKey: .wake)
        try container.encodeIfPresent(digest, forKey: .digest)
        if let ends {
            try container.encode(ends, forKey: .ends)
        } else if clearsEnd {
            try container.encodeNil(forKey: .ends)
        }
        try container.encodeIfPresent(spend, forKey: .spend)
        try container.encodeIfPresent(waiting, forKey: .waiting)
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

    /// The plan, in a line: "site → domain → DNS → deploy → checkout".
    public static func plan(_ goal: GoalPlan) -> String { goal.steps.map(\.text).joined(separator: " → ") }

    /// "2 of 5".
    public static func progress(_ goal: GoalPlan) -> String { "\(goal.done) of \(goal.steps.count)" }

    /// The plan in a few words, for its card: "6 steps", "12 steps in 3 phases".
    public static func summary(_ goal: GoalPlan) -> String {
        let steps = goal.steps.count == 1 ? "1 step" : "\(goal.steps.count) steps"
        let phases = goal.phases.count
        return phases > 1 ? "\(steps) in \(phases) phases" : steps
    }

    /// What the plan does, as a list in words: "Site, Domain, DNS and Deploy"; its phases, for a
    /// plan with them.
    public static func outline(_ goal: GoalPlan) -> String {
        let names = goal.phases.count > 1 ? goal.phases : goal.steps.map(\.text)
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

    /// A track as VoiceOver reads it: "DNS, half done", "Deploy, paused until 15:20", "Build the
    /// site, in progress".
    public static func spoken(_ step: GoalPlan.Step, now: Date = .now) -> String {
        switch step.state {
        case .done: return "\(step.text), done"
        case .skipped: return "\(step.text), skipped"
        case .todo: return "\(step.text), not started"
        case .waiting: return "\(step.text), waiting for you"
        case .paused: return step.resumesDate.map { "\(step.text), paused until \($0.formatted(date: .omitted, time: .shortened))" } ?? "\(step.text), paused"
        case .doing:
            if let note = step.note { return "\(step.text), \(note)" }
            guard let progress = step.progress else { return "\(step.text), in progress" }
            switch progress {
            case ..<0.15: return "\(step.text), just started"
            case 0.4...0.6: return "\(step.text), half done"
            case 0.85...: return "\(step.text), nearly done"
            default: return "\(step.text), \(Int((progress * 100).rounded())) percent done"
            }
        }
    }
}
