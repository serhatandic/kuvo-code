import Foundation
import KuvoLink
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
        #expect(read.folders == ["pdf", "release-notes"])

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
        // A folder there the engine doesn't list (no SKILL.md yet) is a name a new skill can't take,
        // flagged as it's typed.
        try FileManager.default.createDirectory(at: folder.appending(path: "half-made"), withIntermediateDirectories: true)
        let taken = SkillsShown(try await routes.folder()).taken(listed: skills)
        #expect(taken.isSuperset(of: ["half-made", "release-notes", "review", "claude-one"]))

        // Edited through the box: in its folder, where an older Kuvo Code finds it too.
        #expect(try await routes.text(of: "release-notes").contains("Keep them short."))
        try await routes.write("release-notes", "---\nname: release-notes\n---\nAnd kind.\n", isNew: false)
        #expect(FileManager.default.contents(atPath: folder.appending(path: "release-notes/SKILL.md").path) == Data("---\nname: release-notes\n---\nAnd kind.\n".utf8))
        let again = await #expect(throws: BoxRefusal.self) { try await routes.write("release-notes", "Again", isNew: true) }
        #expect(again?.message == "There’s a skill called release-notes already.")
        let fromGitHub = await #expect(throws: BoxRefusal.self) { try await routes.write("pdf", "Mine now", isNew: false) }
        #expect(fromGitHub?.message == "pdf came from GitHub, so it isn’t edited here.")

        // A new one, then put away: in the box's Recently Deleted, never the Mac's Trash.
        try await routes.write("changelog", "---\nname: changelog\n---\nOne line each.\n", isNew: true)
        #expect(FileManager.default.fileExists(atPath: folder.appending(path: "changelog/SKILL.md").path))
        try await routes.remove("changelog")
        #expect(!FileManager.default.fileExists(atPath: folder.appending(path: "changelog").path))
        let trash = BoxProcess.home.appending(path: "trash/skills")
        #expect(((try? FileManager.default.contentsOfDirectory(atPath: trash.path)) ?? []).contains { $0.hasPrefix("changelog-") })
        #expect(!FileManager.default.fileExists(atPath: AppInfo.testTrash.path))
    }

    /// One whose SKILL.md names it otherwise than its folder is matched by its folder (where it
    /// came from, what Remove takes away); and one removed, which the engine lists a moment
    /// longer, is gone from the page at once rather than shown as one you wrote, whose Edit…
    /// would find nothing.
    @Test func aSkillIsItsFolderAndOneRemovedGoesAtOnce() async throws {
        defer { done() }
        try write("---\nname: pdf\n---\nPDFs.\n", to: "pdf-tools", from: ["repository": "acme/skills", "path": "skills/pdf"])
        try write("---\nname: notes\n---\nNotes.\n", to: "notes")
        let engineLists = try listed([
            ["id": "pdf", "name": "pdf", "path": folder.appending(path: "pdf-tools/SKILL.md").path],
            ["id": "notes", "name": "notes", "path": folder.appending(path: "notes/SKILL.md").path],
        ])
        var shown = SkillsShown(try await routes.folder())
        #expect(shown.source(of: engineLists[0]) == "acme/skills")
        #expect(!shown.isYours(engineLists[0]), "from GitHub: added back, not edited")
        #expect(shown.folder(of: engineLists[0]) == "pdf-tools", "what Remove takes away")

        try await routes.remove("pdf-tools")
        shown = SkillsShown(try await routes.folder())
        #expect(shown.current(engineLists).map(\.id) == ["notes"])
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
        // Each skill with what its SKILL.md says it is, so the page asks for nothing more as it shows them.
        #expect(listing.skills == [CollectionSkill(name: "pdf", path: "skills/pdf", files: ["skills/pdf/SKILL.md", "skills/pdf/fill.py"],
                                                   about: SkillAbout(name: "pdf", description: "Fills PDF forms"))])
        #expect(!listing.partial)
        let pdf = try #require(listing.skills.first)

        try await routes.add(pdf, from: listing.repository)
        #expect(FileManager.default.contents(atPath: folder.appending(path: "pdf/fill.py").path) == Data("print('hi')\n".utf8))
        #expect(try await routes.folder().github["pdf"] == SkillSource(repository: "acme/skills", path: "skills/pdf"))
        let again = await #expect(throws: BoxRefusal.self) { try await routes.add(pdf, from: listing.repository) }
        #expect(again?.message == "A skill named pdf is already installed.")

        // What can't be opened says why.
        let notAName = await #expect(throws: BoxRefusal.self) { try await routes.listing("acme") }
        #expect(notAName?.message == "acme wasn’t found on GitHub.")
        let missing = await #expect(throws: BoxRefusal.self) { try await routes.listing("acme/missing") }
        #expect(missing?.message == "acme/missing wasn’t found on GitHub.")
        let limited = await #expect(throws: BoxRefusal.self) { try await routes.listing("acme/busy") }
        #expect(limited?.message == "GitHub is limiting requests for now. Try again in a while.")
    }

    /// Recently Deleted, as Settings › Skills shows it (`RecentlyDeletedSkills`): a deleted skill
    /// shows with what it says it is and when it goes, Restore brings it back whole, and the box
    /// refusing one (a skill has its name now) is shown with the entry kept.
    @Test func aDeletedSkillIsRestoredFromRecentlyDeleted() async throws {
        defer { done() }
        try write("---\nname: release-notes\ndescription: Writes the release notes. From the commits.\n---\nKeep them short.\n", to: "release-notes")
        try Data("# Notes\n".utf8).write(to: folder.appending(path: "release-notes/template.md"))
        let deleted = RecentlyDeletedSkills(routes: routes)
        await deleted.load()
        #expect(deleted.entries == [], "nothing deleted yet")

        try await routes.remove("release-notes")
        await deleted.load()
        let entry = try #require(deleted.entries?.first)
        #expect(deleted.entries?.count == 1)
        #expect(entry.name == "release-notes" && entry.description == "Writes the release notes. From the commits.")
        #expect(entry.when(calendar: Self.utc) == "Deleted today · goes in 30 days")

        #expect(await deleted.restore(entry))
        #expect(deleted.entries == [] && deleted.refusals.isEmpty)
        #expect(FileManager.default.contents(atPath: folder.appending(path: "release-notes/template.md").path) == Data("# Notes\n".utf8), "back whole")

        // One whose name a skill has now: the box says so, and both stay.
        try await routes.remove("release-notes")
        try await routes.write("release-notes", "---\nname: release-notes\n---\nA new one.\n", isNew: true)
        await deleted.load()
        let old = try #require(deleted.entries?.first)
        #expect(await deleted.restore(old) == false)
        #expect(deleted.refusals[old.id] == "There’s a skill called release-notes now. Delete it first to restore this one.")
        #expect(deleted.entries?.map(\.id) == [old.id], "the entry stays, to restore later")
        #expect(try await routes.text(of: "release-notes") == "---\nname: release-notes\n---\nA new one.\n")
        // Once the new one's deleted, the old one comes back, and its refusal goes.
        try await routes.remove("release-notes")
        await deleted.load()
        #expect(await deleted.restore(old))
        #expect(deleted.refusals.isEmpty)
        #expect(try await routes.text(of: "release-notes").contains("Keep them short."))
    }

    /// The box keeps a deleted skill 30 days from when it was deleted, and the page says how long
    /// it has left; past that, it's gone as the list is read.
    @Test func recentlyDeletedKeepsASkill30Days() async throws {
        defer { done() }
        // Put away at times of the test's choosing: the box names an entry by when it was deleted.
        let trash = BoxProcess.home.appending(path: "trash/skills")
        let now = Int(Date.now.timeIntervalSince1970)
        for (name, days) in [("kept", 3), ("gone", 31)] {
            let entry = trash.appending(path: "\(name)-\(now - days * 86_400)")
            try FileManager.default.createDirectory(at: entry, withIntermediateDirectories: true)
            try Data("---\nname: \(name)\n---\n".utf8).write(to: entry.appending(path: "SKILL.md"))
        }

        let page = RecentlyDeletedSkills(routes: routes)
        await page.load()
        #expect(page.entries?.map(\.folder) == ["kept"])
        let kept = try #require(page.entries?.first)
        #expect(kept.when(calendar: Self.utc) == "Deleted 3 days ago · goes in 27 days")
        #expect(try FileManager.default.contentsOfDirectory(atPath: trash.path) == ["kept-\(now - 3 * 86_400)"], "gone for good")
    }

    /// How long ago, and how long it has left, in calendar days: one deleted late last night was
    /// deleted yesterday, and one that goes early tomorrow goes tomorrow.
    @Test func recentlyDeletedCountsCalendarDays() {
        defer { done() }
        func at(_ text: String) -> Double { ISO8601DateFormatter().date(from: text)!.timeIntervalSince1970 }
        let late = at("2026-10-20T23:30:00Z")
        let entry = DeletedSkill(id: "pdf-\(Int(late))", folder: "pdf", name: "pdf", deleted: late, goes: late + 30 * 86_400)
        let when = { (now: String) in entry.when(now: Date(timeIntervalSince1970: at(now)), calendar: Self.utc) }
        #expect(when("2026-10-20T23:45:00Z") == "Deleted today · goes in 30 days")
        #expect(when("2026-10-21T00:15:00Z") == "Deleted yesterday · goes in 29 days", "an hour later, but another day")
        #expect(when("2026-10-23T12:00:00Z") == "Deleted 3 days ago · goes in 27 days")
        #expect(when("2026-11-18T08:00:00Z") == "Deleted 29 days ago · goes tomorrow")
        #expect(when("2026-11-19T08:00:00Z") == "Deleted 30 days ago · goes today")
    }

    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    /// Many reads of a big collection at once (a phone asking for each skill's description), with
    /// the streams that follow this Mac's box open, never hold up adding a skill.
    @Test func manyReadsAtOnceDontHoldUpAnInstall() async throws {
        defer { done() }
        // GitHub answers a big collection's SKILL.md files only once the install is done.
        let gate = DispatchSemaphore(value: 0)
        let held = Guarded(0)
        defer { for _ in 0..<32 { gate.signal() } }
        try StubWeb.answer(Self.github + "/repos/acme/big", json: ["default_branch": "main"])
        StubWeb.handle(Self.github + "/acme/big/main/") { _, _ in
            held.withLock { $0 += 1 }
            TestPulse.beat()
            gate.wait()
            return StubWeb.Answer(status: 200, body: Data("---\nname: big\n---\n".utf8))
        }
        try StubWeb.answer(Self.github + "/repos/acme/skills", json: ["default_branch": "main"])
        try StubWeb.answer(Self.github + "/repos/acme/skills/git/trees/main?recursive=1", json: ["tree": [["path": "skills/pdf/SKILL.md", "type": "blob"]]])
        StubWeb.answer(Self.github + "/acme/skills/main/skills/pdf/SKILL.md", text: "---\nname: pdf\n---\nFill them.\n")

        // The collection the skill's added from, open already.
        let listing = try await routes.listing("acme/skills")
        let client = box.client(engine: engine.url)
        // What the app follows on this Mac's box all the while.
        let streams = ["kuvo/projects/events", "kuvo/worktrees/events"].map { path in
            Task { for try await _ in client.follow(path) {} }
        }
        defer { streams.forEach { $0.cancel() } }
        let reads = (0..<24).map { index in
            Task { try await client.send("GET", "kuvo/skill-library/acme/big/about?path=skills%2Fs\(index)") }
        }
        // As many as the box reads from GitHub at once are waiting there; the rest wait their turn.
        try await until { held.withLock { $0 } == 16 }

        try await routes.add(try #require(listing.skills.first), from: listing.repository)
        #expect(FileManager.default.fileExists(atPath: folder.appending(path: "pdf/SKILL.md").path))

        for _ in 0..<24 { gate.signal() }
        for read in reads { #expect(try await read.value.status == 200) }
    }

    /// While this Mac's box is stopped, the page says so (with Try Again), and reads again once
    /// it's back.
    @Test func aStoppedBoxSaysSo() async throws {
        defer { done() }
        try write("---\nname: release-notes\n---\nShort.\n", to: "release-notes")
        box.process.stop()
        let stopped = await #expect(throws: BoxRefusal.self) { try await routes.folder() }
        #expect(stopped?.message == "Kuvo Code’s background service on this Mac isn’t running. Try again in a moment.")
        // Recently Deleted says so too, and reads again once the box is back.
        let deleted = RecentlyDeletedSkills(routes: routes)
        await deleted.load()
        #expect(deleted.failure == "Kuvo Code’s background service on this Mac isn’t running. Try again in a moment.")
        #expect(deleted.entries == nil)
        await box.startAgain()
        #expect(try await routes.text(of: "release-notes") == "---\nname: release-notes\n---\nShort.\n")
        await deleted.load()
        #expect(deleted.failure == nil && deleted.entries == [])
    }

    /// The name Settings previews for a new skill is the one every box gives it (the shared vector).
    @Test func aNewSkillsNameIsTheBoxs() throws {
        defer { done() }
        let file = try #require(RouteScenarios.folder).appending(path: "names/skill-names.json")
        let read = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let cases = try #require(read["cases"] as? [[String: String]])
        #expect(cases.count > 8)
        for each in cases { #expect(SkillFile.name(from: each["typed"] ?? "") == each["name"], "\(each["typed"] ?? "")") }
    }
}
