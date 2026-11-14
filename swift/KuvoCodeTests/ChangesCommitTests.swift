import Foundation
import Testing
@testable import KuvoCode

/// Commit in the Changes panel, on real repositories: what's staged, or everything in the
/// project's folder when nothing is (only that folder, in a bigger repository), and Push, to a
/// remote of the test's own, setting a new branch's upstream.
@MainActor
@Suite struct ChangesCommitTests {
    let repo: TestRepository
    /// This Mac's box, which commits and pushes.
    let box: GitTestBox

    init() async throws {
        repo = try TestRepository()
        box = try await GitTestBox()
        try repo.write("app/main.swift", "print(1)\n")
        try repo.write("docs/notes.md", "notes\n")
        try repo.commitAll("Start")
    }

    private func commit(in directory: String? = nil, push: Bool = false) async -> String? {
        await box.changes(directory ?? repo.path).commit(message: "Change", push: push, environment: [:])
    }

    private func lastCommitFiles() throws -> [String] {
        try repo.git("show", "--name-only", "--format=", "HEAD").split(separator: "\n").map(String.init).sorted()
    }

    @Test func nothingStagedCommitsEverything() async throws {
        try repo.write("app/main.swift", "print(2)\n")
        try repo.write("app/new.swift", "let x = 1\n")
        #expect(await commit() == nil)
        #expect(try lastCommitFiles() == ["app/main.swift", "app/new.swift"])
        #expect(try repo.status().isEmpty)
    }

    @Test func somethingStagedCommitsOnlyThat() async throws {
        try repo.write("app/main.swift", "print(2)\n")
        try repo.write("docs/notes.md", "more notes\n")
        try repo.git("add", "docs/notes.md")
        #expect(await commit() == nil)
        #expect(try lastCommitFiles() == ["docs/notes.md"])
        #expect(try repo.status() == [" M app/main.swift"])
    }

    /// A project that's one folder of a repository: its changes, not the rest's.
    @Test func aProjectInAFolderCommitsOnlyItsOwn() async throws {
        try repo.write("app/main.swift", "print(2)\n")
        try repo.write("docs/notes.md", "more notes\n")
        #expect(await commit(in: repo.url.appending(path: "app").path(percentEncoded: false)) == nil)
        #expect(try lastCommitFiles() == ["app/main.swift"])
        #expect(try repo.status() == [" M docs/notes.md"])
    }

    /// Push: a new branch goes up and tracks its remote's.
    @Test func pushingANewBranchSetsItsUpstream() async throws {
        let remote = try TestRepository()
        try remote.git("config", "receive.denyCurrentBranch", "ignore")
        try repo.git("remote", "add", "origin", remote.path)
        try repo.git("checkout", "-q", "-b", "feature")
        try repo.write("app/main.swift", "print(3)\n")
        #expect(await commit(push: true) == nil)
        #expect(try repo.git("rev-parse", "--abbrev-ref", "feature@{upstream}").trimmingCharacters(in: .whitespacesAndNewlines) == "origin/feature")
        #expect(try remote.git("rev-parse", "feature") == repo.git("rev-parse", "HEAD"))
    }

    /// The Branch scope: everything since the branch left its base, committed or not; not what
    /// the base did meanwhile.
    @Test func theBranchScopeShowsWhatTheBranchChanged() async throws {
        try repo.git("checkout", "-q", "-b", "feature")
        try repo.write("app/feature.swift", "let f = 1\n")
        try repo.commitAll("Feature")
        try repo.git("checkout", "-q", "main")
        try repo.write("docs/notes.md", "main's own\n")
        try repo.commitAll("Main")
        try repo.git("checkout", "-q", "feature")
        try repo.write("app/main.swift", "print(5)\n")
        let changes = box.changes(repo.path)
        changes.scope = .branch
        changes.base = "main"
        await changes.refresh()
        #expect(changes.files.map(\.path) == ["app/feature.swift", "app/main.swift"])
        changes.scope = .uncommitted
        await changes.refresh()
        #expect(changes.files.map(\.path) == ["app/main.swift"])
    }

    /// A commit whose hook leaves something running (a watcher, a background push) finishes, and
    /// the panel goes on: reading git's output to its end used to wait for that to stop, and Commit
    /// spun for as long as it ran.
    @Test func aHookThatLeavesSomethingRunningDoesntHoldUpTheCommit() async throws {
        let pidFile = repo.url.appending(path: ".git/background.pid")
        defer {
            if let pid = (try? String(contentsOf: pidFile, encoding: .utf8)).flatMap({ pid_t($0.trimmingCharacters(in: .whitespacesAndNewlines)) }) {
                kill(pid, SIGKILL)
            }
        }
        let hook = repo.url.appending(path: ".git/hooks/post-commit")
        try FileManager.default.createDirectory(at: hook.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\n/bin/sleep 600 & echo $! > '\(pidFile.path(percentEncoded: false))'\n".write(to: hook, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: hook.path(percentEncoded: false))
        try repo.write("app/main.swift", "print(6)\n")
        #expect(await commit() == nil)
        #expect(try lastCommitFiles() == ["app/main.swift"])
        #expect(FileManager.default.fileExists(atPath: pidFile.path(percentEncoded: false)), "the hook ran, and left its job running")
    }

    /// A push that fails still leaves the commit, and says so.
    @Test func aFailedPushSaysTheCommitIsMade() async throws {
        try repo.git("remote", "add", "origin", repo.url.appending(path: "nowhere").path(percentEncoded: false))
        try repo.write("app/main.swift", "print(4)\n")
        let failure = await commit(push: true)
        #expect(failure?.hasPrefix("Committed, but the push didn’t go through") == true)
        #expect(try lastCommitFiles() == ["app/main.swift"])
    }
}
