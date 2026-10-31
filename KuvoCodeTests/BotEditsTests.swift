import ClientDesign
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What you change of a machine's bot while that machine is away waits for it, as it always has:
/// the bot shows as you left it, waiting for that computer; a later change goes on top of what
/// waited; once the machine is back, it goes to its box once, and what the box then says is what
/// shows (a change made there meanwhile included). The machine's box is the real one (`kuvo-link.js
/// serve`), reached over HTTP where a Mac reaches it over SSH; its engine is a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BotEditsTests {
    let engine = StubEngine(port: 47_985)
    let app = AppModel()

    init() {
        TestEnvironment.prepare()
        for key in ["botEditOutbox"] { UserDefaults.standard.removeObject(forKey: key) }
        try? FileManager.default.removeItem(at: Bots.file)
        app.bots.app = app
        engine.on("PATCH", "/api/session/*", json: ["data": [:]])
        engine.on("PUT", "/api/experimental/session/*", json: [:])
        engine.on("POST", "/api/session/*", json: [:])
    }

    private func done(_ machine: MachineTestBox) {
        machine.stop()
        StubWeb.stopListening(port: 47_985)
        engine.stop()
        UserDefaults.standard.removeObject(forKey: "botEditOutbox")
        try? FileManager.default.removeItem(at: Bots.file)
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

    @Test func aChangeWhileItsMachineIsAwayWaitsGoesOnceWhenItsBackAndItsBoxWins() async throws {
        let machine = try await lab()
        defer { done(machine) }
        var connected = true
        app.bots.boxes = { box in box == "lab" ? machine.client : BoxClient(box: box, transport: LocalBox { _ in AsyncThrowingStream { $0.finish() } }) }
        app.bots.reachable = { $0 == "lab" && connected }
        await app.bots.refresh("lab")
        let ada = try #require(app.bots.bot("bot_ada000001"))
        #expect(ada.machine == "lab" && ada.name == "Ada")

        // Away: what you change waits, and shows as you left it.
        connected = false
        var renamed = ada
        renamed.name = "Ada Lovelace"
        try await app.bots.update(renamed)
        #expect(app.bots.bot(ada.id)?.name == "Ada Lovelace")
        #expect(app.bots.waitingFor(try #require(app.bots.bot(ada.id))) == "lab")
        #expect(try await there(machine)?.name == "Ada", "nothing reached its box")
        // A later change goes on top of what waited.
        var recolored = try #require(app.bots.bot(ada.id))
        recolored.look = BotLook(color: .sky, shape: .gem, face: .wink)
        recolored.job = "Keeps CI and the docs green"
        recolored.instructions = "Watch main and the docs site."
        try await app.bots.update(recolored, job: true)
        #expect(app.bots.bot(ada.id)?.name == "Ada Lovelace" && app.bots.bot(ada.id)?.look.color == .sky)
        #expect(app.bots.bot(ada.id)?.job == "Keeps CI and the docs green")
        // Kept across launches.
        #expect(BotEdits().waiting[ada.id]?.fields.keys.sorted() == ["job", "look", "name"])
        // Meanwhile, a phone gives her a personality there.
        _ = try await machine.client.send("PATCH", "kuvo/bots/bot_ada000001", body: Data(#"{"personality": "preset.straight"}"#.utf8))

        // Back: it goes once, and what its box says is what shows.
        connected = true
        await app.bots.refresh("lab")
        let now = try #require(app.bots.bot(ada.id))
        #expect(app.bots.waitingFor(now) == nil)
        #expect(app.bots.edits.waiting.isEmpty)
        #expect(now.name == "Ada Lovelace" && now.look == BotLook(color: .sky, shape: .gem, face: .wink))
        #expect(now.job == "Keeps CI and the docs green" && now.instructions == "Watch main and the docs site.")
        #expect(now.personality == "preset.straight", "what changed there meanwhile stays")
        let atBox = try #require(try await there(machine))
        #expect(atBox.name == "Ada Lovelace" && atBox.job == "Keeps CI and the docs green")
        #expect(engine.requests("PATCH", "/api/session/ses_ada").filter { $0.body["title"] as? String == "Ada Lovelace" }.count == 1, "once")
        // Again: nothing waits, nothing goes.
        await app.bots.refresh("lab")
        #expect(engine.requests("PATCH", "/api/session/ses_ada").filter { $0.body["title"] as? String == "Ada Lovelace" }.count == 1)
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

    /// One its box won't take when it's back (a name that's only spaces, say) is let go, and the box's
    /// bot shows as it is.
    @Test func oneItsBoxTurnsDownIsLetGo() async throws {
        let machine = try await lab()
        defer { done(machine) }
        var connected = true
        app.bots.boxes = { box in box == "lab" ? machine.client : BoxClient(box: box, transport: LocalBox { _ in AsyncThrowingStream { $0.finish() } }) }
        app.bots.reachable = { $0 == "lab" && connected }
        await app.bots.refresh("lab")
        connected = false
        var blank = try #require(app.bots.bot("bot_ada000001"))
        blank.name = "   "
        try await app.bots.update(blank)
        connected = true
        await app.bots.refresh("lab")
        #expect(app.bots.edits.waiting.isEmpty)
        #expect(app.bots.bot("bot_ada000001")?.name == "Ada")
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
