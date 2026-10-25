import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Your plan accounts from a phone, as this Mac answers it: the sign-ins it has, listed by name and
/// which is in use (this Mac's box's, as every box's), or as the engine keeps them. A sign-in page started there reaches the engine
/// with what its method's form fills in. The plans whose sign-in ended, and Disconnect, are this
/// Mac's box's, as every box's (the bridge's tests' accounts). The engine is faked.
@MainActor
@Suite(.serialized) struct PhoneAccountsTests {
    let engine: FakeEngine
    let link = PhoneLink()
    let workspace = Workspace()
    let sentToEngine = Sent()

    nonisolated final class Sent: @unchecked Sendable {
        private let lock = NSLock()
        private var bodies: [String: Data] = [:]
        subscript(path: String) -> Data? {
            get { lock.withLock { bodies[path] } }
            set { lock.withLock { bodies[path] = newValue } }
        }
    }

    init() {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        engine = FakeEngine(port: 47903, accounts: ["anthropic", "openai", "opencode"])
        let sent = sentToEngine
        StubWeb.route(engine.url + "/api/integration/opencode/connect/oauth", sent: { request, body in
            sent[request.url!.path()] = body
            return StubWeb.json(["data": ["url": "https://opencode.ai/device", "userCode": "ABCD-1234"]])
        })
        workspace.api = engine.api
        link.workspace = workspace
    }

    private func ask(_ path: String, method: String = "GET", body: String = "") async throws -> (status: Int, body: Data) {
        let request = LinkRequest(method: method, path: path, headers: ["Content-Type": "application/json"], body: Data(body.utf8))
        var status = 0
        var data = Data()
        for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: engine.url + "/")!, password: "test", agents: nil) {
            switch part {
            case .head(let code, _): status = code
            case .body(let chunk): data += chunk
            }
        }
        return (status, data)
    }

    @Test func aPhoneSeesThisMacsSignIns() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { box.stop(); StubWeb.stop() }
        engine.store("anthropic", label: "Work", value: ["type": "key", "key": "sk-ant-secret"])
        engine.store("openai", label: "me", value: ["type": "oauth", "access": "a", "refresh": "rt_secret", "expires": 1], active: false)
        let listed = try await ask("kuvo/accounts/credentials")
        #expect(listed.status == 200)
        let credentials = try #require((try JSONSerialization.jsonObject(with: listed.body) as? [String: Any])?["credentials"] as? [[String: Any]])
        #expect(credentials.map { "\($0["integrationID"]!) \($0["label"]!) \($0["active"]!)" } == ["anthropic Work 1", "openai me 0"])
        #expect(!String(decoding: listed.body, as: UTF8.self).contains("secret"), "the list alone")
        // The engine's own, with what each is signed in with: the phone is yours.
        let kept = try await ask("api/credential")
        #expect(kept.status == 200 && String(decoding: kept.body, as: UTF8.self).contains("sk-ant-secret"))
    }

    /// A provider you add with a name in any language gets an id of plain letters, so a phone can
    /// name it to disconnect it, as the Mac does (the box signs it out: the bridge's tests'
    /// accounts, with one added before by the name it was given).
    @Test func aProviderNamedInAnyLanguageGetsAPlainID() {
        #expect(CustomProviderEditor.providerID(for: "Şirket Proxy") == "sirket-proxy")
        #expect(CustomProviderEditor.providerID(for: "Kırmızı API v2") == "kirmizi-api-v2")
        #expect(CustomProviderEditor.providerID(for: "  ★ ") == "")
    }

    /// OpenCode's sign-in page, started as the Mac starts it: with its method's hidden answer (the
    /// server), which reaches the engine as the phone sent it.
    @Test func aSignInPageStartsWithItsAnswers() async throws {
        defer { StubWeb.stop() }
        let start = #"{"methodID":"console","answer":{"server":"https://opencode.ai"}}"#
        let started = try await ask("api/integration/opencode/connect/oauth", method: "POST", body: start)
        #expect(started.status == 200)
        #expect(sentToEngine["/api/integration/opencode/connect/oauth"].map { String(decoding: $0, as: UTF8.self) } == start)
    }
}
