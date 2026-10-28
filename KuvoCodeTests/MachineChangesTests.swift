import ClientChanges
import Foundation
import Testing
@testable import KuvoCode

/// Changes for a project on a machine comes from the machine's box, as a phone's does: what changed
/// (an edit, a new file read from the box), staging a file, a picture's old side, and a commit.
/// The box is the real one, run with Node, with the machine's own git; only the SSH hop to it is
/// a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct MachineChangesTests {
    let repo: TestRepository
    let root: String

    init() throws {
        repo = try TestRepository()
        // Its own name: the machine's box runs git with none of this Mac's settings.
        try repo.git("config", "user.name", "Ada")
        try repo.git("config", "user.email", "ada@example.com")
        try repo.write("README.md", "Hello\n")
        try Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0x00]).write(to: repo.url.appending(path: "logo.png"))
        try repo.commitAll("First")
        root = RemoteFolder.folder(repo.path, on: "lab")
    }

    @Test func aMachinesChangesComeFromItsBox() async throws {
        let box = try await MachineTestBox()
        defer { box.stop() }
        let client = box.client
        try repo.write("README.md", "Hello\nWorld\n")
        try repo.write("notes/todo.txt", "one\ntwo\n")

        guard case .listed(let files, let uncommitted) = await Git.found(in: root, scope: .uncommitted, base: nil, box: { _ in client }) else {
            Issue.record("the box should list the changes")
            return
        }
        let read = await Git.readNew(files) { _ in client }
        #expect(uncommitted, "something isn't committed")
        #expect(read.map(\.path) == ["notes/todo.txt", "README.md"])
        let edit = try #require(read.first { $0.path == "README.md" })
        // Where git says the repository is (its real path, the temporary folder's links resolved).
        let resolved = try #require(realpath(repo.path, nil))
        defer { free(resolved) }
        let real = RemoteFolder.folder(String(cString: resolved), on: "lab")
        #expect(edit.url == RemoteFolder.url(real).appending(path: "README.md"), "opens on the machine")
        #expect(edit.lines.filter { $0.kind == .added }.map(\.text) == ["World"])
        #expect(edit.lines.contains { $0.kind == .context && $0.text == "Hello" }, "the whole file, to fold")
        let new = try #require(read.first { $0.path == "notes/todo.txt" })
        #expect(new.status == .added && new.lines.map(\.text) == ["one", "two"])
        #expect(new.hash != nil, "read again only when it changes")

        // Stage: it moves to Staged, there on the machine.
        #expect(await Git.performing(.stage, on: edit, root: try #require(edit.root), scope: .unstaged) { _ in client } == nil)
        #expect(try repo.status().contains("M  README.md"))
        guard case .listed(let staged, _) = await Git.found(in: root, scope: .staged, base: nil, box: { _ in client }) else {
            Issue.record("the box should list what's staged")
            return
        }
        #expect(staged.map(\.path) == ["README.md"])
    }

    @Test func aMachinesPictureShowsItsOldSideAndItCommitsThere() async throws {
        let box = try await MachineTestBox()
        defer { box.stop() }
        let client = box.client
        try Data("not a picture".utf8).write(to: repo.url.appending(path: "logo.png"))
        guard case .listed(let files, _) = await Git.found(in: root, scope: .uncommitted, base: nil, box: { _ in client }) else {
            Issue.record("the box should list the changes")
            return
        }
        let picture = try #require(files.first { $0.path == "logo.png" })
        let old = try #require(picture.oldObject)
        #expect(await Git.shown(old, in: root) { _ in client } == Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0x00]))

        let wouldTake = await Git.commitDiffing(in: root) { _ in client }
        #expect(!wouldTake.staged && wouldTake.diff.contains("logo.png"))
        #expect(await Git.committing(message: "New logo", push: false, in: root, environment: [:]) { _ in client } == nil)
        #expect(try repo.status().isEmpty)
        #expect(try repo.git("log", "-1", "--format=%s") == "New logo\n")
        // Nothing left to commit: git's words, as it said them.
        let refused = await Git.committing(message: "Again", push: false, in: root, environment: [:]) { _ in client }
        #expect(refused?.contains("nothing to commit") == true)
    }

    /// A new file edited between two looks shows what it says now, not what was read before; one
    /// unchanged since reads the same.
    @Test func aMachinesNewFileEditedSinceShowsItsNewWords() async throws {
        let box = try await MachineTestBox()
        defer { box.stop() }
        let client = box.client
        try repo.write("notes/todo.txt", "one\n")
        try repo.write("notes/done.txt", "shipped\n")
        let first = try await newFiles(known: [:], client)
        try repo.write("notes/todo.txt", "one\ntwo\n")
        let again = try await newFiles(known: Git.kept(first), client)
        #expect(again.first { $0.path == "notes/todo.txt" }?.lines.map(\.text) == ["one", "two"])
        #expect(again.first { $0.path == "notes/done.txt" }?.lines.map(\.text) == ["shipped"])
    }

    /// Unstage and Discard on a machine's file, from the Mac: done there, in its repository.
    @Test func aMachinesFileUnstagesAndDiscardsThere() async throws {
        let box = try await MachineTestBox()
        defer { box.stop() }
        let client = box.client
        try repo.write("README.md", "Hello\nWorld\n")
        try repo.git("add", "README.md")

        guard case .listed(let staged, _) = await Git.found(in: root, scope: .staged, base: nil, box: { _ in client }) else {
            Issue.record("the box should list what's staged")
            return
        }
        let readme = try #require(staged.first { $0.path == "README.md" })
        #expect(await Git.performing(.unstage, on: readme, root: try #require(readme.root), scope: .staged) { _ in client } == nil)
        #expect(try repo.status().contains(" M README.md"))

        guard case .listed(let unstaged, _) = await Git.found(in: root, scope: .unstaged, base: nil, box: { _ in client }) else {
            Issue.record("the box should list what's changed")
            return
        }
        let edited = try #require(unstaged.first { $0.path == "README.md" })
        #expect(await Git.performing(.discard, on: edited, root: try #require(edited.root), scope: .unstaged) { _ in client } == nil)
        #expect(try repo.status().isEmpty)
        #expect(try String(contentsOf: repo.url.appending(path: "README.md"), encoding: .utf8) == "Hello\n")
    }

    /// The new files' lines as the Mac shows them, read from the box (`known`: those read before).
    private func newFiles(known: [String: ChangedFile], _ client: BoxClient) async throws -> [ChangedFile] {
        guard case .listed(let files, _) = await Git.found(in: root, scope: .uncommitted, base: nil, box: { _ in client }) else {
            Issue.record("the box should list the changes")
            return []
        }
        return await Git.readNew(files, known: known) { _ in client }
    }

    /// A machine whose box can't be reached for a moment isn't taken for a folder with no git: the
    /// list that showed stays.
    @Test func aMachineOutOfReachKeepsItsList() async throws {
        let away = BoxClient(box: "lab", transport: LocalBox { _ in AsyncThrowingStream { $0.finish(throwing: URLError(.networkConnectionLost)) } })
        guard case .unreachable = await Git.found(in: root, scope: .uncommitted, base: nil, box: { _ in away }) else {
            Issue.record("a box out of reach should say so")
            return
        }
    }
}
