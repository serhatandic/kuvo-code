import Foundation
import KuvoLink
import OpenCodeKit
import ClientSessions
import Testing
@testable import KuvoCode

/// Autopilot, in a conversation's composer (PROTOCOL.md, "Autopilot"): Interactive until you turn
/// it on in the Mode menu or with /autopilot, on until its chip's ×; the calls it made where a
/// question would have waited, shown where they were asked, and your choice on one telling its
/// agent. The machine's box is the real one (`kuvo-link.js serve`); its engine is a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct AutopilotTests {
    let engine = StubEngine(port: 48_027)
    private let session = StubEngine.session("ses_one", directory: "/srv/cafe")
    private static let entry = "/api/experimental/session/ses_one/instructions/entries/kuvo.autopilot"

    init() {
        TestEnvironment.prepare()
    }

    /// The machine's box, its engine the stand-in with one conversation, which keeps what it's
    /// changed to, and asks nothing.
    private func lab() async throws -> MachineTestBox {
        let machine = try await MachineTestBox(name: "lab")
        let kept = Guarded(session)
        engine.on("GET", "/api/session/ses_one") { _ in StubWeb.json(["data": kept.withLock { $0 }]) }
        engine.on("PATCH", "/api/session/ses_one") { request in
            StubWeb.json(["data": kept.withLock { now in
                for (key, value) in request.body { now[key] = value }
                return now
            }])
        }
        engine.on("GET", "/api/session", json: ["data": []])
        engine.on("GET", "/api/session/ses_one/form", json: ["data": []])
        engine.on("GET", "/api/session/ses_one/permission", json: ["data": []])
        engine.on("PUT", Self.entry, json: ["data": [:]])
        engine.on("DELETE", Self.entry, json: ["data": [:]])
        engine.on("POST", "/api/session/*", json: ["data": [:]])
        try await StubWeb.listen(port: 48_027)
        try FileManager.default.createDirectory(at: machine.folder.appending(path: "run"), withIntermediateDirectories: true)
        try Data(#"{"port": 48027, "password": "test"}"#.utf8).write(to: machine.folder.appending(path: "run/engine.json"))
        return machine
    }

    private func done(_ machine: MachineTestBox) {
        machine.stop()
        StubWeb.stopListening(port: 48_027)
        engine.stop()
    }

    private func conversation(on machine: MachineTestBox) throws -> SessionModel {
        let model = SessionModel(session: try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: session)), api: engine.api)
        model.box = { machine.client }
        return model
    }

    /// What the conversation's metadata was last changed to keep, as the box asked its engine.
    private var keptOn: Bool? {
        let kept = engine.requests("PATCH", "/api/session/ses_one").last?.body["metadata"] as? [String: Any]
        return (kept?["kuvo"] as? [String: Any])?["autopilot"] as? Bool
    }

    @Test func aConversationIsInteractiveUntilAutopilotIsTurnedOnAndItsChipTurnsItOff() async throws {
        let machine = try await lab()
        defer { done(machine) }
        let model = try conversation(on: machine)
        await model.readAutopilot()
        await model.readKeywords()
        #expect(model.autopilotChoice == AutopilotChoice(on: false), "offered in the Mode menu, off")
        #expect(model.keywords.contains(.autopilot))

        // From the Mode menu: on at once, kept with the conversation, and its agent told how to work.
        model.setAutopilot(true)
        #expect(model.autopilotChoice?.on == true, "the chip shows at once")
        try await until { keptOn == true }
        #expect(!engine.requests("PUT", Self.entry).isEmpty)
        let later = try conversation(on: machine)
        await later.readAutopilot()
        #expect(later.isAutopilot, "the box keeps it, for any client")

        // Its chip's ×: Interactive again.
        model.setAutopilot(false)
        #expect(!model.isAutopilot, "the chip goes at once")
        // Kept off first, then its agent told it asks again (so no question goes ahead meanwhile).
        try await until { keptOn == false && !engine.requests("DELETE", Self.entry).isEmpty }
    }

    @Test func autopilotWithWordsTurnsItOnBeforeTheMessageGoesAndAloneTurnsItOnAndOff() async throws {
        let machine = try await lab()
        defer { done(machine) }
        let model = try conversation(on: machine)
        await model.readAutopilot()

        model.draftText = "/autopilot pick a palette and build the menu page"
        model.submitDraft(for: nil, queue: false)
        try await until { !engine.requests("POST", "/api/session/ses_one/prompt").isEmpty }
        #expect(model.isAutopilot)
        let order = engine.asked.filter { $0 == "PUT \(Self.entry)" || $0 == "POST /api/session/ses_one/prompt" }
        #expect(order == ["PUT \(Self.entry)", "POST /api/session/ses_one/prompt"], "its agent works on Autopilot from the first word")
        let text = try #require(engine.requests("POST", "/api/session/ses_one/prompt").first?.body["text"] as? String)
        #expect(SentMessage.split(text).text == "pick a palette and build the menu page")
        #expect(SentMessage.keyword(of: text) == "/autopilot")

        model.draftText = "/autopilot"
        model.submitDraft(for: nil, queue: false)
        try await until { keptOn == false }
        #expect(!model.isAutopilot)
        #expect(model.draftText.isEmpty)
        model.draftText = "/autopilot"
        model.submitDraft(for: nil, queue: false)
        try await until { keptOn == true }
        #expect(engine.requests("POST", "/api/session/ses_one/prompt").count == 1, "alone, it sends nothing")
    }

    @Test func aCallItMadeShowsAtTheStepThatAskedAndYourChoiceTellsItsAgent() async throws {
        let machine = try await lab()
        defer { done(machine) }
        // A call it made while you were away, as its box keeps it.
        let work = machine.folder.appending(path: "run/work")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let call: [String: Any] = ["id": "frm_1", "text": "Which roast for the house blend?", "choice": "Warm and roasty", "why": "Best reviewed, and it suits the pastries",
                                   "options": ["Light and fruity", "Warm and roasty", "Dark and smoky"], "call": "call_roast", "at": 1]
        try JSONSerialization.data(withJSONObject: ["ses_one": [call]]).write(to: work.appending(path: "decided.json"))
        let model = try conversation(on: machine)
        await model.readAutopilot()
        let made = try #require(model.autopilotShown?.decided(at: "call_roast"))
        #expect(made.choice == "Warm and roasty")
        #expect(!made.changed)

        model.choose("Dark and smoky", on: made)
        try await until { model.autopilotShown?.decided(at: "call_roast")?.changed == true }
        #expect(model.autopilotShown?.decided(at: "call_roast")?.current == "Dark and smoky")
        try await until {
            engine.requests("POST", "").contains { request in
                let text = "\(request.body)"
                return text.contains("[Decision changed]") && text.contains("Dark and smoky") && text.contains("Warm and roasty")
            }
        }
    }

    /// What the agent's browser asks of you, with the app's own wiring, through the tool it calls.
    @Test func aSignInACodeOrAStepOnAutopilotComesBackAtOnceWithNoCard() async throws {
        defer { engine.stop() }
        let app = AppModel()
        app.workspace.api = engine.api
        engine.list([StubEngine.session("ses_a", directory: "/tmp/kuvo-tests-autopilot", extra: ["metadata": ["kuvo": ["autopilot": true]]]),
                     StubEngine.session("ses_i", directory: "/tmp/kuvo-tests-autopilot")])
        await app.workspace.refresh()
        _ = app.browserTools
        let agent = BrowserAgent(utilities: app.utilities, asks: app.browserAsks)
        #expect(await agent.askUser("Solve the CAPTCHA.", for: "ses_a").contains("This is on Autopilot:"))
        #expect(app.browserAsks.asks.isEmpty)
        // An Interactive conversation's still shows its card.
        let asking = Task { await app.browserAsks.ask(.action(instruction: "Solve the CAPTCHA."), host: "example.com", session: "ses_i") }
        try await until { !app.browserAsks.asks.isEmpty }
        asking.cancel()
        _ = await asking.value
    }

    /// Turned on while a card is up (from the phone, say), the agent stops waiting and the card goes.
    @Test func goingOnAutopilotReleasesACardAlreadyUp() async throws {
        defer { engine.stop() }
        let app = AppModel()
        app.workspace.api = engine.api
        engine.list([StubEngine.session("ses_i", directory: "/tmp/kuvo-tests-autopilot"), StubEngine.session("ses_o", directory: "/tmp/kuvo-tests-autopilot")])
        await app.workspace.refresh()
        _ = app.browserTools
        let asking = Task { await app.browserAsks.ask(.action(instruction: "Solve the CAPTCHA."), host: "example.com", session: "ses_i") }
        let other = Task { await app.browserAsks.ask(.action(instruction: "Approve it."), host: "example.com", session: "ses_o") }
        // And a subagent's, which asked before it was known whose it is.
        let subagent = Task { await app.browserAsks.ask(.action(instruction: "Solve it too."), host: "example.com", session: "ses_sub") }
        try await until { app.browserAsks.asks.count == 3 }
        engine.on("GET", "/api/session/ses_sub", json: ["data": StubEngine.session("ses_sub", directory: "/tmp/kuvo-tests-autopilot", extra: ["parentID": "ses_i"])])
        let question: [String: Any] = ["id": "frm_sub", "sessionID": "ses_sub", "title": "Roast", "metadata": ["kind": "question"], "fields": [[String: Any]]()]
        app.workspace.handle(try engine.event("form.created", session: "ses_sub", ["form": question]))
        try await until { app.workspace.root(of: "ses_sub") == "ses_i" }
        engine.on("GET", "/api/session/ses_i", json: ["data": StubEngine.session("ses_i", directory: "/tmp/kuvo-tests-autopilot", extra: ["metadata": ["kuvo": ["autopilot": true]]])])
        app.workspace.handle(try engine.event("session.metadata.updated", session: "ses_i"))
        guard case .leftOnAutopilot = await asking.value else {
            Issue.record("It went on waiting")
            return
        }
        guard case .leftOnAutopilot = await subagent.value else {
            Issue.record("Its subagent went on waiting")
            return
        }
        #expect(app.browserAsks.asks.map(\.session) == ["ses_o"], "another conversation's stays")
        // Already on, one that asked before it was known whose it is goes as soon as it's known.
        let late = Task { await app.browserAsks.ask(.action(instruction: "Solve this too."), host: "example.com", session: "ses_late") }
        try await until { app.browserAsks.asks.count == 2 }
        engine.on("GET", "/api/session/ses_late", json: ["data": StubEngine.session("ses_late", directory: "/tmp/kuvo-tests-autopilot", extra: ["parentID": "ses_i"])])
        let lateQuestion: [String: Any] = ["id": "frm_late", "sessionID": "ses_late", "title": "Roast", "metadata": ["kind": "question"], "fields": [[String: Any]]()]
        app.workspace.handle(try engine.event("form.created", session: "ses_late", ["form": lateQuestion]))
        guard case .leftOnAutopilot = await late.value else {
            Issue.record("A subagent of a conversation already on Autopilot went on waiting")
            return
        }
        other.cancel()
        _ = await other.value
    }

    /// What an MCP server asks a conversation on Autopilot counts, and tells you, only as its box says.
    @Test func anMCPServersFormOnAutopilotCountsOnlyAsItsBoxSays() async throws {
        defer { engine.stop() }
        let project = "/tmp/kuvo-tests-autopilot"
        let workspace = Workspace()
        workspace.api = engine.api
        engine.list([StubEngine.session("ses_a", directory: project, extra: ["metadata": ["kuvo": ["autopilot": true]]])], running: ["ses_a"])
        engine.conversation("ses_a", [["id": "msg_02", "type": "assistant", "agent": "build", "time": ["created": 2], "model": ["id": "m", "providerID": "p"],
                                       "content": [["type": "tool", "id": "call_1", "name": "github_create_issue", "executed": true,
                                                    "state": ["status": "running", "input": ["title": "Crash"]]]]]])
        await workspace.refresh()
        let asked = Guarded<[String]>([])
        workspace.boxes = { _ in
            BoxClient(box: "lab", transport: LocalBox { request in
                AsyncThrowingStream { out in
                    let form = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any])?["form"] as? String ?? ""
                    asked.withLock { $0.append("\(request.path) \(form)") }
                    out.yield(.head(status: 200, headers: [:]))
                    out.yield(.body(Data(#"{"waiting":\#(form.hasSuffix("waits"))}"#.utf8)))
                    out.finish()
                }
            })
        }
        func ask(_ id: String) throws {
            let form: [String: Any] = ["id": id, "sessionID": FormRequest.anySession, "title": "github is requesting input",
                                       "metadata": ["kind": "mcp-elicitation", "server": "github", "message": "Which repository?"],
                                       "fields": [["key": "repo", "type": "string"]]]
            workspace.handle(try ServerEvent(json: JSONSerialization.data(withJSONObject: [
                "id": "evt_" + Identifier.message().dropFirst(4), "type": "form.created", "created": Date().timeIntervalSince1970 * 1000,
                "location": ["directory": project], "data": ["form": form],
            ])))
        }
        try ask("frm_goes")
        #expect(workspace.waitingCount == 0, "not until its box has said")
        // (`notifying` first: it's what wakes this wait, which the stand-in's list doesn't.)
        try await until { !workspace.notifying.contains("frm_goes") && asked.withLock { $0.contains("kuvo/sessions/ses_a/autopilot/asked frm_goes") } }
        #expect(workspace.waitingCount == 0)
        try ask("frm_waits")
        try await until { workspace.waitingCount == 1 }

        // Read again after each reconnect, in the conversation that's open: still only as its box says.
        let again: [String: Any] = ["id": "frm_again", "sessionID": FormRequest.anySession, "title": "github is requesting input",
                                    "metadata": ["kind": "mcp-elicitation", "server": "github", "message": "Which branch?"],
                                    "fields": [["key": "branch", "type": "string"]]]
        engine.on("GET", "/api/session/global/form", json: ["data": [again]])
        engine.on("GET", "/api/session/ses_a/form", json: ["data": [[String: Any]]()])
        _ = try #require(workspace.model(for: "ses_a"))
        await workspace.resync()
        try await until { !workspace.notifying.contains("frm_again") && asked.withLock { $0.contains("kuvo/sessions/ses_a/autopilot/asked frm_again") } }
        await workspace.resync()
        #expect(workspace.asking["frm_again"] == nil)
    }

    @Test func aQuestionSetAsideOnAutopilotReadsSoAndDoesntCountAsFailed() throws {
        func asked(_ id: String) throws -> Message.Content {
            let call: [String: Any] = ["type": "tool", "id": id, "name": "question", "executed": true, "state": ["status": "completed", "input": [String: Any](), "content": [[String: Any]]()]]
            return try JSONDecoder().decode(Message.Content.self, from: JSONSerialization.data(withJSONObject: call))
        }
        func step(_ message: String) throws -> Message.Content {
            let call: [String: Any] = ["type": "tool", "id": "call_1", "name": "question", "executed": true,
                                       "state": ["status": "error", "input": [String: Any](), "error": ["type": "unknown", "message": message]]]
            return try JSONDecoder().decode(Message.Content.self, from: JSONSerialization.data(withJSONObject: call))
        }
        let setAside = try step("This is on Autopilot: nothing was put to the user.")
        #expect(StepsRow.outcomes(of: [setAside]) == "")
        #expect(StepsRow.outcomes(of: [try step("Something broke.")]) == " (1 failed)")
        guard case .tool(let call) = setAside else { return }
        #expect(StepsSummary.summary(of: [call]) == "Set a question aside")
        // One it decided asked nobody.
        #expect(StepsRow.summary(of: [try asked("call_2")], decided: ["call_2"]) == "Decided a question")
        #expect(ToolCallView.summary(of: call, in: "/tmp") == "Set a question aside on Autopilot")
        // It still says what it asked, when it opens.
        let asking: [String: Any] = ["type": "tool", "id": "call_2", "name": "question", "executed": true,
                                     "state": ["status": "error", "input": ["questions": [["question": "Which card should it pay with?"]]],
                                               "error": ["type": "unknown", "message": "This is on Autopilot: nothing was put to the user."]]]
        guard case .tool(let asked) = try JSONDecoder().decode(Message.Content.self, from: JSONSerialization.data(withJSONObject: asking)) else { return }
        #expect(asked.questionsAsked == "Which card should it pay with?")
        // Any other step that quotes those words (a test's output, a command's) failed as any does.
        let quoting: [String: Any] = ["type": "tool", "id": "call_3", "name": "shell", "executed": true,
                                      "state": ["status": "error", "input": ["command": "npm test"], "error": ["type": "unknown", "message": "expected “This is on Autopilot: …”"]]]
        let shell = try JSONDecoder().decode(Message.Content.self, from: JSONSerialization.data(withJSONObject: quoting))
        #expect(StepsRow.outcomes(of: [shell]) == " (1 failed)")
        guard case .tool(let ran) = shell else { return }
        #expect(!ran.isSetAsideOnAutopilot)
        #expect(StepsSummary.summary(of: [ran]) != "Set a question aside")
    }

    /// A question in a conversation on Autopilot counts, and tells you, as its box says it waits on
    /// you, whatever it marks; one its box can't say about tells you, as any question. A conversation
    /// that isn't on Autopilot asks its box nothing.
    @Test func aQuestionOnAutopilotWaitsOnYouAsItsBoxSays() async throws {
        defer { engine.stop() }
        let workspace = Workspace()
        workspace.api = engine.api
        let on = StubEngine.session("ses_a", directory: "/tmp/kuvo-tests-autopilot", extra: ["metadata": ["kuvo": ["autopilot": true]]])
        engine.list([on, StubEngine.session("ses_i", directory: "/tmp/kuvo-tests-autopilot")], running: ["ses_a", "ses_i"])
        engine.conversation("ses_a", [])
        engine.conversation("ses_i", [])
        engine.on("GET", "/api/session/ses_sub", json: ["data": StubEngine.session("ses_sub", directory: "/tmp/kuvo-tests-autopilot", extra: ["parentID": "ses_a"])])
        await workspace.refresh()
        let asks = Guarded<[String]>([])
        workspace.boxes = { _ in
            BoxClient(box: "lab", transport: LocalBox { request in
                AsyncThrowingStream { out in
                    let form = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any])?["form"] as? String ?? ""
                    asks.withLock { $0.append("\(request.path) \(form)") }
                    let refused = form == "frm_refused"
                    out.yield(.head(status: refused ? 404 : 200, headers: [:]))
                    out.yield(.body(Data((refused ? #"{"message":"Not here."}"# : #"{"waiting":\#(form.hasSuffix("waits"))}"#).utf8)))
                    out.finish()
                }
            })
        }
        func ask(_ id: String, in session: String = "ses_a", marked: Bool) throws {
            let labels = marked ? ["Warm (Recommended)", "Dark"] : ["Warm", "Dark"]
            let form: [String: Any] = ["id": id, "sessionID": session, "title": "Roast", "metadata": ["kind": "question"],
                                       "fields": [["key": "q0", "title": "Roast", "description": "Which roast?", "type": "string", "required": true,
                                                   "options": labels.map { ["value": $0, "label": $0] }]]]
            workspace.handle(try engine.event("form.created", session: session, ["form": form]))
        }
        func heard(_ id: String) async throws { try await until { !workspace.notifying.contains(id) } }

        // This Mac's box answers it, as it does a conversation's Autopilot.
        #expect(!PhoneLink.appAnswers("kuvo/sessions/ses_a/autopilot/asked"))

        // Not waiting, as its box says: not counted, marked or not.
        try ask("frm_marked_goes", marked: true)
        #expect(workspace.waitingCount == 0)
        try await heard("frm_marked_goes")
        try ask("frm_plain_goes", marked: false)
        #expect(workspace.waitingCount == 0, "its box says, not its marks")
        try await heard("frm_plain_goes")
        #expect(workspace.waitingCount == 0)

        // Waiting, as its box says: counted, marked or not.
        try ask("frm_marked_waits", marked: true)
        #expect(workspace.waitingCount == 0, "not before its box has said")
        try await heard("frm_marked_waits")
        #expect(workspace.asking["frm_marked_waits"] == "ses_a", "its marks don't send it ahead here: its box didn't")
        #expect(workspace.waitingCount == 1)
        try ask("frm_plain_waits", marked: false)
        try await heard("frm_plain_waits")
        #expect(workspace.asking["frm_plain_waits"] == "ses_a")

        // Its box can't say: yours, as any question.
        try ask("frm_refused", marked: true)
        try await heard("frm_refused")
        #expect(workspace.asking["frm_refused"] == "ses_a")

        // A subagent's: its conversation's box is asked.
        try ask("frm_sub_goes", in: "ses_sub", marked: true)
        try await heard("frm_sub_goes")
        #expect(workspace.asking["frm_sub_goes"] == nil)
        #expect(asks.withLock { $0.contains("kuvo/sessions/ses_a/autopilot/asked frm_sub_goes") })
        // Known as its conversation's (a read of its own, apart from what `heard` waits on): not
        // counted first, as the Dock would show it.
        try await until { workspace.root(of: "ses_sub") == "ses_a" }
        try ask("frm_sub_again", in: "ses_sub", marked: false)
        #expect(workspace.asking["frm_sub_again"] == nil)
        try await heard("frm_sub_again")

        // Answered: off the count.
        workspace.handle(try engine.event("form.replied", session: "ses_a", ["id": "frm_marked_waits", "sessionID": "ses_a"]))
        #expect(workspace.asking["frm_marked_waits"] == nil)

        // Not on Autopilot: yours at once, whatever it marks, and its box isn't asked.
        let before = asks.withLock { $0.count }
        try ask("frm_interactive", in: "ses_i", marked: true)
        #expect(workspace.asking["frm_interactive"] == "ses_i")
        #expect(workspace.waitingCount == 2)
        try await heard("frm_interactive")
        #expect(asks.withLock { $0.count } == before)
    }

    /// A list of questions shows as a call each at its step; one that takes several answers changes
    /// one at a time, keeping one at least.
    @Test func aListOfQuestionsShowsACallEachAndSeveralAnswersChangeOneAtATime() throws {
        let data = try JSONSerialization.data(withJSONObject: ["autopilot": true, "decided": [
            ["id": "frm/roast", "text": "Which roast?", "choice": "Warm", "options": ["Warm", "Dark"], "call": "call_list", "at": 1],
            ["id": "frm/extras", "text": "Which extras?", "choice": "Oat milk, Cinnamon", "options": ["Oat milk", "Syrup", "Cinnamon"], "multiple": true, "call": "call_list", "at": 1],
        ]])
        let shown = try JSONDecoder().decode(AutopilotShown.self, from: data)
        #expect(shown.byCall["call_list"]?.map(\.id) == ["frm/roast", "frm/extras"])

        let extras = shown.decided[1]
        #expect(extras.isChosen("Cinnamon"))
        #expect(!extras.isChosen("Syrup"))
        #expect(extras.picking("Syrup") == "Oat milk, Syrup, Cinnamon")
        #expect(extras.picking("Cinnamon") == "Oat milk")
        #expect(shown.decided[0].picking("Dark") == "Dark")
        let one = try JSONDecoder().decode(AutopilotShown.Call.self, from: JSONSerialization.data(withJSONObject: ["id": "f", "text": "t", "choice": "Oat milk", "options": ["Oat milk", "Syrup"], "multiple": true, "at": 1]))
        #expect(one.picking("Oat milk") == nil)
    }

    /// A call with no step of its own still shows, with what it asked: at its subagent's row, or
    /// under the conversation. One whose step may be among earlier messages waits for them.
    @Test func aCallWithNoStepOfItsOwnShowsAtItsSubagentOrUnderTheConversation() throws {
        func call(_ id: String, asked: String? = nil, session: String? = nil) -> [String: Any] {
            var call: [String: Any] = ["id": id, "text": "Which?", "choice": "A", "at": 1]
            if let asked { call["call"] = asked }
            if let session { call["session"] = session }
            return call
        }
        let data = try JSONSerialization.data(withJSONObject: ["autopilot": true, "decided": [
            call("at_step", asked: "call_seen"),
            call("sub", asked: "call_inside", session: "ses_sub"),
            call("deep", asked: "call_deep", session: "ses_deep"),
            call("no_tool"),
            call("gone", asked: "call_gone"),
        ]])
        let shown = try JSONDecoder().decode(AutopilotShown.self, from: data)
        func ids(_ calls: [AutopilotShown.Call]) -> [String] { calls.map(\.id) }

        let whole = shown.places(steps: ["call_seen"], subagents: ["ses_sub"], whole: true)
        #expect(ids(whole.bySubagent["ses_sub"] ?? []) == ["sub"])
        #expect(ids(whole.alone) == ["deep", "no_tool", "gone"])

        // Earlier messages not read yet: only what has no step anywhere shows there.
        #expect(ids(shown.places(steps: ["call_seen"], subagents: ["ses_sub"], whole: false).alone) == ["no_tool"])

        // A subagent's own conversation: its own, at its steps or under them.
        let own = shown.places(steps: [], subagents: [], whole: true, subagent: "ses_sub")
        #expect(ids(own.alone) == ["sub"])
        #expect(ids(shown.places(steps: ["call_inside"], subagents: [], whole: true, subagent: "ses_sub").alone).isEmpty)
    }

    /// A goal's calls in its bar, as its box sends them: the latest first, a few until Show More, and
    /// each to change only while it runs.
    @Test func aGoalsCallsShowInItsBarTheLatestFirstAndChangeableWhileItRuns() throws {
        func goal(state: String) throws -> GoalPlan {
            let calls = (1...5).map { ["id": "dec_\($0)", "text": "Which \($0)?", "choice": "Pick \($0)", "options": ["Pick \($0)", "Other"], "at": $0] as [String: Any] }
            let json: [String: Any] = ["id": "goal_1", "bot": "bot_ada", "name": "Ada", "session": "ses_one", "goal": "Ship it", "state": state, "steps": [], "proposed": 1, "mode": "autopilot", "decided": calls]
            return try JSONDecoder().decode(GoalPlan.self, from: JSONSerialization.data(withJSONObject: json))
        }
        let running = try goal(state: "running")
        #expect(running.decided.count == 5)
        #expect(GoalDecidedRows.calls(running).map(\.choice) == ["Pick 5", "Pick 4", "Pick 3"])
        #expect(GoalDecidedRows.calls(running, all: true).count == 5)
        #expect(GoalDecidedRows.calls(running).allSatisfy { $0.options != nil })
        #expect(GoalDecidedRows.calls(try goal(state: "done")).allSatisfy { $0.options == nil }, "over, there's nothing left to redirect")
    }

    /// A conversation's Autopilot is kept in its notes, for a client to read.
    @Test func aConversationIsOnAutopilotAsItsNotesSay() throws {
        #expect(AutopilotShown.isOn(try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: StubEngine.session("ses_two", directory: "/srv", extra: ["metadata": ["kuvo": ["autopilot": true]]])))))
    }
}
