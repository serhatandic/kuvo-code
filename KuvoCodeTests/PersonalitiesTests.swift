import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// Your personalities, one library on every computer: one made, changed or removed here is noted
/// with when, so the copies on other computers take it; another copy's newer change comes in, and
/// an older one changes nothing (the rules themselves: KuvoLink's PersonalityLibrariesTests); and
/// a phone makes, changes and removes them here as on a machine.
@MainActor
@Suite(.serialized) struct PersonalitiesTests {
    init() { TestEnvironment.prepare() }

    @Test func aChangeHereIsNotedAndAnOlderCopyDoesntUndoIt() throws {
        let folder = AppInfo.testRoot.appending(path: "Personalities/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = Personalities(folder: folder)
        var told = 0
        store.onChange = { told += 1 }
        let owl = try store.add(name: "Night Owl", description: "Works late.")
        let older = store.library
        var changed = owl
        changed.description = "Works late, writes short."
        try store.update(changed)
        #expect((store.personality(owl.id)?.updated ?? 0) > (owl.updated ?? 0))
        #expect(told == 2)
        // A machine's copy from before the change: nothing here changes.
        #expect(store.take(older).isEmpty)
        #expect(store.personality(owl.id)?.description == "Works late, writes short.")
        // Removed: noted, and kept so after the app starts again.
        store.delete(store.personality(owl.id)!)
        #expect(store.personality(owl.id) == nil)
        #expect(Personalities(folder: folder).removed.map(\.id) == [owl.id])
        #expect(store.take(older).isEmpty, "an older copy doesn't bring it back")
        // One made on a machine comes in, with what changed.
        let made = Personality(id: "custom.machine-made", name: "Calm", description: "Unhurried.", symbol: "person.crop.circle", updated: (Date.now.timeIntervalSince1970 * 1000) + 5)
        #expect(store.take(Personalities.Library(personalities: [made])) == [made.id])
        #expect(store.personality(made.id)?.name == "Calm")
        #expect(told == 3, "taking another copy's isn't a change here to send on")
    }

    @Test func aPhoneMakesChangesAndRemovesThemHere() async throws {
        let link = PhoneLink()
        func ask(_ path: String, method: String = "GET", body: String = "") async throws -> (status: Int, json: [String: Any]?) {
            let request = LinkRequest(method: method, path: path, headers: ["content-type": "application/json"], body: Data(body.utf8))
            var status = 0
            var data = Data()
            for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: "http://127.0.0.1:9/")!, password: nil, agents: nil) {
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
        defer { if let kept = Personalities.shared.personality(id) { Personalities.shared.delete(kept) } }
        #expect(made.json?["name"] as? String == "Night Owl")
        #expect(((try await ask("kuvo/personalities").json?["personalities"] as? [[String: Any]]) ?? []).contains { $0["id"] as? String == id })
        #expect(try await ask("kuvo/personalities", method: "POST", body: #"{"name": "No words"}"#).status == 400)
        let changed = try await ask("kuvo/personalities/\(id)", method: "PATCH", body: #"{"description": "Works late, writes short."}"#)
        #expect(changed.json?["description"] as? String == "Works late, writes short.")
        #expect(try await ask("kuvo/personalities/preset.straight", method: "DELETE").status == 404)
        #expect(try await ask("kuvo/personalities/\(id)", method: "DELETE").status == 200)
        #expect(Personalities.shared.personality(id) == nil)
        #expect(Personalities.shared.removed.contains { $0.id == id })
    }
}
