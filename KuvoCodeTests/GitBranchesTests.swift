import Foundation
import Testing
@testable import KuvoCode

/// Worktrees' way back, on real repositories: merging back, a conflict leaving the folder as it
/// was; and the pull request page for a remote. (Their branches are named by their box:
/// Packages/KuvoLink/Tests/Bridge/worktrees.test.js.)
@MainActor
@Suite struct GitBranchesTests {
    @Test func mergingBack() throws {
        let repo = try TestRepository()
        try repo.write("a.txt", "one\n")
        try repo.commitAll()
        try repo.git("checkout", "-q", "-b", "work")
        try repo.write("b.txt", "new\n")
        try repo.commitAll("Work")
        try repo.git("checkout", "-q", "main")
        #expect(Git.merge("work", into: repo.path, environment: [:]) == .merged)
        #expect(repo.read("b.txt") == "new\n")
    }

    /// A conflict: the files named as they are (whatever letters or quotes are in their names),
    /// and the folder back as it was (not in the middle of a merge).
    @Test(arguments: ["a.txt", "café ığüş.txt", "say \"hi\".txt"])
    func aConflictLeavesTheFolderAsItWas(name: String) throws {
        let repo = try TestRepository()
        try repo.write(name, "one\n")
        try repo.commitAll()
        try repo.git("checkout", "-q", "-b", "work")
        try repo.write(name, "theirs\n")
        try repo.commitAll("Work")
        try repo.git("checkout", "-q", "main")
        try repo.write(name, "ours\n")
        try repo.commitAll("Main")
        #expect(Git.merge("work", into: repo.path, environment: [:]) == .conflict([name]))
        #expect(repo.read(name) == "ours\n")
        #expect(try repo.status().isEmpty)
        #expect(!repo.exists(".git/MERGE_HEAD"))
    }

    /// Where a remote's pull requests are made, whichever way the remote is written; without the
    /// name, password or port it may carry.
    @Test(arguments: [
        ("git@github.com:acme/app.git", "https://github.com/acme/app"),
        ("https://github.com/acme/app.git", "https://github.com/acme/app"),
        ("https://me:ghp_secret@github.com/acme/app", "https://github.com/acme/app"),
        ("ssh://git@gitlab.com:22/group/sub/app.git", "https://gitlab.com/group/sub/app"),
        ("/local/path/repo", nil),
    ])
    func aRemotesWebPage(remote: String, page: String?) {
        #expect(Git.webPage(of: remote)?.absoluteString == page)
    }
}
