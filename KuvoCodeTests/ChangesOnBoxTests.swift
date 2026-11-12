import ClientChanges
import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// This Mac's Changes come from its box, as a machine's and a phone's do, so its git runs with the
/// box's care: a repository's own settings (which a download or an agent could have written) start
/// no program as its changes are read, while Commit runs its hooks, as your terminal would.
@MainActor
@Suite struct ChangesOnBoxTests {
    let repo: TestRepository
    let box: GitTestBox

    init() async throws {
        repo = try TestRepository()
        box = try await GitTestBox()
        try repo.write("README.md", "Hello\n")
        try repo.commitAll("Start")
    }

    /// A program the repository names in its settings, which leaves a mark when it runs.
    private func named(_ setting: String) throws -> URL {
        let mark = repo.url.appending(path: ".git/ran-\(setting)")
        let program = repo.url.appending(path: ".git/\(setting).sh")
        try "#!/bin/sh\ntouch '\(mark.path(percentEncoded: false))'\nexit 1\n".write(to: program, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: program.path(percentEncoded: false))
        try repo.git("config", setting, program.path(percentEncoded: false))
        return mark
    }

    @Test func readingTheChangesStartsNoProgramTheRepositoryNames() async throws {
        let ran = try named("core.fsmonitor")
        try repo.write("README.md", "Hello\nWorld\n")
        try repo.write("new.txt", "new\n")
        let changes = box.changes(repo.path)
        for scope in [ProjectChanges.Scope.uncommitted, .unstaged, .staged] {
            changes.scope = scope
            await changes.refresh()
        }
        changes.scope = .uncommitted
        await changes.refresh()
        #expect(changes.files.map(\.path) == ["new.txt", "README.md"])
        #expect(await changes.hasStaged() == false)
        #expect(!FileManager.default.fileExists(atPath: ran.path(percentEncoded: false)), "the repository's fsmonitor ran")
    }

    /// This Mac's background service not running (starting again after an update, say): Changes
    /// says it can't reach it, as for a machine that's away, rather than reading the project as a
    /// folder without git.
    @Test func thisMacsBoxNotRunningReadsAsOutOfReach() async throws {
        try repo.write("README.md", "Hello\nWorld\n")
        let changes = ProjectChanges(directory: repo.path) { id in
            BoxClient(box: id, transport: LocalBox { _ in PhoneLink.boxUnavailable() })
        }
        await changes.refresh()
        #expect(changes.shown == .waiting)
        #expect(changes.isRepository, "not read as a folder without git")
        #expect(await changes.perform(.stage, on: ChangedFile(path: "README.md", status: .modified, url: repo.url.appending(path: "README.md"), root: repo.path))
            == "Kuvo Code’s background service on this Mac isn’t running. Try again in a moment.")
    }

    /// Commit is what you asked for: its hooks run, and one that says no stops it, in its words.
    @Test func commitRunsTheRepositorysHooks() async throws {
        let hook = repo.url.appending(path: ".git/hooks/pre-commit")
        try FileManager.default.createDirectory(at: hook.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\necho 'Lint failed: README.md' >&2\nexit 1\n".write(to: hook, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: hook.path(percentEncoded: false))
        try repo.write("README.md", "Hello\nWorld\n")
        let changes = box.changes(repo.path)
        let failure = await changes.commit(message: "World", push: false, environment: [:])
        #expect(failure?.contains("Lint failed: README.md") == true)
        #expect(try repo.git("log", "-1", "--format=%s").trimmingCharacters(in: .whitespacesAndNewlines) == "Start")
    }
}
