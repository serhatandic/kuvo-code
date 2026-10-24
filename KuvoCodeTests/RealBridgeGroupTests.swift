import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A group chat as its computer's agents bridge runs it (the bridge the app ships, run for real),
/// as the window shows it: what you write goes there, its bots answer one at a time, and their
/// words show as they say them. Only the engine is a stand-in, its seats answering their bot's
/// next line.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct RealBridgeGroupTests {
    let engine = StubEngine(port: 47990)
    let folder = AppInfo.testRoot.appending(path: "RealBridge-\(UUID().uuidString.prefix(6))")
    let machine = "box.invalid"

    /// The engine's seats: each answers its turn with its bot's next line (PASS once it has none).
    nonisolated final class Seats: @unchecked Sendable {
        private let lock = NSLock()
        private var lines: [String: [String]]
        private var bots: [String: String] = [:]
        private var conversations: [String: [[String: Any]]] = [:]
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

        func prompted(_ seat: String, id: String) {
            lock.withLock {
                guard let bot = bots[seat] else { return }
                let line = lines[bot]?.isEmpty == false ? lines[bot]!.removeFirst() : "PASS"
                conversations[seat, default: []] += [
                    ["id": id, "type": "user", "time": ["created": 1], "text": "(turn)"],
                    ["id": id + "_a", "type": "assistant", "agent": "build", "time": ["created": 2, "completed": 3],
                     "model": ["id": "m", "providerID": "p"], "content": [["type": "text", "text": line]]],
                    ["id": id + "_i", "type": "idle", "time": ["created": 4], "outcome": "succeeded"],
                ]
            }
        }

        /// Newest first, as the engine pages them.
        func conversation(_ seat: String) -> [[String: Any]] {
            lock.withLock { Array((conversations[seat] ?? []).reversed()) }
        }
    }

    /// Two of the machine's bots, as their folders there have them.
    private func bots() throws {
        for (id, name) in [("bot_ada", "Ada"), ("bot_ben", "Ben")] {
            let bot = folder.appending(path: "bots/\(id)")
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
            if request.path.hasSuffix("/prompt") { seats.prompted(String(request.path.split(separator: "/")[2]), id: request.body["id"] as? String ?? "") }
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
        engine.on("GET", "/api/provider", json: ["data": []])
        engine.on("GET", "/api/integration", json: ["data": []])
        engine.on("PATCH", "/api/session/*", json: ["data": [:]])
        engine.on("PUT", "/api/experimental/session/*", json: ["data": [:]])
        engine.on("DELETE", "/api/experimental/session/*", json: ["data": [:]])
    }

    @Test func whatYouWriteGoesThereAndItsBotsWordsShowAsTheySayThem() async throws {
        defer {
            engine.stop()
            try? FileManager.default.removeItem(at: folder)
            for name in ["machine-groups.json", "machine-groups"] { try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: name)) }
        }
        try bots()
        let seats = Seats(lines: ["Ada": ["Ship it Friday. &Ben, the build?"], "Ben": ["Green since this morning."]])
        serve(seats)
        let bridge = try await RealBridge.start(engine: engine, folder: folder, environment: [
            "KUVO_GROUPS": folder.appending(path: "groups").path, "KUVO_BOTS": folder.appending(path: "bots").path, "KUVO_TRASH": folder.appending(path: "trash").path,
        ])
        defer { bridge.stop() }
        let api = try #require(bridge.api)
        let groups = BoxGroups()
        groups.bridge = { [machine] in $0 == machine ? api : nil }
        bridge.agents.onEvent = { [machine] event in groups.handle(event, machine: machine) }

        // A chat there, as New Group Chat makes one.
        let made = BotGroup(id: "grp_crew000001", name: "Crew", members: ["bot_ada", "bot_ben"], created: .now, viewed: .now)
        try await api.putBoxGroup(made, messages: [], held: false)
        await groups.connected(machine)
        #expect(groups.chats.map(\.group.name) == ["Crew"])

        try await groups.send("Ready to ship?", to: made.id)
        try await until { groups.messages(in: made.id).contains { $0.author == "bot_ben" } && !groups.discussing.contains(made.id) }
        let said = groups.messages(in: made.id).filter { $0.kind == .message }
        #expect(said.map(\.author) == [nil, "bot_ada", "bot_ben"])
        #expect(said.map(\.text) == ["Ready to ship?", "Ship it Friday. &Ben, the build?", "Green since this morning."])
        #expect(groups.isUnread(groups.group(made.id)!), "its bots' words, not seen yet")
        #expect(groups.speaking[made.id] == nil)
    }

    /// A meeting set up in Edit Group Chat for a machine's chat is worked out there, on that
    /// computer's clock: a daily one whose time went by while you edited comes at its next round,
    /// rather than at once.
    @Test func aMeetingSetUpForAMachinesChatIsPlannedThere() async throws {
        defer {
            engine.stop()
            try? FileManager.default.removeItem(at: folder)
            for name in ["machine-groups.json", "machine-groups"] { try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: name)) }
        }
        try bots()
        serve(Seats(lines: [:]))
        let bridge = try await RealBridge.start(engine: engine, folder: folder, environment: [
            "KUVO_GROUPS": folder.appending(path: "groups").path, "KUVO_BOTS": folder.appending(path: "bots").path, "KUVO_TRASH": folder.appending(path: "trash").path,
        ])
        defer { bridge.stop() }
        let api = try #require(bridge.api)
        let groups = BoxGroups()
        groups.bridge = { [machine] in $0 == machine ? api : nil }
        let made = BotGroup(id: "grp_crew000001", name: "Crew", members: ["bot_ada", "bot_ben"], created: .now, viewed: .now)
        try await api.putBoxGroup(made, messages: [], held: false)
        await groups.connected(machine)

        let passed = Date(timeIntervalSince1970: (Date.now.timeIntervalSince1970 / 60).rounded(.down) * 60 - 3600)
        var edited = try #require(groups.group(made.id))
        edited.meeting = BotGroup.Meeting(next: passed, every: "1d", topic: "Standup")
        try await groups.update(edited)
        let meeting = try #require(groups.group(made.id)?.meeting)
        #expect(meeting.next > .now, "not at once")
        #expect(Wakes.minutes(of: meeting.next) == Wakes.minutes(of: passed), "at its time of day")
        #expect((23 * 3600...25 * 3600).contains(meeting.next.timeIntervalSince(passed)), "the next day")
        #expect(meeting.every == "1d" && meeting.topic == "Standup")
        #expect(meeting.at == Wakes.minutes(of: passed), "the time of day it keeps")
        // A meeting due would be held before what you write next is: none was.
        bridge.agents.onEvent = { [machine] event in groups.handle(event, machine: machine) }
        try await groups.send("Morning.", to: made.id)
        try await until { groups.messages(in: made.id).contains { $0.text == "Morning." } && !groups.discussing.contains(made.id) }
        #expect(!groups.messages(in: made.id).contains { $0.kind == .meeting }, "it didn't meet at once")
    }
}
