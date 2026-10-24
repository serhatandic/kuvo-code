import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Settings › Skills, kept by each box (PROTOCOL.md, "Skills"): this Mac's by its own box (the real
/// `kuvo-link.js serve`, run with Node), reached as the page reaches it (`BoxSkills`), the same way
/// as a machine's. The skills an older Kuvo Code added stay where they've always been, so they're
/// the box's as they are, and an older version still finds what's written now. GitHub's collections
/// are browsed and added from through the box. The engine and GitHub are stand-ins, listening on
/// ports of their own so the box can reach them.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SkillsOnBoxTests {
    static let enginePort: UInt16 = 47_955
    static let githubPort: UInt16 = 47_956
    static var github: String { "http://127.0.0.1:\(githubPort)" }
    let engine = StubEngine(port: Int(enginePort))
    let box: TestBox
    let routes: BoxSkills
    /// This Mac's skills folder, where its engine reads them.
    let folder = AppModel.engineFolders.configHome.appending(path: "opencode/skills")

    init() async throws {
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.removeItem(at: AppInfo.testTrash)
        try await StubWeb.listen(port: Self.githubPort)
        box = try await TestBox(engine: engine.url, environment: ["KUVO_TEST_GITHUB": Self.github])
        let client = box.client(engine: engine.url)
        routes = BoxSkills(box: client, library: client)
    }

    private func done() {
        box.stop()
        StubWeb.stopListening(port: Self.githubPort)
        engine.stop()
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.removeItem(at: AppInfo.testTrash)
    }

    private func write(_ text: String, to name: String, from github: [String: String]? = nil) throws {
        let skill = folder.appending(path: name)
        try FileManager.default.createDirectory(at: skill, withIntermediateDirectories: true)
        try Data(text.utf8).write(to: skill.appending(path: "SKILL.md"))
        if let github {
            try JSONSerialization.data(withJSONObject: github.merging(["branch": "main"]) { $1 }).write(to: skill.appending(path: ".kuvo-source.json"))
        }
    }

    /// The skills the engine lists, as it names them.
    private func listed(_ skills: [[String: String]]) throws -> [Skill] {
        try JSONDecoder().decode([Skill].self, from: JSONSerialization.data(withJSONObject: skills))
    }

    @Test func skillsAddedBeforeAreTheBoxsWhereTheyAre() async throws {
        defer { done() }
        // As an older Kuvo Code left them, in this Mac's engine's settings folder.
        try write("---\nname: release-notes\ndescription: Writes the release notes\n---\nKeep them short.\n", to: "release-notes")
        try write("---\nname: pdf\n---\nPDFs.\n", to: "pdf", from: ["repository": "anthropics/skills", "path": "skills/pdf"])

        let read = try await routes.folder()
        #expect(read.folder == folder.path, "this Mac's box reads them where the engine does")
        #expect(read.github == ["pdf": SkillSource(repository: "anthropics/skills", path: "skills/pdf")])

        // What the page says of each skill the engine lists.
        let shown = SkillsShown(read)
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let skills = try listed([
            ["id": "release-notes", "name": "release-notes", "path": folder.appending(path: "release-notes/SKILL.md").path],
            ["id": "pdf", "name": "pdf", "path": folder.appending(path: "pdf/SKILL.md").path],
            ["id": "review", "name": "review", "path": "/builtin/review/SKILL.md"],
            ["id": "claude-one", "name": "claude-one", "path": home + "/.claude/skills/claude-one/SKILL.md"],
        ])
        #expect(skills.map { shown.source(of: $0) } == ["Added here", "anthropics/skills", "Built in", nil])
        #expect(skills.map { shown.isYours($0) } == [true, false, false, false], "only one you wrote is yours to edit")
        #expect(shown.place(of: skills[3]) == "~/.claude/skills")

        // Edited through the box: in its folder, where an older Kuvo Code finds it too.
        #expect(try await routes.text(of: "release-notes").contains("Keep them short."))
        try await routes.write("release-notes", "---\nname: release-notes\n---\nAnd kind.\n", isNew: false)
        #expect(FileManager.default.contents(atPath: folder.appending(path: "release-notes/SKILL.md").path) == Data("---\nname: release-notes\n---\nAnd kind.\n".utf8))
        let taken = await #expect(throws: BoxRefusal.self) { try await routes.write("release-notes", "Again", isNew: true) }
        #expect(taken?.message == "There's a skill called release-notes already.")
        let fromGitHub = await #expect(throws: BoxRefusal.self) { try await routes.write("pdf", "Mine now", isNew: false) }
        #expect(fromGitHub?.message == "pdf came from GitHub, so it isn't edited here.")

        // A new one, then put away: in the box's own trash, kept a while, never the Mac's Trash.
        try await routes.write("changelog", "---\nname: changelog\n---\nOne line each.\n", isNew: true)
        #expect(FileManager.default.fileExists(atPath: folder.appending(path: "changelog/SKILL.md").path))
        try await routes.remove("changelog")
        #expect(!FileManager.default.fileExists(atPath: folder.appending(path: "changelog").path))
        let trash = BoxProcess.home.appending(path: "trash/skills")
        #expect(((try? FileManager.default.contentsOfDirectory(atPath: trash.path)) ?? []).contains { $0.hasPrefix("changelog-") })
        #expect(!FileManager.default.fileExists(atPath: AppInfo.testTrash.path))
    }

    @Test func gitHubsCollectionsBrowsedAndAddedFromThroughTheBox() async throws {
        defer { done() }
        try StubWeb.answer(Self.github + "/repos/acme/skills", json: ["default_branch": "main", "description": "Acme's skills"])
        try StubWeb.answer(Self.github + "/repos/acme/skills/git/trees/main?recursive=1", json: ["tree": [
            ["path": "README.md", "type": "blob"],
            ["path": "skills/pdf/SKILL.md", "type": "blob"], ["path": "skills/pdf/fill.py", "type": "blob"],
            // A copy kept for another tool: listed once, as the one in plain sight.
            ["path": ".claude/skills/pdf/SKILL.md", "type": "blob"],
        ], "truncated": false])
        StubWeb.answer(Self.github + "/acme/skills/main/skills/pdf/SKILL.md", text: "---\nname: pdf\ndescription: Fills PDF forms\n---\nFill them.\n")
        StubWeb.answer(Self.github + "/acme/skills/main/skills/pdf/fill.py", text: "print('hi')\n")
        try StubWeb.answer(Self.github + "/repos/acme/busy", json: ["default_branch": "main"])
        try StubWeb.answer(Self.github + "/repos/acme/busy/git/trees/main?recursive=1", status: 403, json: [:])

        let collections = try await routes.collections()
        #expect(collections.first == SkillCollection(id: "anthropics/skills", owner: "anthropics", name: "skills", title: "Anthropic",
                                                     summary: "The reference set: documents, spreadsheets, slides, PDFs, design and more."))
        #expect(collections.count == 12)

        // Typed by its address on GitHub.
        let listing = try await routes.listing("https://github.com/acme/skills")
        #expect(listing.repository.id == "acme/skills" && listing.repository.summary == "Acme's skills")
        #expect(listing.skills == [CollectionSkill(name: "pdf", path: "skills/pdf", files: ["skills/pdf/SKILL.md", "skills/pdf/fill.py"])])
        #expect(!listing.partial)
        let pdf = try #require(listing.skills.first)
        #expect(await routes.about(pdf, in: listing.repository).description == "Fills PDF forms")

        try await routes.add(pdf, from: listing.repository)
        #expect(FileManager.default.contents(atPath: folder.appending(path: "pdf/fill.py").path) == Data("print('hi')\n".utf8))
        #expect(try await routes.folder().github["pdf"] == SkillSource(repository: "acme/skills", path: "skills/pdf"))
        let again = await #expect(throws: BoxRefusal.self) { try await routes.add(pdf, from: listing.repository) }
        #expect(again?.message == "A skill named pdf is already installed.")

        // What can't be opened says why.
        let notAName = await #expect(throws: BoxRefusal.self) { try await routes.listing("acme") }
        #expect(notAName?.message == "acme wasn't found on GitHub.")
        let missing = await #expect(throws: BoxRefusal.self) { try await routes.listing("acme/missing") }
        #expect(missing?.message == "acme/missing wasn't found on GitHub.")
        let limited = await #expect(throws: BoxRefusal.self) { try await routes.listing("acme/busy") }
        #expect(limited?.message == "GitHub is limiting requests for now. Try again in a while.")
    }

    /// While this Mac's box is stopped, the page says so (with Try Again), and reads again once
    /// it's back.
    @Test func aStoppedBoxSaysSo() async throws {
        defer { done() }
        try write("---\nname: release-notes\n---\nShort.\n", to: "release-notes")
        box.process.stop()
        let stopped = await #expect(throws: BoxRefusal.self) { try await routes.folder() }
        #expect(stopped?.message == "This Mac’s box isn’t running. Try again in a moment.")
        await box.startAgain()
        #expect(try await routes.text(of: "release-notes") == "---\nname: release-notes\n---\nShort.\n")
    }
}
