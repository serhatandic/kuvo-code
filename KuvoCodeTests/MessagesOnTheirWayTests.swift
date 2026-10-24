import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A message you send, from the composer to the agent (B12): for its next step while it works,
/// queued for after the run, removed or taken back for editing on its way, and held when you press
/// Stop as it goes. What the queue shows at each point, and what the app asks of the engine, are
/// checked. The engine is stubbed; a request it holds (a `Gate`) is one still on its way.
@MainActor
@Suite(.serialized) struct MessagesOnTheirWayTests {
    let engine = StubEngine(port: 47904)
    let workspace = Workspace()
    let id = "ses_outgoing_\(UUID().uuidString.prefix(8).lowercased())"
    let first: [String: Any] = ["id": "msg_01", "type": "user", "time": ["created": 1], "text": "Fix the build"]

    init() {
        workspace.api = engine.api
    }

    private func done() {
        engine.stop()
        Drafts.shared.remove(id)
    }

    /// A message waiting in the engine's queue, as its inbox lists it.
    private func queued(_ message: String, _ text: String) -> [String: Any] {
        ["id": message, "sessionID": id, "type": "user", "delivery": "queue", "payload": ["text": text]]
    }

    /// The session with `inbox` waiting, at work or not.
    private func open(running: Bool, inbox: [[String: Any]] = []) async throws -> SessionModel {
        engine.list([StubEngine.session(id, title: "Outgoing", directory: "/tmp/kuvo-tests-outgoing")], running: running ? [id] : [])
        engine.on("GET", "/api/session/\(id)/inbox", json: ["data": inbox])
        engine.conversation(id, [first])
        engine.on("PATCH", "/api/session/\(id)/inbox/*", json: [:])
        engine.on("DELETE", "/api/session/\(id)/inbox/*", json: [:])
        engine.on("POST", "/api/session/\(id)/prompt", json: [:])
        engine.on("POST", "/api/session/\(id)/interrupt", json: ["interrupted": true])
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        return model
    }

    /// The deliveries the app asked the engine to change `message` to, in order.
    private func deliveries(of message: String) -> [String] {
        engine.requests("PATCH", "/inbox/\(message)").compactMap { $0.body["delivery"] as? String }
    }

    /// Messages sent from now on stay in preparation, not yet asked of the engine, until `gate`
    /// opens: the folder's tools are still connecting, which a message waits for.
    private func holdInPreparation(until gate: Gate) {
        let connecting = StubWeb.json(["location": ["directory": "/"], "data": [["name": "tools", "status": ["status": "pending"]]]])
        engine.on("GET", "/api/mcp") { _ in gate.isOpen ? StubWeb.Answer(status: 404) : connecting }
    }

    private var prompts: [StubEngine.Request] { engine.requests("POST", "/api/session/\(id)/prompt") }

    /// The engine's word that it has `message`, waiting as `delivery`.
    private func enqueued(_ message: String, _ text: String, _ delivery: String) throws -> ServerEvent {
        try engine.event("session.inbox.enqueued", session: id, [
            "inboxID": message, "item": ["type": "user", "delivery": delivery, "payload": ["text": text]],
        ])
    }

    private func inbox(_ type: String, _ message: String) throws -> ServerEvent {
        try engine.event("session.inbox.\(type)", session: id, ["inboxID": message])
    }

    private func userMessages(in model: SessionModel) -> [String] {
        model.transcript.messages.compactMap { if case .user(let user) = $0 { user.text } else { nil } }
    }

    /// Sent while the agent works: it shows at once, sending, then as the engine's, for the
    /// agent's next step, and joins the conversation when the agent takes it. Nothing else is
    /// asked of the engine: it isn't moved, nudged or interrupted.
    @Test func aMessageSentWhileItWorksGoesToItsNextStep() async throws {
        defer { done() }
        let model = try await open(running: true)
        model.send("Also run the linter", for: nil)
        #expect(model.waiting.map(\.text) == ["Also run the linter"])
        #expect(model.waiting.first?.isLocal == true, "shown as sending")
        await model.messagesSent()
        let sent = try #require(prompts.first)
        #expect(sent.body["delivery"] as? String == "steer")
        let message = try #require(sent.body["id"] as? String)

        model.apply(try enqueued(message, "Also run the linter", "steer"))
        #expect(model.waiting.map(\.text) == ["Also run the linter"])
        #expect(model.waiting.first?.isLocal == false)
        #expect(model.waiting.first?.delivery == .steer)
        model.apply(try inbox("delivered", message))
        #expect(model.waiting.isEmpty)
        #expect(userMessages(in: model) == ["Fix the build", "Also run the linter"])
        #expect(engine.requests("PATCH", "/inbox/\(message)").isEmpty)
        #expect(engine.requests("POST", "/interrupt").isEmpty)
    }

    /// Sent while nothing runs: it starts the run, so it never shows as waiting, and joins the
    /// conversation when the agent takes it.
    @Test func aMessageSentWhileIdleStartsTheRunWithoutWaiting() async throws {
        defer { done() }
        let model = try await open(running: false)
        model.send("Fix the tests", for: nil)
        #expect(model.waiting.isEmpty)
        await model.messagesSent()
        let message = try #require(prompts.first?.body["id"] as? String)
        #expect(prompts.first?.body["delivery"] as? String == "steer")
        model.apply(try enqueued(message, "Fix the tests", "steer"))
        model.apply(try engine.event("session.execution.started", session: id))
        #expect(model.waiting.isEmpty, "the run it starts isn't something it waits for")
        model.apply(try inbox("delivered", message))
        #expect(model.waiting.isEmpty)
        #expect(userMessages(in: model) == ["Fix the build", "Fix the tests"])
    }

    /// Queued while it works, and the run is stopped from elsewhere: the engine doesn't start a
    /// queued message after an interrupt, so the app hands it to the agent once it's idle, once.
    @Test func aQueuedMessageGoesOnceTheAgentIsIdle() async throws {
        defer { done() }
        let model = try await open(running: true)
        model.send("Then update the docs", for: nil, queue: true)
        await model.messagesSent()
        let sent = try #require(prompts.first)
        #expect(sent.body["delivery"] as? String == "queue")
        let message = try #require(sent.body["id"] as? String)
        model.apply(try enqueued(message, "Then update the docs", "queue"))
        #expect(model.waiting.map(\.text) == ["Then update the docs"])
        #expect(!model.isQueuePaused)

        model.apply(try engine.event("session.execution.interrupted", session: id, ["reason": "user"]))
        #expect(!model.isRunning)
        try await eventually { !deliveries(of: message).isEmpty }
        #expect(deliveries(of: message) == ["steer"])
        model.apply(try engine.event("session.inbox.delivery.changed", session: id, ["inboxID": message, "delivery": "steer"]))
        model.apply(try engine.event("session.execution.started", session: id))
        model.apply(try inbox("delivered", message))
        #expect(model.waiting.isEmpty)
        #expect(deliveries(of: message) == ["steer"], "handed over once")
    }

    /// Stop while a message for the next step is still on its way to the engine: it shows under
    /// Paused at once, ahead of the queue; the agent is stopped only once the engine has it in the
    /// queue, so it never starts a run on its own; Resume sends it, once.
    @Test func stopAsAMessageGoesHoldsItUntilResumeSendsItOnce() async throws {
        defer { done() }
        let model = try await open(running: true, inbox: [queued("msg_02", "Then update the docs")])
        let gate = Gate()
        defer { gate.open() }
        engine.on("POST", "/api/session/\(id)/prompt") { _ in
            gate.wait()
            return StubWeb.json([:])
        }
        model.send("Also run the linter", for: nil)
        try await eventually { !prompts.isEmpty }
        let sent = try #require(prompts.first)
        #expect(sent.body["delivery"] as? String == "steer")
        let message = try #require(sent.body["id"] as? String)

        model.stop()
        try await eventually { model.isQueuePaused }
        #expect(model.waiting.map(\.text) == ["Also run the linter", "Then update the docs"], "held, ahead of the queue, while on its way")
        #expect(engine.requests("POST", "/interrupt").isEmpty, "not stopped before the message is in")

        gate.open()
        try await eventually { !engine.requests("POST", "/interrupt").isEmpty }
        let order = engine.asked.filter { $0.contains("/inbox/\(message)") || $0.hasSuffix("/interrupt") }
        #expect(order == ["PATCH /api/session/\(id)/inbox/\(message)", "POST /api/session/\(id)/interrupt"])
        #expect(deliveries(of: message) == ["queue"])

        // The engine's word: it has it, moved to the queue, and the run stopped.
        model.apply(try enqueued(message, "Also run the linter", "steer"))
        model.apply(try engine.event("session.inbox.delivery.changed", session: id, ["inboxID": message, "delivery": "queue"]))
        model.apply(try engine.event("session.execution.interrupted", session: id, ["reason": "user"]))
        #expect(!model.isRunning)
        #expect(model.isQueuePaused)
        #expect(model.waiting.map(\.text) == ["Also run the linter", "Then update the docs"])
        #expect(model.waiting.first?.isLocal == false)
        #expect(deliveries(of: message) == ["queue"], "nothing hands it to the agent before Resume")

        model.resumeQueue()
        try await eventually { deliveries(of: message).count == 2 }
        #expect(deliveries(of: message) == ["queue", "steer"], "Resume gives it to the agent first")
        model.apply(try engine.event("session.inbox.delivery.changed", session: id, ["inboxID": message, "delivery": "steer"]))
        model.apply(try engine.event("session.execution.started", session: id))
        model.apply(try inbox("delivered", message))
        #expect(model.waiting.map(\.text) == ["Then update the docs"])
        #expect(userMessages(in: model) == ["Fix the build", "Also run the linter"])
        #expect(prompts.count == 1, "sent once")
        #expect(deliveries(of: "msg_02").isEmpty, "what was queued after it waits its turn")
    }

    /// Stop as a message goes, then removed from under Paused while its request is still on its
    /// way: it's taken back before the agent is stopped, so it can't start a run afterwards.
    @Test func aHeldMessageRemovedOnItsWayIsTakenBackBeforeTheStop() async throws {
        defer { done() }
        let model = try await open(running: true, inbox: [queued("msg_02", "Then update the docs")])
        let gate = Gate()
        defer { gate.open() }
        engine.on("POST", "/api/session/\(id)/prompt") { _ in
            gate.wait()
            return StubWeb.json([:])
        }
        model.send("Also run the linter", for: nil)
        try await eventually { !prompts.isEmpty }
        let message = try #require(prompts.first?.body["id"] as? String)
        model.stop()
        try await eventually { model.isQueuePaused }
        model.cancelPending(try #require(model.waiting.first { $0.id == message }))
        #expect(model.waiting.map(\.text) == ["Then update the docs"])

        gate.open()
        try await eventually { !engine.requests("POST", "/interrupt").isEmpty }
        let order = engine.asked.filter { $0 == "DELETE /api/session/\(id)/inbox/\(message)" || $0.hasSuffix("/interrupt") }
        #expect(order == ["DELETE /api/session/\(id)/inbox/\(message)", "POST /api/session/\(id)/interrupt"])
    }

    /// Stop before a message for the next step has left (its folder's tools still being checked):
    /// the agent is stopped at once, and the message goes to the queue rather than its next step.
    @Test func stopBeforeAMessageLeftSendsItToTheQueue() async throws {
        defer { done() }
        let model = try await open(running: true, inbox: [queued("msg_02", "Then update the docs")])
        let gate = Gate()
        defer { gate.open() }
        holdInPreparation(until: gate)
        model.send("Also run the linter", for: nil)
        try await eventually { !engine.requests("GET", "/api/mcp").isEmpty }
        model.stop()
        try await eventually { !engine.requests("POST", "/interrupt").isEmpty }
        #expect(prompts.isEmpty, "stopped without waiting for it")
        #expect(model.isQueuePaused)
        #expect(model.waiting.map(\.text) == ["Also run the linter", "Then update the docs"])

        gate.open()
        await model.messagesSent()
        let sent = try #require(prompts.first)
        #expect(sent.body["delivery"] as? String == "queue")
        let message = try #require(sent.body["id"] as? String)
        #expect(deliveries(of: message).isEmpty, "nothing hands it to the agent before Resume")
        model.apply(try enqueued(message, "Also run the linter", "queue"))
        model.apply(try engine.event("session.execution.interrupted", session: id, ["reason": "user"]))
        #expect(model.waiting.map(\.text) == ["Also run the linter", "Then update the docs"])
    }

    /// Removed while its request is on its way: it goes from the queue at once, and the app takes
    /// it back from the engine as soon as the engine has it; nothing comes back to the composer.
    @Test func aMessageRemovedOnItsWayIsTakenBack() async throws {
        defer { done() }
        let model = try await open(running: true)
        let gate = Gate()
        defer { gate.open() }
        engine.on("POST", "/api/session/\(id)/prompt") { _ in
            gate.wait()
            return StubWeb.json([:])
        }
        model.send("Also run the linter", for: nil)
        try await eventually { !prompts.isEmpty }
        let message = try #require(prompts.first?.body["id"] as? String)
        let item = try #require(model.waiting.first)
        model.cancelPending(item)
        #expect(model.waiting.isEmpty)

        gate.open()
        try await eventually { !engine.requests("DELETE", "/inbox/\(message)").isEmpty }
        await model.messagesSent()
        model.apply(try enqueued(message, "Also run the linter", "steer"))
        model.apply(try inbox("cancelled", message))
        #expect(model.waiting.isEmpty)
        #expect(model.draftText.isEmpty)
        #expect(userMessages(in: model) == ["Fix the build"])
    }

    /// Removed once its request went but before the engine's word of it came (it still shows as
    /// sending): the engine has it, so the app takes it back.
    @Test func aMessageRemovedAsItArrivesIsTakenBack() async throws {
        defer { done() }
        let model = try await open(running: true)
        model.send("Also run the linter", for: nil)
        await model.messagesSent()
        let message = try #require(prompts.first?.body["id"] as? String)
        let item = try #require(model.waiting.first)
        #expect(item.isLocal)
        model.cancelPending(item)
        #expect(model.waiting.isEmpty)
        try await eventually { !engine.requests("DELETE", "/inbox/\(message)").isEmpty }
        #expect(engine.requests("DELETE", "/inbox/\(message)").count == 1)
    }

    /// Removed before it left: it's never sent.
    @Test func aMessageRemovedBeforeItLeftIsNeverSent() async throws {
        defer { done() }
        let model = try await open(running: true)
        let gate = Gate()
        defer { gate.open() }
        holdInPreparation(until: gate)
        model.send("Also run the linter", for: nil)
        try await eventually { !engine.requests("GET", "/api/mcp").isEmpty }
        let item = try #require(model.waiting.first)
        model.cancelPending(item)
        #expect(model.waiting.isEmpty)
        gate.open()
        await model.messagesSent()
        #expect(prompts.isEmpty)
        #expect(model.draftText.isEmpty)
    }

    /// Edit on queued messages as the agent takes them: one the agent took before the cancel
    /// reached the engine stays in the conversation and doesn't come back to the composer; one
    /// whose cancel won (the engine's word coming after its answer) comes back, once.
    @Test func editingAsTheAgentTakesAMessageKeepsItOnce() async throws {
        defer { done() }
        let model = try await open(running: true, inbox: [queued("msg_02", "Then update the docs"), queued("msg_04", "And bump the version")])
        #expect(model.waiting.map(\.text) == ["Then update the docs", "And bump the version"])
        let taken = Gate(), cancelled = Gate()
        defer {
            taken.open()
            cancelled.open()
        }
        engine.on("DELETE", "/api/session/\(id)/inbox/msg_02") { _ in
            taken.wait()
            return StubWeb.json([:])
        }
        engine.on("DELETE", "/api/session/\(id)/inbox/msg_04") { _ in
            cancelled.wait()
            return StubWeb.json([:])
        }

        // The agent takes it while the cancel is on its way.
        model.edit(try #require(model.waiting.first { $0.id == "msg_02" }))
        try await eventually { !engine.requests("DELETE", "/inbox/msg_02").isEmpty }
        model.apply(try inbox("delivered", "msg_02"))
        taken.open()

        // This one's cancel wins, and the engine says so after answering.
        model.edit(try #require(model.waiting.first { $0.id == "msg_04" }))
        try await eventually { !engine.requests("DELETE", "/inbox/msg_04").isEmpty }
        cancelled.open()
        model.apply(try inbox("cancelled", "msg_04"))
        try await eventually { !model.draftText.isEmpty }
        #expect(model.draftText == "And bump the version")
        #expect(model.waiting.isEmpty)
        #expect(userMessages(in: model) == ["Fix the build", "Then update the docs"])
    }
}
