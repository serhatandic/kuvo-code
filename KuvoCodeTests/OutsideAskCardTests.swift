import AppKit
import ClientText
import OpenCodeKit
import Testing
@testable import KuvoCode

/// An ask to work outside the project names the folder as people know it ("~/other-project"), not
/// the engine's pattern for it ("/Users/me/other-project/*"), and VoiceOver reads it without
/// "slash star". (The card's text and its label for VoiceOver, as its view draws them: SwiftUI
/// builds no accessibility tree for a test to walk without a reader asking.)
@MainActor
@Suite struct OutsideAskCardTests {
    private func card(_ resources: [String], save: [String]? = nil, action: String = "external_directory", directory: String = "/tmp/kuvo-tests-outside",
                      forConversation: Bool = false) throws -> PermissionCard {
        var ask: [String: Any] = ["id": "per_outside", "sessionID": "ses_outside", "action": action, "resources": resources]
        if let save { ask["save"] = save }
        let request = try JSONDecoder().decode(PermissionRequest.self, from: JSONSerialization.data(withJSONObject: ask))
        return PermissionCard(request: request, directory: directory, forConversation: forConversation, reply: { _, _ in })
    }

    /// Always says what it saves (the user's report: "Always for This" on an edit saved one file,
    /// and the next edit asked again): every edit, a command's kind, as the box now saves them.
    @Test func alwaysNamesWhatItSaves() throws {
        let edit = try card(["sandbox-edit-test/pending-1.txt"], save: ["*"], action: "edit")
        #expect(edit.always.plain == "Always Allow Edits")
        #expect(edit.always.help == "Don’t ask again before changing files in this project")
        // A coding agent's (Claude Code, Codex): for its conversation.
        let agents = try card(["sandbox-edit-test/pending-1.txt"], save: ["*"], action: "edit", forConversation: true)
        #expect(agents.always.help == "Don’t ask again before changing files in this conversation")
        let push = try card(["git push origin main"], save: ["git push *"], action: "shell")
        #expect(push.always.plain == "Always Allow git push")
        #expect(push.always.spoken == "Always allow git push commands")
    }

    @Test func aFolderOutsideTheProjectShowsAndReadsAsTheFolder() throws {
        let home = NSHomeDirectory()
        let folder = try card(["\(home)/other-project/*"], save: ["\(home)/other-project/*"])
        #expect(folder.allowed.shown == "~/other-project")
        #expect(folder.allowed.spoken == "Home, other-project")
        #expect(folder.always.plain == "Always Allow ~/other-project")
        #expect(folder.always.help == "Don’t ask again before working in ~/other-project")

        // A coding agent's ask names files, each on a line; Always saves their folders.
        let files = try card(["\(home)/notes/a.md", "/opt/data/b.csv"], save: ["\(home)/notes/*", "/opt/data/*"])
        #expect(files.allowed.shown == "~/notes/a.md\n/opt/data/b.csv")
        #expect(files.allowed.spoken == "Home, notes, a.md; opt, data, b.csv")
        #expect(files.always.plain == "Always Allow These Folders")
        #expect(files.always.help == "Don’t ask again before working in ~/notes, /opt/data")

        // On a machine, whose home this Mac doesn't know: the folder whole, never this Mac's "~".
        let away = try card(["/home/me/notes/*", "\(home)/other-project/*"], directory: RemoteFolder.folder("/home/me/shop", on: "devbox"))
        #expect(away.allowed.shown == "/home/me/notes\n\(home)/other-project")
        #expect(away.allowed.spoken == "home, me, notes; " + home.split(separator: "/").joined(separator: ", ") + ", other-project")
    }
}
