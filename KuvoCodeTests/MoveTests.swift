import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Moving a bot, a chat or a group chat to another computer is the boxes' work (the bridge's
/// `moves.test.js`); the app asks once and goes by what each box says of its moves. While this
/// Mac's box says one is under way, what it moves is held here: it shows as moving, nothing is sent
/// to it, and a copy its box doesn't live on yet is left out of the list. Once the box says it's
/// over, what waited goes, once. This Mac's box is the real one, its engine a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct MoveTests {
    let engine = StubEngine(port: 47908)
    let chats = AppInfo.testRoot.appending(path: "move-chats").path(percentEncoded: false)

    /// A move as this Mac's box keeps it while it's under way (`run/moves`).
    private func underWay(_ id: String, thing: String, role: String, sessions: [String]) throws {
        let record: [String: Any] = [
            "id": id, "kind": "chat", "thing": thing, "name": "“Trip plans”", "from": "mac-key", "to": "lab-key", "role": role,
            "stage": "copying", "sessions": sessions, "peer": role == "from" ? "lab-key" : "mac-key", "wasPaused": true, "tries": 0,
            "started": Date.now.timeIntervalSince1970 * 1000,
        ]
        let folder = BoxProcess.run.appending(path: "moves")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: record).write(to: folder.appending(path: "\(id).json"), options: .atomic)
    }

    private func over(_ id: String) throws {
        try FileManager.default.removeItem(at: BoxProcess.run.appending(path: "moves/\(id).json"))
    }

    @Test func whatAMoveHoldsWaitsUntilItsThereAndACopyIsLeftOut() async throws {
        defer { engine.stop() }
        // Its box alone (no other computers to move anything with): what it says is as the test writes it.
        let box = try await TestBox(engine: engine.url, environment: ["KUVO_TEST_NO_PEERS": "1"])
        defer { box.stop() }
        let app = AppModel()
        app.moves.app = app
        app.workspace.api = engine.api
        app.moves.boxes = { _ in box.client(engine: engine.url) }
        engine.list([
            StubEngine.session("ses_trip", title: "Trip plans", directory: chats),
            StubEngine.session("ses_copy", title: "Groceries", directory: chats),
            StubEngine.session("ses_other", title: "Notes", directory: chats),
        ])
        engine.on("POST", "/api/session/ses_trip/prompt", json: [:])
        await app.workspace.refresh()
        let following = Task { await app.moves.follow() }
        defer { following.cancel() }

        // This Mac's chat moving to a machine, and a copy of a machine's coming here.
        try underWay("mov_out1", thing: "ses_trip", role: "from", sessions: ["ses_trip"])
        try underWay("mov_in1", thing: "ses_copy", role: "to", sessions: ["ses_copy"])
        try await until { Moves.isFrozen("ses_trip") && Moves.isFrozen("ses_copy") }
        #expect(!Moves.isFrozen("ses_other"))
        #expect(app.moves.isPending("ses_trip"))
        #expect(app.workspace.movedAway["ses_copy"] == .some(nil), "the copy coming here isn't this Mac's yet")
        #expect(app.workspace.movedAway["ses_trip"] == nil, "the one leaving lives here until it's switched")

        // A reply sent now waits for it, and goes once it's over.
        let reply = Task { try await Deliveries.send("Book the train", to: "ses_trip", delivery: .queue, on: app.workspace.api) }
        try over("mov_out1")
        try over("mov_in1")
        try await until { !Moves.isFrozen("ses_trip") && !Moves.isFrozen("ses_copy") }
        #expect(try await reply.value)
        #expect(engine.requests("POST", "/api/session/ses_trip/prompt").count == 1)
        #expect(app.workspace.movedAway.isEmpty)
        #expect(!app.moves.isPending("ses_trip"))
    }
}
