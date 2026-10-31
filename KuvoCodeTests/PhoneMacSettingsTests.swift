import Foundation
import KuvoLink
import ServiceManagement
import Testing
@testable import KuvoCode

/// Settings › General's While Agents Work from a phone (keeping this Mac awake, background work;
/// Open at Login and background work are read but never turned on here, which would add the test
/// copy to your login items). (A link for
/// another phone to pair with is this Mac's box's: PhoneLinkBoxTests.)
@MainActor
@Suite(.serialized) struct PhoneMacSettingsTests {
    let link = PhoneLink()

    init() {
        TestEnvironment.prepare()
        UserDefaults.standard.removeObject(forKey: Awake.key)
        // Off, so nothing here reads the link's keys from the Keychain.
        UserDefaults.standard.removeObject(forKey: "phoneLink")
    }

    private func ask(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> (status: Int, json: [String: Any]) {
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data()
        let request = LinkRequest(method: method, path: path, headers: ["content-type": "application/json"], body: data)
        var status = 0
        var answer = Data()
        for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: "http://127.0.0.1:47995/")!, password: nil, agents: nil) {
            switch part {
            case .head(let code, _): status = code
            case .body(let chunk): answer += chunk
            }
        }
        return (status, (try? JSONSerialization.jsonObject(with: answer) as? [String: Any]) ?? [:])
    }

    @Test func keepingThisMacAwake() async throws {
        defer { UserDefaults.standard.removeObject(forKey: Awake.key) }
        let read = try await ask("kuvo/mac")
        #expect(read.status == 200)
        #expect(read.json["keepsAwake"] as? Bool == true, "on unless you turn it off")
        #expect(read.json["openAtLogin"] is Bool)
        let changed = try await ask("kuvo/mac", method: "PATCH", body: ["keepsAwake": false])
        #expect(changed.json["keepsAwake"] as? Bool == false)
        #expect(!Awake.isOn)
        #expect(try await ask("kuvo/mac", method: "POST").status == 405)
    }

    /// Background work as Settings › General shows it, for a phone: on, not running this time,
    /// waiting for your OK in Login Items, or off; a phone can't turn it off (that's macOS's switch
    /// on the Mac), and one from before it can't bring back Open at Login, which it replaced.
    /// (Never turned on here, which would add the test copy to your background items.)
    @Test func backgroundWorkAsSettingsShowsIt() async throws {
        let work = BackgroundWork.shared
        BackgroundWork.asUsersCopy = true
        defer {
            BackgroundWork.status = nil
            BackgroundWork.asUsersCopy = false
            work.didntStart = false
            work.refresh()
        }
        BackgroundWork.status = { .enabled }
        let on = try await ask("kuvo/mac")
        // (Stops here on a route from before it: what follows would change Open at Login.)
        try #require(on.json["backgroundWork"] as? String == "on")
        #expect(on.json["openAtLogin"] as? Bool == true, "a phone from before it hears it opens at login")
        work.didntStart = true
        #expect(try await ask("kuvo/mac").json["backgroundWork"] as? String == "notRunning")
        work.didntStart = false

        let loginBefore = OpenAtLogin.shared.isOn
        let again = try await ask("kuvo/mac", method: "PATCH", body: ["backgroundWork": true])
        #expect(again.status == 200)
        #expect(again.json["backgroundWork"] as? String == "on")
        // A phone from before it, turning on Open at Login: background work, which replaced it.
        let older = try await ask("kuvo/mac", method: "PATCH", body: ["openAtLogin": true])
        #expect(older.status == 200)
        #expect(older.json["openAtLogin"] as? Bool == true)
        #expect(OpenAtLogin.shared.isOn == loginBefore, "Open at Login isn't turned on again beside it")
        let off = try await ask("kuvo/mac", method: "PATCH", body: ["backgroundWork": false])
        #expect(off.status == 400)
        #expect((off.json["message"] as? String)?.contains("Login Items") == true)

        BackgroundWork.status = { .requiresApproval }
        #expect(try await ask("kuvo/mac").json["backgroundWork"] as? String == "needsApproval")
        // Asked already: the answer says it waits for your OK, as Settings shows.
        let waits = try await ask("kuvo/mac", method: "PATCH", body: ["backgroundWork": true])
        #expect(waits.status == 200)
        #expect(waits.json["backgroundWork"] as? String == "needsApproval")

        BackgroundWork.status = { .notRegistered }
        #expect(try await ask("kuvo/mac").json["backgroundWork"] as? String == "off")
        // A test or demo copy runs its work itself: off, whatever macOS has.
        BackgroundWork.asUsersCopy = false
        BackgroundWork.status = { .enabled }
        #expect(try await ask("kuvo/mac").json["backgroundWork"] as? String == "off")
        // And an older phone's Open at Login doesn't add it to your login items either.
        let refused = try await ask("kuvo/mac", method: "PATCH", body: ["openAtLogin": true])
        #expect(refused.status == 409)
        #expect((refused.json["message"] as? String)?.contains("runs its work itself") == true)
        #expect(OpenAtLogin.shared.isOn == loginBefore)
    }
}
