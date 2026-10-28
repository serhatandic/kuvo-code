import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// What both apps show of a computer's sessions: sub-sessions finished since you were last in them
/// (or in the session they're for) are new; reading a session reads those it shows, all the way
/// down, and its box is told each; a read elsewhere is taken when it's later; seats and the
/// engine's runs for coding agents are kept out of sight.
struct SessionRulesTests {
    private func session(_ id: String, idle: Double? = nil, viewed: Double? = nil, metadata: String = "null") throws -> Session {
        var time = #""created": 1, "updated": 2"#
        if let idle { time += #", "idle": \#(idle)"# }
        if let viewed { time += #", "viewed": \#(viewed)"# }
        let json = #"{"id": "\#(id)", "projectID": "p", "title": "\#(id)", "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "time": {\#(time)}, "location": {"directory": "/p"}, "metadata": \#(metadata)}"#
        return try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    @Test func readingASessionReadsWhatItShowsAllTheWayDown() throws {
        var sessions = [try session("ses_timer", idle: 5, viewed: 5)]
        var subs: [String: [Session]] = [
            "ses_timer": [try session("ses_find", idle: 12), try session("ses_old", idle: 3)],
            "ses_find": [try session("ses_deep", idle: 14)],
        ]
        let parents = ["ses_find": "ses_timer", "ses_old": "ses_timer", "ses_deep": "ses_find"]
        let rootViewed = { (_: Session) in sessions[0].time.viewed }
        #expect(ReadState.hasNew(under: "ses_timer", in: subs, rootViewed: rootViewed))
        #expect(!ReadState.isNew(subs["ses_timer"]![1], rootViewed: 5), "done before you were last in its session: not new")

        // One sub-session read: it and its own, not the others.
        let first = ReadState.read("ses_find", sessions: &sessions, subSessions: &subs) { parents[$0] }
        #expect(first.map(\.id) == ["ses_find", "ses_deep"])
        #expect(first.map(\.idle) == [12, 14])
        #expect(!ReadState.hasNew(under: "ses_find", in: subs, rootViewed: rootViewed))

        // The session read: what it shows that's still unread, for its box to be told.
        subs["ses_timer"]!.append(try session("ses_more", idle: 20))
        let second = ReadState.read("ses_timer", sessions: &sessions, subSessions: &subs) { parents[$0] }
        #expect(second.map(\.id) == ["ses_old", "ses_more"], "itself was read already")
        #expect(!ReadState.hasNew(under: "ses_timer", in: subs, rootViewed: rootViewed))
    }

    @Test func aReadElsewhereIsTakenWhenItsLater() throws {
        var sessions = [try session("ses_timer", idle: 9, viewed: 4)]
        var subs = ["ses_timer": [try session("ses_find", idle: 12, viewed: 1)]]
        let parent = { (id: String) in id == "ses_find" ? "ses_timer" : nil }
        #expect(ReadState.sawRead("ses_find", upTo: 12, sessions: &sessions, subSessions: &subs, parent: parent))
        #expect(subs["ses_timer"]![0].isUnread == false)
        #expect(!ReadState.sawRead("ses_find", upTo: 10, sessions: &sessions, subSessions: &subs, parent: parent), "an earlier one changes nothing")
        #expect(ReadState.sawRead("ses_timer", upTo: 9, sessions: &sessions, subSessions: &subs, parent: parent))
        #expect(sessions[0].isUnread == false)
    }

    @Test func seatsAndTheEnginesRunsAreKeptOutOfSight() throws {
        #expect(HiddenSessions.isHidden(try session("ses_seat", metadata: #"{"kuvo": {"seat": "grp_1"}}"#)))
        #expect(HiddenSessions.isHidden(try session("ses_run", metadata: #"{"kuvo": {"engineFor": "ses_x"}}"#)))
        #expect(!HiddenSessions.isHidden(try session("ses_bot", metadata: #"{"kuvo": {"bot": "bot_1"}}"#)))
        #expect(!HiddenSessions.isHidden(try session("ses_plain")))
    }

    @Test func eachReasonAComputerWasntSearchedIsSaid() {
        #expect(UnsearchedReason.notConnected.line(for: "lokum") == "lokum isn’t connected, so its conversations weren’t searched.")
        #expect(UnsearchedReason.needsUpdate.line(for: "lokum").contains("needs an update"))
    }

    @Test func aSubagentsTaskIsFromTheAgentThatStartedIt() throws {
        var main = try session("ses_timer")
        main.title = "Check the settings screen"
        var finder = try session("ses_find")
        finder.parentID = "ses_timer"
        finder.title = "Find where settings are read"
        #expect(SubagentStarter.name(of: main) == "the main agent")
        // One a subagent started is from that subagent, by its task, as its conversation's header says.
        #expect(SubagentStarter.name(of: finder) == "Find where settings are read")
        finder.title = nil
        #expect(SubagentStarter.name(of: finder) == "a subagent")
        // Its starter not known (yet): the main agent, which starts most.
        #expect(SubagentStarter.name(of: nil) == "the main agent")
    }
}
