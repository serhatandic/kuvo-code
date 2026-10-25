import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Agents on a machine this Mac isn't connected to (PROTOCOL.md, "Peers"): listed as that machine
/// told this Mac's box, and written to only where they are. (Letters between your computers,
/// this Mac's box's too, are the bridge's: its peers and mac-peers tests.) The engine is stubbed,
/// and so is what the box answers; the relay isn't connected.
@MainActor
@Suite(.serialized) struct AgentLettersTests {
    static let engine = "http://127.0.0.1:47994"
    let app = AppModel()
    let here = "ses_onthemac"

    private static func session(_ id: String) -> [String: Any] {
        [
            "id": id, "projectID": "p", "cost": 0, "title": "Release notes",
            "tokens": ["input": 0, "output": 0, "reasoning": 0, "cache": ["read": 0, "write": 0]],
            "time": ["created": 1, "updated": 2], "location": ["directory": "/tmp/kuvo-tests-project"],
            "model": ["id": "luna", "providerID": "openai"], "agent": "build", "metadata": [:] as [String: Any],
        ]
    }

    /// The prompts the engine was sent.
    nonisolated final class Prompts: @unchecked Sendable {
        private let lock = NSLock()
        private var texts: [String] = []
        func add(_ text: String) { lock.withLock { texts.append(text) } }
        var all: [String] { lock.withLock { texts } }
    }

    private func start() async -> Prompts {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        let listed = StubWeb.json(["data": [Self.session(here)]])
        StubWeb.route(Self.engine + "/api/session") { _ in listed }
        StubWeb.route(Self.engine + "/api/session/active") { _ in StubWeb.json(["data": [:]]) }
        let one = StubWeb.json(["data": Self.session(here)])
        StubWeb.route(Self.engine + "/api/session/\(here)") { _ in one }
        StubWeb.route(Self.engine + "/api/session/\(here)/message") { _ in StubWeb.json(["data": []]) }
        let prompts = Prompts()
        StubWeb.handle(Self.engine + "/api/session/\(here)/prompt") { _, body in
            prompts.add((try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["text"] as? String ?? "")
            return StubWeb.json([:])
        }
        app.workspace.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: Self.engine)!, password: "test"))
        await app.workspace.refresh()
        return prompts
    }

    private func done() {
        StubWeb.stop()
    }

    /// A message for an agent on a machine this Mac isn't connected to, with no way to mail it
    /// (the relay isn't connected): it waits for that machine, and never goes to this Mac's own
    /// engine, which would say there's no such session.
    @Test func aMessageForAnAwayMachinesAgentNeverGoesToTheMacsEngine() async throws {
        let prompts = await start()
        defer { done() }
        let before = AgentMail.shared.app
        AgentMail.shared.app = app
        defer { AgentMail.shared.app = before }
        let asked = Prompts()
        StubWeb.handle(Self.engine + "/api/session/ses_faraway/prompt") { _, _ in
            asked.add("ses_faraway")
            return StubWeb.json([:])
        }
        // A machine of this Mac's, not connected now, whose agents its box heard of.
        _ = app.machines.add("awaybox")
        defer { app.removeMachine("awaybox") }
        AgentMail.shared.takeElsewhere([(machine: "awaybox", told: .init(at: 1, list: [.init(session: "ses_faraway", name: "API", kind: "session", project: nil, about: nil, machine: nil)])),
                                         // One the box names that isn't one of this Mac's machines: not listed.
                                         (machine: "gone.invalid", told: .init(at: 1, list: [.init(session: "ses_ghost", name: "Ghost", kind: "session", project: nil, about: nil, machine: nil)]))])
        #expect(AgentMail.shared.directory().first { $0.session == "ses_faraway" }?.machine == "awaybox")
        #expect(!AgentMail.shared.directory().contains { $0.session == "ses_ghost" })
        let sent = await AgentMail.shared.send(from: here, name: "Release notes", to: "API", text: "Is it deployed?", waits: false)
        #expect(!sent.isError, "\(sent.text)")
        #expect(sent.text.contains("awaybox"), "\(sent.text)")
        #expect(asked.all.isEmpty && prompts.all.isEmpty)
        let read = await AgentMail.shared.read("API", query: nil, caller: here)
        #expect(read.isError && read.text.contains("isn't connected"), "\(read.text)")
    }
}
