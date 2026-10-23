import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Your plan accounts from a phone, as this Mac answers it: the sign-ins it has, listed by name and
/// which is in use, or as the engine keeps them; the plans whose sign-in ended; Disconnect, as
/// Settings › Accounts does it, only for your plans. A sign-in page started there reaches the
/// engine with what its method's form fills in. The engine is faked.
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
        defer { StubWeb.stop() }
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

    @Test func endedAndDisconnect() async throws {
        defer { StubWeb.stop() }
        var forgot: [String] = []
        link.endedSignIns = { ["openai"] }
        link.forgetSignIn = { provider in
            guard provider == "openai" else { return false }
            forgot.append(provider)
            return true
        }
        let ended = try await ask("kuvo/accounts/ended")
        #expect(ended.status == 200)
        #expect((try JSONSerialization.jsonObject(with: ended.body) as? [String: [String]]) == ["providers": ["openai"]])

        #expect(try await ask("kuvo/accounts/openai/forget", method: "POST").status == 200)
        #expect(forgot == ["openai"])
        // Only a plan's own name: nothing else is signed out.
        for path in ["kuvo/accounts/../credential/forget", "kuvo/accounts/a%2Fb/forget", "kuvo/accounts//forget", "kuvo/accounts/notion/forget"] {
            #expect(try await ask(path, method: "POST").status == 404, "\(path)")
        }
        #expect(try await ask("kuvo/accounts/openai/forget", method: "GET").status == 404)
        #expect(forgot == ["openai"])
    }

    /// OpenCode's sign-in page, started as the Mac starts it: with its method's hidden answer (the
    /// server), which reaches the engine as the phone sent it.
    /// A provider you add with a name in any language gets an id of plain letters, so a phone can
    /// name it to disconnect it, as the Mac does.
    @Test func aProviderNamedInAnyLanguageCanBeDisconnectedFromAPhone() async throws {
        #expect(CustomProviderEditor.providerID(for: "Şirket Proxy") == "sirket-proxy")
        #expect(CustomProviderEditor.providerID(for: "Kırmızı API v2") == "kirmizi-api-v2")
        #expect(CustomProviderEditor.providerID(for: "  ★ ") == "")
        var forgotten: [String] = []
        link.forgetSignIn = { provider in
            forgotten.append(provider)
            return true
        }
        let id = CustomProviderEditor.providerID(for: "Şirket Proxy")
        #expect(try await ask("kuvo/accounts/\(id)/forget", method: "POST").status == 200)
        #expect(forgotten == ["sirket-proxy"])
    }

    @Test func aSignInPageStartsWithItsAnswers() async throws {
        defer { StubWeb.stop() }
        let start = #"{"methodID":"console","answer":{"server":"https://opencode.ai"}}"#
        let started = try await ask("api/integration/opencode/connect/oauth", method: "POST", body: start)
        #expect(started.status == 200)
        #expect(sentToEngine["/api/integration/opencode/connect/oauth"].map { String(decoding: $0, as: UTF8.self) } == start)
    }
}
