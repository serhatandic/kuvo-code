import ClientSandbox
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// In Auto, what the agent asks to work outside its folder is its reviewer's: no card, no
/// notification and no "needs you" while the box checks it, nor once it allowed or held it back,
/// only a quiet mark on the step that asked; one the box leaves for you is yours as any ask. The
/// box's word is the whole of it (`sandbox.reviews.whole`): nothing waits on a timer of the app's.
/// The engine and the box's word are stubbed.
@MainActor
@Suite(.serialized) struct AutoReviewAsksTests {
    let engine = StubEngine(port: 47993)
    let workspace = Workspace()
    let id = "ses_reviewed"
    let box = BoxClient.mac

    init() {
        workspace.api = engine.api
    }

    private func open() async throws -> SessionModel {
        engine.list([StubEngine.session(id, title: "Notes", directory: "/tmp/kuvo-tests-reviews")], running: [id])
        engine.conversation(id, [["id": "msg_you", "type": "user", "time": ["created": 1], "text": "Update the shared notes"]])
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        return model
    }

    private func outside(_ request: String) -> [String: Any] {
        ["id": request, "sessionID": id, "action": "external_directory", "resources": ["/tmp/kuvo-tests-notes/*"]]
    }

    private func review(_ request: String, _ state: AskReview.State) -> AskReview {
        AskReview(id: request, session: id, call: "call_" + request, state: state, at: 1)
    }

    @Test func whatAutosReviewerTakesUpDoesntWaitOnYou() async throws {
        let workspace = workspace
        Sandboxes.shared.onYours = { workspace.reviewLeftForYou($0) }
        defer {
            Sandboxes.shared.forget(box)
            Sandboxes.shared.onYours = nil
            engine.stop()
        }
        let model = try await open()
        // The box says how its reviewer takes asks up, its asks heard now.
        Sandboxes.shared.setLive(true, box)
        Sandboxes.shared.take(reviews: [], from: box)
        workspace.handle(try engine.event("permission.asked", outside("per_r1")))
        #expect(model.permissions.map(\.id) == ["per_r1"])
        #expect(!workspace.needsAttention(id), "it waits for the box's word")
        Sandboxes.shared.take(reviews: [review("per_r1", .checking)], from: box)
        #expect(!workspace.needsAttention(id), "Auto is checking it")
        #expect(Sandboxes.shared.reviewMarks(on: box)["call_per_r1"]?.mark == "Auto is checking…")
        Sandboxes.shared.take(reviews: [review("per_r1", .heldBack)], from: box)
        #expect(Sandboxes.shared.reviewMarks(on: box)["call_per_r1"]?.mark == "Held back")
        #expect(!workspace.needsAttention(id))

        // One the box leaves for you is yours, as any ask.
        workspace.handle(try engine.event("permission.asked", outside("per_r2")))
        #expect(!workspace.needsAttention(id))
        Sandboxes.shared.take(reviews: [review("per_r1", .heldBack), review("per_r2", .yours)], from: box)
        #expect(workspace.needsAttention(id))
        let box = box
        #expect(model.permissions.filter { Sandboxes.shared.isYours($0, on: box) }.map(\.id) == ["per_r2"])

        // Its box started again, and lists none of them yet: not yours until it says (it takes up
        // what waits as it starts, PROTOCOL.md's `sandbox.reviews.whole`); then yours again.
        Sandboxes.shared.take(reviews: [], from: box)
        #expect(model.permissions.filter { Sandboxes.shared.isYours($0, on: box) }.isEmpty)
        Sandboxes.shared.take(reviews: [review("per_r2", .yours)], from: box)
        #expect(model.permissions.filter { Sandboxes.shared.isYours($0, on: box) }.map(\.id) == ["per_r2"])
    }

    /// An ask kept while its box checks it is told once the box leaves it for you: the
    /// notification, and "needs you", come then, with no wait of the app's own.
    @Test func anAskLeftForYouIsToldThen() async throws {
        let workspace = workspace
        Sandboxes.shared.onYours = { workspace.reviewLeftForYou($0) }
        defer {
            Sandboxes.shared.forget(box)
            Sandboxes.shared.onYours = nil
            engine.stop()
        }
        _ = try await open()
        Sandboxes.shared.setLive(true, box)
        workspace.handle(try engine.event("permission.asked", outside("per_t1")))
        Sandboxes.shared.take(reviews: [review("per_t1", .checking)], from: box)
        #expect(!workspace.needsAttention(id))
        #expect(workspace.asking["per_t1"] == nil, "not told while it's checked")
        Sandboxes.shared.take(reviews: [review("per_t1", .yours)], from: box)
        #expect(workspace.needsAttention(id))
        #expect(workspace.asking["per_t1"] == id, "told once it's yours")
    }

    /// Its box's link down (crashed, restarting), with its engine still asking: nothing lists what
    /// it asks now, so one it never listed is yours, not hidden while the agent waits; one it said
    /// it's checking stays so, as a moment's cut doesn't tell you of it.
    @Test func withItsBoxNotHeardAnAskNotListedIsYours() async throws {
        let workspace = workspace
        Sandboxes.shared.onYours = { workspace.reviewLeftForYou($0) }
        defer {
            Sandboxes.shared.forget(box)
            Sandboxes.shared.onYours = nil
            engine.stop()
        }
        _ = try await open()
        Sandboxes.shared.setLive(true, box)
        workspace.handle(try engine.event("permission.asked", outside("per_d1")))
        #expect(!workspace.needsAttention(id), "heard, and not listed yet: its box's to say")
        Sandboxes.shared.take(reviews: [review("per_d1", .checking)], from: box)
        #expect(!workspace.needsAttention(id), "being checked")
        // Not heard for a moment: what it last said of one stands (a blip doesn't tell you of it).
        Sandboxes.shared.setLive(false, box)
        #expect(!workspace.needsAttention(id), "still its box's to check")
        // One it never listed, asked while it isn't heard: nothing would list it, so it's yours.
        workspace.handle(try engine.event("permission.asked", outside("per_d2")))
        #expect(workspace.needsAttention(id), "its box not heard: one it never listed is yours")
        #expect(workspace.asking["per_d2"] == id, "and told")
    }

    /// Stopped while Auto checked what it asked: the engine lets that ask go with the run, with no
    /// word of it, and its box drops it from its list. It's gone, so it never turns into yours
    /// later, as when its box isn't heard for a moment (a machine's read that fails): no "needs
    /// you" left on the session's row in its bot's bar, with nothing in the session to answer
    /// (#425).
    @Test func anAskStoppedWhileCheckedIsGoneWithItsRun() async throws {
        let workspace = workspace
        Sandboxes.shared.onYours = { workspace.reviewLeftForYou($0) }
        defer {
            Sandboxes.shared.forget(box)
            Sandboxes.shared.onYours = nil
            engine.stop()
        }
        let model = try await open()
        Sandboxes.shared.setLive(true, box)
        workspace.handle(try engine.event("permission.asked", outside("per_s1")))
        Sandboxes.shared.take(reviews: [review("per_s1", .checking)], from: box)
        #expect(!workspace.needsAttention(id), "being checked")
        // You stop it: the run ends, and its box lists the ask no more.
        workspace.handle(try engine.event("session.execution.interrupted", session: id, ["reason": "user"]))
        Sandboxes.shared.take(reviews: [], from: box)
        #expect(model.permissions.isEmpty)
        #expect(!workspace.needsAttention(id))
        // Its box not heard for a moment: nothing of that ask comes back.
        Sandboxes.shared.setLive(false, box)
        #expect(!workspace.needsAttention(id), "an ask gone with its run isn't yours later")
        #expect(workspace.asking["per_s1"] == nil, "nor told")
    }

    /// Back after a reconnect: one Auto was checking that its engine no longer asks (its run ended
    /// unheard) is gone, never yours later; one it still asks stays, and is told once it's yours.
    @Test func aResyncLetsGoOfWhatsNoLongerAsked() async throws {
        let workspace = workspace
        Sandboxes.shared.onYours = { workspace.reviewLeftForYou($0) }
        defer {
            Sandboxes.shared.forget(box)
            Sandboxes.shared.onYours = nil
            engine.stop()
        }
        _ = try await open()
        Sandboxes.shared.setLive(true, box)
        workspace.handle(try engine.event("permission.asked", outside("per_g1")))
        workspace.handle(try engine.event("permission.asked", outside("per_k1")))
        Sandboxes.shared.take(reviews: [review("per_g1", .checking), review("per_k1", .checking)], from: box)
        // Meanwhile unheard: the engine asks only one of them now, and its box checks only that.
        engine.on("GET", "/api/session/\(id)/permission", json: ["data": [outside("per_k1")]])
        engine.on("GET", "/api/session/\(id)/form", json: ["data": [Any]()])
        await workspace.resync()
        Sandboxes.shared.take(reviews: [review("per_k1", .checking)], from: box)
        Sandboxes.shared.setLive(false, box)
        #expect(workspace.asking["per_g1"] == nil, "gone with its run")
        #expect(!workspace.needsAttention(id))
        Sandboxes.shared.setLive(true, box)
        Sandboxes.shared.take(reviews: [review("per_k1", .yours)], from: box)
        #expect(workspace.asking["per_k1"] == id, "still asked, and yours now")
    }

    /// A command isn't the reviewer's to take up, and a box whose word isn't whole (from before
    /// `sandbox.reviews.whole`) has one it hasn't listed yours at once.
    @Test func whatTheReviewerNeverTakesUpIsYoursAtOnce() async throws {
        defer {
            Sandboxes.shared.takeListsAll(true, from: box)
            Sandboxes.shared.forget(box)
            engine.stop()
        }
        _ = try await open()
        Sandboxes.shared.take(reviews: [], from: box)
        workspace.handle(try engine.event("permission.asked", ["id": "per_c1", "sessionID": id, "action": "shell", "resources": ["npm test"]]))
        #expect(workspace.needsAttention(id))
        workspace.handle(try engine.event("permission.replied", ["sessionID": id, "requestID": "per_c1"]))
        Sandboxes.shared.takeListsAll(false, from: box)
        workspace.handle(try engine.event("permission.asked", outside("per_c2")))
        #expect(workspace.needsAttention(id))
    }
}
