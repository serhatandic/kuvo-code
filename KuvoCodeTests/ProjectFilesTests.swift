import Foundation
import Testing
@testable import KuvoCode

/// The project's files, as the panel's file filter and @ mentions list them (C5): in a repository,
/// its files and new ones but not those it ignores, by their names as they are; outside one, every
/// file but the usual heavy folders; and a project folder its repository ignores still lists its
/// files. With several folders, each file after its folder's name. "@" finds them by name.
@Suite struct ProjectFilesTests {
    private func paths(_ roots: [URL]) -> [String] {
        ProjectFiles.list(roots).map(\.path).sorted()
    }

    @Test func aRepositorysFilesWithoutWhatItIgnores() throws {
        let repo = try TestRepository()
        try repo.write(".gitignore", "*.log\n")
        try repo.write("src/app.swift", "a\n")
        try repo.write("café notes.md", "b\n")
        try repo.commitAll()
        try repo.write("new.swift", "c\n")
        try repo.write("debug.log", "d\n")
        #expect(paths([repo.url]) == [".gitignore", "café notes.md", "new.swift", "src/app.swift"])
    }

    @Test func aFolderOutsideGitSkipsHeavyFolders() throws {
        let folder = AppInfo.testRoot.appending(path: "Folders/plain-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        for path in ["index.html", "js/main.js", "node_modules/lib/index.js"] {
            let file = folder.appending(path: path)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("x".utf8).write(to: file)
        }
        #expect(paths([folder]) == ["index.html", "js/main.js"])
    }

    /// A project in a folder its repository ignores (a dotfiles repository at home that ignores
    /// everything, say): its files are listed all the same.
    @Test func aProjectItsRepositoryIgnoresListsItsFiles() throws {
        let repo = try TestRepository()
        try repo.write(".gitignore", "*\n!.gitignore\n")
        try repo.commitAll()
        try repo.write("projects/site/index.html", "x\n")
        try repo.write("projects/site/css/style.css", "y\n")
        #expect(paths([repo.url.appending(path: "projects/site")]) == ["css/style.css", "index.html"])
    }

    @Test func severalFoldersEachByName() throws {
        let web = try TestRepository(), api = try TestRepository()
        try web.write("index.html", "x\n")
        try api.write("main.go", "y\n")
        let files = ProjectFiles.mentionable([web.url, api.url])
        let named = files.map(\.mention)
        #expect(named.contains(web.url.lastPathComponent + "/"))
        #expect(named.contains("index.html"), "the primary folder's files by their paths there")
        #expect(named.contains(api.url.lastPathComponent + "/main.go"))
    }

    /// "@" in the composer: a word starting with it is a mention as it's typed; the files whose
    /// names start with what's typed come first, the primary folder's before another's and shorter
    /// paths before longer; picking one puts its path in, as the agent opens it, and a space.
    @Test func atMentionsAFile() throws {
        let site = try TestRepository(), api = try TestRepository()
        for path in ["src/App.swift", "src/AppDelegate.swift", "docs/app-notes.md", "src/views/Header.swift"] { try site.write(path, "x\n") }
        try api.write("App.swift", "y\n")
        let files = ProjectFiles.mentionable([site.url, api.url])
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
}
