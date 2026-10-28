import ClientVault
import Foundation
import Testing

/// What both apps read of a computer's vault, from what its box answers: the same answer decodes
/// the same, a bot's own items show as it may use them, a page's sign-ins are its site's, and the
/// activity reads as one sentence each.
@Suite struct VaultTests {
    /// A box's `kuvo/vault` answer, as the box test vectors have one.
    private let answer = Data("""
    {"state":{"made":true,"locked":false,"paused":false,"pausedBots":{"bot_scout":"It tried to use “GitHub” on github.com.evil.example, which isn't one of its sites."},"store":"encrypted","keptDays":365},
     "items":[
      {"id":"v_aaaaaaaaaa","kind":"login","name":"GitHub","sites":["github.com"],"username":"ship-bot","fields":["password"],"created":1793200000000,"changed":1793200000000,"used":1793210000000},
      {"id":"v_bbbbbbbbbb","kind":"file","name":"App Store Connect key","sites":[],"fields":["file"],"fileName":"AuthKey_ABC123.p8","created":1793200000000,"changed":1793200000000},
      {"id":"v_cccccccccc","kind":"note","name":"App Review contact","sites":[],"fields":["text"],"readable":true,"created":1793200000000,"changed":1793200000000}],
     "grants":[
      {"item":"v_aaaaaaaaaa","who":{"bot":"bot_ship"},"how":"own","at":1793200000000},
      {"item":"v_bbbbbbbbbb","who":{"bot":"bot_ship"},"how":"ask","at":1793200000000},
      {"item":"v_cccccccccc","who":{"everyone":true},"how":"own","at":1793200000000}]}
    """.utf8)

    @Test func aBotsItemsAreItsOwnGrantsAndEveryones() throws {
        let vault = try JSONDecoder().decode(Vault.self, from: answer)
        #expect(vault.state.pausedBots["bot_scout"]?.contains("evil") == true)
        let ship = vault.items(of: "bot_ship").map { "\($0.item.name): \($0.how.rawValue)" }
        #expect(ship == ["GitHub: own", "App Store Connect key: ask", "App Review contact: own"])
        #expect(vault.items(of: "bot_scout").map(\.item.name) == ["App Review contact"], "everyone's, and nothing of Ship's")
    }

    @Test func aPagesSignInsAreItsSitesAndThoseUnderIt() throws {
        let vault = try JSONDecoder().decode(Vault.self, from: answer)
        #expect(vault.signIns(for: "gist.github.com").map(\.name) == ["GitHub"])
        #expect(vault.signIns(for: "github.com.evil.example").isEmpty)
        #expect(vault.items[0].subtitle == "ship-bot · github.com")
        #expect(vault.items[1].subtitle == "AuthKey_ABC123.p8")
    }

    @Test func activityReadsAsASentenceAndNeverHoldsAValue() {
        let refused = VaultActivity(id: "a_1", at: 1_793_210_000_000, what: "refused", itemName: "GitHub", botName: "Ship", site: "github.com.evil.example", how: "wrong site")
        #expect(refused.sentence == "Refused “GitHub” on github.com.evil.example: not one of its sites. Ship was paused")
        #expect(refused.isWarning)
        #expect(VaultActivity(id: "a_2", at: 0, what: "used", itemName: "App Store Connect key", botName: "Ship", program: "xcodebuild", how: "once").sentence == "Ship used “App Store Connect key” with xcodebuild, allowed once")
        #expect(VaultActivity(id: "a_3", at: 0, what: "added", itemName: "GitHub", client: "Mac").sentence == "You, on Mac, added “GitHub”")
        #expect(!VaultActivity(id: "a_4", at: 0, what: "refused", itemName: "GitHub", botName: "Scout", how: "no grant").isWarning)
    }

    @Test func anAsksTitleSaysWhoWantsWhat() {
        #expect(VaultAsk(id: "q_1", kind: .use, botName: "Ship", itemName: "App Store Connect key").title == "Ship wants to use App Store Connect key")
        #expect(VaultAsk(id: "q_2", kind: .item, sessionName: "Fix checkout", need: "a GitHub token").title == "Fix checkout needs a GitHub token")
    }
}
