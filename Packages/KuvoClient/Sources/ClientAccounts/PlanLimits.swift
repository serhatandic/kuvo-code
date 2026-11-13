import Foundation

/// A computer's plan limits, as its box states them (`kuvo/agents/api/kuvo/limits`, KuvoLink's
/// PROTOCOL.md "Plan limits"): one row per account signed in to Kuvo Code there, each coding agent's
/// and each of the engine's, with its windows. What both apps show of them is worked out here:
/// each row's name, the windows still current, the one closest to its limit, and as of when.
public struct BoxLimits: Decodable, Hashable, Sendable {
    /// This box's own accounts.
    public var accounts: [LimitsAccount]
    /// The services (`claude`, `codex`, `copilot`…) this box reads the limits of: a client shows
    /// those from here, and the rest from where it had them before.
    public var services: [String]
    /// Every account across your computers, one row each, as the box worked them out (each with its
    /// newest reading and the computers it's signed in on, `boxes`), this box's first: what a
    /// client lists, as it is. Nil from a box from before it said them.
    public var rows: [LimitsAccount]?

    public init(accounts: [LimitsAccount], services: [String], rows: [LimitsAccount]? = nil) {
        self.accounts = accounts
        self.services = services
        self.rows = rows
    }

    private enum CodingKeys: String, CodingKey { case accounts, services, rows }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        accounts = try container.decode(Readable<LimitsAccount>.self, forKey: .accounts).items
        services = try container.decodeIfPresent([String].self, forKey: .services) ?? []
        rows = try? container.decodeIfPresent(Readable<LimitsAccount>.self, forKey: .rows)?.items
    }

    /// Reads the route's answer (`{data: …}`) or the event's (`{accounts}`); times are ms.
    public static func decode(_ data: Data) throws -> BoxLimits {
        struct Envelope: Decodable { var data: BoxLimits }
        let decoder = JSONDecoder()
        if let envelope = try? decoder.decode(Envelope.self, from: data) { return envelope.data }
        return try decoder.decode(BoxLimits.self, from: data)
    }

    public static let path = "kuvo/agents/api/kuvo/limits"
    public static let refreshPath = "kuvo/agents/api/kuvo/limits/refresh"
    /// Using a reset (`ResetOffer`, `ResetDone`), and whether agents may without asking (feature `limits.resets`).
    public static let resetPath = "kuvo/agents/api/kuvo/limits/reset"
    public static let alwaysPath = "kuvo/agents/api/kuvo/limits/reset/always"
    public static let bridgeResetPath = "api/kuvo/limits/reset"
    public static let bridgeAlwaysPath = "api/kuvo/limits/reset/always"
    /// The bridge's own path, for a client talking to it directly (the Mac app to its boxes' bridges).
    public static let bridgePath = "api/kuvo/limits"
    public static let bridgeRefreshPath = "api/kuvo/limits/refresh"
    /// The event that says they changed, on the bridge's events.
    public static let event = "kuvo.limits.updated"
}

/// One account's limits.
public struct LimitsAccount: Decodable, Hashable, Sendable, Identifiable {
    public var id: String { provider }
    /// `claude-code`, `claude-code@1f2e3d4c` for one you added, the engine's `github-copilot`…
    public var provider: String
    /// What it's the limits of, for its mark and color: `claude`, `codex`, `copilot`…
    public var service: String
    /// The coding agent, for one of theirs; none for the engine's sign-ins.
    public var agent: String?
    public var account: String?
    /// What you called one you added ("Work").
    public var label: String?
    /// The account at its maker, the same from every box signed in to it (an opaque hash): rows with
    /// one are one account (`UsageListing.accounts`). None from a box that can't tell, or an older one.
    public var identity: String?
    /// Its row's name where a listing gave it one (two rows of one name: the box it's from added).
    public var name: String?
    public var plan: String?
    public var windows: [LimitsWindow]
    public var balance: Balance?
    /// What the plan has beyond its windows (Cursor's on-demand spend with no cap); #631 piece E
    /// adds more kinds, which this copy leaves out until it knows them.
    public var extras: [Extra] = []
    public var checked: Date?
    public var next: Date?
    public var problem: Problem?
    /// A box's row (`BoxLimits.rows`): its id, the same on every box, and the computers it's signed
    /// in on, the answering box's first (`here`).
    public var rowID: String?
    public var boxes: [Computer] = []
    /// Every computer it's on hasn't been heard from for a while: its numbers are as last told,
    /// never live.
    public var away = false

    /// A computer an account is signed in on, as a box's row says.
    public struct Computer: Decodable, Hashable, Sendable {
        public var key: String
        public var name: String
        /// What it's called there (`claude-code`, `openai`…), the coding agent's, and your name for it there.
        public var provider: String
        public var agent: String?
        public var account: String?
        public var label: String?
        /// When its maker last answered it there.
        public var checked: Date?
        /// The box that answered.
        public var here: Bool
        public var away: Bool

        public init(key: String, name: String, provider: String, agent: String? = nil, account: String? = nil, label: String? = nil, checked: Date? = nil, here: Bool = false, away: Bool = false) {
            self.key = key
            self.name = name
            self.provider = provider
            self.agent = agent
            self.account = account
            self.label = label
            self.checked = checked
            self.here = here
            self.away = away
        }

        private enum CodingKeys: String, CodingKey { case key, name, provider, agent, account, label, checked, here, away }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            key = try container.decodeIfPresent(String.self, forKey: .key) ?? ""
            name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
            provider = try container.decode(String.self, forKey: .provider)
            agent = try container.decodeIfPresent(String.self, forKey: .agent)
            account = try container.decodeIfPresent(String.self, forKey: .account)
            label = try container.decodeIfPresent(String.self, forKey: .label)
            checked = try container.decodeIfPresent(Double.self, forKey: .checked).map(Date.init(milliseconds:))
            here = try container.decodeIfPresent(Bool.self, forKey: .here) ?? false
            away = try container.decodeIfPresent(Bool.self, forKey: .away) ?? false
        }
    }

    public struct Balance: Decodable, Hashable, Sendable {
        public var left: Double
        public var limit: Double?
        /// `usd` or `credits`.
        public var unit: String

        public init(left: Double, limit: Double? = nil, unit: String) {
            self.left = left
            self.limit = limit
            self.unit = unit
        }
    }

    /// A fact of the plan beyond its windows (PROTOCOL.md, "Plan limits", `extras`), by `kind`:
    /// `spent` (an amount used, no limit), `capped` (an amount used of `limit`), `left` (an amount
    /// left), `resets` (the plan's rate-limit resets: `count`, each one's expiry, what one refills,
    /// whether one can be used and on which computer), `unreadable` (what this sign-in can't read,
    /// `message`). A kind this copy doesn't know is left out of the list.
    public struct Extra: Decodable, Hashable, Sendable {
        public var id: String
        /// Its maker's own label ("On-demand", "Extra Usage", "Rate Limit Resets").
        public var name: String
        public var kind: String
        /// `spent`, `capped`, `left`: the amount (0 for the others).
        public var amount: Double
        /// `capped`: the most it may come to.
        public var limit: Double?
        /// `usd`, `credits` or `requests` ("" for `resets` and `unreadable`).
        public var unit: String
        public var resetsAt: Date?
        /// `resets`: how many there are.
        public var count: Int
        /// `resets`: when each expires, soonest first.
        public var expiries: [Date]
        /// `resets`: the windows one refills (`five_hour`, `seven_day`), where its maker says.
        public var refills: [String]
        /// `resets`: one can be used now, from one of your computers (`on`).
        public var usable: Bool
        /// `resets`: the computer of yours whose sign-in uses one (`here`: the box that answered).
        public var on: Place?
        /// `resets`: agents may use one without asking (Always Allow).
        public var agents: Bool
        /// `unreadable`: why, in words.
        public var message: String?

        public struct Place: Decodable, Hashable, Sendable {
            public var key: String
            public var name: String
            public var here: Bool

            public init(key: String, name: String, here: Bool = false) {
                self.key = key
                self.name = name
                self.here = here
            }

            private enum CodingKeys: String, CodingKey { case key, name, here }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                key = try container.decodeIfPresent(String.self, forKey: .key) ?? ""
                name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
                here = try container.decodeIfPresent(Bool.self, forKey: .here) ?? false
            }
        }

        public static let kinds: Set<String> = ["spent", "capped", "left", "resets", "unreadable"]

        public init(id: String, name: String, kind: String = "spent", amount: Double = 0, limit: Double? = nil, unit: String = "", resetsAt: Date? = nil, count: Int = 0,
                    expiries: [Date] = [], refills: [String] = [], usable: Bool = false, on: Place? = nil, agents: Bool = false, message: String? = nil) {
            self.id = id
            self.name = name
            self.kind = kind
            self.amount = amount
            self.limit = limit
            self.unit = unit
            self.resetsAt = resetsAt
            self.count = count
            self.expiries = expiries
            self.refills = refills
            self.usable = usable
            self.on = on
            self.agents = agents
            self.message = message
        }

        private enum CodingKeys: String, CodingKey { case id, name, kind, amount, limit, unit, resetsAt, count, expiries, refills, usable, on, agents, message }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            name = try container.decode(String.self, forKey: .name)
            kind = try container.decode(String.self, forKey: .kind)
            // (A kind this copy doesn't know is left out of the list: `Readable`.)
            guard Self.kinds.contains(kind) else { throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "an extra this copy doesn't know") }
            let amounts = kind == "spent" || kind == "capped" || kind == "left"
            amount = amounts ? try container.decode(Double.self, forKey: .amount) : 0
            unit = amounts ? try container.decode(String.self, forKey: .unit) : ""
            limit = kind == "capped" ? try container.decode(Double.self, forKey: .limit) : nil
            resetsAt = try container.decodeIfPresent(Double.self, forKey: .resetsAt).map(Date.init(milliseconds:))
            count = kind == "resets" ? Int(try container.decode(Double.self, forKey: .count)) : 0
            expiries = (try? container.decodeIfPresent([Double].self, forKey: .expiries))?.map(Date.init(milliseconds:)) ?? []
            refills = (try? container.decodeIfPresent([String].self, forKey: .refills)) ?? []
            usable = (try? container.decodeIfPresent(Bool.self, forKey: .usable)) ?? false
            on = try? container.decodeIfPresent(Place.self, forKey: .on)
            agents = (try? container.decodeIfPresent(Bool.self, forKey: .agents)) ?? false
            message = kind == "unreadable" ? try container.decode(String.self, forKey: .message) : nil
        }
    }

    /// Its rate-limit resets, where it has them (`resets`).
    public var resets: Extra? { extras.first { $0.kind == "resets" } }

    public struct Problem: Decodable, Hashable, Sendable {
        /// `rate-limited`, `expired`, `unreadable` or `failed`.
        public var kind: String
        public var message: String
        public var until: Date?

        public init(kind: String, message: String, until: Date? = nil) {
            self.kind = kind
            self.message = message
            self.until = until
        }

        private enum CodingKeys: String, CodingKey { case kind, message, until }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            kind = try container.decode(String.self, forKey: .kind)
            message = try container.decode(String.self, forKey: .message)
            until = try container.decodeIfPresent(Double.self, forKey: .until).map(Date.init(milliseconds:))
        }
    }

    public init(provider: String, service: String, agent: String? = nil, account: String? = nil, label: String? = nil, identity: String? = nil, plan: String? = nil,
                windows: [LimitsWindow] = [], balance: Balance? = nil, checked: Date? = nil, problem: Problem? = nil) {
        self.provider = provider
        self.service = service
        self.agent = agent
        self.account = account
        self.label = label
        self.identity = identity
        self.checked = checked
        self.plan = plan
        self.windows = windows
        self.balance = balance
        self.problem = problem
    }

    private enum CodingKeys: String, CodingKey { case provider, service, agent, account, label, identity, plan, windows, balance, extras, checked, next, problem, id, boxes, away }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decode(String.self, forKey: .provider)
        // (A box from before it said: its coding agents' only.)
        agent = try container.decodeIfPresent(String.self, forKey: .agent)
        service = try container.decodeIfPresent(String.self, forKey: .service) ?? agent ?? provider
        account = try container.decodeIfPresent(String.self, forKey: .account)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        identity = (try? container.decodeIfPresent(String.self, forKey: .identity))?.flatMap { $0.isEmpty ? nil : $0 }
        plan = try container.decodeIfPresent(String.self, forKey: .plan)
        windows = try container.decodeIfPresent(Readable<LimitsWindow>.self, forKey: .windows)?.items ?? []
        balance = try? container.decodeIfPresent(Balance.self, forKey: .balance)
        extras = (try? container.decodeIfPresent(Readable<Extra>.self, forKey: .extras))?.items ?? []
        checked = try container.decodeIfPresent(Double.self, forKey: .checked).map(Date.init(milliseconds:))
        next = try container.decodeIfPresent(Double.self, forKey: .next).map(Date.init(milliseconds:))
        problem = try? container.decodeIfPresent(Problem.self, forKey: .problem)
        rowID = try? container.decodeIfPresent(String.self, forKey: .id)
        boxes = (try? container.decodeIfPresent(Readable<Computer>.self, forKey: .boxes))?.items ?? []
        away = (try? container.decodeIfPresent(Bool.self, forKey: .away)) ?? false
    }

    /// Its row's name: "Claude", "Claude · Work" for one you added, "Copilot" for the engine's.
    public var title: String {
        if let name { return name }
        let base = agent.map { AccountNames.agents[$0] ?? $0.capitalized } ?? AccountNames.services[service] ?? service.capitalized
        guard let label = label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty else { return base }
        return "\(base) · \(label)"
    }

    /// Its service's brand color in light mode, "#RRGGBB", as the Mac's usage panel draws it
    /// (UsageKit's `TotalSpendPalette`), for a client drawing its bar in a pastel of it.
    public var brandColor: String {
        Self.brandColors[service] ?? "#8E8E93"
    }

    static let brandColors = [
        "claude": "#DE7356", "codex": "#10A37F", "cursor": "#13120A", "grok": "#8E8E93", "opencode": "#6E6E73",
        "openrouter": "#6467F2", "antigravity": "#4285F4", "copilot": "#A855F7", "zai": "#2D2D2D", "ollama": "#6E6E73",
    ]


    /// Its windows still current: one that started over since it was read is left out (what's used
    /// now isn't known).
    public func windows(at now: Date) -> [LimitsWindow] {
        windows.filter { ($0.resetsAt ?? .distantFuture) > now }
    }

    /// The window with the least left, as the bar shows it.
    public func tightest(at now: Date) -> LimitsWindow? {
        windows(at: now).max { $0.used < $1.used }
    }

    /// When it was last heard of or read: its "as of" (a turn tells one window, the rest stay as read).
    public func readAt(now: Date) -> Date? {
        windows(at: now).map(\.read).max()
    }

    /// How old a reading is when it's shown as out of date ("As of …" on the Mac): longer than a
    /// box leaves between reads (10 to 15 minutes), so one read on time never is.
    public static let outdatedAfter: TimeInterval = 30 * 60

    /// Read long ago, or every computer it's on is away (its numbers aren't live, however new).
    public func isOutdated(now: Date) -> Bool {
        away || (readAt(now: now).map { now.timeIntervalSince($0) > Self.outdatedAfter } ?? false)
    }
}

/// One window of a plan's limit.
public struct LimitsWindow: Decodable, Hashable, Sendable, Identifiable {
    public var id: String
    /// How much of it is gone, 0…1.
    public var used: Double
    public var resetsAt: Date?
    /// How long it is, in minutes, when its maker says.
    public var minutes: Int?
    /// The model it's for ("Sonnet"), or none for the whole plan's.
    public var model: String?
    /// Its maker's name for what it counts ("Premium requests").
    public var name: String?
    public var amount: Amount?
    public var read: Date
    /// `usage` (read from its maker) or `turn` (heard in a turn).
    public var source: String

    public struct Amount: Decodable, Hashable, Sendable {
        public var used: Double
        public var limit: Double
        /// `requests`, `usd` or `credits`.
        public var unit: String
    }

    private enum CodingKeys: String, CodingKey { case id, used, resetsAt, minutes, model, name, amount, read, source }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        used = try container.decode(Double.self, forKey: .used)
        resetsAt = try container.decodeIfPresent(Double.self, forKey: .resetsAt).map(Date.init(milliseconds:))
        minutes = try container.decodeIfPresent(Int.self, forKey: .minutes)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        amount = try? container.decodeIfPresent(Amount.self, forKey: .amount)
        read = Date(milliseconds: try container.decode(Double.self, forKey: .read))
        source = try container.decodeIfPresent(String.self, forKey: .source) ?? "usage"
    }

    public init(id: String, used: Double, resetsAt: Date? = nil, minutes: Int? = nil, model: String? = nil, name: String? = nil, amount: Amount? = nil, read: Date, source: String = "usage") {
        self.id = id
        self.used = used
        self.resetsAt = resetsAt
        self.minutes = minutes
        self.model = model
        self.name = name
        self.amount = amount
        self.read = read
        self.source = source
    }

    /// Its name on a row, as the usage panel names them: "Session", "Weekly", "Sonnet", "Premium requests".
    public var title: String {
        if let name, !name.isEmpty { return name }
        if let model, !model.isEmpty { return model }
        switch minutes {
        case 300: return "Session"
        case 10_080: return "Weekly"
        case let minutes? where (40_000...45_000).contains(minutes): return "Monthly"
        case let minutes? where minutes >= 1_440: return "\(minutes / 1_440)-day"
        case let minutes? where minutes >= 60: return "\(minutes / 60)-hour"
        default: return "Limit"
        }
    }
}

/// A list's items this copy can read: one it can't is left out, not all of them.
struct Readable<Item: Decodable>: Decodable {
    var items: [Item] = []

    init(from decoder: Decoder) throws {
        var list = try decoder.unkeyedContainer()
        while !list.isAtEnd {
            if let item = try? list.decode(Item.self) { items.append(item) } else { _ = try list.decode(Skipped.self) }
        }
    }

    /// Any value at all, passed over.
    private struct Skipped: Decodable {
        init(from decoder: Decoder) {}
    }
}

extension Date {
    /// A box's time: ms since 1970.
    init(milliseconds: Double) {
        self.init(timeIntervalSince1970: milliseconds / 1000)
    }
}

/// What a client lists of a computer's usage, in one order on every client: the Mac panel's own
/// providers (`kuvo/usage`) in its order, where one says it `covers` a service, that box's rows of
/// it there (the first with what that provider had besides: spend, its trend); then the box's
/// other rows (a machine has no panel: all of them). One row per account, as one box lists them
/// (`listing`, from its `BoxLimits.rows`); merged here only from boxes from before those.
public enum UsageListing {
    public enum Item<Panel> {
        case panel(Panel)
        /// An account's row (its id, its boxes and its limits as one), with the panel's entry whose
        /// other lines go under it.
        case account(Account, below: Panel?)
    }

    /// `accounts`: one box's, as it states them (an account it has twice, a coding agent's and the
    /// engine's sign-in to it, is one row).
    public static func items<Panel>(panel: [Panel], covers: (Panel) -> String?, accounts: [LimitsAccount]) -> [Item<Panel>] {
        items(panel: panel, covers: covers, boxes: [Box(key: "", name: nil, accounts: accounts)])
    }

    /// Every box's accounts, one row per account across them (`accounts(_:)`), placed where the
    /// panel (the client's own computer's, or the first Mac's) says each service goes, as the Mac's
    /// menu bar lists this Mac's and its machines'. COMPAT(0.7 limits-merge): for boxes from before rows. Goes 3 months after 0.8.0.
    public static func items<Panel>(panel: [Panel], covers: (Panel) -> String?, boxes: [Box]) -> [Item<Panel>] {
        place(Self.accounts(boxes), panel: panel, covers: covers)
    }

    /// What the boxes a client reached said (`listing`), placed where the panel says each service goes.
    public static func items<Panel>(panel: [Panel], covers: (Panel) -> String?, listing: Listing) -> [Item<Panel>] {
        place(listing.accounts, panel: panel, covers: covers)
    }

    private static func place<Panel>(_ listed: [Account], panel: [Panel], covers: (Panel) -> String?) -> [Item<Panel>] {
        var items: [Item<Panel>] = []
        var placed = Set<String>()
        for entry in panel {
            guard let service = covers(entry) else {
                items.append(.panel(entry))
                continue
            }
            let rows = listed.filter { $0.account.service == service && !placed.contains($0.id) }
            // (Not read from the box yet: what the panel has, as it is.)
            guard !rows.isEmpty else {
                items.append(.panel(entry))
                continue
            }
            for (index, row) in rows.enumerated() {
                items.append(.account(row, below: index == 0 ? entry : nil))
                placed.insert(row.id)
            }
        }
        for row in listed where !placed.contains(row.id) { items.append(.account(row, below: nil)) }
        return items
    }
}

extension UsageListing {
    /// One computer's accounts, as a client lists them with its other computers' (PROTOCOL.md, "Plan
    /// limits").
    public struct Box: Sendable {
        /// Which box it is, unique among those listed.
        public var key: String
        /// Its name, added to a row's where two rows would have one name; nil for the client's own
        /// computer, whose rows keep theirs.
        public var name: String?
        public var accounts: [LimitsAccount]

        public init(key: String, name: String?, accounts: [LimitsAccount]) {
            self.key = key
            self.name = name
            self.accounts = accounts
        }
    }

    /// One account's row, from every box that has it.
    public struct Account: Sendable, Hashable, Identifiable {
        /// The same for the account whichever boxes have it, as long as they say who it is.
        public var id: String
        /// Its limits, each window as read last by any of its boxes, and its row's name (`title`).
        public var account: LimitsAccount
        /// The boxes it's from, in their order, each with what it's called there (`provider`).
        public var sources: [Source]

        public struct Source: Sendable, Hashable {
            /// Its box's key ("" for the client's own computer, or the box that answered).
            public var box: String
            public var provider: String
            /// Its computer's name (none for the client's own).
            public var name: String?
        }
    }

    /// What one box a client reached said of your accounts.
    public struct Answer: Sendable {
        /// Which computer it is to the client ("" for the Mac's own).
        public var key: String
        /// Its name; nil for the client's own computer.
        public var name: String?
        public var limits: BoxLimits

        public init(key: String, name: String?, limits: BoxLimits) {
            self.key = key
            self.name = name
            self.limits = limits
        }
    }

    /// Every account across your computers, one row each, and the box whose list it is.
    public struct Listing: Sendable {
        public var accounts: [Account]
        /// The box (`Answer.key`) whose rows these are, as it listed them: the one a refresh goes
        /// to (it asks the others for what it hasn't). Nil when they're each box's own, merged here.
        public var lister: String?
    }

    /// What a client lists of every computer it reached (`answers`, in its order, its own computer
    /// first): the first box's rows, as they are (it works them out with your other computers'
    /// boxes, PROTOCOL.md "Plan limits"), when they have every account each other box it reached
    /// says is signed in there, from that computer as it hears it now (not away); else (a box from
    /// before rows, #210, or one the first hasn't heard from lately) each box's own, merged here.
    /// COMPAT(0.7 limits-merge): the merge for boxes from before rows. Goes 3 months after 0.8.0.
    public static func listing(_ answers: [Answer]) -> Listing {
        if let first = answers.first, let rows = first.limits.rows {
            let byID = Dictionary(rows.compactMap { row in row.rowID.map { ($0, row) } }, uniquingKeysWith: { first, _ in first })
            let covered = answers.dropFirst().allSatisfy { other in
                guard let theirs = other.limits.rows else { return false }
                return theirs.allSatisfy { row in
                    guard let here = row.boxes.first(where: \.here) else { return true }
                    return row.rowID.flatMap { byID[$0] }?.boxes.contains { $0.key == here.key && !$0.away } ?? false
                }
            }
            if covered { return Listing(accounts: accounts(rows: rows, here: first.key), lister: first.key) }
        }
        return Listing(accounts: accounts(answers.map { Box(key: $0.key, name: $0.name, accounts: $0.limits.accounts) }), lister: nil)
    }

    /// A box's rows (`BoxLimits.rows`) as they are, each from the computers it says, the box that
    /// answered (`here`, the client's key for it) taken as the client's own; named as below.
    public static func accounts(rows: [LimitsAccount], here: String = "") -> [Account] {
        var listed = rows.map { row in
            Account(id: row.rowID ?? row.provider, account: row,
                    sources: row.boxes.map { Account.Source(box: $0.here ? here : $0.key, provider: $0.provider, name: $0.here ? nil : $0.name) })
        }
        named(&listed, members: rows.map { row in
            row.boxes.map { (name: $0.here ? nil : Optional($0.name), account: LimitsAccount(provider: $0.provider, service: row.service, agent: $0.agent, account: $0.account, label: $0.label)) }
        })
        return listed
    }

    /// One row per account across the boxes, in their order (the client's own computer first): rows
    /// of one service that say they're one account (`identity`) are one, from any box, whatever each
    /// calls it; a row that doesn't say is its box's own, as before. COMPAT(0.7 limits-merge): for boxes from before rows (the box merges them now, `limits-rows.ts`). Goes 3 months after 0.8.0.
    public static func accounts(_ boxes: [Box]) -> [Account] {
        var groups: [(id: String, members: [(box: Box, account: LimitsAccount)])] = []
        var found: [String: Int] = [:]
        for box in boxes {
            for account in box.accounts {
                let id = account.identity.map { "\(account.service)#\($0)" } ?? "\(box.key)/\(account.provider)"
                if let index = found[id] {
                    groups[index].members.append((box, account))
                } else {
                    found[id] = groups.count
                    groups.append((id, [(box, account)]))
                }
            }
        }
        var listed = groups.map { group in
            Account(id: group.id, account: merged(group.members.map(\.account)),
                    sources: group.members.map { Account.Source(box: $0.box.key, provider: $0.account.provider, name: $0.box.name) })
        }
        named(&listed, members: groups.map { group in group.members.map { (name: $0.box.name, account: $0.account) } })
        return listed
    }

    /// Each row's name: its account's (`title`), unless two would have one name.
    /// `members`: each row's accounts as each computer has it, with the computer's name (none for
    /// the client's own).
    static func named(_ listed: inout [Account], members: [[(name: String?, account: LimitsAccount)]]) {
        // Two rows of one name (two accounts, or one whose boxes can't say it's the same) are told
        // apart: a row whose sign-in on this computer is the engine's by the service's name
        // ("ChatGPT"); a row not on this computer by its boxes' names; rows still alike (each on
        // this computer) by their other boxes'.
        var names = listed.map(\.account.title)
        let mine = { (index: Int) in members[index].filter { $0.name == nil }.map(\.account) }
        let elsewhere = { (index: Int) -> String? in
            var seen = Set<String>()
            let boxes = members[index].compactMap(\.name).filter { seen.insert($0).inserted }
            return boxes.isEmpty ? nil : boxes.joined(separator: ", ")
        }
        func alike() -> Set<String> { Set(Dictionary(grouping: names, by: { $0 }).filter { $0.value.count > 1 }.keys) }
        var clash = alike()
        for index in listed.indices where clash.contains(names[index]) {
            let here = mine(index)
            guard let engine = here.first, !here.contains(where: { $0.agent != nil }) else { continue }
            names[index] = engine.title
        }
        clash = alike()
        for index in listed.indices where clash.contains(names[index]) && mine(index).isEmpty {
            if let boxes = elsewhere(index) { names[index] += " · \(boxes)" }
        }
        clash = alike()
        for index in listed.indices where clash.contains(names[index]) && !mine(index).isEmpty {
            if let boxes = elsewhere(index) { names[index] += " · \(boxes)" }
        }
        for index in listed.indices where names[index] != listed[index].account.title { listed[index].account.name = names[index] }
    }

    /// One account as its boxes state it, together: named as a coding agent's where one is among
    /// them (else the engine's sign-in's), with the first name you gave it; each window as read last;
    /// the plan, credits and when it was checked as the newest says; a problem only when none of
    /// them could read it.
    static func merged(_ members: [LimitsAccount]) -> LimitsAccount {
        var account = members.first { $0.agent != nil } ?? members[0]
        guard members.count > 1 else { return account }
        account.label = members.lazy.compactMap { $0.label?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
        var windows: [LimitsWindow] = []
        for member in members {
            for window in member.windows {
                if let index = windows.firstIndex(where: { $0.limit == window.limit }) {
                    if window.read > windows[index].read { windows[index] = window }
                } else {
                    windows.append(window)
                }
            }
        }
        account.windows = windows
        // Newest first: when its maker last answered, or a turn last told of it.
        let newest = members.sorted { ($0.checked ?? $0.windows.map(\.read).max() ?? .distantPast) > ($1.checked ?? $1.windows.map(\.read).max() ?? .distantPast) }
        account.plan = newest.lazy.compactMap(\.plan).first
        account.balance = newest.lazy.compactMap(\.balance).first
        // (As the box does: the newest reading without a problem's; one without any says there are none now.)
        account.extras = newest.first { $0.checked != nil && $0.problem == nil }?.extras ?? []
        account.checked = members.compactMap(\.checked).max()
        account.next = members.compactMap(\.next).min()
        account.problem = members.allSatisfy { $0.problem != nil } ? newest.first?.problem : nil
        return account
    }
}

extension LimitsWindow {
    /// Which limit it is, the same from any box and either sign-in to an account (a coding agent's,
    /// the engine's), which may name it differently: what it counts, and how long it is.
    var limit: String {
        if model == nil, name == nil, minutes == nil { return "id:" + id }
        return "\(model?.lowercased() ?? "")|\(name ?? "")|\(minutes.map(String.init) ?? "")"
    }
}


/// What a box offers on the first ask to use one of a row's resets (`POST …/limits/reset {row}`):
/// what one more ask, with `confirm`, spends, once.
public struct ResetOffer: Decodable, Hashable, Sendable {
    public var confirm: String
    public var row: String
    public var service: String
    /// How many there are now: one of them is used.
    public var count: Int
    public var refills: [String]
    /// The computer whose sign-in uses it.
    public var on: LimitsAccount.Extra.Place
    /// Agents may use this account's resets without asking.
    public var always: Bool
    /// Until when `confirm` holds.
    public var expires: Date

    public init(confirm: String, row: String, service: String, count: Int, refills: [String] = [], on: LimitsAccount.Extra.Place, always: Bool = false, expires: Date) {
        self.confirm = confirm
        self.row = row
        self.service = service
        self.count = count
        self.refills = refills
        self.on = on
        self.always = always
        self.expires = expires
    }

    private enum CodingKeys: String, CodingKey { case confirm, row, service, count, refills, on, always, expires }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        confirm = try container.decode(String.self, forKey: .confirm)
        row = try container.decode(String.self, forKey: .row)
        service = try container.decodeIfPresent(String.self, forKey: .service) ?? ""
        count = Int(try container.decode(Double.self, forKey: .count))
        refills = (try? container.decodeIfPresent([String].self, forKey: .refills)) ?? []
        on = try container.decode(LimitsAccount.Extra.Place.self, forKey: .on)
        always = (try? container.decodeIfPresent(Bool.self, forKey: .always)) ?? false
        expires = Date(milliseconds: try container.decode(Double.self, forKey: .expires))
    }
}

/// How using a reset went (`POST …/limits/reset {row, confirm}`): `reset` when it did; else why
/// not, in the box's words (`message`), and nothing was used unless it says it may still go through.
public struct ResetDone: Decodable, Hashable, Sendable {
    /// `reset`, `unconfirmed`, `nothing-to-reset`, `no-reset`, `not-now` or `failed`.
    public var outcome: String
    public var until: Date?
    public var message: String?

    public init(outcome: String, until: Date? = nil, message: String? = nil) {
        self.outcome = outcome
        self.until = until
        self.message = message
    }

    public var succeeded: Bool { outcome == "reset" }

    private enum CodingKeys: String, CodingKey { case outcome, until, message }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        outcome = try container.decode(String.self, forKey: .outcome)
        until = try container.decodeIfPresent(Double.self, forKey: .until).map(Date.init(milliseconds:))
        message = try container.decodeIfPresent(String.self, forKey: .message)
    }
}

/// What both apps say of a plan's resets: the row's count, the question and what it does, where
/// it's used, and how it went.
public enum ResetWords {
    /// "2 available".
    public static func available(_ count: Int) -> String { "\(count) available" }

    /// "1 of 2 resets", "your last reset".
    public static func oneOf(_ count: Int) -> String { count <= 1 ? "your last reset" : "1 of \(count) resets" }

    /// The confirmation's question: "Use 1 of 2 resets?", "Use your last reset?"
    public static func question(_ count: Int) -> String { "Use \(oneOf(count))?" }

    /// What it does, from what one refills: "Your 5-hour window starts over now."
    public static func consequence(_ refills: [String]) -> String {
        let session = refills.contains("five_hour"), week = refills.contains("seven_day")
        if session && week { return "Your 5-hour and weekly limits start over now." }
        if session { return "Your 5-hour window starts over now." }
        if week { return "Your weekly limit starts over now." }
        return "Your usage limits start over now."
    }

    /// Where it's used, when that's another of your computers: "Used on hetzner, which has this account's sign-in."
    public static func usedOn(_ name: String) -> String { "Used on \(name.isEmpty ? "another of your computers" : name), which has this account's sign-in." }

    /// The help on the control that uses it on another computer.
    public static func elsewhereHelp(_ name: String) -> String {
        "This computer's sign-in can't use resets. \(name.isEmpty ? "Another of your computers" : name) can: using one asks it to."
    }

    /// What went wrong, as the box said it (else in a line).
    public static func failure(_ done: ResetDone?) -> String { done?.message ?? "Didn't go through. Nothing was used." }

    /// What the row's control says while it works, and once it's done, for VoiceOver.
    public static let using = "Using a reset"
    public static let used = "Reset used"
}
