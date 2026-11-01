import AppKit
import OpenCodeKit
import Testing
@testable import KuvoCode

/// An ask to work outside the project names the folder as people know it ("~/other-project"), not
/// the engine's pattern for it ("/Users/me/other-project/*"), and VoiceOver reads it without
/// "slash star". (The card's text and its label for VoiceOver, as its view draws them: SwiftUI
/// builds no accessibility tree for a test to walk without a reader asking.)
@MainActor
@Suite struct OutsideAskCardTests {
    private func card(_ resources: [String], save: [String]? = nil, directory: String = "/tmp/kuvo-tests-outside") throws -> PermissionCard {
        var ask: [String: Any] = ["id": "per_outside", "sessionID": "ses_outside", "action": "external_directory", "resources": resources]
        if let save { ask["save"] = save }
        let request = try JSONDecoder().decode(PermissionRequest.self, from: JSONSerialization.data(withJSONObject: ask))
        return PermissionCard(request: request, directory: directory, reply: { _ in })
    }

    @Test func aFolderOutsideTheProjectShowsAndReadsAsTheFolder() throws {
        let home = NSHomeDirectory()
        let folder = try card(["\(home)/other-project/*"], save: ["\(home)/other-project/*"])
        #expect(folder.allowed.shown == "~/other-project")
        #expect(folder.allowed.spoken == "Home, other-project")
        #expect(folder.alwaysHelp == "Don't ask again for: ~/other-project")

        // A coding agent's ask names files, each on a line; Always saves their folders.
        let files = try card(["\(home)/notes/a.md", "/opt/data/b.csv"], save: ["\(home)/notes/*", "/opt/data/*"])
        #expect(files.allowed.shown == "~/notes/a.md\n/opt/data/b.csv")
        #expect(files.allowed.spoken == "Home, notes, a.md; opt, data, b.csv")
        #expect(files.alwaysHelp == "Don't ask again for: ~/notes, /opt/data")
    }
}
