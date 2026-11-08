import Foundation

/// A computer's plan limits, as its box states them (`kuvo/agents/api/kuvo/limits`, KuvoLink's
/// PROTOCOL.md "Plan limits"): one row per account signed in to Kuvo Code there, each coding agent's
/// and each of the engine's, with its windows. What both apps show of them is worked out here:
/// each row's name, the windows still current, the one closest to its limit, and as of when.
public struct BoxLimits: Decodable, Hashable, Sendable {
    public var accounts: [LimitsAccount]
    /// The services (`claude`, `codex`, `copilot`…) this box reads the limits of: a client shows
    /// those from here, and the rest from where it had them before.
    public var services: [String]

    public init(accounts: [LimitsAccount], services: [String]) {
        self.accounts = accounts
        self.services = services
    }

    private enum CodingKeys: String, CodingKey { case accounts, services }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        accounts = try container.decode(Readable<LimitsAccount>.self, forKey: .accounts).items
        services = try container.decodeIfPresent([String].self, forKey: .services) ?? []
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
    public var plan: String?
    public var windows: [LimitsWindow]
    public var balance: Balance?
    public var checked: Date?
    public var next: Date?
    public var problem: Problem?

    public struct Balance: Decodable, Hashable, Sendable {
        public var left: Double
        public var limit: Double?
        /// `usd` or `credits`.
        public var unit: String
    }

    public struct Problem: Decodable, Hashable, Sendable {
        /// `rate-limited`, `expired`, `unreadable` or `failed`.
        public var kind: String
        public var message: String
        public var until: Date?

        private enum CodingKeys: String, CodingKey { case kind, message, until }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            kind = try container.decode(String.self, forKey: .kind)
            message = try container.decode(String.self, forKey: .message)
            until = try container.decodeIfPresent(Double.self, forKey: .until).map(Date.init(milliseconds:))
        }
    }

    public init(provider: String, service: String, agent: String? = nil, account: String? = nil, label: String? = nil, plan: String? = nil,
                windows: [LimitsWindow] = [], balance: Balance? = nil, problem: Problem? = nil) {
        self.provider = provider
        self.service = service
        self.agent = agent
        self.account = account
        self.label = label
        self.plan = plan
        self.windows = windows
        self.balance = balance
        self.problem = problem
    }

    private enum CodingKeys: String, CodingKey { case provider, service, agent, account, label, plan, windows, balance, checked, next, problem }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decode(String.self, forKey: .provider)
        // (A box from before it said: its coding agents' only.)
        agent = try container.decodeIfPresent(String.self, forKey: .agent)
        service = try container.decodeIfPresent(String.self, forKey: .service) ?? agent ?? provider
        account = try container.decodeIfPresent(String.self, forKey: .account)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        plan = try container.decodeIfPresent(String.self, forKey: .plan)
        windows = try container.decodeIfPresent(Readable<LimitsWindow>.self, forKey: .windows)?.items ?? []
        balance = try? container.decodeIfPresent(Balance.self, forKey: .balance)
        checked = try container.decodeIfPresent(Double.self, forKey: .checked).map(Date.init(milliseconds:))
        next = try container.decodeIfPresent(Double.self, forKey: .next).map(Date.init(milliseconds:))
        problem = try? container.decodeIfPresent(Problem.self, forKey: .problem)
    }

    /// Its row's name: "Claude", "Claude · Work" for one you added, "Copilot" for the engine's.
    public var title: String {
        let base = agent.map { Self.agentNames[$0] ?? $0.capitalized } ?? Self.serviceNames[service] ?? service.capitalized
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

    /// The coding agents, as the usage panel names their rows.
    static let agentNames = ["claude": "Claude", "codex": "Codex", "grok": "Grok", "cursor": "Cursor", "antigravity": "Antigravity"]
    /// The engine's sign-ins, by what they're the limits of.
    static let serviceNames = ["codex": "ChatGPT", "grok": "SuperGrok", "copilot": "Copilot", "openrouter": "OpenRouter", "zai": "Z.ai", "ollama": "Ollama", "opencode": "OpenCode Go"]

    /// Its windows still current: one that started over since it was read is left out (what's used
    /// now isn't known).
    public func windows(at now: Date) -> [LimitsWindow] {
        windows.filter { ($0.resetsAt ?? .distantFuture) > now }
    }

    /// The window with the least left, as the bar shows it.
    public func tightest(at now: Date) -> LimitsWindow? {
        windows(at: now).max { $0.used < $1.used }
    }

    /// When the oldest of what it shows was read: its "as of".
    public func readAt(now: Date) -> Date? {
        windows(at: now).map(\.read).min()
    }

    /// How old a reading is when it's shown as out of date ("As of …" on the Mac): longer than a
    /// box leaves between reads (10 to 15 minutes), so one read on time never is.
    public static let outdatedAfter: TimeInterval = 30 * 60

    public func isOutdated(now: Date) -> Bool {
        readAt(now: now).map { now.timeIntervalSince($0) > Self.outdatedAfter } ?? false
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
