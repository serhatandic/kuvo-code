import Foundation
import Observation

/// Plan limits the host reads itself, one row per login (fork addition): Kuvo Code's boxes read
/// each account's limits with their own sign-ins, and the Bars view draws a bar for each in place
/// of the panel's own bar for that provider (`covered`), with the provider's spend and trend under
/// the first. The panel doesn't read a covered Claude's limits itself: its reading takes this
/// Mac's own login's from the host (`lines(for:)`), for the menu bar, the cards and its notices.
public struct HostLimitRow: Sendable, Hashable, Identifiable {
    /// Unique across the host's rows (its box, and the account there).
    public var id: String
    /// The panel's provider whose mark and color it takes (`claude`, `codex`, `copilot`…).
    public var providerID: String
    /// "Claude · Work".
    public var name: String
    public var plan: String?
    public var meters: [Meter]
    /// Credits left, where the account has them (OpenRouter's).
    public var balance: Balance?
    /// Why it couldn't be read just now, in words to show.
    public var notice: String?
    /// When the oldest of its meters was read: shown as "As of …" once that's long ago
    /// (`HostLimitData.outdated`).
    public var readAt: Date?
    /// It's this Mac's own box's (its own logins are the panel's own provider's).
    public var isLocal: Bool
    /// It's the agent's own sign-in on this Mac (not one you added): the panel's own card for the
    /// provider takes its numbers.
    public var isOwnLogin: Bool

    public struct Meter: Sendable, Hashable {
        /// "Session", "Weekly", "Sonnet", "Premium requests".
        public var title: String
        /// How much is used, 0…1.
        public var fraction: Double
        public var resetsAt: Date?
        public var periodMinutes: Int?
        /// A count's or an amount's own numbers (180 of 300 requests), where the limit is one.
        public var count: (used: Double, limit: Double, unit: String)?

        public init(title: String, fraction: Double, resetsAt: Date? = nil, periodMinutes: Int? = nil, count: (used: Double, limit: Double, unit: String)? = nil) {
            self.title = title
            self.fraction = fraction
            self.resetsAt = resetsAt
            self.periodMinutes = periodMinutes
            self.count = count
        }

        public static func == (a: Meter, b: Meter) -> Bool {
            a.title == b.title && a.fraction == b.fraction && a.resetsAt == b.resetsAt && a.periodMinutes == b.periodMinutes
                && a.count?.used == b.count?.used && a.count?.limit == b.count?.limit && a.count?.unit == b.count?.unit
        }

        public func hash(into hasher: inout Hasher) {
            hasher.combine(title)
            hasher.combine(fraction)
            hasher.combine(resetsAt)
        }
    }

    public struct Balance: Sendable, Hashable {
        public var left: Double
        /// `usd` or `credits`.
        public var unit: String

        public init(left: Double, unit: String) {
            self.left = left
            self.unit = unit
        }
    }

    public init(id: String, providerID: String, name: String, plan: String? = nil, meters: [Meter], balance: Balance? = nil, notice: String? = nil, readAt: Date? = nil, isLocal: Bool = true, isOwnLogin: Bool = false) {
        self.isLocal = isLocal
        self.isOwnLogin = isOwnLogin
        self.id = id
        self.providerID = providerID
        self.name = name
        self.plan = plan
        self.meters = meters
        self.balance = balance
        self.notice = notice
        self.readAt = readAt
    }
}

@MainActor
@Observable
public final class HostLimits {
    public static let shared = HostLimits()

    /// The rows, in the host's order.
    public private(set) var rows: [HostLimitRow] = []
    /// The panel's providers whose limits the host states: their own rows give way to the host's.
    public private(set) var covered: Set<String> = []
    /// Reads them again (a bar's Refresh).
    @ObservationIgnored public var refresh: (() -> Void)?

    public func update(rows: [HostLimitRow], covered: Set<String>) {
        let before = ownReading(in: self.rows, covered: self.covered)
        if self.rows != rows { self.rows = rows }
        if self.covered != covered { self.covered = covered }
        // The panel's own Claude reading takes this Mac's own login's numbers: read again when they
        // change (not their read times), which asks no maker anything. (Only Claude's does.)
        if ownReading(in: rows, covered: covered) != before { onLocalChange?(["claude"]) }
    }

    private func ownReading(in rows: [HostLimitRow], covered: Set<String>) -> [String]? {
        guard covered.contains("claude"), let row = rows.first(where: { $0.isOwnLogin && ProviderAccountID.family(of: $0.providerID) == "claude" }) else { return nil }
        return [row.plan ?? "", row.notice ?? ""] + row.meters.map { "\($0.title) \(Int(($0.fraction * 100).rounded())) \($0.resetsAt?.timeIntervalSince1970 ?? 0)" }
    }

    /// Told which covered providers' local rows changed (the panel reads those again).
    @ObservationIgnored var onLocalChange: ((Set<String>) -> Void)?

    /// A covered provider's limits as the panel's own lines, from this Mac's own login's row (its
    /// agent's own sign-in, listed first): nil when the host has none for it.
    func lines(for providerID: String, now: Date = .now) -> (lines: [MetricLine], plan: String?, readAt: Date?, notice: String?)? {
        let family = ProviderAccountID.family(of: providerID)
        guard covers(family), let row = rows.first(where: { $0.isOwnLogin && ProviderAccountID.family(of: $0.providerID) == family }) else { return nil }
        let lines: [MetricLine] = row.meters.compactMap { meter in
            if let resetsAt = meter.resetsAt, resetsAt <= now { return nil }
            return .progress(label: meter.title, used: ProviderParse.clampPercent(meter.fraction * 100), limit: 100, format: .percent,
                             resetsAt: meter.resetsAt, periodDurationMs: meter.periodMinutes.map { $0 * 60_000 })
        }
        return (lines, row.plan, row.readAt, row.notice)
    }

    public func covers(_ providerID: String) -> Bool {
        covered.contains(ProviderAccountID.family(of: providerID))
    }

    /// What the Bars view lists: each of the panel's providers in its order, one the host covers as
    /// this Mac's own logins' rows when it has them (the first with the provider's spend under it),
    /// then the machines'; then the host's rows for providers the panel doesn't list, unless you
    /// hid that provider.
    func entries(groups: [ProviderGroup], known: (String) -> Provider? = { _ in nil }, isHidden: (String) -> Bool) -> [BarsEntry] {
        var entries: [BarsEntry] = []
        var placed = Set<String>()
        for group in groups {
            let family = ProviderAccountID.family(of: group.provider.id)
            guard !placed.contains(family + "|") else { continue }
            let mine = rows.filter { ProviderAccountID.family(of: $0.providerID) == family }
            let local = mine.filter(\.isLocal)
            // This Mac's own logins in place of the panel's bar, its spend under the first; with
            // none from this Mac's box yet, the panel's own bar, as it was. Then the machines'.
            if covers(family), !local.isEmpty, !isHidden(family) {
                for (index, row) in local.enumerated() { entries.append(.host(row, group.provider, spend: index == 0 ? group : nil)) }
                placed.insert(family + "|")
            } else {
                entries.append(.group(group))
                if !covers(family) { continue }
            }
            placed.insert(family + "|")
            for row in mine where !row.isLocal && !isHidden(family) { entries.append(.host(row, group.provider, spend: nil)) }
            placed.formUnion(mine.map(\.id))
        }
        for row in rows where !placed.contains(row.id) && !isHidden(row.providerID) {
            entries.append(.host(row, known(row.providerID) ?? HostLimits.provider(for: row.providerID), spend: nil))
        }
        return entries
    }

    /// The panel's own bars a phone gets (`kuvo/usage`): all but those this Mac's box states rows for.
    func phoneGroups(_ groups: [ProviderGroup]) -> [ProviderGroup] {
        groups.filter { group in
            let family = ProviderAccountID.family(of: group.provider.id)
            return !(covers(family) && rows.contains { $0.isLocal && ProviderAccountID.family(of: $0.providerID) == family })
        }
    }

    /// A plain provider, for a service the panel doesn't know: its mark and color by its ID.
    static func provider(for id: String) -> Provider {
        Provider(id: id, displayName: id.prefix(1).uppercased() + id.dropFirst(), icon: .providerMark(id))
    }
}

/// A bar in the Bars view: one of the panel's providers, or one of the host's rows.
enum BarsEntry: Identifiable {
    case group(ProviderGroup)
    /// A host's row, drawn with its provider's mark; `spend`, the panel's own group of it, whose
    /// spend and trend show under the first.
    case host(HostLimitRow, Provider, spend: ProviderGroup?)

    var id: String {
        switch self {
        case .group(let group): group.id
        case .host(let row, _, _): "host:" + row.id
        }
    }
}

/// A host row as the bars and their detail draw it: each meter as the panel's own rows are, in the
/// panel's meter style and reset display.
@MainActor
enum HostLimitData {
    static func rows(_ row: HostLimitRow, store: WidgetDataStore, now: Date = .now) -> [WidgetData] {
        var rows: [WidgetData] = row.meters.compactMap { meter in
            // Started over since it was read: what's used now isn't known.
            if let resetsAt = meter.resetsAt, resetsAt <= now { return nil }
            var data: WidgetData
            if let count = meter.count, count.limit > 0 {
                let dollars = count.unit == "usd"
                data = WidgetData(title: meter.title, icon: .providerMark(row.providerID), kind: dollars ? .dollars : .count, used: count.used, limit: count.limit,
                                  countSuffix: dollars ? nil : count.unit)
            } else {
                data = WidgetData(title: meter.title, icon: .providerMark(row.providerID), kind: .percent, used: ProviderParse.clampPercent(meter.fraction * 100), limit: 100)
            }
            data.resetsAt = meter.resetsAt
            data.periodDurationMs = meter.periodMinutes.map { $0 * 60_000 }
            data.displayMode = store.meterStyle
            data.resetDisplayMode = store.resetDisplayMode
            data.alwaysShowPacing = store.alwaysShowPacing
            return data
        }
        if let balance = row.balance {
            var data = WidgetData(title: "Credits", icon: .providerMark(row.providerID), kind: balance.unit == "usd" ? .dollars : .count, used: balance.left, limit: nil,
                                  countSuffix: balance.unit == "usd" ? nil : "credits")
            data.unboundedValueWord = "left"
            rows.append(data)
        }
        return rows
    }

    /// How old a box's reading is when it says "As of": longer than the box's own spacing (10 to
    /// 15 minutes), as the phone says it (KuvoClient's `LimitsAccount.outdatedAfter`).
    static let outdated: TimeInterval = 30 * 60

    /// "As of …" once what it shows was read longer ago than that.
    static func staleness(_ row: HostLimitRow, now: Date = .now) -> StalenessHint? {
        guard let readAt = row.readAt else { return nil }
        let age = now.timeIntervalSince(readAt)
        guard age >= outdated, let duration = Formatters.compactDuration(age) else { return nil }
        let when = readAt.formatted(date: Calendar.current.isDate(readAt, inSameDayAs: now) ? .omitted : .abbreviated, time: .shortened)
        return StalenessHint(label: "As of \(when)", tooltip: "Last read \(duration) ago")
    }
}
