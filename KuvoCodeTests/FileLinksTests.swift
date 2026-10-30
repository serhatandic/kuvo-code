import Foundation
import Testing
@testable import KuvoCode

/// A file a reply names as code (`src/App.swift`, `App.swift:42`) becomes a link that opens it in
/// the side panel, when it's in one of the project's folders; what isn't a file stays code.
@Suite struct FileLinksTests {
    let project: URL
    let api: URL
    var folders: [String] { [project, api].map { $0.path(percentEncoded: false) } }

    init() throws {
        TestEnvironment.prepare()
        let root = AppInfo.testRoot.appending(path: "Links/\(UUID().uuidString)")
        project = root.appending(path: "web")
        api = root.appending(path: "api")
        for (folder, file) in [(project, "src/App.swift"), (project, "package.json"), (api, "README.md")] {
            let url = folder.appending(path: file)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("x\n".utf8).write(to: url)
        }
    }

    @Test(arguments: ["src/App.swift", "src/App.swift:42", "src/App.swift:12-20", "src/App.swift#L10-L20", "package.json"])
    func aProjectsFileLinks(span: String) {
        let url = FileLinks.file(named: span, folders: folders)
        #expect(url?.lastPathComponent == (span.hasPrefix("package") ? "package.json" : "App.swift"))
    }

    /// Another of the project's folders, by its name, as "@" writes them.
    @Test func anotherFolderByItsName() {
        #expect(FileLinks.file(named: "api/README.md", folders: folders)?.path(percentEncoded: false) == api.appending(path: "README.md").path(percentEncoded: false))
    }

    @Test(arguments: ["1.2.3", "..", "https://example.com/app.js", "npm run build", "src", "src/", "missing.swift", "src/Other.swift:3"])
    func whatIsntAFileStaysCode(span: String) {
        #expect(FileLinks.file(named: span, folders: folders) == nil)
    }

    /// In a reply: each code span naming a file, last first, shown by its name and line.
    @Test func aRepliesFiles() throws {
        let reply = try AttributedString(markdown: "Changed `src/App.swift:42` and `api/README.md`; run `npm test`. See [docs](https://example.com).")
        let spans = FileLinks.spans(in: reply, folders: folders)
        #expect(spans.map { String(reply[$0.range].characters) } == ["api/README.md", "src/App.swift:42"])
        #expect(spans.map { FileLinks.label(String(reply[$0.range].characters)) } == ["README.md", "App.swift:42"])
    }

    /// In a project on a machine, a path in a reply is the machine's: never this Mac's file of
    /// the same name (one that's here, as the test's own file is).
    @Test func aMachinesPathNeverOpensThisMacsFile() {
        let onMachine = [RemoteFolder.folder(project.path(percentEncoded: false), on: "lab")]
        let here = project.appending(path: "src/App.swift").path(percentEncoded: false)
        #expect(FileLinks.file(named: here, folders: onMachine) == nil)
        #expect(FileLinks.file(named: "~/.zshrc", folders: onMachine) == nil)
    }
}
