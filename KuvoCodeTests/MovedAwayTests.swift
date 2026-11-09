import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A bot on Claude Code moved from this Mac to your machine with Kuvo Code open (#305, the user's
/// move of 2026-11-08): its conversation lives on the machine's agents bridge from then on, under
/// the same session ID. Its row here is the machine's alone, the sidebar shows it there, a message
/// written in its open conversation goes there, and an event from the machine about it is read
/// there; its model is the one it ran on, shown as that machine names it. Before, a row of this
/// Mac's from before the move stayed first: messages went to this Mac's bridge, which had deleted
/// the conversation ("No session"), and the bot opened on this Mac's page. This Mac's bridge's
/// deletion of its copy is tried both ways: dropped while this Mac's box still says the move is
/// finishing, and heard before this Mac's box has said anything.
/// Both engines, both agents bridges and both boxes' answers are stand-ins; SSH answers nothing.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct MovedAwayTests {
    let app = AppModel()
    let mac = StubEngine(port: 47921)
    let macBridge = StubEngine(port: 47922, alongside: true)
    let mini = StubEngine(port: 47923, alongside: true)
    let miniBridge = StubEngine(port: 47924, alongside: true)
    let machine = "mini-\(UUID().uuidString.prefix(8).lowercased()).invalid"
    let miniKey = String(repeating: "N", count: 43)
    let id = "ses_foreman"
    let bot = "bot_foreman01"
    let kept = "/home/me/\(RemoteEngineInstaller.root)"
    /// What each box says, as the test moves it along.
    let said = Said()

    init() {
        app.standIn(engine: mac.api)
        app.workspace.api = mac.api
        app.agents.connect(macBridge.api.client.endpoint, folderPrefix: "")
        app.workspace.agents = app.agents
        app.catalog.outsideAgents = app.agents
        SSHConnection.standIn = { _, _ in nil }
        let api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: mini.url)!, password: "test"), folderPrefix: RemoteFolder.prefix(for: machine))
        MachineEngine.standIn = { [machine] in $0.id == machine ? api : nil }
        mini.on("GET", "/api/mcp", json: ["location": ["directory": "/"], "data": []])
        mini.on("GET", "/api/credential", json: ["data": []])
        mac.list([])
        mini.list([])
        // Claude Code's models as each bridge lists them: its `default` stands for Opus here, and
        // for Sonnet on the machine (another plan's account).
        for (bridge, stands) in [(macBridge, "opus"), (miniBridge, "sonnet")] {
            bridge.on("GET", "/api/model", json: ["data": [Self.claudeModel("opus", "Opus 5.5", default: stands == "opus"), Self.claudeModel("sonnet", "Sonnet 5.5", default: stands == "sonnet")]])
            bridge.on("GET", "/api/integration", json: ["data": [["id": "claude-code", "name": "Claude Code", "methods": [], "connections": []]]])
            bridge.on("POST", "/api/session/\(id)/prompt", json: [:])
        }
    }

    private func done() {
        app.agents.disconnect()
        for machine in app.machines.list { app.removeMachine(machine.id) }
        SSHConnection.standIn = nil
        MachineEngine.standIn = nil
        Drafts.shared.remove(id)
        try? FileManager.default.removeItem(at: Bots.file)
        mac.stop()
    }

    /// A Claude Code model as its agents bridge lists it.
    private static func claudeModel(_ id: String, _ name: String, default stands: Bool) -> [String: Any] {
        ["id": id, "modelID": id, "providerID": "claude-code", "name": name, "capabilities": ["tools": true, "input": ["text", "image"], "output": ["text"]],
         "variants": [], "time": ["released": 1], "cost": [["input": 0, "output": 0]], "status": "active", "enabled": true, "limit": ["context": 200_000, "output": 32_000],
         "aliases": stands ? ["default"] : []]
    }

    /// Foreman's conversation as a box's agents bridge lists it, in `directory`, on `model`.
    private func conversation(in directory: String, model: String) -> [String: Any] {
        StubEngine.session(id, title: "Kuvo Foreman", directory: directory, extra: [
            "metadata": ["kuvoAgent": "claude", "kuvo": ["bot": bot]], "model": ["id": model, "providerID": "claude-code", "variant": "high"],
        ])
    }

    /// Each box's answers: its bots, and its moves.
    private func boxes() -> (String) -> BoxClient {
        { [said, machine, bot, id, kept] box in
            BoxClient(box: box, transport: LocalBox { request in
                AsyncThrowingStream { reply in
                    let onMachine = box == machine
                    let body: String? = switch request.path {
                    case "kuvo/bots":
                        said.botOn == onMachine ? #"{"bots":[{"id":"\#(bot)","session":"\#(id)","name":"Kuvo Foreman","look":{"color":"sky","shape":"round","face":"calm"},"folder":"\#(onMachine ? kept + "/bots/" + bot : "/kuvo-tests-none/" + bot)"}]}"# : #"{"bots":[]}"#
                    case "kuvo/moves": onMachine ? said.machineMoves : said.macMoves
                    default: nil
                    }
                    reply.yield(.head(status: body == nil ? 503 : 200, headers: ["content-type": "application/json"]))
                    reply.yield(.body(Data((body ?? #"{"message":"Not now."}"#).utf8)))
                    reply.finish()
                }
            })
        }
    }

    private func move(_ role: String, stage: String) -> String {
        #"{"moves":[{"id":"mov_foreman1","kind":"bot","thing":"\#(bot)","from":"mac-key","to":"\#(miniKey)","role":"\#(role)","stage":"\#(stage)","sessions":["\#(id)"],"place":"mini"}],"away":["\#(id)"]}"#
    }

    /// This Mac with Foreman on it, its conversation open in a tab, and the machine connected.
    private func start(open: Bool = true) async throws -> MachineEngine {
        app.moves.app = app
        app.bots.app = app
        app.phoneLink.standIn(machine: machine, key: miniKey)
        let boxes = boxes()
        app.bots.boxes = boxes
        app.moves.boxes = boxes
        app.bots.reachable = { _ in true }
        macBridge.list([conversation(in: "/kuvo-tests-none/\(bot)/workspace", model: "default")])
        macBridge.on("DELETE", "/api/session/\(id)", json: [:])
        await app.workspace.refresh()
        await app.workspace.refreshAgents()
        await app.catalog.refreshAgents()
        let engine = app.machines.add(machine)
        app.workspace.machines = Set(app.machines.list.map(\.id))
        await app.connect(engine).value
        engine.agents.connect(miniBridge.api.client.endpoint, folderPrefix: RemoteFolder.prefix(for: machine))
        await engine.catalog.refreshAgents()
        await app.bots.refresh(BoxClient.mac)
        await app.bots.refresh(machine)
        await app.moves.reloadAll()
        #expect(app.bots.bot(bot)?.machine == nil)
        if open {
            app.tabs.open(.session(id))
            _ = try #require(app.workspace.model(for: id))
        }
        #expect(shown == "Opus 5.5", "before it moves, as this Mac's Claude Code names its default")
        #expect(open ? sidebarShows == .mac : true)
        return engine
    }

    /// Its conversation's rows here (one per box that listed it).
    private var rows: [Session] { app.workspace.sessions.filter { $0.id == id } }

    /// The model its composer shows: as the catalog of the computer its row is on names it.
    private var shown: String? {
        let row = app.workspace.session(id)
        let catalog = app.catalog(for: SidebarBox(directory: row?.location.directory ?? ""))
        return catalog.model(row?.model)?.name
    }

    /// The page the sidebar slides to as its tab comes into view (`SidebarView`).
    private var sidebarShows: SidebarBox? { app.tabs.box(of: .session(id)) }

    /// After the move: one row, the machine's; the sidebar there; a message written in its open
    /// conversation goes to the machine's bridge alone; an event from the machine is read there.
    private func expectItLivesOnTheMachine(_ engine: MachineEngine) async throws {
        do {
            try await until { rows.count == 1 && rows.first.map { RemoteFolder.machine(of: $0.location.directory) } == machine }
        } catch {
            Issue.record("its rows: \(rows.map(\.location.directory))")
            throw error
        }
        #expect(sidebarShows == .machine(machine))
        #expect(app.bots.bot(bot)?.machine == machine)
        #expect(shown == "Opus 5.5", "the model it ran on, as the machine names it (not its default there, Sonnet)")

        // (Held until both computers' lists are read, as the move ends: a message meanwhile stays in the composer.)
        try await until { !app.moves.held.contains(id) && !app.moves.held.contains(bot) }
        let open = try #require(app.workspace.model(for: id))
        open.send("Hey, I moved you. All good?", for: nil)
        do {
            try await until { !miniBridge.requests("POST", "/api/session/\(id)/prompt").isEmpty }
        } catch {
            Issue.record("the machine's bridge was asked \(miniBridge.asked.filter { $0.hasPrefix("POST") }), this Mac's \(macBridge.asked.filter { $0.hasPrefix("POST") }), engines \(mini.asked.filter { $0.hasPrefix("POST") }) \(mac.asked.filter { $0.hasPrefix("POST") }); \(String(describing: open.failure))")
            throw error
        }
        #expect(macBridge.requests("POST", "/api/session/\(id)/prompt").isEmpty, "nothing goes to the box it left: \(macBridge.asked)")

        // Full Access switched on there, say: read there, not here.
        let readHere = macBridge.requests("GET", "/api/session/\(id)").count
        let readThere = miniBridge.requests("GET", "/api/session/\(id)").count
        app.workspace.handleAgents(try miniBridge.event("session.metadata.updated", session: id), machine: machine)
        await app.workspace.reloading[id]?.value
        #expect(miniBridge.requests("GET", "/api/session/\(id)").count > readThere)
        #expect(macBridge.requests("GET", "/api/session/\(id)").count == readHere)
        #expect(rows.count == 1)
    }

    /// The order the user's move had: this Mac's box says the move is finishing (and the machine,
    /// read a moment before, that its copy isn't switched to yet) as this Mac's bridge deletes its
    /// copy, which is dropped; then this Mac's box says it moved away, and the machine lists it.
    @Test func aCodingAgentsBotMovedAwayWithTheAppOpenLivesOnTheMachine() async throws {
        defer { done() }
        let engine = try await start()

        said.machineMoves = move("to", stage: "copying")
        said.macMoves = move("from", stage: "finishing")
        await app.moves.reload(machine)
        await app.moves.reload(BoxClient.mac)
        #expect(app.workspace.isAway(id, from: nil) && app.workspace.isAway(id, from: machine), "away from both, as each box says")
        // This Mac's bridge lets its copy go.
        macBridge.list([])
        app.workspace.handleAgents(try macBridge.event("session.deleted", session: id), machine: nil)

        // There: the machine has it, on the model it ran on here.
        miniBridge.list([conversation(in: kept + "/bots/\(bot)/workspace", model: "opus")])
        miniBridge.on("GET", "/api/session/\(id)", json: ["data": conversation(in: kept + "/bots/\(bot)/workspace", model: "opus")])
        said.botOn = true
        said.machineMoves = #"{"moves":[],"away":[]}"#
        said.macMoves = #"{"moves":[],"away":[],"moved":[{"session":"\#(id)","key":"\#(miniKey)","at":1794200000000}]}"#
        await app.moves.reload(BoxClient.mac)
        await app.moves.reload(machine)
        try await expectItLivesOnTheMachine(engine)
    }

    /// The other order: the machine read first (its row beside this Mac's), and this Mac's bridge's
    /// deletion heard before this Mac's box has said anything of the move. Only this Mac's row goes.
    @Test func itsOldBoxsDeletionHeardFirstTakesOnlyThatBoxsRow() async throws {
        defer { done() }
        // Not open: nothing follows it there on its own.
        let engine = try await start(open: false)

        miniBridge.list([conversation(in: kept + "/bots/\(bot)/workspace", model: "opus")])
        miniBridge.on("GET", "/api/session/\(id)", json: ["data": conversation(in: kept + "/bots/\(bot)/workspace", model: "opus")])
        said.botOn = true
        await app.workspace.refresh(engine)
        #expect(rows.count == 2, "this Mac's, from before, and the machine's")
        macBridge.list([])
        app.workspace.handleAgents(try macBridge.event("session.deleted", session: id), machine: nil)
        #expect(rows.map { RemoteFolder.machine(of: $0.location.directory) } == [machine], "the machine's stays")

        await app.bots.refresh(BoxClient.mac)
        await app.bots.refresh(machine)
        app.tabs.open(.session(id))
        try await expectItLivesOnTheMachine(engine)
    }

    /// Kuvo Code opened again after the move, its list of this Mac's conversations as it kept it
    /// from before (with this Mac's row of the bot): this Mac's box says it moved away, and that row
    /// goes before this Mac's agents bridge has even answered, and isn't kept again.
    @Test func aRowKeptFromBeforeTheMoveDoesntComeBackAtLaunch() async throws {
        defer { done() }
        let engine = try await start()
        miniBridge.list([conversation(in: kept + "/bots/\(bot)/workspace", model: "opus")])
        said.botOn = true
        said.macMoves = #"{"moves":[],"away":[],"moved":[{"session":"\#(id)","key":"\#(miniKey)","at":1794200000000}]}"#
        // This Mac's bridge not answering (starting), as at launch.
        macBridge.on("GET", "/api/session", json: [:], status: 503)
        await app.moves.reload(BoxClient.mac)
        #expect(rows.isEmpty || rows.allSatisfy { RemoteFolder.machine(of: $0.location.directory) == machine })
        await app.workspace.refresh()
        #expect(!SessionCopies.localSessions().contains { $0.id == id }, "this Mac's list as kept for the next launch leaves it out")
        await app.workspace.refresh(engine)
        try await until { rows.count == 1 }
        #expect(sidebarShows == .machine(machine))
    }
}

/// What the stand-in boxes say, from any thread.
nonisolated final class Said: @unchecked Sendable {
    private let lock = NSLock()
    private var bot = false
    private var mac = #"{"moves":[],"away":[]}"#
    private var machine = #"{"moves":[],"away":[]}"#
    /// Foreman is on the machine.
    var botOn: Bool {
        get { lock.withLock { bot } }
        set { lock.withLock { bot = newValue } }
    }
    var macMoves: String {
        get { lock.withLock { mac } }
        set { lock.withLock { mac = newValue } }
    }
    var machineMoves: String {
        get { lock.withLock { machine } }
        set { lock.withLock { machine = newValue } }
    }
}
