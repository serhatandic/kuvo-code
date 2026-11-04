import ClientSandbox
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// In Auto, what the agent asks to work outside its folder is its reviewer's: no card, no
/// notification and no "needs you" while the box checks it, nor once it allowed or held it back,
/// only a quiet mark on the step that asked; one the box leaves for you is yours as any ask, and so
/// is one it says nothing of in time. The engine and the box's word are stubbed.
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
        // The box says how its reviewer takes asks up.
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

        // Its box restarted, and lists none of them now: what was yours stays yours.
        Sandboxes.shared.take(reviews: [], from: box)
        #expect(workspace.needsAttention(id))
        #expect(model.permissions.filter { Sandboxes.shared.isYours($0, on: box) }.map(\.id) == ["per_r2"])
    }

    /// A command isn't the reviewer's to take up, and a box from before says nothing of reviews:
    /// either is yours at once.
    @Test func whatTheReviewerNeverTakesUpIsYoursAtOnce() async throws {
        defer {
            Sandboxes.shared.forget(box)
            engine.stop()
        }
        _ = try await open()
        Sandboxes.shared.take(reviews: [], from: box)
        workspace.handle(try engine.event("permission.asked", ["id": "per_c1", "sessionID": id, "action": "shell", "resources": ["npm test"]]))
        #expect(workspace.needsAttention(id))
        workspace.handle(try engine.event("permission.replied", ["sessionID": id, "requestID": "per_c1"]))
        Sandboxes.shared.take(reviews: nil, from: box)
        workspace.handle(try engine.event("permission.asked", outside("per_c2")))
        #expect(workspace.needsAttention(id))
    }
}
