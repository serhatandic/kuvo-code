import ClientChanges
import Foundation
import Testing
@testable import KuvoCode

/// Comments on lines of the changes (B5) stay with their line while the agent goes on editing the
/// file: lines added or removed above it move it, and the comment shows under it and goes to the
/// agent with its new number; one whose line now reads differently stays as written.
@MainActor
@Suite struct ChangesCommentsTests {
    let repo: TestRepository
    let changes: ProjectChanges
    /// This Mac's box, which runs git for it.
    let box: GitTestBox

    init() async throws {
        repo = try TestRepository()
        box = try await GitTestBox()
        changes = box.changes(repo.path)
    }

    /// Each changed file's lines as the panel shows them now, by path.
    private func lines() async -> [String: [DiffLine]] {
        await changes.refresh()
        return Dictionary(changes.files.map { ($0.path, $0.lines) }, uniquingKeysWith: { first, _ in first })
    }

    private func comment(on number: Int, in path: String, _ lines: [String: [DiffLine]]) throws -> ReviewComment {
        let line = try #require(lines[path]?.first { $0.kind != .removed && $0.newNumber == number })
        return ReviewComment(file: path, line: number, side: .new, snippet: line.text.trimmingCharacters(in: .whitespaces), text: "Rename this")
    }

    @Test func aCommentFollowsItsLineWhenTheAgentAddsLinesAboveIt() async throws {
        try repo.write("App.swift", "import SwiftUI\n\nstruct App {}\n")
        try repo.commitAll("Start")
        try repo.write("App.swift", "import SwiftUI\n\nstruct App {}\nlet total = 1\n")
        let before = await lines()
        let comment = try comment(on: 4, in: "App.swift", before)

        // The agent adds a doc comment and an import at the top.
        try repo.write("App.swift", "import Foundation\nimport SwiftUI\n\n/// The app.\nstruct App {}\nlet total = 1\n")
        let now = await lines()
        let moved = try #require(ReviewComment.following([comment], from: before, to: now).first)
        #expect(moved.line == 6)
        #expect(moved.location == "App.swift:6", "the agent is told where the line is now")
        let line = try #require(now["App.swift"]?.first { moved.matches($0) }, "it shows under its line")
        #expect(line.text == "let total = 1")
    }

    /// A line that reads like others (a "}"): the comment stays on its own one, not another "}"
    /// the lines added moved next to its old place.
    @Test func aCommentOnACommonLineStaysOnItsOwn() async throws {
        try repo.write("a.swift", "func a() {\n}\n")
        try repo.commitAll("Start")
        try repo.write("a.swift", "func a() {\n}\nfunc b() {\n}\n")
        let before = await lines()
        let comment = try comment(on: 4, in: "a.swift", before)

        try repo.write("a.swift", "func a() {\n}\n// one\n// two\n// three\nfunc b() {\n}\n")
        let moved = try #require(ReviewComment.following([comment], from: before, to: await lines()).first)
        #expect(moved.line == 7, "b()'s brace, not a()'s")
    }

    /// The line was rewritten: the comment keeps what it was about, and where.
    @Test func aCommentWhoseLineChangedStaysAsWritten() async throws {
        try repo.write("a.swift", "let a = 1\n")
        try repo.commitAll("Start")
        try repo.write("a.swift", "let a = 1\nlet b = 2\n")
        let before = await lines()
        let comment = try comment(on: 2, in: "a.swift", before)

        try repo.write("a.swift", "let a = 1\nlet b = 3\n")
        #expect(ReviewComment.following([comment], from: before, to: await lines()) == [comment])
    }
}
