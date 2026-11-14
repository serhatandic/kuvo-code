import ClientText
import Foundation
import Testing

/// The Always button says what it saves: every edit, a command's kind, a folder; short on the
/// button and whole in its hover text and for VoiceOver.
struct AlwaysWordsTests {
    private let home = "/Users/me"

    @Test func anEditsAlwaysIsEveryEditInTheProjectOrForACodingAgentTheConversation() {
        let edit = AlwaysWords.of(action: "edit", save: ["*"], resources: ["sandbox-edit-test/pending-1.txt"], home: home)
        #expect(edit.plain == "Always Allow Edits")
        #expect(edit.help == "Don’t ask again before changing files in this project")
        // One that saved only its file (a box from before) says the same: what it means to you.
        #expect(AlwaysWords.of(action: "write", save: nil, resources: ["a.txt"], home: home).plain == "Always Allow Edits")
        #expect(AlwaysWords.of(action: "patch", save: ["*"], resources: ["a.txt"], home: home, forConversation: true).help == "Don’t ask again before changing files in this conversation")
    }

    @Test func aCommandsAlwaysNamesItsKind() {
        let push = AlwaysWords.of(action: "shell", save: ["git push *"], resources: ["git push origin main"], home: home)
        #expect(push.title == "Always Allow")
        #expect(push.named == "git push")
        #expect(push.plain == "Always Allow git push")
        #expect(push.help == "Don’t ask again before running git push commands in this project")
        #expect(push.spoken == "Always allow git push commands")
        // An exact line, as saved.
        #expect(AlwaysWords.of(action: "shell", save: ["make"], resources: ["make"], home: home).help == "Don’t ask again before running make in this project")
        // Several: named in the hover text.
        let several = AlwaysWords.of(action: "shell", save: ["npm install *", "npm test *"], resources: ["npm install && npm test"], home: home)
        #expect(several.plain == "Always Allow These Commands")
        #expect(several.help == "Don’t ask again in this project before running: npm install, npm test")
        #expect(AlwaysWords.of(action: "shell", save: ["*"], resources: ["ls"], home: home).plain == "Always Allow Commands")
    }

    @Test func aLongNameIsCutOnTheButtonAndWholeInItsHoverText() {
        let long = AlwaysWords.of(action: "shell", save: ["docker compose --project-directory infra up *"], resources: [], home: home)
        #expect(long.named == "docker compose --projec…")
        #expect(long.named!.count == AlwaysWords.longest)
        #expect(long.help.contains("docker compose --project-directory infra up commands"))
        #expect(long.spoken.contains("docker compose --project-directory infra up"))
    }

    /// The same words as the box's notices for phones, case for case (its bridge test reads them too).
    @Test func theBoxSaysTheSame() throws {
        struct Vectors: Decodable {
            struct Case: Decodable { var action: String; var save: [String]?; var resources: [String]; var home: String?; var plain: String }
            var cases: [Case]
        }
        let file = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../KuvoLink/Vectors/always-words.json").standardized
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: file))
        #expect(vectors.cases.count > 10)
        for each in vectors.cases {
            #expect(AlwaysWords.of(action: each.action, save: each.save, resources: each.resources, home: each.home).plain == each.plain, "\(each.action) \(each.save ?? [])")
        }
    }

    @Test func workingOutsideTheProjectNamesTheFolder() {
        let notes = AlwaysWords.of(action: "external_directory", save: ["/Users/me/notes/*"], resources: ["/Users/me/notes/a.md"], home: home)
        #expect(notes.plain == "Always Allow ~/notes")
        #expect(notes.help == "Don’t ask again before working in ~/notes")
        #expect(notes.spoken == "Always allow working in Home, notes")
        let deep = AlwaysWords.of(action: "external_directory", save: ["/Users/me/Developer/clients/acme/website-2026/*"], resources: [], home: home)
        #expect(deep.named == "…/website-2026")
        #expect(deep.help == "Don’t ask again before working in ~/Developer/clients/acme/website-2026")
    }
}
