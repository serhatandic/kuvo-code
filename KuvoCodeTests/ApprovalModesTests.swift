import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// How much a conversation's agent does on its own, as its box keeps it (PROTOCOL.md, "Approval"):
/// the mode the composer shows and sets, Full Access asked once on a computer, what Auto's reviewer
/// held back shown over the composer until you look, and a new conversation made with the mode you
/// picked. The machine's box is the real one (`kuvo-link.js serve`), reached over HTTP where a Mac
/// reaches it over SSH; its engine is a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ApprovalModesTests {
    let engine = StubEngine(port: 48_011)

    /// Ask First's rules, as a conversation from before has them.
    private static let askFirst: [[String: Any]] = ["edit", "write", "patch", "shell", "webfetch"].map { ["action": $0, "resource": "*", "effect": "ask"] }
    private let session = StubEngine.session("ses_one", directory: "/srv/app", extra: ["permissions": ApprovalModesTests.askFirst])

    init() {
        TestEnvironment.prepare()
    }

    /// The machine's box, its engine the stand-in with one conversation, which keeps what it's
    /// changed to.
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
        engine.on("POST", "/api/session/*", json: ["data": [:]])
        try await StubWeb.listen(port: 48_011)
        try FileManager.default.createDirectory(at: machine.folder.appending(path: "run"), withIntermediateDirectories: true)
        try Data(#"{"port": 48011, "password": "test"}"#.utf8).write(to: machine.folder.appending(path: "run/engine.json"))
        return machine
    }

    private func done(_ machine: MachineTestBox) {
        machine.stop()
        StubWeb.stopListening(port: 48_011)
        engine.stop()
    }

    private func conversation(on machine: MachineTestBox) throws -> SessionModel {
        let model = SessionModel(session: try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: session)), api: engine.api)
        model.box = { machine.client }
        return model
    }

    @Test func fullAccessIsAskedOnceOnAComputerThenTheConversationRunsInIt() async throws {
        let machine = try await lab()
        defer { done(machine) }
        let model = try conversation(on: machine)
        await model.readApproval()
        #expect(model.approval == .askFirst, "one from before reads as its rules say")
        #expect(model.approvalShown?.option(.fullAccess)?.unavailable?.reason == "fullAccessOff")

        // Not confirmed on this computer yet: the composer asks, and nothing changes meanwhile.
        model.setApproval(.fullAccess)
        try await until { model.confirmsFullAccess }
        #expect(model.approval == .askFirst)
        #expect(engine.requests("PATCH", "/api/session/ses_one").isEmpty)

        model.confirmFullAccess()
        try await until { model.approvalShown?.effective == .fullAccess }
        #expect(model.approval == .fullAccess)
        #expect(!model.confirmsFullAccess)
        let kept = try #require(engine.requests("PATCH", "/api/session/ses_one").last?.body["metadata"] as? [String: Any])
        #expect((kept["kuvo"] as? [String: Any])?["approval"] as? String == "fullAccess", "kept with the conversation on its box")
        let rules = try #require(engine.requests("PATCH", "/api/session/ses_one").last?.body["permissions"] as? [[String: Any]])
        #expect(!rules.contains { $0["action"] as? String == "shell" && $0["effect"] as? String == "ask" }, "nothing asks")

        // Confirmed there now: picked again elsewhere, it isn't asked again.
        struct Here: Decodable { var fullAccess: Bool }
        #expect(try await machine.client.value(Here.self, "GET", "kuvo/approval").fullAccess)
        model.setApproval(.acceptEdits)
        try await until { model.approvalShown?.effective == .acceptEdits }
        model.setApproval(.fullAccess)
        try await until { model.approvalShown?.effective == .fullAccess }
        #expect(!model.confirmsFullAccess)
    }

    @Test func whatAutoHeldBackShowsOverTheComposerUntilYouLookAndApproveLetsItRunOnce() async throws {
        let machine = try await lab()
        defer { done(machine) }
        let reviews = machine.folder.appending(path: "box/reviews")
        try FileManager.default.createDirectory(at: reviews, withIntermediateDirectories: true)
        let now = Date.now.timeIntervalSince1970 * 1000
        func log(_ decisions: [[String: Any]]) throws {
            try JSONSerialization.data(withJSONObject: ["decisions": decisions, "refusedInRow": 1, "refused": 1]).write(to: reviews.appending(path: "ses_one.json"))
        }
        let installed: [String: Any] = ["id": "d1", "at": now - 2_000, "action": "brew install jq", "kind": "command", "decision": "allowed", "reason": "An install the task needs.", "by": "model"]
        let push: [String: Any] = ["id": "d2", "at": now - 1_000, "action": "git push --force origin main", "kind": "command", "decision": "refused", "reason": "It rewrites main, which you didn't ask for.", "by": "model", "why": "reviewer", "held": true, "key": "k2"]
        try log([installed, push])

        let model = try conversation(on: machine)
        model.readDecisions()
        try await until { model.decisions != nil }
        #expect(model.unseenHeld.map(\.action) == ["git push --force origin main"], "the bar names what's held back, not what went ahead")
        #expect(model.decisions?.latestFirst.map(\.action) == ["git push --force origin main", "brew install jq"])

        model.approveDecision(try #require(model.unseenHeld.first))
        try await until { model.decisions?.decisions.first { $0.key == "d2" }?.approved != nil }
        #expect(model.unseenHeld.isEmpty, "approved: nothing left to show")
        try await until { engine.requests("POST", "").contains { "\($0.body)".contains("You approved: git push --force origin main") } }

        // Another held back, after the box kept your approval: shown, until you open Decisions.
        let delete: [String: Any] = ["id": "d3", "at": now, "action": "rm -rf ~/Projects/old", "kind": "command", "decision": "refused", "reason": "Deletes another project.", "by": "model", "why": "reviewer", "held": true, "key": "k3"]
        let kept = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: reviews.appending(path: "ses_one.json"))) as? [String: Any])
        try log((kept["decisions"] as? [[String: Any]] ?? []) + [delete])
        model.readDecisions()
        try await until { model.unseenHeld.map(\.action) == ["rm -rf ~/Projects/old"] }
        model.openDecisions()
        #expect(model.showsDecisions)
        #expect(model.unseenHeld.isEmpty)
        #expect(model.decisions?.waiting.map(\.action) == ["rm -rf ~/Projects/old"], "still there to approve in Decisions")
    }

    @Test func oneHeldBackWhileTheListWasOnItsWayStillShows() async throws {
        let held = #"{"id":"d1","at":1,"action":"git push --force origin main","kind":"command","decision":"refused","reason":"It rewrites main.","by":"model","why":"reviewer","held":true,"key":"k1"}"#
        let box = SlowDecisions(first: #"{"decisions":[]}"#, later: #"{"decisions":[\#(held)]}"#)
        let model = SessionModel(session: try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: session)), api: engine.api)
        model.box = { box.client }
        model.readDecisions()
        try await until { box.holding }
        // Auto holds something back while that read is on its way, and the conversation reads again.
        model.readDecisions()
        box.release()
        try await until { model.unseenHeld.map(\.action) == ["git push --force origin main"] }
    }

    @Test func aPausedAutoShowsUntilYouLetItGoOn() async throws {
        let machine = try await lab()
        defer { done(machine) }
        let reviews = machine.folder.appending(path: "box/reviews")
        try FileManager.default.createDirectory(at: reviews, withIntermediateDirectories: true)
        let now = Date.now.timeIntervalSince1970 * 1000
        try JSONSerialization.data(withJSONObject: ["decisions": [["id": "d1", "at": now, "action": "cat ~/.ssh/id_ed25519", "kind": "command", "decision": "refused", "reason": "Reads your SSH key.", "by": "model", "why": "reviewer", "held": true]], "refusedInRow": 3, "refused": 3, "paused": now])
            .write(to: reviews.appending(path: "ses_one.json"))

        let model = try conversation(on: machine)
        model.readDecisions()
        try await until { model.decisions?.paused != nil }
        model.resumeAuto()
        try await until { model.decisions != nil && model.decisions?.paused == nil }
        #expect(model.decisions?.waiting.count == 1, "what it held back is still yours to approve")
    }

    @Test func aNewConversationIsMadeWithTheModePickedForItsBoxToKeep() async throws {
        let machine = "lab"
        let workspace = Workspace()
        let api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: engine.url)!, password: "test"), folderPrefix: RemoteFolder.prefix(for: machine))
        workspace.machineAPI = { $0 == machine ? api : nil }
        defer { engine.stop() }
        engine.on("POST", "/api/session", json: ["data": StubEngine.session("ses_new", directory: "/srv/app")])

        _ = try await workspace.createSession(in: RemoteFolder.folder("/srv/app", on: machine), model: nil, agent: "build", approval: .acceptEdits)
        let picked = try #require(engine.requests("POST", "/api/session").last?.body)
        #expect(((picked["metadata"] as? [String: Any])?["kuvo"] as? [String: Any])?["approval"] as? String == "acceptEdits")
        // Until its box makes its rules a moment later, it asks before commands.
        #expect((picked["permissions"] as? [[String: Any]])?.contains { $0["action"] as? String == "shell" && $0["effect"] as? String == "ask" } == true)

        // None picked: its box gives it that computer's default.
        _ = try await workspace.createSession(in: RemoteFolder.folder("/srv/app", on: machine), model: nil, agent: "build")
        #expect(engine.requests("POST", "/api/session").last?.body["metadata"] == nil)
    }
}

/// A box's decisions: the first read held on its way until `release()`, answering what was there
/// when it was asked; the reads after it answer what's there now.
private nonisolated final class SlowDecisions: @unchecked Sendable {
    private let lock = NSLock()
    private let first: String
    private let later: String
    private var reads = 0
    private var held: AsyncThrowingStream<LinkResponsePart, Error>.Continuation?

    init(first: String, later: String) {
        self.first = first
        self.later = later
    }

    var holding: Bool { lock.withLock { held != nil } }

    func release() {
        guard let held = lock.withLock({ () -> AsyncThrowingStream<LinkResponsePart, Error>.Continuation? in
            defer { self.held = nil }
            return self.held
        }) else { return }
        Self.answer(first, to: held)
    }

    private static func answer(_ body: String, to continuation: AsyncThrowingStream<LinkResponsePart, Error>.Continuation) {
        continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
        continuation.yield(.body(Data(body.utf8)))
        continuation.finish()
    }

    @MainActor var client: BoxClient {
        BoxClient(box: BoxClient.mac, transport: LocalBox { [self] _ in
            AsyncThrowingStream { continuation in
                let isFirst = lock.withLock {
                    reads += 1
                    if reads == 1 { held = continuation }
                    return reads == 1
                }
                if !isFirst { Self.answer(later, to: continuation) }
                TestPulse.beat()
            }
        })
    }
}
