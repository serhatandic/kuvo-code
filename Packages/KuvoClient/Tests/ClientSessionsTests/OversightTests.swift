import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// A bot overseeing its sessions, as both apps show it: which bots oversee a project and which of
/// its sessions, and which of a box's marks (what a bot just did to a session) play, each once.
struct OversightTests {
    private func session(_ id: String, by bot: String? = nil) throws -> Session {
        let metadata = bot.map { #"{"kuvo": {"by": {"bot": "\#($0)", "name": "\#($0.capitalized)"}}}"# } ?? "null"
        let json = #"{"id": "\#(id)", "projectID": "p", "title": "\#(id)", "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "time": {"created": 1, "updated": 2}, "location": {"directory": "/p"}, "metadata": \#(metadata)}"#
        return try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private func marks(_ json: String) throws -> [OversightMark] {
        try JSONDecoder().decode(OversightMarks.self, from: Data(json.utf8)).marks
    }

    @Test func aProjectIsOverseenByEachBotWithSessionsInItAndYourOwnSessionsByNone() throws {
        let overseers = Oversight.overseers(of: [
            try session("ses_core", by: "pixel"), try session("ses_mine"), try session("ses_log", by: "ada"), try session("ses_icons", by: "pixel"),
        ])
        #expect(overseers == [
            Overseer(bot: "pixel", name: "Pixel", sessions: ["ses_core", "ses_icons"]),
            Overseer(bot: "ada", name: "Ada", sessions: ["ses_log"]),
        ])
        #expect(Oversight.overseenBy(overseers.map(\.name)) == "Overseen by Pixel and Ada")
        #expect(Oversight.overseers(of: [try session("ses_mine")]).isEmpty)
    }

    @Test func eachBotKeepsItsPlaceAsItsSessionsTakeTurnsAtTheTop() throws {
        let adaBusy = [try session("ses_log", by: "ada"), try session("ses_core", by: "pixel")]
        let pixelBusy = [try session("ses_core", by: "pixel"), try session("ses_log", by: "ada")]
        let bots = ["pixel", "ada"]
        #expect(Oversight.overseers(of: adaBusy, ranked: bots).map(\.bot) == ["pixel", "ada"])
        #expect(Oversight.overseers(of: pixelBusy, ranked: bots).map(\.bot) == ["pixel", "ada"], "lanes and faces don't swap places")
        #expect(Oversight.overseers(of: [try session("ses_new", by: "newer")] + adaBusy, ranked: bots).map(\.bot) == ["pixel", "ada", "newer"], "a bot Bots doesn't list yet goes last")
    }

    @Test func whatABotDidBeforeYouLookedIsntPlayedAndEachNewThingPlaysOnce() throws {
        var player = OversightPlayer()
        let before = try marks(#"{"marks": [{"id": "m1", "bot": "pixel", "session": "ses_core", "kind": "read", "at": 1}]}"#)
        #expect(player.take(before).isEmpty, "what happened before you looked isn't played late")
        let next = try marks(#"{"marks": [{"id": "m1", "bot": "pixel", "session": "ses_core", "kind": "read", "at": 1}, {"id": "m2", "bot": "pixel", "session": "ses_icons", "kind": "finished", "at": 2}, {"id": "m3", "bot": "pixel", "session": "ses_core", "kind": "something-newer", "at": 3}]}"#)
        #expect(player.take(next).map(\.id) == ["m2"], "the new one plays; one of a kind this app doesn't know is left out")
        #expect(player.take(next).isEmpty, "a line that repeats it doesn't play it again")
    }
}
