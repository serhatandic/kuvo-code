import Foundation
import Observation

/// Plan limits the host reads itself, one row per account (fork addition): Kuvo Code's boxes read
/// each account's limits with their own sign-ins, the host lists each account once however many
/// of them have it, and the Bars view draws a bar for each in place
/// of the panel's own bar for that provider (`covered`), with the provider's spend and trend under
/// the first. The panel doesn't read a covered Claude's limits itself: its reading takes this
/// Mac's own login's from the host (`lines(for:)`), for the menu bar, the cards and its notices.
public struct HostLimitRow: Sendable, Hashable, Identifiable {
    /// Unique across the host's rows (the account, or its box and the account there).
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
    /// One of its boxes is this Mac's (its own logins are the panel's own provider's).
    public var isLocal: Bool
    /// The computers it's from where none is this Mac ("hetzner, lokum"): added to its name where
    /// the panel shows a bar of that name of its own (its card for a provider this Mac has no row
    /// of yet).
    public var place: String?
    /// It's the agent's own sign-in on this Mac (not one you added): the panel's own card for the
    /// provider takes its numbers.
    public var isOwnLogin: Bool
    /// Every computer it's on hasn't been heard from for a while: what it shows is as of `readAt`
    /// however recent, never live.
    public var isAway: Bool

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

    public init(id: String, providerID: String, name: String, plan: String? = nil, meters: [Meter], balance: Balance? = nil, notice: String? = nil, readAt: Date? = nil, isLocal: Bool = true, isOwnLogin: Bool = false, place: String? = nil, isAway: Bool = false) {
        self.isLocal = isLocal
        self.isAway = isAway
        self.place = place
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
        let changed = self.rows != rows || self.covered != covered
        if self.rows != rows { self.rows = rows }
        if self.covered != covered { self.covered = covered }
        // The panel's readings of covered providers take the host's numbers as they're shown: drawn
        // again (nothing is asked of any maker).
        if changed { onChange?() }
    }

    /// Claude's bar while this Mac's box has none of its own login's limits yet: a Mac's box hears
    /// them only as Claude runs in Kuvo Code (no read of Anthropic, nor of your own sign-in).
    public static let waitingForClaude = "Its limits show once Claude has had a turn in Kuvo Code."

    /// Told when the rows change: the panel draws its readings again with them.
    @ObservationIgnored var onChange: (() -> Void)?

    /// How old the host's numbers may be before a reading leaves them out and its bar says "As of":
    /// longer than a box leaves between reads (10 to 15 minutes), as the phone says it too
    /// (KuvoClient's `LimitsAccount.outdatedAfter`).
    static let outdated: TimeInterval = 30 * 60

    /// This Mac's own login's row for a covered provider (Claude's agent's own sign-in, the engine's
    /// sign-in for its others): the panel's own card of it takes its numbers.
    func ownRow(for providerID: String) -> HostLimitRow? {
        let family = ProviderAccountID.family(of: providerID)
        guard providerID == family, covers(family) else { return nil }
        return rows.first { $0.isOwnLogin && ProviderAccountID.family(of: $0.providerID) == family }
    }

    /// A covered provider's limits as the panel's own lines, from this Mac's own login's row; nil
    /// with none, or none read in the last half hour.
    func lines(for providerID: String, now: Date = .now) -> (lines: [MetricLine], plan: String?, readAt: Date?, notice: String?)? {
        guard let row = ownRow(for: providerID) else { return nil }
        if let readAt = row.readAt, now.timeIntervalSince(readAt) > Self.outdated { return nil }
        let lines: [MetricLine] = row.meters.compactMap { meter in
            if let resetsAt = meter.resetsAt, resetsAt <= now { return nil }
            if let count = meter.count, count.limit > 0 {
                return .progress(label: meter.title, used: count.used, limit: count.limit,
                                 format: count.unit == "usd" ? .dollars : .count(suffix: count.unit), resetsAt: meter.resetsAt, periodDurationMs: meter.periodMinutes.map { $0 * 60_000 })
            }
            return .progress(label: meter.title, used: ProviderParse.clampPercent(meter.fraction * 100), limit: 100, format: .percent,
                             resetsAt: meter.resetsAt, periodDurationMs: meter.periodMinutes.map { $0 * 60_000 })
        }
        return (lines, row.plan, row.readAt, row.notice)
    }

    /// The panel's readings with the host's numbers for each covered provider (fork addition): its
    /// own limit lines give way to this Mac's own login's, read by its box, so the menu bar, the
    /// cards, notices and the host's own readers show what the bars do. What else it has (spend,
    /// its trend) stays.
    func applied(to snapshots: [String: ProviderSnapshot], now: Date = .now) -> [String: ProviderSnapshot] {
        guard !covered.isEmpty else { return snapshots }
        var result = snapshots
        for (id, snapshot) in snapshots {
            guard let host = lines(for: id, now: now) else { continue }
            var applied = snapshot
            applied.lines = host.lines + snapshot.lines.filter { if case .progress = $0 { false } else { true } }
            applied.plan = host.plan ?? snapshot.plan
            applied.warning = host.notice
            applied.errorCategory = nil
            result[id] = applied
        }
        return result
    }

    public func covers(_ providerID: String) -> Bool {
        covered.contains(ProviderAccountID.family(of: providerID))
    }

    /// What the Bars view lists: each of the panel's providers in its order, one the host covers as
    /// the rows this Mac has a share in when it has them (the first with the provider's spend under
    /// it), then the rest; then the host's rows for providers the panel doesn't list, unless you
    /// hid that provider. Where this Mac has none yet and the panel's own bar has no limits to show
    /// (`limitsOnlyFromHost`), the other computers' rows take its place as this Mac's would. A row
    /// beside a bar of the panel's own of its name says where it's from.
    func entries(groups: [ProviderGroup], known: (String) -> Provider? = { _ in nil }, isHidden: (String) -> Bool) -> [BarsEntry] {
        var entries: [BarsEntry] = []
        var placed = Set<String>()
        var shown = Set<String>()
        let host = { (row: HostLimitRow, provider: Provider, spend: ProviderGroup?) -> BarsEntry in
            var row = row
            if let place = row.place, shown.contains(row.name) { row.name += " · \(place)" }
            shown.insert(row.name)
            return .host(row, provider, spend: spend)
        }
        for group in groups {
            let family = ProviderAccountID.family(of: group.provider.id)
            guard !placed.contains(family + "|") else { continue }
            let mine = rows.filter { ProviderAccountID.family(of: $0.providerID) == family }
            let first = takingPlace(of: family)
            // This Mac's own logins in place of the panel's bar, its spend under the first; with
            // none from this Mac's box yet, the panel's own bar, as it was. Then the machines'.
            if covers(family), !first.isEmpty, !isHidden(family) {
                for (index, row) in first.enumerated() { entries.append(host(row, group.provider, index == 0 ? group : nil)) }
                placed.insert(family + "|")
            } else {
                entries.append(.group(group))
                shown.insert(group.provider.displayName)
                if !covers(family) { continue }
            }
            placed.insert(family + "|")
            let taken = Set(first.map(\.id))
            for row in mine where !row.isLocal && !taken.contains(row.id) && !isHidden(family) { entries.append(host(row, group.provider, nil)) }
            placed.formUnion(mine.map(\.id))
        }
        for row in rows where !placed.contains(row.id) && !isHidden(row.providerID) {
            entries.append(host(row, known(row.providerID) ?? HostLimits.provider(for: row.providerID), nil))
        }
        return entries
    }

    /// The panel's providers whose own bar reads no limits while the host covers them, so it's only
    /// the provider's spend: Claude's (`ClaudeProvider` leaves them to this Mac's box, by this).
    /// Every other provider's bar reads its own limits (yours, outside Kuvo Code) until this Mac's
    /// box has a row of it.
    static let limitsOnlyFromHost: Set<String> = ["claude"]

    /// The rows that take the place of the panel's own bar of a covered provider: this Mac's own
    /// logins; with none yet, where its bar has no limits of its own, the other computers' (one row
    /// per account across them, so an account on several is still one row, by its own name).
    private func takingPlace(of family: String) -> [HostLimitRow] {
        let mine = rows.filter { ProviderAccountID.family(of: $0.providerID) == family }
        let local = mine.filter(\.isLocal)
        return local.isEmpty && Self.limitsOnlyFromHost.contains(family) ? mine : local
    }

    /// The panel's own bars a phone gets (`kuvo/usage`), in the Bars view's order: those whose
    /// place the box's rows take, as the Bars view takes them (`takingPlace`), say so (`covers`,
    /// their service), keeping only what the box doesn't state (spend, its trend), which the phone
    /// shows under the first of those rows, where they go.
    func phoneGroups(_ groups: [ProviderGroup]) -> [(group: ProviderGroup, covers: String?)] {
        var placed = Set<String>()
        return groups.compactMap { group in
            let family = ProviderAccountID.family(of: group.provider.id)
            guard covers(family), !takingPlace(of: family).isEmpty else { return (group, nil) }
            // (One place per service: its other account cards go with it.)
            guard placed.insert(family).inserted else { return nil }
            return (group, family)
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

    /// "As of …" once what it shows was read longer ago than that, or its computers aren't heard from.
    static func staleness(_ row: HostLimitRow, now: Date = .now) -> StalenessHint? {
        guard let readAt = row.readAt else { return nil }
        let age = now.timeIntervalSince(readAt)
        guard age >= HostLimits.outdated || row.isAway, let duration = Formatters.compactDuration(max(age, 60)) else { return nil }
        let when = readAt.formatted(date: Calendar.current.isDate(readAt, inSameDayAs: now) ? .omitted : .abbreviated, time: .shortened)
        return StalenessHint(label: "As of \(when)", tooltip: "Last read \(duration) ago")
    }
}
