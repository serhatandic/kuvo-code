import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Update All, in Settings › Accounts: every coding agent with a newer version that its installer
/// can update to, on this Mac and on each machine, updated on its own computer, once per program
/// (an account you added runs the same one). One you update yourself is left out, and nothing is
/// asked of an agent that's up to date. The agents' bridges are stubbed.
@MainActor
@Suite(.serialized) struct UpdateAllAgentsTests {
    /// A bridge's coding agents: the version of each program, and the updates it was asked for.
    nonisolated final class Bridge: @unchecked Sendable {
        private let lock = NSLock()
        private var versions: [String: String]
        private var asked: [String] = []
        private let manual: Set<String>
        let url: String
        static let newest = ["claude-code": "2.1.309", "codex-cli": "0.164.0", "grok-cli": "1.0.67"]

        init(port: Int, versions: [String: String], manual: Set<String> = [], added: [String] = []) {
            url = "http://127.0.0.1:\(port)"
            self.versions = versions
            self.manual = manual
            StubWeb.handle(url + "/api/model") { _, _ in StubWeb.json(["data": []]) }
            StubWeb.handle(url + "/api/integration") { [weak self] request, _ in
                guard let self else { return StubWeb.Answer(status: 503) }
                return self.lock.withLock {
                    let parts = request.url!.path().split(separator: "/").map(String.init)
                    if request.httpMethod == "POST", parts.last == "update", parts.count == 4 {
                        let id = parts[2]
                        self.asked.append(id)
                        self.versions[id] = Self.newest[id]
                        return StubWeb.json(["data": ["updated": true, "version": Self.newest[id] ?? ""]])
                    }
                    let accounts = self.versions.keys.sorted() + added
                    return StubWeb.json(["data": accounts.map { self.integration($0) }])
                }
            }
        }

        private func integration(_ id: String) -> [String: Any] {
            let program = String(id.split(separator: "@")[0])
            let version = versions[program] ?? ""
            let newest = Self.newest[program] ?? version
            return [
                "id": id, "name": program, "methods": [], "connections": [],
                "metadata": [
                    "source": "agent", "agent": program, "installed": true, "version": version, "latestVersion": newest,
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

        let outdated = app.outdatedAgents.map { "\($0.integration.id) on \($0.box.id)" }
        #expect(outdated == ["claude-code on mac", "codex-cli on \(box.machine.id)"])

        app.updateAllAgents()
        for _ in 0..<100 where !app.outdatedAgents.isEmpty { try await Task.sleep(for: .milliseconds(50)) }
        #expect(macBridge.updates == ["claude-code"], "once for Claude Code, not again for the account you added; never Grok")
        #expect(boxBridge.updates == ["codex-cli"], "the machine's own Codex, on the machine")
        #expect(app.outdatedAgents.isEmpty, "each lists its new version, so there's nothing left to update")
    }
}
