import ClientAccounts
import Foundation
import OpenCodeKit
import Testing

/// What both apps show of a service's spend from a box's answer (`kuvo/agents/api/kuvo/usage?zone=`,
/// PROTOCOL.md "Usage history"): Today, Yesterday and Last 30 Days in the answer's zone, a trend of
/// tokens a day, and nothing at all (never $0) for what wasn't used or couldn't be read; the cards in
/// the order your computers keep (PROTOCOL.md "Usage settings").
struct UsageSpendTests {
    struct Envelope: Decodable { var data: BoxUsage }

    /// 2026-11-14 at 01:30 in Istanbul: still the 13th in UTC.
    let now = Date(timeIntervalSince1970: 1_794_609_000)
    /// 2026-11-14 at 05:00 in UTC and 08:00 in Istanbul: still the 13th in Pago Pago (UTC−11).
    let early = Date(timeIntervalSince1970: 1_794_632_400)

    func usage(_ json: String) throws -> BoxUsage {
        try JSONDecoder().decode(Envelope.self, from: Data(json.utf8)).data
    }

    /// The answer's zone, not this computer's: in Pago Pago it's still the 13th.
    @Test func todayYesterdayAndTheLast30DaysAreTheAnswersDaysInItsZone() throws {
        let usage = try usage("""
        {"data": {"zone": "Pacific/Pago_Pago", "services": ["claude", "codex"], "rows": [
          {"id": "claude#a", "service": "claude", "provider": "claude-code", "boxes": [], "days": []}],
         "totals": {"claude": [
           {"date": "2026-11-14", "tokens": 7, "cost": 7, "models": []},
           {"date": "2026-11-13", "tokens": 1200000, "cost": 4.82, "models": []},
           {"date": "2026-11-12", "tokens": 300, "cost": 0.5, "models": [], "unknown": ["mystery-9"]},
           {"date": "2026-10-19", "tokens": 500, "cost": 1, "models": []},
           {"date": "2026-10-13", "tokens": 999, "cost": 99, "models": []}
         ]}}}
        """)
        let spend = try #require(UsageSpend(service: "claude", of: usage, now: early))
        #expect(spend.periods.map(\.title) == ["Today", "Yesterday", "Last 30 Days"])
        #expect(spend.periods.map { ($0.cost * 100).rounded() / 100 } == [4.82, 0.5, 6.32])
        // (A day not yet come there, and one the box told before midnight passed, 31 days back now, aren't counted.)
        #expect(spend.periods.map(\.tokens) == [1_200_000, 300, 1_200_800])
        #expect(spend.periods.map(\.unknown) == [[], ["mystery-9"], ["mystery-9"]])
        #expect(spend.estimated)
        // One point a day, the oldest first, today last.
        #expect(spend.trend.count == 31)
        #expect(spend.trend.first?.date == "2026-10-14")
        #expect(spend.trend.last == UsageSpend.TrendDay(date: "2026-11-13", tokens: 1_200_000))
        // A service the box doesn't state has none here.
        #expect(UsageSpend(service: "codex", of: usage, now: early) == nil)
        #expect(UsageSpend(service: "grok", of: usage, now: early) == nil)
    }

    /// Nothing used is no tile, never "$0.00 · 0 tokens": a day the box knows nothing of and a day
    /// with nothing in it look alike.
    @Test func aPeriodWithNothingUsedHasNoTileAndNothingUsedAtAllIsNoSpend() throws {
        let quiet = try usage("""
        {"data": {"zone": "Europe/Istanbul", "services": ["claude"], "rows": [], "totals": {"claude": [
          {"date": "2026-11-14", "tokens": 0, "cost": 0, "models": []},
          {"date": "2026-11-12", "tokens": 10, "cost": 0.01, "models": []}
        ]}}}
        """)
        let spend = try #require(UsageSpend(service: "claude", of: quiet, now: now))
        #expect(spend.periods.map(\.id) == ["last30"])
        let none = try usage("""
        {"data": {"zone": "Europe/Istanbul", "services": ["claude"], "rows": [], "totals": {"claude": [{"date": "2026-11-14", "tokens": 0, "cost": 0, "models": []}]}}}
        """)
        #expect(UsageSpend(service: "claude", of: none, now: now) == nil)
    }

    /// OpenCode's hosted models are billed, not estimated: only where every account of the service says so.
    @Test func billedSpendIsntMarkedAnEstimate() throws {
        let usage = try usage("""
        {"data": {"zone": "UTC", "services": ["opencode", "grok"], "rows": [
          {"id": "opencode#go", "service": "opencode", "provider": "opencode-go", "estimated": false, "boxes": [], "days": []},
          {"id": "opencode#zen", "service": "opencode", "provider": "opencode", "estimated": false, "boxes": [], "days": []},
          {"id": "grok#g", "service": "grok", "provider": "grok-cli", "boxes": [], "days": []}],
         "totals": {"opencode": [{"date": "2026-11-13", "tokens": 5, "cost": 2, "models": []}],
                    "grok": [{"date": "2026-11-13", "tokens": 5, "cost": 2, "models": []}]}}}
        """)
        #expect(UsageSpend(service: "opencode", of: usage, now: now)?.estimated == false)
        #expect(UsageSpend(service: "grok", of: usage, now: now)?.estimated == true)
    }

    /// The cards in the order your computers keep (a card of one of several accounts is its
    /// service's place), the rest in the panel's own; the meters shown, all of them while the layout
    /// was never set.
    @Test func theCardsGoInTheLayoutsOrderAndShowItsMeters() throws {
        let settings = try JSONDecoder().decode(BoxUsageSettings.self, from: Data("""
        {"settings": {"layout": {"providerOrder": ["codex", "claude@1f2e", "claude", "openrouter"],
          "placed": ["claude@1f2e.today", "codex.last30", "codex.trend"]}}, "versions": {}, "imported": true}
        """.utf8))
        let layout = UsageLayout(settings)
        #expect(layout.ordered(["grok", "claude", "mystery", "openrouter", "codex", "cursor"]) == ["codex", "claude", "openrouter", "cursor", "grok", "mystery"])
        #expect(layout.shows("today", of: "claude"))
        #expect(!layout.shows("yesterday", of: "claude"))
        #expect(layout.shows("trend", of: "codex"))
        #expect(!layout.shows("trend", of: "claude"))
        let unset = UsageLayout(nil)
        #expect(unset.ordered(["grok", "claude", "codex"]) == ["claude", "codex", "grok"])
        #expect(unset.shows("yesterday", of: "claude"))
    }
}
