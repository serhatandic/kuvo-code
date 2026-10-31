import Foundation
import Testing
import ClientText

/// A message sent with a keyword reads in its bubble as the composer showed it: the keyword, then
/// your words, and never what Kuvo Code told the agent with them.
@Suite struct SentWithKeywordTests {
    @Test func aKeywordsMessageIsYourWordsWithTheKeyword() {
        let sent = SentWithKeyword.message("check CI", typed: "/loop every hour")
        #expect(SentWithKeyword.split(sent) == ("check CI", "/loop every hour"))
    }

    /// /goal in a bot's chat, word for word as every box sends it (the box's work/goals.ts): the bot
    /// is told to plan it, which your bubble leaves out.
    @Test func aGoalAskedForInABotsChatIsYourWordsWithGoal() {
        let sent = """
        Write a short weekly summary of this repo's commits every Monday for a month

        <sent-with>
        The user sent this as a goal, with Kuvo Code's /goal. Plan it, check what it needs, and put it to them with propose_goal before doing any of the work:
        /goal
        </sent-with>
        """
        #expect(SentWithKeyword.split(sent) == ("Write a short weekly summary of this repo's commits every Monday for a month", "/goal"))
    }

    /// One sent before the goal's words went in a block: read the same way.
    @Test func aGoalSentTheOldWayReadsTheSame() {
        let sent = "[Goal] Write a short weekly summary of this repo's commits every Monday for a month\n\n(The user asked for this as a goal: plan it, check what it needs, and put it to them with propose_goal before doing any of the work.)"
        #expect(SentWithKeyword.split(sent) == ("Write a short weekly summary of this repo's commits every Monday for a month", "/goal"))
    }

    /// Taken back (Undo, ↑, Edit, a branch): a goal comes back as one, /goal and its words, so
    /// sending it again asks for the goal again; /plan's and /loop's words come back alone, so they
    /// don't switch to Plan or set another loop.
    @Test func takenBackAGoalStaysAGoalAndOtherKeywordsLeaveTheirWords() {
        #expect(SentWithKeyword.draft("Summarize the commits weekly", keyword: "/goal") == "/goal Summarize the commits weekly")
        #expect(SentWithKeyword.draft("check CI", keyword: "/loop every hour") == "check CI")
        #expect(SentWithKeyword.draft("Plan the move", keyword: "/plan") == "Plan the move")
        #expect(SentWithKeyword.draft("just words", keyword: nil) == "just words")
    }

    /// Words of yours that only look like it stay as you wrote them.
    @Test func yourOwnBracketsStayYours() {
        #expect(SentWithKeyword.split("[Goal] ship it") == ("[Goal] ship it", nil))
    }
}
