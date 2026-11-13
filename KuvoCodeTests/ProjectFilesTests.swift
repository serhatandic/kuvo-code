import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// The project's files, as the panel's file filter and @ mentions list them (C5), from the box the
/// folder is on (this Mac's, the real box), as a phone would ask: in a repository, its files and
/// new ones but not those it ignores, by their names as they are; outside one, every file but the
/// usual heavy folders; and a project folder its repository ignores still lists its files. With
/// several folders, each file after its folder's name. "@" finds them by name. (The box's own
/// checks: Packages/KuvoLink/Tests/Bridge/changes.test.js.)
@MainActor
@Suite struct ProjectFilesTests {
    let box: GitTestBox

    init() async throws {
        box = try await GitTestBox()
    }

    private func paths(_ roots: [URL]) async -> [String] {
        let client = box.client
        return await ProjectFiles.list(roots) { _ in client }.map(\.path).sorted()
    }

    private func mentionable(_ roots: [URL]) async -> [ProjectFiles.File] {
        let client = box.client
        return await ProjectFiles.mentionable(roots) { _ in client }
    }

    @Test func aRepositorysFilesWithoutWhatItIgnores() async throws {
        let repo = try TestRepository()
        try repo.write(".gitignore", "*.log\n")
        try repo.write("src/app.swift", "a\n")
        try repo.write("café notes.md", "b\n")
        try repo.commitAll()
        try repo.write("new.swift", "c\n")
        try repo.write("debug.log", "d\n")
        #expect(await paths([repo.url]) == [".gitignore", "café notes.md", "new.swift", "src/app.swift"])
    }

    @Test func aFolderOutsideGitSkipsHeavyFolders() async throws {
        let folder = AppInfo.testRoot.appending(path: "Folders/plain-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        for path in ["index.html", "js/main.js", "node_modules/lib/index.js"] {
            let file = folder.appending(path: path)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("x".utf8).write(to: file)
        }
        #expect(await paths([folder]) == ["index.html", "js/main.js"])
    }

    /// A project in a folder its repository ignores (a dotfiles repository at home that ignores
    /// everything, say): its files are listed all the same.
    @Test func aProjectItsRepositoryIgnoresListsItsFiles() async throws {
        let repo = try TestRepository()
        try repo.write(".gitignore", "*\n!.gitignore\n")
        try repo.commitAll()
        try repo.write("projects/site/index.html", "x\n")
        try repo.write("projects/site/css/style.css", "y\n")
        #expect(await paths([repo.url.appending(path: "projects/site")]) == ["css/style.css", "index.html"])
    }

    @Test func severalFoldersEachByName() async throws {
        let web = try TestRepository(), api = try TestRepository()
        try web.write("index.html", "x\n")
        try api.write("main.go", "y\n")
        let files = await mentionable([web.url, api.url])
        let named = files.map(\.mention)
        #expect(named.contains(web.url.lastPathComponent + "/"))
        #expect(named.contains("index.html"), "the primary folder's files by their paths there")
        #expect(named.contains(api.url.lastPathComponent + "/main.go"))
    }

    /// "@" in the composer: a word starting with it is a mention as it's typed; the files whose
    /// names start with what's typed come first, the primary folder's before another's and shorter
    /// paths before longer; picking one puts its path in, as the agent opens it, and a space.
    @Test func atMentionsAFile() async throws {
        let site = try TestRepository(), api = try TestRepository()
        for path in ["src/App.swift", "src/AppDelegate.swift", "docs/app-notes.md", "src/views/Header.swift"] { try site.write(path, "x\n") }
        try api.write("App.swift", "y\n")
        let files = await mentionable([site.url, api.url])
        let apiName = api.url.lastPathComponent

        let typed = "the crash in @app"
        let query = try #require(Mentions.query(in: typed))
        #expect(query.query == "app")
        let found = Mentions.matches(query.query, in: files)
        #expect(found.map(\.mention) == ["src/App.swift", "docs/app-notes.md", "src/AppDelegate.swift", apiName + "/App.swift"])
        #expect(Mentions.insert(found[0], into: typed) == "the crash in @src/App.swift ")
        #expect(Mentions.insert(found[3], into: typed) == "the crash in @\(apiName)/App.swift ")
        // Anywhere in a path, after the names.
        #expect(Mentions.matches("views", in: files).map(\.mention) == ["src/views/Header.swift"])
        // Before anything's typed: the folders first.
        #expect(Mentions.matches("", in: files).prefix(2).map(\.mention) == [site.url.lastPathComponent + "/", apiName + "/"])

        // Not a mention: an address, or once the word has ended.
        #expect(Mentions.query(in: "write to me@example.com") == nil)
        #expect(Mentions.query(in: "see @src/App.swift ") == nil)
    }

    /// A box answering every request with `status` and `body`.
    private func answering(_ status: Int, _ body: String, box id: String = BoxClient.mac) -> BoxClient {
        BoxClient(box: id, transport: LocalBox { _ in
            AsyncThrowingStream { continuation in
                continuation.yield(.head(status: status, headers: [:]))
                continuation.yield(.body(Data(body.utf8)))
                continuation.finish()
            }
        })
    }

    /// What the filter says when the list can't be read: this Mac's box starting keeps it loading
    /// (`starting`, read again); one from before the list says to wait for its update, or, one
    /// attached in place, that it needs a newer version; a folder its box can't read, why.
    @Test(arguments: [
        (503, #"{"message":"Starting.","reason":"starting"}"#, BoxClient.mac, FolderFailure.starting),
        (404, "{}", BoxClient.mac, FolderFailure.updating),
        (404, "{}", "attached", FolderFailure.olderService),
        (403, "That isn't available over the link.", BoxClient.mac, FolderFailure.updating),
        (403, "That isn't available over the link.", "attached", FolderFailure.olderService),
        // A path refused as not what it seems says nothing: never taken for an older box.
        (403, "", BoxClient.mac, FolderFailure(reason: "It said no (403).")),
        (403, #"{"message":"It can't be read here.","reason":"Permission denied"}"#, BoxClient.mac, FolderFailure.denied),
    ])
    func whyTheListIsntThere(status: Int, body: String, box id: String, failure: FolderFailure) async throws {
        let repo = try TestRepository()
        let client = answering(status, body, box: id)
        let listing = await ProjectFiles.listing([repo.url]) { _ in client }
        #expect(listing.files.isEmpty)
        #expect(listing.failure == failure)
    }

    /// Newest first, by when its box says each last changed.
    @Test func newestFirstByWhatItsBoxSays() async throws {
        let repo = try TestRepository()
        for (name, seconds) in [("old.txt", 1_600_000_000.0), ("new.txt", 1_700_000_000.0), ("middle.txt", 1_650_000_000.0)] {
            try repo.write(name, "x\n")
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: seconds)], ofItemAtPath: repo.url.appending(path: name).path(percentEncoded: false))
        }
        let client = box.client
        #expect(await ProjectFiles.newestFirst([repo.url]) { _ in client }.map(\.path) == ["new.txt", "middle.txt", "old.txt"])
    }

    /// A folder whose name has what a path writes as it is ("site (copy)", "@scope", "a+b"): asked for
    /// as every box writes a path, so one from before the route says it hasn't it; and listed.
    @Test(arguments: ["site (copy)", "@scope, pkg; v1:2 $!*", "a+b & c=d"])
    func aFolderNamedWithMarks(name: String) async throws {
        let folder = AppInfo.testRoot.appending(path: "Folders/\(UUID().uuidString)/\(name)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder.deletingLastPathComponent()) }
        try Data("x".utf8).write(to: folder.appending(path: "index.html"))
        let sent = Sent()
        let recording = BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            sent.add(request.path)
            return AsyncThrowingStream { continuation in
                continuation.yield(.head(status: 404, headers: [:]))
                continuation.yield(.body(Data("{}".utf8)))
                continuation.finish()
            }
        })
        _ = await ProjectFiles.listing([folder]) { _ in recording }
        let path = try #require(sent.paths.first)
        #expect(EngineRoutes.canonical(path) == path, "written as a box writes it")
        #expect(await paths([folder]) == ["index.html"])
    }

    /// A folder with a backslash in its name, which no path to a box carries: said so, never asked.
    @Test func aFolderNoPathCarriesIsNeverAsked() async throws {
        let folder = AppInfo.testRoot.appending(path: "Folders/\(UUID().uuidString)/a\\b")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder.deletingLastPathComponent()) }
        let sent = Sent()
        let recording = BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            sent.add(request.path)
            return AsyncThrowingStream { $0.finish() }
        })
        let listing = await ProjectFiles.listing([folder]) { _ in recording }
        #expect(listing.failure == .unsendable)
        #expect(sent.paths.isEmpty)
    }

    nonisolated private final class Sent: @unchecked Sendable {
        private(set) var paths: [String] = []
        private let lock = NSLock()
        func add(_ path: String) { lock.withLock { paths.append(path) } }
    }
}
