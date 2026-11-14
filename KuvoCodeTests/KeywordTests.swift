import ClientDesign
import ClientSessions
import ClientText
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The keywords besides /goal, typed in a conversation's composer and run by its computer's box
/// (the agents bridge the app ships, run for real): a side question answered without a word added
/// to the conversation, a review with fresh eyes whose findings go to the agent only when you ask,
/// a handoff that carries the work on in a new conversation, /plan, and a /loop that can't be read.
/// What each means is its box's to say (`ConversationBox`, the real one). Only the engine is a
/// stand-in.
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
        // A review's parts, each read in a session of its own: made, told its part, and answering
        // with the next answer; its end is read back as the box does after its feed came back.
        let parts = Parts()
        engine.on("POST", "/api/session") { _ in StubWeb.json(["data": ["id": parts.make()]]) }
        for part in Parts.ids {
            engine.on("POST", "/api/session/\(part)/prompt") { _ in
                parts.answer(part, answers.next())
                return StubWeb.json(["data": [:]])
            }
            engine.on("GET", "/api/session/\(part)/message") { _ in
                // Newest first, as the engine lists them: its answer, then its turn's end.
                var messages: [[String: Any]] = []
                if let text = parts.answer(of: part) {
                    messages = [["id": "msg_9", "type": "idle", "outcome": "succeeded"],
                                ["id": "msg_8", "type": "assistant", "content": [["type": "text", "text": text]]]]
                }
                return StubWeb.json(["data": messages])
            }
            engine.on("DELETE", "/api/session/\(part)", json: ["data": [:]])
        }
        engine.on("GET", "/api/session/active", json: ["data": [:]])
        engine.on("GET", "/api/event") { _ in StubWeb.Answer(status: 200, body: Data()) }
        engine.on("GET", "/api/provider", json: ["data": []])
        engine.on("GET", "/api/integration", json: ["data": []])
    }

    /// A review's parts' sessions, as the engine made them, and what each answered.
    nonisolated final class Parts: @unchecked Sendable {
        static let ids = (1...6).map { "ses_part\($0)" }
        private let lock = NSLock()
        private var made = 0
        private var answers: [String: String] = [:]
        func make() -> String { lock.withLock { made += 1; return Self.ids[min(made, Self.ids.count) - 1] } }
        func answer(_ part: String, _ text: String) { lock.withLock { answers[part] = text } }
        func answer(of part: String) -> String? { lock.withLock { answers[part] } }
    }

    nonisolated final class Answers: @unchecked Sendable {
        private let lock = NSLock()
        private var left: [String]
        private var last: String?
        init(_ answers: [String]) { left = answers }
        func next() -> String { lock.withLock { left.isEmpty ? "" : left.removeFirst() } }
        /// One value, kept (a mode the engine was switched to).
        func set(_ value: String) { lock.withLock { last = value } }
        var now: String? { lock.withLock { last } }
    }

    private func session(directory: String = "/tmp") throws -> SessionModel {
        let session = try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: StubEngine.session(id, directory: directory)))
        return SessionModel(session: session, api: engine.api)
    }

    /// The bridge up, and the conversation's keywords offered once it has said it runs them, as
    /// its box says them (the box beside it).
    private func start(_ model: SessionModel) async throws -> Started {
        let bridge = try await RealBridge.start(engine: engine, folder: folder)
        model.goalBridge = { bridge.agents }
        try await until { bridge.agents.runsKeywords == true }
        let box = try await ConversationBox(engine: engine, bridge: bridge)
        await box.serves(model)
        return Started(bridge: bridge, box: box)
    }

    /// The bridge and the box beside it, stopped together.
    @MainActor final class Started {
        let bridge: RealBridge
        let box: ConversationBox
        var agents: OutsideAgents { bridge.agents }
        var api: OpenCodeAPI? { bridge.api }

        init(bridge: RealBridge, box: ConversationBox) {
            self.bridge = bridge
            self.box = box
        }

        func stop() {
            box.stop()
            bridge.stop()
        }
    }

    /// `/compact` is on offer in a coding agent's conversation as in the engine's, goes to its box,
    /// and what can't be summarized says why in the conversation, where the box's words show.
    @Test func compactGoesToTheBoxAndSaysWhyWhenItCant() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: [])
        let session = try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: StubEngine.session(id, directory: "/tmp", extra: ["metadata": ["kuvoAgent": "cursor"]])))
        let model = SessionModel(session: session, api: engine.api)
        let box = try await ConversationBox(engine: engine)
        defer { box.stop() }
        await box.serves(model)
        #expect(OutsideAgents.isAgentSession(session))
        #expect(model.keywords.contains(.compact))

        let why = "Cursor can't summarize on request: it does so by itself when the conversation fills up."
        engine.on("POST", "/api/session/\(id)/compact", json: ["message": why], status: 400)
        model.draftText = "/compact"
        model.submitDraft(for: nil, queue: false)
        await model.messagesSent()
        #expect(model.draftText.isEmpty)
        try await until { model.failure != nil }
        #expect(engine.requests("POST", "/api/session/\(id)/compact").count == 1)
        #expect(told == 0, "it's no message to the agent")
        #expect(model.failure?.contains(why) == true, "\(model.failure ?? "")")
    }

    private func clean() {
        engine.stop()
        Drafts.shared.remove(id)
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
        model.submitDraft(for: nil, queue: false)

        await model.messagesSent()
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
        model.submitDraft(for: nil, queue: false)
        await model.messagesSent()
        #expect(model.draftText == "/btw ")
        #expect(model.failure == nil)
    }

    // A side thread: while it shows, folded too, what's sent from the composer is a follow-up,
    // answered with the thread so far, kept in it, and joining nothing to the conversation; the
    // next waits in the composer until it's answered; with its tag's ×, clicked as the follow-up
    // went, the composer messages the conversation again and stays so; another /btw is a new
    // thread; and a thread goes whole.
    @Test func aSideQuestionsFollowUpIsAnsweredWithItsThread() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: ["In `onBlur`.", "Because blur fires before the tab hides.", "A duration like 25m."])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }

        model.draftText = "/btw where does it pause?"
        model.submitDraft(for: nil, queue: false)
        try await until { model.sideQuestions.first?.state == .answered }
        model.hidesSideQuestion = true
        #expect(model.asksSideThread)
        model.draftText = "why there?"
        model.submitDraft(for: nil, queue: false)
        #expect(model.draftText.isEmpty)
        model.draftText = "and on close?"
        model.submitDraft(for: nil, queue: false)
        #expect(model.draftText == "and on close?")
        // The tag's ×, before the follow-up is in: it stays off once it is.
        model.composerAsksSide = false
        model.draftText = ""
        try await until { model.shownSideThread?.questions.count == 2 && model.shownSideThread?.latest.state == .answered }
        #expect(!model.asksSideThread)
        let thread = try #require(model.shownSideThread)
        #expect(thread.questions.map(\.question) == ["where does it pause?", "why there?"])
        #expect(thread.latest.answer == "Because blur fires before the tab hides.")
        let asked = engine.requests("POST", "/generate").map { "\($0.body)" }
        #expect(asked.last?.contains("In `onBlur`.") == true)
        #expect(told == 0)

        // So the next message is the conversation's.
        engine.on("POST", "/api/session/\(id)/prompt", json: ["data": [:]])
        model.draftText = "Pause it on blur then."
        model.submitDraft(for: nil, queue: false)
        try await until { told == 1 }
        #expect(model.shownSideThread?.questions.count == 2)

        model.draftText = "/btw what does parseDuration match?"
        model.submitDraft(for: nil, queue: false)
        // (The new thread, by its question: the first is answered already, and shows until it does.)
        try await until { model.shownSideThread?.latest.question == "what does parseDuration match?" && model.shownSideThread?.latest.state == .answered }
        #expect(model.sideThreads.count == 2)
        #expect(model.shownSideThread?.questions.count == 1)

        model.removeSideThread(thread)
        try await until { model.sideThreads.count == 1 }
        #expect(try await bridge.api?.sideQuestions(of: id).map(\.question) == ["what does parseDuration match?"])
    }

    // Something attached while the side thread's tag shows, alone or with words: a side question
    // takes none, so Send says what to do instead, and the words and the file stay, sent nowhere.
    @Test func aFileForASideQuestionSaysWhy() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: ["In `onBlur`."])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }

        model.draftText = "/btw where does it pause?"
        model.submitDraft(for: nil, queue: false)
        try await until { model.sideQuestions.first?.state == .answered }
        #expect(model.asksSideThread)
        let file = URL(fileURLWithPath: "/tmp/screenshot.png")
        model.draftFiles = [file]
        model.submitDraft(for: nil, queue: false)
        let why = "A side question can’t include pictures or files. Remove them, or close Side question to send it all to the agent."
        #expect(model.failure == why)
        model.failure = nil
        model.draftText = "[Image 1] what's this?"
        model.submitDraft(for: nil, queue: false)
        #expect(model.failure == why)
        #expect(model.draftText == "[Image 1] what's this?")
        #expect(model.draftFiles == [file])
        #expect(model.shownSideThread?.questions.count == 1)
        #expect(told == 0)

        // Done as it says: the file removed, or the tag closed, and it's said no more.
        model.draftFiles = []
        #expect(model.failure == nil)
        model.draftFiles = [file]
        model.submitDraft(for: nil, queue: false)
        #expect(model.failure == why)
        model.composerAsksSide = false
        #expect(model.failure == nil)
    }

    /// A conversation's side questions from its row's menu in the sidebar: Open the Latest shows
    /// the latest one's answer over its composer, though they were asked from the phone and the
    /// conversation wasn't open; one picked shows instead, even after the bar was put away.
    @Test func aConversationsSideQuestionsOpenFromItsRowsMenu() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: ["In `onBlur`.", "Every 25 minutes."])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }
        let first = try #require(try await bridge.api?.askSideQuestion("Where does it pause?", about: id))
        let latest = try #require(try await bridge.api?.askSideQuestion("How often does it ring?", about: id))
        try await until { bridge.agents.sideQuestionCounts[id] == 2 }
        #expect(model.shownSideQuestion == nil)

        await model.showSideQuestion(nil)
        #expect(model.shownSideQuestion == latest.id)
        #expect(model.sideQuestions.map(\.question) == ["Where does it pause?", "How often does it ring?"])

        model.shownSideQuestion = nil
        model.hidesSideQuestion = true
        await model.showSideQuestion(first.id)
        #expect(model.shownSideQuestion == first.id)
        #expect(!model.hidesSideQuestion)
    }

    /// The sidebar's count of a conversation's side questions: there when Kuvo Code opens again,
    /// for ones asked before, and down as they're removed on another client (the phone).
    @Test func aConversationsSideQuestionCountIsThereAtLaunchAndFollowsRemovals() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: ["One.", "Two.", "Three."])
        let model = try session()
        let first = try await start(model)
        var asked: [SideQuestion] = []
        for question in ["Where?", "When?", "Why?"] { asked.append(try #require(try await first.api?.askSideQuestion(question, about: id))) }
        await first.agents.loadSideQuestions(of: id)
        try await until { first.agents.sideQuestions[id]?.count == 3 && first.agents.sideQuestions[id]?.allSatisfy { $0.state == .answered } == true }
        first.stop()

        // Opened again: counted from what the box kept.
        let again = try await start(model)
        defer { again.stop() }
        try await until { again.agents.sideQuestionCounts[id] == 3 }

        try await again.api?.removeSideQuestion(asked[0].id, of: id)
        try await until { again.agents.sideQuestionCounts[id] == 2 }
        #expect(model.sideQuestions.map(\.question) == ["When?", "Why?"])
        try await again.api?.removeSideQuestion(nil, of: id)
        try await until { again.agents.sideQuestionCounts[id] == nil }
        #expect(model.sideQuestions.isEmpty)
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
        model.submitDraft(for: nil, queue: false)
        try await until { model.review?.state == .done }
        let review = try #require(model.review)
        #expect(review.summary == "One real problem.")
        #expect(review.findings.map(\.title) == ["The interval is never cleared"])
        #expect(review.findings.first?.locations.map(\.text) == ["src/timer.ts:2", "src/stop.ts"])
        #expect(told == 0)

        // Ask the Agent to Fix: the findings go as your message, and the review is put away. The
        // review comments you're writing in Changes stay for your own next message.
        model.reviewComments = [ReviewComment(file: "src/timer.ts", line: 2, side: .new, snippet: "setInterval(tick)", text: "Name the interval")]
        model.fixReview()
        try await until { !engine.requests("POST", "/api/session/\(id)/prompt").isEmpty }
        let sent = try #require(engine.requests("POST", "/api/session/\(id)/prompt").first)
        #expect(String(describing: sent.body).contains("The interval is never cleared (src/timer.ts:2, src/stop.ts). Clear it when the timer stops."))
        #expect(!String(describing: sent.body).contains("Name the interval"))
        #expect(model.reviewComments.map(\.text) == ["Name the interval"])
        try await until { model.review == nil }
        await model.dismissingReview?.value
        #expect(try await bridge.api?.reviews().isEmpty == true)
    }

    // "/review" and what to review in your own words (What to review › Something else…), sent as
    // written: the box finds the files they mean and reads those, and the review says which.
    @Test func aReviewOfWhatYouDescribeReadsTheFilesFoundForIt() async throws {
        defer { clean() }
        let repository = try TestRepository()
        try repository.write("src/timer.ts", "export const tick = 1000\n")
        try repository.write("src/billing.ts", "export const charge = 1\n")
        try repository.write("test/timer.test.ts", "expect(tick)\n")
        try repository.git("add", "-A")
        try repository.git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "a")
        serve(directory: repository.path, answers: [#"{"paths": ["src/timer.ts", "test/"]}"#, #"{"summary": "Fine.", "findings": []}"#])
        let model = try session(directory: repository.path)
        let bridge = try await start(model)
        defer { bridge.stop() }

        model.draftText = "/review the timer and its tests"
        model.submitDraft(for: nil, queue: false)
        try await until { model.review?.state == .done }
        let review = try #require(model.review)
        #expect(review.scope == .described("the timer and its tests", paths: ["src/timer.ts", "test/timer.test.ts"]))
        #expect(review.focus == nil)
        #expect(review.summary == "Fine.")
        #expect(ReviewList.footnote(review, readerName: nil) == "“the timer and its tests”")
    }

    @Test func aReviewPutAwayCanBeBroughtBackAndOneFindingCanBeFixedAlone() async throws {
        defer { clean() }
        let repository = try TestRepository()
        try repository.write("src/timer.ts", "export const tick = 1000\n")
        try repository.git("add", "-A")
        try repository.git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "a")
        try repository.write("src/timer.ts", "export const tick = 1000\nsetInterval(tick)\n")
        serve(directory: repository.path, answers: [#"{"summary": "Two.", "findings": [{"title": "The interval is never cleared", "explanation": "Clear it on stop.", "severity": "bug", "locations": [{"file": "src/timer.ts", "line": 2}]}, {"title": "No test covers stopping", "explanation": "", "severity": "risk", "locations": []}]}"#])
        let model = try session(directory: repository.path)
        let bridge = try await start(model)
        defer { bridge.stop() }
        model.draftText = "/review"
        model.submitDraft(for: nil, queue: false)
        try await until { model.review?.state == .done }
        let review = try #require(model.review)

        // One of them alone: only it, for the agent.
        let one = try #require(await model.reviewFixText([review.findings[1].id]))
        #expect(one.contains("No test covers stopping"))
        #expect(!one.contains("The interval is never cleared"))

        // ✕ puts it away at once, its line saying so; Undo brings it back, still on its computer.
        let item = PutAway.review(review.id)
        model.putAwayReview()
        #expect(model.shownReview == nil)
        #expect(model.putAways.text(item) == "Review put away")
        model.putAways.undo(item)
        #expect(model.shownReview?.id == review.id)
        #expect(try await bridge.api?.reviews().map(\.id) == [review.id])

        // Its moment over: gone from its computer too, and its line with it.
        model.putAwayReview()
        model.putAways.expire(item)
        try await until { model.review == nil }
        #expect(model.putAways.text(item) == nil)
        await model.dismissingReview?.value
        #expect(try await bridge.api?.reviews().isEmpty == true)
    }

    @Test func aReviewIsReadByTheModelNamedAfterWithLookingWhereYouSay() async throws {
        defer { clean() }
        let repository = try TestRepository()
        try repository.write("src/timer.ts", "export const tick = 1000\n")
        try repository.git("add", "-A")
        try repository.git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "a")
        try repository.write("src/timer.ts", "export const tick = 1000\nsetInterval(tick)\n")
        serve(directory: repository.path, answers: [#"{"summary": "Fine.", "findings": []}"#])
        // The engine's models, as the composer's "Who reads it" lists them.
        let location = ["directory": "/"]
        engine.on("GET", "/api/integration", json: ["location": location, "data": [["id": "deepseek", "name": "DeepSeek", "methods": [["type": "key"]],
                                                                                  "connections": [["type": "credential", "credentialID": "cred_deepseek", "method": "key"]]]]])
        engine.on("GET", "/api/model", json: ["location": location, "data": [[
            "id": "v4.1-flash", "modelID": "v4.1-flash", "providerID": "deepseek", "name": "DeepSeek V4.1 Flash",
            "capabilities": ["tools": true, "input": ["text"], "output": ["text"]], "variants": [], "time": ["released": 1],
            "cost": [["input": 1, "output": 1]], "status": "active", "enabled": true, "limit": ["context": 100_000, "output": 8_000]]]])
        engine.on("GET", "/api/model/default", json: ["location": location, "data": NSNull()])
        engine.on("GET", "/api/agent", json: ["location": location, "data": []])
        engine.on("GET", "/api/command", json: ["location": location, "data": []])
        engine.on("GET", "/api/provider", json: ["location": location, "data": [["id": "deepseek", "name": "DeepSeek"]]])
        let catalog = Catalog()
        catalog.api = engine.api
        // Its box, saying that model runs there (`kuvo/models/offered`), as "Who reads it" offers.
        let offered = #"{"models":[{"providerID":"deepseek","id":"v4.1-flash","name":"DeepSeek V4.1 Flash"}],"known":{"engine":true,"agents":true}}"#
        catalog.box = BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            AsyncThrowingStream { continuation in
                let answered = request.path.hasPrefix("kuvo/models/offered")
                continuation.yield(.head(status: answered ? 200 : 404, headers: ["content-type": "application/json"]))
                continuation.yield(.body(Data((answered ? offered : #"{"message":"No such route."}"#).utf8)))
                continuation.finish()
            }
        })
        await catalog.refresh()
        _ = catalog.offered
        try await until { catalog.offeredSaid != nil }
        #expect(catalog.reviewReaders.map(\.name) == ["DeepSeek V4.1 Flash"])
        let model = try session(directory: repository.path)
        model.reviewCatalog = { catalog }
        let bridge = try await start(model)
        defer { bridge.stop() }

        // A name half typed comes back, saying so; nothing is read.
        model.draftText = "/review with deep"
        model.submitDraft(for: nil, queue: false)
        await model.messagesSent()
        #expect(model.draftText == "/review with deep")
        #expect(model.failure == "Finish the model’s name, or pick it from the list.")
        #expect(model.review == nil)

        model.draftText = "/review with deepseek v4.1 flash the pause handling"
        model.submitDraft(for: nil, queue: false)
        try await until { model.review?.state == .done }
        #expect(model.review?.model == ModelRef(id: "v4.1-flash", providerID: "deepseek"))
        #expect(model.review?.focus == "the pause handling")
    }

    // "/review"'s lists, from the conversation's box: what it can read here with how much each
    // is, and the commits to start from; picked as the composer writes them, the review reads
    // those commits (the first too) and looks for security holes.
    @Test func aReviewReadsWhatYouPickLookingForWhatYouPick() async throws {
        defer { clean() }
        let repository = try TestRepository()
        try repository.write("src/login.ts", "check(password)\n")
        try repository.git("add", "-A")
        try repository.git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "Check the password")
        try repository.write("src/login.ts", "check(password)\nlog(password)\n")
        try repository.git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qam", "Log the sign-in")
        serve(directory: repository.path, answers: [#"{"summary": "The password is logged.", "findings": [{"title": "The password is written to the log", "explanation": "", "severity": "bug", "locations": [{"file": "src/login.ts", "line": 2}]}]}"#])
        let model = try session(directory: repository.path)
        let bridge = try await start(model)
        defer { bridge.stop() }

        var known = ReviewList.Known()
        await ReviewList.Known.load(session: id, api: try #require(bridge.agents.api)) { known = $0 }
        // On main, with nothing uncommitted: no branch of its own, and the changes say so.
        let what = try #require(ReviewList.make(.what(""), known: known))
        #expect(what.rows.map(\.title) == ["Changes not committed yet", "Commits…", "A folder…", "The whole project", "Something else…"])
        #expect(what.rows.map(\.note) == ["nothing to review", "pick where to start", "src", "1 file", "say what to review"])
        let commits = try #require(ReviewList.make(.commit(""), known: known))
        #expect(commits.rows.map(\.title) == ["Log the sign-in", "Check the password"])

        guard case .write(let since) = commits.rows[1].pick, case .start(let security)? = ReviewList.make(.lookFor(""), known: known)?.rows[1].pick else {
            Issue.record("The rows don't write what they pick.")
            return
        }
        model.draftText = "/review " + since + security
        model.submitDraft(for: nil, queue: false)
        try await until { model.review?.state == .done }
        let first = try repository.git("rev-parse", "--short", "HEAD~1").trimmingCharacters(in: .whitespacesAndNewlines)
        #expect(model.review?.scope == .commits(from: first + "^", to: nil))
        #expect(model.review?.focus == "security")
        #expect(model.review?.findings.map(\.title) == ["The password is written to the log"])
        // Its reviewer read both commits, from nothing before the first, and was told what to look for
        // (in its part's session).
        let asked = (engine.requests("POST", "/prompt").map { "\($0.body)" }).joined()
        #expect(asked.contains("+check(password)") && asked.contains("+log(password)"))
        #expect(asked.contains("security holes"))
    }

    /// The engine has a /goal of its own (since 2.2.1). The composer takes "/goal" itself wherever
    /// it's typed, so the engine's would be a row in "/" that can't run: it isn't offered, with goals
    /// on (a conversation's keywords) or off (a subagent's, or a project with none yet).
    @Test func theEnginesOwnGoalIsNeverOffered() throws {
        let engineCommands = try JSONDecoder().decode([Command].self, from: Data(#"[{"name": "init", "description": "Create AGENTS.md"}, {"name": "goal", "description": "Keep working until done"}]"#.utf8))
        #expect(Keyword.commands(engineCommands, keywords: []).map(\.name) == ["init"])
        #expect(Keyword.commands(engineCommands, keywords: Keyword.allCases).map(\.name) == ["init"])
    }

    @Test func theEnginesOwnReviewStaysReachableAsReviewQuick() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: [])
        engine.on("POST", "/api/session/\(id)/command", json: ["data": [:]])
        engine.on("GET", "/api/command", json: ["data": [["name": "review", "description": "Review changes"]]])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }
        let engineCommands = try JSONDecoder().decode([Command].self, from: Data(#"[{"name": "review", "description": "Review changes"}]"#.utf8))
        let offered = Keyword.commands(engineCommands, keywords: model.keywords)
        #expect(offered.map(\.name) == [Keyword.quickReview])

        model.draftText = "/review-quick main"
        model.submitDraft(for: nil, queue: false)
        try await until { !engine.requests("POST", "/api/session/\(id)/command").isEmpty }
        let ran = try #require(engine.requests("POST", "/api/session/\(id)/command").first)
        #expect(ran.body["name"] as? String == "review")
        #expect(ran.body["text"] as? String == "main")
        #expect(model.review == nil)
    }

    /// Picked from "/" (or typed) and sent with Return: the composer's Send hands over the
    /// engine's commands as it lists them, and /review-quick still runs the engine's review rather
    /// than going to the model as words.
    @Test func reviewQuickSentFromTheComposerRunsTheEnginesReview() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: [])
        engine.on("POST", "/api/session/\(id)/command", json: ["data": [:]])
        engine.on("POST", "/api/session/\(id)/prompt", json: ["data": [:]])
        engine.on("GET", "/api/command", json: ["data": [["name": "review", "description": "Review changes"]]])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }

        model.draftText = "/review-quick main"
        model.submitDraft(for: nil, queue: false)
        try await until { !engine.requests("POST", "/api/session/\(id)/command").isEmpty || !engine.requests("POST", "/api/session/\(id)/prompt").isEmpty }
        #expect(engine.requests("POST", "/api/session/\(id)/prompt").isEmpty, "not sent to the model as a message")
        let ran = try #require(engine.requests("POST", "/api/session/\(id)/command").first)
        #expect(ran.body["name"] as? String == "review")
        #expect(ran.body["text"] as? String == "main")
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
        model.submitDraft(for: nil, queue: false)
        try await until { model.handoff?.state == .done && !opened.isEmpty }
        #expect(opened == ["ses_next"])
        #expect(model.handoff?.to == "ses_next")
        #expect(model.handoff?.title == "Pause on blur (continued)")
        let note = try #require(engine.requests("POST", "/api/session/ses_next/synthetic").first)
        #expect((note.body["text"] as? String)?.contains("What to do next: write the test") == true)
        #expect(told == 0)
    }

    /// A handoff's end told before the box's answer to its start (it failed at once) stays, also for
    /// one asked again that fails the same way: they're told apart by when each was asked for, not
    /// by what they say.
    @Test func aHandoffsEndToldBeforeItsStartStaysOneAskedAgainToo() throws {
        let agents = OutsideAgents()
        let told = { (handoff: [String: Any]) throws in
            agents.keywordEvent(try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": "evt_\(UUID().uuidString)", "type": "kuvo.handoff", "data": ["sessionID": "ses_a", "handoff": handoff]])))
        }
        let answer = { (started: Double) in Handoff(from: "ses_a", state: .writing, started: started) }
        let failed: [String: Any] = ["from": "ses_a", "state": "failed", "error": "No room."]

        // The first: its end, then the answer to its start.
        try told(failed.merging(["started": 1_000.0]) { $1 })
        agents.startedHandoff(answer(1_000))
        #expect(agents.handoffs["ses_a"]?.state == .failed)
        // Asked again, failing the same way, in the same order.
        try told(failed.merging(["started": 2_000.0]) { $1 })
        agents.startedHandoff(answer(2_000))
        #expect(agents.handoffs["ses_a"]?.state == .failed)
        #expect(agents.handoffs["ses_a"]?.started == 2_000)
        // The answer first, as usual: writing, until its end is told.
        agents.startedHandoff(answer(3_000))
        #expect(agents.handoffs["ses_a"]?.state == .writing)
    }

    /// A handoff asked for again that fails the same way shows its own end, not "writing" for good:
    /// each is told apart by when it was asked for, so the box's answer doesn't take back an end
    /// that came first.
    @Test func aHandoffAskedAgainThatFailsTheSameWayShowsItsEnd() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: ["## Handoff\nIt pauses on blur.", "## Handoff\nIt pauses on blur."])
        engine.on("POST", "/api/session", json: ["message": "There's no room for another conversation."], status: 500)
        engine.on("PATCH", "/api/session/\(id)", json: ["data": [:]])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }

        model.draftText = "/handoff write the test"
        model.submitDraft(for: nil, queue: false)
        await model.messagesSent()
        try await until { model.handoff?.state == .failed }
        let first = try #require(model.handoff?.started)
        model.draftText = "/handoff write the test"
        model.submitDraft(for: nil, queue: false)
        await model.messagesSent()
        try await until { model.handoff?.state == .failed && model.handoff?.started != first }
        #expect(model.handoff?.error == bridge.agents.handoffs[id]?.error)
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
        model.submitDraft(for: nil, queue: false)
        try await until { !engine.requests("POST", "/api/session/\(id)/prompt").isEmpty }
        #expect(model.session.agent == "plan")
        let asked = engine.asked.filter { $0.hasSuffix("/agent") || $0.hasSuffix("/prompt") }
        #expect(asked == ["POST /api/session/\(id)/agent", "POST /api/session/\(id)/prompt"], "Plan first, then the message")
        let sent = try #require(engine.requests("POST", "/api/session/\(id)/prompt").first)
        let text = try #require(sent.body["text"] as? String)
        #expect(text.hasPrefix("how to test the blur pause"))
        // Its bubble, read from the parts its box keeps with it (on any client), draws the keyword
        // as typed in front of the words; taken back (Undo, a draft), it's the words alone.
        #expect(text.contains("\n\n<sent-with>\n"))
        let parts = (sent.body["metadata"] as? [String: Any]).flatMap { $0["kuvo"] as? [String: Any] }?["parts"] as? [String: Any]
        #expect(parts?["keyword"] as? String == "/plan")
        #expect(parts?["words"] as? String == "how to test the blur pause")
    }

    /// `/plan` alone turns Plan on, and again turns it off, back to Build; with words in Plan it
    /// stays in Plan and sends them.
    @Test func planAloneTurnsPlanOnAndOff() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: [])
        // The engine keeps the mode it's switched to, as its box reads it.
        let mode = Answers([])
        engine.on("POST", "/api/session/\(id)/agent") { request in
            mode.set(request.body["agent"] as? String ?? "")
            return StubWeb.json(["data": [:]])
        }
        engine.on("GET", "/api/session/\(id)") { _ in
            StubWeb.json(["data": StubEngine.session(self.id, title: "Pause on blur", directory: "/tmp", extra: ["model": ["id": "m", "providerID": "p"], "agent": mode.now ?? "build"])])
        }
        engine.on("POST", "/api/session/\(id)/prompt", json: ["data": [:]])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }
        let picked = { engine.requests("POST", "/api/session/\(id)/agent").compactMap { $0.body["agent"] as? String } }

        model.draftText = "/plan"
        model.submitDraft(for: nil, queue: false)
        await model.messagesSent()
        try await until { picked() == ["plan"] }
        #expect(model.session.agent == "plan")
        #expect(model.draftText.isEmpty)

        model.draftText = "/plan"
        model.submitDraft(for: nil, queue: false)
        await model.messagesSent()
        try await until { picked() == ["plan", "build"] }
        #expect(model.session.agent == "build")

        // The Plan Mode menu item and ⌥⌘2 go by the box too.
        await model.togglePlan()?.value
        #expect(picked() == ["plan", "build", "plan"])
        #expect(model.session.agent == "plan")
        model.draftText = "/plan the next step"
        model.submitDraft(for: nil, queue: false)
        try await until { !engine.requests("POST", "/api/session/\(id)/prompt").isEmpty }
        #expect(model.session.agent == "plan")
        #expect(picked() == ["plan", "build", "plan"], "already in Plan: it stays, and sends")
        #expect(engine.requests("POST", "/api/session/\(id)/prompt").count == 1)
        // And off again, back to Build, as its box says.
        await model.togglePlan()?.value
        #expect(picked() == ["plan", "build", "plan", "build"])
        #expect(model.session.agent == "build")
        #expect(!model.transcript.pending.contains { $0.text.hasPrefix("/plan") }, "a menu's switch shows no message")
        #expect(engine.requests("POST", "/api/session/\(id)/prompt").count == 1)
    }

    @Test func aLoopWhoseHowOftenCantBeReadComesBackAndSaysSo() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: [])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }

        model.draftText = "/loop now and then check CI"
        model.submitDraft(for: nil, queue: false)

        await model.messagesSent()
        #expect(model.draftText == "/loop now and then check CI")
        #expect(model.failure?.hasPrefix("Can’t tell how often") == true)
        model.draftText = "/loop every morning at 9"
        model.submitDraft(for: nil, queue: false)
        await model.messagesSent()
        #expect(model.draftText == "/loop every morning at 9")
        #expect(model.failure?.hasPrefix("Write what to do each time") == true)
        #expect(told == 0)
    }

    /// A "/" or "!" text shows at once where it was sent, until its box has said what it means: in
    /// the conversation, as a message waiting to go, or, for a side question, in its side thread,
    /// being answered (it never joins the conversation). A message sent meanwhile shows and goes at
    /// once, not after it.
    @Test func aTypedTextShowsAtOnceWhereItWasSentAndAMessageSentMeanwhileDoesntWait() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: ["In `onBlur`."])
        engine.on("POST", "/api/session/\(id)/prompt", json: ["data": [:]])
        engine.on("POST", "/api/session/\(id)/shell", json: ["data": [:]])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }
        // (Its side questions read, as an open conversation has them.)
        await bridge.agents.loadSideQuestions(of: id)

        model.draftText = "!pwd"
        model.submitDraft(for: nil, queue: false)
        #expect(model.transcript.pending.map(\.text) == ["!pwd"])
        model.draftText = "Pause it on blur then."
        model.submitDraft(for: nil, queue: false)
        #expect(model.transcript.pending.map(\.text) == ["!pwd", "Pause it on blur then."], "the message shows at once")
        model.draftText = "/btw where does it pause?"
        model.submitDraft(for: nil, queue: false)
        #expect(model.transcript.pending.map(\.text) == ["!pwd", "Pause it on blur then."], "a side question isn't the conversation's")
        #expect(model.shownSideThread?.latest.question == "where does it pause?")
        #expect(model.shownSideThread?.latest.state == .answering)

        await model.messagesSent()
        #expect(!model.transcript.pending.contains { $0.text == "!pwd" }, "its row gives way to what it means")
        try await until { model.sideQuestions.map(\.question) == ["where does it pause?"] && model.sideQuestions.first?.state == .answered && told == 1 }
        #expect(engine.requests("POST", "/api/session/\(id)/shell").count == 1)
    }

    /// What you're replying to goes with one message: a "/" text that turns out to be a message
    /// takes it only if it's still in the composer, not after a message sent meanwhile took it.
    @Test func aQuoteGoesWithOneMessageOnly() async throws {
        defer { clean() }
        serve(directory: "/tmp", answers: [])
        engine.on("POST", "/api/session/\(id)/prompt", json: ["data": [:]])
        // (Its commands, as an engine lists them: none of them is "/tmp".)
        engine.on("GET", "/api/command", json: ["data": []])
        let model = try session()
        let bridge = try await start(model)
        defer { bridge.stop() }
        let quote = Drafts.Quote(text: "The timer stops at zero.")

        model.draftQuotes = [quote]
        model.draftText = "/tmp/timer.log says why"
        model.submitDraft(for: nil, queue: false)
        #expect(model.draftQuotes.map(\.text) == ["The timer stops at zero."], "it waits for what the box says")
        model.draftText = "Fix it."
        model.submitDraft(for: nil, queue: false)
        #expect(model.draftQuotes.isEmpty)
        await model.messagesSent()
        try await until { engine.requests("POST", "/api/session/\(id)/prompt").count == 2 }
        let sent = engine.requests("POST", "/api/session/\(id)/prompt").compactMap { $0.body["text"] as? String }
        #expect(sent.filter { $0.contains("The timer stops at zero.") }.count == 1, "\(sent)")
    }
}
