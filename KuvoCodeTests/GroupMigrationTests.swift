import Foundation
import Testing
@testable import KuvoCode

/// This Mac's group chats, as Kuvo Code 0.5, 0.6, 0.7.2 and 0.8.0-beta.1 kept them, moved into its
/// own box the first time this version starts: each chat with its messages (steps, a wrap-up's
/// work, reports, meetings), what its bots heard and were told to set aside, and a chat that was
/// moving kept held for the move to finish. It can be cut short and run again, an older version's
/// list that shows up later is taken in by each chat's ID, and the old files are kept in Backups.
/// The files are as each version wrote them.
@MainActor
@Suite(.serialized) struct GroupMigrationTests {
    static let chatID = "grp_rel0000001"
    let defaults = UserDefaults(suiteName: "GroupMigrationTests-\(UUID().uuidString)")!
    var support: URL { AppInfo.supportDirectory }

    init() {
        // First: the run's first use of the test folder clears it (a stand-in engine's start does
        // too), which would take the files a test wrote before it.
        TestEnvironment.prepare()
        Self.clean()
    }

    private static func clean() {
        for name in ["groups.json", "groups", "Backups", "bots.json", "bots", "group-chats.json", "group-chats", "machine-groups.json", "machine-groups"] {
            try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: name))
        }
    }

    // MARK: What each version wrote

    /// A chat and its messages as `shape` ("0.5.0", "0.5.22", "0.6.0", "0.7.2" or "beta.1") wrote
    /// them, in `support`, with Ada and Ben as its bots.
    static func write(shape: String, in support: URL, id: String = chatID, name: String = "Release") throws {
        var group: [String: Any] = ["id": id, "name": name, "members": ["bot_ada", "bot_ben"],
                                    "seats": ["bot_ada": "ses_seatAda"], "heard": ["bot_ada": "gm_2"],
                                    "created": "2026-05-01T09:00:00Z", "viewed": "2026-05-01T10:00:00Z"]
        var messages: [[String: Any]] = [
            ["id": "gm_1", "text": "Plan the release", "time": "2026-05-01T09:01:00Z", "kind": "message"],
            ["id": "gm_2", "author": "bot_ada", "text": "Friday works.", "time": "2026-05-01T09:02:00Z", "kind": "message"],
        ]
        if shape != "0.5.0" {
            group["purpose"] = "Ship each release"
            group["retracted"] = ["bot_ben": "Plan the rel"]
            group["meeting"] = shape == "0.5.3" ? ["next": "2027-01-04T06:00:00Z", "every": "weekdays", "topic": "Standup"]
                : ["next": "2027-01-04T06:00:00Z", "every": "weekdays", "topic": "Standup", "at": 540]
            messages[1]["steps"] = [["type": "tool", "id": "call_1", "name": "read", "state": ["status": "completed", "input": ["path": "notes.txt"], "content": []]]]
            messages.append(["id": "gm_3", "author": "bot_ada", "text": "Here's who does what.", "time": "2026-05-01T09:03:00Z", "kind": "wrapUp",
                             "tasks": [["id": "gt_1", "bot": "bot_ben", "task": "Tag it", "state": "done", "started": "2026-05-01T09:04:00Z", "finished": "2026-05-01T09:10:00Z"],
                                       ["id": "gt_2", "bot": "bot_ada", "task": "Notes", "state": "proposed", "after": ["bot_ben"]]]])
            messages.append(["id": "gm_4", "author": "bot_ben", "text": "Tagged.", "time": "2026-05-01T09:10:00Z", "kind": "message", "report": "gt_1"])
            messages.append(["id": "gm_5", "text": "Standup", "time": "2026-05-02T06:00:00Z", "kind": "meeting"])
            messages.append(["id": "gm_6", "text": "Ben couldn’t answer: it isn’t signed in.", "time": "2026-05-02T06:01:00Z", "kind": "note"])
        }
        if shape == "0.6.0" || shape == "0.7.2" || shape == "beta.1" { group["agentSeats"] = ["ses_seatAda"] }
        let groups = support.appending(path: "groups")
        try FileManager.default.createDirectory(at: groups, withIntermediateDirectories: true)
        var list = (try? JSONSerialization.jsonObject(with: Data(contentsOf: support.appending(path: "groups.json"))) as? [[String: Any]]) ?? []
        list.append(group)
        try JSONSerialization.data(withJSONObject: list, options: [.prettyPrinted, .sortedKeys]).write(to: support.appending(path: "groups.json"))
        try JSONSerialization.data(withJSONObject: messages, options: [.prettyPrinted, .sortedKeys]).write(to: groups.appending(path: "\(id).json"))
    }

    /// Ada and Ben, this Mac's bots, as `bots.json` lists them; their folders as 0.5 left them
    /// (no description, no conversation file) unless `described`.
    private func saveBots(described: Bool = false) throws {
        let bots = [("bot_ada", "Ada", "ses_ada"), ("bot_ben", "Ben", "ses_ben")].map { id, name, session -> [String: Any] in
            ["id": id, "name": name, "job": "Helps", "instructions": "Helps.", "look": ["color": "mint", "shape": "round", "face": "calm"],
             "folder": support.appending(path: "bots/\(id)").path, "sessionID": session, "created": "2026-05-01T08:00:00Z"]
        }
        try JSONSerialization.data(withJSONObject: bots).write(to: support.appending(path: "bots.json"))
        for (id, _, _) in [("bot_ada", "", ""), ("bot_ben", "", "")] {
            let folder = support.appending(path: "bots/\(id)")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data("## Job\nHelps\n".utf8).write(to: folder.appending(path: "MEMORY.md"))
            if described { try Data(#"{"kept":true}"#.utf8).write(to: folder.appending(path: "bot.json")) }
        }
    }

    private func record(_ id: String = chatID) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: support.appending(path: "groups/\(id)/group.json"))) as? [String: Any])
    }

    private func messages(_ id: String = chatID) throws -> [[String: Any]] {
        try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: support.appending(path: "groups/\(id)/messages.json"))) as? [[String: Any]])
    }

    // MARK: Scenarios

    @Test(arguments: ["0.5.0", "0.5.3", "0.5.22", "0.6.0", "0.7.2", "beta.1"])
    func eachVersionsChatMovesWhole(shape: String) throws {
        defer { Self.clean() }
        try Self.write(shape: shape, in: support)

        let report = GroupMigration.run(version: "0.8.0", defaults: defaults)

        #expect(report.moved == [Self.chatID])
        let kept = try record()
        #expect(kept["kuvo"] as? Int == 1 && kept["status"] as? String == "active")
        let group = try #require(kept["group"] as? [String: Any])
        #expect(group["name"] as? String == "Release" && group["members"] as? [String] == ["bot_ada", "bot_ben"])
        #expect(group["seats"] as? [String: String] == ["bot_ada": "ses_seatAda"] && group["heard"] as? [String: String] == ["bot_ada": "gm_2"])
        #expect(group["viewed"] as? String == "2026-05-01T10:00:00Z")
        let said = try messages()
        if shape == "0.5.0" {
            #expect(said.map { $0["id"] as? String } == ["gm_1", "gm_2"])
            #expect(group["meeting"] == nil && group["purpose"] == nil)
        } else {
            #expect(said.map { $0["kind"] as? String } == ["message", "message", "wrapUp", "message", "meeting", "note"])
            #expect((said[1]["steps"] as? [[String: Any]])?.first?["name"] as? String == "read", "what a bot did on its turn")
            #expect((said[2]["tasks"] as? [[String: Any]])?.map { $0["state"] as? String } == ["done", "proposed"], "the wrap-up's work")
            #expect((said[2]["tasks"] as? [[String: Any]])?.last?["after"] as? [String] == ["bot_ben"])
            #expect(said[3]["report"] as? String == "gt_1", "a report back")
            #expect(group["retracted"] as? [String: String] == ["bot_ben": "Plan the rel"], "what a bot is to set aside")
            #expect((group["meeting"] as? [String: Any])?["every"] as? String == "weekdays")
            #expect(group["purpose"] as? String == "Ship each release")
        }
        #expect((group["agentSeats"] as? [String] ?? []) == (["0.6.0", "0.7.2", "beta.1"].contains(shape) ? ["ses_seatAda"] : []))
        // The old files, left for an older version to read if you go back to it, and copied to Backups.
        #expect(FileManager.default.fileExists(atPath: support.appending(path: "groups.json").path))
        #expect(FileManager.default.fileExists(atPath: support.appending(path: "groups/\(Self.chatID).json").path))
        let backup = try #require(report.backup)
        #expect(backup.lastPathComponent.hasPrefix("groups-0.8.0-"))
        #expect(FileManager.default.fileExists(atPath: backup.appending(path: "groups.json").path))
        #expect(FileManager.default.fileExists(atPath: backup.appending(path: "groups/\(Self.chatID).json").path))
        // The window shows it from its first frame, as last seen.
        let shown = BoxGroups()
        #expect(shown.chats.map(\.group.id) == [Self.chatID] && shown.chats.first?.machine == nil)
        #expect(GroupChats(boxes: shown).list.map(\.id) == [Self.chatID] && shown.group(Self.chatID)?.name == "Release", "listed from the first frame")
        #expect(shown.messages(in: Self.chatID).count == said.count)
    }

    /// One moving when the app last quit stays held, for the move's recovery to finish or take back.
    @Test func aChatThatWasMovingStaysHeld() throws {
        defer { Self.clean() }
        try Self.write(shape: "beta.1", in: support)
        try Self.write(shape: "beta.1", in: support, id: "grp_other00001", name: "Other")
        let move: [String: Any] = ["kind": "group", "id": Self.chatID, "sessions": [String](), "to": "box", "wasPaused": true, "stage": "copying"]
        defaults.set(try JSONSerialization.data(withJSONObject: [move]), forKey: GroupMigration.movesKey)

        GroupMigration.run(version: "0.8.0", defaults: defaults)

        #expect(try record()["status"] as? String == "held")
        #expect(try record("grp_other00001")["status"] as? String == "active")
        #expect(BoxGroups().chats.first { $0.group.id == Self.chatID }?.held == true)
    }

    /// Cut short after a chat's messages were written but before its record: done again at the
    /// next launch, whole. A chat whose record is there is left as it is, and a second run does
    /// nothing more.
    @Test func cutShortItCarriesOnAndRunsAgainSafely() throws {
        defer { Self.clean() }
        try Self.write(shape: "0.7.2", in: support)
        try Self.write(shape: "0.7.2", in: support, id: "grp_done000001", name: "Done")
        // As if a run stopped part way: one chat's messages there without its record, the other moved already.
        let half = support.appending(path: "groups/\(Self.chatID)")
        try FileManager.default.createDirectory(at: half, withIntermediateDirectories: true)
        try Data("[]".utf8).write(to: half.appending(path: "messages.json"))
        let done = support.appending(path: "groups/grp_done000001")
        try FileManager.default.createDirectory(at: done, withIntermediateDirectories: true)
        let since = #"{"kuvo":1,"status":"active","group":{"id":"grp_done000001","name":"Renamed since","members":["bot_ada","bot_ben"],"seats":{},"heard":{},"created":"2026-05-01T09:00:00Z"}}"#
        try Data(since.utf8).write(to: done.appending(path: "group.json"))

        let first = GroupMigration.run(version: "0.8.0", defaults: defaults)

        #expect(first.moved == [Self.chatID] && first.skipped == ["grp_done000001"])
        #expect(try messages().count == 6, "its messages written whole")
        #expect(((try record("grp_done000001"))["group"] as? [String: Any])?["name"] as? String == "Renamed since", "left as it is")
        let second = GroupMigration.run(version: "0.8.0", defaults: defaults)
        #expect(second == GroupMigration.Report(), "nothing more to do")
    }

    /// An older version run again (a rollback) writes a list of its own: what it has that's new
    /// is taken in by each chat's ID, what's here stays, one deleted since it was taken stays
    /// deleted, and its files are kept beside the first.
    @Test func anOlderVersionsListLaterIsTakenInByID() throws {
        defer { Self.clean() }
        try Self.write(shape: "beta.1", in: support)
        try Self.write(shape: "beta.1", in: support, id: "grp_gone000001", name: "Deleted since")
        let first = GroupMigration.run(version: "0.8.0", defaults: defaults)
        // Deleted after it moved (its bridge puts its folder in the trash).
        try FileManager.default.removeItem(at: support.appending(path: "groups/grp_gone000001"))
        try Self.write(shape: "beta.1", in: support, id: "grp_new0000001", name: "Made while rolled back")

        let report = GroupMigration.run(version: "0.8.0", defaults: defaults)

        #expect(report.moved == ["grp_new0000001"] && report.skipped == [Self.chatID] && report.deleted == ["grp_gone000001"])
        #expect(report.backup != nil && report.backup != first.backup)
        #expect(BoxGroups().chats.contains { $0.group.id == "grp_new0000001" })
        #expect(!FileManager.default.fileExists(atPath: support.appending(path: "groups/grp_gone000001").path), "not brought back")
    }

    /// A chat that couldn't be moved (its folder can't be made), or a list that can't be read,
    /// leaves what was kept as it is, and is tried again at the next launch.
    @Test func whatCouldntBeMovedIsTriedAgain() throws {
        defer { Self.clean() }
        try Self.write(shape: "0.7.2", in: support)
        // Something in its folder's place.
        try Data("in the way".utf8).write(to: support.appending(path: "groups/\(Self.chatID)"))

        let failed = GroupMigration.run(version: "0.8.0", defaults: defaults)

        #expect(failed.failed == [Self.chatID] && failed.backup == nil)
        try FileManager.default.removeItem(at: support.appending(path: "groups/\(Self.chatID)"))
        let again = GroupMigration.run(version: "0.8.0", defaults: defaults)
        #expect(again.moved == [Self.chatID] && again.backup != nil)
        #expect(try messages().count == 6)

        // A list that won't read: nothing noted, so it's read again once it can be.
        Self.clean()
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try Data("[{\"id\": ".utf8).write(to: support.appending(path: "groups.json"))
        #expect(GroupMigration.run(version: "0.8.0", defaults: defaults).failed == ["groups.json"])
        try? FileManager.default.removeItem(at: support.appending(path: "groups.json"))
        try Self.write(shape: "0.7.2", in: support)
        #expect(GroupMigration.run(version: "0.8.0", defaults: defaults).moved == [Self.chatID])
    }

    /// A seat an older version made on a machine for a bot there isn't one the machine knows as a
    /// seat: it's out of the chat (the bot's next turn makes one there), out of the lists, and
    /// deleted there once the machine connects.
    @Test func aSeatLeftOnAMachineIsTakenOutAndDeletedThere() async throws {
        defer { Self.clean() }
        let bots = [("bot_ada", "Ada", nil as String?), ("bot_ben", "Ben", "box")].map { id, name, machine -> [String: Any] in
            var bot: [String: Any] = ["id": id, "name": name, "job": "Helps", "instructions": "Helps.", "look": ["color": "mint", "shape": "round", "face": "calm"],
                                      "folder": support.appending(path: "bots/\(id)").path, "sessionID": "ses_\(id)", "created": "2026-05-01T08:00:00Z"]
            if let machine { bot["machine"] = machine }
            return bot
        }
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: bots).write(to: support.appending(path: "bots.json"))
        try Self.write(shape: "0.7.2", in: support)
        var list = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: support.appending(path: "groups.json"))) as? [[String: Any]])
        list[0]["seats"] = ["bot_ada": "ses_seatAda", "bot_ben": "ses_seatBen"]
        list[0]["heard"] = ["bot_ada": "gm_2", "bot_ben": "gm_2"]
        list[0]["agentSeats"] = ["ses_seatBen"]
        try JSONSerialization.data(withJSONObject: list).write(to: support.appending(path: "groups.json"))

        GroupMigration.run(version: "0.8.0", defaults: defaults)

        let group = try #require(try record()["group"] as? [String: Any])
        #expect(group["seats"] as? [String: String] == ["bot_ada": "ses_seatAda"], "the Mac's bot keeps its seat")
        #expect(group["heard"] as? [String: String] == ["bot_ada": "gm_2"] && group["agentSeats"] as? [String] == [])
        #expect(GroupMigration.orphanSeats == ["ses_seatBen"], "out of the lists until it's gone")

        let machine = StubEngine(port: 47953)
        defer { machine.stop() }
        machine.on("DELETE", "/api/session/ses_seatBen", json: [:])
        await GroupMigration.dropOrphanSeats(on: "box", api: machine.api)
        #expect(machine.requests("DELETE", "/api/session/ses_seatBen").count == 1)
        #expect(GroupMigration.orphanSeats.isEmpty)
    }

    /// What 0.8.0-beta.1's window kept of machines' chats is kept alongside this Mac's, which show
    /// from the first frame, and its old files go.
    @Test func machinesChatsAsLastSeenStayBesideThisMacs() throws {
        defer { Self.clean() }
        try Self.write(shape: "beta.1", in: support)
        let machineChat: [String: Any] = ["machine": "box", "held": false, "discussing": false, "paused": false,
                                          "group": ["id": "grp_box0000001", "name": "On the box", "members": ["bot_x", "bot_y"], "seats": [:], "heard": [:], "created": "2026-05-01T09:00:00Z"]]
        try JSONSerialization.data(withJSONObject: [machineChat]).write(to: support.appending(path: "machine-groups.json"))
        try FileManager.default.createDirectory(at: support.appending(path: "machine-groups"), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: [["id": "gm_9", "text": "Hi", "time": "2026-05-01T09:00:00Z", "kind": "message"]])
            .write(to: support.appending(path: "machine-groups/grp_box0000001.json"))

        GroupMigration.run(version: "0.8.0", defaults: defaults)

        let shown = BoxGroups()
        #expect(Set(shown.chats.map(\.group.id)) == [Self.chatID, "grp_box0000001"])
        #expect(shown.machine(of: "grp_box0000001") == "box" && shown.messages(in: "grp_box0000001").map(\.text) == ["Hi"])
        #expect(!FileManager.default.fileExists(atPath: support.appending(path: "machine-groups.json").path))
        #expect(!FileManager.default.fileExists(atPath: support.appending(path: "machine-groups").path))
    }

    /// What bots whose machine was away were still to be told goes to the box, and every bot here
    /// gets its description and conversation beside its memory (one 0.5 made has neither); what's
    /// there already stays.
    @Test func whatBotsWereToBeToldAndWhoTheyAreGoToTheBox() throws {
        defer { Self.clean() }
        try saveBots()
        try Data(#"{"kept":true}"#.utf8).write(to: support.appending(path: "bots/bot_ben/bot.json"))
        try Self.write(shape: "0.5.0", in: support)
        defaults.set(["bot_far": ["grp_gone000001"]], forKey: GroupMigration.waitingMemoryKey)

        GroupMigration.run(version: "0.8.0", defaults: defaults)

        let pending = try JSONSerialization.jsonObject(with: Data(contentsOf: support.appending(path: "groups/pending-memory.json"))) as? [String: [String]]
        #expect(pending == ["bot_far": ["grp_gone000001"]])
        #expect(defaults.dictionary(forKey: GroupMigration.waitingMemoryKey) == nil)
        let ada = support.appending(path: "bots/bot_ada")
        let described = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: ada.appending(path: "bot.json"))) as? [String: Any])
        #expect(described["name"] as? String == "Ada" && described["id"] as? String == "bot_ada")
        #expect(try String(contentsOf: ada.appending(path: "session"), encoding: .utf8) == "ses_ada")
        #expect(try String(contentsOf: support.appending(path: "bots/bot_ben/bot.json"), encoding: .utf8) == #"{"kept":true}"#, "left as it is")
    }

    /// The old files kept in Backups stay as backups made before updates come and go.
    @Test func theOldFilesStayAsBackupsComeAndGo() throws {
        defer { Self.clean() }
        try Self.write(shape: "0.7.2", in: support)
        GroupMigration.run(version: "0.8.0", defaults: defaults)
        for day in 1...5 { Backups.make(now: Date(timeIntervalSince1970: 1_800_000_000 + Double(day) * 86_400)) }
        #expect(try FileManager.default.contentsOfDirectory(atPath: support.appending(path: "Backups").path).contains { $0.hasPrefix("groups-0.8.0-") })
        let made = try FileManager.default.contentsOfDirectory(atPath: support.appending(path: "Backups").path).filter { $0.first?.isNumber == true }
        #expect(made.count == Backups.kept)
    }
}
