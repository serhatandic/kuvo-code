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
        // Written a while ago, so it has a stamp (one changed in the last few seconds is read each look).
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -3600)], ofItemAtPath: repo.url.appending(path: "notes/todo.txt").path(percentEncoded: false))

        guard case .listed(let files, let uncommitted) = await Git.found(at: GitPlace.of(root, box: { _ in client }), scope: .uncommitted, base: nil) else {
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
        #expect(await Git.performing(.stage, on: edit, at: GitPlace.of(try #require(edit.root), box: { _ in client }), scope: .unstaged) == nil)
        #expect(try repo.status().contains("M  README.md"))
        guard case .listed(let staged, _) = await Git.found(at: GitPlace.of(root, box: { _ in client }), scope: .staged, base: nil) else {
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
        guard case .listed(let files, _) = await Git.found(at: GitPlace.of(root, box: { _ in client }), scope: .uncommitted, base: nil) else {
            Issue.record("the box should list the changes")
            return
        }
        let picture = try #require(files.first { $0.path == "logo.png" })
        let old = try #require(picture.oldObject)
        #expect(await Git.shown(old, at: GitPlace.of(root, box: { _ in client })) == Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0x00]))

        let wouldTake = await Git.commitDiffing(at: GitPlace.of(root, box: { _ in client }))
        #expect(!wouldTake.staged && wouldTake.diff.contains("logo.png"))
        #expect(await Git.committing(message: "New logo", push: false, at: GitPlace.of(root, box: { _ in client }), environment: [:]) == nil)
        #expect(try repo.status().isEmpty)
        #expect(try repo.git("log", "-1", "--format=%s") == "New logo\n")
        // Nothing left to commit: git's words, as it said them.
        let refused = await Git.committing(message: "Again", push: false, at: GitPlace.of(root, box: { _ in client }), environment: [:])
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

    /// An install in a project with no .gitignore: hundreds of new files. Each is read from the
    /// box once, and the next look (every few seconds while the panel shows) asks it for none of
    /// them, only for one the agent changes.
    @Test func aMachinesManyNewFilesAreReadOnce() async throws {
        let box = try await MachineTestBox()
        defer { box.stop() }
        let client = box.client
        // Written a while ago: one changed in the last few seconds has no stamp yet, and is read each look.
        let earlier = Date(timeIntervalSinceNow: -3600)
        for index in 0..<600 {
            try repo.write("node_modules/pkg\(index)/index.js", "module.exports = \(index)\n")
            try FileManager.default.setAttributes([.modificationDate: earlier], ofItemAtPath: repo.url.appending(path: "node_modules/pkg\(index)/index.js").path(percentEncoded: false))
        }
        let asked = Asked()
        func look(known: [String: ChangedFile]) async throws -> [ChangedFile] {
            guard case .listed(let files, _) = await Git.found(at: GitPlace.of(root, box: { _ in client }), scope: .uncommitted, base: nil) else {
                Issue.record("the box should list the changes")
                return []
            }
            return await Git.readNew(files, known: known) { _ in asked.add(); return client }
        }
        let first = try await look(known: [:])
        #expect(first.count == 600 && asked.count == 600)
        #expect(first.first { $0.path == "node_modules/pkg42/index.js" }?.lines.map(\.text) == ["module.exports = 42"])

        let again = try await look(known: Git.kept(first))
        #expect(asked.count == 600, "nothing read again: \(asked.count - 600) files")
        #expect(again == first)

        try repo.write("node_modules/pkg7/index.js", "module.exports = 'seven'\n")
        let edited = try await look(known: Git.kept(again))
        #expect(asked.count == 601, "only the edited file read again")
        #expect(edited.first { $0.path == "node_modules/pkg7/index.js" }?.lines.map(\.text) == ["module.exports = 'seven'"])
    }

    /// Whether the machine is back.
    nonisolated private final class Back: @unchecked Sendable {
        var isBack = false
    }

    /// How many files a look read from the box.
    nonisolated private final class Asked: @unchecked Sendable {
        private let lock = NSLock()
        private var asked = 0
        var count: Int { lock.withLock { asked } }
        func add() { lock.withLock { asked += 1 } }
    }

    /// Unstage and Discard on a machine's file, from the Mac: done there, in its repository.
    @Test func aMachinesFileUnstagesAndDiscardsThere() async throws {
        let box = try await MachineTestBox()
        defer { box.stop() }
        let client = box.client
        try repo.write("README.md", "Hello\nWorld\n")
        try repo.git("add", "README.md")

        guard case .listed(let staged, _) = await Git.found(at: GitPlace.of(root, box: { _ in client }), scope: .staged, base: nil) else {
            Issue.record("the box should list what's staged")
            return
        }
        let readme = try #require(staged.first { $0.path == "README.md" })
        #expect(await Git.performing(.unstage, on: readme, at: GitPlace.of(try #require(readme.root), box: { _ in client }), scope: .staged) == nil)
        #expect(try repo.status().contains(" M README.md"))

        guard case .listed(let unstaged, _) = await Git.found(at: GitPlace.of(root, box: { _ in client }), scope: .unstaged, base: nil) else {
            Issue.record("the box should list what's changed")
            return
        }
        let edited = try #require(unstaged.first { $0.path == "README.md" })
        #expect(await Git.performing(.discard, on: edited, at: GitPlace.of(try #require(edited.root), box: { _ in client }), scope: .unstaged) == nil)
        #expect(try repo.status().isEmpty)
        #expect(try String(contentsOf: repo.url.appending(path: "README.md"), encoding: .utf8) == "Hello\n")
    }

    /// The new files' lines as the Mac shows them, read from the box (`known`: those read before).
    private func newFiles(known: [String: ChangedFile], _ client: BoxClient) async throws -> [ChangedFile] {
        guard case .listed(let files, _) = await Git.found(at: GitPlace.of(root, box: { _ in client }), scope: .uncommitted, base: nil) else {
            Issue.record("the box should list the changes")
            return []
        }
        return await Git.readNew(files, known: known) { _ in client }
    }

    /// A machine whose box can't be reached for a moment isn't taken for a folder with no git: the
    /// list that showed stays.
    @Test func aMachineOutOfReachKeepsItsList() async throws {
        let away = BoxClient(box: "lab", transport: LocalBox { _ in AsyncThrowingStream { $0.finish(throwing: URLError(.networkConnectionLost)) } })
        guard case .unreachable = await Git.found(at: GitPlace.of(root, box: { _ in away }), scope: .uncommitted, base: nil) else {
            Issue.record("a box out of reach should say so")
            return
        }
    }

    /// A machine out of reach when Changes first opens is said to be, not taken for a folder
    /// without git (which hides Stage and Discard); its changes show once it's back.
    @Test func aMachineOutOfReachFromTheStartSaysSo() async throws {
        let box = try await MachineTestBox()
        defer { box.stop() }
        let client = box.client
        let away = BoxClient(box: "lab", transport: LocalBox { _ in AsyncThrowingStream { $0.finish(throwing: URLError(.networkConnectionLost)) } })
        let back = Back()
        let changes = ProjectChanges(directory: root) { _ in back.isBack ? client : away }
        try repo.write("README.md", "Hello\nWorld\n")

        await changes.refresh()
        #expect(changes.isLoaded && changes.isUnreachable)
        #expect(changes.isRepository, "not a folder without git")
        #expect(changes.files.isEmpty)

        back.isBack = true
        await changes.refresh()
        #expect(!changes.isUnreachable)
        #expect(changes.files.map(\.path) == ["README.md"])
    }

    /// Out of reach when Changes first opens: its connection shows in the list's place, never "No
    /// Changes" or a folder without git; read once it's back.
    @Test func aMachineAwayBeforeItsChangesAreReadShowsItsConnection() async throws {
        let box = try await MachineTestBox()
        defer { box.stop() }
        let client = box.client
        let asked = Asked()
        let changes = ProjectChanges(directory: root) { _ in asked.add(); return client }
        try repo.write("README.md", "Hello\nWorld\n")
        changes.isAway = true

        await changes.refresh()
        #expect(changes.shown == .waiting)
        #expect(changes.files.isEmpty)
        #expect(asked.count == 0, "its box isn't asked while it's away")

        changes.isAway = false
        await changes.refresh()
        #expect(changes.shown == .list)
        #expect(changes.files.map(\.path) == ["README.md"])
    }

    /// Away after it was read: the list stays as last seen, with when, and its box isn't asked
    /// again (an edit there meanwhile doesn't show) until it's back.
    @Test func aMachineAwayAfterItsChangesWereReadKeepsThemAsLastSeen() async throws {
        let box = try await MachineTestBox()
        defer { box.stop() }
        let client = box.client
        let asked = Asked()
        let changes = ProjectChanges(directory: root) { _ in asked.add(); return client }
        try repo.write("README.md", "Hello\nWorld\n")
        let before = Date.now
        await changes.refresh()
        #expect(changes.shown == .list)
        let read = try #require(changes.read)
        #expect(read >= before)

        changes.isAway = true
        try repo.write("notes.txt", "Later\n")
        let count = asked.count
        await changes.refresh()
        #expect(asked.count == count, "its box isn't asked while it's away")
        #expect(changes.shown == .asLastSeen)
        #expect(changes.files.map(\.path) == ["README.md"])
        #expect(changes.read == read)
        // Its Discard alert or commit form open from before it went: said to wait, nothing done.
        let readme = try #require(changes.files.first)
        #expect(await changes.perform(.discard, on: readme) == ChangesAway.notBack("lab"))
        #expect(await changes.commit(message: "Later", push: false, environment: [:]) == ChangesAway.notBack("lab"))
        #expect(asked.count == count)
        #expect(try repo.status().contains(" M README.md"))
        #expect(ChangesAway.asLastSeen(changes.read, now: read.addingTimeInterval(180), locale: Locale(identifier: "en_US"))
                == "These are its changes as last seen, 3 minutes ago. They can’t be staged or committed until it’s back.")

        changes.isAway = false
        await changes.refresh()
        #expect(changes.shown == .list)
        #expect(changes.files.map(\.path) == ["notes.txt", "README.md"])
    }
}
