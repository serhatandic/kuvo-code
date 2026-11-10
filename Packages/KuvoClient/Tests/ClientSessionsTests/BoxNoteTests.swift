import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// What the box writes to an agent in its conversation (a goal starting, its sessions' news, your
/// answer told late) reads in both apps as a line of what happened, never as a bubble of yours,
/// in conversations from before the box marked them too.
struct BoxNoteTests {
    /// A user message as the engine keeps it.
    private func message(_ text: String, metadata: String? = nil) throws -> Message.User {
        let kept = metadata.map { #", "metadata": \#($0)"# } ?? ""
        let json = #"{"type": "user", "id": "msg_1", "time": {"created": 1}, "text": \#(String(data: try JSONEncoder().encode(text), encoding: .utf8)!)\#(kept)}"#
        guard case .user(let user) = try JSONDecoder().decode(Message.self, from: Data(json.utf8)) else { throw CocoaError(.coderReadCorrupt) }
        return user
    }

    @Test func aMarkedMessageIsItsLine() throws {
        let started = try message("[Goal started] The user approved the plan. Work through it now: 1. Read the commits 2. Write the summary",
                                  metadata: #"{"kuvo": {"note": {"from": "Goal", "line": "Goal started"}}}"#)
        #expect(BoxNote.of(started) == BoxNote(from: "Goal", line: "Goal started"))
    }

    /// Before the box marked them: read from how it wrote them.
    @Test func oldOnesReadTheSame() throws {
        let cases: [(String, BoxNote)] = [
            ("[Goal started] The user approved the plan. Work through it now, steps side by side where they don't depend on each other: 1. Read 2. Write\nSpend nothing.",
             BoxNote(from: "Goal", line: "Goal started")),
            ("[Not now] The user didn't start this goal. Don't start its work: ask them in a line what they'd like instead, if anything.",
             BoxNote(from: "Goal", line: "You said not now")),
            ("[Goal changed] The user changed the goal's limits. Switched on: nothing.", BoxNote(from: "Goal", line: "You changed the goal's limits")),
            ("[Goal's end] The end the user set has come. Finish the step under way, start nothing new, and end with finish_goal and your report.",
             BoxNote(from: "Goal", line: "The goal's end came")),
            ("[Limit reset] the model's limit has reset. Carry on with the goal.", BoxNote(from: "Goal", line: "The model's limit reset")),
            ("[Goal] Nothing of the goal is at work now. Carry on with the next step that doesn't wait on the user (goal_progress shows the plan as it stands).",
             BoxNote(from: "Goal", line: "Reminded to carry on")),
            ("[Session finished] \"Sign-in\" in tidepool (address ses_9), after 3 min:\nDone, all green.",
             BoxNote(from: "Its sessions", line: "“Sign-in” finished", news: [SessionNews(session: "ses_9", title: "Sign-in", kind: .finished, said: "Done, all green.")])),
            ("[Session still working] \"Sign-in\" in tidepool (address ses_9), after 30 min:\nStarted the tests.\n(Still running in the background: the command `npm test`. It may write again once that ends.)",
             BoxNote(from: "Its sessions", line: "“Sign-in” still working",
                     news: [SessionNews(session: "ses_9", title: "Sign-in", kind: .working, said: "Started the tests.", running: "the command `npm test`")])),
            ("[Session failed] \"Sign-in\" in tidepool (address ses_9) stopped with an error. Read it with read_conversation.",
             BoxNote(from: "Its sessions", line: "“Sign-in” stopped with an error", news: [SessionNews(session: "ses_9", title: "Sign-in", kind: .failed, said: "Stopped with an error.")])),
            ("[Session finished] \"A\" in x (address ses_1):\nok\n\n[Session asks] \"B\" in x (address ses_2) asks: a name (ask f1).",
             BoxNote(from: "Its sessions", line: "2 updates from its sessions",
                     news: [SessionNews(session: "ses_1", title: "A", kind: .finished, said: "ok"), SessionNews(session: "ses_2", title: "B", kind: .asks, said: "A name.")])),
            ("[Goal resumed] The user resumed the goal you paused. Carry on from where it stopped.", BoxNote(from: "Goal", line: "Goal resumed")),
            ("[The user answered] Made Tidepool at ~/Developer/tidepool.", BoxNote(from: "Your answer", line: "You answered: Made Tidepool at ~/Developer/tidepool.")),
        ]
        for (text, note) in cases { #expect(BoxNote.of(try message(text)) == note, "\(text)") }
    }

    /// Its sessions' news reads as a message from each session (#404): who, what happened, and what
    /// it said, not what the lead is told to do with it; marked by the box, or from before.
    @Test func itsSessionsNewsIsAMessageFromEach() throws {
        let finished = try message("[Session finished] \"#398 sign-in card answers the wrong computer\" in kuvo-ai (address ses_398), after 2 h:\nMerged to main at 1a2b3c4. Tests green.\n\nShots in notes/398.",
                                   metadata: #"{"kuvo": {"note": {"from": "Its sessions", "line": "“#398 sign-in card answers the wrong computer” finished"}}}"#)
        let news = try #require(BoxNote.of(finished)?.news.first)
        #expect(news.title == "#398 sign-in card answers the wrong computer")
        #expect(news.session == "ses_398")
        #expect(news.status == "finished")
        #expect(news.body == "Merged to main at 1a2b3c4. Tests green.\n\nShots in notes/398.")

        let working = try message("[Session still working] \"Tests\" in tidepool (address ses_7), after 30 min:\n(It ended without a reply.)\n(Still running in the background: the command `npm test`. It may write again once that ends.)")
        #expect(BoxNote.of(working)?.news.first?.body == "Still running in the background: the command `npm test`.")
        #expect(BoxNote.of(working)?.news.first?.status == "still working")
        // Shown: nothing (the user, 11-10).
        #expect(BoxNote.of(working)?.shown == [])
        #expect(BoxNote.of(finished)?.shown.count == 1)

        let asks = try message("[Session asks] \"Deploy\" in tidepool (address ses_5) asks to run `fly deploy` (ask per_1). Answer with answer_ask if it's yours to allow, or tell the user in a line and carry on.")
        #expect(BoxNote.of(asks)?.news.first?.body == "Asks to run `fly deploy`.")
        let question = try message("[Session asks] \"Deploy\" in tidepool (address ses_5) asks: Which region? (ask frm_1). Answer with answer_ask (answer), or tell the user in a line and carry on.")
        #expect(BoxNote.of(question)?.news.first?.body == "Which region?")

        let failed = try message("[Session failed] \"Deploy\" in tidepool (address ses_5) stopped with an error: The model is overloaded. Read it with read_conversation, then start it again, try another way, or tell the user.")
        #expect(BoxNote.of(failed)?.news.first?.body == "Stopped with an error: The model is overloaded.")
        #expect(BoxNote.of(failed)?.news.first?.status == "stopped")

        let held = try message("[Session failed] \"Deploy\" in tidepool (address ses_5) stopped: Claude's weekly limit is reached until Friday. Starting it again there fails the same way: start it again on a model that can, from list_models, or tell the user.")
        #expect(BoxNote.of(held)?.news.first?.body == "Stopped: Claude's weekly limit is reached until Friday.")

        let ended = try message("[Session finished] \"\" in x (address ses_1):\n(It ended without a reply.)")
        #expect(BoxNote.of(ended)?.news == [SessionNews(session: "ses_1", title: "New Session", kind: .finished, said: "")])
        #expect(BoxNote.of(ended)?.news.first?.body == "It ended without a reply.")
    }

    /// The box's other notes tell of no session.
    @Test func otherNotesHaveNoNews() throws {
        #expect(BoxNote.of(try message("[Goal started] The user approved the plan. Work through it now.", metadata: #"{"kuvo": {"note": {"from": "Goal", "line": "Goal started"}}}"#))?.news == [])
    }

    /// Yours, even when they start like one, and /goal asked for, which is your bubble.
    @Test func yourWordsStayYours() throws {
        #expect(BoxNote.of(try message("[Goal] ship it")) == nil)
        #expect(BoxNote.of(try message("[Goal started] is what the card says, why?")) == nil)
        #expect(BoxNote.of(try message("[Session finished] yet? Tell me")) == nil)
        #expect(BoxNote.of(try message("[Limit reset] when?")) == nil)
        #expect(BoxNote.of(try message("Write a weekly summary\n\n<sent-with>\nThe user sent this as a goal, with Kuvo Code's /goal. Plan it, check what it needs, and put it to them with propose_goal before doing any of the work:\n/goal\n</sent-with>")) == nil)
        #expect(BoxNote.of(try message("hello", metadata: #"{"kuvo": {"other": 1}}"#)) == nil)
    }

    /// A session that wasn't summarized is its own message, and doesn't run into the one before.
    @Test func notSummarizedIsItsOwnMessage() throws {
        let text = "[Session finished] \"A\" in tidepool (address ses_a), after 3 min:\nDone.\n\n[Session not summarized] \"B\" in tidepool (address ses_b): The model refused. Its conversation and work are as they were."
        let note = try #require(BoxNote.of(try message(text, metadata: #"{"kuvo": {"note": {"from": "Its sessions", "line": "2 updates from its sessions"}}}"#)))
        #expect(note.shown.map(\.body) == ["Done.", "The model refused."])
        #expect(note.shown.map(\.status) == ["finished", "not summarized"])
        #expect(note.shown.map(\.session) == ["ses_a", "ses_b"])
    }

    /// Its sessions' news worded in a way this app doesn't read shows whole rather than nothing;
    /// a kind it doesn't know ends the part before it and is left out; a title may have quotes.
    @Test func unreadNewsShowsWhole() throws {
        let marked = #"{"kuvo": {"note": {"from": "Its sessions", "line": "News"}}}"#
        let odd = try #require(BoxNote.of(try message("[Session paused] something new", metadata: marked)))
        #expect(odd.shown.map(\.body) == ["[Session paused] something new"])
        #expect(odd.shown.first?.status == nil)
        let mixed = try #require(BoxNote.of(try message("[Session finished] \"Fix \"login\" form\" in tidepool (address ses-1.a), after 3 min:\nDone.\n\n[Session paused] \"B\" in tidepool (address ses_b): later.", metadata: marked)))
        #expect(mixed.shown.map(\.title) == ["Fix \"login\" form"])
        #expect(mixed.shown.map(\.session) == ["ses-1.a"])
        #expect(mixed.shown.map(\.body) == ["Done."])
    }
}
