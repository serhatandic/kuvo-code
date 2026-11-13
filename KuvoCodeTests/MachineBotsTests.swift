import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What's a computer's own that its box makes bots with (its kit), as this Mac gives it: a
/// machine's as it connects, this Mac's box's as it starts. The words are the box's own, the same
/// file on every box, which this Mac puts beside each one's bridge.
@MainActor
@Suite(.serialized) struct MachineBotsTests {
    let app = AppModel()

    init() {
        TestEnvironment.prepare()
        app.bots.app = app
    }

    /// A machine's kit names it as this Mac does (what its bots are told they run on) and carries
    /// your time zone, never words of this Mac's: a box tells its bots its own. Nor rules: a new
    /// bot's its box makes from its own default and Settings › Permissions.
    @Test func aMachinesKitCarriesWhatsItsOwnAndNoWords() throws {
        let kit = try JSONSerialization.jsonObject(with: JSONEncoder().encode(app.bots.kit(for: "box"))) as? [String: Any] ?? [:]
        #expect(kit["machine"] as? String == "box")
        #expect(kit["timeZone"] as? String == TimeZone.current.identifier)
        for words in ["instructions", "jobInstructions", "templates", "greeting", "memory", "personalityWords", "identityNote", "rules"] {
            #expect(kit[words] == nil, "\(words) is the box's own")
        }
        // Only the personalities you made: Kuvo Code's own come with the box's words.
        #expect((kit["personalities"] as? [[String: Any]] ?? []).allSatisfy { $0["custom"] as? Bool == true })
        // This Mac's: no machine, and its bots go by its own clock.
        let mac = try JSONSerialization.jsonObject(with: JSONEncoder().encode(app.bots.kit(for: nil))) as? [String: Any] ?? [:]
        #expect(mac["machine"] == nil && mac["zoneinfo"] == nil)
    }

    /// A release for boxes brings the same words this Mac puts beside a machine's bridge, so a box
    /// that updated itself tells its bots what one this Mac set up would.
    @Test func aReleaseBringsTheBoxItsWords() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "box-release-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        try BoxRelease.write(to: folder)
        let words = try BotWords.data
        #expect(try Data(contentsOf: folder.appending(path: "bin/bot-words.json")) == words)
        #expect(!FileManager.default.fileExists(atPath: folder.appending(path: "bin/bot-kit.json").path))
    }
}
