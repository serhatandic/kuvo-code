import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Update All, in Settings › Accounts, and each agent's Update, as its computer's box keeps them:
/// the box picks what Update All updates (`metadata.updateAll`) and says how each program's update
/// stands (`metadata.programUpdate`), whoever asked; this page's computer only is asked (this
/// Mac's page, or a machine's). Each says how its update goes, signed in or not: updating, updated
/// to its new version, or why it couldn't be, said once. The agents' bridges are stubbed: what
/// they pick and keep is the box's own tests' (test/agents/program-updates.test.ts).
@MainActor
@Suite(.serialized) struct UpdateAllAgentsTests {
    /// A bridge's coding agents, as its box states them, and what it was asked to update.
    nonisolated final class Bridge: @unchecked Sendable {
        private let lock = NSLock()
        /// Each program's update, as the box says it (`metadata.programUpdate`).
        private var updates: [String: [String: Any]] = [:]
        /// The programs Update All updates, as the box picked them.
        private var picked: Set<String>
        private var asked: [String] = []
        private var at = 1_000
        private let versions: [String: String]
        private let accounts: [String]
        let url: String
        static let newest = ["claude-code": "2.1.309", "codex-cli": "0.164.0", "grok-cli": "1.0.67"]

        init(port: Int, versions: [String: String], picked: Set<String>, added: [String] = []) {
            url = "http://127.0.0.1:\(port)"
            self.versions = versions
            self.picked = picked
            // The accounts you added first: what the page shows mustn't hang on the order.
            accounts = added + versions.keys.sorted()
            StubWeb.handle(url + "/api/model") { _, _ in StubWeb.json(["data": []]) }
            StubWeb.handle(url + "/api/kuvo/updates") { [weak self] request, _ in
                guard let self, request.httpMethod == "POST" else { return StubWeb.Answer(status: 404) }
                return self.lock.withLock {
                    let parts = request.url!.path().split(separator: "/").map(String.init)
                    let programs = parts.count == 4 ? [String(parts[3].split(separator: "@")[0])] : self.picked.sorted()
                    self.asked.append(parts.count == 4 ? parts[3] : "all")
                    for program in programs { self.start(program) }
                    return StubWeb.json(["data": ["updating": programs]])
                }
            }
            StubWeb.handle(url + "/api/integration") { [weak self] _, _ in
                guard let self else { return StubWeb.Answer(status: 503) }
                return self.lock.withLock { StubWeb.json(["data": self.accounts.map(self.integration)]) }
            }
        }

        private func start(_ program: String) {
            at += 1
            updates[program] = ["state": "updating", "at": at]
            picked.remove(program)
        }

        /// Another client (the phone) started `program`'s update.
        func startedElsewhere(_ program: String) {
            lock.withLock { start(program) }
        }

        /// `program`'s update ended, as the box says it: `updated`, `current` or `failed`, and
        /// whether Update All offers it again.
        func end(_ program: String, _ state: String, version: String? = nil, message: String? = nil, offeredAgain: Bool = false) {
            lock.withLock {
                at += 1
                var update: [String: Any] = ["state": state, "at": at]
                update["version"] = version
                update["message"] = message
                updates[program] = update
                if offeredAgain { picked.insert(program) }
            }
        }

        private func integration(_ id: String) -> [String: Any] {
            let parts = id.split(separator: "@").map(String.init)
            let program = parts[0]
            var metadata: [String: Any] = [
                "source": "agent", "agent": program, "accountID": parts.count == 2 ? parts[1] : "default", "installed": true,
                "version": versions[program] ?? "", "latestVersion": Self.newest[program] ?? "", "outdated": versions[program] != Self.newest[program],
                "updates": true, "updateAll": picked.contains(program),
            ]
            metadata["programUpdate"] = updates[program]
            return ["id": id, "name": program, "methods": [], "connections": [], "metadata": metadata]
        }

        var asks: [String] { lock.withLock { asked } }
        var endpoint: ServerEndpoint { ServerEndpoint(url: URL(string: url)!, password: "test") }
    }

    @Test func updateAllAsksOnlyThatPagesComputerForWhatItsBoxPicked() async throws {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        defer { StubWeb.stop() }
        // This Mac: an old Claude Code (with an account you added, which runs the same one), and
        // a Grok you installed in a way Kuvo Code can't update, which its box leaves out. The
        // machine: an old Codex.
        let macBridge = Bridge(port: 47971, versions: ["claude-code": "2.1.305", "grok-cli": "1.0.60"], picked: ["claude-code"], added: ["claude-code@1f2e"])
        let boxBridge = Bridge(port: 47972, versions: ["codex-cli": "0.163.0", "claude-code": "2.1.309"], picked: ["codex-cli"])
        let app = AppModel()
        app.catalog.outsideAgents = app.agents
        app.agents.connect(macBridge.endpoint, folderPrefix: "")
        let box = app.machines.add("box")
        box.agents.connect(boxBridge.endpoint, folderPrefix: RemoteFolder.prefix(for: box.machine.id))
        defer {
            app.agents.disconnect()
            box.agents.disconnect()
        }
        await app.catalog.refreshAgents()
        await box.catalog.refreshAgents()

        #expect(app.outdatedAgents(on: .mac).map { OutsideAgents.name($0.id) } == ["Claude Code"], "once for Claude Code, though both its accounts say so; never Grok")
        #expect(app.outdatedAgents(on: .machine(box.machine.id)).map(\.id) == ["codex-cli"])

        // This Mac's page: its own box only, the machine's on the machine's page.
        try await app.updateAllAgents(on: .mac)
        #expect(macBridge.asks == ["all"])
        #expect(boxBridge.asks.isEmpty)
        try await app.updateAllAgents(on: .machine(box.machine.id))
        #expect(boxBridge.asks == ["all"])
        #expect(app.outdatedAgents(on: .mac).isEmpty && app.outdatedAgents(on: .machine(box.machine.id)).isEmpty, "each updating, so there's nothing left to update")
    }

    @Test func eachSaysHowItsUpdateWentSignedInOrNotOnce() async throws {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        defer { StubWeb.stop() }
        // Claude Code, never signed in here (a tile on the page, not a row), and a Grok whose
        // installer leaves it as it was.
        let bridge = Bridge(port: 47973, versions: ["claude-code": "2.1.305", "grok-cli": "1.0.60"], picked: ["claude-code", "grok-cli"])
        let app = AppModel()
        app.catalog.outsideAgents = app.agents
        app.agents.connect(bridge.endpoint, folderPrefix: "")
        defer { app.agents.disconnect() }
        await app.catalog.refreshAgents()
        func status(_ id: String) -> OutsideAgents.UpdateStatus? {
            app.catalog.codingAgents.first { $0.id == id }.flatMap(app.agents.updateStatus)
        }
        func agent(_ id: String) throws -> Integration { try #require(app.catalog.codingAgents.first { $0.id == id }) }
        #expect(status("claude-code") == .available("2.1.309"))

        try await app.updateAllAgents(on: .mac)
        #expect(status("claude-code") == .updating)
        #expect(status("grok-cli") == .updating)

        bridge.end("claude-code", "updated", version: "2.1.309")
        bridge.end("grok-cli", "failed", version: "1.0.60", message: "Grok is still 1.0.60 after “grok update”.", offeredAgain: true)
        await app.catalog.refreshAgents()
        #expect(status("claude-code") == .updated("2.1.309"))
        #expect(status("grok-cli") == .failed("Grok is still 1.0.60 after “grok update”."))
        #expect(app.outdatedAgents(on: .mac).map(\.id) == ["grok-cli"], "still out of date, so Update All stays")

        // Seen: the failure once you've dismissed it, what an update brought once you've left the page.
        app.agents.dismissUpdateFailure(try agent("grok-cli"))
        #expect(status("grok-cli") == .available("1.0.67"), "offered again")
        app.agents.forgetUpdates(app.catalog.codingAgents)
        #expect(status("claude-code") == .available("2.1.309"), "the stub's version stands still; news no more")
    }

    @Test func anUpdateAnotherClientStartedShowsUnderWayThenHowItWent() async throws {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        defer { StubWeb.stop() }
        // Codex, behind, with an account you added; the phone updates it.
        let bridge = Bridge(port: 47974, versions: ["codex-cli": "0.163.0"], picked: ["codex-cli"], added: ["codex-cli@9a8b"])
        let app = AppModel()
        app.catalog.outsideAgents = app.agents
        app.agents.connect(bridge.endpoint, folderPrefix: "")
        defer { app.agents.disconnect() }
        await app.catalog.refreshAgents()
        func status(_ id: String) -> OutsideAgents.UpdateStatus? {
            app.catalog.codingAgents.first { $0.id == id }.flatMap(app.agents.updateStatus)
        }

        bridge.startedElsewhere("codex-cli")
        await app.catalog.refreshAgents()
        #expect(status("codex-cli") == .updating, "under way, though this Mac didn't ask")
        #expect(status("codex-cli@9a8b") == .updating, "on each account with the program")
        #expect(app.outdatedAgents(on: .mac).isEmpty, "not offered again while it updates")
        #expect(bridge.asks.isEmpty)

        bridge.end("codex-cli", "current", version: "0.164.0")
        await app.catalog.refreshAgents()
        #expect(status("codex-cli") == .current("0.164.0"), "already on the newest when asked: up to date, not silence")
    }
}
