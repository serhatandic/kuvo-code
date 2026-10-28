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

    // Something else…: what to review in your own words, picked once said; then, while you pick
    // what to look for, what the box found for it, or why it found nothing.
    @Test func somethingElseReviewsWhatYouSay() throws {
        #expect(ReviewList.make(.what("some"), known: known)?.rows.map(\.id) == ["described"])
        #expect(ReviewList.make(.what(""), known: known)?.rows.last?.pick == .write("about "))
        // A box from before doesn't offer it.
        var older = known
        older.choices?.describes = nil
        #expect(ReviewList.make(.what(""), known: older)?.rows.map(\.id).contains("described") == false)

        #expect(ReviewList.make(.described(" "), known: known) == nil)
        let saying = try #require(ReviewList.make(.described("the auth module and its tests"), known: known))
        #expect(saying.rows.map(\.title) == ["“the auth module and its tests”"])
        #expect(saying.rows[0].pick == .write(#"about "the auth module and its tests" "#))
        #expect(ReviewList.unfinished(ReviewCommand(" about ", readers: [])) == "Write what to review after “about”.")

        let command = ReviewCommand(#" about "the auth module" "#, readers: [])
        var found = ReviewList.Described(words: "the auth module")
        #expect(ReviewList.described(command) == "the auth module")
        #expect(ReviewList.described(ReviewCommand(" about the auth", readers: [])) == nil)
        #expect(ReviewList.found(command, described: found)?.text == "Finding the files for that…")
        found.size = ReviewSize(files: 4, parts: 1, found: ["src/auth/login.ts", "src/auth/session.ts", "tests/login.test.ts", "tests/session.test.ts"])
        #expect(ReviewList.found(command, described: found)?.text == "Found 4 files: login.ts, session.ts, login.test.ts, …")
        found = .init(words: "the auth module", problem: "No files in this project fit that. Say it another way, or pick a folder.")
        #expect(ReviewList.found(command, described: found)! == ("No files in this project fit that. Say it another way, or pick a folder.", true))
        // Other words, or another scope: nothing of it.
        #expect(ReviewList.found(ReviewCommand(#" about "billing" "#, readers: []), described: found) == nil)
        #expect(ReviewList.found(ReviewCommand(" this branch ", readers: []), described: found) == nil)
        #expect(ReviewList.summary(command, reader: "Claude") == "Claude reads the files it finds for “the auth module” with fresh eyes, without this conversation, and lists what it finds.")
    }

    @Test func theLineUnderAReviewSaysWhatItCoveredAndWhoReadIt() throws {
        let review = { (json: String) in try JSONDecoder().decode(Review.self, from: Data(json.utf8)) }
        let both = try review(#"{"id": "r", "session": "s", "state": "done", "scope": {"kind": "project"}, "focus": "security: the sign-in", "findings": [], "started": 1}"#)
        #expect(ReviewList.footnote(both, readerName: "GLM") == "The whole project · security · “the sign-in” · read by GLM")
        // Today's review says nothing more.
        #expect(ReviewList.footnote(try review(#"{"id": "r", "session": "s", "state": "done", "findings": [], "started": 1}"#), readerName: "GLM") == nil)
        #expect(ReviewList.unfinished(ReviewCommand(" since ", readers: [])) == "Write the commit to start with after “since”.")
        #expect(ReviewList.summary(ReviewCommand(" folder src for performance", readers: []), reader: "GLM") == "GLM reads the files in src with fresh eyes, without this conversation, looking for performance, and lists what it finds.")
    }
}
