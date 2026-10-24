import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Messages waiting for the agent (A6, B12): what's left waiting when the app quit, when you stop
/// the agent, or when its run fails waits under Paused rather than starting on its own, and Resume
/// gives the agent the first of it. The engine is stubbed; what the app asked of it is recorded.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct QueueTests {
    let engine = StubEngine(port: 47993)
    let workspace = Workspace()
    let id = "ses_queue"
    let queued: [String: Any] = ["id": "msg_02", "sessionID": "ses_queue", "type": "user", "delivery": "queue",
                                 "payload": ["text": "Then update the docs"]]
    let first: [String: Any] = ["id": "msg_01", "type": "user", "time": ["created": 1], "text": "Fix the build"]

    init() {
        workspace.api = engine.api
    }

    /// The session with `inbox` waiting, at work or not: its conversation as the engine has it.
    private func open(running: Bool, inbox: [[String: Any]]) async throws -> SessionModel {
        engine.list([StubEngine.session(id, title: "Queue", directory: "/tmp/kuvo-tests-queue")], running: running ? [id] : [])
        engine.on("GET", "/api/session/\(id)/inbox", json: ["data": inbox])
        engine.conversation(id, [first])
        engine.on("PATCH", "/api/session/\(id)/inbox/*", json: [:])
        engine.on("POST", "/api/session/\(id)/prompt", json: [:])
        engine.on("POST", "/api/session/\(id)/interrupt", json: ["interrupted": true])
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        return model
    }

    /// A delivery change the app asked for, for the queued message.
    private var deliveries: [String] { engine.requests("PATCH", "/inbox/msg_02").compactMap { $0.body["delivery"] as? String } }

    /// The app quit with a message queued and nothing running: on opening, it waits under Paused
    /// (the agent doesn't start on it by itself); Resume hands it to the agent.
    @Test func aQueueLeftWhenTheAppQuitWaitsForResume() async throws {
        defer { engine.stop() }
        let model = try await open(running: false, inbox: [queued])
        #expect(model.waiting.map(\.text) == ["Then update the docs"])
        #expect(model.isQueuePaused, "a queue found on opening should wait for Resume")
        #expect(deliveries.isEmpty, "nothing should be handed to the agent before Resume")

        model.resumeQueue()
        try await until { !deliveries.isEmpty }
        #expect(deliveries == ["steer"], "Resume should hand the first queued message to the agent")
        #expect(!model.isQueuePaused)
    }

    /// Stop while a message waits its turn: the agent is interrupted, and the message stays,
    /// paused, rather than starting a new run as this one ends. Resume sends it.
    @Test func stopHoldsTheQueueUntilResume() async throws {
        defer { engine.stop() }
        let model = try await open(running: true, inbox: [queued])
        #expect(model.isRunning)
        #expect(!model.isQueuePaused, "a queue behind a run isn't paused")

        model.stop()
        try await until { !engine.requests("POST", "/interrupt").isEmpty }
        #expect(engine.requests("POST", "/interrupt").first?.query["resume"] == nil, "Stop shouldn't ask the engine to carry on")
        model.apply(try engine.event("session.execution.interrupted", session: id, ["reason": "user"]))
        #expect(!model.isRunning)
        #expect(model.isQueuePaused, "what waited should stay paused after Stop")
        #expect(model.waiting.map(\.text) == ["Then update the docs"])

        model.resumeQueue()
        try await until { !deliveries.isEmpty }
        #expect(deliveries == ["steer"])
    }

    /// A run that fails doesn't run the queue into the same error: it waits, paused.
    @Test func aFailedRunPausesTheQueue() async throws {
        defer { engine.stop() }
        let model = try await open(running: true, inbox: [queued])
        model.apply(try engine.event("session.execution.failed", session: id, ["error": ["type": "provider", "message": "Model is overloaded"]]))
        #expect(!model.isRunning)
        #expect(model.isQueuePaused)
        #expect(model.waiting.map(\.text) == ["Then update the docs"])
    }

    /// A run that ends well goes on to what's queued (the engine does, and the app nudges it
    /// after one that was interrupted): nothing is held.
    @Test func aRunThatEndsWellGoesOnToTheQueue() async throws {
        defer { engine.stop() }
        let model = try await open(running: true, inbox: [queued])
        model.apply(try engine.event("session.execution.succeeded", session: id))
        #expect(!model.isQueuePaused)
        try await until { !deliveries.isEmpty }
        #expect(deliveries == ["steer"], "the next queued message should be handed to the agent")
    }

    /// A message for the agent's next step (sent while it works, without Queue), then Stop before
    /// the agent took it: it isn't lost or sent into a new run; it waits, paused, ahead of what was
    /// queued before it, and Resume gives it to the agent first.
    @Test func stopHoldsAMessageForTheNextStepAheadOfTheQueue() async throws {
        defer { engine.stop() }
        let model = try await open(running: true, inbox: [queued])
        model.send("Also run the linter", for: nil)
        try await until { !engine.requests("POST", "/prompt").isEmpty }
        let sent = try #require(engine.requests("POST", "/prompt").first)
        #expect(sent.body["delivery"] as? String == "steer")
        let steering = try #require(sent.body["id"] as? String)
        // The engine has it, for the next step.
        model.apply(try engine.event("session.inbox.enqueued", session: id, [
            "inboxID": steering, "item": ["type": "user", "delivery": "steer", "payload": ["text": "Also run the linter"]],
        ]))
        #expect(model.waiting.map(\.text) == ["Also run the linter", "Then update the docs"])

        model.stop()
        try await until { !engine.requests("POST", "/interrupt").isEmpty }
        let held = engine.requests("PATCH", "/inbox/\(steering)").compactMap { $0.body["delivery"] as? String }
        #expect(held == ["queue"], "Stop should move the message for the next step to the queue, so it doesn't start a run")
        model.apply(try engine.event("session.inbox.delivery.changed", session: id, ["inboxID": steering, "delivery": "queue"]))
        model.apply(try engine.event("session.execution.interrupted", session: id, ["reason": "user"]))
        #expect(model.isQueuePaused)
        #expect(model.waiting.map(\.text) == ["Also run the linter", "Then update the docs"], "the held message stays ahead of the queue")

        model.resumeQueue()
        try await until { engine.requests("PATCH", "/inbox/\(steering)").count == 2 }
        #expect(engine.requests("PATCH", "/inbox/\(steering)").last?.body["delivery"] as? String == "steer", "Resume should give the agent the held message first")
        #expect(deliveries.isEmpty, "what was queued after it waits its turn")
    }

    /// Stop while a message for the next step is still on its way to the engine: once it's there it
    /// goes to the queue, before the agent is stopped, so it can't start a new run on an idle
    /// session.
    @Test func stopWhileAMessageIsOnItsWayHoldsItToo() async throws {
        defer { engine.stop() }
        let model = try await open(running: true, inbox: [queued])
        let gate = Gate()
        defer { gate.open() }
        engine.on("POST", "/api/session/\(id)/prompt") { _ in
            gate.wait()
            return StubWeb.json([:])
        }
        model.send("Also run the linter", for: nil)
        try await until { !engine.requests("POST", "/prompt").isEmpty }
        let steering = try #require(engine.requests("POST", "/prompt").first?.body["id"] as? String)
        model.stop()
        try await until { model.isQueuePaused }
        #expect(engine.requests("POST", "/interrupt").isEmpty, "the agent is stopped only once the message is in")
        gate.open()
        try await until { !engine.requests("POST", "/interrupt").isEmpty }
        let order = engine.asked.filter { $0.contains("/inbox/\(steering)") || $0.hasSuffix("/interrupt") }
        #expect(order == ["PATCH /api/session/\(id)/inbox/\(steering)", "POST /api/session/\(id)/interrupt"])
        #expect(engine.requests("PATCH", "/inbox/\(steering)").first?.body["delivery"] as? String == "queue")
    }

    /// The app quit with a message for the agent's next step still waiting (the run it was for
    /// ended with the app): on opening, it waits under Paused with the rest, to send with Resume,
    /// rather than showing as sending for ever.
    @Test func aMessageForTheNextStepLeftWhenTheAppQuitWaitsForResume() async throws {
        defer { engine.stop() }
        let steering: [String: Any] = ["id": "msg_03", "sessionID": id, "type": "user", "delivery": "steer",
                                       "payload": ["text": "Also run the linter"]]
        let model = try await open(running: false, inbox: [steering, queued])
        #expect(model.isQueuePaused)
        #expect(model.waiting.map(\.text) == ["Also run the linter", "Then update the docs"], "both wait, the one for the next step first")
        // Held where it is, so the engine doesn't start it on its own either.
        #expect(engine.requests("PATCH", "/inbox/msg_03").map { $0.body["delivery"] as? String } == ["queue"])
        model.apply(try engine.event("session.inbox.delivery.changed", session: id, ["inboxID": "msg_03", "delivery": "queue"]))
        model.resumeQueue()
        try await until { engine.requests("PATCH", "/inbox/msg_03").count > 1 }
        #expect(engine.requests("PATCH", "/inbox/msg_03").last?.body["delivery"] as? String == "steer", "Resume gives it to the agent first")
        #expect(deliveries.isEmpty, "what was queued waits its turn")
    }

    /// Opened when the engine couldn't say what it runs (a machine's slow to answer, say): a
    /// message for the next step stays where it is, for the agent to take if it's at work.
    @Test func aMessageForTheNextStepStaysWhenItsUnknownWhetherItRuns() async throws {
        defer { engine.stop() }
        let steering: [String: Any] = ["id": "msg_03", "sessionID": id, "type": "user", "delivery": "steer",
                                       "payload": ["text": "Also run the linter"]]
        engine.on("GET", "/api/session/active", json: ["data": "not an answer"])
        _ = try await open(running: false, inbox: [steering])
        #expect(engine.requests("PATCH", "/inbox/msg_03").isEmpty, "not moved to the queue")
    }
}
