import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Moving a bot, a chat or a group chat to another computer is the boxes' work (the bridge's
/// `moves.test.js`); the app asks once and goes by what each box says of its moves. While this
/// Mac's box says one is under way, what it moves is held here: it shows as moving, nothing is sent
/// to it, and a copy its box doesn't live on yet is left out of the list. Once the box says it's
/// over, what waited goes, once, and what came here is listed, whoever asked for the move. This
/// Mac's box is the real one, its engine a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct MoveTests {
    let engine = StubEngine(port: 47908)
    let chats = AppInfo.testRoot.appending(path: "move-chats").path(percentEncoded: false)

    /// A move as this Mac's box keeps it while it's under way (`run/moves`).
    private func underWay(_ id: String, thing: String, role: String, sessions: [String], to: String = "lab-key", sent: Int? = nil, size: Int? = nil) throws {
        var record: [String: Any] = [
            "id": id, "kind": "chat", "thing": thing, "name": "“Trip plans”", "from": "mac-key", "to": to, "role": role,
            "stage": "copying", "sessions": sessions, "peer": role == "from" ? to : "mac-key", "wasPaused": true, "tries": 0,
            "started": Date.now.timeIntervalSince1970 * 1000,
        ]
        record["sent"] = sent
        record["size"] = size
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
        await app.workspace.refresh()
        #expect(app.workspace.session("ses_copy") == nil, "nor listed")
        #expect(app.workspace.movedAway["ses_trip"] == nil, "the one leaving lives here until it's switched")

        // A reply sent now waits for it, and goes once it's over.
        let reply = Task { try await Deliveries.send("Book the train", to: "ses_trip", delivery: .queue, on: app.workspace.api) }
        try over("mov_out1")
        try over("mov_in1")
        try await until { !Moves.isFrozen("ses_trip") && !Moves.isFrozen("ses_copy") }
        #expect(try await reply.value)
        #expect(engine.requests("POST", "/api/session/ses_trip/prompt").count == 1)
        #expect(app.workspace.movedAway.isEmpty)
        // The copy's this Mac's now, though a phone asked for the move: listed.
        try await until { app.workspace.session("ses_copy") != nil }
        #expect(!app.moves.isPending("ses_trip"))
    }

    /// Your machine "lab", as this Mac's box knows it among your computers (`run/link.json`).
    private static let lab = String(repeating: "L", count: 43)
    private func labIsAPeer() throws {
        let file = BoxProcess.run.appending(path: "link.json")
        var link = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any] ?? [:]
        link["phones"] = link["phones"] ?? []
        link["macPeers"] = [["key": Self.lab, "sign": String(repeating: "S", count: 43), "address": String(repeating: "A", count: 22), "name": "lab", "id": "lab", "kind": "machine"]]
        try FileManager.default.createDirectory(at: BoxProcess.run, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: link).write(to: file, options: .atomic)
    }

    @Test func itsMenuListsWhereTheBoxSaysItCanGoAndItsRowSaysHowFarItIs() async throws {
        defer { engine.stop() }
        let box = try await TestBox(engine: engine.url, environment: ["KUVO_TEST_NO_PEERS": "1"])
        defer { box.stop() }
        try labIsAPeer()
        let app = AppModel()
        app.moves.app = app
        app.workspace.api = engine.api
        app.moves.boxes = { _ in box.client(engine: engine.url) }
        // A chat of this Mac's, where its box keeps them.
        let chat = StubEngine.session("ses_trip", title: "Trip plans", directory: AppInfo.supportDirectory.appending(path: "Chats").path(percentEncoded: false))
        engine.list([chat])
        engine.on("GET", "/api/session/ses_trip", json: chat)
        let following = Task { await app.moves.follow() }
        defer { following.cancel() }

        // Its menu: lab, as this Mac's box says, and kept a while.
        let places = try #require(await app.moves.loadPlaces("chat", "ses_trip", from: nil))
        #expect(places.map(\.name) == ["lab"])
        #expect(places.first?.ok == true && places.first?.why == nil)
        #expect(app.moves.places(of: "ses_trip", from: nil) == places)
        #expect(app.moves.places(of: "ses_trip", from: "lab") == nil, "only as the box it lives on said")

        // Moving to lab (asked from a phone, say): its row says where to and how far its copy is.
        try underWay("mov_out2", thing: "ses_trip", role: "from", sessions: ["ses_trip"], to: Self.lab, sent: 12_400_000, size: 30_000_000)
        try await until { app.moves.isMoving("ses_trip") }
        #expect(app.moves.underWay["ses_trip"]?.words == "Moving to lab… 12 of 30 MB")
        // And its menu, opened now, says why it can't go anywhere: asked again, not as it was kept.
        let now = try #require(await app.moves.loadPlaces("chat", "ses_trip", from: nil))
        #expect(now.first?.ok == false)
        #expect(now.first?.why == "It’s moving to another computer. Try again once it’s there.")
        #expect(now.first?.note == "Moving already", "short, beside lab's name")
        // Asked to move again meanwhile, it says why rather than nothing.
        let again = Moves.Place(key: Self.lab, name: "lab", kind: "machine", ok: true)
        await #expect(throws: Moves.Failure.self) { try await app.moves.move("chat", "ses_trip", from: nil, to: again) }
        try over("mov_out2")
        try await until { !app.moves.isMoving("ses_trip") }
        // Over: what its menu was told before isn't shown as now (it may live elsewhere now).
        #expect(app.moves.places(of: "ses_trip", from: nil) == nil)
    }
}
