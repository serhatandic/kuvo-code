import Foundation

/// One provider's plan limits as the tracker last read them, for the host to show beside a session.
/// (Fork addition.)
public struct PlanLimits: Sendable, Hashable {
    public struct Limit: Sendable, Hashable, Identifiable {
        public var id: String { label }
        /// "Session", "Weekly", "Premium requests", …
        public let label: String
        /// How much is used, from 0 to 1.
        public let fraction: Double
        public let resetsAt: Date?
    }

    public let providerName: String
    public let plan: String?
    public let limits: [Limit]

    /// The snapshot's bounded rows, in the provider's order; `nil` for a failed read or one
    /// without limits.
    init?(_ snapshot: ProviderSnapshot, now: Date = .now) {
        guard snapshot.errorCategory == nil else { return nil }
        // Not a reading from before refreshes stopped (a login that ran out, days offline) shown
        // as now's: the panel calls it Outdated from the same age.
        guard now.timeIntervalSince(snapshot.refreshedAt) < RefreshSetting.interval * 2 else { return nil }
        let limits = snapshot.lines.compactMap { line -> Limit? in
            guard case .progress(let label, let used, let limit, _, let resetsAt, _, _) = line, limit > 0 else { return nil }
            // Its window ended since: it started over, at an amount not read yet.
            if let resetsAt, resetsAt <= now { return nil }
            return Limit(label: label, fraction: min(max(used / limit, 0), 1), resetsAt: resetsAt)
        }
        guard !limits.isEmpty else { return nil }
        providerName = snapshot.displayName
        plan = snapshot.plan
        self.limits = limits
    }
}

extension UsageMenuBar {
    /// The latest limits for a tracker provider (`codex`, `copilot`, …), without fetching anything:
    /// `nil` while the tracker isn't running, the provider is off, or it has no reading yet.
    /// Reading it in a view's body keeps the view current as the tracker refreshes.
    public func planLimits(for providerID: String) -> PlanLimits? {
        guard let container, container.enablement.isEnabled(providerID),
              let snapshot = container.dataStore.snapshots[providerID] else { return nil }
        return PlanLimits(snapshot)
    }
}

extension UsageMenuBar {
    /// The providers the panel follows and has read, by ID (`claude`, `codex`, …), for the host's
    /// own counts. Empty while the tracker isn't running. (Fork addition.)
    public var trackedProviderIDs: [String] {
        guard let container else { return [] }
        return container.dataStore.snapshots.keys.filter { container.enablement.isEnabled($0) && container.availability.isAvailable($0) }.sorted()
    }
}
