import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Refresh Models, in an account's menu in Settings › Accounts, on this Mac and from a phone: the
/// computer's box asks the provider's models again without restarting its engine (what it closes
/// and learns is the bridge's tests', models-refresh.test.js and compatibility-live.test.js). Here:
/// both reach this Mac's real box, which answers what it did; one the box doesn't have says so. The
/// engine is faked.
@MainActor
@Suite(.serialized) struct RefreshModelsTests {
    let engine: FakeEngine
    let link = PhoneLink()
    let workspace = Workspace()

    init() {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        engine = FakeEngine(port: 47916, accounts: ["github-copilot", "anthropic"])
        workspace.api = engine.api
        link.workspace = workspace
    }

    /// What this Mac answers a request, as a phone's comes, or the app's own (`BoxClient.mac`).
    private func respond(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> {
        PhoneLink.respond(to: request, link: link, engine: URL(string: engine.url + "/")!, password: "test", agents: nil)
    }

    @Test func refreshModelsInThisMacsAccountsAsksItsBoxAndSaysWhyItCouldnt() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { box.stop(); StubWeb.stop() }
        let catalog = Catalog()
        catalog.box = BoxClient(box: BoxClient.mac, transport: LocalBox(respond: { [link, engine] request in
            PhoneLink.respond(to: request, link: link, engine: URL(string: engine.url + "/")!, password: "test", agents: nil)
        }))
        await catalog.readRefreshable()
        // Offered for a provider whose models come from your account, not for a catalog's.
        #expect(catalog.refreshesModels("github-copilot"))
        #expect(!catalog.refreshesModels("anthropic"))
        let waits = try await catalog.refreshModels("github-copilot")
        #expect(!waits, "nothing at work there")
        #expect(catalog.refreshingModels.isEmpty)
        // One gone from the engine meanwhile: the box's words, as the alert says them.
        await #expect { try await catalog.refreshModels("gitlab") } throws: {
            $0.localizedDescription == "That provider isn't on this computer's engine any more."
        }
    }

    @Test func aPhonesRefreshModelsReachesThisMacsBox() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { box.stop(); StubWeb.stop() }
        var status = 0
        var body = Data()
        for try await part in respond(LinkRequest(method: "POST", path: "kuvo/accounts/github-copilot/refresh", headers: [:], body: Data())) {
            switch part {
            case .head(let code, _): status = code
            case .body(let chunk): body += chunk
            }
        }
        #expect(status == 200)
        let answer = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect((answer["waiting"] as? [String]) == [])
    }

    @Test func aMachinesBoxWithoutItIsntOfferedRefreshModels() async throws {
        /// A machine's box from before Refresh Models: a route it doesn't have.
        struct OlderBox: BoxTransport {
            func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> {
                AsyncThrowingStream { continuation in
                    continuation.yield(.head(status: 404, headers: [:]))
                    continuation.yield(.body(Data("{}".utf8)))
                    continuation.finish()
                }
            }
        }
        let catalog = Catalog()
        catalog.box = BoxClient(box: "lab", transport: OlderBox())
        await catalog.readRefreshable()
        #expect(!catalog.refreshesModels("github-copilot"))
    }
}
