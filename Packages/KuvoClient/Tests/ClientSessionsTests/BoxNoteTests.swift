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
             BoxNote(from: "Its sessions", line: "“Sign-in” finished")),
            ("[Session failed] \"Sign-in\" in tidepool (address ses_9) stopped with an error. Read it with read_conversation.",
             BoxNote(from: "Its sessions", line: "“Sign-in” stopped with an error")),
            ("[Session finished] \"A\" in x (address ses_1):\nok\n\n[Session asks] \"B\" in x (address ses_2) asks: a name (ask f1).",
             BoxNote(from: "Its sessions", line: "2 updates from its sessions")),
            ("[Goal resumed] The user resumed the goal you paused. Carry on from where it stopped.", BoxNote(from: "Goal", line: "Goal resumed")),
            ("[The user answered] Made Tidepool at ~/Developer/tidepool.", BoxNote(from: "Your answer", line: "You answered: Made Tidepool at ~/Developer/tidepool.")),
        ]
        for (text, note) in cases { #expect(BoxNote.of(try message(text)) == note, "\(text)") }
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
}
