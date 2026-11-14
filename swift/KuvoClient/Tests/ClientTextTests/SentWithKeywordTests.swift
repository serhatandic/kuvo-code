import Foundation
import Testing
import ClientText

/// A message sent with a keyword, taken back into the composer. (How its keyword reads, in its
/// bubble too, is its box's to say: `MessageParts.keyword`, held to protocol/vectors/message-parts.json.)
@Suite struct SentWithKeywordTests {
    /// Taken back (Undo, ↑, Edit, a branch): a goal comes back as one, /goal and its words, so
    /// sending it again asks for the goal again; /plan's and /loop's words come back alone, so they
    /// don't switch to Plan or set another loop.
    @Test func takenBackAGoalStaysAGoalAndOtherKeywordsLeaveTheirWords() {
        #expect(SentWithKeyword.draft("Summarize the commits weekly", keyword: "/goal") == "/goal Summarize the commits weekly")
        #expect(SentWithKeyword.draft("check CI", keyword: "/loop every hour") == "check CI")
        #expect(SentWithKeyword.draft("Plan the move", keyword: "/plan") == "Plan the move")
        #expect(SentWithKeyword.draft("just words", keyword: nil) == "just words")
    }
}
