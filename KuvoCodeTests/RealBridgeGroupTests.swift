import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// This Mac's group chats as its coding agents' bridge runs them (the bridge the app ships, run
/// for real, as a machine runs its own), as the window and a phone show them: what you write goes
/// there, its bots answer one at a time, and their words show as they say them; a phone's routes
/// for them are the bridge's, with every rule of what can be; what an older version kept here
/// moves there. Only the engine is a stand-in, its seats answering their bot's next line.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct RealBridgeGroupTests {
    let engine = StubEngine(port: 47990)
    let folder = AppInfo.testRoot.appending(path: "RealBridge-\(UUID().uuidString.prefix(6))")

    /// The engine's seats: each answers its turn with its bot's next line (PASS once it has none).
    nonisolated final class Seats: @unchecked Sendable {
        private let lock = NSLock()
        private var lines: [String: [String]]
        private var bots: [String: String] = [:]
        private var conversations: [String: [[String: Any]]] = [:]
        private var prompts: [String: [String]] = [:]
        private var next = 1

        init(lines: [String: [String]]) { self.lines = lines }

        func made(title: String) -> String {
            lock.withLock {
                let id = "ses_seat_\(next)"
                next += 1
                bots[id] = String(title.prefix { $0 != " " })
                return id
            }
        }

        func prompted(_ seat: String, id: String, text: String) {
            lock.withLock {
                guard let bot = bots[seat] else { return }
                prompts[bot, default: []].append(text)
                let line = lines[bot]?.isEmpty == false ? lines[bot]!.removeFirst() : "PASS"
                conversations[seat, default: []] += [
                    ["id": id, "type": "user", "time": ["created": 1], "text": "(turn)"],
                    ["id": id + "_a", "type": "assistant", "agent": "build", "time": ["created": 2, "completed": 3],
                     "model": ["id": "m", "providerID": "p"], "content": [["type": "text", "text": line]]],
                    ["id": id + "_i", "type": "idle", "time": ["created": 4], "outcome": "succeeded"],
                ]
            }
            TestPulse.beat()
        }

        /// A seat made before (by an older version), as the engine has it still.
        func kept(_ seat: String, bot: String) { lock.withLock { bots[seat] = bot } }

        /// What a bot's seat was told at its turns.
        func told(_ bot: String) -> [String] { lock.withLock { prompts[bot] ?? [] } }

        /// Newest first, as the engine pages them.
        func conversation(_ seat: String) -> [[String: Any]] {
            lock.withLock { Array((conversations[seat] ?? []).reversed()) }
        }
    }

    /// This Mac's bots, as their folders have them (`bots` under `root`).
    private func bots(in root: URL) throws {
        for (id, name) in [("bot_ada", "Ada"), ("bot_ben", "Ben")] {
            let bot = root.appending(path: "bots/\(id)")
            try FileManager.default.createDirectory(at: bot.appending(path: "workspace"), withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: ["kuvo": 1, "id": id, "name": name, "job": "Helps",
                                                        "look": ["color": "mint", "shape": "round", "face": "calm"],
                                                        "model": ["id": "m", "providerID": "p"],
                                                        "created": "2026-10-21T09:00:00Z", "updated": "2026-10-21T09:00:00Z"])
                .write(to: bot.appending(path: "bot.json"))
            try Data("ses_\(id)".utf8).write(to: bot.appending(path: "session"))
            try Data(bot.appending(path: "workspace").path.utf8).write(to: bot.appending(path: "directory"))
            try Data("# \(name)'s memory\n\n## Job\nHelps with the release\n".utf8).write(to: bot.appending(path: "MEMORY.md"))
        }
    }

    private func serve(_ seats: Seats) {
        engine.on("POST", "/api/session") { request in
            let id = seats.made(title: request.body["title"] as? String ?? "")
            return StubWeb.json(["data": StubEngine.session(id, title: request.body["title"] as? String ?? "", directory: "/tmp")])
        }
        engine.on("POST", "/api/session/*") { request in
            if request.path.hasSuffix("/prompt") {
                seats.prompted(String(request.path.split(separator: "/")[2]), id: request.body["id"] as? String ?? "", text: request.body["text"] as? String ?? "")
            }
            return StubWeb.json(["data": [:]])
        }
        engine.on("GET", "/api/session/*") { request in
            let parts = request.path.split(separator: "/").map(String.init)
            switch parts.dropFirst(3).first {
            case "message": return StubWeb.json(["data": seats.conversation(parts[2])])
            case "inbox", "permission", "form": return StubWeb.json(["data": []])
            case nil where parts[2] == "active": return StubWeb.json(["data": [:]])
            default: return StubWeb.json(["data": StubEngine.session(parts[2], title: "seat", directory: "/tmp", extra: ["model": ["id": "m", "providerID": "p"]])])
            }
        }
        engine.on("GET", "/api/session", json: ["data": []])
        engine.on("GET", "/api/provider", json: ["data": []])
        engine.on("GET", "/api/integration", json: ["data": []])
        engine.on("PATCH", "/api/session/*", json: ["data": [:]])
        engine.on("PUT", "/api/experimental/session/*", json: ["data": [:]])
        engine.on("DELETE", "/api/experimental/session/*", json: ["data": [:]])
    }

    /// This Mac's bridge, as the app starts it: its group chats in `root/groups`, its bots in
    /// `root/bots`, what it lets go of in `root/trash`, who can be named in `root/agents.json`.
    private func start(root: URL, agents: OutsideAgents = OutsideAgents()) async throws -> RealBridge {
        try await RealBridge.start(engine: engine, folder: folder, environment: [
            "KUVO_GROUPS": root.appending(path: "groups").path, "KUVO_BOTS": root.appending(path: "bots").path,
            "KUVO_TRASH": root.appending(path: "trash").path, "KUVO_GROUPS_MEMORY_KEY": BotGroups.memoryKey,
            "KUVO_AGENTS_FILE": root.appending(path: "agents.json").path,
        ], agents: agents)
    }

    private func clean() {
        engine.stop()
        try? FileManager.default.removeItem(at: folder)
        for name in ["group-chats.json", "group-chats", "groups.json", "groups", "Backups", "bots.json", "bots"] {
            try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: name))
        }
    }

    /// A phone's request to this Mac, as PhoneLink answers it: this Mac's box, with its bridge.
    private func ask(_ bridge: RealBridge, _ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> (status: Int, json: [String: Any]?) {
        let request = LinkRequest(method: method, path: path, headers: ["content-type": "application/json"], body: try body.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data())
        var status = 0
        var answer = Data()
        for try await part in PhoneLink.respond(to: request, link: PhoneLink(), engine: URL(string: engine.url + "/")!, password: nil, agents: bridge.agents.address) {
            switch part {
            case .head(let code, _): status = code
            case .body(let data): answer += data
            }
        }
        return (status, try? JSONSerialization.jsonObject(with: answer) as? [String: Any])
    }

    @Test func whatYouWriteGoesThereAndItsBotsWordsShowAsTheySayThem() async throws {
        defer { clean() }
        try bots(in: folder)
        let seats = Seats(lines: ["Ada": ["Ship it Friday. &Ben, the build?"], "Ben": ["Green since this morning."]])
        serve(seats)
        let bridge = try await start(root: folder)
        defer { bridge.stop() }
        let api = try #require(bridge.api)
        let groups = BoxGroups()
        groups.bridge = { $0 == nil ? api : nil }
        bridge.agents.onEvent = { event in groups.handle(event, machine: nil) }

        // A chat on this Mac, as New Group Chat makes one: the box says what can be.
        let made = try await groups.create(name: " Crew ", purpose: nil, members: ["bot_ada", "bot_ben"], meeting: nil)
        #expect(made.name == "Crew" && groups.chats.map(\.group.name) == ["Crew"] && groups.machine(of: made.id) == nil)

        try await groups.send("Ready to ship?", to: made.id)
        try await until { groups.messages(in: made.id).contains { $0.author == "bot_ben" } && !groups.discussing.contains(made.id) }
        let said = groups.messages(in: made.id).filter { $0.kind == .message }
        #expect(said.map(\.author) == [nil, "bot_ada", "bot_ben"])
        #expect(said.map(\.text) == ["Ready to ship?", "Ship it Friday. &Ben, the build?", "Green since this morning."])
        #expect(groups.isUnread(groups.group(made.id)!), "its bots' words, not seen yet")
        #expect(groups.speaking[made.id] == nil)
        // Kept where the box keeps it.
        #expect(FileManager.default.fileExists(atPath: folder.appending(path: "groups/\(made.id)/group.json").path))
    }

    /// This Mac's bridge is up before its engine, as it usually is at launch: once the engine is up,
    /// its chats show as the bridge has them (what went on there while the app was closed), rather
    /// than staying as last seen.
    @Test func thisMacsChatsShowAsItsBridgeHasThemWhenItsUpBeforeTheEngine() async throws {
        defer { clean() }
        try bots(in: folder)
        serve(Seats(lines: [:]))
        // A chat its box went on with while the app was closed.
        let chat = folder.appending(path: "groups/grp_ship0000001")
        try FileManager.default.createDirectory(at: chat, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["kuvo": 1, "status": "active", "group": [
            "id": "grp_ship0000001", "name": "Crew", "members": ["bot_ada", "bot_ben"], "seats": [:], "heard": [:], "created": "2026-10-31T09:00:00Z",
        ]]).write(to: chat.appending(path: "group.json"))
        try JSONSerialization.data(withJSONObject: [
            ["id": "gm_1", "kind": "message", "text": "Ready to ship Friday?", "time": "2026-10-31T09:01:00Z"],
            ["id": "gm_2", "kind": "message", "author": "bot_ada", "text": "Release notes are in.", "time": "2026-10-31T09:05:00Z"],
        ]).write(to: chat.appending(path: "messages.json"))
        let app = AppModel()
        app.followAgents()
        let bridge = try await start(root: folder, agents: app.agents)
        defer { bridge.stop() }
        // Its feed is up, and the app has done what it does as it connects, before the engine is.
        try await until { app.catalog.areAgentsLoaded }

        app.standIn(engine: engine.api)
        try await until { app.chats.messages(in: "grp_ship0000001").map(\.id) == ["gm_1", "gm_2"] }
        #expect(app.chats.list.map(\.id) == ["grp_ship0000001"])
    }

    /// One chat's talk redraws only what shows that chat: another chat's conversation, sidebar row
    /// and tab (its messages, who's talking in it, whether it's unread), and the list of chats,
    /// hear nothing of it, though its computer says something of the talking chat with nearly
    /// every step (who's talking, each bot's seat, what each heard).
    @Test func oneChatsTalkRedrawsOnlyThatChat() async throws {
        defer { clean() }
        try bots(in: folder)
        let seats = Seats(lines: ["Ada": ["Ship it Friday. &Ben, the build?"], "Ben": ["Green since this morning."]])
        serve(seats)
        let bridge = try await start(root: folder)
        defer { bridge.stop() }
        let api = try #require(bridge.api)
        let groups = BoxGroups()
        groups.bridge = { $0 == nil ? api : nil }
        bridge.agents.onEvent = { event in groups.handle(event, machine: nil) }
        let talking = try await groups.create(name: "Crew", purpose: nil, members: ["bot_ada", "bot_ben"], meeting: nil)
        let quiet = try await groups.create(name: "Quiet", purpose: nil, members: ["bot_ada", "bot_ben"], meeting: nil)

        /// What heard of a change, from wherever it's told.
        nonisolated final class Heard: @unchecked Sendable {
            private let lock = NSLock()
            private var names: Set<String> = []
            func note(_ name: String) { lock.withLock { _ = names.insert(name) } }
            func has(_ name: String) -> Bool { lock.withLock { names.contains(name) } }
        }
        let heard = Heard()
        withObservationTracking {
            _ = (groups.messages(in: quiet.id), groups.speaker(in: quiet.id), groups.isDiscussing(quiet.id), groups.isPaused(quiet.id),
                 groups.activity(in: quiet.id), groups.group(quiet.id).map(groups.isUnread))
        } onChange: { heard.note("other") }
        withObservationTracking { _ = groups.groups } onChange: { heard.note("list") }
        withObservationTracking { _ = (groups.messages(in: talking.id), groups.speaker(in: talking.id)) } onChange: { heard.note("talking") }

        try await groups.send("Ready to ship?", to: talking.id)
        try await until { groups.messages(in: talking.id).contains { $0.author == "bot_ben" } && !groups.isDiscussing(talking.id) }
        #expect(heard.has("talking"), "the talking chat's views hear of it")
        #expect(!heard.has("other"), "another chat's views don't")
        #expect(!heard.has("list"), "nor does the list of chats: nothing it shows changed")
        #expect(groups.messages(in: quiet.id).isEmpty && groups.speaker(in: quiet.id) == nil)
        #expect(groups.group(talking.id)?.seats.keys.sorted() == ["bot_ada", "bot_ben"], "its bookkeeping is kept all the same")

        // What the list shows of a chat still reaches it: a rename.
        let renamed = Heard()
        withObservationTracking { _ = groups.groups } onChange: { renamed.note("list") }
        try await groups.update(quiet.id, name: "Quiet room", purpose: nil, members: ["bot_ada", "bot_ben"], meeting: nil)
        try await until { groups.groups.contains { $0.name == "Quiet room" } }
        #expect(renamed.has("list"), "the list of chats hears of a rename")
    }

    /// A meeting set up in Edit Group Chat is worked out on the chat's computer, on its clock: a
    /// daily one whose time went by while you edited comes at its next round, rather than at once.
    @Test func aMeetingIsPlannedWhereTheChatLives() async throws {
        defer { clean() }
        try bots(in: folder)
        serve(Seats(lines: [:]))
        let bridge = try await start(root: folder)
        defer { bridge.stop() }
        let api = try #require(bridge.api)
        let groups = BoxGroups()
        groups.bridge = { $0 == nil ? api : nil }
        let made = try await groups.create(name: "Crew", purpose: nil, members: ["bot_ada", "bot_ben"], meeting: nil)

        let passed = Date(timeIntervalSince1970: (Date.now.timeIntervalSince1970 / 60).rounded(.down) * 60 - 3600)
        try await groups.update(made.id, name: "Crew", purpose: nil, members: ["bot_ada", "bot_ben"], meeting: .init(next: passed, every: "1d", topic: "Standup"))
        let meeting = try #require(groups.group(made.id)?.meeting)
        #expect(meeting.next > .now, "not at once")
        #expect(Wakes.minutes(of: meeting.next) == Wakes.minutes(of: passed), "at its time of day")
        #expect((23 * 3600...25 * 3600).contains(meeting.next.timeIntervalSince(passed)), "the next day")
        #expect(meeting.every == "1d" && meeting.topic == "Standup")
        // A one-off whose time has passed is refused, in the box's words.
        await #expect(throws: ServerError.self) {
            try await groups.update(made.id, name: "Crew", purpose: nil, members: ["bot_ada", "bot_ben"], meeting: .init(next: passed, every: nil, topic: "Late"))
        }
    }

    /// Who can be in this Mac's chats is what its box says: its own bots, and those of your
    /// machines that take a chat's turns, not one of a machine that doesn't yet.
    @Test func whoCanBeInThisMacsChatsIsWhatItsBoxSays() async throws {
        defer { clean() }
        try bots(in: folder)
        serve(Seats(lines: [:]))
        let bridge = try await start(root: folder)
        defer { bridge.stop() }
        let api = try #require(bridge.api)
        let groups = BoxGroups()
        groups.bridge = { $0 == nil ? api : nil }
        // Who this Mac's link says your machines and their bots are (its box, `tellSeatPeers`).
        let peers: JSONValue = .object([
            "boxes": .array([.object(["key": .string("key_spare"), "name": .string("spare.invalid"), "seats": .bool(true)]),
                             .object(["key": .string("key_old"), "name": .string("old.invalid"), "seats": .bool(false)])]),
            "bots": .array([.object(["id": .string("bot_far"), "name": .string("Far"), "job": .string(""), "box": .string("key_spare")]),
                            .object(["id": .string("bot_older"), "name": .string("Older"), "job": .string(""), "box": .string("key_old")])]),
        ])
        _ = try await api.client.send(try api.client.request("PUT", "api/kuvo/peers", body: peers), as: JSONValue.self)

        #expect(await groups.joinable(nil) == ["bot_ada", "bot_ben", "bot_far"])
        #expect(await groups.joinable("away.invalid") == nil, "a machine that isn't there says nothing")
    }

    /// A phone's group chat routes on this Mac are its bridge's, as on a machine: made, listed,
    /// followed, written to and changed with every rule of what can be; a bot of another computer
    /// stays in a chat a phone changes, and lists as that computer's; the agents a message names
    /// with & are worked out there; and a chat goes as Delete Group Chat… deletes it.
    @Test func aPhonesGroupChatsOnThisMacAreItsBridges() async throws {
        defer { clean() }
        try bots(in: folder)
        // Who can be named here, as AgentMail writes it.
        try JSONSerialization.data(withJSONObject: ["agents": [["session": "ses_fix", "name": "Fix login", "kind": "session", "project": "api"]]])
            .write(to: folder.appending(path: "agents.json"))
        let seats = Seats(lines: ["Ada": ["On it.", "PASS"], "Ben": ["PASS"]])
        serve(seats)
        let bridge = try await start(root: folder)
        defer { bridge.stop() }
        // This Mac's box, which passes a phone's group chat routes on to the bridge (not telling it
        // who your other computers are: this test does).
        let box = try await TestBox(engine: engine.url, environment: ["KUVO_TEST_NO_PEERS": "1"])
        defer { box.stop() }
        bridge.agents.recordForBox()
        let api = try #require(bridge.api)
        let peers: JSONValue = .object([
            "boxes": .array([.object(["key": .string("key_spare"), "name": .string("spare.invalid"), "seats": .bool(true)])]),
            "bots": .array([.object(["id": .string("bot_far"), "name": .string("Far"), "job": .string("Watches CI"), "box": .string("key_spare"),
                                     "session": .string("ses_far"), "look": .object(["color": .string("sky"), "shape": .string("round"), "face": .string("calm")])])]),
        ])
        _ = try await api.client.send(try api.client.request("PUT", "api/kuvo/peers", body: peers), as: JSONValue.self)

        let made = try await ask(bridge, "POST", "kuvo/groups", ["name": "Release", "members": ["bot_ada", "bot_ben", "bot_ada"], "purpose": "  Ship 1.0  "])
        #expect(made.status == 201, "\(made)")
        let id = try #require((made.json?["group"] as? [String: Any])?["id"] as? String)
        #expect((made.json?["group"] as? [String: Any])?["purpose"] as? String == "Ship 1.0")
        #expect(try await ask(bridge, "POST", "kuvo/groups", ["name": "Solo", "members": ["bot_ada"]]).status == 400)
        let unknown = try await ask(bridge, "POST", "kuvo/groups", ["name": "Who", "members": ["bot_ada", "bot_gone000001"]])
        #expect(unknown.status == 404 && unknown.json?["message"] as? String == "There’s no bot “bot_gone000001”.")

        // A bot of another computer joins, and stays when the phone changes the chat again.
        let joined = try await ask(bridge, "PATCH", "kuvo/groups/\(id)", ["members": ["bot_ada", "bot_far"]])
        #expect(joined.status == 200, "\(joined)")
        let renamed = try await ask(bridge, "PATCH", "kuvo/groups/\(id)", ["name": "Release 1.0"])
        let members = try #require((renamed.json?["group"] as? [String: Any])?["members"] as? [[String: Any]])
        #expect(members.map { $0["id"] as? String } == ["bot_ada", "bot_far"])
        #expect(members.last?["computer"] as? String == "spare.invalid" && members.last?["session"] as? String == "ses_far")
        let nameless = try await ask(bridge, "PATCH", "kuvo/groups/\(id)", ["name": " "])
        #expect(nameless.status == 400 && nameless.json?["message"] as? String == "A group chat needs a name.")

        // Listed: this Mac's own chats only.
        let listed = try #require(try await ask(bridge, "GET", "kuvo/groups").json?["groups"] as? [[String: Any]])
        #expect(listed.map { $0["id"] as? String } == [id] && listed.first?["name"] as? String == "Release 1.0")

        // Written to, as a phone writes: the box names who it names.
        let wrote = try await ask(bridge, "POST", "kuvo/groups/\(id)", ["text": "&Ada, look at &Fix login"])
        #expect(wrote.status == 200)
        try await until { !seats.told("Ada").isEmpty }
        #expect(seats.told("Ada").first?.contains("- &Fix login (ses_fix): session, on the Mac, in api") == true, "\(seats.told("Ada"))")
        let read = try #require(try await ask(bridge, "GET", "kuvo/groups/\(id)").json)
        #expect((read["messages"] as? [[String: Any]])?.first?["text"] as? String == "&Ada, look at &Fix login")
        #expect((read["messages"] as? [[String: Any]])?.first?["named"] == nil, "the block is the box's")

        // A path that isn't what it seems: refused, as every box refuses it.
        #expect(try await ask(bridge, "GET", "kuvo/groups/../bots").status == 403)
        #expect(try await ask(bridge, "DELETE", "kuvo/groups/\(id)").status == 200)
        #expect(try await ask(bridge, "DELETE", "kuvo/groups/\(id)").status == 200, "gone already is as good as deleted")
        #expect(try #require(try await ask(bridge, "GET", "kuvo/groups").json?["groups"] as? [Any]).isEmpty)
    }

    /// With this Mac's bridge not running, a phone's group chat routes say so: try again.
    @Test func aPhoneHearsWhenThisMacsGroupChatsArentRunning() async throws {
        defer { clean() }
        let box = try await TestBox(engine: engine.url)
        defer { box.stop() }
        BoxProcess.agentsChanged(nil, pid: nil)
        var status = 0
        var answer = Data()
        for try await part in PhoneLink.respond(to: LinkRequest(path: "kuvo/groups"), link: PhoneLink(), engine: URL(string: engine.url + "/")!, password: nil, agents: OutsideAgents.Address()) {
            switch part {
            case .head(let code, _): status = code
            case .body(let data): answer += data
            }
        }
        #expect(status == 503)
        #expect((try? JSONSerialization.jsonObject(with: answer) as? [String: Any])?["message"] as? String == "Group chats on this Mac are starting. Try again in a moment.")
    }

    /// What an older version kept of this Mac's chats moves into its box, and talks there: its
    /// messages, who heard what, and its bots, as they were.
    @Test func chatsFromAnOlderVersionTalkInThisMacsBridge() async throws {
        defer { clean() }
        let support = AppInfo.supportDirectory
        try bots(in: support)
        try GroupMigrationTests.write(shape: "0.5.22", in: support)
        GroupMigration.run(version: "0.8.0", defaults: UserDefaults(suiteName: "RealBridgeGroupTests-\(UUID().uuidString)")!)
        let seats = Seats(lines: ["Ada": ["Back again."], "Ben": ["PASS"]])
        seats.kept("ses_seatAda", bot: "Ada")
        serve(seats)
        let bridge = try await start(root: support)
        defer { bridge.stop() }
        let api = try #require(bridge.api)
        let groups = BoxGroups()
        #expect(groups.chats.map(\.group.id) == [GroupMigrationTests.chatID], "shown from the first frame, before the bridge says anything")
        groups.bridge = { $0 == nil ? api : nil }
        bridge.agents.onEvent = { event in groups.handle(event, machine: nil) }
        await groups.connected(nil)
        #expect(groups.messages(in: GroupMigrationTests.chatID).map(\.text).prefix(2) == ["Plan the release", "Friday works."])
        try await groups.send("Where were we?", to: GroupMigrationTests.chatID)
        try await until { groups.messages(in: GroupMigrationTests.chatID).contains { $0.text == "Back again." } && !groups.discussing.contains(GroupMigrationTests.chatID) }
        // What you wrote reached Ada at her turn.
        #expect(seats.told("Ada").first?.contains("Where were we?") == true)
    }
}
