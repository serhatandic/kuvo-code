import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// Settings › General's While Agents Work from a phone (keeping this Mac awake; Open at Login is
/// read but never changed here, which would add the test copy to your login items), and a link
/// for another phone to pair with, only while the phone link is on.
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

    @Test func noPairingLinkWhileTheLinkIsOff() async throws {
        let answer = try await ask("kuvo/phones/pair", method: "POST")
        #expect(answer.status == 409)
        #expect(link.pairing == nil)
        #expect(try await ask("kuvo/phones/pair").status == 405)
    }
}
