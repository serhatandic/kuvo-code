import Foundation
import KuvoLink
import os
import Testing
@testable import KuvoCode

/// Merge into…, as the Changes panel asks the box the worktree is on (this Mac's, the real box), on
/// real repositories: the branch's commits go into the branch it was made from, a conflict leaves
/// the project's folder as it was and names the files, and a merge of yours under way there is left
/// be. (The box's own checks: box/bridge-tests/changes.test.js; its worktrees'
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

    // MARK: The title bar's branches, and what Delete says

    private var place: GitPlace { GitPlace(client: box.client, path: repo.path, machine: nil) }

    /// The title bar's branch menu, from this Mac's box: a new branch from where it is, with the
    /// changes not committed coming along; switching back; and git's words when it can't.
    @Test func theBranchMenuListsAndSwitchesOnTheBox() async throws {
        try repo.write("a.txt", "one\n")
        try repo.commitAll()
        try repo.write("a.txt", "two\n")
        #expect(await Git.switching(to: "idea", creating: true, at: place) == nil)
        let made = try #require(await Git.branches(at: place))
        #expect(made.repository && made.current == "idea")
        #expect(Set(made.branches) == ["idea", "main"])
        #expect(repo.read("a.txt") == "two\n", "what wasn't committed came along")

        try repo.commitAll("Two")
        #expect(await Git.switching(to: "main", creating: false, at: place) == nil)
        #expect(await Git.branches(at: place)?.current == "main")
        #expect(repo.read("a.txt") == "one\n")
        #expect(await Git.switching(to: "nowhere", creating: false, at: place) != nil)
        #expect(await Git.switching(to: "-f", creating: false, at: place) == "A branch’s name can’t start with “-”.")

        let plain = AppInfo.testRoot.appending(path: "Folders/plain-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: plain, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: plain) }
        #expect(await Git.branches(at: GitPlace(client: box.client, path: plain.path(percentEncoded: false), machine: nil)) == Git.Branches(repository: false))
    }

    /// Delete on a session in its own worktree says whether changes not committed go with it, as
    /// its box says: a new file counts, and so does one it can't say about.
    @Test func deleteAsksTheBoxWhatGoesWithAWorktree() async throws {
        try repo.write("a.txt", "one\n")
        try repo.commitAll()
        #expect(await Git.hasUncommittedChanges(at: place) == false)
        try repo.write("new.txt", "new\n")
        #expect(await Git.hasUncommittedChanges(at: place))
        let gone = GitPlace(client: box.client, path: repo.path + "-gone", machine: nil)
        #expect(await Git.hasUncommittedChanges(at: gone), "can't say: as if there were")
    }

    /// A box answering each request with `answers`' next (the last again once they run out).
    private func answering(_ answers: [(Int, String)], box id: String = BoxClient.mac) -> BoxClient {
        let next = Answers(answers)
        return BoxClient(box: id, transport: LocalBox { _ in
            let (status, body) = next.take()
            return AsyncThrowingStream { continuation in
                continuation.yield(.head(status: status, headers: [:]))
                continuation.yield(.body(Data(body.utf8)))
                continuation.finish()
            }
        })
    }

    nonisolated private final class Answers: @unchecked Sendable {
        private var left: [(Int, String)]
        private let lock = NSLock()
        init(_ answers: [(Int, String)]) { left = answers }
        func take() -> (Int, String) { lock.withLock { left.count > 1 ? left.removeFirst() : left[0] } }
    }

    /// A box held for its update (#679): no git of this Mac's runs, nothing reaches the box; Switch
    /// and Merge into… say the gate's words, Delete says changes may go, the menu lists none.
    @Test func aHeldBoxRunsNoGitAndSaysWhy() async throws {
        try repo.write("a.txt", "one\n")
        try repo.commitAll()
        let id = "held-\(UUID().uuidString)"
        let gates = BoxGates()
        gates.updating(id, detail: "Kuvo Code on this Mac finishes updating once the work running now ends.")
        defer { gates.letGo(id) }
        let asked = OSAllocatedUnfairLock(initialState: 0)
        let reached = BoxClient(box: id, transport: LocalBox { _ in
            asked.withLock { $0 += 1 }
            return AsyncThrowingStream { $0.finish() }
        })
        let there = GitPlace(client: reached, path: repo.path, machine: nil)
        let words = "Updating… Kuvo Code on this Mac finishes updating once the work running now ends."
        #expect(await Git.branches(at: there) == nil)
        #expect(await Git.switching(to: "idea", creating: true, at: there) == words)
        #expect(await Git.hasUncommittedChanges(at: there))
        let tree = Workspace.Worktree(project: repo.path, root: repo.path + "-work", branch: "work", base: "main")
        #expect(await tree.mergeBack(at: there, author: [:]) == .failed(words))
        #expect(try repo.git("branch", "--list", "idea").isEmpty, "nothing switched here")
        #expect(asked.withLock { $0 } == 0)
    }

    /// The branch menu and Edit Project's setup while this Mac's box is starting: they wait for it,
    /// rather than show no branches or no setup.
    @Test func theBranchMenuWaitsWhileThisMacsBoxStarts() async {
        let client = answering([
            (503, #"{"message":"Starting.","reason":"starting"}"#),
            (503, #"{"message":"Starting.","reason":"starting"}"#),
            (200, #"{"repository":true,"root":"/x","current":"main","branches":["main","idea"]}"#),
        ])
        let place = GitPlace(client: client, path: "/x", machine: nil)
        #expect(await Git.branches(at: place, pause: .zero) == Git.Branches(repository: true, current: "main", branches: ["main", "idea"]))
    }

    /// A box's own refusal in plain words is what it says; what went wrong on the way (5xx) isn't.
    @Test func aBoxsPlainWords() {
        #expect(BoxRefusal(status: 405, data: Data("Stop it with POST.".utf8)).message == "Stop it with POST.")
        #expect(BoxRefusal(status: 502, data: Data("TypeError: fetch failed".utf8)).message == "It said no (502).")
        #expect(BoxRefusal(status: 403, data: Data()).message == "It said no (403).")
    }
}
