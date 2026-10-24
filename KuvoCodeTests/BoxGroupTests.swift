import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Group chats on your computers, as the window shows them: this Mac's and a machine's alike, each
/// as its computer's bridge last said, following what it says as they go; what you do in one goes
/// where it lives. One whose bots all live on a machine moves there, and back; one whose bots live
/// on different computers stays where it is, and a bot in a machine's chat stays with it. A move
/// cut short is taken back. Both bridges are stubbed, holding their chats as the runner does
/// (`Agents/src/groups`); RealBridgeGroupTests runs the real one.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BoxGroupTests {
    let mac = StubEngine(port: 47986)
    let macBridge = StubEngine(port: 47950, alongside: true)
    let machineBridge = StubEngine(port: 47985, alongside: true)
    let here = Held()
    let there = Held()
    var botsFile: URL { AppInfo.supportDirectory.appending(path: "bots.json") }

    init() {
        Self.clean()
    }

    private static func clean() {
        for name in ["bots.json", "groups.json", "groups", "group-chats.json", "group-chats", "machine-groups.json", "machine-groups"] {
            try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: name))
        }
        try? FileManager.default.removeItem(at: AppInfo.testTrash)
        UserDefaults.standard.removeObject(forKey: "movesUnderWay")
    }

    /// The chats on a computer, as its runner keeps them, from any thread.
    nonisolated final class Held: @unchecked Sendable {
        private let lock = NSLock()
        private var chats: [String: (group: [String: Any], status: String, messages: [[String: Any]])] = [:]
        private var asked: [String] = []
        var actions: [String] { lock.withLock { asked } }

        func add(_ group: [String: Any], status: String = "active", messages: [[String: Any]] = []) {
            lock.withLock { chats[group["id"] as! String] = (group, status, messages) }
        }

        func has(_ id: String) -> Bool { lock.withLock { chats[id] != nil } }
        func status(_ id: String) -> String? { lock.withLock { chats[id]?.status } }
        func messages(_ id: String) -> [[String: Any]] { lock.withLock { chats[id]?.messages ?? [] } }

        func answer(_ request: StubEngine.Request) -> StubWeb.Answer {
            defer { TestPulse.beat() }
            return lock.withLock {
                let parts = request.path.split(separator: "/").map(String.init).dropFirst(3)
                let id = parts.first
                let action = parts.dropFirst().first
                asked.append("\(request.method) \(([id, action].compactMap { $0 }).joined(separator: "/"))")
                let read = { (id: String) -> [String: Any] in
                    let chat = self.chats[id]!
                    return ["group": chat.group, "status": chat.status, "state": ["discussing": false, "paused": false], "messages": chat.messages]
                }
                switch (request.method, id, action) {
                case ("GET", nil, _):
                    return StubWeb.json(["version": 1, "data": chats.keys.sorted().map { key in
                        ["group": chats[key]!.group, "status": chats[key]!.status, "state": ["discussing": false, "paused": false], "last": chats[key]!.messages.last as Any]
                    }])
                case ("PUT", "settings", _):
                    return StubWeb.json([:])
                case ("GET", let id?, nil):
                    return chats[id] == nil ? StubWeb.json(["message": "No such chat."], status: 404) : StubWeb.json(["data": read(id)])
                case ("PUT", let id?, nil):
                    if chats[id] != nil { return StubWeb.json(["message": "That chat is here already."], status: 409) }
                    chats[id] = (request.body["group"] as? [String: Any] ?? [:], request.body["status"] as? String ?? "held", request.body["messages"] as? [[String: Any]] ?? [])
                    return StubWeb.json(["data": read(id)])
                case ("PATCH", let id?, nil):
                    guard var chat = chats[id] else { return StubWeb.json(["message": "No such chat."], status: 404) }
                    if let members = request.body["members"] { chat.group["members"] = members }
                    if let name = request.body["name"] { chat.group["name"] = name }
                    chats[id] = chat
                    return StubWeb.json(["data": read(id)])
                case ("DELETE", let id?, nil):
                    guard let chat = chats[id] else { return StubWeb.json(["message": "No such chat."], status: 404) }
                    if chat.status == "held" { return StubWeb.json(["message": "That chat is moving."], status: 409) }
                    chats[id] = nil
                    return StubWeb.json([:])
                case ("POST", let id?, "activate"):
                    chats[id]?.status = "active"
                    return StubWeb.json(["data": read(id)])
                case ("POST", let id?, "hold"):
                    chats[id]?.status = "held"
                    return StubWeb.json(["data": ["group": chats[id]!.group, "messages": chats[id]!.messages]])
                case ("POST", let id?, "release"):
                    guard chats[id] != nil else { return StubWeb.json(["message": "No such chat."], status: 404) }
                    chats[id] = nil
                    return StubWeb.json([:])
                case ("POST", let id?, "send"):
                    if chats[id]?.status == "held" { return StubWeb.json(["message": "That chat is moving."], status: 409) }
                    let message: [String: Any] = ["id": "gm_sent", "text": request.body["text"] as? String ?? "", "time": "2026-10-22T09:00:00Z", "kind": "message"]
                    chats[id]?.messages.append(message)
                    return StubWeb.json(["data": message])
                default:
                    return StubWeb.json([:])
                }
            }
        }
    }

    private func app(machine: String = "box") -> AppModel {
        let app = AppModel()
        app.bots.app = app
        app.wakeUps.app = app
        app.boxGroups.app = app
        app.moves.app = app
        app.workspace.api = mac.api
        let macAPI = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: macBridge.url)!, password: "test"))
        let machineAPI = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: machineBridge.url)!, password: "test"), folderPrefix: RemoteFolder.prefix(for: machine))
        app.boxGroups.bridge = { $0 == nil ? macAPI : $0 == machine ? machineAPI : nil }
        for (bridge, held) in [(macBridge, here), (machineBridge, there)] {
            bridge.on("GET", "/api/kuvo/groups") { held.answer($0) }
            for method in ["GET", "PUT", "PATCH", "DELETE", "POST"] { bridge.on(method, "/api/kuvo/groups/*") { held.answer($0) } }
        }
        mac.on("PATCH", "/api/session/*", json: [:])
        return app
    }

    private func saveBots(_ bots: [(String, String, String?)]) throws {
        try FileManager.default.createDirectory(at: botsFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: bots.map { id, name, machine in
            var bot: [String: Any] = ["id": id, "name": name, "job": "Helps", "instructions": "Helps.", "jobInMemory": true,
                                      "look": ["color": "mint", "shape": "round", "face": "calm"],
                                      "folder": machine == nil ? AppInfo.testRoot.appending(path: id).path : "/home/me/.kuvo-code/bots/\(id)",
                                      "sessionID": "ses_" + id, "created": "2026-10-21T09:00:00Z"]
            if let machine { bot["machine"] = machine }
            return bot
        }).write(to: botsFile)
    }

    private static func group(_ id: String, members: [String], seats: [String: String] = [:]) -> [String: Any] {
        ["id": id, "name": "Crew", "members": members, "seats": seats, "heard": [:], "created": "2026-10-21T09:00:00Z"]
    }

    private static let said: [String: Any] = ["id": "gm_1", "author": "bot_pal", "text": "Morning.", "time": "2026-10-22T08:00:00Z", "kind": "message"]

    @Test func eachComputersChatsShowAndFollowWhatItSays() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box"), ("bot_ada", "Ada", nil), ("bot_ben", "Ben", nil)])
        here.add(Self.group("grp_mac0000001", members: ["bot_ada", "bot_ben"]))
        there.add(Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"], seats: ["bot_pal": "ses_seatP"]), messages: [Self.said])
        let app = app()

        await app.boxGroups.connected(nil)
        await app.boxGroups.connected("box")

        #expect(Set(app.chats.list.map(\.id)) == ["grp_mac0000001", "grp_box0000001"])
        #expect(app.chats.machine(of: "grp_box0000001") == "box" && app.chats.machine(of: "grp_mac0000001") == nil)
        #expect(app.chats.messages(in: "grp_box0000001").map(\.text) == ["Morning."])
        #expect(app.chats.isUnread(app.chats.group("grp_box0000001")!), "a bot's message you haven't seen")
        #expect(app.workspace.seats.contains("ses_seatP"), "its seats stay out of the lists")
        // What each says as it goes: a bot talking, a new message.
        let group = Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"], seats: ["bot_pal": "ses_seatP"])
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["speaking": "bot_lb", "discussing": true, "paused": false]]), machine: "box")
        #expect(app.chats.speaking["grp_box0000001"] == "bot_lb" && app.chats.discussing.contains("grp_box0000001"))
        app.boxGroups.handle(try macBridge.event("kuvo.group.message", ["id": "grp_mac0000001", "message":
            ["id": "gm_2", "author": "bot_ada", "text": "Build is green.", "time": "2026-10-22T08:01:00Z", "kind": "message"]]), machine: nil)
        #expect(app.chats.messages(in: "grp_mac0000001").map(\.text) == ["Build is green."])
        // A message from one computer isn't taken for another's chat.
        app.boxGroups.handle(try machineBridge.event("kuvo.group.message", ["id": "grp_mac0000001", "message":
            ["id": "gm_3", "author": "bot_pal", "text": "Not here.", "time": "2026-10-22T08:02:00Z", "kind": "message"]]), machine: "box")
        #expect(app.chats.messages(in: "grp_mac0000001").count == 1)
        // Seen last, for while a computer is away or this Mac's bridge starts.
        let lastSeen = BoxGroups()
        #expect(Set(lastSeen.chats.map(\.group.id)) == ["grp_mac0000001", "grp_box0000001"] && lastSeen.messages(in: "grp_box0000001").count == 1)
        #expect(lastSeen.discussing.isEmpty, "nothing talks until its computer says so")
        // What you write goes where it lives.
        try await app.boxGroups.send("Go ahead", to: "grp_box0000001")
        try await app.boxGroups.send("Hello here", to: "grp_mac0000001")
        #expect(there.actions.contains("POST grp_box0000001/send") && here.actions.contains("POST grp_mac0000001/send"))
        #expect(!there.actions.contains("POST grp_mac0000001/send"))
        // Gone there: gone here.
        app.boxGroups.handle(try machineBridge.event("kuvo.group.deleted", ["id": "grp_box0000001"]), machine: "box")
        #expect(app.chats.list.map(\.id) == ["grp_mac0000001"])
    }

    /// This Mac's bridge starting, then stopped: its chats show as last seen, and what you write
    /// waits in the composer; once it's up, it goes.
    @Test func thisMacsChatsWaitForItsBridge() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_ada", "Ada", nil), ("bot_ben", "Ben", nil)])
        here.add(Self.group("grp_mac0000001", members: ["bot_ada", "bot_ben"]), messages: [Self.said])
        let app = app()
        let up = app.boxGroups.bridge
        await app.boxGroups.connected(nil)
        app.boxGroups.bridge = { $0 == nil ? nil : up?($0) }
        var failure: String?
        app.boxGroups.stoppedBecause = { failure }

        #expect(app.chats.reach("grp_mac0000001") == .starting)
        #expect(app.chats.messages(in: "grp_mac0000001").map(\.text) == ["Morning."], "as last seen")
        #expect(!app.chats.send("Anyone?", to: "grp_mac0000001"), "it waits in the composer")
        failure = "It stopped unexpectedly (exit code 1)."
        #expect(app.chats.reach("grp_mac0000001") == .stopped("It stopped unexpectedly (exit code 1)."))
        #expect(!app.chats.send("Anyone?", to: "grp_mac0000001"))
        #expect(!here.actions.contains("POST grp_mac0000001/send"))

        app.boxGroups.bridge = up
        #expect(app.chats.reach("grp_mac0000001") == .ready)
        #expect(app.chats.send("Anyone?", to: "grp_mac0000001"))
        try await until { here.actions.contains("POST grp_mac0000001/send") }
    }

    /// What this Mac's bridge lets go of goes to the Finder's Trash; nothing outside its own
    /// trash folder is touched, whatever an event says.
    @Test func whatThisMacsBridgeLetsGoOfGoesToTheTrash() async throws {
        defer { Self.clean(); mac.stop(); try? FileManager.default.removeItem(at: BoxGroups.macTrash) }
        let app = app()
        let folder = BoxGroups.macTrash.appending(path: "20261024T100000-group-grp_gone000001")
        try FileManager.default.createDirectory(at: folder.appending(path: "grp_gone000001"), withIntermediateDirectories: true)
        let elsewhere = AppInfo.testRoot.appending(path: "Keep-\(UUID().uuidString.prefix(6))")
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: elsewhere) }

        app.boxGroups.handle(try macBridge.event("kuvo.group.trashed", ["id": "grp_gone000001", "path": folder.path]), machine: nil)
        app.boxGroups.handle(try macBridge.event("kuvo.group.trashed", ["id": "grp_x", "path": elsewhere.path]), machine: nil)
        app.boxGroups.handle(try machineBridge.event("kuvo.group.trashed", ["id": "grp_y", "path": folder.path]), machine: "box")

        #expect(!FileManager.default.fileExists(atPath: folder.path))
        #expect(FileManager.default.fileExists(atPath: elsewhere.path), "not one outside its trash")
        #expect(FileManager.default.fileExists(atPath: AppInfo.testTrash.path))
    }

    /// Looked at here: told there once, not again each time the machine says it back (in whole
    /// seconds, as it keeps times).
    @Test func aLookIsToldOnce() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        there.add(Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"]), messages: [Self.said])
        let app = app()
        await app.boxGroups.connected("box")
        let told = { there.actions.filter { $0 == "PATCH grp_box0000001" }.count }
        app.chats.markViewed("grp_box0000001")
        try await until { told() > 0 }
        let seen = try #require(app.chats.group("grp_box0000001")?.viewed)
        var group = Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"])
        group["viewed"] = ISO8601DateFormatter().string(from: seen)
        app.boxGroups.handle(try machineBridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                                 "state": ["discussing": false, "paused": false]]), machine: "box")
        // A message after it, and back: the look isn't told again.
        await app.boxGroups.reload("grp_box0000001")
        #expect(told() == 1, "not told again")
        #expect(app.chats.group("grp_box0000001")?.viewed == seen)
    }

    @Test func aChatWhoseBotsLiveOnAMachineMovesThereAndBack() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        let id = "grp_k000000001"
        here.add(Self.group(id, members: ["bot_pal", "bot_lb"]), messages: [Self.said])
        let app = app()
        await app.boxGroups.connected(nil)
        await app.boxGroups.connected("box")

        try await app.moves.move(group: id, to: "box")

        // Held here, brought there and started; let go here (its bridge puts it in the trash).
        #expect(here.actions.filter { $0.hasPrefix("POST grp") } == ["POST \(id)/hold", "POST \(id)/release"])
        #expect(there.actions.filter { $0.hasPrefix("PUT grp") || $0.hasPrefix("POST grp") } == ["PUT \(id)", "POST \(id)/activate"])
        #expect(there.status(id) == "active" && !here.has(id))
        #expect(app.chats.machine(of: id) == "box" && app.chats.list.filter { $0.id == id }.count == 1)
        #expect(app.chats.messages(in: id).map(\.text) == ["Morning."])
        #expect(UserDefaults.standard.data(forKey: "movesUnderWay") == nil)

        // A bot in it stays with it.
        do {
            try await app.moves.move(bot: "bot_pal", to: nil)
            Issue.record("it moved")
        } catch {
            #expect(error.localizedDescription.contains("Move the chat to this Mac first"), "\(error.localizedDescription)")
        }

        // And back.
        try await app.moves.move(group: id, to: nil)
        #expect(there.actions.filter { $0.hasPrefix("POST") }.suffix(2) == ["POST \(id)/hold", "POST \(id)/release"])
        #expect(!there.has(id) && here.status(id) == "active")
        #expect(app.chats.machine(of: id) == nil && app.chats.messages(in: id).map(\.text) == ["Morning."])
    }

    /// While it moves, what you write waits: it's held where it is.
    @Test func whatYouWriteWaitsWhileItMoves() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        let id = "grp_k000000002"
        here.add(Self.group(id, members: ["bot_pal", "bot_lb"]))
        let app = app()
        await app.boxGroups.connected(nil)
        await app.boxGroups.connected("box")
        let waypoint = Waypoint()
        machineBridge.on("PUT", "/api/kuvo/groups/\(id)") { _ in
            waypoint.block()
            return StubWeb.json(["message": "Disk full"], status: 500)
        }
        let move = Task { try await app.moves.move(group: id, to: "box") }
        await waypoint.arrived()
        #expect(!app.chats.send("Wait for it", to: id), "it waits in the composer")
        waypoint.open()
        await #expect(throws: (any Error).self) { try await move.value }
        // Taken back: it carries on here.
        #expect(here.status(id) == "active" && app.chats.send("Now", to: id))
    }

    @Test func aChatWhoseBotsLiveOnDifferentComputersStaysWhereItIs() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_scout", "Scout", nil)])
        here.add(Self.group("grp_mix0000001", members: ["bot_pal", "bot_scout"]))
        let app = app()
        await app.boxGroups.connected(nil)
        await app.boxGroups.connected("box")
        do {
            try await app.moves.move(group: "grp_mix0000001", to: "box")
            Issue.record("it moved")
        } catch {
            #expect(error.localizedDescription.contains("live on different computers"), "\(error.localizedDescription)")
        }
        #expect(here.status("grp_mix0000001") == "active" && there.actions.allSatisfy { !$0.hasPrefix("PUT grp") })
    }

    /// The app quit as a chat went to the machine, before it was let go here: taken back, so it
    /// carries on here, and what got there goes.
    @Test func aChatsMoveCutShortIsTakenBack() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        let id = "grp_k000000003"
        here.add(Self.group(id, members: ["bot_pal", "bot_lb"]), status: "held")
        there.add(Self.group(id, members: ["bot_pal", "bot_lb"]), status: "held")
        let record: [String: Any] = ["kind": "group", "id": id, "sessions": [String](), "to": "box", "wasPaused": true, "stage": "copying"]
        UserDefaults.standard.set(try JSONSerialization.data(withJSONObject: [record]), forKey: "movesUnderWay")
        let app = app()
        await app.boxGroups.connected(nil)

        await app.moves.recover()

        #expect(!there.has(id))
        #expect(here.status(id) == "active")
        #expect(UserDefaults.standard.data(forKey: "movesUnderWay") == nil)
        #expect(app.chats.list.filter { $0.id == id }.count == 1 && app.chats.machine(of: id) == nil)
        #expect(!app.chats.discussing.contains(id))
    }

    /// A move taken back that couldn't let go of its copy there: the one started here is the chat
    /// (listed once, read and written here), and the copy goes once the machine's there again.
    @Test func aCopyLeftOnAMachineIsntTheChatAndGoes() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        let id = "grp_k000000004"
        here.add(Self.group(id, members: ["bot_pal", "bot_lb"]), messages: [Self.said])
        there.add(Self.group(id, members: ["bot_pal", "bot_lb"]), status: "held")
        let app = app()
        await app.boxGroups.connected(nil)
        await app.boxGroups.connected("box")
        #expect(app.chats.list.filter { $0.id == id }.count == 1)
        #expect(app.chats.machine(of: id) == nil && app.chats.messages(in: id).map(\.text) == ["Morning."])
        #expect(there.actions.contains("POST \(id)/release") && !there.has(id))
    }

    @Test func aRemovedMachinesChatsGoFromHere() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        there.add(Self.group("grp_box0000003", members: ["bot_pal", "bot_lb"]), messages: [Self.said])
        let app = app()
        await app.boxGroups.connected("box")
        #expect(app.chats.group("grp_box0000003") != nil)
        app.boxGroups.forget(machine: "box")
        #expect(app.chats.group("grp_box0000003") == nil)
        #expect(BoxGroups().chats.isEmpty, "nor kept for later")
    }

    @Test func aDeletedBotLeavesItsChatsWhereverTheyLive() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box"), ("bot_x", "X", "box")])
        there.add(Self.group("grp_box0000002", members: ["bot_pal", "bot_lb", "bot_x"]))
        here.add(Self.group("grp_mac0000002", members: ["bot_pal", "bot_lb", "bot_x"]))
        let app = app()
        await app.boxGroups.connected(nil)
        await app.boxGroups.connected("box")
        await app.boxGroups.remove(try #require(app.bots.bot("bot_x")))
        #expect(app.chats.group("grp_box0000002")?.members == ["bot_pal", "bot_lb"])
        #expect(app.chats.group("grp_mac0000002")?.members == ["bot_pal", "bot_lb"])
    }
}
