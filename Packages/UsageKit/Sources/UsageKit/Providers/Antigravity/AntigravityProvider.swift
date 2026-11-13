import Foundation

/// Antigravity is read by each box with its own Kuvo Code sign-in. This card only draws it.
@MainActor
final class AntigravityProvider: ProviderRuntime {
    let provider = Provider(id: "antigravity", displayName: "Antigravity", icon: .providerMark("antigravity"))
    private static let usageSourceNote = "From your Antigravity conversations (estimated)"

    var widgetDescriptors: [WidgetDescriptor] {
        [
            .percent(id: AntigravityMetric.geminiID, provider: provider, title: AntigravityMetric.sessionLabel, sessionStartSignal: .zeroUsage)
                .exportingLimit("geminiSession", unit: "percent"),
            .percent(id: AntigravityMetric.geminiWeeklyID, provider: provider, title: AntigravityMetric.weeklyLabel)
                .exportingLimit("geminiWeekly", unit: "percent"),
            .percent(id: AntigravityMetric.argonWeeklyID, provider: provider, title: AntigravityMetric.argonWeeklyLabel)
                .exportingLimit("argonWeekly", unit: "percent"),
            .percent(id: AntigravityMetric.claudeID, provider: provider, title: AntigravityMetric.claudeLabel, sessionStartSignal: .zeroUsage)
                .exportingLimit("nonGeminiSession", unit: "percent"),
            .percent(id: AntigravityMetric.claudeWeeklyID, provider: provider, title: AntigravityMetric.claudeWeeklyLabel)
                .exportingLimit("nonGeminiWeekly", unit: "percent"),
            .usageTrend(provider: provider)
                .exportingHistory(
                    scope: .machineLocal,
                    estimatedCost: true,
                    sourceNote: Self.usageSourceNote
                )
        ] + WidgetDescriptor.spendTiles(provider: provider)
    }

    func hasLocalCredentials() async -> Bool {
        HostLimits.shared.rows.contains { ProviderAccountID.family(of: $0.providerID) == "antigravity" }
            || !(HostHistory.shared.days["antigravity"] ?? []).isEmpty
    }

    func refresh() async -> ProviderSnapshot {
        let now = Date.now
        var lines: [MetricLine] = []
        var history: ProviderUsageHistory?
        if let hosted = HostHistory.shared.scan(for: provider.id), let scan = hosted {
            var note = Self.usageSourceNote
            if let asOf = HostHistory.shared.asOfNote(for: provider.id) { note += ", \(asOf)" }
            history = ProviderUsageHistory(series: scan.series, modelUsage: scan.modelUsage, unknownModelsByDay: scan.unknownModelsByDay)
            SpendTileMapper.appendTokenUsage(scan.series, to: &lines, now: now,
                unknownModelsByDay: scan.unknownModelsByDay, modelUsage: scan.modelUsage, modelSourceNote: note)
            SpendTileMapper.appendUsageTrend(scan.series, to: &lines, now: now, note: note)
        }
        return ProviderSnapshot.make(provider: provider, plan: nil, lines: lines, refreshedAt: now, usageHistory: history)
    }
}
