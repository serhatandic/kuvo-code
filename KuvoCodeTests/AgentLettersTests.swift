import Foundation
import KuvoLink
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

    /// A letter handed to this Mac's box (`kuvo/link/letters`), as the box answers it. Cut off once
    /// the box kept it (it started again while the agent waited): it's on its way, and the agent
    /// isn't told it failed (it would send it again, and it would come twice). Cut off before: it
    /// didn't go.
    @Test func aLetterTheBoxKeptIsOnItsWayWhateverHappensAfter() async {
        func answer(_ lines: [String], cutOff: Bool, status: Int = 200) -> AsyncThrowingStream<LinkResponsePart, Error> {
            AsyncThrowingStream { continuation in
                continuation.yield(.head(status: status, headers: ["content-type": "application/x-ndjson"]))
                for line in lines { continuation.yield(.body(Data((line + "\n").utf8))) }
                if cutOff { continuation.finish(throwing: URLError(.networkConnectionLost)) } else { continuation.finish() }
            }
        }
        let kept = await AgentMail.mailed(answer([#"{"id":"ltr_1"}"#], cutOff: true), to: "API", on: "lab", waits: true)
        #expect(kept == .done("On its way to API on lab. Its answer, if it writes one, comes to you as a message."))
        guard case .failed = await AgentMail.mailed(answer([], cutOff: true), to: "API", on: "lab", waits: true) else { Issue.record("cut off before it was kept"); return }
        #expect(await AgentMail.mailed(answer([#"{"id":"ltr_1"}"#, #"{"text":"Shipped."}"#], cutOff: false), to: "API", on: "lab", waits: true) == .done("API answered:\n\nShipped."))
        #expect(await AgentMail.mailed(answer([#"{"id":"ltr_1"}"#, #"{"text":null}"#], cutOff: false), to: "API", on: "lab", waits: true)
            == .done("API hasn't answered yet. It may still write back with send_message."))
        guard case .failed = await AgentMail.mailed(answer([#"{"id":"ltr_1"}"#, #"{"failed":"There's no such conversation here."}"#], cutOff: false), to: "API", on: "lab", waits: true) else {
            Issue.record("didn't get there"); return
        }
        guard case .failed = await AgentMail.mailed(answer([#"{"message":"That isn't one of this Mac's computers."}"#], cutOff: false, status: 404), to: "API", on: "lab", waits: false) else {
            Issue.record("refused"); return
        }
    }

    /// Who's on your other computers, as this Mac's box answers (`kuvo/link/agents`): listed by
    /// each machine's name here, a bot with its id and look; one it names that isn't one of this
    /// Mac's machines, and one that told nothing yet, left out.
    @Test func whoIsOnYourOtherComputersComesFromTheBox() async throws {
        _ = await start()
        defer { done() }
        let before = AgentMail.shared.app
        AgentMail.shared.app = app
        defer { AgentMail.shared.app = before }
        _ = app.machines.add("lab.invalid")
        defer { app.removeMachine("lab.invalid") }
        let answer = #"""
            {"peers":[{"key":"k1","id":"lab.invalid","at":5,"features":["groups.seats"],"list":[
              {"session":"ses_api","name":"API","kind":"session","project":"api"},
              {"session":"ses_ada","name":"Ada","kind":"bot","id":"bot_ada","look":{"color":"sky","shape":"round","face":"calm"},"about":"Ships"}]},
              {"key":"k2","id":"gone.invalid","at":5,"features":[],"list":[{"session":"ses_ghost","name":"Ghost","kind":"session"}]},
              {"key":"k3","id":null,"at":0,"features":[],"list":[]}]}
            """#
        AgentMail.shared.takeElsewhere(answer: Data(answer.utf8))
        let listed = AgentMail.shared.directory().filter { $0.machine != nil }
        #expect(listed.map(\.session).sorted() == ["ses_ada", "ses_api"])
        let ada = try #require(listed.first { $0.session == "ses_ada" })
        #expect(ada.machine == "lab.invalid" && ada.kind == "bot" && ada.id == "bot_ada" && ada.look?.color.rawValue == "sky" && ada.about == "Ships")
    }
}
