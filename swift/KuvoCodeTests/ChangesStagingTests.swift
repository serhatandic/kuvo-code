import ClientChanges
import Foundation
import Testing
@testable import KuvoCode

/// Stage and Unstage in the Changes panel (B5, B7), on real repositories: what you stage is what
/// the Staged scope lists and a commit takes, what you unstage goes back to Unstaged as it is, and
/// a repository with no commits yet works the same. The files themselves never change.
@MainActor
@Suite struct ChangesStagingTests {
    let repo: TestRepository
    let changes: ProjectChanges
    /// This Mac's box, which runs git for it.
    let box: GitTestBox

    init() async throws {
        repo = try TestRepository()
        box = try await GitTestBox()
        changes = box.changes(repo.path)
    }

    private func start() throws {
        try repo.write("a.swift", "let a = 1\n")
        try repo.write("b.swift", "let b = 1\n")
        try repo.commitAll("Start")
    }

    /// What `scope` lists now: each file's path and how it changed.
    private func listed(_ scope: ProjectChanges.Scope) async -> [String] {
        changes.scope = scope
        await changes.refresh()
        return changes.files.map { "\($0.path) \($0.status)" }
    }

    private func perform(_ action: ProjectChanges.Action, on path: String, in scope: ProjectChanges.Scope = .uncommitted) async throws {
        changes.scope = scope
        await changes.refresh()
        let file = try #require(changes.files.first { $0.path == path }, "\(path) isn't listed in \(scope); listed: \(changes.files.map(\.path))")
        let failure = await changes.perform(action, on: file)
        #expect(failure == nil, "\(action) \(path): \(failure ?? "")")
    }

    @Test func stagingAFileMovesItFromUnstagedToStaged() async throws {
        try start()
        try repo.write("a.swift", "let a = 2\n")
        try repo.write("b.swift", "let b = 2\n")
        try await perform(.stage, on: "a.swift")
        #expect(await listed(.staged) == ["a.swift modified"])
        #expect(await listed(.unstaged) == ["b.swift modified"])
        #expect(await listed(.uncommitted) == ["a.swift modified", "b.swift modified"])
        #expect(repo.read("a.swift") == "let a = 2\n")
    }

    /// A new file staged, then unstaged: new to git again, still listed, still there.
    @Test func unstagingANewFileLeavesItNew() async throws {
        try start()
        try repo.write("c.swift", "let c = 1\n")
        try repo.git("add", "c.swift")
        #expect(await listed(.staged) == ["c.swift added"])
        try await perform(.unstage, on: "c.swift", in: .staged)
        #expect(await listed(.staged).isEmpty)
        #expect(await listed(.uncommitted) == ["c.swift added"])
        #expect(try repo.status() == ["?? c.swift"])
        #expect(repo.read("c.swift") == "let c = 1\n")
    }

    @Test func aDeletedFileIsStagedAsDeleted() async throws {
        try start()
        try FileManager.default.removeItem(at: repo.url.appending(path: "b.swift"))
        try await perform(.stage, on: "b.swift")
        #expect(await listed(.staged) == ["b.swift deleted"])
        #expect(try repo.status() == ["D  b.swift"])
    }

    /// Moved with git and changed after: staging takes the move and the change together.
    @Test func aMovedAndChangedFileIsStagedWhole() async throws {
        try start()
        try repo.git("mv", "a.swift", "c.swift")
        try repo.write("c.swift", "let a = 1\nlet c = 2\n")
        try await perform(.stage, on: "c.swift")
        #expect(await listed(.unstaged).isEmpty)
        let staged = await listed(.staged)
        #expect(staged == ["c.swift renamed"])
        #expect(changes.files.first?.oldPath == "a.swift")
    }

    /// A repository with no commits yet: what you stage you can unstage, and committing makes its
    /// first commit.
    @Test func aNewRepositoryStagesUnstagesAndCommits() async throws {
        try repo.write("notes.md", "first\n")
        try repo.git("add", "notes.md")
        #expect(await listed(.staged) == ["notes.md added"])
        try await perform(.unstage, on: "notes.md", in: .staged)
        #expect(try repo.status() == ["?? notes.md"])
        #expect(await listed(.uncommitted) == ["notes.md added"])

        let failure = await changes.commit(message: "First", push: false, environment: [:])
        #expect(failure == nil)
        #expect(try repo.git("log", "--format=%s").trimmingCharacters(in: .whitespacesAndNewlines) == "First")
        #expect(try repo.status().isEmpty)
        #expect(changes.files.isEmpty)
    }
}
