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
        // The one made, as the engine keeps it: read by the box just before it marks it, with what
        // was written to it since.
        let made = Guarded(StubEngine.session("ses_new1", title: "Review docs", directory: folder))
        engine.on("GET", "/api/session/ses_new1") { _ in StubWeb.json(["data": made.withLock { $0 }]) }
        engine.on("PATCH", "/api/session/ses_new1") { request in
            StubWeb.json(["data": made.withLock { now in
                for (key, value) in request.body { now[key] = value }
                return now
            }])
        }
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
}
