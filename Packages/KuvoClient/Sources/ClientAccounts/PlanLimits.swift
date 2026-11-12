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

    private enum CodingKeys: String, CodingKey { case provider, service, agent, account, label, identity, plan, windows, balance, checked, next, problem, id, boxes, away }

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
private struct Readable<Item: Decodable>: Decodable {
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
    /// menu bar lists this Mac's and its machines'. For boxes from before they listed every
    /// computer's rows themselves (#210; goes once every box has had that three months).
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
    /// says is signed in there; else (a box from before rows, #210, or one the first hasn't heard
    /// from yet) each box's own, merged here (goes once every box has had #210 three months).
    public static func listing(_ answers: [Answer]) -> Listing {
        if let first = answers.first, let rows = first.limits.rows {
            let ids = Set(rows.compactMap(\.rowID))
            let covered = answers.dropFirst().allSatisfy { other in
                guard let theirs = other.limits.rows else { return false }
                return theirs.filter { $0.boxes.contains(where: \.here) }.allSatisfy { $0.rowID.map(ids.contains) ?? false }
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
    /// calls it; a row that doesn't say is its box's own, as before. Only for boxes from before they
    /// said `rows` (the box merges them now, `limits-rows.ts`; #210).
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
