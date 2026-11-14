import ClientDesign
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What you change of a machine's bot while that machine is away goes to this Mac's box, which holds
/// it for that machine (PROTOCOL.md, `kuvo/bots`, "Held for another computer"): the bot shows as you
/// left it, waiting for that computer, a later change on top, and nothing waits in the app. What an
/// earlier version kept here is handed to the box once. The boxes are the real ones (`kuvo-link.js
/// serve`), a machine's reached over HTTP where a Mac reaches it over SSH; the engine is a stand-in.
/// (Handing it on to the machine once it's back is the box's: `bots-held.test.js`.)
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BotEditsTests {
    let engine = StubEngine(port: 47_985)
    let app = AppModel()

    init() {
        TestEnvironment.prepare()
        UserDefaults.standard.removeObject(forKey: Bots.oldOutboxKey)
        try? FileManager.default.removeItem(at: Bots.file)
        app.bots.app = app
        engine.on("PATCH", "/api/session/*", json: ["data": [:]])
        engine.on("PUT", "/api/experimental/session/*", json: [:])
        engine.on("POST", "/api/session/*", json: [:])
    }

    private func done(_ machine: MachineTestBox, _ box: MachineTestBox? = nil) {
        machine.stop()
        box?.stop()
        StubWeb.stopListening(port: 47_985)
        engine.stop()
        UserDefaults.standard.removeObject(forKey: Bots.oldOutboxKey)
        try? FileManager.default.removeItem(at: Bots.file)
    }

    /// The box that holds what's changed for lab, in this Mac's box's place: the real box, which knows
    /// lab as one of your computers (its key, its address on the relay, its id on this Mac) and has its
    /// keys. (This Mac's own box has its keys only from the app's Keychain, in memory; its sealing with
    /// them is the bridge's `bots-held-mac.test.js`.)
    private func ownBox() async throws -> MachineTestBox {
        let box = try await MachineTestBox(name: "holder")
        let random = { Data((0..<32).map { _ in UInt8.random(in: 0...255) }).base64URL }
        let mac = String(repeating: "M", count: 43)
        let link: [String: Any] = [
            "secret": random(), "key": random(), "relay": "wss://relay.invalid", "name": "holder", "mac": mac, "macs": [mac], "phones": [],
            "legacy": [mac: ["at": 1, "peers": [["key": String(repeating: "L", count: 43), "address": String(repeating: "a", count: 22), "kind": "machine", "name": "lab", "id": "lab"]]]],
        ]
        try FileManager.default.createDirectory(at: box.folder.appending(path: "run"), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: link).write(to: box.folder.appending(path: "run/link.json"), options: .atomic)
        return box
    }

    /// Ada, a bot on the machine, as its folder there has her; and what its box makes and tells
    /// bots with, as this Mac gives it; its engine, the stand-in.
    private func lab() async throws -> MachineTestBox {
        let machine = try await MachineTestBox(name: "lab")
        let folder = machine.folder.appending(path: "bots/bot_ada000001")
        try FileManager.default.createDirectory(at: folder.appending(path: "wakes"), withIntermediateDirectories: true)
        try Data(#"{"kuvo": 1, "id": "bot_ada000001", "name": "Ada", "job": "Keeps CI green", "look": {"color": "mint", "shape": "round", "face": "calm"}, "created": "2026-10-01T09:00:00Z", "updated": "2026-10-01T09:00:00Z"}"#.utf8)
            .write(to: folder.appending(path: "bot.json"))
        try Data("ses_ada".utf8).write(to: folder.appending(path: "session"))
        try Data("# Ada's memory\n".utf8).write(to: folder.appending(path: "MEMORY.md"))
        try JSONEncoder().encode(app.bots.kit(for: "lab")).write(to: machine.folder.appending(path: "bots/kit.json"))
        try await StubWeb.listen(port: 47_985)
        try FileManager.default.createDirectory(at: machine.folder.appending(path: "run"), withIntermediateDirectories: true)
        try Data(#"{"port": 47985, "password": "test"}"#.utf8).write(to: machine.folder.appending(path: "run/engine.json"))
        return machine
    }

    /// What the machine's box has of her now, as a phone would read it.
    private func there(_ machine: MachineTestBox) async throws -> ListedBot? {
        struct Listed: Decodable { var bots: [ListedBot] }
        return try await machine.client.value(Listed.self, "GET", "kuvo/bots").bots.first
    }

    /// What this Mac's box holds, as any client reads it.
    private func held(_ box: MachineTestBox) async throws -> [HeldBotEdit] {
        struct Listed: Decodable { var held: [HeldBotEdit]? }
        return try await box.client.value(Listed.self, "GET", "kuvo/bots").held ?? []
    }

    @Test func aChangeWhileItsMachineIsAwayIsHeldByThisMacsBoxAndShowsAsYouLeftIt() async throws {
        let machine = try await lab()
        let box = try await ownBox()
        defer { done(machine, box) }
        var connected = true
        let own = box.client
        app.bots.boxes = { name in name == "lab" ? machine.client : own }
        app.bots.reachable = { $0 == "lab" && connected }
        await app.bots.refresh("lab")
        let ada = try #require(app.bots.bot("bot_ada000001"))
        #expect(ada.machine == "lab" && ada.name == "Ada")

        // Away: what you change goes to this Mac's box, which holds it; it shows as you left it.
        connected = false
        var renamed = ada
        renamed.name = "Ada Lovelace"
        try await app.bots.update(renamed)
        #expect(app.bots.bot(ada.id)?.name == "Ada Lovelace")
        #expect(app.bots.waitingFor(try #require(app.bots.bot(ada.id))) == "lab")
        #expect(try await there(machine)?.name == "Ada", "nothing reached its box")
        // A later change goes on top of what's held.
        var recolored = try #require(app.bots.bot(ada.id))
        recolored.look = BotLook(color: .sky, shape: .gem, face: .wink)
        recolored.job = "Keeps CI and the docs green"
        recolored.instructions = "Watch main and the docs site."
        try await app.bots.update(recolored, job: true)
        #expect(app.bots.bot(ada.id)?.name == "Ada Lovelace" && app.bots.bot(ada.id)?.look.color == .sky)
        #expect(app.bots.bot(ada.id)?.job == "Keeps CI and the docs green")
        let kept = try #require(try await held(box).first)
        #expect(kept.bot == ada.id && kept.computer == "lab")
        #expect(kept.change?.keys.sorted() == ["job", "look", "name"], "one edit, each field the last given")
        #expect(UserDefaults.standard.data(forKey: Bots.oldOutboxKey) == nil, "nothing kept in the app")

        // A new launch: what it shows comes from this Mac's box.
        let later = AppModel()
        later.bots.app = later
        later.bots.boxes = app.bots.boxes
        later.bots.reachable = { _ in false }
        await later.bots.refresh(BoxClient.mac)
        #expect(later.bots.bot(ada.id)?.name == "Ada Lovelace")
        #expect(later.bots.waitingFor(try #require(later.bots.bot(ada.id))) == "lab")

        // Back, with what's held still on its way: a change now goes straight to the machine, whose
        // box keeps it over the older one held (it takes only what was given after).
        connected = true
        var again = try #require(app.bots.bot(ada.id))
        again.name = "Ada L."
        try await app.bots.update(again)
        #expect(try await there(machine)?.name == "Ada L.")
        #expect(try await held(box).first?.change?["name"]?.string == "Ada Lovelace", "nothing more held")
    }

    /// What an earlier version kept here for machines that were away (with a delete for a bot whose
    /// machine you removed) is handed to this Mac's box once, at launch, which holds each for its
    /// machine; then nothing's kept in the app.
    @Test func whatAnEarlierVersionKeptForAMachineThatWasAwayGoesToThisMacsBoxOnce() async throws {
        let machine = try await lab()
        let box = try await ownBox()
        defer { done(machine, box) }
        let outbox: [String: Bots.OldEdit] = [
            "bot_ada000001": Bots.OldEdit(box: "lab", fields: ["name": .string("Ada Lovelace")]),
            "bot_gone00001": Bots.OldEdit(box: "attic", delete: true),
        ]
        UserDefaults.standard.set(try JSONEncoder().encode(outbox), forKey: Bots.oldOutboxKey)
        let own = box.client
        await app.bots.handOverOldEdits(to: own)
        #expect(UserDefaults.standard.data(forKey: Bots.oldOutboxKey) == nil)
        let kept = try await held(box)
        #expect(kept.first { $0.bot == "bot_ada000001" }?.change?["name"]?.string == "Ada Lovelace")
        #expect(kept.first { $0.bot == "bot_ada000001" }?.computer == "lab")
        #expect(kept.first { $0.bot == "bot_gone00001" }?.delete == true)
        #expect(kept.first { $0.bot == "bot_gone00001" }?.computer == "attic", "a machine you removed: held until you add it again")
        // Once only.
        await app.bots.handOverOldEdits(to: own)
        #expect(try await held(box).count == 2)
    }

    /// One this Mac's box can't keep now (it isn't answering, or doesn't know where the bot is yet)
    /// stays in the app until it can: never lost.
    @Test func anEarlierVersionsEditStaysUntilThisMacsBoxTakesIt() async throws {
        let outbox = ["bot_ada000001": Bots.OldEdit(box: "lab", fields: ["name": .string("Ada Lovelace")])]
        UserDefaults.standard.set(try JSONEncoder().encode(outbox), forKey: Bots.oldOutboxKey)
        defer { UserDefaults.standard.removeObject(forKey: Bots.oldOutboxKey) }
        let down = BoxClient(box: BoxClient.mac, transport: LocalBox { _ in AsyncThrowingStream { $0.finish(throwing: URLError(.cannotConnectToHost)) } })
        await app.bots.handOverOldEdits(to: down)
        #expect(Bots.oldOutbox() == outbox)
        let unsure = BoxClient(box: BoxClient.mac, transport: LocalBox { _ in
            AsyncThrowingStream { continuation in
                continuation.yield(.head(status: 404, headers: ["content-type": "application/json"]))
                continuation.yield(.body(Data(#"{"message": "That bot isn’t there any more."}"#.utf8)))
                continuation.finish()
            }
        })
        await app.bots.handOverOldEdits(to: unsure)
        #expect(Bots.oldOutbox() == outbox)
    }

    /// Its bots read again (a run of one ended there), slowly, while you rename one: the list, read
    /// from before, doesn't put the old name back.
    @Test func aChangeMadeWhileItsBotsAreReadStays() async throws {
        let machine = try await lab()
        defer { done(machine) }
        app.bots.reachable = { $0 == "lab" }
        app.bots.boxes = { _ in machine.client }
        await app.bots.refresh("lab")
        let ada = try #require(app.bots.bot("bot_ada000001"))

        let before = try await machine.client.send("GET", "kuvo/bots").body
        let reading = Gate(), release = Gate()
        let endpoint = machine.endpoint
        let base = endpoint.url.absoluteString.hasSuffix("/") ? endpoint.url : URL(string: endpoint.url.absoluteString + "/")!
        app.bots.boxes = { box in
            BoxClient(box: box, transport: LocalBox { request in
                guard request.method == "GET", request.path == "kuvo/bots" else {
                    return EngineRoutes.forward(request, to: base, password: endpoint.password, allowing: { path, _ in path.hasPrefix("kuvo/") })
                }
                return AsyncThrowingStream { continuation in
                    Thread.detachNewThread {
                        reading.open()
                        release.wait()
                        continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                        continuation.yield(.body(before))
                        continuation.finish()
                    }
                }
            })
        }
        let read = Task { await app.bots.refresh("lab") }
        try await until { reading.isOpen }
        var renamed = ada
        renamed.name = "Ada Lovelace"
        try await app.bots.update(renamed)
        #expect(app.bots.bot(ada.id)?.name == "Ada Lovelace")
        release.open()
        await read.value
        #expect(app.bots.bot(ada.id)?.name == "Ada Lovelace")
    }

    /// A machine's bots followed while it's connected: one a phone changes or makes there shows here
    /// as it happens, not only once the Mac connects to it again.
    @Test func whatAPhoneDoesToAMachinesBotsShowsWhileItsConnected() async throws {
        let machine = try await lab()
        defer { done(machine) }
        app.bots.boxes = { box in box == "lab" ? machine.client : BoxClient(box: box, transport: LocalBox { _ in AsyncThrowingStream { $0.finish() } }) }
        app.bots.reachable = { $0 == "lab" }
        app.bots.machineFollowPause = .zero
        let following = Task { await app.bots.follow("lab") }
        defer { following.cancel() }
        try await until { app.bots.bot("bot_ada000001") != nil }

        // A phone renames her there.
        _ = try await machine.client.send("PATCH", "kuvo/bots/bot_ada000001", body: Data(#"{"name": "Ada Lovelace"}"#.utf8))
        try await until { app.bots.bot("bot_ada000001")?.name == "Ada Lovelace" }
        #expect(app.bots.bot("bot_ada000001")?.machine == "lab")
    }

    /// The bot keeps its job as you talk to it, Edit Bot open or not: while you haven't touched
    /// the job's fields they show its newest; once you've typed, yours stay, the bot's newer one shows
    /// beside them, and Save keeps yours, unless you take its own.
    @Test func aJobTheBotChangesWhileEditBotIsOpenNeverOverwritesWhatYouTyped() {
        var draft = JobDraft(line: "Keeps CI green", details: "Watch main.")
        draft.botKept(.init(line: "Keeps CI and docs green", details: "Watch main and the docs."))
        #expect(draft.line == "Keeps CI and docs green" && draft.keptMeanwhile == nil, "untouched: the bot's newest")

        draft.details = "Watch main, the docs, and the nightly build."
        draft.botKept(.init(line: "Keeps everything green", details: "Watch it all."))
        #expect(draft.details == "Watch main, the docs, and the nightly build.", "what you typed stays")
        #expect(draft.line == "Keeps CI and docs green")
        #expect(draft.keptMeanwhile == .init(line: "Keeps everything green", details: "Watch it all."), "its newer one, shown beside yours")
        // The bot comes round to what you typed: nothing to choose between.
        draft.botKept(.init(line: "Keeps CI and docs green", details: "Watch main, the docs, and the nightly build."))
        #expect(draft.keptMeanwhile == nil)

        draft.line = "Keeps the lights on"
        draft.botKept(.init(line: "Keeps the servers up", details: "Page me at night."))
        draft.useKept()
        #expect(draft.line == "Keeps the servers up" && draft.details == "Page me at night." && draft.keptMeanwhile == nil, "its own, in place of yours")
    }
}
