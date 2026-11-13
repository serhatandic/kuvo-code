import ClientAccounts
import Foundation
import Testing

/// What a plan has beyond its windows and its resets, as a box states them (#631 E): what both apps
/// draw under a usage row, and what a confirmation says before a reset is used.
struct PlanResetsTests {
    /// A box's rows: Claude (capped extra usage, reset grants usable on hetzner), Codex (credits
    /// left, reset credits here), OpenRouter (credits bought, spend by period), a Mac's Claude token
    /// alone (can't read them), and an extra of a kind from a newer box.
    let answer = """
    {"data": {"services": ["claude", "codex", "openrouter"], "accounts": [], "rows": [
      {"id": "claude#aaaa", "provider": "claude-code", "service": "claude", "agent": "claude", "account": "default", "windows": [],
       "extras": [
         {"id": "extra_usage", "name": "Extra Usage", "kind": "capped", "amount": 12.4, "limit": 50, "unit": "usd", "resetsAt": 1795000000000},
         {"id": "resets", "name": "Rate Limit Resets", "kind": "resets", "count": 2, "expiries": [1794600000000, 1795000000000], "refills": ["five_hour", "seven_day"], "usable": true, "on": {"key": "key-hetzner", "name": "hetzner"}}
       ], "boxes": []},
      {"id": "codex#bbbb", "provider": "codex-cli", "service": "codex", "agent": "codex", "account": "default", "windows": [], "agentsReset": true,
       "extras": [
         {"id": "credits", "name": "Extra Usage", "kind": "left", "amount": 1240, "unit": "credits"},
         {"id": "resets", "name": "Rate Limit Resets", "kind": "resets", "count": 1, "usable": true, "agents": true, "on": {"key": "", "name": "", "here": true}},
         {"id": "tomorrow", "name": "Something new", "kind": "forecast", "chance": 0.4}
       ], "boxes": []},
      {"id": "openrouter#cccc", "provider": "openrouter", "service": "openrouter", "windows": [], "balance": {"left": 7.7, "limit": 50, "unit": "usd"},
       "extras": [
         {"id": "today", "name": "Today", "kind": "spent", "amount": 1.84, "unit": "usd", "resetsAt": 1794700000000},
         {"id": "week", "name": "This Week", "kind": "spent", "amount": 9.2, "unit": "usd"}
       ], "boxes": []},
      {"id": "key-mac/claude-code@w", "provider": "claude-code@w", "service": "claude", "agent": "claude", "account": "w", "windows": [],
       "extras": [{"id": "resets", "name": "Rate Limit Resets", "kind": "unreadable", "message": "This Mac's Claude sign-in can only run Claude."}], "boxes": []}
    ]}}
    """

    @Test func eachKindOfExtraReadsAsTheBoxStatesIt() throws {
        let rows = try #require(try BoxLimits.decode(Data(answer.utf8)).rows)
        let claude = rows[0], codex = rows[1], openrouter = rows[2], mac = rows[3]

        #expect(claude.extras.first?.kind == "capped")
        #expect(claude.extras.first?.amount == 12.4)
        #expect(claude.extras.first?.limit == 50)
        let resets = try #require(claude.resets)
        #expect(resets.count == 2)
        #expect(resets.expiries == [Date(timeIntervalSince1970: 1_794_600_000), Date(timeIntervalSince1970: 1_795_000_000)])
        #expect(resets.refills == ["five_hour", "seven_day"])
        #expect(resets.usable)
        #expect(resets.on == .init(key: "key-hetzner", name: "hetzner", here: false))
        #expect(!resets.agents)

        // A kind a newer box states is left out, not the row.
        #expect(codex.extras.map(\.kind) == ["left", "resets"])
        #expect(codex.extras[0].amount == 1240)
        #expect(codex.extras[0].unit == "credits")
        #expect(codex.resets?.on?.here == true)
        #expect(codex.resets?.agents == true)
        #expect(codex.agentsReset && !claude.agentsReset)

        #expect(openrouter.balance == .init(left: 7.7, limit: 50, unit: "usd"))
        #expect(openrouter.extras.map(\.name) == ["Today", "This Week"])
        #expect(openrouter.resets == nil)

        #expect(mac.resets == nil)
        #expect(mac.extras.first?.kind == "unreadable")
        #expect(mac.extras.first?.message == "This Mac's Claude sign-in can only run Claude.")
    }

    @Test func theOfferAndHowItWentReadAsTheBoxAnswersThem() throws {
        struct Envelope<Value: Decodable>: Decodable { var data: Value }
        let offer = try JSONDecoder().decode(Envelope<ResetOffer>.self, from: Data("""
        {"data": {"confirm": "rsc_1", "row": "claude#aaaa", "service": "claude", "count": 2, "refills": ["five_hour", "seven_day"], "on": {"key": "key-hetzner", "name": "hetzner"}, "always": false, "expires": 1794600000000}}
        """.utf8)).data
        #expect(offer.confirm == "rsc_1")
        #expect(offer.count == 2)
        #expect(!offer.on.here)
        #expect(offer.expires == Date(timeIntervalSince1970: 1_794_600_000))

        let open = try JSONDecoder().decode(Envelope<ResetDone>.self, from: Data(#"{"data": {"outcome": "unconfirmed", "message": "It may still be going through: check again in a minute."}}"#.utf8)).data
        #expect(open.stillOpen && !open.succeeded)
        let done = try JSONDecoder().decode(Envelope<ResetDone>.self, from: Data(#"{"data": {"outcome": "nothing-to-reset", "message": "Nothing to reset: this account isn't at a limit. Nothing was used."}}"#.utf8)).data
        #expect(!done.succeeded)
        #expect(ResetWords.failure(done) == "Nothing to reset: this account isn't at a limit. Nothing was used.")
        #expect(ResetWords.failure(nil) == "Didn't go through. Nothing was used.")
    }

    @Test func theConfirmationSaysWhatItSpendsAndWhatStartsOver() {
        #expect(ResetWords.question(2) == "Use 1 of 2 resets?")
        #expect(ResetWords.question(1) == "Use your last reset?")
        #expect(ResetWords.consequence(["five_hour", "seven_day"]) == "Your 5-hour and weekly limits start over now.")
        #expect(ResetWords.consequence(["five_hour"]) == "Your 5-hour window starts over now.")
        #expect(ResetWords.consequence([]) == "Your usage limits start over now.")
        #expect(ResetWords.usedOn("hetzner") == "Used on hetzner, which has this account's sign-in.")
        #expect(ResetWords.available(2) == "2 available")
    }
}
