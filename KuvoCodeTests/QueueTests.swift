import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Messages waiting for the agent (A6, B12), as this Mac shows and changes them: the session's box
/// carries the queue (PROTOCOL.md, "The queue"; what it decides by itself, after a run, a failure or
/// a restart, is the bridge's queue test). Stop asks the box, which holds what was for the next
/// step ahead of the queue and pauses it; the queue shows Paused and in that order, as the box
/// says; Resume and Send Now go through the box too. This Mac's box is the real one, its engine a
/// stand-in whose inbox changes as it's asked to.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct QueueTests {
    let engine = StubEngine(port: 47993)
    let workspace = Workspace()
    let id = "ses_queue"
    let first: [String: Any] = ["id": "msg_01", "type": "user", "time": ["created": 1], "text": "Fix the build"]

    /// The engine's inbox: what's sent lands as it was asked to go, a delivery changed changes it.
    nonisolated final class Inbox: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [[String: Any]]
        init(_ items: [[String: Any]]) { self.items = items }
        var all: [[String: Any]] { lock.withLock { items } }
        func add(_ id: String, _ text: String, _ delivery: String) {
            lock.withLock { items.append(["id": id, "sessionID": "ses_queue", "type": "user", "delivery": delivery, "payload": ["text": text]]) }
        }
        func set(_ id: String, _ delivery: String) {
            lock.withLock { for index in items.indices where items[index]["id"] as? String == id { items[index]["delivery"] = delivery } }
        }
    }

    init() {
        workspace.api = engine.api
    }

    private func queued(_ message: String, _ text: String) -> [String: Any] {
        ["id": message, "sessionID": id, "type": "user", "delivery": "queue", "payload": ["text": text]]
    }

    /// The session, at work or not, with `inbox` waiting, and its box (this Mac's), as the app
    /// reaches it. `queues`: what the box keeps, before it starts.
    private func open(running: Bool, inbox: [[String: Any]], queues: String? = nil, prompt: ((StubEngine.Request) -> Void)? = nil) async throws -> (SessionModel, TestBox, Inbox) {
        let session = StubEngine.session(id, title: "Queue", directory: "/tmp/kuvo-tests-queue")
        engine.list([session], running: running ? [id] : [])
        let kept = Inbox(inbox)
        engine.on("GET", "/api/session/\(id)", json: ["data": session])
        engine.on("GET", "/api/session/\(id)/inbox") { _ in StubWeb.json(["data": kept.all]) }
        engine.conversation(id, [first])
        engine.on("PATCH", "/api/session/\(id)/inbox/*") { request in
            kept.set(String(request.path.split(separator: "/").last ?? ""), request.body["delivery"] as? String ?? "")
            return StubWeb.json([:])
        }
        engine.on("POST", "/api/session/\(id)/prompt") { request in
            prompt?(request)
            kept.add(request.body["id"] as? String ?? "", request.body["text"] as? String ?? "", request.body["delivery"] as? String ?? "")
            return StubWeb.json([:])
        }
        engine.on("POST", "/api/session/\(id)/interrupt", json: ["interrupted": true])
        let box = try await TestBox(engine: engine.url)
        if let queues {
            try FileManager.default.createDirectory(at: BoxProcess.run, withIntermediateDirectories: true)
            try Data(queues.utf8).write(to: BoxProcess.run.appending(path: "queues.json"))
        }
        let url = engine.url
        workspace.boxes = { $0 == BoxClient.mac ? box.client(engine: url) : nil }
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        return (model, box, kept)
    }

    /// The run over, as the engine says.
    private func stopped() {
        engine.list([StubEngine.session(id, title: "Queue", directory: "/tmp/kuvo-tests-queue")], running: [])
    }

    /// A delivery change asked for `message`, in order.
    private func deliveries(of message: String) -> [String] {
        engine.requests("PATCH", "/inbox/\(message)").compactMap { $0.body["delivery"] as? String }
    }

    /// A queue its box keeps paused (it found it waiting as its engine started, a run failed): it
    /// shows under Paused, held first; Resume asks the box, which hands the agent what it held.
    @Test func aQueueTheBoxPausedShowsPausedAndResumeGoesOnWithWhatItHeld() async throws {
        let (model, box, _) = try await open(running: false, inbox: [queued("msg_02", "Then update the docs"), queued("msg_03", "Also run the linter")],
                                             queues: #"{"ses_queue":{"paused":true,"held":["msg_03"]}}"#)
        defer { box.stop(); engine.stop() }
        try await until { model.isQueuePaused }
        #expect(model.waiting.map(\.text) == ["Also run the linter", "Then update the docs"], "what Stop held first")
        #expect(deliveries(of: "msg_02").isEmpty && deliveries(of: "msg_03").isEmpty)

        model.resumeQueue()
        try await until { !deliveries(of: "msg_03").isEmpty }
        #expect(deliveries(of: "msg_03") == ["steer"])
        #expect(deliveries(of: "msg_02").isEmpty, "what was queued waits its turn")
        try await until { !model.isQueuePaused }
    }

    /// Stop while a message waits for the agent's next step: the box moves it to the queue, ahead
    /// of what was queued, pauses it and stops the run; the queue shows that.
    @Test func stopHoldsWhatWasForTheNextStepAheadOfTheQueue() async throws {
        let (model, box, kept) = try await open(running: true, inbox: [queued("msg_02", "Then update the docs")])
        defer { box.stop(); engine.stop() }
        kept.add("msg_03", "Also run the linter", "steer")
        model.apply(try engine.event("session.inbox.enqueued", session: id, ["inboxID": "msg_03", "item": ["type": "user", "delivery": "steer", "payload": ["text": "Also run the linter"]]]))

        model.stop()
        try await until { !engine.requests("POST", "/interrupt").isEmpty }
        let order = engine.asked.filter { $0.contains("/inbox/msg_03") && $0.hasPrefix("PATCH") || $0.hasSuffix("/interrupt") }
        #expect(order == ["PATCH /api/session/\(id)/inbox/msg_03", "POST /api/session/\(id)/interrupt"], "held before the run stops, so it doesn't start a new one")
        #expect(deliveries(of: "msg_03") == ["queue"])
        #expect(engine.requests("POST", "/interrupt").first?.query["resume"] == nil, "Stop doesn't ask the engine to carry on")
        model.apply(try engine.event("session.inbox.delivery.changed", session: id, ["inboxID": "msg_03", "delivery": "queue"]))
        model.apply(try engine.event("session.execution.interrupted", session: id, ["reason": "user"]))
        try await until { model.waiting.map(\.text) == ["Also run the linter", "Then update the docs"] }
        #expect(model.isQueuePaused)
    }

    /// Stop while a message for the next step is still on its way to the engine: it shows under
    /// Paused at once, ahead of the queue; the run is stopped only once the engine has it, and the
    /// box holds it then, so it never starts a run on its own; Resume sends it, once.
    @Test func stopAsAMessageGoesHoldsItUntilResumeSendsItOnce() async throws {
        let gate = Gate()
        defer { gate.open() }
        let (model, box, _) = try await open(running: true, inbox: [queued("msg_02", "Then update the docs")]) { _ in gate.wait() }
        defer { box.stop(); engine.stop() }
        model.send("Also run the linter", for: nil)
        try await until { !engine.requests("POST", "/prompt").isEmpty }
        let message = try #require(engine.requests("POST", "/prompt").first?.body["id"] as? String)

        model.stop()
        try await until { model.isQueuePaused }
        #expect(model.waiting.map(\.text) == ["Also run the linter", "Then update the docs"], "held, ahead of the queue, while on its way")
        #expect(engine.requests("POST", "/interrupt").isEmpty, "not stopped before the message is in")

        gate.open()
        try await until { !engine.requests("POST", "/interrupt").isEmpty }
        let order = engine.asked.filter { $0.contains("/inbox/\(message)") && $0.hasPrefix("PATCH") || $0.hasSuffix("/interrupt") }
        #expect(order.first == "PATCH /api/session/\(id)/inbox/\(message)" && order.last == "POST /api/session/\(id)/interrupt")
        #expect(deliveries(of: message).allSatisfy { $0 == "queue" })

        model.apply(try engine.event("session.inbox.enqueued", session: id, ["inboxID": message, "item": ["type": "user", "delivery": "steer", "payload": ["text": "Also run the linter"]]]))
        model.apply(try engine.event("session.inbox.delivery.changed", session: id, ["inboxID": message, "delivery": "queue"]))
        model.apply(try engine.event("session.execution.interrupted", session: id, ["reason": "user"]))
        stopped()
        try await until { model.waiting.first?.isLocal == false }
        #expect(model.isQueuePaused)
        #expect(model.waiting.map(\.text) == ["Also run the linter", "Then update the docs"])

        let held = deliveries(of: message).count
        model.resumeQueue()
        try await until { deliveries(of: message).count > held }
        #expect(deliveries(of: message).last == "steer", "Resume gives it to the agent first")
        #expect(deliveries(of: "msg_02").isEmpty, "what was queued after it waits its turn")
        #expect(engine.requests("POST", "/prompt").count == 1, "sent once")
    }

    /// Send Now on a queued message while the agent works: the box steers it and stops the step
    /// under way for it, and the queue isn't paused.
    @Test func sendNowGoesThroughTheBox() async throws {
        let (model, box, _) = try await open(running: true, inbox: [queued("msg_02", "Then update the docs")], queues: #"{"ses_queue":{"paused":true,"held":[]}}"#)
        defer { box.stop(); engine.stop() }
        let item = try #require(model.waiting.first)
        model.sendNow(item)
        try await until { !engine.requests("POST", "/interrupt").isEmpty }
        #expect(deliveries(of: "msg_02") == ["steer"])
        #expect(engine.requests("POST", "/interrupt").first?.query["resume"] == "true")
        #expect(!model.isQueuePaused)
    }

    /// A queued message removed by mistake: Undo puts it back in the queue, as it was, behind
    /// the run, rather than starting it.
    @Test func undoPutsARemovedMessageBackInTheQueue() async throws {
        engine.on("DELETE", "/api/session/\(id)/inbox/*", json: [:])
        let (model, box, _) = try await open(running: true, inbox: [queued("msg_02", "Then update the docs")])
        defer { box.stop(); engine.stop() }
        let item = try #require(model.waiting.first)
        model.cancelPending(item)
        try await until { !engine.requests("DELETE", "/inbox/msg_02").isEmpty }
        model.apply(try engine.event("session.inbox.cancelled", session: id, ["inboxID": "msg_02"]))

        model.requeue(item, for: nil, paused: false)
        try await until { !engine.requests("POST", "/prompt").isEmpty }
        let back = try #require(engine.requests("POST", "/prompt").first)
        #expect(back.body["text"] as? String == "Then update the docs")
        #expect(back.body["delivery"] as? String == "queue", "it should wait behind the run, as it did")
    }
}
