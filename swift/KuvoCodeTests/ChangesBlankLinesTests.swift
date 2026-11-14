import ClientChanges
import Foundation
import Testing
@testable import KuvoCode

/// The Changes panel shows a file's own lines, each in its place with its number (which review
/// comments name), whatever your git settings say: about blank lines, or a converter they show a
/// kind of file through (textconv, as git-crypt or a .docx reader sets up).
@MainActor
@Suite struct ChangesBlankLinesTests {
    @Test func anUnchangedBlankLineKeepsItsPlace() async throws {
        let repo = try TestRepository()
        // Git told to write unchanged blank lines as nothing at all.
        _ = try repo.git("config", "diff.suppressBlankEmpty", "true")
        try repo.write("app.js", "let a = 1\n\nlet b = 2\n")
        try repo.commitAll("Start")
        try repo.write("app.js", "let a = 1\n\nlet b = 3\n")

        let box = try await GitTestBox()
        let changes = box.changes(repo.path)
        await changes.refresh()
        let row = try #require(changes.files.first)
        #expect(row.lines.map(\.text) == ["let a = 1", "", "let b = 2", "let b = 3"])
        #expect(row.lines.last?.newNumber == 3)
    }

    @Test func aFilesOwnLinesNotAConvertersOnes() async throws {
        let repo = try TestRepository()
        _ = try repo.git("config", "diff.shout.textconv", "tr a-z A-Z <")
        try repo.write(".gitattributes", "*.js diff=shout\n")
        try repo.write("app.js", "let a = 1\n")
        try repo.commitAll("Start")
        try repo.write("app.js", "let a = 2\n")

        let box = try await GitTestBox()
        let changes = box.changes(repo.path)
        await changes.refresh()
        let row = try #require(changes.files.first { $0.path == "app.js" })
        #expect(row.lines.map(\.text) == ["let a = 1", "let a = 2"])
    }
}
