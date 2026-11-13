import ClientSessions
import ClientText
import Foundation
import KuvoLink
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
        func remove(_ id: String) {
            lock.withLock { items.removeAll { $0["id"] as? String == id } }
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
    /// `older`: its box is a machine's from before the box carried the queue (no `queue` in its
    /// `kuvo/info`, none of the queue's routes).
    private func open(running: Bool, inbox: [[String: Any]], queues: String? = nil, older: Bool = false, prompt: (@Sendable (StubEngine.Request) -> Void)? = nil) async throws -> (SessionModel, TestBox, Inbox) {
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
        engine.on("DELETE", "/api/session/\(id)/inbox/*") { request in
            kept.remove(String(request.path.split(separator: "/").last ?? ""))
            return StubWeb.json([:])
        }
        let box = try await TestBox(engine: engine.url)
        if let queues {
            try FileManager.default.createDirectory(at: BoxProcess.run, withIntermediateDirectories: true)
            try Data(queues.utf8).write(to: BoxProcess.run.appending(path: "queues.json"))
        }
        let url = engine.url
        let olderBox = BoxClient(box: "lab", transport: LocalBox { request in
            AsyncThrowingStream { answer in
                let info = request.path == "kuvo/info"
                answer.yield(.head(status: info ? 200 : 404, headers: ["content-type": "application/json"]))
                answer.yield(.body(Data((info ? #"{"name":"lab","features":["sessions","agent-tools"]}"# : #"{"message":"Not here."}"#).utf8)))
                answer.finish()
            }
        })
        workspace.boxes = { $0 == BoxClient.mac ? (older ? olderBox : box.client(engine: url)) : nil }
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

    /// A message waiting that was sent with a keyword reads as you typed it, the keyword in front,
    /// in its row and the folded line, as its bubble does (it read as the words alone, so a waiting
    /// /goal looked like any message).
    @Test func aMessageWaitingWithAKeywordReadsAsTyped() {
        var goal = Transcript.Pending(id: "msg_8", text: KeptParts.text("Summarize the commits weekly"), delivery: .queue, isLocal: false)
        goal.metadata = KeptParts.value(words: "Summarize the commits weekly", keyword: "/goal")
        var loop = Transcript.Pending(id: "msg_9", text: KeptParts.text("check CI"), delivery: .queue, isLocal: false)
        loop.metadata = KeptParts.value(words: "check CI", keyword: "/loop every hour")
        #expect(QueueRow.summary(of: goal) == "/goal Summarize the commits weekly")
        #expect(QueueRow.summary(of: loop) == "/loop every hour check CI")
        let row = QueueRow.styledSummary(of: goal, folders: [])
        #expect(String(row.characters) == "/goal Summarize the commits weekly")
        #expect(row.runs.first?[KeywordTokenMark.self] == Keyword.goal.symbol, "the keyword drawn as a token, its mark for the \"/\"")
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

    /// A conversation opened as last seen while the engine started (the tab Kuvo Code opens with):
    /// once the engine is up, its queue goes through its box as any other's does. (Resume said its
    /// computer didn't answer, every time, until Kuvo Code quit.)
    @Test func aConversationOpenedBeforeTheEngineWasUpResumesThroughItsBox() async throws {
        let decoder = JSONDecoder()
        let session = try decoder.decode(Session.self, from: JSONSerialization.data(withJSONObject: StubEngine.session(id, title: "Queue", directory: "/tmp/kuvo-tests-queue")))
        SessionCopies.save(.init(session: session, messages: try decoder.decode([Message].self, from: JSONSerialization.data(withJSONObject: [first]))))
        await SessionCopies.written()
        defer { SessionCopies.remove(id) }
        workspace.api = nil
        workspace.add(session)
        let early = try #require(workspace.model(for: id))
        workspace.api = engine.api

        let (model, box, _) = try await open(running: false, inbox: [queued("msg_02", "Then update the docs"), queued("msg_03", "Also run the linter")],
                                             queues: #"{"ses_queue":{"paused":true,"held":["msg_03"]}}"#)
        defer { box.stop(); engine.stop() }
        #expect(model === early, "the same conversation, read in place")
        try await until { model.isQueuePaused }
        #expect(await model.resumeQueue().value)
        try await until { !deliveries(of: "msg_03").isEmpty }
        #expect(deliveries(of: "msg_03") == ["steer"])
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

    /// After Stop, a message removed and brought back with Undo: it waits for Resume on the box,
    /// where it was (first, ahead of the one after it), rather than reaching the engine, which
    /// would run all it holds at once; Resume sends it first, and the rest waits its turn.
    @Test func aMessagePutBackAfterStopWaitsForResume() async throws {
        let (model, box, _) = try await open(running: false, inbox: [queued("msg_02", "Fix the docs"), queued("msg_03", "Then update the changelog")],
                                             queues: #"{"ses_queue":{"paused":true,"held":[]}}"#)
        defer { box.stop(); engine.stop() }
        try await until { model.isQueuePaused }
        let item = try #require(model.waiting.first)
        let before = model.next(after: item)
        model.cancelPending(item)
        try await until { !engine.requests("DELETE", "/inbox/msg_02").isEmpty }
        model.apply(try engine.event("session.inbox.cancelled", session: id, ["inboxID": "msg_02"]))
        try await until { model.waiting.map(\.text) == ["Then update the changelog"] }

        model.requeue(item, for: nil, paused: true, before: before)
        try await until { model.waiting.map(\.text) == ["Fix the docs", "Then update the changelog"] && model.waiting.first.map(model.isOnBox) == true }
        #expect(engine.requests("POST", "/prompt").isEmpty, "held on the box, not sent to the engine")
        #expect(model.isQueuePaused)
        #expect(model.sender(of: try #require(model.waiting.first)) == nil, "yours")

        model.resumeQueue()
        try await until { !engine.requests("POST", "/prompt").isEmpty }
        #expect(engine.requests("POST", "/prompt").first?.body["text"] as? String == "Fix the docs", "back where it was: it goes first")
        #expect(deliveries(of: "msg_03").isEmpty, "the one after it waits its turn")
    }

    /// A stopped conversation stays stopped while others write to it: another agent's letter waits
    /// on the box and shows in the queue with who it's from; a message you send for after this run
    /// waits after it; Remove takes the letter away and Undo puts it back as it was, where it was,
    /// from the same agent; Resume sends the first, and nothing went to the engine before.
    @Test func whatArrivesWhileStoppedWaitsShownWithWhoItsFrom() async throws {
        let (model, box, _) = try await open(running: true, inbox: [])
        defer { box.stop(); engine.stop() }
        let following = Task { await workspace.followQueues() }
        defer { following.cancel() }
        model.stop()
        try await until { !engine.requests("POST", "/interrupt").isEmpty }
        stopped()
        model.apply(try engine.event("session.execution.interrupted", session: id, ["reason": "user"]))
        try await until { model.isQueuePaused }

        struct Letter: Encodable { var id: String; var text: String; var from: String }
        struct Added: Decodable { var waits: Bool }
        let added = try await box.client(engine: engine.url).value(Added.self, "POST", "kuvo/sessions/\(id)/queue/add", body: Letter(id: "msg_ada1", text: "The build is green on main.", from: "Ada"))
        #expect(added.waits)
        try await until { model.waiting.count == 1 }
        let letter = try #require(model.waiting.first)
        #expect(model.sender(of: letter) == "Ada")
        #expect(letter.text == "The build is green on main.")
        #expect(model.isQueuePaused, "still stopped")

        model.send("Also run the tests", for: nil, queue: true)
        try await until { model.waiting.map(\.text) == ["The build is green on main.", "Also run the tests"] && model.waiting.allSatisfy(model.isOnBox) }
        #expect(model.sender(of: model.waiting[1]) == nil)

        model.cancelPending(letter)
        try await until { model.waiting.map(\.text) == ["Also run the tests"] }
        model.requeue(letter, for: nil, paused: true)
        try await until { model.waiting.map(\.text) == ["The build is green on main.", "Also run the tests"] }
        #expect(model.sender(of: model.waiting[0]) == "Ada", "back as it was, where it was")
        #expect(engine.requests("POST", "/prompt").isEmpty, "nothing reached the engine while it was stopped")

        model.resumeQueue()
        try await until { !engine.requests("POST", "/prompt").isEmpty }
        let sent = try #require(engine.requests("POST", "/prompt").first)
        #expect(sent.body["text"] as? String == "The build is green on main.")
        #expect(sent.body["delivery"] as? String == "steer")
        #expect(engine.requests("POST", "/prompt").count == 1, "one run at a time")
    }

    /// Another agent's letter waiting in the engine's queue, removed and put back with Undo: it goes
    /// back as the agent read it, still theirs to answer, never as words of yours.
    @Test func anotherAgentsLetterPutBackStaysTheirs() async throws {
        let letter = "[Message from Ada · ses_ada] (To answer, use send_message to ses_ada.)\n\nThe build is green."
        let (model, box, _) = try await open(running: true, inbox: [queued("msg_02", letter)])
        defer { box.stop(); engine.stop() }
        let item = try #require(model.waiting.first)
        // Read by its box: from Ada.
        #expect(SentMessage.parts(item).mail?.name == "Ada")
        model.cancelPending(item)
        try await until { !engine.requests("DELETE", "/inbox/msg_02").isEmpty }
        model.apply(try engine.event("session.inbox.cancelled", session: id, ["inboxID": "msg_02"]))
        model.requeue(item, for: nil, paused: false)
        try await until { !engine.requests("POST", "/prompt").isEmpty }
        #expect(engine.requests("POST", "/prompt").last?.body["text"] as? String == letter)
    }

    /// Stopped from another client a moment ago, before this Mac heard: a message sent for after
    /// this run still waits on the box, which decides, rather than reaching the engine, which would
    /// run all it holds.
    @Test func aMessageQueuedBeforeThisMacHeardOfAStopStillWaits() async throws {
        let (model, box, _) = try await open(running: true, inbox: [queued("msg_02", "Then update the docs")])
        defer { box.stop(); engine.stop() }
        // Stopped from the phone: its box paused it, and this Mac hasn't read that yet.
        try Data(#"{"ses_queue":{"paused":true,"held":[]}}"#.utf8).write(to: BoxProcess.run.appending(path: "queues.json"))
        #expect(!model.isQueuePaused)

        model.send("Also run the tests", for: nil, queue: true)
        try await until { model.waiting.last.map(model.isOnBox) == true }
        #expect(engine.requests("POST", "/prompt").isEmpty, "held on the box, not sent to the engine")
        #expect(model.waiting.map(\.text) == ["Then update the docs", "Also run the tests"])
        #expect(model.isQueuePaused, "as the box says")
    }

    /// Remove, Undo and Resume at once, as quick hands do: Resume waits for the one Undo brings
    /// back, so the queue goes on one message at a time, the one brought back among them, rather
    /// than going on without it and the one brought back going to the agent too as it arrives.
    @Test func resumeRightAfterUndoGoesOnOneAtATime() async throws {
        let (model, box, _) = try await open(running: true, inbox: [])
        defer { box.stop(); engine.stop() }
        let following = Task { await workspace.followQueues() }
        defer { following.cancel() }
        model.stop()
        try await until { !engine.requests("POST", "/interrupt").isEmpty }
        stopped()
        model.apply(try engine.event("session.execution.interrupted", session: id, ["reason": "user"]))
        try await until { model.isQueuePaused }

        struct Letter: Encodable { var id: String; var text: String; var from: String }
        struct Added: Decodable { var waits: Bool }
        let added = try await box.client(engine: engine.url).value(Added.self, "POST", "kuvo/sessions/\(id)/queue/add", body: Letter(id: "msg_ada1", text: "The build is green on main.", from: "Ada"))
        #expect(added.waits)
        try await until { model.waiting.count == 1 }
        model.send("Also run the tests", for: nil, queue: true)
        try await until { model.waiting.map(\.text) == ["The build is green on main.", "Also run the tests"] && model.waiting.allSatisfy(model.isOnBox) }
        let letter = try #require(model.waiting.first)

        model.cancelPending(letter)
        model.requeue(letter, for: nil, paused: true)
        model.resumeQueue()
        // One went; the other waits for it, or went too.
        let prompts = { engine.requests("POST", "/prompt").compactMap { $0.body["text"] as? String } }
        try await until { prompts().count > 1 || prompts().count == 1 && model.waiting.count == 1 && model.waiting[0].text != prompts()[0] }
        #expect(prompts().count == 1, "one run at a time")
        #expect(Set(prompts() + model.waiting.map(\.text)) == ["The build is green on main.", "Also run the tests"], "the one brought back still there")
    }

    /// Resume its box can't take (it's not running now): the queue shows Paused again, and why.
    @Test func resumeTheBoxDidntTakeStaysPaused() async throws {
        let (model, box, _) = try await open(running: false, inbox: [queued("msg_02", "Then update the docs")], queues: #"{"ses_queue":{"paused":true,"held":[]}}"#)
        defer { engine.stop() }
        try await until { model.isQueuePaused }
        box.stop()
        // (Said, for what Resume was pressed under to show where it says why: a group chat's part.)
        #expect(await model.resumeQueue().value == false)
        #expect(model.isQueuePaused && model.failure != nil)
        #expect(deliveries(of: "msg_02").isEmpty)
    }

    /// A queue this Mac's box pauses after the session was read (it found it waiting as its engine
    /// started): it shows Paused, as this Mac follows its box's queues.
    @Test func aPauseTheBoxMakesLaterShows() async throws {
        let (model, box, _) = try await open(running: false, inbox: [queued("msg_02", "Then update the docs")])
        defer { box.stop(); engine.stop() }
        let following = Task { await workspace.followQueues() }
        defer { following.cancel() }
        #expect(!model.isQueuePaused)
        try Data(#"{"ses_queue":{"paused":true,"held":[]}}"#.utf8).write(to: BoxProcess.run.appending(path: "queues.json"))
        try await until { model.isQueuePaused }
    }

    /// A machine whose box doesn't carry the queue yet (its update to this version didn't get
    /// through): this Mac carries it, as before. Stop pauses it, Resume gives the agent the next
    /// one, a run that ends starts the next, and Send Now gives one right away.
    @Test func onABoxWithoutTheQueueThisMacCarriesIt() async throws {
        let (model, box, kept) = try await open(running: true, inbox: [queued("msg_02", "Then update the docs"), queued("msg_03", "Also run the linter"), queued("msg_04", "And tag it")], older: true)
        defer { box.stop(); engine.stop() }
        model.stop()
        try await until { !engine.requests("POST", "/interrupt").isEmpty }
        #expect(model.isQueuePaused)
        stopped()
        model.apply(try engine.event("session.execution.interrupted", session: id, ["reason": "user"]))
        #expect(model.isQueuePaused, "Stop pauses it")

        model.resumeQueue()
        try await until { !deliveries(of: "msg_02").isEmpty }
        #expect(deliveries(of: "msg_02") == ["steer"])
        #expect(!model.isQueuePaused && model.failure == nil)

        kept.remove("msg_02")
        model.apply(try engine.event("session.inbox.delivered", session: id, ["inboxID": "msg_02"]))
        model.apply(try engine.event("session.execution.started", session: id))
        model.apply(try engine.event("session.execution.succeeded", session: id))
        try await until { !deliveries(of: "msg_03").isEmpty }
        #expect(deliveries(of: "msg_03") == ["steer"], "the next goes as the run ends")

        let last = try #require(model.waiting.first { $0.id == "msg_04" })
        model.sendNow(last)
        try await until { !deliveries(of: "msg_04").isEmpty }
        #expect(deliveries(of: "msg_04") == ["steer"])
        #expect(model.failure == nil)
    }

    /// On a box without the queue, a session opened with messages left waiting (the app quit
    /// mid-run): it waits for Resume, what was for the next step held ahead of the queue; Resume
    /// gives that first; a run that fails holds what came for its next step and pauses again.
    @Test func onABoxWithoutTheQueueALeftQueueWaitsAndAFailedRunPausesIt() async throws {
        let (model, box, kept) = try await open(running: false, inbox: [queued("msg_02", "Then update the docs"), ["id": "msg_03", "sessionID": id, "type": "user", "delivery": "steer", "payload": ["text": "Also run the linter"]]], older: true)
        defer { box.stop(); engine.stop() }
        try await until { model.isQueuePaused && !deliveries(of: "msg_03").isEmpty }
        #expect(deliveries(of: "msg_03") == ["queue"], "held, not left for a step that won't come")
        #expect(deliveries(of: "msg_02").isEmpty)
        model.apply(try engine.event("session.inbox.delivery.changed", session: id, ["inboxID": "msg_03", "delivery": "queue"]))
        #expect(model.waiting.map(\.text) == ["Also run the linter", "Then update the docs"])

        model.resumeQueue()
        try await until { deliveries(of: "msg_03").count == 2 }
        #expect(deliveries(of: "msg_03").last == "steer", "what was held goes first")
        #expect(deliveries(of: "msg_02").isEmpty)

        kept.add("msg_04", "And tag it", "steer")
        model.apply(try engine.event("session.inbox.enqueued", session: id, ["inboxID": "msg_04", "item": ["type": "user", "delivery": "steer", "payload": ["text": "And tag it"]]]))
        model.apply(try engine.event("session.execution.failed", session: id, ["error": ["type": "provider", "message": "Overloaded."]]))
        try await until { !deliveries(of: "msg_04").isEmpty }
        #expect(deliveries(of: "msg_04") == ["queue"])
        #expect(model.isQueuePaused)
        #expect(deliveries(of: "msg_02").isEmpty, "not run into the same error")
    }

    /// A machine's box updated while the session was open: once the Mac connects again, the box
    /// carries the queue, and a Stop goes to it.
    @Test func aBoxUpdatedSinceCarriesTheQueueAfterTheMacReconnects() async throws {
        let (model, box, _) = try await open(running: true, inbox: [queued("msg_02", "Then update the docs")], older: true)
        defer { box.stop(); engine.stop() }
        model.stop()
        try await until { !engine.requests("POST", "/interrupt").isEmpty }
        let kept = BoxProcess.run.appending(path: "queues.json")
        #expect(!FileManager.default.fileExists(atPath: kept.path), "carried here: the box keeps nothing")

        let url = engine.url
        workspace.boxes = { $0 == BoxClient.mac ? box.client(engine: url) : nil }
        model.reconnect(engine.api)
        model.stop()
        try await until { (try? Data(contentsOf: kept)).flatMap { String(data: $0, encoding: .utf8) }?.contains(#""paused":true"#) == true }
    }

    /// A queued message removed by mistake: Undo puts it back in the queue, as it was, behind
    /// the run, rather than starting it.
    @Test func undoPutsARemovedMessageBackInTheQueue() async throws {
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

    /// Edit on a waiting message after Undo put a goal back: the goal loses its "/goal" as the
    /// message goes ahead of it, so no "/goal" is left in the middle to go as plain words.
    @Test func editingAMessageBackAfterAnUndoneGoalLeavesNoGoalInTheMiddle() async throws {
        let queued: [String: Any] = ["id": "msg_04", "sessionID": id, "type": "user", "delivery": "queue", "payload": ["text": "Then run the linter"]]
        let (model, box, _) = try await open(running: true, inbox: [queued])
        defer { box.stop(); engine.stop() }
        let goal: [String: Any] = ["id": "msg_03", "type": "user", "time": ["created": 3], "text": KeptParts.text("Ship v2"), "metadata": KeptParts.json(words: "Ship v2", keyword: "/goal")]
        engine.on("POST", "/api/experimental/session/\(id)/wait", json: [:])
        engine.on("POST", "/api/session/\(id)/revert/stage") { request in
            StubWeb.json(["data": ["messageID": request.body["messageID"] as? String ?? ""]])
        }
        guard case .user(let undone) = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: goal)) else { return }
        model.undo(from: undone)
        try await until { model.draftText == "/goal Ship v2" }
        model.edit(try #require(model.waiting.first { $0.id == "msg_04" }))
        try await until { !engine.requests("DELETE", "/inbox/msg_04").isEmpty }
        model.apply(try engine.event("session.inbox.cancelled", session: id, ["inboxID": "msg_04"]))
        try await until { model.draftText != "/goal Ship v2" }
        #expect(model.draftText == "Then run the linter\n\nShip v2")
        model.draftText = ""
    }

    /// Edit on a waiting goal, then on another waiting message: the goal Edit put back loses its
    /// "/goal" as the other goes ahead of it.
    @Test func editingTwoWaitingMessagesBackLeavesNoGoalInTheMiddle() async throws {
        let goal: [String: Any] = ["id": "msg_04", "sessionID": id, "type": "user", "delivery": "queue", "payload": ["text": KeptParts.text("Ship v2"), "metadata": KeptParts.json(words: "Ship v2", keyword: "/goal")]]
        let lint: [String: Any] = ["id": "msg_05", "sessionID": id, "type": "user", "delivery": "queue", "payload": ["text": "Then run the linter"]]
        let (model, box, _) = try await open(running: true, inbox: [goal, lint])
        defer { box.stop(); engine.stop() }
        for (message, composer) in [("msg_04", "/goal Ship v2"), ("msg_05", "Then run the linter\n\nShip v2")] {
            model.edit(try #require(model.waiting.first { $0.id == message }))
            try await until { !engine.requests("DELETE", "/inbox/\(message)").isEmpty }
            model.apply(try engine.event("session.inbox.cancelled", session: id, ["inboxID": message]))
            try await until { model.draftText.hasPrefix(message == "msg_04" ? "/goal" : "Then") }
            #expect(model.draftText == composer)
        }
        model.draftText = ""
    }

    /// A goal put back stays one until the composer is sent, whatever else comes and goes: Redo
    /// bringing it back, or the undo made final elsewhere, still leaves no "/goal" in the middle
    /// when a waiting message is edited back ahead of it.
    @Test func aGoalPutBackStaysOneUntilItsSent() async throws {
        let goal: [String: Any] = ["id": "msg_04", "sessionID": id, "type": "user", "delivery": "queue", "payload": ["text": KeptParts.text("Ship v2"), "metadata": KeptParts.json(words: "Ship v2", keyword: "/goal")]]
        let lint: [String: Any] = ["id": "msg_05", "sessionID": id, "type": "user", "delivery": "queue", "payload": ["text": "Then run the linter"]]
        let docs: [String: Any] = ["id": "msg_06", "sessionID": id, "type": "user", "delivery": "queue", "payload": ["text": "Then the docs"]]
        let (model, box, _) = try await open(running: true, inbox: [goal, lint, docs])
        defer { box.stop(); engine.stop() }
        engine.on("POST", "/api/experimental/session/\(id)/wait", json: [:])
        engine.on("POST", "/api/session/\(id)/revert/stage") { request in
            StubWeb.json(["data": ["messageID": request.body["messageID"] as? String ?? ""]])
        }
        engine.on("DELETE", "/api/session/\(id)/revert", json: [:])
        func editBack(_ message: String) async throws {
            let before = model.draftText
            model.edit(try #require(model.waiting.first { $0.id == message }))
            try await until { !engine.requests("DELETE", "/inbox/\(message)").isEmpty }
            model.apply(try engine.event("session.inbox.cancelled", session: id, ["inboxID": message]))
            try await until { model.draftText != before }
        }
        guard case .user(let fixBuild) = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: first)) else { return }

        // Edit puts the goal back; an undo goes ahead of it, and Redo brings the goal back as it was.
        try await editBack("msg_04")
        model.undo(from: fixBuild)
        try await until { model.draftText == "Fix the build\n\nShip v2" }
        model.redo()
        try await until { model.session.revert == nil }
        #expect(model.draftText == "/goal Ship v2")
        try await editBack("msg_05")
        #expect(model.draftText == "Then run the linter\n\nShip v2")

        // An undone goal, the undo made final (by another client, a starter, a command) with the
        // goal still in the composer.
        model.draftText = ""
        let goalSent: [String: Any] = ["id": "msg_03", "type": "user", "time": ["created": 3], "text": KeptParts.text("Ship v2"), "metadata": KeptParts.json(words: "Ship v2", keyword: "/goal")]
        guard case .user(let undoneGoal) = try JSONDecoder().decode(Message.self, from: JSONSerialization.data(withJSONObject: goalSent)) else { return }
        model.undo(from: undoneGoal)
        try await until { model.draftText == "/goal Ship v2" }
        model.apply(try engine.event("session.revert.committed", session: id, ["to": "msg_03"]))
        try await editBack("msg_06")
        #expect(model.draftText == "Then the docs\n\nShip v2")
        model.draftText = ""
    }

    /// A queued message that carries its file in itself (one queued from the phone, or for a
    /// machine, read again after a relaunch): its bubble shows the file, and Edit and Undo bring
    /// it back with the file, rather than the words alone.
    @Test func aMessageCarryingItsFileKeepsItThroughEditAndUndo() async throws {
        let notes = "Weekly numbers: 12, 15, 9\n"
        func carrying(_ message: String, _ text: String) -> [String: Any] {
            ["id": message, "sessionID": id, "type": "user", "delivery": "queue",
             "payload": ["text": text, "files": [["uri": "data:text/plain;base64,\(Data(notes.utf8).base64EncodedString())", "name": "numbers.csv", "mime": "text/plain"]]]]
        }
        let (model, box, _) = try await open(running: true, inbox: [carrying("msg_02", "Sum these up"), carrying("msg_03", "Then chart them")])
        defer { box.stop(); engine.stop() }
        let removed = try #require(model.waiting.first { $0.id == "msg_02" })
        #expect(removed.inlineFiles.count == 1)

        // Undo after Remove: it goes back with its file.
        model.cancelPending(removed)
        try await until { !engine.requests("DELETE", "/inbox/msg_02").isEmpty }
        model.apply(try engine.event("session.inbox.cancelled", session: id, ["inboxID": "msg_02"]))
        model.requeue(removed, for: nil, paused: false)
        try await until { !engine.requests("POST", "/prompt").isEmpty }
        let back = try #require(engine.requests("POST", "/prompt").first)
        let sent = (back.body["files"] as? [[String: Any]] ?? []).compactMap { ($0["uri"] as? String).flatMap(URL.init(string:)) }
        #expect(sent.count == 1, "\(back.body)")
        #expect(sent.first.flatMap { try? String(contentsOf: $0, encoding: .utf8) } == notes)
        #expect(sent.first?.pathExtension == "csv", "as its own kind, not as the text/plain it went to the machine as")

        // Edit: the composer has it, file and all.
        model.edit(try #require(model.waiting.first { $0.id == "msg_03" }))
        try await until { !engine.requests("DELETE", "/inbox/msg_03").isEmpty }
        model.apply(try engine.event("session.inbox.cancelled", session: id, ["inboxID": "msg_03"]))
        try await until { !model.draftText.isEmpty }
        #expect(model.draftText == "Then chart them")
        #expect(model.draftFiles.count == 1)
        #expect(model.draftFiles.first.flatMap { try? String(contentsOf: $0, encoding: .utf8) } == notes)
        #expect(model.draftFiles.first?.pathExtension == "csv")
        model.draftText = ""
        model.draftFiles = []
    }
}
