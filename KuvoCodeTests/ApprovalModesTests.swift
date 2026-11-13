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

        let workspace = Workspace()
        workspace.boxes = { _ in machine.client }
        model.confirmFullAccess(in: workspace)
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

        // Looked at here, so not news after the app opens again, or on another client.
        try await until { model.decisions?.seen != nil }
        let later = try conversation(on: machine)
        later.readDecisions()
        try await until { later.decisions != nil }
        #expect(later.unseenHeld.isEmpty)
        #expect(later.decisions?.waiting.count == 1)
    }

    /// A folder Auto allowed edits in for the session (#422) is listed, counted as the one edit that
    /// allowed it, and Revoke takes it back on the box: each change there is judged again.
    @Test func aFolderAutoAllowsEditsInIsListedAndRevokeTakesItBack() async throws {
        let machine = try await lab()
        defer { done(machine) }
        let reviews = machine.folder.appending(path: "box/reviews")
        try FileManager.default.createDirectory(at: reviews, withIntermediateDirectories: true)
        let now = Date.now.timeIntervalSince1970 * 1000
        let edit: [String: Any] = ["id": "d1", "at": now, "action": "Change /tmp/eval/T2/vault.test.js", "kind": "file", "decision": "allowed", "reason": "Part of the evaluation.", "by": "model"]
        let place: [String: Any] = ["id": "d2", "at": now, "action": "Change /tmp/eval/T2", "kind": "file", "decision": "allowed", "reason": "Auto allowed edits in /tmp/eval/T2 for this session.", "by": "model", "place": "/tmp/eval/T2"]
        let file = reviews.appending(path: "ses_one.json")
        try JSONSerialization.data(withJSONObject: ["decisions": [edit, place], "refusedInRow": 0, "refused": 0, "places": ["/tmp/eval/T2"]]).write(to: file)

        let model = try conversation(on: machine)
        model.readDecisions()
        try await until { model.decisions != nil }
        #expect(model.decisions?.counts == .init(edits: 1))
        let allowed = try #require(model.decisions?.decisions.first { $0.place != nil })
        #expect(allowed.revocable)

        model.revokePlace(allowed)
        try await until { model.decisions?.decisions.first { $0.key == "d2" }?.revoked != nil }
        #expect(model.decisions?.decisions.first { $0.key == "d2" }?.revocable == false)
        let kept = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        #expect((kept["places"] as? [String]) == [])
    }

    /// A long night's work reads at a glance: how many it held back and of each kind it allowed,
    /// what waits on you first however old, then the latest, the rest folded into "…N more".
    @Test func decisionsListWhatWaitsOnYouFirstAndCountTheRest() throws {
        var each: [String] = []
        for minute in 0..<10 {
            each.append(#"{"id":"e\#(minute)","at":\#(minute),"action":"Change /work/Sweep/Design/File\#(minute).swift","kind":"file","decision":"allowed","reason":"In the project.","by":"code"}"#)
        }
        each.insert(#"{"id":"p","at":0.5,"action":"git push --force origin main","kind":"command","decision":"refused","reason":"Rewrites main.","by":"model","held":true,"key":"k"}"#, at: 1)
        each.append(#"{"id":"b","at":11,"action":"xcodebuild -scheme Sweep test","kind":"command","decision":"allowed","reason":"Its tests.","by":"model"}"#)
        each.append(#"{"id":"r","at":12,"action":"Read /Users/me/.ssh/config","kind":"file","decision":"allowed","reason":"You asked.","by":"model"}"#)
        // Held back, then you approved it and it ran: it counts (and lists) once, as what it was,
        // not as held back still. (The box also logs its run as allowed by you.)
        each.insert(#"{"id":"z","at":5.5,"action":"Change /Users/me/.zshrc","kind":"file","decision":"refused","reason":"Your shell's start-up.","by":"model","held":true,"key":"z","approved":6,"used":6.5}"#, at: 7)
        each.insert(#"{"id":"y","at":6.5,"action":"Change /Users/me/.zshrc","kind":"file","decision":"allowed","reason":"You approved it after Auto's reviewer held it back.","by":"you"}"#, at: 8)
        let decisions = try JSONDecoder().decode(ReviewDecisions.self, from: Data(#"{"decisions":[\#(each.joined(separator: ","))]}"#.utf8))

        #expect(decisions.counts == .init(heldBack: 1, edits: 11, reads: 1, commands: 1))
        let folded = decisions.listed(limit: 3)
        #expect(folded.rows.map(\.action) == ["git push --force origin main", "Read /Users/me/.ssh/config", "xcodebuild -scheme Sweep test", "Change /work/Sweep/Design/File9.swift"])
        #expect(folded.more == 10)
        let all = decisions.listed(limit: nil)
        #expect(all.rows.count == 14 && all.more == 0)
    }

    @Test func decisionsSayWhenTheirComputerCantBeReached() async throws {
        let box = Unreachable()
        let model = SessionModel(session: try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: session)), api: engine.api)
        model.box = { box.client }
        model.openDecisions()
        try await until { model.decisionsUnread }
        #expect(model.decisions == nil)

        // Back: Try Again reads them.
        box.reachable = true
        model.readDecisions()
        try await until { model.decisions != nil }
        #expect(!model.decisionsUnread)
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

    @Test func picksAnsweredOutOfOrderShowWhatTheBoxKept() async throws {
        let box = SlowPicks()
        let model = SessionModel(session: try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: session)), api: engine.api)
        model.box = { box.client }
        await model.readApproval()
        #expect(model.approval == .askFirst)

        // Accept Edits, then Auto at once: the box takes both in turn, but Accept Edits' answer
        // comes back last.
        model.setApproval(.acceptEdits)
        try await until { box.holding }
        model.setApproval(.auto)
        try await until { model.approvalShown?.effective == .auto }
        box.release()
        // Read again once both are answered (a late answer shown instead would be the wrong one).
        try await until { model.approval != .auto || box.reads == 2 }
        #expect(model.approval == .auto, "the box keeps Auto, and so does the composer")
    }

    /// A bot's conversation on a box from before bots could have Full Access (bridge 0.9.188): the
    /// option says why and isn't picked, and a pick made before its options were read is turned
    /// down quietly, the mode as it was, with no failure and no Full Access confirmation.
    @Test func aBotsFullAccessAnOlderBoxWontGiveIsShownNotPicked() async throws {
        let box = OlderBotBox()
        let model = SessionModel(session: try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: session)), api: engine.api)
        model.box = { box.client }
        await model.readApproval()
        #expect(model.approvalShown?.option(.fullAccess)?.unavailable?.reason == "bot")
        model.setApproval(.fullAccess)
        model.setApproval(.auto)
        try await until { model.approvalShown?.effective == .auto }
        #expect(box.picks == ["auto"], "Full Access isn't sent to a box that said it won't")
        #expect(!model.confirmsFullAccess)

        // Picked before the box said so: it turns it down, and that's all.
        box.says = false
        await model.readApproval()
        box.says = true
        model.setApproval(.fullAccess)
        // Read again, its menu says why (it didn't before).
        try await until { model.approvalShown?.option(.fullAccess)?.unavailable?.reason == "bot" }
        #expect(model.approval == .auto)
        #expect(model.failure == nil)
        #expect(!model.confirmsFullAccess)
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

    /// A new conversation on a machine is made by its box with the mode picked, which it keeps: Ask
    /// First's asks from its first moment for Accept Edits, so nothing runs unasked.
    @Test func aNewConversationIsMadeWithTheModePickedForItsBoxToKeep() async throws {
        let machine = try await lab()
        defer { done(machine) }
        engine.on("POST", "/api/session", json: ["data": StubEngine.session("ses_new", directory: "/srv/app")])
        engine.on("GET", "/api/session/ses_new", json: ["data": StubEngine.session("ses_new", directory: "/srv/app")])
        let workspace = Workspace()
        let api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: engine.url)!, password: "test"), folderPrefix: RemoteFolder.prefix(for: "lab"))
        workspace.machineAPI = { $0 == "lab" ? api : nil }
        workspace.boxes = { $0 == "lab" ? machine.client : nil }

        _ = try await workspace.createSession(in: RemoteFolder.folder("/srv/app", on: "lab"), model: nil, agent: "build", approval: .acceptEdits)
        let picked = try #require(engine.requests("POST", "/api/session").last?.body)
        #expect(((picked["metadata"] as? [String: Any])?["kuvo"] as? [String: Any])?["approval"] as? String == "acceptEdits")
        #expect((picked["permissions"] as? [[String: Any]])?.contains { $0["action"] as? String == "shell" && $0["effect"] as? String == "ask" } == true)
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

/// A box keeping one conversation's approval: it takes each pick as it comes, but the first one's
/// answer is held on its way until `release()`.
private nonisolated final class SlowPicks: @unchecked Sendable {
    private let lock = NSLock()
    private var approval = "askFirst"
    private var puts = 0
    private var gets = 0
    private var held: (AsyncThrowingStream<LinkResponsePart, Error>.Continuation, String)?

    var holding: Bool { lock.withLock { held != nil } }
    /// Reads of the conversation's approval.
    var reads: Int { lock.withLock { gets } }

    func release() {
        guard let (continuation, body) = lock.withLock({ () -> (AsyncThrowingStream<LinkResponsePart, Error>.Continuation, String)? in
            defer { held = nil }
            return held
        }) else { return }
        Self.answer(body, to: continuation)
        TestPulse.beat()
    }

    private static func shown(_ approval: String) -> String {
        let options = ["askFirst", "acceptEdits", "auto", "fullAccess"].map { #"{"approval":"\#($0)"}"# }.joined(separator: ",")
        return #"{"approval":"\#(approval)","effective":"\#(approval)","options":[\#(options)]}"#
    }

    private static func answer(_ body: String, to continuation: AsyncThrowingStream<LinkResponsePart, Error>.Continuation) {
        continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
        continuation.yield(.body(Data(body.utf8)))
        continuation.finish()
    }

    @MainActor var client: BoxClient {
        BoxClient(box: BoxClient.mac, transport: LocalBox { [self] request in
            AsyncThrowingStream { continuation in
                let picked = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any])?["approval"] as? String
                let now = lock.withLock { () -> String? in
                    if request.method == "PUT", let picked { approval = picked; puts += 1 } else if request.path.hasSuffix("/approval") { gets += 1 }
                    if request.method == "PUT" && puts == 1 {
                        held = (continuation, Self.shown(approval))
                        return nil
                    }
                    return Self.shown(approval)
                }
                if let now { Self.answer(now, to: continuation) }
                TestPulse.beat()
            }
        })
    }
}

/// A bot's conversation's approval on a box from before bridge 0.9.188, which never gives a bot
/// Full Access: its options say so while `says` (a read made before it did doesn't), and a pick of
/// it is turned down with `409`, `reason: "bot"`.
private nonisolated final class OlderBotBox: @unchecked Sendable {
    private let lock = NSLock()
    private var approval = "askFirst"
    private var saying = true
    private var sent: [String] = []

    var says: Bool {
        get { lock.withLock { saying } }
        set { lock.withLock { saying = newValue } }
    }
    /// The modes it was asked to set, in turn, Full Access included.
    var picks: [String] { lock.withLock { sent } }

    @MainActor var client: BoxClient {
        BoxClient(box: BoxClient.mac, transport: LocalBox { [self] request in
            AsyncThrowingStream { continuation in
                let picked = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any])?["approval"] as? String
                let (status, body) = lock.withLock { () -> (Int, String) in
                    if request.method == "PUT", let picked {
                        sent.append(picked)
                        if picked == "fullAccess" {
                            return (409, #"{"error":"Not for a bot.","message":"Bots can't use Full Access: Auto is the most they get.","reason":"bot"}"#)
                        }
                        approval = picked
                    }
                    let full = saying ? #"{"approval":"fullAccess","unavailable":{"reason":"bot","why":"Bots can't use Full Access: Auto is the most they get."}}"# : #"{"approval":"fullAccess"}"#
                    let options = ["askFirst", "acceptEdits", "auto"].map { #"{"approval":"\#($0)"}"# } + [full]
                    return (200, #"{"approval":"\#(approval)","effective":"\#(approval)","options":[\#(options.joined(separator: ","))]}"#)
                }
                continuation.yield(.head(status: status, headers: ["content-type": "application/json"]))
                continuation.yield(.body(Data(body.utf8)))
                continuation.finish()
                TestPulse.beat()
            }
        })
    }
}

/// A box that can't be reached until `reachable`, then has no decisions to show.
private nonisolated final class Unreachable: @unchecked Sendable {
    private let lock = NSLock()
    private var isReachable = false
    var reachable: Bool {
        get { lock.withLock { isReachable } }
        set { lock.withLock { isReachable = newValue } }
    }

    @MainActor var client: BoxClient {
        BoxClient(box: BoxClient.mac, transport: LocalBox { [self] _ in
            AsyncThrowingStream { continuation in
                if reachable {
                    continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(Data(#"{"decisions":[]}"#.utf8)))
                    continuation.finish()
                } else {
                    continuation.finish(throwing: URLError(.cannotConnectToHost))
                }
                TestPulse.beat()
            }
        })
    }
}
