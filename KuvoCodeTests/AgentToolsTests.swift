import Foundation
import KuvoLink
import OpenCodeKit
import os
import Testing
@testable import KuvoCode

/// Agents writing to each other from this Mac's conversations (PROTOCOL.md, "Agents' tools"): their
/// tools are answered by this Mac's box, as every box answers them, and "&" lists who there is as
/// the box says. (What the tools do, on every box and between them: the bridge's agent-tools and
/// mac-peers tests.) This Mac's box is the real one, its engine a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct AgentToolsTests {
    let engine = StubEngine(port: 47_966)
    let folder: String

    init() throws {
        try FileManager.default.createDirectory(at: AppInfo.testRoot, withIntermediateDirectories: true)
        folder = MacBox.realPath(AppInfo.testRoot.path)
        let lead = StubEngine.session("ses_lead", title: "Lead", directory: folder)
        engine.list([lead, StubEngine.session("ses_notes", title: "Release notes", directory: folder)])
        engine.on("GET", "/api/session/ses_lead", json: ["data": lead])
        engine.on("GET", "/api/session/ses_notes", json: ["data": StubEngine.session("ses_notes", title: "Release notes", directory: folder)])
        engine.on("POST", "/api/session", json: ["data": ["id": "ses_new1"]])
        engine.on("PATCH", "/api/session/*", json: ["data": [:]])
        engine.on("POST", "/api/session/*", json: [:])
    }

    /// This Mac's box, reached as the app reaches it.
    private func started() async throws -> TestBox {
        let box = try await TestBox(engine: engine.url)
        let url = engine.url
        AgentMail.shared.box = { box.client(engine: url) }
        return box
    }

    private func done(_ box: TestBox) {
        AgentMail.shared.box = { nil }
        box.stop()
        engine.stop()
    }

    @Test func aConversationWritesToAnotherThroughThisMacsBox() async throws {
        let box = try await started()
        defer { done(box) }
        let said = await AgentMail.shared.call("send_message", arguments: ["to": "&release notes", "text": "Add the iPhone fixes."], caller: "ses_lead")
        #expect(said == (text: "Sent to Release notes. Its answer, if it writes one, comes to you as a message.", isError: false))
        let prompt = try #require(engine.requests("POST", "/api/session/ses_notes/prompt").last)
        #expect(prompt.body["text"] as? String == "[Message from Lead · ses_lead] (To answer, use send_message to ses_lead.)\n\nAdd the iPhone fixes.")
        // And who there is, for "&", as the box says.
        await AgentMail.shared.refresh(within: 60)
        let listed = AgentMail.shared.directory().filter { ["ses_lead", "ses_notes"].contains($0.session) }
        #expect(listed.map(\.name).sorted() == ["Lead", "Release notes"])
        #expect(listed.allSatisfy { $0.machine == nil && $0.kind == "session" })
    }

    @Test func aConversationStartsASessionBesideItThroughThisMacsBox() async throws {
        let box = try await started()
        defer { done(box) }
        let said = await AgentMail.shared.call("start_session", arguments: ["task": "Review the docs.", "title": "Review docs"], caller: "ses_lead")
        #expect(!said.isError, "\(said.text)")
        #expect(said.text.hasPrefix("Started \"Review docs\""), "\(said.text)")
        #expect(said.text.contains("(address ses_new1)"))
        let made = try #require(engine.requests("POST", "/api/session").last)
        #expect((made.body["location"] as? [String: Any])?["directory"] as? String == folder)
        let marked = engine.requests("PATCH", "/api/session/ses_new1").last?.body["metadata"] as? [String: Any]
        #expect((marked?["kuvo"] as? [String: Any])?["startedBy"] as? String == "ses_lead")
        let task = engine.requests("POST", "/api/session/ses_new1/prompt").last?.body["text"] as? String
        #expect(task == "[Message from Lead · ses_lead] (To answer, use send_message to ses_lead.)\n\nReview the docs.")
    }

    /// This Mac's box not running (it's starting again): the agent's told so, to try again, not
    /// left waiting.
    @Test func withoutTheBoxTheAgentIsToldToTryAgain() async throws {
        defer { engine.stop() }
        let before = PhoneLink.box.withLock { $0 }
        PhoneLink.box.withLock { $0 = nil }
        defer { PhoneLink.box.withLock { $0 = before } }
        let base = try #require(URL(string: engine.url + "/"))
        AgentMail.shared.box = { BoxClient(box: BoxClient.mac, transport: LocalBox { PhoneLink.respond(to: $0, link: nil, engine: base, password: "test", agents: nil) }) }
        defer { AgentMail.shared.box = { nil } }
        let said = await AgentMail.shared.call("list_agents", arguments: [:], caller: "ses_lead")
        #expect(said == (text: "Kuvo Code’s background service on this Mac isn’t running. Try again in a moment.", isError: true))
    }

    /// Just updated, while the older box still runs a session's work (the keeper makes way once
    /// it's over, which can take hours): a wake-up goes to it, which doesn't answer those yet
    /// (`agent-tools.own`), and this app's own box script keeps it all the same, run once with the
    /// box's folders, as a machine's tool server runs it; kuvo-wake and the box's script are real.
    /// Where that can't run (no engine yet), the agent hears why. Another tool's refusal is the box's.
    @Test func anOlderBoxAfterAnUpdateStillKeepsAWakeUp() async throws {
        let node = try #require(TestBox.node, "Node runs the box's script in the tests")
        try await StubWeb.listen(port: 47_966)
        BoxProcess.engineChanged(ServerEndpoint(url: try #require(URL(string: engine.url)), password: "test"), version: OpenCodeEngine.version, pid: getpid())
        let runtime = OwnToolsOnce.runtime
        OwnToolsOnce.runtime = { (node, false) }
        let wakes = WakeUps.root.appending(path: "ses_lead")
        defer {
            OwnToolsOnce.runtime = runtime
            BoxProcess.engineChanged(nil, version: nil, pid: nil)
            try? FileManager.default.removeItem(at: wakes)
            try? FileManager.default.removeItem(at: BoxProcess.home)
            StubWeb.stopListening(port: 47_966)
            engine.stop()
        }
        let mail = AgentMail()
        mail.box = {
            BoxClient(box: BoxClient.mac, transport: LocalBox { request in
                AsyncThrowingStream { continuation in
                    let older = request.path == "kuvo/info"
                        ? (200, ["features": ["agent-tools", "agents"]] as [String: Any])
                        : (400, ["message": "Send {name, arguments, session}: name one of list_agents, send_message."] as [String: Any])
                    continuation.yield(.head(status: older.0, headers: ["content-type": "application/json"]))
                    continuation.yield(.body((try? JSONSerialization.data(withJSONObject: older.1)) ?? Data()))
                    continuation.finish()
                }
            })
        }
        let said = await mail.call("schedule_wake_up", arguments: ["when": "+2h", "note": "Look again"], caller: "ses_lead")
        #expect(!said.isError, "\(said.text)")
        let kept = (try? FileManager.default.contentsOfDirectory(atPath: wakes.appending(path: "wakes").path(percentEncoded: false))) ?? []
        #expect(kept.count == 1, "kept, for its time")
        #expect((try? String(contentsOf: wakes.appending(path: "session"), encoding: .utf8)) == "ses_lead")

        OwnToolsOnce.runtime = { nil }
        #expect(await mail.call("list_wake_ups", arguments: [:], caller: "ses_lead") == (text: AgentMail.updating, isError: true))
        let other = await mail.call("list_agents", arguments: [:], caller: "ses_lead")
        #expect(other == (text: "Send {name, arguments, session}: name one of list_agents, send_message.", isError: true))
    }
}
