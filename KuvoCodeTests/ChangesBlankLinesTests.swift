import ClientChanges
import Foundation
import Testing
@testable import KuvoCode

/// An unchanged blank line keeps its place in the Changes panel, and the lines after it their
/// numbers (which review comments name), whatever your git settings say about blank lines.
@MainActor
@Suite struct ChangesBlankLinesTests {
    @Test func anUnchangedBlankLineKeepsItsPlace() async throws {
        let repo = try TestRepository()
        // Git told to write unchanged blank lines as nothing at all.
        _ = try repo.git("config", "diff.suppressBlankEmpty", "true")
        try repo.write("app.js", "let a = 1\n\nlet b = 2\n")
        try repo.commitAll("Start")
        try repo.write("app.js", "let a = 1\n\nlet b = 3\n")

        let changes = ProjectChanges(directory: repo.path)
        await changes.refresh()
        let row = try #require(changes.files.first)
        #expect(row.lines.map(\.text) == ["let a = 1", "", "let b = 2", "let b = 3"])
        #expect(row.lines.last?.newNumber == 3)
    }
}
