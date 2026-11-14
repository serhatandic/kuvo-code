import Foundation
import OpenCodeKit

// Whether a session is at work, and a bot through the sessions it oversees (PROTOCOL.md, "Work › At
// work"). A box says the facts: which turns its engine runs, what a session left running
// (`kuvo/work/background`), what a session asks, which bot oversees which session (`kuvo.by`) and
// which are archived. Each client works out from them what it shows, here, the same way on the Mac
// and the phone: a bot's row, face, tab and header, and the bar over its composer. The box never
// sends that as a finished count.

public enum AtWork {
    /// A session works: its engine runs a turn of it, or its box says something it left running (a
    /// command, a subagent, another task of its agent's) still does.
    public static func isWorking(running: Bool, background: SessionBackground?) -> Bool {
        running || background != nil
    }

    /// Put away, in any of the ways a client marks it, as its box reads it too.
    public static func isArchived(_ session: Session) -> Bool {
        session.time.archived != nil || session.metadata?["kuvo.archived"]?.bool == true || session.metadata?["kuvo"]?["archived"]?.bool == true
    }

    /// Every session `bot` oversees that you haven't archived: each marked as its work (`kuvo.by`,
    /// which its box puts on those its sessions start too), as its row in Bots and its lanes count
    /// them. A subagent isn't one: it keeps the session it works for at work (`background`).
    public static func overseen(by bot: String, in sessions: some Sequence<Session>) -> [Session] {
        sessions.filter { WorksFor($0)?.bot == bot && !isArchived($0) }
    }

    /// Those of them at it now: working, or waiting on an answer. `isAtWork` is the client's word on
    /// a session from what its box said (`isWorking`, or asking).
    public static func sessions(of bot: String, in sessions: some Sequence<Session>, isAtWork: (String) -> Bool) -> [Session] {
        overseen(by: bot, in: sessions).filter { isAtWork($0.id) }
    }

    /// The bot is at work through the sessions it oversees (its own conversation may be still), so
    /// its face works and its row shimmers: while one works (`isWorking`; one only waiting on you
    /// shows that on its own row), and not while its wake-ups are paused, when it sleeps, though its
    /// sessions may still run (their bar says so).
    public static func isOverseeingWork(_ bot: String, paused: Bool, in sessions: some Sequence<Session>, isWorking: (String) -> Bool) -> Bool {
        !paused && overseen(by: bot, in: sessions).contains { isWorking($0.id) }
    }

    /// The line under a bot's name while it oversees work (`isOverseeingWork`): how many of its
    /// sessions are at it, working or waiting on you, in the words of the bar over its composer
    /// ("3 sessions at work"), so its row says the same on every client; nil while it doesn't.
    public static func workLine(of bot: String, paused: Bool, in sessions: some Sequence<Session>, isWorking: (String) -> Bool, isAsking: (String) -> Bool) -> String? {
        let overseen = overseen(by: bot, in: sessions)
        guard !paused, overseen.contains(where: { isWorking($0.id) }) else { return nil }
        return WorkWords.barTitle(atWork: overseen.filter { isWorking($0.id) || isAsking($0.id) }.count, today: 0)
    }

    /// The line under a bot's name at rest, in place of its job: how many sessions it oversees
    /// ("Overseeing 4 sessions"); nil for none.
    public static func restLine(of bot: String, in sessions: some Sequence<Session>) -> String? {
        let overseen = overseen(by: bot, in: sessions)
        return overseen.isEmpty ? nil : Oversight.overseeing(count: overseen.count)
    }
}

extension BotWorkReport {
    /// Its sessions as they stand now, each by what the client knows of it from its box since the
    /// report was read (`working`, `asking`), so the bar over the bot's composer counts the same
    /// sessions at work as its row: one asking first, then one working; one the report had at work
    /// that no longer is, done.
    public func standing(working: (String) -> Bool, asking: (String) -> Bool) -> BotWorkReport {
        var now = self
        now.sessions = sessions.map { item in
            var item = item
            if asking(item.session) {
                item.state = .asking
            } else if working(item.session) {
                item.state = .working
            } else if item.isAtWork {
                item.state = .idle
                item.asks = nil
            }
            return item
        }
        return now
    }
}
