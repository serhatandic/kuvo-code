import Foundation

/// What a service's accounts spent, as both apps' usage panels show it under its first account
/// (UsageKit's spend tiles and Usage Trend), worked out from the days a box states (`BoxUsage`,
/// PROTOCOL.md "Usage history"): Today, Yesterday and Last 30 Days, each in dollars and tokens, and
/// the tokens of each day. A view only: the box reads, prices and adds up; this picks the days.
///
/// A period with no use has no tile, never `$0.00 · 0 tokens` (nothing used and nothing known look
/// alike), and a box that couldn't be read has no `BoxUsage` at all: so a failed read never shows $0.
public struct UsageSpend: Hashable, Sendable {
    public var periods: [Period]
    /// One point a day, the oldest first, for today and the 30 days before it; empty when nothing
    /// was used in all that time (no trend to draw).
    public var trend: [TrendDay]
    /// Its dollars are an estimate (priced from the logs), not what its maker billed.
    public var estimated: Bool

    /// Today, Yesterday or Last 30 Days.
    public struct Period: Hashable, Sendable, Identifiable {
        /// `today`, `yesterday` or `last30`: the panel's meter is `<service>.<id>`.
        public var id: String
        public var title: String
        public var cost: Double
        public var tokens: Int
        /// Models used then that couldn't be priced (counted nowhere), in name order.
        public var unknown: [String]
    }

    public struct TrendDay: Hashable, Sendable {
        /// `yyyy-MM-dd` in the box's answer's zone.
        public var date: String
        public var tokens: Int

        public init(date: String, tokens: Int) {
            self.date = date
            self.tokens = tokens
        }
    }

    /// Nothing to show: no period with use.
    public var isEmpty: Bool { periods.isEmpty && trend.isEmpty }

    /// `days` as a box states them (newest first or not), in `zone` (the answer's `zone`), as of `now`.
    public init(days: [BoxUsage.Day], zone: String, estimated: Bool = true, now: Date = .now) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone) ?? .current
        let key = { (date: Date) -> String in
            let parts = calendar.dateComponents([.year, .month, .day], from: date)
            return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        }
        let today = calendar.startOfDay(for: now)
        // Today and the 30 days before it, the oldest first: a day the box told before midnight
        // passed here (one more back) isn't in the window any more.
        let window = (0...Self.previousDays).reversed().compactMap { calendar.date(byAdding: .day, value: -$0, to: today).map(key) }
        let inWindow = Set(window)
        var byDate: [String: (cost: Double, tokens: Int, unknown: Set<String>)] = [:]
        for day in days where inWindow.contains(day.date) && day.cost.isFinite && day.cost >= 0 && day.tokens >= 0 {
            var sum = byDate[day.date] ?? (0, 0, [])
            sum.cost += day.cost
            sum.tokens += day.tokens
            sum.unknown.formUnion(day.unknown)
            byDate[day.date] = sum
        }
        let used = { (sum: (cost: Double, tokens: Int, unknown: Set<String>)) in sum.tokens > 0 || sum.cost > 0 }
        var periods: [Period] = []
        for (id, title, date) in [("today", "Today", window.last), ("yesterday", "Yesterday", window.dropLast().last)] {
            guard let date, let sum = byDate[date], used(sum) else { continue }
            periods.append(Period(id: id, title: title, cost: sum.cost, tokens: sum.tokens, unknown: sum.unknown.sorted()))
        }
        // (Added up day by day, the oldest first: the same dollars every time it's drawn.)
        let all = window.compactMap { byDate[$0] }.reduce((cost: 0.0, tokens: 0, unknown: Set<String>())) { ($0.cost + $1.cost, $0.tokens + $1.tokens, $0.unknown.union($1.unknown)) }
        if used(all) { periods.append(Period(id: "last30", title: "Last 30 Days", cost: all.cost, tokens: all.tokens, unknown: all.unknown.sorted())) }
        self.periods = periods
        trend = all.tokens > 0 ? window.map { TrendDay(date: $0, tokens: byDate[$0]?.tokens ?? 0) } : []
        self.estimated = estimated
    }

    /// A service's spend as a box's answer states it (`totals`: your own computers' accounts added up);
    /// nil where it doesn't state that service, or none of it was used.
    public init?(service: String, of usage: BoxUsage, now: Date = .now) {
        guard usage.services.contains(service), let days = usage.totals[service] else { return nil }
        let rows = usage.rows.filter { $0.service == service }
        // (Billed, not estimated, only where every account of it says so: OpenCode's hosted models.)
        self.init(days: days, zone: usage.zone, estimated: rows.isEmpty || rows.contains(where: \.estimated), now: now)
        if isEmpty { return nil }
    }

    /// The days before today the panel counts.
    public static let previousDays = 30
    /// The meter the trend is, after its card's id (`<service>.trend`).
    public static let trendID = "trend"
}

/// How the usage panel lists its cards, as your computers' boxes keep it for every app (`BoxUsageSettings`,
/// PROTOCOL.md "Usage settings"): their order, and which meters show. A view only: the box keeps
/// the settings; this reads what a client draws by.
public struct UsageLayout: Hashable, Sendable {
    /// The cards' order, by service (`claude`…); never set: the panel's own.
    public var order: [String]
    /// The meters shown (`<service>.<meter>`); nil where it was never set (the panel's own: all of
    /// what a client draws).
    public var placed: Set<String>?

    public init(order: [String] = [], placed: Set<String>? = nil) {
        self.order = order
        self.placed = placed
    }

    /// From a box's settings (`settings`), its `layout` part.
    public init(_ settings: BoxUsageSettings?) {
        guard case .object(let parts)? = settings?.settings, case .object(let layout)? = parts["layout"] else {
            self.init()
            return
        }
        let strings = { (key: String) -> [String]? in
            guard case .array(let values)? = layout[key] else { return nil }
            return values.compactMap { if case .string(let value) = $0 { value } else { nil } }
        }
        var seen = Set<String>()
        // (A card of one of several accounts, `claude@…`, is its service's place.)
        self.init(order: (strings("providerOrder") ?? []).map(Self.service(of:)).filter { seen.insert($0).inserted }, placed: strings("placed").map(Set.init))
    }

    /// The panel's own order, where the layout says none (UsageKit's `ProviderCatalog`): the three
    /// it began with, then the rest by name.
    public static let defaultOrder = ["claude", "codex", "cursor", "antigravity", "copilot", "grok", "ollama", "opencode", "openrouter", "zai"]

    /// `services` in the layout's order: those it names first, as it names them, then the rest in the
    /// panel's own order, then any it doesn't know, as given.
    public func ordered(_ services: [String]) -> [String] {
        let rank = Dictionary((order + Self.defaultOrder).enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        let unique = services.filter { seen.insert($0).inserted }
        return unique.enumerated().sorted { (rank[$0.element] ?? Int.max, $0.offset) < (rank[$1.element] ?? Int.max, $1.offset) }.map(\.element)
    }

    /// Whether a card's meter shows (`today`, `last30`, `trend`…): placed on the service's card, or
    /// on one of its accounts' (`claude@1f2e.today`).
    public func shows(_ meter: String, of service: String) -> Bool {
        guard let placed else { return true }
        return placed.contains { id in
            guard id.hasSuffix("." + meter) else { return false }
            return Self.service(of: String(id.dropLast(meter.count + 1))) == service
        }
    }

    /// A card's service: `claude@1f2e` is one of Claude's.
    static func service(of card: String) -> String {
        card.split(separator: "@", maxSplits: 1).first.map(String.init) ?? card
    }
}
