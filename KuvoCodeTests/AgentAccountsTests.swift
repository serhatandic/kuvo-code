import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Your accounts with the coding agents, in Settings › Accounts: one you remove stays gone while a
/// slower look at every agent (opening the page) is still on its way, and Add Another Account
/// tapped twice adds one. The agents' bridge is stubbed.
@MainActor
@Suite(.serialized) struct AgentAccountsTests {
    /// A bridge with Claude Code and the accounts added to it.
    nonisolated final class Bridge: @unchecked Sendable {
        private let lock = NSLock()
        private var accounts: [String]
        private var heldFresh: [@Sendable () -> Void] = []
        /// What only a look at every agent finds: a newer Claude Code.
        private var outdated = false
        private(set) var adds = 0
        let url: String

        init(port: Int, accounts: [String]) {
            url = "http://127.0.0.1:\(port)"
            self.accounts = accounts
            StubWeb.handle(url + "/api/model") { _, _ in StubWeb.json(["data": []]) }
            // A look at every agent anew is slow: it answers with the accounts as they were when
            // it was asked, once the test lets it, and finds a newer Claude Code, which the bridge
            // answers from then on.
            StubWeb.hold(url + "/api/integration?fresh=1") { [weak self] _, _, reply in
                guard let self else { return reply(StubWeb.Answer(status: 503)) }
                let asked = self.lock.withLock { self.accounts }
                self.lock.withLock {
                    self.heldFresh.append { [weak self] in
                        guard let self else { return }
                        self.lock.withLock { self.outdated = true }
                        reply(self.list(asked))
                    }
                }
            }
            StubWeb.handle(url + "/api/integration") { [weak self] _, _ in self?.list() ?? StubWeb.Answer(status: 503) }
            StubWeb.handle(url + "/api/kuvo/accounts") { [weak self] request, _ in
                guard let self else { return StubWeb.Answer(status: 503) }
                return self.lock.withLock {
                    if request.httpMethod == "DELETE", let id = request.url?.lastPathComponent.removingPercentEncoding {
                        self.accounts.removeAll { $0 == id }
                        return StubWeb.json([:])
                    }
                    self.adds += 1
                    let id = "claude-code@new\(self.adds)"
                    self.accounts.append(id)
                    return StubWeb.json(["data": ["providerID": id]])
                }
            }
        }

        private func list(_ given: [String]? = nil) -> StubWeb.Answer {
            let (ids, outdated) = lock.withLock { (given ?? accounts, outdated) }
            return StubWeb.json(["data": ids.map { id in
                [
                    "id": id, "name": "Claude Code", "methods": [], "connections": [],
                    "metadata": ["source": "agent", "agent": "claude-code", "installed": true, "outdated": outdated] as [String: Any],
                ] as [String: Any]
            }])
        }

        var isHolding: Bool { lock.withLock { !heldFresh.isEmpty } }

        func answerHeld() {
            let held = lock.withLock { defer { heldFresh = [] }; return heldFresh }
            held.forEach { $0() }
        }

        var added: Int { lock.withLock { adds } }
        var endpoint: ServerEndpoint { ServerEndpoint(url: URL(string: url)!, password: "test") }
    }

    @Test func anAccountYouRemoveStaysGoneWhileASlowerLookFinishes() async throws {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        defer { StubWeb.stop() }
        let bridge = Bridge(port: 47932, accounts: ["claude-code", "claude-code@work"])
        let app = AppModel()
        app.catalog.outsideAgents = app.agents
        app.agents.connect(bridge.endpoint, folderPrefix: "")
        defer { app.agents.disconnect() }
        await app.catalog.refreshAgents()
        #expect(app.catalog.codingAgents.map(\.id) == ["claude-code", "claude-code@work"])

        // Settings › Accounts opens and looks at every agent anew; meanwhile you remove an account.
        let opening = Task { await app.catalog.refreshAgents(fresh: true) }
        try await until { bridge.isHolding }
        #expect(app.catalog.isRefreshingAgents)
        try await app.agents.removeAccount("claude-code@work")
        await app.catalog.refreshAgents()
        #expect(app.catalog.codingAgents.map(\.id) == ["claude-code"])

        // The look from before you removed it comes in last.
        bridge.answerHeld()
        await opening.value
        #expect(app.catalog.codingAgents.map(\.id) == ["claude-code"])
        #expect(!app.catalog.isRefreshingAgents)
    }

    @Test func whatALookAtEveryAgentFoundShowsThoughARoutineReadOvertookIt() async throws {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        defer { StubWeb.stop() }
        let bridge = Bridge(port: 47934, accounts: ["claude-code"])
        let app = AppModel()
        app.catalog.outsideAgents = app.agents
        app.agents.connect(bridge.endpoint, folderPrefix: "")
        defer { app.agents.disconnect() }

        // Settings › Accounts looks at every agent; meanwhile the app reads them as it does
        // (the engine said something changed).
        let opening = Task { await app.catalog.refreshAgents(fresh: true) }
        try await until { bridge.isHolding }
        await app.catalog.refreshAgents()
        bridge.answerHeld()
        await opening.value
        // The look found a newer Claude Code: Update shows.
        let claude = app.catalog.codingAgents.first { $0.id == "claude-code" }
        #expect(claude?.metadata?["outdated"]?.bool == true)
    }

    @Test func addAnotherAccountTappedTwiceAddsOne() async throws {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        defer { StubWeb.stop() }
        let bridge = Bridge(port: 47933, accounts: ["claude-code"])
        let app = AppModel()
        app.agents.connect(bridge.endpoint, folderPrefix: "")
        defer { app.agents.disconnect() }

        async let first = app.agents.addAccount(agent: "claude-code", label: "Work")
        async let second = app.agents.addAccount(agent: "claude-code", label: "Work")
        let added = try await [first, second].compactMap { $0 }
        #expect(added == ["claude-code@new1"])
        #expect(bridge.added == 1)
        #expect(app.agents.addingAccount.isEmpty)
    }
}
