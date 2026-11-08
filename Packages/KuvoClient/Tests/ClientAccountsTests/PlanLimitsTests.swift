import ClientAccounts
import Foundation
import Testing

/// What both apps show of a box's plan limits, from its route's answer as a box sends it.
struct PlanLimitsTests {
    /// `kuvo/agents/api/kuvo/limits`, as a box answers it: two Claude logins, the engine's Copilot,
    /// and a window from a newer box this copy can't read.
    let answer = """
    {"data": {"services": ["claude", "codex", "copilot"], "accounts": [
      {"provider": "claude-code", "service": "claude", "agent": "claude", "account": "default", "plan": "Max 20x", "next": 1794170000000,
       "windows": [
         {"id": "five_hour", "used": 0.42, "minutes": 300, "resetsAt": 1794180000000, "read": 1794160000000, "source": "turn"},
         {"id": "seven_day", "used": 0.18, "minutes": 10080, "resetsAt": 1794600000000, "read": 1794150000000, "source": "turn"},
         {"id": "seven_day_fable", "used": 0.07, "minutes": 10080, "model": "Fable", "resetsAt": 1794600000000, "read": 1794150000000, "source": "turn"},
         {"id": "from_the_future", "used": "a lot"}
       ]},
      {"provider": "claude-code@1f2e3d4c", "service": "claude", "agent": "claude", "account": "1f2e3d4c", "label": "Work",
       "windows": [{"id": "five_hour", "used": 0.9, "minutes": 300, "resetsAt": 1794100000000, "read": 1794090000000, "source": "usage"}],
       "problem": {"kind": "rate-limited", "message": "Anthropic is turning away reads of the plan's limits for now.", "until": 1794173000000}},
      {"provider": "github-copilot", "service": "copilot", "plan": "Individual Pro",
       "windows": [{"id": "premium_interactions", "name": "Premium requests", "used": 0.6, "minutes": 43200, "amount": {"used": 180, "limit": 300, "unit": "requests"}, "read": 1794160000000, "source": "usage"}]},
      {"provider": "openrouter", "service": "openrouter", "windows": [], "balance": {"left": 12.5, "unit": "usd"}}
    ]}}
    """

    let now = Date(timeIntervalSince1970: 1_794_165_000)

    @Test func eachLoginIsARowOfItsOwnByName() throws {
        let limits = try BoxLimits.decode(Data(answer.utf8))
        #expect(limits.services == ["claude", "codex", "copilot"])
        #expect(limits.accounts.map(\.title) == ["Claude", "Claude · Work", "Copilot", "OpenRouter"])
        #expect(limits.accounts[3].balance?.left == 12.5)
    }

    @Test func windowsAreNamedAsTheUsagePanelNamesThem() throws {
        let limits = try BoxLimits.decode(Data(answer.utf8))
        // The one this copy can't read is left out, not the account.
        #expect(limits.accounts[0].windows.map(\.title) == ["Session", "Weekly", "Fable"])
        #expect(limits.accounts[2].windows.map(\.title) == ["Premium requests"])
        #expect(limits.accounts[2].windows[0].amount?.limit == 300)
    }

    @Test func aWindowThatStartedOverSinceIsNotShownAsUsed() throws {
        let limits = try BoxLimits.decode(Data(answer.utf8))
        // Work's session reset after it was read: what's used now isn't known.
        #expect(limits.accounts[1].windows(at: now).isEmpty)
        #expect(limits.accounts[1].tightest(at: now) == nil)
        #expect(limits.accounts[1].problem?.kind == "rate-limited")
        #expect(limits.accounts[0].tightest(at: now)?.id == "five_hour")
        // As of its oldest window shown; out of date once that's over half an hour.
        #expect(limits.accounts[0].readAt(now: now) == Date(timeIntervalSince1970: 1_794_150_000))
        #expect(limits.accounts[0].isOutdated(now: now))
        #expect(!limits.accounts[0].isOutdated(now: Date(timeIntervalSince1970: 1_794_151_000)))
    }

    @Test func theEventCarriesTheAccountsAlone() throws {
        let event = #"{"accounts": [{"provider": "codex-cli", "agent": "codex", "windows": []}]}"#
        let limits = try BoxLimits.decode(Data(event.utf8))
        #expect(limits.accounts.map(\.title) == ["Codex"])
        // (A box from before it said what service an account is: its agent.)
        #expect(limits.accounts[0].service == "codex")
        #expect(limits.services.isEmpty)
    }
}
