import Foundation
import Testing
@testable import KuvoCode

/// Merge into…, as the Changes panel asks the box the worktree is on (this Mac's, the real box), on
/// real repositories: the branch's commits go into the branch it was made from, a conflict leaves
/// the project's folder as it was and names the files, and a merge of yours under way there is left
/// be. (The box's own checks: Packages/KuvoLink/Tests/Bridge/changes.test.js; its worktrees'
/// branches, worktrees.test.js.)
@MainActor
@Suite struct GitBranchesTests {
    let repo: TestRepository
    let box: GitTestBox

    init() async throws {
        repo = try TestRepository()
        box = try await GitTestBox()
    }

    /// A worktree of the repository on `branch`, made from main, as its box keeps one: the session's
    /// folder in it, as the panel's Merge names it, and the worktree as this Mac knows it.
    private func worktree(_ branch: String = "work", base: String? = "main") async throws -> (place: GitPlace, tree: Workspace.Worktree, folder: URL) {
        let folder = AppInfo.testRoot.appending(path: "Worktrees/\(UUID().uuidString)")
        try repo.git("worktree", "add", "-q", "-b", branch, folder.path(percentEncoded: false))
        var record: [String: Any] = ["project": repo.path, "root": folder.path(percentEncoded: false), "branch": branch]
        if let base { record["base"] = base }
        let (status, _) = try await box.client.send("POST", "kuvo/worktrees/record", body: JSONSerialization.data(withJSONObject: record))
        #expect(status == 200, "the box keeps it")
        return (GitPlace(client: box.client, path: folder.path(percentEncoded: false), machine: nil),
                Workspace.Worktree(project: repo.path, root: folder.path(percentEncoded: false), branch: branch, base: base), folder)
    }

    private func commit(_ name: String, _ text: String, in folder: URL) throws {
        try Data(text.utf8).write(to: folder.appending(path: name))
        for arguments in [["add", "-A"], ["commit", "-q", "-m", "Work"]] {
            let process = Process()
            process.executableURL = URL(filePath: "/usr/bin/git")
            process.arguments = ["-C", folder.path(percentEncoded: false)] + arguments
            try process.run()
            process.waitUntilExit()
            #expect(process.terminationStatus == 0)
        }
    }

    @Test func mergingBack() async throws {
        try repo.write("a.txt", "one\n")
        try repo.commitAll()
        let (place, tree, folder) = try await worktree()
        defer { try? FileManager.default.removeItem(at: folder) }
        try commit("b.txt", "new\n", in: folder)
        #expect(await tree.mergeBack(at: place, author: [:]) == .merged(into: "main"))
        #expect(repo.read("b.txt") == "new\n")
    }

    /// One whose branch it was made from isn't known: its box merges into the one the project's
    /// folder is on, and says which.
    @Test func withoutItsBaseItGoesIntoTheProjectsBranch() async throws {
        try repo.write("a.txt", "one\n")
        try repo.commitAll()
        let (place, tree, folder) = try await worktree(base: nil)
        defer { try? FileManager.default.removeItem(at: folder) }
        try commit("b.txt", "new\n", in: folder)
        #expect(await tree.mergeBack(at: place, author: [:]) == .merged(into: "main"))
        #expect(repo.read("b.txt") == "new\n")
    }

    /// A conflict: the files named as they are (whatever letters or quotes are in their names),
    /// and the folder back as it was (not in the middle of a merge).
    @Test(arguments: ["a.txt", "café ığüş.txt", "say \"hi\".txt"])
    func aConflictLeavesTheFolderAsItWas(name: String) async throws {
        try repo.write(name, "one\n")
        try repo.commitAll()
        let (place, tree, folder) = try await worktree()
        defer { try? FileManager.default.removeItem(at: folder) }
        try commit(name, "theirs\n", in: folder)
        try repo.write(name, "ours\n")
        try repo.commitAll("Main")
        #expect(await tree.mergeBack(at: place, author: [:]) == .conflict([name], into: "main"))
        #expect(repo.read(name) == "ours\n")
        #expect(try repo.status().isEmpty)
        #expect(!repo.exists(".git/MERGE_HEAD"))
    }

    /// A merge you're in the middle of in the project's folder is yours: refused, and left as it is
    /// (never taken back with this one).
    @Test func aMergeOfYoursUnderWayIsLeftBe() async throws {
        try repo.write("a.txt", "one\n")
        try repo.commitAll()
        try repo.git("checkout", "-q", "-b", "theirs")
        try repo.write("a.txt", "theirs\n")
        try repo.commitAll("Theirs")
        try repo.git("checkout", "-q", "main")
        let (place, tree, folder) = try await worktree()
        defer { try? FileManager.default.removeItem(at: folder) }
        try commit("b.txt", "other\n", in: folder)
        try repo.write("a.txt", "ours\n")
        try repo.commitAll("Main")
        #expect(throws: (any Error).self) { try repo.git("merge", "--no-edit", "theirs") }
        #expect(await tree.mergeBack(at: place, author: [:]) == .failed("The project’s folder is in the middle of a merge. Finish it there first."))
        #expect(repo.exists(".git/MERGE_HEAD"), "your merge still under way")
        #expect(!repo.exists("b.txt"))
    }
}
