import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What a phone changes on this Mac that this Mac answers itself: its integrations' keys in the
/// Keychain, starting the engine over, and finishing a sign-in whose page sends the browser back
/// to this Mac, which a phone can't load. (Its engine settings are its box's:
/// SettingsOnBoxTests and the route scenarios.)
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PhoneSettingsTests {
    let link = PhoneLink()

    init() {
        TestEnvironment.prepare()
    }

    private func ask(_ path: String, method: String = "GET", body: String = "") async throws -> (status: Int, json: [String: Any]?) {
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

    /// This Mac's integrations' keys, from a phone: set, read, listed and removed in the Keychain,
    /// and a bot's own or anything that isn't a key's name never touched.
    @Test func integrationsKeysFromAPhone() async throws {
        let name = "KUVO_KEY_PHONETEST_TOKEN"
        defer { IntegrationKeys.set(nil, for: name) }
        #expect(try await ask("kuvo/keys/\(name)").status == 404)
        #expect(try await ask("kuvo/keys/\(name)", method: "PUT", body: #"{"value": "ghp_phone"}"#).status == 200)
        #expect(IntegrationKeys.value(name) == "ghp_phone")
        #expect(try await ask("kuvo/keys/\(name)").json?["value"] as? String == "ghp_phone")
        #expect((try await ask("kuvo/keys").json?["keys"] as? [String])?.contains(name) == true)
        #expect(try await ask("kuvo/keys/\(name)__BOT_A", method: "PUT", body: #"{"value": "x"}"#).status == 400)
        #expect(try await ask("kuvo/keys/HOME", method: "PUT", body: #"{"value": "x"}"#).status == 400)
        #expect(try await ask("kuvo/keys/\(name)", method: "PUT", body: #"{"value": ""}"#).status == 400)
        #expect(try await ask("kuvo/keys/\(name)", method: "DELETE").status == 200)
        #expect(IntegrationKeys.value(name) == nil)
    }

    @Test func theEngineStartsOverOnceTheAnswerIsOut() async throws {
        // When the engine running now came up, which the phone watches change.
        let up = Date(timeIntervalSince1970: 1_792_660_000)
        link.engineStarted = { up }
        #expect(try await ask("kuvo/info").json?["started"] as? Double == up.timeIntervalSince1970)
        var restarted = false
        link.restartEngine = {
            restarted = true
            TestPulse.beat()
        }
        #expect(try await ask("kuvo/engine/restart", method: "POST").status == 202)
        #expect(!restarted)
        try await until { restarted }
        #expect(restarted)
    }

    @Test func aSignInThatReturnsHereIsLoadedHere() async throws {
        StubWeb.start(hosts: ["127.0.0.1", "example.com"])
        defer { StubWeb.stop() }
        StubWeb.handle("http://127.0.0.1:19876/") { _, _ in StubWeb.Answer(status: 302) }

        let loaded = try await ask("kuvo/sign-in/return", method: "POST", body: #"{"url": "http://127.0.0.1:19876/mcp/oauth/callback?code=c&state=s#_=_"}"#)
        #expect(loaded.status == 200 && loaded.json?["status"] as? Int == 302)
        #expect(StubWeb.asked.contains("http://127.0.0.1:19876/mcp/oauth/callback?code=c&state=s"))

        // Only this Mac's own address, with what the page sent back.
        for url in ["http://example.com:19876/cb?code=c", "http://127.0.0.1:19876/cb", "https://127.0.0.1:19876/cb?code=c"] {
            #expect(try await ask("kuvo/sign-in/return", method: "POST", body: #"{"url": "\#(url)"}"#).status == 400, "\(url)")
        }
        #expect(!StubWeb.asked.contains { $0.contains("example.com") || $0.hasSuffix("/cb") })
        #expect(try await ask("kuvo/sign-in/return").status == 405)
    }
}
