import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// Whether a bot is at work and how many of its sessions are, as both apps work it out from what its
/// box says: the turns its engine runs, what a session left running, what one asks and who
/// oversees whom. Its row and the bar over its composer count the same sessions, whatever the
/// report said when it was read.
struct AtWorkTests {
    private func session(_ id: String, by bot: String? = "pixel", archived: String? = nil) throws -> Session {
        var kuvo = bot.map { #""startedBy": "ses_pixel", "by": {"bot": "\#($0)", "name": "Pixel"}, "depth": 1"# } ?? ""
        if archived == "kuvo" { kuvo += (kuvo.isEmpty ? "" : ", ") + #""archived": true"# }
        var metadata = #"{"kuvo": {\#(kuvo)}"#
        if archived == "flat" { metadata += #", "kuvo.archived": true"# }
        metadata += "}"
        let time = archived == "time" ? #"{"created": 1, "updated": 2, "archived": 3}"# : #"{"created": 1, "updated": 2}"#
        let json = #"{"id": "\#(id)", "projectID": "p", "title": "\#(id)", "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "time": \#(time), "location": {"directory": "/p"}, "metadata": \#(metadata)}"#
        return try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private func report(_ items: [(String, String)]) throws -> BotWorkReport {
        let sessions = items.map { #"{"session": "\#($0.0)", "title": "\#($0.0)", "folder": "/p", "startedBy": "ses_pixel", "depth": 1, "state": "\#($0.1)", "started": 1, "tokens": 0}"# }
        let json = #"{"bot": "pixel", "sessions": [\#(sessions.joined(separator: ","))], "answered": [], "today": {"started": \#(items.count), "working": 0, "tokens": 0}}"#
        return try JSONDecoder().decode(BotWorkReport.self, from: Data(json.utf8))
    }

    private let background = SessionBackground(commands: 1, subagents: 0, tasks: 0, since: 1)

    /// The case the sidebar and the bar once disagreed on: three sessions working, three whose turn
    /// ended while a command they started runs on. The row and the bar both count six, though the
    /// report was read before those commands were known.
    @Test func aSessionWaitingOnItsBackgroundCommandCountsInTheRowAndTheBarAlike() throws {
        let running: Set<String> = ["ses_1", "ses_2", "ses_3"]
        let left: [String: SessionBackground] = ["ses_4": background, "ses_5": background, "ses_6": background]
        let working = { (id: String) in AtWork.isWorking(running: running.contains(id), background: left[id]) }
        let sessions = try (1...6).map { try session("ses_\($0)") } + [try session("ses_mine", by: nil)]

        let row = AtWork.sessions(of: "pixel", in: sessions, isAtWork: working)
        #expect(row.count == 6, "the row counts those waiting on a command they left running")
        #expect(AtWork.isOverseeingWork("pixel", paused: false, in: sessions, isWorking: working))

        let read = try report([("ses_1", "working"), ("ses_2", "working"), ("ses_3", "working"), ("ses_4", "finished"), ("ses_5", "finished"), ("ses_6", "idle")])
        let bar = read.standing(working: working, asking: { _ in false })
        #expect(bar.atWork.count == row.count, "the bar counts the same six")
        #expect(WorkWords.barTitle(atWork: bar.atWork.count, today: bar.today.started) == "6 sessions at work")
    }

    @Test func oneThatAsksIsAtWorkAndOneTheReportHadAtWorkThatEndedIsDone() throws {
        let read = try report([("ses_1", "working"), ("ses_2", "finished"), ("ses_3", "asking")])
        let now = read.standing(working: { $0 == "ses_2" }, asking: { $0 == "ses_1" })
        #expect(now.sessions.map(\.state) == [.asking, .working, .idle])
        #expect(now.atWork.map(\.session) == ["ses_1", "ses_2"])
        #expect(now.sessions[2].asks == nil, "what it asked is over")
    }

    @Test func archivedSessionsAndYourOwnArentABotsWork() throws {
        let sessions = [try session("ses_kept"), try session("ses_a", archived: "time"), try session("ses_b", archived: "flat"),
                        try session("ses_c", archived: "kuvo"), try session("ses_mine", by: nil), try session("ses_ada", by: "ada")]
        #expect(AtWork.overseen(by: "pixel", in: sessions).map(\.id) == ["ses_kept"])
        #expect(AtWork.sessions(of: "pixel", in: sessions) { _ in true }.map(\.id) == ["ses_kept"])
    }

    @Test func aPausedBotSleepsThoughItsSessionsRun() throws {
        let sessions = [try session("ses_1")]
        #expect(!AtWork.isOverseeingWork("pixel", paused: true, in: sessions) { _ in true })
        #expect(AtWork.sessions(of: "pixel", in: sessions) { _ in true }.count == 1, "its sessions are still at work, as its bar says")
        #expect(!AtWork.isOverseeingWork("pixel", paused: false, in: sessions) { _ in false })
    }

    /// One waiting on you, its turn not running, shows that on its own row: the bot's face doesn't
    /// look busy for it, though its bar counts it among those at work.
    @Test func aSessionOnlyWaitingOnYouDoesntMakeItsBotLookBusy() throws {
        let sessions = [try session("ses_1")]
        #expect(!AtWork.isOverseeingWork("pixel", paused: false, in: sessions) { _ in false })
        #expect(AtWork.sessions(of: "pixel", in: sessions) { $0 == "ses_1" }.count == 1)
    }

    /// A bot's row says what the bar over its composer says, on the Mac and the phone alike: how
    /// many of its sessions are at work, wherever they are (#240: the phone said "At work in 3
    /// projects: 3 sessions", counting worktrees as projects, where the Mac said something else).
    @Test func aBotsRowSaysHowManyOfItsSessionsAreAtWorkAsItsBarDoes() throws {
        let sessions = try ["ses_1", "ses_2", "ses_3", "ses_done"].map { try session($0) } + [try session("ses_mine", by: nil)]
        let working: (String) -> Bool = { ["ses_1", "ses_2", "ses_mine"].contains($0) }
        let asking: (String) -> Bool = { $0 == "ses_3" }
        let line = AtWork.workLine(of: "pixel", paused: false, in: sessions, isWorking: working, isAsking: asking)
        #expect(line == "3 sessions at work")
        let bar = try report([("ses_1", "working"), ("ses_2", "working"), ("ses_3", "asking"), ("ses_done", "finished")]).standing(working: working, asking: asking)
        #expect(line == WorkWords.barTitle(atWork: bar.atWork.count, today: bar.today.started), "the row and the bar say the same")
        #expect(AtWork.workLine(of: "pixel", paused: false, in: sessions, isWorking: { $0 == "ses_2" }, isAsking: { _ in false }) == "A session is at work")
        // Paused, or only waiting on you: its row says that instead.
        #expect(AtWork.workLine(of: "pixel", paused: true, in: sessions, isWorking: working, isAsking: asking) == nil)
        #expect(AtWork.workLine(of: "pixel", paused: false, in: sessions, isWorking: { _ in false }, isAsking: asking) == nil)
    }

    @Test func aReportFromABoxThatSaysNothingOfWorkingTodayStillReads() throws {
        let json = #"{"bot": "pixel", "sessions": [], "answered": [], "today": {"started": 0, "tokens": 0}}"#
        #expect(try JSONDecoder().decode(BotWorkReport.self, from: Data(json.utf8)).today.started == 0)
    }
}
