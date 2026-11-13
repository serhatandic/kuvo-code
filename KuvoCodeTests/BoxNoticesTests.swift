import ClientSessions
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The Mac shows each box's news as the box words it (`kuvo/notices`): the box alone decides what's
/// news (a reply to you, not a bot's wake-up) and says it in a sentence. Each once, none from before
/// this Mac was there, and none of the asks it shows from its own cards. Where a box tells its own,
/// the Mac words none of it itself.
@MainActor
@Suite(.serialized) struct BoxNoticesTests {
    init() {
        TestEnvironment.prepare()
    }

    private func told(_ entries: [(id: String, category: String, body: String)], telling: Bool = true) throws -> BoxNotices.Told {
        let json: [String: Any] = [
            "telling": telling,
            "notices": entries.map { entry in
                ["id": entry.id, "at": 1_792_000_000_000, "notice": ["title": "Fix the tests", "subtitle": "kuvo-ai", "body": entry.body, "category": entry.category, "thread": "ses_main", "data": ["session": "ses_main"]]] as [String: Any]
            },
        ]
        return try JSONDecoder().decode(BoxNotices.Told.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test func eachNewsShowsOnceAndNoneFromBeforeTheMacWasThere() throws {
        let notices = BoxNotices()
        var shown: [String] = []
        notices.show = { notice, _ in shown.append(notice.body ?? "") }
        // What it had as it was first read: news before this Mac was there.
        notices.take(try told([("ntc_old", "finished", "Old news.")]), from: BoxClient.mac)
        #expect(shown.isEmpty)
        #expect(notices.tells(BoxClient.mac))
        // A reply, a failure, a bot's report, a group chat's word: shown, each once.
        let later = try told([("ntc_old", "finished", "Old news."), ("ntc_1", "finished", "All 42 tests pass now."), ("ntc_2", "failed", "Stopped with an error: Rate limited."),
                              ("ntc_3", "report", "I need your Stripe key to go on."), ("ntc_4", "message", "Shipped the fix.")])
        notices.take(later, from: BoxClient.mac)
        notices.take(later, from: BoxClient.mac)
        #expect(shown == ["All 42 tests pass now.", "Stopped with an error: Rate limited.", "I need your Stripe key to go on.", "Shipped the fix."])
    }

    @Test func asksAreLeftToTheirOwnCards() throws {
        let notices = BoxNotices()
        var shown: [String] = []
        notices.show = { notice, _ in shown.append(notice.category.rawValue) }
        notices.take(try told([]), from: "lab")
        notices.take(try told([("ntc_p", "permission", "Wants to run a command: npm test"), ("ntc_q", "question", "Which database?"), ("ntc_a", "ask", "Sign in to GitHub")]), from: "lab")
        #expect(shown.isEmpty)
    }

    @Test func aBoxWhoseBridgeIsntRunningLeavesItsNewsToTheMac() throws {
        let notices = BoxNotices()
        #expect(!notices.tells("lab"))
        notices.take(try told([], telling: false), from: "lab")
        #expect(!notices.tells("lab"))
        notices.take(try told([]), from: "lab")
        #expect(notices.tells("lab"))
    }

    @Test func anEntryThatCantBeReadLeavesTheRest() throws {
        let json = #"{"telling": true, "notices": [{"id": "ntc_bad", "notice": {"category": "finished", "data": {"session": 7}}}, {"id": "ntc_ok", "at": 1, "notice": {"title": "Fix", "body": "Done.", "category": "finished", "data": {"session": "ses_main"}}}]}"#
        let told = try JSONDecoder().decode(BoxNotices.Told.self, from: Data(json.utf8))
        #expect(told.notices.map(\.id) == ["ntc_ok"])
        #expect(told.telling == true)
    }
    @Test func usageIsDeliveredFromFirstReadOnceAcrossBoxesAndRelaunch() async throws {
        let name = "BoxNoticesTests." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let data = Data(#"{"notices":[{"id":"ntc_transport","notice":{"category":"usage","title":"Almost Out","body":"Under 10% usage remaining for this window.","data":{"notice":"usage_stable","row":"claude#hash"}}}]}"#.utf8)
        let answer = try JSONDecoder().decode(BoxNotices.Told.self, from: data)
        let notices = BoxNotices()
        notices.usageDelivery = .init(defaults: defaults)
        var shown: [String] = []
        notices.showUsage = { _, id in shown.append(id); return true }
        let first = notices.take(answer, from: "one")
        let second = notices.take(answer, from: "two")
        await first.value
        await second.value
        #expect(shown == ["usage_stable"])
        let restarted = BoxNotices()
        restarted.usageDelivery = .init(defaults: defaults)
        restarted.showUsage = { _, id in shown.append(id); return true }
        await restarted.take(answer, from: "one").value
        #expect(shown == ["usage_stable"])
    }

}
