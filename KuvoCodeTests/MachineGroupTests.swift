import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Group chats that live on a machine: they show beside this Mac's, as the machine last said,
/// and follow what it says as they go; what you do in one goes there. One whose bots all live on a
/// machine moves there, and back; one whose bots live on different computers stays on this Mac,
/// and a bot in a machine's chat stays with it. A move cut short is taken back. The machine's
/// bridge is stubbed, holding its chats as the runner there does (`Agents/src/groups`).
@MainActor
@Suite(.serialized) struct MachineGroupTests {
    let mac = StubEngine(port: 47986)
    let bridge = StubEngine(port: 47985, alongside: true)
    let held = Held()
    var botsFile: URL { AppInfo.supportDirectory.appending(path: "bots.json") }

    init() {
        Self.clean()
    }

    private static func clean() {
        for name in ["bots.json", "groups.json", "groups", "machine-groups.json", "machine-groups"] {
            try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: name))
        }
        try? FileManager.default.removeItem(at: AppInfo.testTrash)
        UserDefaults.standard.removeObject(forKey: "movesUnderWay")
    }

    /// The chats on the machine, as its runner keeps them, from any thread.
    nonisolated final class Held: @unchecked Sendable {
        private let lock = NSLock()
        private var chats: [String: (group: [String: Any], status: String, messages: [[String: Any]])] = [:]
        private(set) var actions: [String] = []

        func add(_ group: [String: Any], status: String = "active", messages: [[String: Any]] = []) {
            lock.withLock { chats[group["id"] as! String] = (group, status, messages) }
        }

        func has(_ id: String) -> Bool { lock.withLock { chats[id] != nil } }
        func status(_ id: String) -> String? { lock.withLock { chats[id]?.status } }

        func answer(_ request: StubEngine.Request) -> StubWeb.Answer {
            lock.withLock {
                let parts = request.path.split(separator: "/").map(String.init).dropFirst(3)
                let id = parts.first
                let action = parts.dropFirst().first
                actions.append("\(request.method) \(([id, action].compactMap { $0 }).joined(separator: "/"))")
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
                    chats[id] = nil
                    return StubWeb.json([:])
                case ("POST", let id?, "send"):
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
        app.groups.app = app
        app.machineGroups.app = app
        app.moves.app = app
        app.workspace.api = mac.api
        let api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: bridge.url)!, password: "test"), folderPrefix: RemoteFolder.prefix(for: machine))
        app.machineGroups.bridge = { $0 == machine ? api : nil }
        let held = held
        bridge.on("GET", "/api/kuvo/groups") { held.answer($0) }
        for method in ["GET", "PUT", "PATCH", "DELETE", "POST"] { bridge.on(method, "/api/kuvo/groups/*") { held.answer($0) } }
        mac.on("PATCH", "/api/session/*", json: [:])
        mac.on("PUT", "/api/experimental/session/*", json: [:])
        mac.on("DELETE", "/api/experimental/session/*", json: [:])
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

    @Test func aMachinesGroupChatsShowBesideTheMacsAndFollowWhatItSays() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        held.add(Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"], seats: ["bot_pal": "ses_seatP"]), messages: [Self.said])
        let app = app()
        let mine = app.groups.create(name: "Here", members: ["bot_pal"])

        await app.machineGroups.connected("box")

        #expect(Set(app.chats.list.map(\.id)) == [mine.id, "grp_box0000001"])
        #expect(app.chats.machine(of: "grp_box0000001") == "box" && app.chats.machine(of: mine.id) == nil)
        #expect(app.chats.messages(in: "grp_box0000001").map(\.text) == ["Morning."])
        #expect(app.chats.isUnread(app.chats.group("grp_box0000001")!), "a bot's message you haven't seen")
        #expect(app.workspace.seats.contains("ses_seatP"), "its seats stay out of the lists")
        // A phone sees both, and where each lives.
        let link = PhoneLink()
        link.groups = app.chats
        var listed = Data()
        for try await part in PhoneLink.respond(to: LinkRequest(path: "kuvo/groups"), link: link, engine: URL(string: mac.url + "/")!, password: nil, agents: nil) {
            if case .body(let data) = part { listed += data }
        }
        let phone = try #require((try JSONSerialization.jsonObject(with: listed) as? [String: Any])?["groups"] as? [[String: Any]])
        #expect(Dictionary(uniqueKeysWithValues: phone.map { ($0["id"] as! String, $0["machine"] as? String ?? "this Mac") }) == [mine.id: "this Mac", "grp_box0000001": "box"])
        #expect(phone.allSatisfy { $0["moving"] as? Bool == false })
        // What it says as it goes: a bot talking, a new message.
        let group = Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"], seats: ["bot_pal": "ses_seatP"])
        app.machineGroups.handle(try bridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                          "state": ["speaking": "bot_lb", "discussing": true, "paused": false]]), machine: "box")
        #expect(app.chats.speaking["grp_box0000001"] == "bot_lb" && app.chats.discussing.contains("grp_box0000001"))
        app.machineGroups.handle(try bridge.event("kuvo.group.message", ["id": "grp_box0000001", "message":
            ["id": "gm_2", "author": "bot_lb", "text": "Build is green.", "time": "2026-10-22T08:01:00Z", "kind": "message"]]), machine: "box")
        #expect(app.chats.messages(in: "grp_box0000001").map(\.text) == ["Morning.", "Build is green."])
        // Seen last, for while it's away.
        let lastSeen = MachineGroups()
        #expect(lastSeen.chats.map(\.group.id) == ["grp_box0000001"] && lastSeen.messages(in: "grp_box0000001").count == 2)
        #expect(lastSeen.discussing.isEmpty, "nothing talks until its machine says so")
        // What you write goes there.
        try await app.machineGroups.send("Go ahead", to: "grp_box0000001")
        #expect(held.actions.contains("POST grp_box0000001/send"))
        #expect(app.chats.messages(in: "grp_box0000001").last?.text == "Go ahead")
        // Gone there: gone here.
        app.machineGroups.handle(try bridge.event("kuvo.group.deleted", ["id": "grp_box0000001"]), machine: "box")
        #expect(!app.chats.list.contains { $0.id == "grp_box0000001" })
    }

    /// A phone deletes a group chat as Delete Group Chat… does, wherever it lives: this Mac's here,
    /// a machine's there, each leaving the list; one gone already is as good as deleted; one the
    /// machine is moving (another Mac's move) stays, and says why; with its
    /// machine away, it waits.
    @Test func aPhoneDeletesAGroupChatWhereItLives() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box"), ("bot_ada", "Ada", nil), ("bot_ben", "Ben", nil)])
        held.add(Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"]))
        held.add(Self.group("grp_box0000002", members: ["bot_pal", "bot_lb"]))
        let app = app()
        let mine = app.groups.create(name: "Here", members: ["bot_ada", "bot_ben"])
        await app.machineGroups.connected("box")
        let link = PhoneLink()
        link.groups = app.chats
        func delete(_ id: String) async throws -> (status: Int, message: String?) {
            var status = 0
            var body = Data()
            for try await part in PhoneLink.respond(to: LinkRequest(method: "DELETE", path: "kuvo/groups/\(id)"), link: link, engine: URL(string: mac.url + "/")!, password: nil, agents: nil) {
                switch part {
                case .head(let code, _): status = code
                case .body(let data): body += data
                }
            }
            return (status, (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["message"] as? String)
        }

        #expect(try await delete(mine.id).status == 200)
        #expect(app.chats.group(mine.id) == nil)
        #expect(try await delete("grp_box0000001?from=phone").status == 200)
        #expect(!held.has("grp_box0000001") && app.chats.group("grp_box0000001") == nil)
        // Gone already: as good as deleted.
        #expect(try await delete("grp_box0000001").status == 200)
        #expect(try await delete("grp_none000001").status == 200)

        held.add(Self.group("grp_box0000002", members: ["bot_pal", "bot_lb"]), status: "held")
        let moving = try await delete("grp_box0000002")
        #expect(moving.status == 409 && moving.message == "That chat is moving. Try again once it’s there.")
        #expect(held.status("grp_box0000002") == "held" && app.chats.group("grp_box0000002") != nil)

        app.machineGroups.bridge = { _ in nil }
        let away = try await delete("grp_box0000002")
        #expect(away.status == 503 && away.message == "box isn’t connected. Connect to it, then try again.")
        #expect(app.chats.group("grp_box0000002") != nil)
    }

    /// What a bot on a machine does on its turn, as the machine says it: shown under who's
    /// talking, gone when it's done. A phone following the chat gets its messages once, then
    /// only what changed while they stay as they were.
    @Test func whatABotDoesShowsWhileItTalks() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        held.add(Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"]), messages: [Self.said])
        let app = app()
        await app.machineGroups.connected("box")
        let link = PhoneLink()
        link.groups = app.chats
        var lines: [[String: Any]] = []
        let following = Task { @MainActor in
            for try await part in PhoneLink.respond(to: LinkRequest(path: "kuvo/groups/grp_box0000001/events"), link: link,
                                                    engine: URL(string: mac.url + "/")!, password: nil, agents: nil) {
                if case .body(let data) = part, let line = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { lines.append(line) }
            }
        }
        defer { following.cancel() }
        try await eventually { lines.count == 1 }
        #expect((lines.first?["messages"] as? [Any])?.count == 1)
        let group = Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"])
        let read: [String: Any] = ["kind": "tool", "call": ["type": "tool", "id": "call_1", "name": "read",
                                                            "state": ["status": "completed", "input": ["path": "notes.txt"], "content": []]]]
        app.machineGroups.handle(try bridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                          "state": ["speaking": "bot_lb", "discussing": true, "paused": false,
                                                                                    "activity": [read, ["kind": "thinking", "text": "Checking the build"]]]]), machine: "box")
        let shown = try #require(app.chats.activity["grp_box0000001"])
        #expect(shown.count == 2)
        if case .step(let call) = shown[0] { #expect(call.name == "read") } else { Issue.record("not the step") }
        #expect(shown[1] == .thinking("Checking the build"))
        try await eventually { lines.count == 2 }
        #expect(lines.count == 2 && lines[1]["messages"] == nil, "the phone keeps the ones it has")
        #expect((lines.last?["activity"] as? [Any])?.count == 2 && lines.last?["speaking"] as? String == "bot_lb")
        app.machineGroups.handle(try bridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                          "state": ["discussing": false, "paused": false]]), machine: "box")
        #expect(app.chats.activity["grp_box0000001"] == nil)
    }

    /// Looked at here: told there once, not again each time the machine says it back (in whole
    /// seconds, as it keeps times).
    @Test func aLookIsToldOnce() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        held.add(Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"]), messages: [Self.said])
        let app = app()
        await app.machineGroups.connected("box")
        let told = { held.actions.filter { $0 == "PATCH grp_box0000001" }.count }
        app.chats.markViewed("grp_box0000001")
        for _ in 0..<50 where told() == 0 { try await Task.sleep(for: .milliseconds(20)) }
        #expect(told() == 1)
        let seen = try #require(app.chats.group("grp_box0000001")?.viewed)
        var group = Self.group("grp_box0000001", members: ["bot_pal", "bot_lb"])
        group["viewed"] = ISO8601DateFormatter().string(from: seen)
        app.machineGroups.handle(try bridge.event("kuvo.group.updated", ["id": "grp_box0000001", "group": group, "status": "active",
                                                                          "state": ["discussing": false, "paused": false]]), machine: "box")
        try await Task.sleep(for: .milliseconds(300))
        #expect(told() == 1, "not told again")
        #expect(app.chats.group("grp_box0000001")?.viewed == seen)
    }

    @Test func aChatWhoseBotsLiveOnAMachineMovesThereAndBack() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        let app = app()
        let chat = app.groups.create(name: "k", members: ["bot_pal", "bot_lb"])
        app.groups.adopt(chat, messages: [try JSONDecoder.isoDecoder.decode(GroupMessage.self, from: JSONSerialization.data(withJSONObject: Self.said))])
        await app.machineGroups.connected("box")

        try await app.moves.move(group: chat.id, to: "box")

        // There, started, with its messages; gone from this Mac, its file in the Trash.
        #expect(held.actions.filter { $0.hasPrefix("PUT grp") || $0.hasPrefix("POST grp") } == ["PUT \(chat.id)", "POST \(chat.id)/activate"])
        #expect(held.status(chat.id) == "active")
        #expect(app.groups.group(chat.id) == nil && app.chats.machine(of: chat.id) == "box")
        #expect(app.chats.messages(in: chat.id).map(\.text) == ["Morning."])
        #expect(FileManager.default.fileExists(atPath: AppInfo.testTrash.path))
        #expect(UserDefaults.standard.data(forKey: "movesUnderWay") == nil)

        // A bot in it stays with it.
        do {
            try await app.moves.move(bot: "bot_pal", to: nil)
            Issue.record("it moved")
        } catch {
            #expect(error.localizedDescription.contains("Move the chat to this Mac first"), "\(error.localizedDescription)")
        }

        // And back: held there, here, let go there (its seats stay, as its bots do).
        try await app.moves.move(group: chat.id, to: nil)
        #expect(held.actions.filter { $0.hasPrefix("POST") }.suffix(2) == ["POST \(chat.id)/hold", "POST \(chat.id)/release"])
        #expect(!held.has(chat.id))
        #expect(app.groups.group(chat.id) != nil && app.chats.machine(of: chat.id) == nil)
        #expect(app.groups.messages(in: chat.id).map(\.text) == ["Morning."])
    }

    @Test func aChatWhoseBotsLiveOnDifferentComputersStaysOnThisMac() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_scout", "Scout", nil)])
        let app = app()
        let chat = app.groups.create(name: "Mixed", members: ["bot_pal", "bot_scout"])
        await app.machineGroups.connected("box")
        do {
            try await app.moves.move(group: chat.id, to: "box")
            Issue.record("it moved")
        } catch {
            #expect(error.localizedDescription.contains("live on different computers"), "\(error.localizedDescription)")
        }
        #expect(app.groups.group(chat.id) != nil && held.actions.allSatisfy { !$0.hasPrefix("PUT grp") })
    }

    /// A meeting that comes due while its chat moves to a machine waits, and is held once where
    /// the chat is when the move is over: here still, as the machine turned it down.
    @Test func aMeetingDueWhileItsChatMovesIsHeldOnceAfter() async throws {
        defer { Self.clean(); mac.stop() }
        let machine = "box.invalid"
        try saveBots([("bot_pal", "Pal", machine), ("bot_lb", "Lokum Builder", machine)])
        let app = app(machine: machine)
        let chat = app.groups.create(name: "k", members: ["bot_pal", "bot_lb"], meeting: .init(next: .now.addingTimeInterval(-60), topic: "Where we are"))
        await app.machineGroups.connected(machine)
        let waypoint = Waypoint()
        bridge.on("PUT", "/api/kuvo/groups/\(chat.id)") { _ in
            waypoint.block()
            return StubWeb.json(["message": "Disk full"], status: 500)
        }
        let meetings = { app.groups.messages(in: chat.id).filter { $0.kind == .meeting }.count }

        let move = Task { try await app.moves.move(group: chat.id, to: machine) }
        await waypoint.arrived()
        app.groups.meetDue()
        #expect(meetings() == 0, "not while it moves")
        waypoint.open()
        await #expect(throws: (any Error).self) { try await move.value }

        app.groups.meetDue()
        app.groups.meetDue()
        #expect(meetings() == 1)
        #expect(app.groups.group(chat.id) != nil && !held.has(chat.id))
        app.groups.stop(chat.id)
    }

    /// The app quit as a chat went to the machine, before it was let go here: taken back, so it
    /// carries on here, and what got there goes.
    @Test func aChatsMoveCutShortIsTakenBack() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        let app = app()
        let chat = app.groups.create(name: "k", members: ["bot_pal", "bot_lb"])
        held.add(Self.group(chat.id, members: ["bot_pal", "bot_lb"]), status: "held")
        let record: [String: Any] = ["kind": "group", "id": chat.id, "sessions": [String](), "to": "box", "wasPaused": true, "stage": "copying"]
        UserDefaults.standard.set(try JSONSerialization.data(withJSONObject: [record]), forKey: "movesUnderWay")

        await app.moves.recover()

        #expect(!held.has(chat.id))
        #expect(app.groups.group(chat.id) != nil)
        #expect(UserDefaults.standard.data(forKey: "movesUnderWay") == nil)
    }

    /// A move taken back that couldn't let go of its copy there: this Mac's is the chat (listed
    /// once, read and written here), and the copy goes once the machine's there again.
    @Test func aCopyLeftOnAMachineIsntTheChatAndGoes() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        let app = app()
        let chat = app.groups.create(name: "k", members: ["bot_pal", "bot_lb"])
        app.groups.adopt(chat, messages: [try JSONDecoder.isoDecoder.decode(GroupMessage.self, from: JSONSerialization.data(withJSONObject: Self.said))])
        held.add(Self.group(chat.id, members: ["bot_pal", "bot_lb"]), status: "held")
        await app.machineGroups.connected("box")
        #expect(app.chats.list.filter { $0.id == chat.id }.count == 1)
        #expect(app.chats.machine(of: chat.id) == nil && app.chats.messages(in: chat.id).map(\.text) == ["Morning."])
        #expect(held.actions.contains("POST \(chat.id)/release") && !held.has(chat.id))
        #expect(!app.machineGroups.has(chat.id))
    }

    @Test func aRemovedMachinesChatsGoFromHere() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box")])
        held.add(Self.group("grp_box0000003", members: ["bot_pal", "bot_lb"]), messages: [Self.said])
        let app = app()
        await app.machineGroups.connected("box")
        #expect(app.chats.group("grp_box0000003") != nil)
        app.machineGroups.forget(machine: "box")
        #expect(app.chats.group("grp_box0000003") == nil)
        #expect(MachineGroups().chats.isEmpty, "nor kept for later")
    }

    @Test func aDeletedBotLeavesAMachinesChats() async throws {
        defer { Self.clean(); mac.stop() }
        try saveBots([("bot_pal", "Pal", "box"), ("bot_lb", "Lokum Builder", "box"), ("bot_x", "X", "box")])
        held.add(Self.group("grp_box0000002", members: ["bot_pal", "bot_lb", "bot_x"]))
        let app = app()
        await app.machineGroups.connected("box")
        await app.machineGroups.remove(try #require(app.bots.bot("bot_x")))
        #expect(app.chats.group("grp_box0000002")?.members == ["bot_pal", "bot_lb"])
    }
}

private extension JSONDecoder {
    static let isoDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
