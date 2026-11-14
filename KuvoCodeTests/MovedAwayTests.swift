import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A bot on Claude Code moved between this Mac and your machine with Kuvo Code open (#305, the
/// user's move of 2026-11-08): its conversation lives on the other computer's agents bridge from
/// then on, under the same session ID. Its row here is that computer's alone, the sidebar shows it
/// there, a message written in its open conversation goes there, and an event from there about it
/// is read there; its model is the one it ran on, shown as that computer names it. Its tab stays
/// open all through the move. Before, a row of the computer it left stayed first: messages went to
/// that computer's bridge, which had deleted the conversation ("No session"), and the bot opened on
/// that computer's page, until Kuvo Code was opened again. The old bridge's deletion of its copy is
/// tried both ways (dropped as the move finishes; heard while this Mac's box still says the copy is
/// on its way), and so are an event from where it went before that computer's list is read again,
/// and Kuvo Code opened again with the list it kept from before the move.
/// Both engines, both agents bridges and both boxes' answers are stand-ins; SSH answers nothing.
/// A message goes through its computer's box (`kuvo/sessions/<id>/send`, #668 item 3), which hands
/// it to its own agents bridge (that part: the box's tests, message-parts.test.ts).
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct MovedAwayTests {
    let app = AppModel()
    let mac = StubEngine(port: 47861)
    let macBridge = StubEngine(port: 47862, alongside: true)
    let mini = StubEngine(port: 47863, alongside: true)
    let miniBridge = StubEngine(port: 47864, alongside: true)
    let machine = "mini-\(UUID().uuidString.prefix(8).lowercased()).invalid"
    let miniKey = String(repeating: "N", count: 43)
    /// This Mac's box's key among your computers.
    var macKey: String { app.phoneLink.macKey ?? String(repeating: "C", count: 43) }
    let id = "ses_foreman"
    let bot = "bot_foreman01"
    let kept = "/home/me/\(RemoteEngineInstaller.root)"
    /// What each box says, as the test moves it along.
    let said = Said()
    /// Moments the list had no row of the conversation, as the window followed it.
    let gaps = Gaps()

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
        }
    }

    private func done() {
        gaps.stopped = true
        app.agents.disconnect()
        for machine in app.machines.list { app.removeMachine(machine.id) }
        SSHConnection.standIn = nil
        MachineEngine.standIn = nil
        Drafts.shared.remove(id)
        try? FileManager.default.removeItem(at: Bots.file)
        // (This Mac's list as kept for the next launch: nothing of this test's for the next suite,
        // nor written by a save still waiting.)
        // A list read still on its way finds nothing of it either.
        macBridge.list([])
        miniBridge.list([])
        app.workspace.drop(id)
        // Nor does a read this app still has queued (a move's) reach the next test's stand-ins,
        // which answer at the same addresses, and keep what they say.
        app.workspace.api = nil
        app.moves.boxes = { _ in BoxClient(box: "gone", transport: LocalBox { _ in AsyncThrowingStream { $0.finish(throwing: CancellationError()) } }) }
        SessionCopies.saveLocalSessions([])
        mac.stop()
    }

    /// As the window follows the list (`MainView`'s `onChange`): each time it changes, closed tabs
    /// go, and a moment its conversation has no row at all is counted.
    private func watchList() { Self.watch(app, gaps, id) }

    private static func watch(_ app: AppModel, _ gaps: Gaps, _ id: String) {
        guard !gaps.stopped else { return }
        withObservationTracking { _ = app.workspace.sessions } onChange: { [weak app] in
            Task { @MainActor in
                guard let app, !gaps.stopped else { return }
                if !app.workspace.sessions.contains(where: { $0.id == id }) { gaps.count += 1 }
                app.tabs.dropClosed()
                watch(app, gaps, id)
            }
        }
    }

    /// A Claude Code model as its agents bridge lists it.
    private static func claudeModel(_ id: String, _ name: String, default stands: Bool) -> [String: Any] {
        ["id": id, "modelID": id, "providerID": "claude-code", "name": name, "capabilities": ["tools": true, "input": ["text", "image"], "output": ["text"]],
         "variants": [], "time": ["released": 1], "cost": [["input": 0, "output": 0]], "status": "active", "enabled": true, "limit": ["context": 200_000, "output": 32_000],
         "aliases": stands ? ["default"] : []]
    }

    /// Foreman's conversation as a computer's agents bridge lists it (nil: this Mac's), on `model`.
    private func conversation(on place: String?, model: String) -> [String: Any] {
        let directory = place == nil ? "/kuvo-tests-none/\(bot)/workspace" : kept + "/bots/\(bot)/workspace"
        return StubEngine.session(id, title: "Kuvo Foreman", directory: directory, extra: [
            "metadata": ["kuvoAgent": "claude", "kuvo": ["bot": bot]], "model": ["id": model, "providerID": "claude-code", "variant": "high"],
        ])
    }

    /// Foreman listed on that computer's bridge (nil: this Mac's) alone, as it is when it lives there.
    private func lives(on place: String?, model: String) {
        let bridge = place == nil ? macBridge : miniBridge
        (place == nil ? miniBridge : macBridge).list([])
        bridge.list([conversation(on: place, model: model)])
        bridge.on("GET", "/api/session/\(id)", json: ["data": conversation(on: place, model: model)])
    }

    /// Each box's answers: its bots, and its moves.
    private func boxes() -> (String) -> BoxClient {
        { [said, machine, bot, id, kept] box in
            BoxClient(box: box, transport: LocalBox { request in
                AsyncThrowingStream { reply in
                    let onMachine = box == machine
                    let body: String? = switch request.path {
                    case "kuvo/bots":
                        said.botOn == onMachine ? #"{"bots":[{"id":"\#(bot)","session":"\#(id)","name":"Kuvo Foreman","look":{"color":"sky","shape":"round","face":"calm"},"agents":true,"folder":"\#(onMachine ? kept + "/bots/" + bot : "/kuvo-tests-none/" + bot)"}]}"# : #"{"bots":[]}"#
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

    /// Each computer's box as a conversation's composer reaches it (`Workspace.boxes`): a message to
    /// Foreman's conversation (`kuvo/sessions/<id>/send`) is taken there, and noted as sent to that
    /// computer; anything else goes as the app sends it (here, nowhere: neither box is running).
    private func sendingBoxes() {
        let reach = app.workspace.boxes
        app.workspace.boxes = { [said, id] box in
            guard let through = reach?(box) else { return nil }
            return BoxClient(box: box, transport: LocalBox { request in
                AsyncThrowingStream { reply in
                    guard request.method == "POST", request.path == "kuvo/sessions/\(id)/send" else {
                        let task = Task { @MainActor in
                            do {
                                for try await part in through.transport.send(request) { reply.yield(part) }
                                reply.finish()
                            } catch {
                                reply.finish(throwing: error)
                            }
                        }
                        reply.onTermination = { _ in task.cancel() }
                        return
                    }
                    said.sent(to: box)
                    reply.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                    reply.yield(.body(Data("{}".utf8)))
                    reply.finish()
                }
            })
        }
    }

    /// Foreman's move as a box says it: `role` on that box, at `stage`, and away from there when
    /// it doesn't live there (a copy not switched to, an original switched away from).
    private func move(_ role: String, stage: String, toMac: Bool = false) -> String {
        let (from, to) = toMac ? (miniKey, macKey) : (macKey, miniKey)
        let switched = stage == "switching" || stage == "finishing"
        let away = (role == "to") != switched ? #"["\#(id)"]"# : "[]"
        return #"{"moves":[{"id":"mov_foreman1","kind":"bot","thing":"\#(bot)","from":"\#(from)","to":"\#(to)","role":"\#(role)","stage":"\#(stage)","sessions":["\#(id)"],"place":"mini"}],"away":\#(away)}"#
    }

    /// A box that moved Foreman away (to `key`) lately, and has nothing under way.
    private func movedAway(to key: String) -> String {
        #"{"moves":[],"away":[],"moved":[{"session":"\#(id)","key":"\#(key)","at":1794200000000}]}"#
    }

    private let nothing = #"{"moves":[],"away":[]}"#

    /// Foreman on this Mac (nil) or the machine, its conversation open in a tab, the machine connected.
    private func start(on place: String? = nil, open: Bool = true) async throws -> MachineEngine {
        app.moves.app = app
        app.bots.app = app
        app.phoneLink.standIn(machine: machine, key: miniKey)
        let boxes = boxes()
        app.bots.boxes = boxes
        app.moves.boxes = boxes
        sendingBoxes()
        app.bots.reachable = { _ in true }
        said.botOn = place != nil
        lives(on: place, model: "default")
        macBridge.on("DELETE", "/api/session/\(id)", json: [:])
        await app.workspace.refresh()
        await app.workspace.refreshAgents()
        await app.catalog.refreshAgents()
        let engine = app.machines.add(machine)
        app.workspace.machines = Set(app.machines.list.map(\.id))
        await app.connect(engine).value
        engine.agents.connect(miniBridge.api.client.endpoint, folderPrefix: RemoteFolder.prefix(for: machine))
        await engine.catalog.refreshAgents()
        _ = await app.workspace.refresh(engine)
        await app.bots.refresh(BoxClient.mac)
        await app.bots.refresh(machine)
        await app.moves.reloadAll()
        #expect(app.bots.bot(bot)?.machine == place)
        #expect(rows.count == 1)
        if open {
            app.tabs.open(.session(id))
            _ = try #require(app.workspace.model(for: id))
            #expect(sidebarShows == SidebarBox(machine: place))
        }
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

    /// Its tab, as the window keeps it once the list changed (`MainView` drops closed tabs then).
    private var tabIsOpen: Bool {
        app.tabs.dropClosed()
        return app.tabs.keys.contains(.session(id))
    }

    /// After the move: one row, that computer's (nil: this Mac's); the sidebar there; its tab still
    /// open; a message written in its open conversation goes to that computer's box alone; an
    /// event from there is read there.
    private func expectItLives(on place: String?) async throws {
        let (there, left) = place == nil ? (macBridge, miniBridge) : (miniBridge, macBridge)
        let (thereBox, leftBox) = place == nil ? (BoxClient.thisMac, machine) : (machine, BoxClient.thisMac)
        do {
            try await until { rows.count == 1 && rows.first.map { RemoteFolder.machine(of: $0.location.directory) } == place }
        } catch {
            Issue.record("its rows: \(rows.map(\.location.directory))")
            throw error
        }
        #expect(sidebarShows == SidebarBox(machine: place))
        #expect(tabIsOpen)

        // (Held until both computers' lists are read, as the move ends: a message meanwhile stays in the composer.)
        try await until { !app.moves.held.contains(id) && !app.moves.held.contains(bot) }
        let open = try #require(app.workspace.model(for: id))
        open.send("Hey, I moved you. All good?", for: nil)
        do {
            try await until { said.sends.contains(thereBox) }
        } catch {
            Issue.record("sent through \(said.sends), it lives on \(thereBox); \(String(describing: open.failure))")
            throw error
        }
        #expect(!said.sends.contains(leftBox), "nothing goes to the computer it left")
        // (Its box hands it to the agents bridge there: the app never goes to either bridge itself.)
        #expect(there.requests("POST", "/api/session/\(id)/prompt").isEmpty && left.requests("POST", "/api/session/\(id)/prompt").isEmpty)

        // Full Access switched on there, say: read there, not where it was.
        let readLeft = left.requests("GET", "/api/session/\(id)").count
        let readThere = there.requests("GET", "/api/session/\(id)").count
        app.workspace.handleAgents(try there.event("session.metadata.updated", session: id), machine: place)
        await app.workspace.reloading[id]?.value
        #expect(there.requests("GET", "/api/session/\(id)").count > readThere)
        #expect(left.requests("GET", "/api/session/\(id)").count == readLeft)
        #expect(rows.count == 1)
    }

    /// The order the user's move had: this Mac's box says the move is switching, then finishing
    /// (the machine, read a moment before, that its copy isn't switched to yet), as this Mac's
    /// bridge deletes its copy, which is dropped; then this Mac's box says it moved away, and the
    /// machine lists it. Its tab stays open all along.
    @Test func aCodingAgentsBotMovedAwayWithTheAppOpenLivesOnTheMachine() async throws {
        defer { done() }
        let engine = try await start()
        #expect(shown == "Opus 5.5", "before it moves, as this Mac's Claude Code names its default")
        let open = app.workspace.model(for: id)
        watchList()

        said.machineMoves = move("to", stage: "copying")
        said.macMoves = move("from", stage: "copying")
        await app.moves.reload(machine)
        await app.moves.reload(BoxClient.mac)
        // This Mac's bridge lets its copy go, heard before its box's word that it switched.
        macBridge.list([])
        app.workspace.handleAgents(try macBridge.event("session.deleted", session: id), machine: nil)
        #expect(tabIsOpen && rows.count == 1, "its only row stays while it moves")
        said.macMoves = move("from", stage: "switching")
        await app.moves.reload(BoxClient.mac)
        #expect(app.workspace.isAway(id, from: nil) && app.workspace.isAway(id, from: machine), "away from both, as each box says")
        // This Mac's agents bridge read again meanwhile (it reconnected, say).
        await app.workspace.refreshAgents()
        await app.workspace.refresh()
        #expect(tabIsOpen && rows.count == 1, "listed nowhere else yet: its row and tab stay")
        said.macMoves = move("from", stage: "finishing")
        await app.moves.reload(BoxClient.mac)
        // The machine's copy read while its last word still says it isn't its own yet: left out,
        // one row, this Mac's.
        lives(on: machine, model: "opus")
        _ = await app.workspace.refresh(engine)
        #expect(rows.map { RemoteFolder.machine(of: $0.location.directory) } == [nil], "one row, never two")

        // There: the machine has it, on the model it ran on here.
        lives(on: machine, model: "opus")
        said.botOn = true
        said.machineMoves = nothing
        said.macMoves = movedAway(to: miniKey)
        await app.moves.reload(BoxClient.mac)
        await app.moves.reload(machine)
        try await expectItLives(on: machine)
        #expect(app.bots.bot(bot)?.machine == machine)
        #expect(shown == "Opus 5.5", "the model it ran on, as the machine names it (not its default there, Sonnet)")
        #expect(app.workspace.model(for: id) === open, "the conversation open all along, not opened again")
        #expect(gaps.count == 0, "never without a row (its tab would close)")
        _ = engine
    }

    /// The race the other way: the machine switched and was read (its row beside this Mac's), while
    /// this Mac's box was last heard saying its copy was on its way, and this Mac's bridge's deletion
    /// comes before its box says more. Only this Mac's row goes; then, this Mac's bot list read
    /// before the machine's, the machine's row still stays.
    @Test func itsOldBoxsDeletionHeardEarlyTakesOnlyThatBoxsRow() async throws {
        defer { done() }
        // (Not open: an open one would follow the machine's row as soon as it's listed.)
        let engine = try await start(open: false)
        said.macMoves = move("from", stage: "copying")
        await app.moves.reload(BoxClient.mac)
        #expect(Moves.isFrozen(id))

        lives(on: machine, model: "opus")
        _ = await app.workspace.refresh(engine)
        #expect(rows.count == 2, "this Mac's, from before, and the machine's")
        app.workspace.handleAgents(try macBridge.event("session.deleted", session: id), machine: nil)
        #expect(rows.map { RemoteFolder.machine(of: $0.location.directory) } == [machine], "the machine's stays")

        said.botOn = true
        said.macMoves = movedAway(to: miniKey)
        await app.moves.reload(BoxClient.mac)
        await app.bots.refresh(BoxClient.mac)
        await app.bots.refresh(machine)
        app.tabs.open(.session(id))
        try await expectItLives(on: machine)
    }

    /// The move heard of only as over (this Mac's box says it moved away, as when Kuvo Code opens
    /// again), and an event from the machine about it comes before the machine's list is read
    /// again: it's read on the machine, and lives there from then on.
    @Test func anEventFromWhereItWentFindsItThere() async throws {
        defer { done() }
        _ = try await start()
        lives(on: machine, model: "opus")
        said.botOn = true
        said.macMoves = movedAway(to: miniKey)
        await app.moves.reload(BoxClient.mac)
        #expect(rows.count == 1 && tabIsOpen, "its only row stays until it's listed where it went")
        app.workspace.handleAgents(try miniBridge.event("session.metadata.updated", session: id), machine: machine)
        await app.workspace.reloading[id]?.value
        await app.bots.refresh(machine)
        try await expectItLives(on: machine)
    }

    /// Kuvo Code opened again after the move with the lists it kept before it (this Mac's with the
    /// bot's row in it): this Mac's box says it moved away, and only the machine's row is left, the
    /// sidebar there, before this Mac's agents bridge has even answered; this Mac's list kept for
    /// the next launch leaves it out.
    @Test func aRowKeptFromBeforeTheMoveDoesntComeBackAtLaunch() async throws {
        defer { done() }
        let engine = try await start()
        let here = try #require(app.workspace.session(id))
        lives(on: machine, model: "opus")
        said.botOn = true
        said.macMoves = movedAway(to: miniKey)
        await app.moves.reload(BoxClient.mac)
        await app.moves.reload(machine)
        // (Read as it connects.)
        _ = await app.workspace.refresh(engine)
        try await until { rows.first.map { RemoteFolder.machine(of: $0.location.directory) } == machine }
        let there = try #require(app.workspace.session(id))
        await app.workspace.refresh()
        await SessionCopies.written()
        #expect(!SessionCopies.localSessions().contains { $0.id == id }, "this Mac's list as kept for the next launch leaves it out")

        // As the version before this kept them.
        SessionCopies.saveLocalSessions([here])
        SessionCopies.saveSessions([there], of: machine)
        await SessionCopies.written()
        let relaunched = AppModel()
        relaunched.moves.app = relaunched
        relaunched.bots.app = relaunched
        relaunched.moves.boxes = boxes()
        relaunched.bots.boxes = boxes()
        relaunched.phoneLink.standIn(machine: machine, key: miniKey)
        #expect(relaunched.workspace.session(id).map { RemoteFolder.machine(of: $0.location.directory) } == .some(nil), "this Mac's row from before, first")
        relaunched.workspace.machines = [machine]
        await relaunched.moves.reload(BoxClient.mac)
        #expect(relaunched.workspace.sessions.filter { $0.id == id }.map { RemoteFolder.machine(of: $0.location.directory) } == [machine])
        relaunched.tabs.open(.session(id))
        #expect(relaunched.tabs.box(of: .session(id)) == .machine(machine))
    }

    /// The way back: on the machine with its conversation open, moved to this Mac. Once the machine
    /// says it moved away, it lives here.
    @Test func movedBackToThisMacItLivesHere() async throws {
        defer { done() }
        let engine = try await start(on: machine)
        let open = app.workspace.model(for: id)
        watchList()
        said.macMoves = move("to", stage: "copying", toMac: true)
        said.machineMoves = move("from", stage: "copying", toMac: true)
        await app.moves.reload(BoxClient.mac)
        await app.moves.reload(machine)
        // The machine lets its copy go, heard before its box's word that it switched (its moves
        // are read every few seconds).
        miniBridge.list([])
        app.workspace.handleAgents(try miniBridge.event("session.deleted", session: id), machine: machine)
        #expect(tabIsOpen && rows.count == 1, "its only row stays while it moves")
        said.machineMoves = move("from", stage: "finishing", toMac: true)
        await app.moves.reload(machine)
        // The machine read again meanwhile (it reconnected, say).
        _ = await app.workspace.refresh(engine)
        #expect(tabIsOpen && rows.count == 1)

        lives(on: nil, model: "opus")
        said.botOn = false
        said.macMoves = nothing
        said.machineMoves = movedAway(to: macKey)
        await app.moves.reload(machine)
        await app.moves.reload(BoxClient.mac)
        // (This Mac's box tells its bots as they change: `Bots.follow`.)
        await app.bots.refresh(BoxClient.mac)
        try await expectItLives(on: nil)
        #expect(app.bots.bot(bot)?.machine == nil)
        #expect(app.workspace.model(for: id) === open, "the conversation open all along")
        #expect(gaps.count == 0, "never without a row (its tab would close)")
    }
}

/// Moments the list had no row of the conversation.
@MainActor final class Gaps {
    var count = 0
    /// The test is over: nothing more is followed.
    var stopped = false
}

/// What the stand-in boxes say, from any thread.
nonisolated final class Said: @unchecked Sendable {
    private let lock = NSLock()
    private var bot = false
    private var mac = #"{"moves":[],"away":[]}"#
    private var machine = #"{"moves":[],"away":[]}"#
    private var through: [String] = []
    /// The boxes a message to Foreman went through, in order.
    var sends: [String] { lock.withLock { through } }
    func sent(to box: String) { lock.withLock { through.append(box) } }
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
