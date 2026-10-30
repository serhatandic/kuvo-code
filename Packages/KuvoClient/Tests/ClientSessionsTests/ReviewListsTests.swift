import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// "/review"'s lists, as both apps show them: what it can read in this folder with how much each
/// is, found as you type; a commit or a folder to start with; then what to look for, whose pick
/// starts the review.
struct ReviewListsTests {
    private let known = ReviewList.Known(
        choices: try! JSONDecoder().decode(ReviewChoices.self, from: Data(#"""
        {"repository": true, "branch": {"name": "timer", "base": "main", "commits": 12},
         "commits": [{"id": "abc1234def", "short": "abc1234", "title": "Pause keeps the time left", "time": 1000},
                     {"id": "fed9876abc", "short": "fed9876", "title": "First", "time": 0}],
         "folders": [{"path": "docs", "files": 4}, {"path": "src", "files": 300}, {"path": "src/auth", "files": 12}, {"path": "tests", "files": 8}, {"path": "tools", "files": 1}],
         "describes": true}
        """#.utf8)),
        uncommitted: ReviewSize(files: 3, parts: 1), branch: ReviewSize(files: 41, parts: 1), project: ReviewSize(files: 312, parts: 9))

    @Test func whatToReviewSaysHowMuchEachReadsAndABigOneTakesAWhile() throws {
        let list = try #require(ReviewList.make(.what(""), known: known))
        #expect(list.rows.map(\.title) == ["Changes not committed yet", "This branch against main", "Commits…", "A folder…", "The whole project", "Something else…"])
        #expect(list.rows.map(\.note) == ["3 files", "12 commits · 41 files", "pick where to start", "docs, src, tests…", "312 files · read in 9 parts, takes a while", "say what to review"])
        #expect(list.rows[4].warns == true)
        // Return on the first keeps today's: the changes not committed yet.
        #expect(list.rows[0].pick == .write("changes not committed yet "))
        // While it's measured, no size yet; nothing to commit says so.
        let measuring = try #require(ReviewList.make(.what(""), known: ReviewList.Known(choices: known.choices, uncommitted: ReviewSize(files: 0, parts: 0), measured: false)))
        #expect(measuring.rows.map(\.note) == ["nothing to review", "12 commits", "pick where to start", "docs, src, tests…", "…", "say what to review"])
    }

    @Test func typingFindsARowAndYourOwnWordsCloseTheList() throws {
        #expect(ReviewList.make(.what("the wh"), known: known)?.rows.map(\.id) == ["project"])
        #expect(ReviewList.make(.what("bra"), known: known)?.rows.map(\.id) == ["branch"])
        #expect(ReviewList.make(.what("an eye"), known: known) == nil)
    }

    @Test func outOfARepositoryOnlyFoldersAndTheProject() throws {
        let loose = ReviewList.Known(choices: ReviewChoices(repository: false, folders: [.init(path: "lib", files: 2)]))
        #expect(ReviewList.make(.what(""), known: loose)?.rows.map(\.id) == ["folder", "project"])
    }

    @Test func aCommitOrAFolderIsPickedFromWhatsThere() throws {
        let commits = try #require(ReviewList.make(.commit(""), known: known))
        #expect(commits.rows.map(\.title) == ["Pause keeps the time left", "First"])
        #expect(commits.rows[0].pick == .write("since abc1234 "))
        #expect(ReviewList.make(.commit("fed"), known: known)?.rows.map(\.title) == ["First"])
        #expect(ReviewList.make(.commit("pause"), known: known)?.rows.count == 1)

        // By the start of its path first, then any folder with what's typed in it.
        #expect(ReviewList.make(.folder("s"), known: known)?.rows.map(\.title) == ["src", "src/auth", "docs", "tests", "tools"])
        #expect(ReviewList.make(.folder("auth"), known: known)?.rows.first?.pick == .write("folder src/auth "))
        #expect(ReviewList.make(.folder("auth"), known: known)?.rows.first?.note == "12 files")
    }

    @Test func lookForStartsTheReview() throws {
        let list = try #require(ReviewList.make(.lookFor(""), known: known))
        #expect(list.rows.map(\.title) == ["Anything wrong", "Security", "Performance", "Accessibility", "Something else…"])
        // Return on the first starts today's review; a preset starts it looking for that; Something
        // else… waits for your words.
        #expect(list.rows.map(\.pick) == [.start(""), .start("for security"), .start("for performance"), .start("for accessibility"), .write("for ")])
        #expect(ReviewList.make(.lookFor("for sec"), known: known)?.rows.map(\.id) == ["security"])
    }

    // Something else…: the list closes for what to review in your own words, which go as they are.
    @Test func somethingElseReviewsWhatYouSay() throws {
        #expect(ReviewList.make(.what("some"), known: known)?.rows.map(\.id) == ["described"])
        #expect(ReviewList.make(.what(""), known: known)?.rows.last?.pick == .ownWords)
        // A box from before doesn't offer it.
        var older = known
        older.choices?.describes = nil
        #expect(ReviewList.make(.what(""), known: older)?.rows.map(\.id).contains("described") == false)

    }

    // A review's parts in its card: each says what it's doing as it reads, then what it found,
    // and opens once it reads in a session of its own; one alone is the reviewer.
    @Test func eachPartSaysWhatItsDoingThenWhatItFound() throws {
        let review = try JSONDecoder().decode(Review.self, from: Data(#"""
        {"id": "r", "session": "s", "state": "reviewing", "findings": [], "started": 1, "parts": [
          {"n": 1, "of": 3, "files": ["src/a.ts", "src/b.ts"], "state": "done", "found": 2, "session": "ses_p1"},
          {"n": 2, "of": 3, "files": ["src/c.ts"], "state": "reading", "found": 0, "session": "ses_p2", "now": "Reading src/c.ts"},
          {"n": 3, "of": 3, "files": ["src/d.ts", "src/e.ts", "src/f.ts"], "fileCount": 250, "state": "waiting", "found": 0}]}
        """#.utf8))
        let parts = try #require(review.parts)
        #expect(parts.map(\.title) == ["Part 1", "Part 2", "Part 3"])
        // All its files are counted, not only those named.
        #expect(parts.map(\.line) == ["2 files · 2 found", "Reading src/c.ts", "250 files"])
        #expect(parts.map(\.opens) == [true, true, false])
        #expect(!review.hasNoParts)
        // Alone, it's the reviewer; one a box from before parts reads says nothing of them.
        #expect(Review.Part(n: 1, of: 1, files: ["a.ts"], state: .done).title == "The reviewer")
        #expect(Review.Part(n: 1, of: 1, files: ["a.ts"], state: .done).line == "1 file · found nothing")
        let older = try JSONDecoder().decode(Review.self, from: Data(#"{"id": "r", "session": "s", "state": "reviewing", "findings": [], "started": 1}"#.utf8))
        #expect(older.hasNoParts)
        // With the coding agents a part has no session: listed, not opened.
        #expect(!Review.Part(n: 1, of: 2, files: ["a.ts"], state: .done, found: 1).opens)
        // A part that failed says so in its own view, and what became of its review.
        #expect(ReviewPartWords.failed(stopped: false, alone: false) == "This part couldn’t be read. The review went on with the others.")
        #expect(ReviewPartWords.failed(stopped: true, alone: true) == "Stopped.")
        #expect(ReviewPartWords.failed(stopped: false, alone: true) == "The reviewer couldn’t read this, so the review couldn’t be done. Ask for it again.")
    }

    @Test func theLineUnderAReviewSaysWhatItCoveredAndWhoReadIt() throws {
        let review = { (json: String) in try JSONDecoder().decode(Review.self, from: Data(json.utf8)) }
        let both = try review(#"{"id": "r", "session": "s", "state": "done", "scope": {"kind": "project"}, "focus": "security: the sign-in", "findings": [], "started": 1}"#)
        #expect(ReviewList.footnote(both, readerName: "GLM") == "The whole project · security · “the sign-in” · read by GLM")
        // Today's review says nothing more.
        #expect(ReviewList.footnote(try review(#"{"id": "r", "session": "s", "state": "done", "findings": [], "started": 1}"#), readerName: "GLM") == nil)
        #expect(ReviewList.unfinished(ReviewCommand(" since ", readers: [])) == "Write the commit to start with after “since”.")
    }
}
