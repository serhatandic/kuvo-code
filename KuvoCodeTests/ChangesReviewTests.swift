import ClientChanges
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Reviewing in the Changes panel: the review button asks for what the tab shows, and a comment on
/// a line stays on that line while the agent goes on editing the file.
@MainActor
struct ChangesReviewTests {
    /// In a worktree on `kuvo/fix`, made from main, the Branch tab ("Since main") shows what the
    /// branch changed. The engine's review compares the branch you're on with the one it's given
    /// (`git diff <given>...HEAD`): given its own name, it found nothing to review.
    @Test func aBranchsReviewIsComparedWithItsBase() {
        #expect(ChangesPanel.reviewMessage(scope: .branch, base: "main", keywords: [.review]) == "/review-quick main")
        #expect(ChangesPanel.reviewMessage(scope: .branch, base: "main", keywords: []) == "/review main")
    }

    @Test func uncommittedChangesAreReviewedWithFreshEyes() {
        #expect(ChangesPanel.reviewMessage(scope: .uncommitted, base: "main", keywords: [.review]) == "/review")
        #expect(ChangesPanel.reviewMessage(scope: .branch, base: nil, keywords: [.review]) == "/review")
    }

    /// You comment on a line while the agent works; it adds lines above it. The panel reads the
    /// changes again every few seconds: the comment (and one still being written) stays on its
    /// line, rather than vanishing from the diff with what you typed.
    @Test func aCommentStaysOnItsLineWhenTheAgentAddsLinesAboveIt() async throws {
        let repo = try TestRepository()
        try repo.write("app.js", "let a = 1\nlet b = 2\n")
        try repo.commitAll("First")
        try repo.write("app.js", "let a = 1\nlet b = 3\n")
        let box = try await GitTestBox()
        let changes = box.changes(repo.path)
        await changes.refresh()
        let line = try #require(changes.files.first?.lines.first { $0.kind == .added })
        let comment = ReviewComment(file: "app.js", line: line.number, side: .new, snippet: line.text, text: "Why 3?")

        let before = try #require(changes.files.first?.lines)

        try repo.write("app.js", "import x from 'x'\n\nlet a = 1\nlet b = 3\n")
        await changes.refresh()
        let lines = try #require(changes.files.first?.lines)
        let now = try #require(ReviewComment.line(side: comment.side, number: comment.line, from: before, to: lines))
        #expect(now.text == "let b = 3")
        #expect(now.number == 4)
        // And the agent is told where it is now.
        let followed = ReviewComment.following([comment], from: ["app.js": before], to: ["app.js": lines])
        #expect(ReviewComments.text("Have a look", adding: followed).contains("[app.js:4]"))
    }

    /// A comment on a line that reads like others ("}") moves with its own line, never onto
    /// another line that reads the same.
    @Test func aCommentNeverSlidesOntoAnotherLineThatReadsTheSame() async throws {
        let repo = try TestRepository()
        try repo.write("app.js", "if (a) {\n  go()\n}\n")
        try repo.commitAll("First")
        try repo.write("app.js", "if (a) {\n  go()\n}\nif (b) {\n  stop()\n}\n")
        let box = try await GitTestBox()
        let changes = box.changes(repo.path)
        await changes.refresh()
        let brace = try #require(changes.files.first?.lines.last { $0.text == "}" })
        let comment = ReviewComment(file: "app.js", line: brace.number, side: .new, snippet: "}", text: "Return here?")
        let before = try #require(changes.files.first?.lines)

        try repo.write("app.js", "// Moves\nif (a) {\n  go()\n}\nif (b) {\n  stop()\n}\n")
        await changes.refresh()
        let lines = try #require(changes.files.first?.lines)
        let followed = try #require(ReviewComment.following([comment], from: ["app.js": before], to: ["app.js": lines]).first)
        // Its own brace, the last one, now a line further down; not the first, nor where it was.
        #expect(followed.line == brace.number + 1)
        #expect(lines.last { $0.text == "}" }?.number == followed.line)
    }
}
