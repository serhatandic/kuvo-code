import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What a phone changes on this Mac: starting the engine over, which the app answers itself, and
/// finishing a sign-in whose page sends the browser back to this Mac, which a phone can't load
/// (this Mac's box's, as every box's).
/// (Its engine settings and keys are its box's: SettingsOnBoxTests, PhoneIntegrationsTests and the
/// route scenarios.)
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

    @Test func theEngineStartsOverOnceTheAnswerIsOut() async throws {
        // (When it came up, which the phone watches change, is its box's to say: `kuvo/info`.)
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
        let engine = StubEngine(port: 47_969, alongside: true)
        let box = try await TestBox(engine: engine.url)
        defer { box.stop(); StubWeb.stop() }
        // Where the sign-in's page sends the browser back: an address on this Mac.
        StubWeb.handle("http://127.0.0.1:19876/") { _, _ in StubWeb.Answer(status: 302) }
        try await StubWeb.listen(port: 19876)
        defer { StubWeb.stopListening(port: 19876) }

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
