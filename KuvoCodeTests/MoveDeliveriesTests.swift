import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What's sent to a bot while it moves to another computer: nothing reaches it on the way, and
/// each wake-up, agent's letter and reply from a notification that came meanwhile arrives exactly
/// once, where it lives once the move is over: where it went, or where it was if the move failed.
/// A letter or a reply waits for that; a wake-up's file goes along with its folder (the machine's
/// own kuvo-wake sends it there). The machine is a folder of the test's own and a second engine,
/// stubbed; the move is held at its first step while things are sent to it.
@MainActor
@Suite(.serialized) struct MoveDeliveriesTests {
    let mac = StubEngine(port: 47906)
    let box = StubEngine(port: 47907, alongside: true)
    let machine = "box.invalid"
    /// The machine's `~/.kuvo-code`.
    let boxRoot = AppInfo.testRoot.appending(path: "deliveries-box/.kuvo-code")
    let waypoint = Waypoint()

    init() {
        Self.clean()
    }

    private static func clean() {
        for name in ["bots.json", "bots", "wakes", "groups.json", "groups"] { try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: name)) }
        try? FileManager.default.removeItem(at: AppInfo.testRoot.appending(path: "deliveries-box"))
        try? FileManager.default.removeItem(at: AppInfo.testTrash)
        try? FileManager.default.removeItem(at: AgentMail.seenFile)
        UserDefaults.standard.removeObject(forKey: "movesUnderWay")
    }

    /// The app, with this Mac's engine and the machine's; a move waits at its first step until the
    /// test lets it go.
    private func app() -> AppModel {
        let app = AppModel()
        app.bots.app = app
        app.wakeUps.app = app
        app.groups.app = app
        app.moves.app = app
        app.workspace.api = mac.api
        let boxAPI = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: box.url)!, password: "test"), folderPrefix: RemoteFolder.prefix(for: machine))
        let machine = machine
        app.workspace.machineAPI = { $0 == machine ? boxAPI : nil }
        app.moves.transport = HeldMachine(machine: FolderMachine(root: boxRoot), waypoint: waypoint)
        for engine in [mac, box] {
            engine.on("PATCH", "/api/session/*", json: [:])
            engine.on("PUT", "/api/experimental/session/*", json: [:])
            engine.on("DELETE", "/api/session/*", json: [:])
            engine.on("POST", "/api/experimental/session/import") { Self.imported($0) }
        }
        return app
    }

    nonisolated private static func imported(_ request: StubEngine.Request) -> StubWeb.Answer {
        let info = request.body["info"] as? [String: Any] ?? [:]
        let directory = (request.body["location"] as? [String: Any])?["directory"] as? String ?? ""
        return StubWeb.json(["data": StubEngine.session(info["id"] as? String ?? "", title: info["title"] as? String ?? "", directory: directory)])
    }

    /// A bot in `parent`, with a wake-up that's come due.
    private func bot(_ id: String, session: String, in parent: URL, on machine: String? = nil) throws -> URL {
        let folder = parent.appending(path: id)
        try FileManager.default.createDirectory(at: folder.appending(path: "workspace"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: folder.appending(path: "wakes"), withIntermediateDirectories: true)
        try Data("# Scout's memory\n".utf8).write(to: folder.appending(path: "MEMORY.md"))
        try Data(session.utf8).write(to: folder.appending(path: "session"))
        try Data("check the build".utf8).write(to: folder.appending(path: "wakes/" + Wakes.name(due: .now.addingTimeInterval(-60), every: nil)))
        var bot: [String: Any] = [
            "id": id, "name": "Scout", "job": "Watches the build", "instructions": "Watches the build", "jobInMemory": true,
            "look": ["color": "sky", "shape": "round", "face": "calm"], "folder": folder.path, "sessionID": session,
            "created": "2026-10-01T09:00:00Z",
        ]
        if let machine { bot["machine"] = machine }
        try JSONSerialization.data(withJSONObject: [bot]).write(to: AppInfo.supportDirectory.appending(path: "bots.json"))
        return folder
    }

    /// Its conversation, as its engine exports it and is asked about it.
    private func conversation(_ session: String, directory: String, on engine: StubEngine, bot: String) {
        var info = StubEngine.session(session, title: "Scout", directory: directory)
        info["metadata"] = ["kuvo": ["bot": bot]]
        let said = [["id": "msg_\(session)_1", "type": "user", "text": "Remember the number 42.", "time": ["created": 1]] as [String: Any]]
        engine.on("GET", "/api/experimental/session/\(session)/export", json: ["data": ["info": info, "messages": said]])
        engine.on("GET", "/api/session/\(session)/inbox", json: ["data": []])
        engine.on("POST", "/api/session/\(session)/prompt", json: [:])
    }

    /// A letter from an agent on another machine, by mail.
    private func letter(_ id: String, to session: String) -> [String: Any] {
        let at = (Date.now.timeIntervalSince1970 * 1000).rounded()
        return ["letter": ["id": id, "from": "ses_faraway", "name": "API", "to": session, "text": "The API's deployed.", "wait": false, "at": at], "at": at]
    }

    private func prompts(_ engine: StubEngine, _ session: String, saying words: String) -> Int {
        engine.requests("POST", "/api/session/\(session)/prompt").filter { ($0.body["text"] as? String)?.contains(words) == true }.count
    }

    /// A Mac bot's wake-up that comes due as the move starts, before its wake-ups are held: it
    /// isn't sent from this Mac, and goes with its folder, waiting there for the machine's own
    /// kuvo-wake.
    @Test func aWakeUpDueAsItLeavesGoesWithIt() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "bot_deliver001", session = "ses_deliver1"
        let original = try bot(id, session: session, in: Bots.root)
        let app = app()
        let workspace = original.appending(path: "workspace").path
        mac.list([StubEngine.session(session, title: "Scout", directory: workspace)])
        await app.workspace.refresh()
        conversation(session, directory: workspace, on: mac, bot: id)
        let machine = machine

        let move = Task { try await app.moves.move(bot: id, to: machine) }
        await waypoint.arrived()
        await app.wakeUps.wakeDue()
        #expect(prompts(mac, session, saying: "check the build") == 0, "nothing goes to it on the way")
        waypoint.open()
        try await move.value

        let there = boxRoot.appending(path: "bots/\(id)/wakes")
        #expect(try FileManager.default.contentsOfDirectory(atPath: there.path).count == 1, "it went along")
        #expect(!FileManager.default.fileExists(atPath: boxRoot.appending(path: "bots/\(id)/paused").path))
        await app.wakeUps.wakeDue()
        #expect(prompts(mac, session, saying: "check the build") == 0, "the machine sends it, not this Mac")
    }

    /// A machine's bot coming to this Mac: a letter and a reply sent to it on the way arrive once
    /// it's here, once, however often a letter's sender tries; the wake-up that came due meanwhile
    /// goes from here, once.
    @Test func whatCameWhileItMovedArrivesOnceWhereItWent() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "bot_deliver002", session = "ses_deliver2"
        let original = try bot(id, session: session, in: boxRoot.appending(path: "bots"), on: machine)
        let app = app()
        let before = AgentMail.shared.app
        AgentMail.shared.app = app
        defer { AgentMail.shared.app = before }
        let workspace = original.appending(path: "workspace").path
        app.workspace.add(try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject:
            StubEngine.session(session, title: "Scout", directory: RemoteFolder.folder(workspace, on: machine)))))
        conversation(session, directory: workspace, on: box, bot: id)
        conversation(session, directory: workspace, on: mac, bot: id)

        let move = Task { try await app.moves.move(bot: id, to: nil) }
        await waypoint.arrived()
        let mail = letter("ltr_deliver2", to: session)
        let sent = Task { await AgentMail.shared.mailed(mail, from: "peer.invalid") }
        let replied = Task { await app.workspace.send("Thanks, carry on.", to: session) }
        // Its sender tries again meanwhile.
        let again = Task { await AgentMail.shared.mailed(mail, from: "peer.invalid") }
        // These reach it before it goes on (the main actor takes them in turn).
        await Task.yield()
        await app.wakeUps.wakeDue()
        #expect(box.requests("POST", "/api/session/\(session)/prompt").isEmpty, "nothing goes to it on the way")
        waypoint.open()
        try await move.value
        await sent.value
        await replied.value
        await again.value
        #expect(app.bots.bot(id)?.machine == nil)
        #expect(prompts(mac, session, saying: "The API's deployed.") == 1, "it waited, and went once it could")
        #expect(prompts(mac, session, saying: "Thanks, carry on.") == 1)

        // Its sender tries again (as a machine does, until it hears it's there).
        await AgentMail.shared.mailed(mail, from: "peer.invalid")
        await app.wakeUps.wakeDue()
        await app.wakeUps.wakeDue()
        #expect(prompts(mac, session, saying: "The API's deployed.") == 1)
        #expect(prompts(mac, session, saying: "check the build") == 1)
        #expect(box.requests("POST", "/api/session/\(session)/prompt").isEmpty)
    }

    /// A move that fails: what was sent to the bot on the way arrives where it was, once, its
    /// wake-up included.
    @Test func whatCameWhileAMoveFailedArrivesOnceWhereItWas() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "bot_deliver003", session = "ses_deliver3"
        let original = try bot(id, session: session, in: Bots.root)
        let app = app()
        let before = AgentMail.shared.app
        AgentMail.shared.app = app
        defer { AgentMail.shared.app = before }
        let workspace = original.appending(path: "workspace").path
        mac.list([StubEngine.session(session, title: "Scout", directory: workspace)])
        await app.workspace.refresh()
        conversation(session, directory: workspace, on: mac, bot: id)
        box.on("POST", "/api/experimental/session/import", json: ["message": "Disk full"], status: 500)
        let machine = machine

        let move = Task { try await app.moves.move(bot: id, to: machine) }
        await waypoint.arrived()
        let mail = letter("ltr_deliver3", to: session)
        let sent = Task { await AgentMail.shared.mailed(mail, from: "peer.invalid") }
        let replied = Task { await app.workspace.send("Thanks, carry on.", to: session) }
        // Both reach it before it goes on (the main actor takes them in turn).
        await Task.yield()
        await app.wakeUps.wakeDue()
        #expect(mac.requests("POST", "/api/session/\(session)/prompt").isEmpty, "nothing goes to it on the way")
        waypoint.open()
        await #expect(throws: (any Error).self) { try await move.value }
        await sent.value
        await replied.value
        #expect(app.bots.bot(id)?.machine == nil)
        #expect(prompts(mac, session, saying: "The API's deployed.") == 1, "it waited, and went once it could")
        #expect(prompts(mac, session, saying: "Thanks, carry on.") == 1)

        await AgentMail.shared.mailed(mail, from: "peer.invalid")
        await app.wakeUps.wakeDue()
        await app.wakeUps.wakeDue()
        #expect(prompts(mac, session, saying: "The API's deployed.") == 1)
        #expect(prompts(mac, session, saying: "check the build") == 1)
        #expect(box.requests("POST", "/api/session/\(session)/prompt").isEmpty)
    }

    /// A reply from a notification that waits for the bot's move is kept until it's gone: had the
    /// app quit meanwhile, it's in the bot's composer at the next launch. Once it's gone, nothing
    /// of it is kept.
    @Test func aReplyWaitingAsTheAppQuitsIsInTheComposerNextTime() async throws {
        defer {
            Self.clean()
            mac.stop()
            Drafts.shared.remove("ses_deliver5")
            Drafts.shared.saveNow()
        }
        let id = "bot_deliver005", session = "ses_deliver5"
        let original = try bot(id, session: session, in: Bots.root)
        let app = app()
        let workspace = original.appending(path: "workspace").path
        mac.list([StubEngine.session(session, title: "Scout", directory: workspace)])
        await app.workspace.refresh()
        conversation(session, directory: workspace, on: mac, bot: id)
        box.on("POST", "/api/session/\(session)/prompt", json: [:])
        let machine = machine

        let move = Task { try await app.moves.move(bot: id, to: machine) }
        await waypoint.arrived()
        let replied = Task { await app.workspace.send("Ship it.", to: session) }
        // It reaches the move before the move goes on (the main actor takes them in turn).
        await Task.yield()
        // The app quitting now: the next launch reads what's kept.
        #expect(Drafts(defaults: .standard)[session].text == "Ship it.")

        waypoint.open()
        try await move.value
        await replied.value
        #expect(prompts(box, session, saying: "Ship it.") == 1)
        #expect(prompts(mac, session, saying: "Ship it.") == 0)
        #expect(Drafts(defaults: .standard)[session].isEmpty, "once it's gone, it isn't put back")
    }

    /// A bot whose move was cut short after it switched (the app quit), before it went over to its
    /// copy, takes nothing where it was until that's finished: its turn in a group chat is sat
    /// out, and nothing goes to an engine for it.
    @Test func aBotCutShortSitsOutItsTurnUntilItsThere() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "bot_deliver004", session = "ses_deliver4"
        let original = try bot(id, session: session, in: Bots.root)
        try Data(Moves.hold.utf8).write(to: original.appending(path: "paused"))
        let record: [String: Any] = ["kind": "bot", "id": id, "sessions": [session], "original": original.path, "to": machine,
                                     "copy": boxRoot.appending(path: "bots/\(id)").path, "wasPaused": false, "stage": "switched"]
        UserDefaults.standard.set(try JSONSerialization.data(withJSONObject: [record]), forKey: "movesUnderWay")
        let app = app()
        // The machine away: the move can't be finished yet.
        app.workspace.machineAPI = { _ in nil }
        await app.moves.recover()
        let group = app.groups.create(name: "Crew", members: [id])

        app.groups.send("Where are we?", to: group.id)
        try await eventually { app.groups.messages(in: group.id).contains { $0.kind == .note } && !app.groups.discussing.contains(group.id) }

        #expect(app.groups.messages(in: group.id).contains { $0.kind == .note && $0.text.contains("sat this out") })
        #expect(mac.asked.allSatisfy { !$0.hasPrefix("POST") }, "nothing went to an engine for it: \(mac.asked)")
        app.groups.stop(group.id)
    }
}

/// A machine whose first step waits at `waypoint`.
struct HeldMachine: MoveTransport {
    let machine: FolderMachine
    let waypoint: Waypoint

    func home(on machine: String?) async throws -> MoveHome {
        await waypoint.pass()
        return try await self.machine.home(on: machine)
    }

    func exists(_ path: String, on machine: String?) async throws -> Bool { try await self.machine.exists(path, on: machine) }
    func pack(_ path: String, on machine: String?, into archive: URL) async throws { try await self.machine.pack(path, on: machine, into: archive) }
    func unpack(_ archive: URL, into parent: String, on machine: String?) async throws { try await self.machine.unpack(archive, into: parent, on: machine) }
    func trash(_ path: String, on machine: String?) async throws { try await self.machine.trash(path, on: machine) }
    func write(_ data: Data, to path: String, on machine: String?) async throws { try await self.machine.write(data, to: path, on: machine) }
    func remove(_ path: String, on machine: String?) async throws { try await self.machine.remove(path, on: machine) }
    func unpause(_ folder: String, on machine: String?) async throws { try await self.machine.unpause(folder, on: machine) }
}

/// A point something waits at until the test lets it go, which the test hears it reach: work held
/// part way while something else happens. From any thread; once open, everything passes.
nonisolated final class Waypoint: @unchecked Sendable {
    private let condition = NSCondition()
    private var isOpen = false
    private var reached = false
    private var passing: [CheckedContinuation<Void, Never>] = []
    private var hearing: [CheckedContinuation<Void, Never>] = []

    /// Waits here (from async work) until it's open.
    func pass() async {
        await withCheckedContinuation { (going: CheckedContinuation<Void, Never>) in
            condition.lock()
            let heard = arrive()
            if isOpen { going.resume() } else { passing.append(going) }
            condition.unlock()
            heard.forEach { $0.resume() }
        }
    }

    /// Waits here (from a stub's own thread) until it's open.
    func block() {
        condition.lock()
        let heard = arrive()
        condition.unlock()
        heard.forEach { $0.resume() }
        condition.lock()
        while !isOpen { condition.wait() }
        condition.unlock()
    }

    /// Once something has reached it.
    func arrived() async {
        await withCheckedContinuation { (heard: CheckedContinuation<Void, Never>) in
            condition.lock()
            if reached { heard.resume() } else { hearing.append(heard) }
            condition.unlock()
        }
    }

    func open() {
        condition.lock()
        isOpen = true
        let going = passing
        passing = []
        condition.broadcast()
        condition.unlock()
        going.forEach { $0.resume() }
    }

    /// (Locked.) Those waiting to hear it reached.
    private func arrive() -> [CheckedContinuation<Void, Never>] {
        reached = true
        defer { hearing = [] }
        return hearing
    }
}
