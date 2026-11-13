import Foundation
import Observation

/// One day of what a service's accounts used, as the host states it (fork addition): the host's
/// boxes read their accounts' logs, price them and add them up across its computers (PROTOCOL.md,
/// "Usage history"), in the host's time zone.
public struct HostHistoryDay: Sendable, Hashable {
    /// `yyyy-MM-dd`, a calendar day where the host is.
    public var date: String
    public var models: [Model]
    /// Models used that day that couldn't be priced (counted nowhere).
    public var unknown: [String]

    public struct Model: Sendable, Hashable {
        public var name: String
        public var tokens: Int
        public var cost: Double

        public init(name: String, tokens: Int, cost: Double) {
            self.name = name
            self.tokens = tokens
            self.cost = cost
        }
    }

    public init(date: String, models: [Model], unknown: [String] = []) {
        self.date = date
        self.models = models
        self.unknown = unknown
    }
}

/// The usage history the host states itself (fork addition): for each provider family it covers
/// (`claude`, `grok`, `opencode`), its days take the place of what the provider would read from the logs on this Mac,
/// so the spend tiles, the trend and the model breakdown show the host's (every account it runs,
/// on every computer of yours), and nothing is read twice. A provider it doesn't cover reads its
/// logs as before.
@MainActor
@Observable
public final class HostHistory {
    public static let shared = HostHistory()

    /// The provider families whose history the host states.
    public private(set) var covered: Set<String> = []
    /// Each covered family's days, newest first.
    public private(set) var days: [String: [HostHistoryDay]] = [:]
    /// Whether the host has said them since launch (until then, what the cards last had stays).
    private var answered = false
    /// When the host last said them, and whether it isn't answering now (its days are as of then).
    public private(set) var asOf: Date?
    public private(set) var away = false
    /// Has the host's boxes read their logs again now (the panel's Refresh).
    @ObservationIgnored public var refresh: (() -> Void)?

    /// `answered`: what the host said (else what it last said, kept from before, while it starts).
    public func update(days: [String: [HostHistoryDay]], covered: Set<String>, answered: Bool = true, now: Date = .now) {
        if answered { asOf = now }
        guard days != self.days || covered != self.covered || answered != self.answered || (answered && away) else { return }
        if answered { away = false }
        self.answered = answered
        let touched = Set(self.days.keys).union(days.keys).union(self.covered).union(covered)
        self.days = days
        self.covered = covered
        // Its cards read again, with the host's days in place of their own: those whose limits come
        // from the host too, so nothing is asked of a maker for it. The rest take them at their next
        // refresh.
        let quiet = touched.filter { HostLimits.limitsOnlyFromHost.contains($0) && HostLimits.shared.covers($0) }
        UsageMenuBar.shared.refresh(providerIDs: quiet.sorted())
    }

    /// The host stopped answering (its days stay, as of when it last did), or answers again.
    public func setAway(_ away: Bool) {
        guard away != self.away else { return }
        self.away = away
        let quiet = covered.filter { HostLimits.limitsOnlyFromHost.contains($0) && HostLimits.shared.covers($0) }
        UsageMenuBar.shared.refresh(providerIDs: quiet.sorted())
    }

    /// What a covered card's history note adds while the host isn't answering: "as of 14:05".
    func asOfNote(for providerID: String) -> String? {
        guard away, let asOf, covered.contains(ProviderAccountID.family(of: providerID)) else { return nil }
        return "as of \(asOf.formatted(date: Calendar.current.isDateInToday(asOf) ? .omitted : .abbreviated, time: .shortened))"
    }

    /// A covered provider's history as the panel's own scan of its logs would have been, or nil for
    /// one the host doesn't cover. Only its main card (`claude`, `grok`, `opencode`) takes the host's days, once the
    /// host has answered (until then nil inside: what it last showed stays); its cards for other
    /// logins of yours show none (an empty history, so what they had before goes). Every account
    /// the host runs is in the main card's: none is counted on two cards.
    func scan(for providerID: String) -> LogUsageScan?? {
        let family = ProviderAccountID.family(of: providerID)
        guard covered.contains(family) else { return nil }
        guard providerID == family else { return .some(Self.scan([])) }
        guard answered else { return .some(nil) }
        return .some(Self.scan(days[family] ?? []))
    }

    static func scan(_ days: [HostHistoryDay]) -> LogUsageScan {
        var accumulator = DailyUsageAccumulator()
        for day in days {
            for model in day.models {
                accumulator.add(day: day.date, tokens: model.tokens, cost: model.cost, model: model.name)
            }
            for model in day.unknown {
                accumulator.addUnknownModel(day: day.date, model: model)
            }
        }
        return accumulator.build()
    }
}
