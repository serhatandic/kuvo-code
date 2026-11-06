import Foundation
import KuvoLink
import OpenCodeKit
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
        model.submitDraft(for: nil, queue: false, commands: [])
        try await until { !engine.requests("POST", "/api/session/ses_one/prompt").isEmpty }
        #expect(model.isAutopilot)
        let order = engine.asked.filter { $0 == "PUT \(Self.entry)" || $0 == "POST /api/session/ses_one/prompt" }
        #expect(order == ["PUT \(Self.entry)", "POST /api/session/ses_one/prompt"], "its agent works on Autopilot from the first word")
        let text = try #require(engine.requests("POST", "/api/session/ses_one/prompt").first?.body["text"] as? String)
        #expect(SentMessage.split(text).text == "pick a palette and build the menu page")
        #expect(SentMessage.keyword(of: text) == "/autopilot")

        model.draftText = "/autopilot"
        model.submitDraft(for: nil, queue: false, commands: [])
        try await until { keptOn == false }
        #expect(!model.isAutopilot)
        #expect(model.draftText.isEmpty)
        model.draftText = "/autopilot"
        model.submitDraft(for: nil, queue: false, commands: [])
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
        try await until { engine.requests("POST", "").contains { "\($0.body)".contains("the user picked Dark and smoky, not Warm and roasty") } }
    }

    /// A question that marks the choice it recommends is what Autopilot goes ahead on: the Mac
    /// doesn't notify you of one in a conversation on Autopilot, as the box answers it.
    @Test func aQuestionAutopilotGoesAheadOnIsOneThatMarksItsRecommendation() throws {
        func form(_ labels: [String], required: Bool? = nil, format: String? = nil) throws -> FormRequest {
            var field: [String: Any] = ["key": "roast", "type": "string", "options": labels.enumerated().map { ["value": "r\($0.offset)", "label": $0.element] }]
            if let required { field["required"] = required }
            if let format { field["format"] = format }
            return try JSONDecoder().decode(FormRequest.self, from: JSONSerialization.data(withJSONObject: ["id": "frm_1", "sessionID": "ses_one", "title": "Roast", "metadata": ["kind": "question"], "fields": [field]]))
        }
        #expect(try form(["Light", "Warm (Recommended)"]).recommendsAnswer)
        #expect(try !form(["Light", "Warm"]).recommendsAnswer, "none marked: it waits for you")
        #expect(try !form(["Light (Recommended)", "Warm (recommended)"]).recommendsAnswer, "two marked in one choice: it waits")
        #expect(try !form(["Use this key (Recommended)", "Skip"], format: "password").recommendsAnswer, "a secret is yours to hand over, whatever it marks")
        #expect(AutopilotShown.isOn(try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: StubEngine.session("ses_two", directory: "/srv", extra: ["metadata": ["kuvo": ["autopilot": true]]])))))
    }
}
