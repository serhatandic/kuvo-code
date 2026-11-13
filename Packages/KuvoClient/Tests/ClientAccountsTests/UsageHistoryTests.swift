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
        #expect(usage.rows.map(\.estimated) == [true, true])
    }

    /// Cursor's row: its maker's account of the whole account (its newest computer's, not a sum),
    /// each model with the family it shows under where that isn't its own name.
    @Test func cursorsRowIsAccountWideAndItsModelsSayTheirFamily() throws {
        struct Envelope: Decodable { var data: BoxUsage }
        let answer = """
        {"data": {"zone": "UTC", "services": ["claude", "cursor"], "rows": [
          {"id": "cursor#eeeeeeeeeeeeeeee", "service": "cursor", "provider": "cursor", "accountWide": true, "boxes": [],
           "days": [{"date": "2026-11-12", "tokens": 1100, "cost": 0.75, "models": [{"model": "gpt-6-high-fast", "tokens": 1000, "cost": 0.5, "family": "gpt-6"}, {"model": "gpt-6", "tokens": 100, "cost": 0.25}]}]}
        ], "totals": {}}}
        """
        let usage = try JSONDecoder().decode(Envelope.self, from: Data(answer.utf8)).data
        #expect(usage.rows.map(\.accountWide) == [true])
        #expect(usage.rows[0].days[0].models.map(\.family) == ["gpt-6", nil])
        #expect(try JSONDecoder().decode(Envelope.self, from: Data(self.answer.utf8)).data.rows.map(\.accountWide) == [false, false])
    }

    /// What the engine's hosted models cost, as OpenCode billed it, and Grok's, priced.
    @Test func aBilledRowSaysItsNotAnEstimate() throws {
        struct Envelope: Decodable { var data: BoxUsage }
        let answer = """
        {"data": {"zone": "UTC", "services": ["claude", "grok", "opencode"], "rows": [
          {"id": "opencode#cccccccccccccccc", "service": "opencode", "provider": "opencode-go", "estimated": false, "boxes": [],
           "days": [{"date": "2026-11-12", "tokens": 900, "cost": 0.5, "models": [{"model": "glm-5.2", "tokens": 900, "cost": 0.5}]}]},
          {"id": "grok#dddddddddddddddd", "service": "grok", "provider": "grok-cli", "boxes": [], "days": []}
        ], "totals": {"opencode": [{"date": "2026-11-12", "tokens": 900, "cost": 0.5, "models": [{"model": "glm-5.2", "tokens": 900, "cost": 0.5}]}]}}}
        """
        let usage = try JSONDecoder().decode(Envelope.self, from: Data(answer.utf8)).data
        #expect(usage.services == ["claude", "grok", "opencode"])
        #expect(usage.rows.map(\.estimated) == [false, true])
        #expect(usage.totals["opencode"]?.map(\.cost) == [0.5])
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
