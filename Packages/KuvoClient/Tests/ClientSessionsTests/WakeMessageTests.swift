import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// A wake-up's card in both apps reads a short summary, and opens to the note its agent read whole:
/// the summary its agent gave it, or the note's first sentence, in conversations from before too.
struct WakeMessageTests {
    /// A user message as the engine keeps it.
    private func message(_ text: String, metadata: String? = nil) throws -> Message.User {
        let kept = metadata.map { #", "metadata": \#($0)"# } ?? ""
        let json = #"{"type": "user", "id": "msg_1", "time": {"created": 1}, "text": \#(String(data: try JSONEncoder().encode(text), encoding: .utf8)!)\#(kept)}"#
        guard case .user(let user) = try JSONDecoder().decode(Message.self, from: Data(json.utf8)) else { throw CocoaError(.coderReadCorrupt) }
        return user
    }

    @Test func theSummaryItsAgentGaveIsWhatTheCardReads() throws {
        let note = "Look at the last CI run. If it failed, read the log, fix what broke and tell the user.\n\nThen check the deploy."
        let wake = try #require(WakeMessage.of(try message("[Wake-up] " + note, metadata: #"{"kuvo": {"wake": {"summary": "Check CI\nand the deploy"}}}"#)))
        #expect(wake.note == note, "the note whole, as its agent read it")
        #expect(wake.summary == "Check CI and the deploy")
        #expect(wake.folds)
    }

    /// One from before summaries, or without one: its note's first sentence.
    @Test func withoutOneItsFirstSentence() throws {
        let cases: [(String, String, Bool)] = [
            ("Look at the last CI run. If it failed, read the log.", "Look at the last CI run.", true),
            ("**Check** v1.2 on example.com! Then tell Ada.", "Check v1.2 on example.com!", true),
            ("# Morning round\n\nRead the inbox and summarize it.", "Morning round", true),
            ("Water the plants", "Water the plants", false),
            ("Water the plants.", "Water the plants.", false),
            // A sentence two lines on a phone may not hold, or a long one: all of it, folded to two lines.
            ("Check whether the nightly build on main passed, and tell the user.", "Check whether the nightly build on main passed, and tell the user.", true),
            (String(repeating: "Read the inbox and ", count: 10) + "sum it up", String(repeating: "Read the inbox and ", count: 10) + "sum it up", true),
            ("Tell the user how CI went.\n\nYour watch (AbCd12, every 10m) saw a change. Its check, gh run list, now prints:\ncompleted success",
             "Tell the user how CI went.", true),
        ]
        for (note, summary, folds) in cases {
            let wake = try #require(WakeMessage.of(try message("[Wake-up] " + note)))
            #expect(wake.summary == summary, "\(note)")
            #expect(wake.folds == folds, "\(note)")
            #expect(wake.note == note)
        }
    }

    @Test func otherMessagesAreNone() throws {
        #expect(WakeMessage.of(try message("Check the build")) == nil)
        #expect(WakeMessage.of(try message("[Goal started] The user approved the plan.", metadata: #"{"kuvo": {"wake": {"summary": "x"}}}"#)) == nil)
    }
}
