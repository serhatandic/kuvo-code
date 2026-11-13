import ClientChanges
import ClientDesign
import Foundation
import Testing
@testable import KuvoCode

/// Discard in the Changes panel, on real repositories: what you throw away goes back to the last
/// commit (or, with nothing to go back to, to the Trash), and nothing else changes.
@MainActor
@Suite struct ChangesDiscardTests {
    let repo: TestRepository
    let changes: ProjectChanges
    /// This Mac's box, which runs git for it.
    let box: GitTestBox

    init() async throws {
        repo = try TestRepository()
        try repo.write("README.md", "Hello\n")
        try repo.write("src/app.swift", "let a = 1\n")
        try repo.commitAll("Start")
        box = try await GitTestBox()
        changes = box.changes(repo.path)
    }

    /// The panel's row for `path`, as it lists it now.
    private func row(_ path: String) async throws -> ChangedFile {
        await changes.refresh()
        return try #require(changes.files.first { $0.path == path }, "\(path) isn't listed; listed: \(changes.files.map(\.path))")
    }

    private func discard(_ path: String) async throws {
        let failure = await changes.perform(.discard, on: try await row(path))
        #expect(failure == nil)
    }

    /// Somewhere in the tests' Trash: thrown away, but not lost.
    private func isInTrash(_ name: String) -> Bool {
        let found = FileManager.default.enumerator(atPath: AppInfo.testTrash.path(percentEncoded: false))?
            .contains { ($0 as? String)?.hasSuffix("/" + name) == true }
        return found ?? false
    }

    @Test func aNewFileGoesToTheTrash() async throws {
        let name = "draft-\(UUID().uuidString).txt"
        try repo.write(name, "notes\n")
        try await discard(name)
        #expect(!repo.exists(name))
        #expect(isInTrash(name))
        #expect(try repo.status().isEmpty)
        #expect(changes.files.isEmpty)
    }

    @Test func anEditStagedAndChangedAgainGoesBackToTheCommit() async throws {
        try repo.write("src/app.swift", "let a = 2\n")
        try repo.git("add", "src/app.swift")
        try repo.write("src/app.swift", "let a = 3\n")
        try await discard("src/app.swift")
        #expect(repo.read("src/app.swift") == "let a = 1\n")
        #expect(try repo.status().isEmpty)
    }

    @Test func unstagedScopeKeepsWhatIsStaged() async throws {
        try repo.write("src/app.swift", "let a = 2\n")
        try repo.git("add", "src/app.swift")
        try repo.write("src/app.swift", "let a = 3\n")
        changes.scope = .unstaged
        try await discard("src/app.swift")
        #expect(repo.read("src/app.swift") == "let a = 2\n")
        #expect(try repo.status() == ["M  src/app.swift"])
    }

    @Test func aStagedNewFileLeavesGitAndGoesToTheTrash() async throws {
        let name = "staged-\(UUID().uuidString).txt"
        try repo.write(name, "new\n")
        try repo.git("add", name)
        try await discard(name)
        #expect(!repo.exists(name))
        #expect(try repo.status().isEmpty)
    }

    /// "app/[slug]/page.tsx" is a pattern to git: Discard must take the file itself, not every
    /// page it matches.
    @Test func aPathWithBracketsDiscardsOnlyThatFile() async throws {
        try repo.write("app/[slug]/page.tsx", "one\n")
        try repo.write("app/s/page.tsx", "two\n")
        try repo.commitAll()
        try repo.write("app/[slug]/page.tsx", "one changed\n")
        try repo.write("app/s/page.tsx", "two changed\n")
        try await discard("app/[slug]/page.tsx")
        #expect(repo.read("app/[slug]/page.tsx") == "one\n")
        #expect(repo.read("app/s/page.tsx") == "two changed\n")
    }

    /// A file now a link is listed once, as changed, and Discard puts the file back rather than
    /// throwing the link away and leaving nothing.
    @Test func aFileReplacedByALinkComesBack() async throws {
        try FileManager.default.removeItem(at: repo.url.appending(path: "README.md"))
        try FileManager.default.createSymbolicLink(atPath: repo.url.appending(path: "README.md").path(percentEncoded: false), withDestinationPath: "src/app.swift")
        let listed = try await row("README.md")
        #expect(listed.status == .modified)
        #expect(changes.files.filter { $0.path == "README.md" }.count == 1)
        try await discard("README.md")
        #expect(!repo.isLink("README.md"))
        #expect(repo.read("README.md") == "Hello\n")
        #expect(try repo.status().isEmpty)
    }

    /// A folder where a committed file was: the folder (and what's in it) goes to the Trash, not
    /// deleted for good, and the file comes back.
    @Test func aFolderInAFilesPlaceGoesToTheTrash() async throws {
        let inside = "kept-\(UUID().uuidString).txt"
        try FileManager.default.removeItem(at: repo.url.appending(path: "README.md"))
        try repo.write("README.md/\(inside)", "precious\n")
        try await discard("README.md")
        #expect(repo.read("README.md") == "Hello\n")
        #expect(isInTrash("README.md/\(inside)"))
        #expect(try repo.status().isEmpty)
    }

    /// A file where a committed file's folder was: Discard brings the folder's file back, and the
    /// file in its way goes to the Trash rather than being deleted for good.
    @Test func aFileInAFoldersPlaceGoesToTheTrash() async throws {
        let precious = "precious \(UUID().uuidString)\n"
        try FileManager.default.removeItem(at: repo.url.appending(path: "src"))
        try repo.write("src", precious)
        try await discard("src/app.swift")
        #expect(repo.read("src/app.swift") == "let a = 1\n")
        #expect(trashed(named: "src").contains(precious), "the file named src should be in the Trash")
    }

    /// What's in the Trash under `name`, each file's text.
    private func trashed(named name: String) -> [String] {
        let trash = AppInfo.testTrash
        let found = FileManager.default.enumerator(atPath: trash.path(percentEncoded: false))?.compactMap { $0 as? String } ?? []
        return found.filter { ($0 as NSString).lastPathComponent == name }.compactMap { path in
            (try? Data(contentsOf: trash.appending(path: path))).map { String(decoding: $0, as: UTF8.self) }
        }
    }

    @Test func aMoveGoesBack() async throws {
        try repo.git("mv", "src/app.swift", "src/main.swift")
        let moved = try await row("src/main.swift")
        #expect(moved.status == .renamed)
        try await discard("src/main.swift")
        #expect(repo.read("src/app.swift") == "let a = 1\n")
        #expect(!repo.exists("src/main.swift"))
        #expect(try repo.status().isEmpty)
    }

    @Test func aDeletedFileComesBack() async throws {
        try FileManager.default.removeItem(at: repo.url.appending(path: "src/app.swift"))
        try await discard("src/app.swift")
        #expect(repo.read("src/app.swift") == "let a = 1\n")
        #expect(try repo.status().isEmpty)
    }

    /// A new file too big to read line by line is listed as such, without its lines, and can still
    /// be thrown away.
    @Test func aHugeNewFileIsListedWithoutItsLines() async throws {
        let name = "big-\(UUID().uuidString).log"
        try repo.write(name, String(repeating: "line\n", count: DiffParser.maxLines + 10))
        let big = try await row(name)
        #expect(big.isTooBig)
        #expect(big.lines.isEmpty)
        try await discard(name)
        #expect(!repo.exists(name))
    }

    /// The panel lists what changed, with lines counted, and nothing once it's all committed.
    @Test func theListFollowsTheWorkingTree() async throws {
        try repo.write("src/app.swift", "let a = 1\nlet b = 2\n")
        try repo.write("notes.txt", "a\nb\n")
        await changes.refresh()
        #expect(changes.files.map(\.path) == ["notes.txt", "src/app.swift"])
        #expect(changes.additions == 3)
        #expect(changes.deletions == 0)
        try repo.commitAll()
        await changes.refresh()
        #expect(changes.files.isEmpty)
    }

    /// A submodule with edits of its own: Discard says they're in its own repository, rather than
    /// seeming to work and leaving them.
    @Test func discardOnASubmoduleSaysToDiscardThere() async throws {
        let library = try TestRepository()
        try library.write("lib.swift", "let lib = 1\n")
        try library.commitAll("Library")
        try repo.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", library.path, "lib")
        try repo.commitAll("Add the library")
        try repo.write("lib/lib.swift", "let lib = 2\n")

        let failure = await changes.perform(.discard, on: try await row("lib"))
        #expect(failure == "lib is a submodule: its changes are in its own repository, so discard them there.")
        #expect(repo.read("lib/lib.swift") == "let lib = 2\n", "its edits stay")
    }
}
