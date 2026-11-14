import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The network goes away mid-reply (J1): what the engine did while the app couldn't hear it shows
/// once its feed is back. The reply the agent finished shows whole and once, the session no longer
/// shows working, a question answered elsewhere meanwhile (on the phone) is no longer waiting on
/// you, and one asked meanwhile is. The engine is stubbed.
@MainActor
@Suite(.serialized) struct NetworkDropTests {
    let engine = StubEngine(port: 47994)
    let workspace = Workspace()
    let id = "ses_drop"
    let you: [String: Any] = ["id": "msg_01", "type": "user", "time": ["created": 1], "text": "Why does the build fail?"]
    let answer = "The linker can't find libz: install it, or drop -lz from the flags."

    init() {
        workspace.api = engine.api
    }

    private func session() -> [String: Any] {
        StubEngine.session(id, title: "Build", directory: "/tmp/kuvo-tests-drop")
    }

    @Test func whatHappenedWhileTheFeedWasDownShowsWhenItsBack() async throws {
        defer { engine.stop() }
        let asked: [String: Any] = ["id": "per_rm", "sessionID": id, "action": "shell", "resources": ["rm -rf build"]]
        engine.list([session()], running: [id])
        engine.conversation(id, [you])
        engine.on("GET", "/api/session/\(id)/permission", json: ["data": [asked]])
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        workspace.handle(try engine.event("permission.asked", asked))
        #expect(workspace.waitingCount == 1)

        // Halfway through its reply.
        let step: [String: Any] = ["assistantMessageID": "msg_02", "agent": "build", "model": ["id": "m", "providerID": "p"]]
        model.apply(try engine.event("session.step.started", session: id, step))
        model.apply(try engine.event("session.text.started", session: id, ["assistantMessageID": "msg_02", "ordinal": 0]))
        model.apply(try engine.event("session.text.delta", session: id, ["assistantMessageID": "msg_02", "ordinal": 0, "delta": "The linker can't"]))
        #expect(workspace.isWorking(id))

        // The feed goes. Meanwhile the agent finished; the question was answered on the phone, and
        // another one asked.
        let reply: [String: Any] = ["id": "msg_02", "type": "assistant", "agent": "build", "time": ["created": 2, "completed": 3],
                                    "model": ["id": "m", "providerID": "p"], "content": [["type": "text", "text": answer]]]
        let again: [String: Any] = ["id": "per_push", "sessionID": id, "action": "shell", "resources": ["git push"]]
        engine.list([session()], running: [])
        engine.conversation(id, [you, reply])
        engine.on("GET", "/api/session/\(id)/permission", json: ["data": [again]])

        // Back.
        await workspace.resync()
        let texts = model.transcript.messages.compactMap { message -> String? in
            guard case .assistant(let assistant) = message else { return nil }
            return assistant.content.compactMap { if case .text(let text) = $0 { text.text } else { nil } }.joined()
        }
        #expect(texts == [answer], "the whole reply, once")
        #expect(!model.isRunning)
        #expect(!workspace.isWorking(id), "it no longer shows working")
        #expect(model.permissions.map(\.id) == ["per_push"], "the one answered elsewhere goes, the new one shows")
        #expect(workspace.waitingCount == 1)
        #expect(workspace.needsAttention(id))
    }

    /// Back while the agent is still writing: the reply goes on from the words on screen, none lost
    /// and none twice, though the engine's copy has none of a block's words until it ends, and more
    /// of them came while it was read.
    @Test func aReplyStillBeingWrittenKeepsItsWordsWhenItsBack() async throws {
        defer { engine.stop() }
        engine.list([session()], running: [id])
        engine.conversation(id, [you])
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        let step: [String: Any] = ["assistantMessageID": "msg_02", "agent": "build", "model": ["id": "m", "providerID": "p"]]
        model.apply(try engine.event("session.step.started", session: id, step))
        model.apply(try engine.event("session.text.started", session: id, ["assistantMessageID": "msg_02", "ordinal": 0]))
        model.apply(try engine.event("session.text.delta", session: id, ["assistantMessageID": "msg_02", "ordinal": 0, "delta": "The linker can't"]))

        // Back: the conversation is read again, and more words come while it's on its way.
        let writing: [String: Any] = ["id": "msg_02", "type": "assistant", "agent": "build", "time": ["created": 2],
                                      "model": ["id": "m", "providerID": "p"], "content": [["type": "text", "text": ""]]]
        let gate = Gate()
        defer { gate.open() }
        let answer = StubWeb.json(["data": [writing, you]])
        engine.on("GET", "/api/session/\(id)/message") { _ in
            gate.wait()
            return answer
        }
        let reads = engine.requests("GET", "/api/session/\(id)/message").count
        let resync = Task { await workspace.resync() }
        try await until { engine.requests("GET", "/api/session/\(id)/message").count > reads }
        model.apply(try engine.event("session.text.delta", session: id, ["assistantMessageID": "msg_02", "ordinal": 0, "delta": " find libz"]))
        gate.open()
        await resync.value

        let texts = model.transcript.messages.compactMap { message -> String? in
            guard case .assistant(let assistant) = message else { return nil }
            return assistant.content.compactMap { if case .text(let text) = $0 { text.text } else { nil } }.joined()
        }
        #expect(texts == ["The linker can't find libz"])
    }

    /// This Mac's engine back while a machine's ask is answered elsewhere (on the phone): it stays
    /// answered, rather than coming back as waiting on you.
    @Test func aMachinesAskAnsweredWhileThisMacsEngineIsReadStaysAnswered() async throws {
        defer { engine.stop() }
        engine.list([session()])
        engine.conversation(id, [you])
        workspace.machines = ["far.invalid"]
        await workspace.refresh()
        // A conversation of this Mac's open, read again as its engine comes back.
        await try #require(workspace.model(for: id)).load()
        let asked: [String: Any] = ["id": "per_far", "sessionID": "ses_far", "action": "shell", "resources": ["make deploy"]]
        workspace.handle(try engine.event("permission.asked", asked), machine: "far.invalid")
        #expect(workspace.waitingCount == 1)

        let gate = Gate()
        defer { gate.open() }
        let answer = StubWeb.json(["data": [you]])
        engine.on("GET", "/api/session/\(id)/message") { _ in
            gate.wait()
            return answer
        }
        let reads = engine.requests("GET", "/api/session/\(id)/message").count
        let resync = Task { await workspace.resync() }
        try await until { engine.requests("GET", "/api/session/\(id)/message").count > reads }
        workspace.handle(try engine.event("permission.replied", ["requestID": "per_far", "sessionID": "ses_far", "reply": "once"]), machine: "far.invalid")
        gate.open()
        await resync.value
        #expect(workspace.waitingCount == 0)
    }
}
