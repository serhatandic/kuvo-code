import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The keywords besides /goal, typed in a conversation's composer and run by its computer's box
/// (the agents bridge the app ships, run for real): a side question answered without a word added
/// to the conversation, a review with fresh eyes whose findings go to the agent only when you ask,
/// a handoff that carries the work on in a new conversation, /plan, and a /loop that can't be read.
/// Only the engine is a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct KeywordTests {
    let engine = StubEngine(port: 47960)
    let folder = AppInfo.testRoot.appending(path: "Keywords-\(UUID().uuidString.prefix(6))")
    let id = "ses_words"

    /// The engine's side: the conversation, in `directory`, on a paid model; its model's answers,
    /// in turn, to what it's asked outside the conversation.
    private func serve(directory: String, answers: [String]) {
        let answers = Answers(answers)
        engine.on("GET", "/api/session/\(id)", json: ["data": StubEngine.session(id, title: "Pause on blur", directory: directory, extra: ["model": ["id": "m", "providerID": "p"]])])
        engine.on("GET", "/api/session/\(id)/message", json: ["data": [["id": "msg_0001", "type": "user", "text": "Make the timer pause on blur.", "time": ["created": 1]]]])
        engine.on("POST", "/api/experimental/generate") { _ in StubWeb.json(["data": ["text": answers.next()]]) }
        engine.on("POST", "/api/session/\(id)/generate") { _ in StubWeb.json(["data": ["text": answers.next()]]) }
        engine.on("GET", "/api/session/active", json: ["data": [:]])
        engine.on("GET", "/api/event") { _ in StubWeb.Answer(status: 200, body: Data()) }
        engine.on("GET", "/api/provider", json: ["data": []])
        engine.on("GET", "/api/integration", json: ["data": []])
    }

    nonisolated final class Answers: @unchecked Sendable {
        private let lock = NSLock()
        private var left: [String]
        init(_ answers: [String]) { left = answers }
        func next() -> String { lock.withLock { left.isEmpty ? "" : left.removeFirst() } }
    }

    private func session(directory: String = "/tmp") throws -> SessionModel {
        let session = try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: StubEngine.session(id, directory: directory)))
        return SessionModel(session: session, api: engine.api)
    }

    /// The bridge up, and the conversation's keywords offered once it has said it runs them.
    private func start(_ model: SessionModel) async throws -> RealBridge {
        let bridge = try await RealBridge.start(engine: engine, folder: folder)
        model.goalBridge = { bridge.agents }
        try await until { bridge.agents.runsKeywords == true }
        return bridge
    }

    private func clean() {
        engine.stop()
        try? FileManager.default.removeItem(at: folder)
    }

    /// What the conversation's agent was told: notes and messages.
    private var told: Int {
        engine.requests("POST", "/api/session/\(id)/synthetic").count + engine.requests("POST", "/api/session/\(id)/prompt").count
    }

    @Test func aSideQuestionIsAnsweredOverTheComposerAndNothingJoinsTheConversation() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: ["It pauses in `onBlur`, in src/timer.ts."])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }
        #expect(model.keywords.contains(.btw))

        model.draftText = "/btw where does it pause?"
        model.submitDraft(for: nil, queue: false, commands: [])
        #expect(model.draftText.isEmpty)
        try await until { model.sideQuestions.first?.state == .answered }
        let question = try #require(model.sideQuestions.first)
        #expect(question.question == "where does it pause?")
        #expect(question.answer == "It pauses in `onBlur`, in src/timer.ts.")
        #expect(model.shownSideQuestion == question.id)
        #expect(told == 0)
        // Counted for the sidebar, and still there after the app reads them again.
        #expect(bridge.agents.sideQuestionCounts[id] == 1)
        await bridge.agents.loadSideQuestions(of: id)
        #expect(model.sideQuestions.map(\.id) == [question.id])

        // Asked from another client (the phone) in a conversation whose list isn't read here:
        // counted, not mistaken for its whole list.
        engine.on("GET", "/api/session/ses_other", json: ["data": StubEngine.session("ses_other", directory: "/tmp", extra: ["model": ["id": "m", "providerID": "p"]])])
        engine.on("GET", "/api/session/ses_other/message", json: ["data": []])
        engine.on("POST", "/api/session/ses_other/generate", json: ["data": ["text": "Elsewhere."]])
        try await bridge.api?.askSideQuestion("And here?", about: "ses_other")
        try await bridge.api?.askSideQuestion("And again?", about: "ses_other")
        try await until { bridge.agents.sideQuestionCounts["ses_other"] == 2 }

        // "/btw" alone leaves what to type.
        model.draftText = "/btw"
        model.submitDraft(for: nil, queue: false, commands: [])
        #expect(model.draftText == "/btw ")
        #expect(model.failure == nil)
    }

    @Test func aReviewListsWhatItFoundAndTheAgentHearsOfItOnlyWhenAsked() async throws {
        defer { clean() }
        let repository = try TestRepository()
        try repository.write("src/timer.ts", "export const tick = 1000\n")
        try repository.git("add", "-A")
        try repository.git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "a")
        try repository.write("src/timer.ts", "export const tick = 1000\nsetInterval(tick)\n")
        serve(directory: repository.path, answers: [#"{"summary": "One real problem.", "findings": [{"title": "The interval is never cleared", "explanation": "Clear it when the timer stops.", "severity": "bug", "locations": [{"file": "src/timer.ts", "line": 2}, {"file": "src/stop.ts"}]}]}"#])
        engine.on("POST", "/api/session/\(id)/prompt", json: ["data": [:]])
        let model = try session(directory: repository.path)
        let bridge = try await start(model)
        defer { bridge.stop() }

        model.draftText = "/review"
        model.submitDraft(for: nil, queue: false, commands: [])
        try await until { model.review?.state == .done }
        let review = try #require(model.review)
        #expect(review.summary == "One real problem.")
        #expect(review.findings.map(\.title) == ["The interval is never cleared"])
        #expect(review.findings.first?.locations.map(\.text) == ["src/timer.ts:2", "src/stop.ts"])
        #expect(told == 0)

        // Ask the Agent to Fix: the findings go as your message, and the review is put away.
        model.fixReview()
        try await until { !engine.requests("POST", "/api/session/\(id)/prompt").isEmpty }
        let sent = try #require(engine.requests("POST", "/api/session/\(id)/prompt").first)
        #expect(String(describing: sent.body).contains("The interval is never cleared (src/timer.ts:2, src/stop.ts). Clear it when the timer stops."))
        try await until { model.review == nil }
        #expect(try await bridge.api?.reviews().isEmpty == true)
    }

    @Test func theEnginesOwnReviewStaysReachableAsReviewQuick() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: [])
        engine.on("POST", "/api/session/\(id)/command", json: ["data": [:]])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }
        let engineCommands = try JSONDecoder().decode([Command].self, from: Data(#"[{"name": "review", "description": "Review changes"}]"#.utf8))
        let offered = Keyword.commands(engineCommands, keywords: model.keywords)
        #expect(offered.map(\.name) == [Keyword.quickReview])

        model.draftText = "/review-quick main"
        model.submitDraft(for: nil, queue: false, commands: offered)
        try await until { !engine.requests("POST", "/api/session/\(id)/command").isEmpty }
        let ran = try #require(engine.requests("POST", "/api/session/\(id)/command").first)
        #expect(ran.body["name"] as? String == "review")
        #expect(ran.body["text"] as? String == "main")
        #expect(model.review == nil)
    }

    @Test func aHandoffCarriesTheWorkOnInANewConversation() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: ["## Handoff\nIt pauses on blur. Left: a test."])
        engine.on("POST", "/api/session", json: ["data": StubEngine.session("ses_next", title: "Pause on blur (continued)", directory: "/tmp")])
        engine.on("PATCH", "/api/session/\(id)", json: ["data": [:]])
        engine.on("PATCH", "/api/session/ses_next", json: ["data": [:]])
        engine.on("GET", "/api/session/ses_next", json: ["data": StubEngine.session("ses_next", directory: "/tmp")])
        engine.on("POST", "/api/session/ses_next/synthetic", json: ["data": [:]])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }
        // Opened where the window is, not only while this conversation is in view.
        var opened: [String] = []
        bridge.agents.onHandoff = { opened.append($0.to ?? "") }

        model.draftText = "/handoff write the test"
        model.submitDraft(for: nil, queue: false, commands: [])
        try await until { model.handoff?.state == .done && !opened.isEmpty }
        #expect(opened == ["ses_next"])
        #expect(model.handoff?.to == "ses_next")
        #expect(model.handoff?.title == "Pause on blur (continued)")
        let note = try #require(engine.requests("POST", "/api/session/ses_next/synthetic").first)
        #expect((note.body["text"] as? String)?.contains("What to do next: write the test") == true)
        #expect(told == 0)
    }

    @Test func planSwitchesToPlanThenSendsWhatFollows() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: [])
        engine.on("POST", "/api/session/\(id)/agent", json: ["data": [:]])
        engine.on("POST", "/api/session/\(id)/prompt", json: ["data": [:]])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }

        model.draftText = "/plan how to test the blur pause"
        model.submitDraft(for: nil, queue: false, commands: [])
        try await until { !engine.requests("POST", "/api/session/\(id)/prompt").isEmpty }
        #expect(model.session.agent == "plan")
        let asked = engine.asked.filter { $0.hasSuffix("/agent") || $0.hasSuffix("/prompt") }
        #expect(asked == ["POST /api/session/\(id)/agent", "POST /api/session/\(id)/prompt"], "Plan first, then the message")
        let sent = try #require(engine.requests("POST", "/api/session/\(id)/prompt").first)
        let text = try #require(sent.body["text"] as? String)
        #expect(text.hasPrefix("how to test the blur pause"))
        // Its bubble, read from what the agent got (on any client), draws the keyword as typed in
        // front of the words; taken back (Undo, a draft), it's the words alone.
        #expect(SentMessage.keyword(of: text) == "/plan")
        #expect(SentMessage.split(text).text == "how to test the blur pause")
    }

    @Test func aLoopWhoseHowOftenCantBeReadComesBackAndSaysSo() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: [])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }

        model.draftText = "/loop now and then check CI"
        model.submitDraft(for: nil, queue: false, commands: [])
        #expect(model.draftText == "/loop now and then check CI")
        #expect(model.failure?.hasPrefix("Can’t tell how often") == true)
        model.draftText = "/loop every morning at 9"
        model.submitDraft(for: nil, queue: false, commands: [])
        #expect(model.draftText == "/loop every morning at 9")
        #expect(model.failure?.hasPrefix("Write what to do each time") == true)
        #expect(told == 0)
    }
}
