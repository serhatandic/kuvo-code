import Foundation
import Testing
@testable import KuvoCode

/// Settings › Git as this Mac kept it before each computer kept its own: given to a computer's box
/// once, where that computer has none of its own, so nothing you set is lost; tried again until a
/// box takes it, and never again once it has. The box is a real one (`MachineTestBox`).
@Suite(.serialized, .timeLimit(.minutes(1))) struct GitSettingsMoveTests {
    let defaults: UserDefaults
    let suite = "GitSettingsMoveTests-\(UUID().uuidString)"

    init() throws {
        TestEnvironment.prepare()
        defaults = try #require(UserDefaults(suiteName: suite))
        defaults.set("", forKey: GitPreferences.branchPrefixKey)
        defaults.set("Start with the area changed.", forKey: GitPreferences.commitInstructionsKey)
        defaults.set("Add a Testing section.", forKey: GitPreferences.pullRequestInstructionsKey)
    }

    private func clear() { defaults.removePersistentDomain(forName: suite) }

    @Test func aComputerTakesThisMacsOnceAndKeepsItsOwn() async throws {
        defer { clear() }
        let box = try await MachineTestBox(settings: ["pull_request_instructions": "Its own."])
        defer { box.stop() }
        await GitPreferences.move(to: box.client, defaults: defaults)
        let moved = try box.onDisk()
        #expect(moved["branch_prefix"] as? String == "", "no prefix stays no prefix")
        #expect(moved["commit_instructions"] as? String == "Start with the area changed.")
        #expect(moved["pull_request_instructions"] as? String == "Its own.", "the computer's own stays")
        #expect(defaults.stringArray(forKey: GitPreferences.movedKey) == [box.name])

        // Changed there since: this Mac's don't come back.
        let (status, _) = try await box.client.send("PATCH", "kuvo/config", body: JSONSerialization.data(withJSONObject: ["changes": [["path": ["commit_instructions"], "value": "Changed there."]]]))
        #expect(status == 200)
        await GitPreferences.move(to: box.client, defaults: defaults)
        #expect(try box.onDisk()["commit_instructions"] as? String == "Changed there.")
        #expect(defaults.string(forKey: GitPreferences.commitInstructionsKey) != nil, "kept here for a computer added later")
    }

    @Test func oneThatCantBeReachedIsTriedAgain() async throws {
        defer { clear() }
        let away = try await MachineTestBox(name: "away")
        let client = away.client
        away.stop()
        await GitPreferences.move(to: client, defaults: defaults)
        #expect(defaults.stringArray(forKey: GitPreferences.movedKey) == nil)

        let back = try await MachineTestBox(name: "away")
        defer { back.stop() }
        await GitPreferences.move(to: back.client, defaults: defaults)
        #expect(try back.onDisk()["commit_instructions"] as? String == "Start with the area changed.")
        #expect(defaults.stringArray(forKey: GitPreferences.movedKey) == ["away"])
    }
}
