import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// Your personalities, one library on every computer, kept by this Mac's box as by a machine's:
/// one made, changed or removed here is noted with when, so the copies on other computers take
/// it; another copy's newer change comes in, and an older one changes nothing (the rules
/// themselves: KuvoLink's PersonalityLibrariesTests and the bridge's); a phone makes, changes and
/// removes them here as on a machine; and those kept before the box kept them come with you.
@MainActor
@Suite(.serialized) struct PersonalitiesTests {
    init() { TestEnvironment.prepare() }

    /// A store as the app's is, reaching this Mac's box (`AppModel.wireStores`).
    private func store(on box: SettingsBox) -> Personalities {
        let store = Personalities()
        store.box = { box.client }
        return store
    }

    @Test func aChangeHereIsNotedAndAnOlderCopyDoesntUndoIt() async throws {
        forgetOld()
        defer { forgetOld() }
        let box = try await SettingsBox(port: 47_930)
        defer { box.stop() }
        let store = store(on: box)
        var told: [Set<String>] = []
        store.onChange = { told.append($0) }
        let owl = try await store.add(name: "Night Owl", description: "Works late.")
        #expect(store.personality(owl.id)?.name == "Night Owl", "the picker has it as soon as it's made")
        let older = store.library
        var changed = owl
        changed.description = "Works late, writes short."
        try await store.update(changed)
        #expect((store.personality(owl.id)?.updated ?? 0) > (owl.updated ?? 0))
        #expect(told == [[owl.id], [owl.id]], "each change is told, so its bots hear it")
        // A machine's copy from before the change: nothing here changes.
        #expect(await store.take(older) == [])
        #expect(store.personality(owl.id)?.description == "Works late, writes short.")
        // Removed: noted, and kept so after the app starts again.
        try await store.delete(try #require(store.personality(owl.id)))
        #expect(store.personality(owl.id) == nil)
        let again = self.store(on: box)
        await again.refresh()
        #expect(again.removed.map(\.id) == [owl.id])
        #expect(await store.take(older) == [], "an older copy doesn't bring it back")
        #expect(store.personality(owl.id) == nil)
        // One made on a machine comes in, with what changed.
        let made = Personality(id: "custom.machine-made", name: "Calm", description: "Unhurried.", symbol: "person.crop.circle", updated: (Date.now.timeIntervalSince1970 * 1000) + 5)
        #expect(await store.take(Personalities.Library(personalities: [made])) == [made.id])
        #expect(store.personality(made.id)?.name == "Calm")
        #expect(told.last == [made.id])
    }

    @Test func withoutItsBoxAChangeSaysSoAndNothingIsKept() async throws {
        forgetOld()
        defer { forgetOld() }
        let box = try await SettingsBox(port: 47_937)
        let store = store(on: box)
        let owl = try await store.add(name: "Night Owl", description: "Works late.")
        // Kuvo Code's background service stops (it's starting again, say).
        box.stop()
        do {
            _ = try await store.add(name: "Calm", description: "Unhurried.")
            Issue.record("made with no box to keep it")
        } catch {
            #expect(error.localizedDescription == "Kuvo Code’s background service on this Mac isn’t running. Try again in a moment.")
        }
        #expect(store.custom.map(\.id) == [owl.id], "what was read stays")
        #expect(await store.take(Personalities.Library()) == nil, "a machine's copy isn't taken, and says so")
    }

    /// The app's own store emptied again, as its box's library is (none, after a test).
    private func forgetShared(_ box: SettingsBox) async {
        try? FileManager.default.removeItem(at: Personalities.boxFile)
        let shared = Personalities.shared
        shared.box = { box.client }
        await shared.refresh()
        shared.box = { nil }
    }

    @Test func aPhoneMakesChangesAndRemovesThemHere() async throws {
        forgetOld()
        defer { forgetOld() }
        let box = try await SettingsBox(port: 47_931)
        defer { box.stop() }
        // The app's own, which shows what a phone changes as it's answered.
        let shared = Personalities.shared
        shared.box = { box.client }
        await shared.refresh()
        // As a phone asks, through this Mac's link.
        let link = PhoneLink()
        let engine = try #require(URL(string: box.engine.url + "/"))
        func ask(_ path: String, method: String = "GET", body: String = "") async throws -> (status: Int, json: [String: Any]?) {
            let request = LinkRequest(method: method, path: path, headers: ["content-type": "application/json"], body: Data(body.utf8))
            var status = 0
            var data = Data()
            for try await part in PhoneLink.respond(to: request, link: link, engine: engine, password: "test", agents: nil, asking: Data("a phone".utf8)) {
                switch part {
                case .head(let code, _): status = code
                case .body(let chunk): data += chunk
                }
            }
            return (status, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        let made = try await ask("kuvo/personalities", method: "POST", body: #"{"name": "  Night   Owl ", "description": "Works late."}"#)
        #expect(made.status == 200)
        let id = try #require(made.json?["id"] as? String)
        #expect(made.json?["name"] as? String == "Night Owl")
        #expect(shared.personality(id)?.name == "Night Owl", "the app has it once the phone's told")
        #expect(((try await ask("kuvo/personalities").json?["personalities"] as? [[String: Any]]) ?? []).contains { $0["id"] as? String == id })
        #expect(try await ask("kuvo/personalities", method: "POST", body: #"{"name": "No words"}"#).status == 400)
        let changed = try await ask("kuvo/personalities/\(id)", method: "PATCH", body: #"{"description": "Works late, writes short."}"#)
        #expect(changed.json?["description"] as? String == "Works late, writes short.")
        #expect(shared.personality(id)?.description == "Works late, writes short.")
        #expect(try await ask("kuvo/personalities/preset.straight", method: "DELETE").status == 404)
        #expect(try await ask("kuvo/personalities/\(id)", method: "DELETE").status == 200)
        #expect(shared.personality(id) == nil)
        #expect(shared.removed.contains { $0.id == id })
        // Only the app beside the box reads the library whole.
        #expect(try await ask("kuvo/personalities/document").status == 403)
        await forgetShared(box)
    }

    @Test func yourPersonalitiesRefuseOneThereIsNoRoomFor() async throws {
        forgetOld()
        defer { forgetOld() }
        let box = try await SettingsBox(port: 47_932)
        defer { box.stop() }
        let store = store(on: box)
        let words = String(repeating: "Words. ", count: 285)
        var refused: Error?
        for i in 0..<400 where refused == nil {
            do { _ = try await store.add(name: "P\(i)", description: words) } catch { refused = error }
        }
        #expect(refused?.localizedDescription == "There’s no room for more in your personalities. Shorten or remove one, then try again.")
        let count = store.custom.count
        #expect(count > 100)
        let again = self.store(on: box)
        await again.refresh()
        #expect(again.custom.count == count, "nothing kept of the one refused")
    }

    // MARK: Those kept before the box kept them

    private var oldFile: URL { AppInfo.supportDirectory.appending(path: "personalities.json") }
    private var oldRemovedFile: URL { AppInfo.supportDirectory.appending(path: "personalities-removed.json") }

    /// Yours, those from before and when they were taken in, gone: each test starts with none.
    private func forgetOld() {
        for file in [oldFile, oldRemovedFile, Personalities.boxFile] { try? FileManager.default.removeItem(at: file) }
        UserDefaults.standard.removeObject(forKey: "personalities.takenFromOld")
    }

    /// The old files as an older version wrote them: a plain list, and what was removed.
    private func writeOld(_ personalities: [[String: Any]], removed: [[String: Any]]? = nil, at date: Date) throws {
        try JSONSerialization.data(withJSONObject: personalities).write(to: oldFile)
        try FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: oldFile.path)
        if let removed {
            try JSONSerialization.data(withJSONObject: removed).write(to: oldRemovedFile)
            try FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: oldRemovedFile.path)
        }
    }

    @Test func yoursFromBeforeComeWithYouAndStayWhereTheyWere() async throws {
        forgetOld()
        defer { forgetOld() }
        let old = Date(timeIntervalSince1970: 1_760_000_000)
        // One made before personalities were noted with when, and one removed.
        try writeOld([["id": "custom.owl", "name": "Night Owl", "description": "Works late.", "symbol": "moon"]],
                     removed: [["id": "custom.gone", "removed": 1_759_000_000_000]], at: old)
        Personalities.moveToBox()
        let box = try await SettingsBox(port: 47_933)
        defer { box.stop() }
        let store = store(on: box)
        await store.refresh()
        #expect(store.personality("custom.owl")?.description == "Works late.")
        #expect(store.removed.map(\.id) == ["custom.gone"])
        #expect(FileManager.default.fileExists(atPath: oldFile.path), "a copy stays, for going back to an older version")
        // Deleted since: the old copy, taken in again, doesn't bring it back.
        try await store.delete(try #require(store.personality("custom.owl")))
        try writeOld([["id": "custom.owl", "name": "Night Owl", "description": "Works late.", "symbol": "moon"]], at: old.addingTimeInterval(60))
        await store.takeFromOld()
        #expect(store.personality("custom.owl") == nil)
    }

    @Test func oneAnOlderVersionMadeSinceComesInToo() async throws {
        forgetOld()
        defer { forgetOld() }
        try writeOld([["id": "custom.owl", "name": "Night Owl", "description": "Works late.", "symbol": "moon", "updated": 1_760_000_000_000]],
                     at: Date(timeIntervalSince1970: 1_760_000_000))
        Personalities.moveToBox()
        let box = try await SettingsBox(port: 47_934)
        defer { box.stop() }
        let store = store(on: box)
        // Back on an older version for a while, which made another there.
        try writeOld([["id": "custom.owl", "name": "Night Owl", "description": "Works late.", "symbol": "moon", "updated": 1_760_000_000_000],
                      ["id": "custom.calm", "name": "Calm", "description": "Unhurried.", "symbol": "leaf", "updated": 1_761_000_000_000]],
                     at: Date(timeIntervalSince1970: 1_761_000_000))
        await store.takeFromOld()
        #expect(store.personality("custom.calm")?.name == "Calm")
        #expect(store.personality("custom.owl") != nil)
    }

    @Test func withNoneFromBeforeNothingIsWritten() {
        forgetOld()
        defer { forgetOld() }
        Personalities.moveToBox()
        #expect(!FileManager.default.fileExists(atPath: Personalities.boxFile.path))
    }

    @Test func yoursOnTheBoxAreNeverReplacedByTheOldOnes() throws {
        forgetOld()
        defer { forgetOld() }
        try FileManager.default.createDirectory(at: Personalities.boxFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        let kept = Data(#"{"kuvo":1,"personalities":[],"removed":[]}"#.utf8)
        try kept.write(to: Personalities.boxFile)
        try writeOld([["id": "custom.owl", "name": "Night Owl", "description": "Works late.", "symbol": "moon"]], at: .now)
        Personalities.moveToBox()
        #expect(try Data(contentsOf: Personalities.boxFile) == kept)
    }
}
