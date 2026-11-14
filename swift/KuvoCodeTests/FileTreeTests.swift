import Foundation
import Testing
@testable import KuvoCode

/// The panel's Files tab (C5) while the agent works: the tree shows files made, removed or
/// renamed since it was opened, keeps what's open, lists a link to a folder as a folder, and a
/// file removed while shown says it's gone rather than showing nothing.
@MainActor
@Suite struct FileTreeTests {
    let folder: URL

    init() throws {
        TestEnvironment.prepare()
        folder = AppInfo.testRoot.appending(path: "Trees/\(UUID().uuidString)")
        try write("src/app.swift")
        try write("README.md")
    }

    private func write(_ path: String) throws {
        let file = folder.appending(path: path)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("x\n".utf8).write(to: file)
    }

    /// The tree's files and folders, indented by depth.
    private func names(_ tree: FileTree) -> [String] {
        tree.rows.compactMap { row in
            guard case .entry(let entry, let depth) = row else { return nil }
            return String(repeating: "  ", count: depth) + entry.name
        }
    }

    private func entry(_ tree: FileTree, named name: String) -> FileTree.Entry? {
        for row in tree.rows { if case .entry(let entry, _) = row, entry.name == name { return entry } }
        return nil
    }

    @Test func filesTheAgentMakesAndRemovesShowInAnOpenTree() async throws {
        let tree = FileTree(roots: [folder])
        tree.toggle(try #require(entry(tree, named: "src")).url)
        #expect(names(tree) == ["src", "  app.swift", "README.md"])

        try write("src/view.swift")
        try FileManager.default.removeItem(at: folder.appending(path: "README.md"))
        try FileManager.default.moveItem(at: folder.appending(path: "src/app.swift"), to: folder.appending(path: "src/main.swift"))
        await tree.refresh()
        #expect(names(tree) == ["src", "  main.swift", "  view.swift"], "what's open stays open")
    }

    /// A package manager's linked package, a linked folder: it opens like any folder.
    @Test func aLinkToAFolderIsAFolder() throws {
        try write("packages/ui/index.ts")
        try FileManager.default.createSymbolicLink(at: folder.appending(path: "ui"), withDestinationURL: folder.appending(path: "packages/ui"))
        let tree = FileTree(roots: [folder])
        let link = try #require(entry(tree, named: "ui"))
        #expect(link.isDirectory)
        tree.toggle(link.url)
        #expect(names(tree).contains("  index.ts"))
    }

    @Test func aFileRemovedWhileShownSaysItsGone() async throws {
        let file = folder.appending(path: "README.md")
        try FileManager.default.removeItem(at: file)
        guard case .unavailable(let said) = await FileViewer.load(file, from: nil) else {
            Issue.record("a file that's gone should say so")
            return
        }
        #expect(said == "That file isn’t there anymore.")
    }

    /// A README's links in the panel's preview: to a file beside it, up a folder, or from the
    /// project's folder ("/docs/setup.md", as GitHub reads them); a machine's on that machine.
    @Test func aMarkdownFilesLinksOpenTheProjectsFiles() throws {
        let readme = folder.appending(path: "docs/README.md")
        let root = folder.path(percentEncoded: false)
        func linked(_ link: String, from file: URL = readme, root: String = root) throws -> String? {
            FileViewer.linked(try #require(URL(string: link)), from: file, root: root)?.absoluteString
        }
        #expect(try linked("setup.md") == folder.appending(path: "docs/setup.md").absoluteString)
        #expect(try linked("../src/app.swift") == folder.appending(path: "src/app.swift").absoluteString)
        #expect(try linked("/src/app.swift") == folder.appending(path: "src/app.swift").absoluteString)
        #expect(try linked("https://example.com") == nil)

        let machine = RemoteFolder.folder("/home/ada/web", on: "lab")
        let remote = RemoteFolder.url(machine + "/docs/README.md")
        #expect(try linked("../src/app.ts", from: remote, root: machine) == "ssh://lab/home/ada/web/src/app.ts")
        #expect(try linked("/src/app.ts", from: remote, root: machine) == "ssh://lab/home/ada/web/src/app.ts")
    }
}
