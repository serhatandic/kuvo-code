import ClientChanges
import Foundation
import Testing
@testable import KuvoCode

/// Files with names git writes differently (quoted, escaped, or with " b/" in them) are listed in
/// the Changes panel by their real paths, and Discard takes back that file and no other: a file
/// of the same name elsewhere in the project stays as it is.
@MainActor
@Suite struct ChangesFileNamesTests {
    nonisolated static let names = [
        "Plan b/notes.md",      // " b/" in a folder's name, as in git's header
        "say \"hi\".txt",       // git quotes the name, escaping the quotes
        "back\\slash.txt",      // and the backslash
        "tab\there.txt",        // and a tab
        "café ığüş.txt",        // letters beyond ASCII, which git escapes unless told not to
        "-rf.txt",              // like an option
        "with  two spaces.txt",
    ]

    @Test(arguments: names)
    func aChangedFileIsListedByItsPathAndDiscardTakesOnlyIt(name: String) async throws {
        let repo = try TestRepository()
        try repo.write(name, "one\n")
        // One of the same name elsewhere, changed too.
        try repo.write("notes.md", "root\n")
        try repo.commitAll("Start")
        try repo.write(name, "one\ntwo\n")
        try repo.write("notes.md", "root changed\n")

        let box = try await GitTestBox()
        let changes = box.changes(repo.path)
        await changes.refresh()
        #expect(changes.files.map(\.path).sorted() == [name, "notes.md"].sorted())
        let row = try #require(changes.files.first { $0.path == name }, "listed: \(changes.files.map(\.path))")
        #expect(row.lines.filter { $0.kind == .added }.map(\.text) == ["two"])
        #expect(row.url.resolvingSymlinksInPath().path(percentEncoded: false) == repo.url.appending(path: name).resolvingSymlinksInPath().path(percentEncoded: false))

        let failure = await changes.perform(.discard, on: row)
        #expect(failure == nil)
        #expect(repo.read(name) == "one\n")
        #expect(repo.read("notes.md") == "root changed\n", "Discard must leave the other file alone")
    }

    /// A file moved to a name git quotes: listed at its new path, from its old one.
    @Test func aMoveToANameGitQuotes() async throws {
        let repo = try TestRepository()
        try repo.write("say \"hi\".txt", "hello\n")
        try repo.commitAll("Start")
        try repo.git("mv", "say \"hi\".txt", "say \"bye\".txt")
        let box = try await GitTestBox()
        let changes = box.changes(repo.path)
        await changes.refresh()
        let row = try #require(changes.files.first, "nothing listed")
        #expect(changes.files.count == 1)
        #expect(row.path == "say \"bye\".txt")
        #expect(row.oldPath == "say \"hi\".txt")
        #expect(row.status == .renamed)
        #expect(await changes.perform(.discard, on: row) == nil)
        #expect(repo.read("say \"hi\".txt") == "hello\n")
        #expect(!repo.exists("say \"bye\".txt"))
        #expect(try repo.status().isEmpty)
    }
}
