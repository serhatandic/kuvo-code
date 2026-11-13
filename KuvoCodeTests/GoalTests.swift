import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// "/goal" in a conversation, as its computer's box reads it and runs it (its box and the agents
/// bridge the app ships, run for real): typed in the composer, the box gives the agent the goal and keeps it going turn
/// after turn until a check finds it met, and the conversation shows where it stands; Done puts it
/// away. Only the engine is a stand-in: each note to its agent takes a turn that runs a command,
/// and its model's checks answer in turn. Its live feed ends at once, as a dropped one does, so
/// the box goes by the conversation itself each time it hears from the engine again.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct GoalTests {
    let engine = StubEngine(port: 47993)
    let folder = AppInfo.testRoot.appending(path: "Goals-\(UUID().uuidString.prefix(6))")
    let id = "ses_goal"

    /// The conversation on the engine, and what its model says when the goal is checked.
    nonisolated final class Conversation: @unchecked Sendable {
        private let lock = NSLock()
        private var messages: [[String: Any]] = [["id": "msg_0000", "type": "idle", "time": ["created": 1], "outcome": "succeeded"]]
        private var verdicts: [String]
        private(set) var notes: [String] = []
        private var next = 1

        init(verdicts: [String]) { self.verdicts = verdicts }

        /// A note to the agent: it takes a turn, runs the tests, says what they printed.
        func noted(_ text: String, description: String) {
            lock.withLock {
                notes.append(text)
                let now = Date().timeIntervalSince1970 * 1000
                func id() -> String { defer { next += 1 }; return String(format: "msg_%04d", next) }
                messages += [
                    ["id": id(), "type": "synthetic", "time": ["created": now], "text": text, "description": description],
                    ["id": id(), "type": "assistant", "agent": "build", "time": ["created": now, "completed": now], "model": ["id": "m", "providerID": "p"],
                     "content": [["type": "tool", "name": "bash", "state": ["status": "completed", "input": ["command": "npm test"], "content": [["type": "text", "text": "ok"]]]],
                                 ["type": "text", "text": "Ran the tests."]]],
                    ["id": id(), "type": "idle", "time": ["created": now], "outcome": "succeeded"],
                ]
            }
            TestPulse.beat()
        }

        func check() -> String {
            lock.withLock { verdicts.isEmpty ? #"{"verdict": "met", "reason": "npm test passed."}"# : verdicts.removeFirst() }
        }

        /// Newest first, as the engine pages them.
        var paged: [[String: Any]] { lock.withLock { messages.reversed() } }
        var told: [String] { lock.withLock { notes } }
    }

    private func serve(_ conversation: Conversation) {
        engine.on("GET", "/api/session/\(id)/message") { _ in StubWeb.json(["data": conversation.paged]) }
        engine.on("POST", "/api/session/\(id)/synthetic") { request in
            conversation.noted(request.body["text"] as? String ?? "", description: request.body["description"] as? String ?? "")
            return StubWeb.json(["data": [:]])
        }
        // The check, afresh on the session's model (a paid one answers it so), and in the session if not.
        engine.on("POST", "/api/experimental/generate") { _ in StubWeb.json(["data": ["text": conversation.check()]]) }
        engine.on("POST", "/api/session/\(id)/generate") { _ in StubWeb.json(["data": ["text": conversation.check()]]) }
        engine.on("GET", "/api/session/\(id)", json: ["data": StubEngine.session(id, directory: "/tmp", extra: ["model": ["id": "m", "providerID": "p"]])])
        // The feed ends as soon as it opens: each time it's opened again, the box looks.
        engine.on("GET", "/api/event") { _ in StubWeb.Answer(status: 200, body: Data()) }
        engine.on("GET", "/api/provider", json: ["data": []])
        engine.on("GET", "/api/integration", json: ["data": []])
    }

    private func session() throws -> SessionModel {
        let session = try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: StubEngine.session(id, directory: "/tmp")))
        return SessionModel(session: session, api: engine.api)
    }

    private func clean() {
        engine.stop()
        try? FileManager.default.removeItem(at: folder)
    }

    @Test func aGoalTypedInTheComposerKeepsTheAgentGoingUntilItsMet() async throws {
        defer { clean() }
        let conversation = Conversation(verdicts: [#"{"verdict": "not_met", "reason": "2 tests in test/auth still fail."}"#])
        serve(conversation)
        let bridge = try await RealBridge.start(engine: engine, folder: folder)
        defer { bridge.stop() }
        let model = try session()
        model.goalBridge = { bridge.agents }
        let box = try await ConversationBox(engine: engine, bridge: bridge)
        defer { box.stop() }
        await box.serves(model)
        #expect(model.takesGoals)

        model.draftText = "/goal all tests in test/auth pass"
        model.submitDraft(for: nil, queue: false)
        #expect(model.draftText.isEmpty)
        try await until { model.goal?.state == .met }

        // The agent was given the goal, then told what was left after its first turn.
        #expect(conversation.told.count == 2)
        #expect(conversation.told.first?.hasPrefix(Goal.marker + "all tests in test/auth pass") == true)
        #expect(conversation.told.last?.hasPrefix(Goal.marker + "Not met yet.") == true)
        #expect(conversation.told.last?.contains("2 tests in test/auth still fail.") == true)
        let goal = try #require(model.goal)
        #expect(goal.condition == "all tests in test/auth pass")
        #expect(goal.turns == 2)
        #expect(goal.last?.reason == "npm test passed.")
        #expect(model.failure == nil)

        // Done puts it away, on the box too.
        model.changeGoal(.clear)
        try await until { model.goal == nil }
        #expect(try await bridge.api?.goals().isEmpty == true)
    }

    @Test func theBarsButtonsPauseResumeAndPutItAwayAtOnce() async throws {
        defer { clean() }
        serve(Conversation(verdicts: [#"{"verdict": "not_met", "reason": "Tests still fail."}"#]))
        let bridge = try await RealBridge.start(engine: engine, folder: folder)
        defer { bridge.stop() }
        let model = try session()
        model.goalBridge = { bridge.agents }
        let box = try await ConversationBox(engine: engine, bridge: bridge)
        defer { box.stop() }
        await box.serves(model)
        model.draftText = "/goal the build is green"
        model.submitDraft(for: nil, queue: false)
        try await until { model.goal != nil && !model.isChangingGoal }

        // Pause shows at once, as the box answered.
        model.changeGoal(.pause)
        try await until { !model.isChangingGoal }
        #expect(model.goal?.state == .paused)
        #expect(model.goal?.pausedBy == .you)
        model.changeGoal(.resume)
        try await until { !model.isChangingGoal }
        #expect(model.failure == nil)
        try await until { model.goal?.state == .met }

        // Done clicked twice: put away once, and nothing goes wrong.
        model.changeGoal(.clear)
        model.changeGoal(.clear)
        try await until { model.goal == nil && !model.isChangingGoal }
        #expect(model.failure == nil)
    }

    @Test func theBarsButtonsSayWhyWhileItsComputersBridgeIsntRunning() throws {
        defer { clean() }
        // A goal as last heard, its bridge gone since (restarting, say).
        let agents = OutsideAgents()
        agents.took(try JSONDecoder().decode(Goal.self, from: Data(#"{"session":"ses_goal","condition":"The build is green","state":"working","started":1,"turns":1,"checking":false}"#.utf8)))
        let model = try session()
        model.goalBridge = { agents }

        model.changeGoal(.pause)
        #expect(model.failure?.contains("isn’t running now") == true)
        model.failure = nil
        model.stopGoal()
        #expect(model.failure?.contains("isn’t running now") == true)
        #expect(model.goal?.state == .working)
    }

    @Test func slashGoalAloneLeavesWhatToTypeAndAGoalThatCantBeSetComesBack() async throws {
        defer { clean() }
        serve(Conversation(verdicts: []))
        let bridge = try await RealBridge.start(engine: engine, folder: folder)
        defer { bridge.stop() }
        let model = try session()
        model.goalBridge = { bridge.agents }
        let box = try await ConversationBox(engine: engine, bridge: bridge)
        defer { box.stop() }
        await box.serves(model)

        // No goal yet: "/goal" alone is ready to be finished.
        model.draftText = "/goal"
        model.submitDraft(for: nil, queue: false)
        await model.messagesSent()
        #expect(model.draftText == "/goal ")

        // A conversation its engine doesn't have: what you wrote comes back, with why.
        let elsewhere = try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: StubEngine.session("ses_elsewhere", directory: "/tmp")))
        let other = SessionModel(session: elsewhere, api: engine.api)
        other.goalBridge = { bridge.agents }
        await box.serves(other)
        other.draftText = "/goal the build is green"
        other.submitDraft(for: nil, queue: false)
        try await until { other.failure != nil }
        #expect(other.draftText == "/goal the build is green")
        #expect(other.failure == "There's no such conversation here.")
        #expect(other.goal == nil)
    }

    /// A goal that can't be set comes back, and words you typed while it was being set stay
    /// yours: its words go in front of them without "/goal", which would make them part of the
    /// goal (as Undo and Edit put a goal back beside your words).
    @Test func aGoalThatCantBeSetComesBackBesideWhatYouTypedMeanwhileWithoutTakingItIn() async throws {
        defer { clean() }
        serve(Conversation(verdicts: []))
        let bridge = try await RealBridge.start(engine: engine, folder: folder)
        defer { bridge.stop() }
        let elsewhere = try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: StubEngine.session("ses_elsewhere", directory: "/tmp")))
        let model = SessionModel(session: elsewhere, api: engine.api)
        model.goalBridge = { bridge.agents }
        let box = try await ConversationBox(engine: engine, bridge: bridge)
        defer { box.stop() }
        await box.serves(model)
        model.draftText = "/goal the build is green"
        model.submitDraft(for: nil, queue: false)
        // Typed while the box is asked.
        model.draftText = "also update the docs"
        try await until { model.failure != nil }
        #expect(model.draftText == "the build is green\n\nalso update the docs")
        #expect(model.failure == "There's no such conversation here.")
    }

    /// "/goal pause" that can't be done comes back as written into an empty composer; beside words
    /// you typed meanwhile it isn't put back as "pause" (a word of yours to send), and the failure
    /// says what didn't happen.
    @Test func aGoalPauseThatCantBeDoneIsntPutBackAsAWord() async throws {
        defer { clean() }
        serve(Conversation(verdicts: []))
        let bridge = try await RealBridge.start(engine: engine, folder: folder)
        defer { bridge.stop() }
        let elsewhere = try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: StubEngine.session("ses_elsewhere", directory: "/tmp")))
        let model = SessionModel(session: elsewhere, api: engine.api)
        model.goalBridge = { bridge.agents }
        let box = try await ConversationBox(engine: engine, bridge: bridge)
        defer { box.stop() }
        await box.serves(model)
        model.draftText = "/goal pause"
        model.submitDraft(for: nil, queue: false)
        model.draftText = "also update the docs"
        try await until { model.failure != nil }
        #expect(model.draftText == "also update the docs", "\(model.draftText)")

        model.failure = nil
        model.draftText = "/goal pause"
        model.submitDraft(for: nil, queue: false)
        try await until { model.failure != nil }
        #expect(model.draftText == "/goal pause")
    }

    /// A goal put back in the composer stays one when a "/goal pause" that can't be done comes
    /// back beside it: the pause puts nothing there, so nothing goes ahead of the goal to make it
    /// plain words.
    @Test func aGoalPauseThatCantBeDoneLeavesAGoalPutBackAGoal() async throws {
        defer { clean() }
        serve(Conversation(verdicts: []))
        let bridge = try await RealBridge.start(engine: engine, folder: folder)
        defer { bridge.stop() }
        let elsewhere = try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: StubEngine.session("ses_elsewhere", directory: "/tmp")))
        let model = SessionModel(session: elsewhere, api: engine.api)
        model.goalBridge = { bridge.agents }
        let box = try await ConversationBox(engine: engine, bridge: bridge)
        defer { box.stop() }
        await box.serves(model)
        // A goal that can't be set comes back as one.
        model.draftText = "/goal ship v2"
        model.submitDraft(for: nil, queue: false)
        await model.messagesSent()
        #expect(model.draftText == "/goal ship v2")
        // Then a pause sent meanwhile (not from the composer, as a goal bar's could be) comes back
        // too: the pause couldn't be done.
        model.failure = nil
        model.submit("/goal pause", files: [], for: nil, queue: false)
        await model.messagesSent()
        #expect(model.failure != nil)
        #expect(model.draftText == "/goal ship v2", "\(model.draftText), \(model.failure ?? "")")
    }
}