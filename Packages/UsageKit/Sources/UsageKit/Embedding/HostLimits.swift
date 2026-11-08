import Foundation
import Observation

/// Plan limits the host reads itself, one row per login (fork addition): Kuvo Code's boxes read
/// each account's limits with their own sign-ins, and the Bars view draws a bar for each in place
/// of the panel's own row for that provider (`covered`), which it no longer reads live (Claude's).
/// What the panel has of those providers besides (spend, its trend) still counts in the spend bar.
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
    /// When the oldest of its meters was read: shown as "As of …" once that's long ago.
    public var readAt: Date?

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

    public init(id: String, providerID: String, name: String, plan: String? = nil, meters: [Meter], balance: Balance? = nil, notice: String? = nil, readAt: Date? = nil) {
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
        if self.rows != rows { self.rows = rows }
        if self.covered != covered { self.covered = covered }
    }

    public func covers(_ providerID: String) -> Bool {
        covered.contains(ProviderAccountID.family(of: providerID))
    }

    /// What the Bars view lists: each of the panel's providers in its order, those the host covers
    /// as the host's rows for them; then the host's rows for providers the panel doesn't list,
    /// unless you hid that provider.
    func entries(groups: [ProviderGroup], known: (String) -> Provider? = { _ in nil }, isHidden: (String) -> Bool) -> [BarsEntry] {
        var entries: [BarsEntry] = []
        var placed = Set<String>()
        for group in groups {
            let id = group.provider.id
            if covers(id) {
                for row in rows where ProviderAccountID.family(of: row.providerID) == ProviderAccountID.family(of: id) && !placed.contains(row.id) {
                    entries.append(.host(row, group.provider))
                    placed.insert(row.id)
                }
            } else {
                entries.append(.group(group))
            }
        }
        for row in rows where !placed.contains(row.id) && !isHidden(row.providerID) {
            entries.append(.host(row, known(row.providerID) ?? HostLimits.provider(for: row.providerID)))
        }
        return entries
    }

    /// A plain provider, for a service the panel doesn't know: its mark and color by its ID.
    static func provider(for id: String) -> Provider {
        Provider(id: id, displayName: id.prefix(1).uppercased() + id.dropFirst(), icon: .providerMark(id))
    }
}

/// A bar in the Bars view: one of the panel's providers, or one of the host's rows.
enum BarsEntry: Identifiable {
    case group(ProviderGroup)
    case host(HostLimitRow, Provider)

    var id: String {
        switch self {
        case .group(let group): group.id
        case .host(let row, _): "host:" + row.id
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

    /// "As of …" once what it shows was read longer ago than the panel calls Outdated.
    static func staleness(_ row: HostLimitRow, now: Date = .now) -> StalenessHint? {
        guard let readAt = row.readAt else { return nil }
        let age = now.timeIntervalSince(readAt)
        guard age >= WidgetDataStore.stalenessThreshold, let duration = Formatters.compactDuration(age) else { return nil }
        let when = readAt.formatted(date: Calendar.current.isDate(readAt, inSameDayAs: now) ? .omitted : .abbreviated, time: .shortened)
        return StalenessHint(label: "As of \(when)", tooltip: "Last read \(duration) ago")
    }
}
