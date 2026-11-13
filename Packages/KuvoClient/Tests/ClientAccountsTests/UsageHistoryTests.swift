import ClientAccounts
import Foundation
import Testing

/// What both apps draw of what your accounts used, from a box's answer as it sends it
/// (`kuvo/agents/api/kuvo/usage?zone=`, PROTOCOL.md "Usage history").
struct UsageHistoryTests {
    /// Two Claude accounts, one on two computers; a row and a model from a newer box this copy can't read.
    let answer = """
    {"data": {"zone": "Europe/Istanbul", "services": ["claude"], "scanned": 1794484800000,
      "rows": [
        {"id": "claude#aaaaaaaaaaaaaaaa", "service": "claude", "provider": "claude-code", "agent": "claude", "account": "default",
         "identity": "aaaaaaaaaaaaaaaa", "scanned": 1794484800000,
         "boxes": [{"key": "mac", "name": "MacBook", "provider": "claude-code", "here": true}, {"key": "dev", "name": "devbox", "provider": "claude-code", "away": true}],
         "days": [
           {"date": "2026-11-12", "tokens": 1300, "cost": 0.0065, "models": [{"model": "claude-opus-4-5", "tokens": 1300, "cost": 0.0065}, {"model": 7}]},
           {"date": "2026-11-11", "tokens": 0, "cost": 0, "models": [], "unknown": ["mystery-model-9"]}
         ]},
        {"id": "claude#bbbbbbbbbbbbbbbb", "service": "claude", "provider": "claude-code@1f2e3d4c", "label": "Work", "away": true, "boxes": [],
         "days": [{"date": "2026-11-12", "tokens": 7, "cost": 0.000035, "models": [{"model": "claude-opus-4-5", "tokens": 7, "cost": 0.000035}]}]},
        {"id": 42}
      ],
      "totals": {"claude": [
        {"date": "2026-11-12", "tokens": 1307, "cost": 0.006535, "models": [{"model": "claude-opus-4-5", "tokens": 1307, "cost": 0.006535}]},
        {"date": "2026-11-11", "tokens": 0, "cost": 0, "models": [], "unknown": ["mystery-model-9"]}
      ]},
      "partial": {"claude": {"away": true}}
    }}
    """

    @Test func aBoxsAnswerReadsWhatItCanAndLeavesOutWhatItCant() throws {
        struct Envelope: Decodable { var data: BoxUsage }
        let usage = try JSONDecoder().decode(Envelope.self, from: Data(answer.utf8)).data
        #expect(usage.zone == "Europe/Istanbul")
        #expect(usage.services == ["claude"])
        #expect(usage.rows.map(\.id) == ["claude#aaaaaaaaaaaaaaaa", "claude#bbbbbbbbbbbbbbbb"])
        #expect(usage.rows[0].days[0].models == [BoxUsage.Model(model: "claude-opus-4-5", tokens: 1300, cost: 0.0065)])
        #expect(usage.rows[0].days[1].unknown == ["mystery-model-9"])
        #expect(usage.rows[1].label == "Work")
        #expect(usage.rows[1].away)
        #expect(!usage.rows[0].away)
        #expect(usage.totals["claude"]?.map(\.tokens) == [1307, 0])
        #expect(usage.partial["claude"]?.away == true)
        #expect(usage.partial["claude"]?.cut == false)
    }

    /// Codex's days, a model estimated at the fallback model's rates, and the box's choice of it.
    @Test func codexsFallbackEstimatesAndTheBoxsChoiceOfIt() throws {
        struct Envelope: Decodable { var data: BoxUsage }
        let answer = """
        {"data": {"zone": "UTC", "services": ["claude", "codex"], "rows": [],
          "totals": {"codex": [{"date": "2026-11-12", "tokens": 1100, "cost": 0.0085, "models": [{"model": "gpt-mystery-9", "tokens": 1100, "cost": 0.0085}], "unknown": ["gpt-mystery-9"], "fallback": ["gpt-5.5"]}]},
          "pricing": {"codex": {"fallback": "gpt-5.5", "chosen": true, "choices": ["gpt-6-astra", "gpt-5.5"]}}
        }}
        """
        let usage = try JSONDecoder().decode(Envelope.self, from: Data(answer.utf8)).data
        #expect(usage.services == ["claude", "codex"])
        #expect(usage.totals["codex"]?.first?.fallback == ["gpt-5.5"])
        #expect(usage.totals["codex"]?.first?.unknown == ["gpt-mystery-9"])
        #expect(usage.codexFallback?.model == "gpt-5.5")
        #expect(usage.codexFallback?.choices == ["gpt-6-astra", "gpt-5.5"])
        #expect(usage.codexFallback?.chosen == true)
        // None chosen yet; a box from before says nothing of it.
        let none = try JSONDecoder().decode(Envelope.self, from: Data(#"{"data": {"services": ["claude", "codex"], "pricing": {"codex": {"fallback": null, "chosen": false, "choices": []}}}}"#.utf8)).data
        #expect(none.codexFallback?.model == nil)
        #expect(none.codexFallback?.chosen == false)
        #expect(try JSONDecoder().decode(Envelope.self, from: Data(answer.replacingOccurrences(of: "\"pricing\"", with: "\"other\"").utf8)).data.codexFallback == nil)
    }
}
