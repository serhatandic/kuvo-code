import ClientDesign
import Foundation
import KuvoLink
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
        try await until { app.moves.held.isSuperset(of: ["ses_trip", "ses_copy"]) }
        #expect(!Moves.isFrozen("ses_other"))
        #expect(app.moves.isPending("ses_trip"))
        #expect(app.workspace.movedAway["ses_copy"] == [BoxClient.mac], "the copy coming here isn't this Mac's yet")
        await app.workspace.refresh()
        #expect(app.workspace.session("ses_copy") == nil, "nor listed")
        #expect(app.workspace.movedAway["ses_trip"] == nil, "the one leaving lives here until it's switched")

        // A reply sent now waits for it, and goes once it's over.
        let reply = Task { try await Deliveries.send("Book the train", to: "ses_trip", delivery: .queue, on: app.workspace.api) }
        try over("mov_out1")
        try over("mov_in1")
        try await until { app.moves.held.isDisjoint(with: ["ses_trip", "ses_copy"]) }
        #expect(try await reply.value)
        #expect(engine.requests("POST", "/api/session/ses_trip/prompt").count == 1)
        // (Let go of as each move's over is read, just after it unfreezes.)
        try await until { app.workspace.movedAway.isEmpty }
        // The copy's this Mac's now, though a phone asked for the move: listed.
        try await until { app.workspace.session("ses_copy") != nil }
        #expect(!app.moves.isPending("ses_trip"))
    }

    /// A rename made while a move has the conversation (begun before it, or made as it ends) isn't
    /// lost: it shows at once, and is made once the conversation is where it lives now; the later
    /// of two, as you'd expect.
    @Test func aRenameWhileItMovesIsMadeOnceItsThere() async throws {
        defer { engine.stop() }
        let box = try await TestBox(engine: engine.url, environment: ["KUVO_TEST_NO_PEERS": "1"])
        defer { box.stop() }
        let app = AppModel()
        app.moves.app = app
        app.workspace.api = engine.api
        app.moves.boxes = { _ in box.client(engine: engine.url) }
        engine.list([StubEngine.session("ses_renamed", title: "Trip plans", directory: chats)])
        engine.on("PATCH", "/api/session/ses_renamed", json: [:])
        await app.workspace.refresh()
        let following = Task { await app.moves.follow() }
        defer { following.cancel() }

        try underWay("mov_rename1", thing: "ses_renamed", role: "from", sessions: ["ses_renamed"])
        try await until { app.moves.held.contains("ses_renamed") }
        let renaming = Task { await app.workspace.rename("ses_renamed", to: "Trip to Lisbon") }
        // Shown so meanwhile; and renamed again before it's there, the later name is the one made.
        try await until { app.workspace.session("ses_renamed")?.title == "Trip to Lisbon" }
        let again = Task { await app.workspace.rename("ses_renamed", to: "Lisbon in May") }
        try await until { app.workspace.session("ses_renamed")?.title == "Lisbon in May" }
        try over("mov_rename1")
        await renaming.value
        await again.value
        #expect(engine.requests("PATCH", "/api/session/ses_renamed").map { $0.body["title"] as? String } == ["Lisbon in May"])
        #expect(app.workspace.session("ses_renamed")?.title == "Lisbon in May")
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

    /// This Mac's moves read twice at once (its group chats read once they're known, as the app
    /// starts and reads every box's): the first read back returns once the latest is taken, so
    /// what goes by it knows a chat moving away is moving, not gone.
    @Test func aReadOvertakenByAnotherReturnsKnowingWhatTheLatestSaid() async throws {
        let gate = Gate()
        let asked = Asked()
        let moving = #"{"moves":[{"id":"mv_1","kind":"group","thing":"grp_trip000001","from":"mac-key","to":"lab-key","role":"from","stage":"copying","sessions":[]}],"away":[]}"#
        let app = AppModel()
        app.moves.app = app
        app.moves.boxes = { box in
            BoxClient(box: box, transport: LocalBox { _ in
                let first = asked.next() == 1
                return AsyncThrowingStream { answer in
                    DispatchQueue.global().async {
                        // The first read answers at once, from before the move; the latest once the gate opens.
                        if !first { gate.wait() }
                        answer.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                        answer.yield(.body(Data((first ? #"{"moves":[],"away":[]}"# : moving).utf8)))
                        answer.finish()
                    }
                }
            })
        }
        let before = Task { await app.moves.reload(BoxClient.mac) }
        let latest = Task { await app.moves.reload(BoxClient.mac) }
        try await until { asked.count == 2 }
        gate.open()
        await before.value
        #expect(app.moves.isPending("grp_trip000001"), "known once the first read returns")
        await latest.value
    }

    /// Requests counted, from any thread.
    nonisolated private final class Asked: @unchecked Sendable {
        private let lock = NSLock()
        private var asked = 0
        var count: Int { lock.withLock { asked } }
        func next() -> Int {
            defer { TestPulse.beat() }
            return lock.withLock { asked += 1; return asked }
        }
    }

    /// A box answering each path as the test says (JSON), and 503 to one it says nothing of.
    private static func box(_ name: String, _ answer: @escaping @Sendable (String) -> String?) -> BoxClient {
        BoxClient(box: name, transport: LocalBox { request in
            AsyncThrowingStream { reply in
                let body = answer(request.path)
                reply.yield(.head(status: body == nil ? 503 : 200, headers: ["content-type": "application/json"]))
                reply.yield(.body(Data((body ?? #"{"message":"Not now."}"#).utf8)))
                reply.finish()
            }
        })
    }

    /// Whether the move a test set up is over yet, from any thread.
    nonisolated private final class Over: @unchecked Sendable {
        private let lock = NSLock()
        private var over = false
        var now: Bool {
            get { lock.withLock { over } }
            set { lock.withLock { over = newValue } }
        }
    }

    /// A bot of this Mac's moved to your machine: once it's there it's listed there, with what you
    /// were writing to it, though this Mac's box said it no longer has it before the machine's
    /// list was read (as its stream does, at once).
    @Test func aBotMovedToAMachineKeepsWhatYouWereWritingToIt() async throws {
        let lab = "move-\(UUID().uuidString.prefix(8).lowercased()).invalid"
        let labKey = String(repeating: "M", count: 43)
        let app = AppModel()
        app.moves.app = app
        app.bots.app = app
        _ = app.machines.add(lab)
        defer {
            app.removeMachine(lab)
            try? FileManager.default.removeItem(at: Bots.file)
        }
        app.phoneLink.standIn(machine: lab, key: labKey)
        let over = Over()
        let pixel = #"{"id":"bot_move00001","session":"ses_movebot","name":"Pixel","look":{"color":"sky","shape":"round","face":"calm"},"folder":"/kuvo-tests-none/bot_move00001"}"#
        let moving = #"{"moves":[{"id":"mv_bot1","kind":"bot","thing":"bot_move00001","from":"mac-key","to":"\#(labKey)","role":"from","stage":"switching","sessions":["ses_movebot"]}],"away":[]}"#
        let mac = BoxClient.mac
        let boxes = { (box: String) in
            Self.box(box) { path in
                switch path {
                case "kuvo/bots": (box == lab) == over.now ? #"{"bots":[\#(pixel)]}"# : #"{"bots":[]}"#
                case "kuvo/moves": box == mac && !over.now ? moving : #"{"moves":[],"away":[]}"#
                default: nil
                }
            }
        }
        app.bots.boxes = boxes
        app.moves.boxes = boxes
        app.bots.reachable = { $0 == lab }
        await app.bots.refresh(BoxClient.mac)
        await app.moves.reload(BoxClient.mac)
        #expect(app.moves.isMoving("bot_move00001"))
        Drafts.shared["ses_movebot"].text = "And the release notes"
        defer { Drafts.shared.remove("ses_movebot") }

        // There: this Mac's box no longer lists it, and says so before the machine's list is read.
        over.now = true
        await app.moves.reload(BoxClient.mac)
        await app.bots.refresh(BoxClient.mac)
        try await until { app.bots.bot("bot_move00001")?.machine == lab && !app.moves.held.contains("bot_move00001") }
        #expect(Drafts.shared["ses_movebot"].text == "And the release notes")
    }

    /// A bot moved to your machine with its conversation in view: its tabs here go, and its panel
    /// starts over rather than having nothing to show (only the tab bar, in the panel's middle).
    @Test func aBotMovedWithItsConversationInViewStillHasATabInItsPanel() async throws {
        let lab = "move-\(UUID().uuidString.prefix(8).lowercased()).invalid"
        let labKey = String(repeating: "M", count: 43)
        let app = AppModel()
        app.moves.app = app
        app.bots.app = app
        _ = app.machines.add(lab)
        defer {
            app.removeMachine(lab)
            try? FileManager.default.removeItem(at: Bots.file)
        }
        app.phoneLink.standIn(machine: lab, key: labKey)
        let over = Over()
        let pixel = #"{"id":"bot_move00002","session":"ses_movebot2","name":"Pixel","look":{"color":"sky","shape":"round","face":"calm"},"folder":"/kuvo-tests-none/bot_move00002"}"#
        let moving = #"{"moves":[{"id":"mv_bot2","kind":"bot","thing":"bot_move00002","from":"mac-key","to":"\#(labKey)","role":"from","stage":"switching","sessions":["ses_movebot2"]}],"away":[]}"#
        let mac = BoxClient.mac
        let boxes = { (box: String) in
            Self.box(box) { path in
                switch path {
                case "kuvo/bots": (box == lab) == over.now ? #"{"bots":[\#(pixel)]}"# : #"{"bots":[]}"#
                case "kuvo/moves": box == mac && !over.now ? moving : #"{"moves":[],"away":[]}"#
                default: nil
                }
            }
        }
        app.bots.boxes = boxes
        app.moves.boxes = boxes
        app.bots.reachable = { $0 == lab }
        await app.bots.refresh(BoxClient.mac)
        await app.moves.reload(BoxClient.mac)
        app.tabs.open(.session("ses_movebot2"))
        app.utilities.inView = app.tabs.inView
        #expect(app.utilities.panelKey == "bot_move00002")

        over.now = true
        await app.moves.reload(BoxClient.mac)
        app.utilities.inView = app.tabs.inView
        await app.bots.refresh(BoxClient.mac)
        app.utilities.inView = app.tabs.inView
        try await until { app.bots.bot("bot_move00002")?.machine == lab && !app.moves.held.contains("bot_move00002") }
        app.utilities.inView = app.tabs.inView
        #expect(app.utilities.selected != nil, "its panel, tabs: \(app.utilities.tabs.map(\.owner))")
    }

    /// A machine whose box can't be read for a moment (its connection dropped, say) hasn't ended
    /// what it said was moving: that still shows as moving, until its box says it's over.
    @Test func aMachineThatCantBeReadForAMomentIsStillMovingWhatItWas() async throws {
        let unreadable = Over()
        let moving = #"{"moves":[{"id":"mv_lab1","kind":"chat","thing":"ses_labtrip","from":"lab-key","to":"mac-key","role":"from","stage":"copying","sessions":["ses_labtrip"]}],"away":[]}"#
        let app = AppModel()
        app.moves.app = app
        app.moves.boxes = { box in Self.box(box) { path in path == "kuvo/moves" && !unreadable.now ? moving : nil } }
        await app.moves.reload("lab")
        #expect(app.moves.isMoving("ses_labtrip"))
        unreadable.now = true
        await app.moves.reload("lab")
        #expect(app.moves.isMoving("ses_labtrip"), "a read that failed says nothing of it")
        #expect(Moves.isFrozen("ses_labtrip"))
        unreadable.now = false
        app.moves.forget("lab")
    }

    /// A move whose other end went quiet stops looking busy and says what it waits for: the machine
    /// it leaves, while that can't be read, or the computer it's going to, as the box it leaves says.
    /// Once that's back, it shows how far it is again.
    @Test func aMoveWaitingForAComputerSaysWhichAndCarriesOnOnceItsBack() async throws {
        let unreadable = Over()
        let quiet = Over()
        let app = AppModel()
        app.moves.app = app
        app.moves.boxes = { box in
            Self.box(box) { path in
                guard path == "kuvo/moves", !unreadable.now else { return nil }
                let waiting = quiet.now ? #","waiting":true"# : ""
                return #"{"moves":[{"id":"mv_wait1","kind":"chat","thing":"ses_waittrip","from":"lab-key","to":"pi-key","role":"from","stage":"copying","sessions":["ses_waittrip"],"place":"pi","sent":12400000,"size":30000000\#(waiting)}],"away":[]}"#
            }
        }
        await app.moves.reload("lab")
        #expect(app.moves.underWay["ses_waittrip"]?.words == "Moving to pi… 12 of 30 MB")
        // Lab out of reach: it waits for lab, still held.
        unreadable.now = true
        await app.moves.reload("lab")
        #expect(app.moves.underWay["ses_waittrip"]?.words == "Waiting for lab")
        #expect(app.moves.underWay["ses_waittrip"]?.spoken == "Waiting for lab. It moves to pi once lab is back.")
        #expect(Moves.isFrozen("ses_waittrip"))
        // Back, though it says just what it said: moving again.
        unreadable.now = false
        await app.moves.reload("lab")
        #expect(app.moves.underWay["ses_waittrip"]?.waitingFor == nil)
        // Lab says pi has gone quiet: it waits for pi.
        quiet.now = true
        await app.moves.reload("lab")
        #expect(app.moves.underWay["ses_waittrip"]?.words == "Waiting for pi")
        quiet.now = false
        await app.moves.reload("lab")
        #expect(app.moves.underWay["ses_waittrip"]?.words == "Moving to pi… 12 of 30 MB")
        app.moves.forget("lab")
    }

    /// Coming here from a machine that's away, and never read since the app started: this Mac's own
    /// box has the move, so it shows as waiting for that machine, not as nothing at all.
    @Test func aMoveComingHereFromAMachineThatsAwaySaysItWaitsForIt() async throws {
        let lab = "move-\(UUID().uuidString.prefix(8).lowercased()).invalid"
        let labKey = String(repeating: "J", count: 43)
        let mac = BoxClient.mac
        let app = AppModel()
        app.moves.app = app
        _ = app.machines.add(lab)
        defer { app.removeMachine(lab) }
        app.phoneLink.standIn(machine: lab, key: labKey)
        app.moves.boxes = { box in
            Self.box(box) { path in
                guard path == "kuvo/moves", box == mac else { return nil }
                return #"{"moves":[{"id":"mv_in3","kind":"chat","thing":"ses_in3","from":"\#(labKey)","to":"mac-key","role":"to","stage":"copying","sessions":["ses_in3"],"place":"devbox","sent":12400000,"size":30000000}],"away":["ses_in3"]}"#
            }
        }
        await app.moves.reload(mac)
        await app.moves.reload(lab)
        let going = try #require(app.moves.underWay["ses_in3"])
        #expect(going.words == "Waiting for devbox")
        #expect(MoveWords.waitingCard(for: going.waitingFor ?? "", place: going.place).title == "Moving to this Mac")
        #expect(MoveWords.progress(sent: going.sent, size: going.size) == "12 of 30 MB")
        app.moves.forget(lab)
    }

    /// A move this Mac's box took back while the machine it was going to restarted: what the machine
    /// said last of it, before it went out of reach, doesn't keep the bot from you until it's back.
    /// One end saying a move is over is enough.
    @Test func aMoveOverAtOneEndIsOverThoughTheOtherCantBeRead() async throws {
        let lab = "move-\(UUID().uuidString.prefix(8).lowercased()).invalid"
        let mac = BoxClient.mac
        let over = Over()
        let unreadable = Over()
        let app = AppModel()
        app.moves.app = app
        app.bots.app = app
        defer { try? FileManager.default.removeItem(at: Bots.file) }
        let pixel = #"{"id":"bot_takeback1","session":"ses_takeback","name":"Pixel","look":{"color":"sky","shape":"round","face":"calm"},"folder":"/kuvo-tests-none/bot_takeback1"}"#
        let move: @Sendable (String) -> String = { role in #"{"moves":[{"id":"mv_back1","kind":"bot","thing":"bot_takeback1","from":"mac-key","to":"lab-key","role":"\#(role)","stage":"copying","sessions":["ses_takeback"]}],"away":[]}"# }
        let boxes = { (box: String) in
            Self.box(box) { path in
                switch path {
                case "kuvo/bots": box == mac ? #"{"bots":[\#(pixel)]}"# : #"{"bots":[]}"#
                case "kuvo/moves" where box == lab: unreadable.now ? nil : move("to")
                case "kuvo/moves": over.now ? #"{"moves":[],"away":[]}"# : move("from")
                default: nil
                }
            }
        }
        app.bots.boxes = boxes
        app.moves.boxes = boxes
        app.bots.reachable = { $0 == lab }
        await app.bots.refresh(mac)
        await app.moves.reload(mac)
        await app.moves.reload(lab)
        #expect(Moves.isFrozen("bot_takeback1"))

        // The machine restarts (out of reach), and this Mac's box takes the move back.
        unreadable.now = true
        await app.moves.reload(lab)
        over.now = true
        await app.moves.reload(mac)
        try await until { !app.moves.held.contains("bot_takeback1") }
        #expect(app.bots.bot("bot_takeback1")?.machine == nil)
        #expect(!app.moves.isMoving("bot_takeback1"))
        app.moves.forget(lab)
    }

    /// A bot moved between two machines: once the one it went to says it's there, it shows there,
    /// though the one it left still lists it until its copy is let go of.
    @Test func aBotThatMovedShowsWhereItWentNotWhereItWas() async throws {
        let lab = "move-\(UUID().uuidString.prefix(8).lowercased()).invalid"
        let pi = "move-\(UUID().uuidString.prefix(8).lowercased()).invalid"
        let (labKey, piKey) = (String(repeating: "L", count: 43), String(repeating: "P", count: 43))
        let app = AppModel()
        app.moves.app = app
        app.bots.app = app
        _ = app.machines.add(lab)
        _ = app.machines.add(pi)
        defer {
            app.removeMachine(lab)
            app.removeMachine(pi)
            try? FileManager.default.removeItem(at: Bots.file)
        }
        app.phoneLink.standIn(machine: lab, key: labKey)
        app.phoneLink.standIn(machine: pi, key: piKey)
        let there = Over()
        let pixel = #"{"id":"bot_twomachines","session":"ses_twomachines","name":"Pixel","look":{"color":"sky","shape":"round","face":"calm"},"folder":"/kuvo-tests-none/bot_twomachines"}"#
        let move: @Sendable (String) -> String = { role in #"{"moves":[{"id":"mv_two1","kind":"bot","thing":"bot_twomachines","from":"\#(labKey)","to":"\#(piKey)","role":"\#(role)","stage":"switching","sessions":["ses_twomachines"]}],"away":[]}"# }
        let boxes = { (box: String) in
            Self.box(box) { path in
                switch path {
                // The machine it left lists it all along (its copy not let go of yet).
                case "kuvo/bots": box == lab || (box == pi && there.now) ? #"{"bots":[\#(pixel)]}"# : #"{"bots":[]}"#
                case "kuvo/moves" where box == lab || box == pi: there.now ? #"{"moves":[],"away":[]}"# : move(box == lab ? "from" : "to")
                case "kuvo/moves": #"{"moves":[],"away":[]}"#
                default: nil
                }
            }
        }
        app.bots.boxes = boxes
        app.moves.boxes = boxes
        app.bots.reachable = { $0 == lab || $0 == pi }
        await app.bots.refresh(lab)
        await app.moves.reload(lab)
        await app.moves.reload(pi)
        #expect(app.moves.isMoving("bot_twomachines"))

        there.now = true
        await app.moves.reload(pi)
        try await until { !app.moves.held.contains("bot_twomachines") }
        #expect(app.bots.bot("bot_twomachines")?.machine == pi)
    }

    /// A move between two of your machines, started elsewhere (on your phone, say): this Mac's box
    /// hears it from the machine (`elsewhere`), and the Mac reads that machine, whose box answers
    /// it over SSH only when asked, and shows it moving.
    @Test func aMoveBetweenTwoMachinesStartedElsewhereShowsHere() async throws {
        let lab = "move-\(UUID().uuidString.prefix(8).lowercased()).invalid"
        let labKey = String(repeating: "E", count: 43)
        let mac = BoxClient.mac
        let started = Over()
        let app = AppModel()
        app.moves.app = app
        _ = app.machines.add(lab)
        defer { app.removeMachine(lab) }
        app.phoneLink.standIn(machine: lab, key: labKey)
        let move = #"{"id":"mv_far1","kind":"chat","thing":"ses_far","from":"\#(labKey)","to":"\#(String(repeating: "F", count: 43))","role":"from","stage":"copying","sessions":["ses_far"],"place":"pi"}"#
        app.moves.boxes = { box in
            Self.box(box) { path in
                guard path == "kuvo/moves" else { return nil }
                if box == mac { return started.now ? #"{"moves":[],"away":[],"elsewhere":[{"box":"\#(labKey)","moves":[\#(move)]}]}"# : #"{"moves":[],"away":[]}"# }
                return started.now ? #"{"moves":[\#(move)],"away":[]}"# : #"{"moves":[],"away":[]}"#
            }
        }
        await app.moves.reloadAll()
        #expect(!app.moves.isMoving("ses_far"))

        // Started on your phone: this Mac's box hears it, and says so (its feed, here read).
        started.now = true
        await app.moves.reload(mac)
        try await until { app.moves.isMoving("ses_far") }
        #expect(app.moves.underWay["ses_far"]?.place == "pi")
        started.now = false
        app.moves.forget(lab)
    }

    /// The same, with the machine's first read lost (its connection dropped a moment): it's read
    /// again while this Mac's box says it's moving, not only when its move's stage changes.
    @Test func aMoveElsewhereWhoseMachineCouldntBeReadShowsOnceItCan() async throws {
        let lab = "move-\(UUID().uuidString.prefix(8).lowercased()).invalid"
        let labKey = String(repeating: "G", count: 43)
        let mac = BoxClient.mac
        let unreadable = Over()
        unreadable.now = true
        let asked = Asked()
        let app = AppModel()
        app.moves.app = app
        _ = app.machines.add(lab)
        defer { app.removeMachine(lab) }
        app.phoneLink.standIn(machine: lab, key: labKey)
        let move = #"{"id":"mv_far2","kind":"chat","thing":"ses_far2","from":"\#(labKey)","to":"\#(String(repeating: "H", count: 43))","role":"from","stage":"copying","sessions":["ses_far2"],"place":"pi"}"#
        app.moves.boxes = { box in
            Self.box(box) { path in
                guard path == "kuvo/moves" else { return nil }
                if box == mac { return #"{"moves":[],"away":[],"elsewhere":[{"box":"\#(labKey)","moves":[\#(move)]}]}"# }
                defer { _ = asked.next() }
                return unreadable.now ? nil : #"{"moves":[\#(move)],"away":[]}"#
            }
        }
        await app.moves.reload(mac)
        try await until { asked.count == 1 }
        #expect(!app.moves.isMoving("ses_far2"))
        unreadable.now = false
        try await until { app.moves.isMoving("ses_far2") }
        app.moves.forget(lab)
    }

    /// The connection to its box gone before it answered, and nothing of it moving there now: it
    /// says so, as the phone does, never the connection's own error (it may be over already).
    @Test func cutOffBeforeItsBoxAnsweredItSaysWhatItsBoxSaysNow() async throws {
        let app = AppModel()
        app.moves.app = app
        app.moves.boxes = { box in
            BoxClient(box: box, transport: LocalBox { request in
                AsyncThrowingStream { reply in
                    guard request.method != "POST" else { return reply.finish(throwing: URLError(.networkConnectionLost)) }
                    reply.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                    reply.yield(.body(Data(#"{"moves":[],"away":[]}"#.utf8)))
                    reply.finish()
                }
            })
        }
        let lab = Moves.Place(key: "lab-key", name: "lab", kind: "machine", ok: true)
        await #expect {
            try await app.moves.move("chat", "ses_cutoff", from: nil, to: lab)
        } throws: { error in
            let error = error as NSError
            return error.localizedDescription == "Lost touch with this Mac’s background work"
                && error.localizedRecoverySuggestion == "Kuvo Code lost touch with this Mac’s background work before it answered, and nothing is moving there now. If it isn’t where you moved it, move it again."
        }
    }

    /// A move's stage changing asks again where only what it moves can go (a request each, over
    /// SSH for a machine's), not where every bot and chat can: theirs haven't changed.
    @Test func aMoveChangingStageAsksAgainOnlyWhereWhatItMovesCanGo() async throws {
        defer { engine.stop() }
        let moving = Over()
        let asked = Asked()
        let app = AppModel()
        app.moves.app = app
        app.workspace.api = engine.api
        let folder = AppInfo.supportDirectory.appending(path: "Chats").path(percentEncoded: false)
        engine.list([StubEngine.session("ses_stagea", title: "Trip plans", directory: folder), StubEngine.session("ses_stageb", title: "Groceries", directory: folder)])
        app.moves.boxes = { box in
            Self.box(box) { raw in
                let path = raw.removingPercentEncoding ?? raw
                let leaving = moving.now
                if path.hasPrefix("kuvo/moves/places") {
                    if path.hasSuffix("id=ses_stageb") { _ = asked.next() }
                    let why = leaving && path.hasSuffix("id=ses_stagea") ? #","why":"It’s moving to another computer.","note":"Moving already""# : ""
                    return #"{"places":[{"key":"lab-key","name":"lab","kind":"machine","ok":\#(why.isEmpty)\#(why)}]}"#
                }
                guard path == "kuvo/moves" else { return nil }
                return leaving ? #"{"moves":[{"id":"mv_stage1","kind":"chat","thing":"ses_stagea","from":"mac-key","to":"lab-key","role":"from","stage":"holding","sessions":["ses_stagea"]}],"away":[]}"# : #"{"moves":[],"away":[]}"#
            }
        }
        await app.workspace.refresh()
        await app.moves.reloadAll()
        try await until { app.moves.places(of: "ses_stagea", from: nil) != nil && app.moves.places(of: "ses_stageb", from: nil) != nil }
        let before = asked.count

        // One starts moving: its menu says so, and the other's isn't asked again.
        moving.now = true
        await app.moves.reload(BoxClient.mac)
        try await until { app.moves.places(of: "ses_stagea", from: nil)?.first?.ok == false }
        #expect(asked.count == before, "where the other can go hasn't changed")
        moving.now = false
        await app.moves.reload(BoxClient.mac)
        try await until { !app.moves.held.contains("ses_stagea") }
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
        // And a session it started, which stays here as it moves.
        let work = StubEngine.session("ses_tripwork", title: "Flights", directory: AppInfo.supportDirectory.appending(path: "Chats").path(percentEncoded: false), created: 2,
                                      extra: ["metadata": ["kuvo": ["startedBy": "ses_trip", "depth": 1]]])
        engine.list([chat, work])
        engine.on("GET", "/api/session/ses_trip", json: chat)
        let following = Task { await app.moves.follow() }
        defer { following.cancel() }

        // Read ahead as Kuvo Code starts, so its menu opens with them (an open menu isn't drawn again).
        await app.workspace.refresh()
        await app.moves.reloadAll()
        try await until { app.moves.places(of: "ses_trip", from: nil) != nil }
        // Its menu: lab, as this Mac's box says, and kept a while.
        let places = try #require(await app.moves.loadPlaces("chat", "ses_trip", from: nil))
        #expect(places.map(\.name) == ["lab"])
        #expect(places.first?.ok == true && places.first?.why == nil)
        #expect(app.moves.places(of: "ses_trip", from: nil) == places)
        #expect(app.moves.places(of: "ses_trip", from: "lab") == nil, "only as the box it lives on said")
        // With what of it stays here, for Move's question.
        #expect(app.moves.stays(of: "ses_trip", from: nil) == MoveWords.Stays(sessions: 1))
        // Read again with nothing changed (ahead, as the panel slides in, say): the sidebar's menus
        // aren't drawn again.
        nonisolated final class Heard: @unchecked Sendable { var changed = false }
        let same = Heard()
        withObservationTracking { _ = app.moves.places(of: "ses_trip", from: nil) } onChange: { same.changed = true }
        await app.moves.loadPlaces("chat", "ses_trip", from: nil, fresh: true)
        await app.moves.loadPlaces("chat", "ses_trip", from: nil, fresh: true)
        #expect(!same.changed, "the same places, read twice")
        let changed = Heard()
        withObservationTracking { _ = app.moves.places(of: "ses_trip", from: nil) } onChange: { changed.changed = true }

        // Moving to lab (asked from a phone, say): its row says where to and how far its copy is.
        try underWay("mov_out2", thing: "ses_trip", role: "from", sessions: ["ses_trip"], to: Self.lab, sent: 12_400_000, size: 30_000_000)
        try await until { app.moves.isMoving("ses_trip") }
        #expect(app.moves.underWay["ses_trip"]?.words == "Moving to lab… 12 of 30 MB")
        // And its menu, opened now, says why it can't go anywhere: asked again, not as it was kept.
        let now = try #require(await app.moves.loadPlaces("chat", "ses_trip", from: nil))
        #expect(now.first?.ok == false)
        #expect(now.first?.why == "It’s moving to another computer. Try again once it’s there.")
        #expect(now.first?.note == "Moving already", "short, beside lab's name")
        #expect(changed.changed, "places that did change are drawn")
        #expect(app.moves.places(of: "ses_trip", from: nil) == now, "and kept for its menu")
        // Asked to move again meanwhile, it says why rather than nothing.
        let again = Moves.Place(key: Self.lab, name: "lab", kind: "machine", ok: true)
        await #expect(throws: Moves.Failure.self) { try await app.moves.move("chat", "ses_trip", from: nil, to: again) }
        try over("mov_out2")
        try await until { !app.moves.isMoving("ses_trip") }
        // Over: what its menu was told before isn't shown as now (it may live elsewhere now).
        #expect(app.moves.places(of: "ses_trip", from: nil) == nil)
    }
}
