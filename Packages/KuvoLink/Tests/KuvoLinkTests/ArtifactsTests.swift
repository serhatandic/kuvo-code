import Foundation
import Testing
@testable import KuvoLink

/// What a box says its agents made, as the Mac and the phone both read it (`kuvo/artifacts`): a
/// bot's Shelf in its sections, a coding session's outputs without its code, and what each
/// version says it was.
@Suite struct ArtifactsTests {
    /// A list as the box answers it, a version each.
    private static func list(_ items: [(name: String, kind: String, extra: String)]) throws -> [ArtifactSummary] {
        let artifacts = items.enumerated().map { index, item in
            """
            {"id": "art_\(index)", "path": "/w/\(item.name)", "name": "\(item.name)", "kind": "\(item.kind)", "type": "text/plain",
             "where": {"bots": ["bot_a"], "sessions": [], "groups": []}, "gone": null, "updated": \(1000 + index), "versions": 1,
             "latest": {"n": 1, "at": \(1000 + index), "by": {"kind": "agent"}, "via": ["write"], "status": "added", "edits": 1, "size": 3, "hash": "sha256:x", "kept": true}
             \(item.extra)}
            """
        }
        return try JSONDecoder().decode(ArtifactList.self, from: Data("{\"artifacts\": [\(artifacts.joined(separator: ","))], \"next\": null}".utf8)).artifacts
    }

    @Test func aShelfIsItsSectionsInOrderFinalFirstAndItsMemoryFileFirst() throws {
        let shelf = ArtifactWords.shelf(try Self.list([
            ("notes.md", "document", ""),
            ("job.json", "memory", ""),
            ("MEMORY.md", "memory", ""),
            ("report.pdf", "document", #", "pinned": {"by": "bot", "at": 1}"#),
            ("daily.md", "document", #", "living": true"#),
            ("app.ts", "code", ""),
            ("chart.png", "image", ""),
            ("thing", "a-kind-from-later", ""),
        ]))
        #expect(shelf.map(\.section) == [.pinned, .memory, .pages, .documents, .images, .other])
        #expect(shelf[1].artifacts.map(\.name) == ["MEMORY.md", "job.json"])
        #expect(shelf[2].artifacts.map(\.name) == ["daily.md"])
        // Newest first within a section; one of a kind this app doesn't know yet goes last.
        #expect(shelf[5].artifacts.map(\.name) == ["thing", "app.ts"])
    }

    @Test func aCodingSessionShowsWhatItMadeButNotItsCodeOrWhatGitKeeps() throws {
        let made = try Self.list([
            ("app.ts", "code", ""),
            ("README.md", "document", #", "git": true"#),
            ("notes.md", "document", ""),
            ("shot.png", "image", ""),
            ("app.o", "file", ""),
            ("config.ts", "code", #", "shown": 5"#),
        ]).filter(ArtifactWords.isOutput)
        #expect(made.map(\.name) == ["notes.md", "shot.png", "config.ts"])
    }

    @Test func olderThingsShowMoreReadStayWhenTheNewestChange() throws {
        // A first page of two, and the one Show More read after it.
        let all = try Self.list([("old.md", "document", ""), ("middle.md", "document", ""), ("new.md", "document", "")])
        let shown = [all[2], all[1], all[0]]
        // Then middle.md changes again (now newest) and fresh.md is made: the first page comes again.
        var middle = all[1]
        middle.updated = 2000
        var fresh = all[2]
        fresh.id = "art_fresh"
        fresh.name = "fresh.md"
        fresh.updated = 1999
        let firstPage = try JSONDecoder().decode(ArtifactList.self, from: JSONEncoder().encode(ArtifactListShape(artifacts: [middle, fresh])))
        #expect(firstPage.keeping(shown).map(\.name) == ["middle.md", "fresh.md", "new.md", "old.md"])
    }

    @Test func aBotsMemoryIsCalledByItsBotsName() throws {
        let memory = try Self.list([("MEMORY.md", "memory", ""), ("notes.md", "memory", "")])
        // In a group chat, whose memory it is matters; on its own Shelf too, it reads as the bot's.
        #expect(ArtifactWords.name(memory[0].header, bot: "Ben") == "Ben’s memory")
        #expect(ArtifactWords.name(memory[0].header) == "Its memory")
        #expect(ArtifactWords.name(memory[1].header, bot: "Ben") == "notes.md")
    }

    @Test func eachVersionSaysWhatHappenedToIt() throws {
        let decode = { (json: String) in try JSONDecoder().decode(ArtifactVersion.self, from: Data(json.utf8)) }
        let base = #""at": 1, "via": ["write"], "edits": 1, "size": 1, "hash": null, "kept": true"#
        #expect(ArtifactWords.what(try decode(#"{"n": 1, "by": {"kind": "agent"}, "status": "added", \#(base)}"#), bot: "Ada") == "Ada wrote it")
        #expect(ArtifactWords.what(try decode(#"{"n": 1, "by": {"kind": "agent"}, "status": "added", "at": 1, "via": ["browser_screenshot"], "edits": 1, "size": 1, "hash": null, "kept": true}"#), bot: "Pixel") == "Pixel took it")
        #expect(ArtifactWords.what(try decode(#"{"n": 1, "by": {"kind": "agent"}, "status": "added", "at": 1, "via": ["download"], "edits": 1, "size": 1, "hash": null, "kept": true}"#), bot: "Ada") == "Ada downloaded it")
        #expect(ArtifactWords.what(try decode(#"{"n": 2, "by": {"kind": "agent"}, "status": "modified", "at": 1, "via": ["edit"], "edits": 3, "size": 1, "hash": null, "kept": true}"#)) == "Changed it 3 times")
        #expect(ArtifactWords.what(try decode(#"{"n": 4, "by": {"kind": "you"}, "status": "modified", "restored": 1, \#(base)}"#)) == "You put back version 1")
        #expect(ArtifactWords.what(try decode(#"{"n": 0, "by": {"kind": "outside"}, "status": "added", "before": true, \#(base)}"#)) == "Before it was changed")
        // A reason this app doesn't know yet still reads.
        #expect(try decode(#"{"n": 1, "by": {"kind": "agent"}, "status": "added", "reason": "a-reason-from-later", \#(base)}"#).reason == .other)
        // So does what happened to it, from a newer box: the list it's in still shows.
        let later = try decode(#"{"n": 2, "by": {"kind": "agent"}, "status": "a-status-from-later", \#(base)}"#)
        #expect(later.status == .other)
        #expect(ArtifactWords.what(later, bot: "Ada") == "Ada changed it")
    }
}

/// A list as a box sends it, for a page made here.
private struct ArtifactListShape: Encodable {
    var artifacts: [ArtifactSummary]
    var next: String?
}
