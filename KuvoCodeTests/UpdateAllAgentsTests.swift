import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Update All, in Settings › Accounts: every coding agent on that page's computer (this Mac's
/// page, or a machine's) with a newer version that its installer can update to, once per program
/// (an account you added runs the same one). One you update yourself is left out, and nothing is
/// asked of an agent that's up to date. Each says how its update went, signed in or not: updating,
/// updated to its new version, or why it couldn't be. The agents' bridges are stubbed.
@MainActor
@Suite(.serialized) struct UpdateAllAgentsTests {
    /// A bridge's coding agents: the version of each program, and the updates it was asked for.
    nonisolated final class Bridge: @unchecked Sendable {
        private let lock = NSLock()
        private var versions: [String: String]
        private var asked: [String] = []
        private let manual: Set<String>
        /// Programs whose installer runs but leaves them as they were.
        private let stuck: Set<String>
        /// Programs updated elsewhere (a terminal, another client) by the time they're asked.
        private let updatedElsewhere: Set<String>
        /// Programs whose own sign-in's version check didn't answer in time: only the accounts you
        /// added say they're out of date.
        private let unchecked: Set<String>
        let url: String
        static let newest = ["claude-code": "2.1.309", "codex-cli": "0.164.0", "grok-cli": "1.0.67"]

        init(port: Int, versions: [String: String], manual: Set<String> = [], stuck: Set<String> = [], updatedElsewhere: Set<String> = [], unchecked: Set<String> = [], added: [String] = []) {
            url = "http://127.0.0.1:\(port)"
            self.versions = versions
            self.manual = manual
            self.stuck = stuck
            self.updatedElsewhere = updatedElsewhere
            self.unchecked = unchecked
            StubWeb.handle(url + "/api/model") { _, _ in StubWeb.json(["data": []]) }
            StubWeb.handle(url + "/api/integration") { [weak self] request, _ in
                guard let self else { return StubWeb.Answer(status: 503) }
                return self.lock.withLock {
                    let parts = request.url!.path().split(separator: "/").map(String.init)
                    if request.httpMethod == "POST", parts.last == "update", parts.count == 4 {
                        self.asked.append(parts[2])
                        let id = String(parts[2].split(separator: "@")[0])
                        if self.updatedElsewhere.contains(id) {
                            self.versions[id] = Self.newest[id]
                            return StubWeb.json(["data": ["updated": false, "version": Self.newest[id] ?? ""]])
                        }
                        if self.stuck.contains(id) {
                            return StubWeb.json(["data": ["updated": false, "version": self.versions[id] ?? "", "message": "Grok is still \(self.versions[id] ?? "") after “grok update”."]])
                        }
                        self.versions[id] = Self.newest[id]
                        return StubWeb.json(["data": ["updated": true, "version": Self.newest[id] ?? ""]])
                    }
                    // The accounts you added first: what Update All updates mustn't hang on the order.
                    let accounts = added + self.versions.keys.sorted()
                    return StubWeb.json(["data": accounts.map { self.integration($0) }])
                }
            }
        }

        private func integration(_ id: String) -> [String: Any] {
            let parts = id.split(separator: "@").map(String.init)
            let program = parts[0]
            let version = versions[program] ?? ""
            let newest = Self.newest[program] ?? version
            if parts.count == 1, unchecked.contains(program) {
                return ["id": id, "name": program, "methods": [], "connections": [], "metadata": ["source": "agent", "agent": program, "accountID": "default", "installed": true]]
            }
            return [
                "id": id, "name": program, "methods": [], "connections": [],
                "metadata": [
                    "source": "agent", "agent": program, "accountID": parts.count == 2 ? parts[1] : "default", "installed": true, "version": version, "latestVersion": newest,
                    "outdated": version != newest, "updates": !manual.contains(program),
                ] as [String: Any],
            ]
        }

        var updates: [String] { lock.withLock { asked } }
        var endpoint: ServerEndpoint { ServerEndpoint(url: URL(string: url)!, password: "test") }
    }

    @Test func updatesEveryOutdatedAgentOnEachComputerOnce() async throws {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        defer { StubWeb.stop() }
        // This Mac: an old Claude Code (with an account you added, which runs the same one), and
        // a Grok you installed in a way Kuvo Code can't update. The machine: an old Codex, and a
        // Claude Code that's up to date.
        let macBridge = Bridge(port: 47971, versions: ["claude-code": "2.1.305", "grok-cli": "1.0.60"], manual: ["grok-cli"], added: ["claude-code@1f2e"])
        let boxBridge = Bridge(port: 47972, versions: ["codex-cli": "0.163.0", "claude-code": "2.1.309"])
        let app = AppModel()
        app.catalog.outsideAgents = app.agents
        app.agents.connect(macBridge.endpoint, folderPrefix: "")
        let box = app.machines.add("box")
        box.agents.connect(boxBridge.endpoint, folderPrefix: RemoteFolder.prefix(for: box.machine.id))
        defer {
            app.agents.disconnect()
            box.agents.disconnect()
        }
        await app.catalog.refreshAgents(fresh: true)
        await box.catalog.refreshAgents(fresh: true)

        #expect(app.outdatedAgents(on: .mac).map(\.id) == ["claude-code"])
        #expect(app.outdatedAgents(on: .machine(box.machine.id)).map(\.id) == ["codex-cli"])

        // This Mac's page: its own agents only, the machine's on the machine's page.
        for update in app.updateAllAgents(on: .mac) { await update.value }
        #expect(macBridge.updates == ["claude-code"], "once for Claude Code, not again for the account you added; never Grok")
        #expect(boxBridge.updates.isEmpty)
        for update in app.updateAllAgents(on: .machine(box.machine.id)) { await update.value }
        #expect(boxBridge.updates == ["codex-cli"], "the machine's own Codex, on the machine")
        #expect(app.outdatedAgents(on: .mac).isEmpty && app.outdatedAgents(on: .machine(box.machine.id)).isEmpty, "each lists its new version, so there's nothing left to update")
    }

    @Test func eachSaysHowItsUpdateWentSignedInOrNot() async throws {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        defer { StubWeb.stop() }
        // Claude Code, never signed in here (a tile on the page, not a row), and a Grok whose
        // installer leaves it as it was.
        let bridge = Bridge(port: 47973, versions: ["claude-code": "2.1.305", "grok-cli": "1.0.60"], stuck: ["grok-cli"])
        let app = AppModel()
        app.catalog.outsideAgents = app.agents
        app.agents.connect(bridge.endpoint, folderPrefix: "")
        defer { app.agents.disconnect() }
        await app.catalog.refreshAgents(fresh: true)
        func status(_ id: String) -> OutsideAgents.UpdateStatus? {
            app.catalog.codingAgents.first { $0.id == id }.flatMap(app.agents.updateStatus)
        }
        #expect(status("claude-code") == .available("2.1.309"))

        let updates = app.updateAllAgents(on: .mac)
        #expect(status("claude-code") == .updating)
        #expect(status("grok-cli") == .updating)
        for update in updates { await update.value }

        #expect(status("claude-code") == .updated("2.1.309"))
        #expect(status("grok-cli") == .failed("Grok is still 1.0.60 after “grok update”."))
        #expect(app.outdatedAgents(on: .mac).map(\.id) == ["grok-cli"], "still out of date, so Update All stays")
    }

    @Test func theAgentsOwnRowSaysHowItWentWhicheverAccountWasUpdated() async throws {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        defer { StubWeb.stop() }
        // Claude Code's own sign-in didn't hear back about its version in time, so only the
        // account you added says it's out of date. And Codex was updated in a terminal since the
        // page last looked.
        let bridge = Bridge(port: 47974, versions: ["claude-code": "2.1.305", "codex-cli": "0.163.0"], updatedElsewhere: ["codex-cli"], unchecked: ["claude-code"], added: ["claude-code@1f2e"])
        let app = AppModel()
        app.catalog.outsideAgents = app.agents
        app.agents.connect(bridge.endpoint, folderPrefix: "")
        defer { app.agents.disconnect() }
        await app.catalog.refreshAgents(fresh: true)
        // What the page shows for each: the agent's own sign-in.
        func status(_ id: String) -> OutsideAgents.UpdateStatus? {
            app.catalog.codingAgents.first { $0.id == id }.flatMap(app.agents.updateStatus)
        }

        let updates = app.updateAllAgents(on: .mac)
        #expect(status("claude-code") == .updating, "the agent's own row is updating, whichever account asked")
        for update in updates { await update.value }
        #expect(Set(bridge.updates) == ["claude-code@1f2e", "codex-cli"])

        #expect(status("claude-code") == .updated("2.1.309"))
        #expect(status("codex-cli") == .current("0.164.0"), "already on the newest when asked: up to date, not silence")
        #expect(app.outdatedAgents(on: .mac).isEmpty)
    }
}
