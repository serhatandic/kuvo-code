import ClientChanges
import Foundation
import Testing
@testable import KuvoCode

/// Create Pull Request, as the Changes panel asks the box the project is on (this Mac's or a
/// machine's, the same box): its confirmation says the base it goes into, a title from the commits
/// and what Create will do there; Create then pushes, and makes it with `gh` when that's signed in
/// on the box, else gives GitHub's page. The box is the real one, run with Node; `gh` and GitHub's
/// remote are stand-ins.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PullRequestTests {
    let repo: TestRepository
    let remote: TestRepository
    let bin: URL

    init() throws {
        repo = try TestRepository()
        remote = try TestRepository()
        try remote.git("config", "receive.denyCurrentBranch", "ignore")
        try repo.git("config", "user.name", "Ada")
        try repo.git("config", "user.email", "ada@example.com")
        try repo.write("README.md", "Hello\n")
        try repo.commitAll("First")
        // GitHub's, as the remote reads, pushed to a folder here.
        try repo.git("remote", "add", "origin", "git@github.com:kuvo-test/app.git")
        try repo.git("config", "remote.origin.pushurl", remote.path)
        try repo.git("push", "-q", "-u", "origin", "main")
        try repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
        try repo.git("checkout", "-q", "-b", "dark-mode")
        try repo.write("README.md", "Hello\nDark\n")
        try repo.commitAll("Add a dark mode")
        // In the remote's folder, removed with it.
        bin = remote.url.appending(path: "bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
    }

    /// GitHub's `gh` on the box: signed in (and making #7), or not.
    func gh(signedIn: Bool) throws {
        let script = signedIn
            ? "#!/bin/sh\n[ \"$1\" = auth ] && exit 0\necho https://github.com/kuvo-test/app/pull/7\n"
            : "#!/bin/sh\necho 'You are not logged into any GitHub hosts.' >&2\nexit 1\n"
        let file = bin.appending(path: "gh")
        try Data(script.utf8).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path(percentEncoded: false))
    }

    @Test func withoutGhSignedInItSaysSoAndOpensGitHubsPage() async throws {
        try gh(signedIn: false)
        let box = try await MachineTestBox(environment: ["PATH": "\(bin.path(percentEncoded: false)):/usr/bin:/bin"])
        defer { box.stop() }

        let draft = try await PullRequests.draft(on: box.client, directory: repo.path)
        #expect(draft.branch == "dark-mode" && draft.base == "main")
        #expect(draft.title == "Add a dark mode")
        #expect(draft.what(on: "lab") == "GitHub’s gh isn’t signed in on lab, so this pushes dark-mode and opens GitHub’s page to create it there.")
        #expect(draft.action == "Push and Open GitHub")
        #expect(try remote.git("branch", "--list", "dark-mode").isEmpty, "nothing pushed before Create")

        let made = try await PullRequests.create(on: box.client, directory: repo.path, title: "Dark mode", body: "Follows the system")
        #expect(made == .toOpen(URL(string: "https://github.com/kuvo-test/app/compare/main...dark-mode?expand=1&title=Dark+mode&body=Follows+the+system")!))
        #expect(try remote.git("log", "-1", "--format=%s", "dark-mode").trimmingCharacters(in: .whitespacesAndNewlines) == "Add a dark mode")
    }

    @Test func withGhSignedInTheBoxCreatesIt() async throws {
        try gh(signedIn: true)
        let box = try await MachineTestBox(environment: ["PATH": "\(bin.path(percentEncoded: false)):/usr/bin:/bin"])
        defer { box.stop() }

        let draft = try await PullRequests.draft(on: box.client, directory: repo.path)
        #expect(draft.creates)
        #expect(draft.what(on: "lab") == "Pushes dark-mode and creates the pull request on GitHub.")
        #expect(draft.action == "Create Pull Request")
        #expect(try await PullRequests.create(on: box.client, directory: repo.path, title: "Dark mode", body: "") == .made(URL(string: "https://github.com/kuvo-test/app/pull/7")!))
    }

    @Test func aBranchWithNothingNewIsRefusedBeforeAnythingIsPushed() async throws {
        try repo.git("checkout", "-q", "-b", "empty", "main")
        let box = try await MachineTestBox()
        defer { box.stop() }
        await #expect {
            try await PullRequests.draft(on: box.client, directory: repo.path)
        } throws: { error in
            error.localizedDescription == "empty has nothing main doesn’t have yet."
        }
    }
}
