import Foundation
import os

/// This Mac's group chats, moved into its own box, once: Kuvo Code 0.5 to 0.8.0-beta.1 ran them in
/// the app and kept them in `groups.json`, each chat's messages in `groups/<id>.json`; from now on
/// this Mac's coding agents' bridge runs them as a machine's runs its own, and keeps each in a
/// folder of its own in `groups` (`groups/<id>/group.json` and `messages.json`, as
/// `Agents/src/groups/store.ts` reads them).
///
/// It runs at launch, before the bridge starts, on this Mac's own files, and can be cut short at
/// any point and run again: each chat's messages are written first and its record last (each
/// written whole, then renamed), and a chat whose record is there already is left as it is. A
/// chat that was moving when the app last quit is kept held, so the move's recovery finishes it
/// or takes it back (`Moves.recover`). Then what the bots were still to be told (a bot whose
/// machine was away) goes to `groups/pending-memory.json`, every bot here gets its description
/// and its conversation beside its memory (where the bridge reads a bot), and the old files go
/// to `Backups/groups-<version>`, where an older version's copy can be had back.
///
/// An older version run again afterwards writes a `groups.json` of its own: what it has that's new
/// is taken in the same way at the next launch, by each chat's ID.
enum GroupMigration {
    /// The folder this Mac's bridge keeps its group chats in (`KUVO_GROUPS`).
    static var root: URL { AppInfo.supportDirectory.appending(path: "groups") }
    private static var oldList: URL { AppInfo.supportDirectory.appending(path: "groups.json") }
    /// What a bot whose machine was away was still to be told of its chats, as 0.5 to 0.8.0-beta.1 kept it.
    static let waitingMemoryKey = "groupMemoryWaiting"
    /// The moves under way, as `Moves` keeps them.
    static let movesKey = "movesUnderWay"
    private static let log = Logger(subsystem: "run.kuvo.code", category: "groups")

    /// What a run did: the chats it moved, and those it found moved already.
    struct Report: Equatable {
        var moved: [String] = []
        var skipped: [String] = []
        var backup: URL?
    }

    @discardableResult
    static func run(version: String = AppInfo.version, defaults: UserDefaults = .standard) -> Report {
        var report = Report()
        let manager = FileManager.default
        let pendingMemory = defaults.dictionary(forKey: waitingMemoryKey) as? [String: [String]]
        let hasList = manager.fileExists(atPath: oldList.path)
        guard hasList || pendingMemory != nil else { return report }
        do {
            try manager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch {
            log.error("This Mac's group chats couldn't be moved: \(error.localizedDescription, privacy: .public)")
            return report
        }
        if hasList {
            let held = movingChats(defaults)
            let chats = (try? Data(contentsOf: oldList)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] }
            if chats == nil { log.error("groups.json couldn't be read; it's kept in Backups") }
            var seeded: [BoxGroups.Chat] = []
            var logs: [String: Data] = [:]
            for chat in chats ?? [] {
                guard let id = chat["id"] as? String, isChatID(id) else { continue }
                let folder = root.appending(path: id)
                if manager.fileExists(atPath: folder.appending(path: "group.json").path) {
                    report.skipped.append(id)
                    continue
                }
                let messages = self.messages(from: root.appending(path: "\(id).json"))
                guard let group = group(from: chat, id: id, messages: messages) else { continue }
                let status = held.contains(id) ? "held" : "active"
                do {
                    try manager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                    let messagesData = try JSONSerialization.data(withJSONObject: messages, options: [.prettyPrinted, .withoutEscapingSlashes])
                    try write(messagesData, to: folder.appending(path: "messages.json"))
                    // Its record last: with it there, the chat is there.
                    let record: [String: Any] = ["kuvo": 1, "status": status, "group": group]
                    try write(JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]), to: folder.appending(path: "group.json"))
                    report.moved.append(id)
                    // What the window shows of it while the bridge starts, from its first frame.
                    if let decoded = decode(BotGroup.self, from: group) {
                        seeded.append(BoxGroups.Chat(machine: nil, group: decoded, held: status == "held", discussing: false, paused: false))
                        logs[id] = messagesData
                    }
                } catch {
                    log.error("A group chat couldn't be moved (it's tried again at the next launch): \(error.localizedDescription, privacy: .public)")
                }
            }
            seed(seeded, logs: logs)
        }
        if let pendingMemory {
            var pending = (try? Data(contentsOf: root.appending(path: "pending-memory.json"))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: [String]] } ?? [:]
            for (bot, chats) in pendingMemory { pending[bot] = Array(Set((pending[bot] ?? []) + chats)).sorted() }
            if let data = try? JSONSerialization.data(withJSONObject: pending, options: [.sortedKeys]), (try? write(data, to: root.appending(path: "pending-memory.json"))) != nil {
                defaults.removeObject(forKey: waitingMemoryKey)
            }
        }
        describeBots()
        if hasList { report.backup = keepOldFiles(version: version) }
        return report
    }

    // MARK: Reading what was kept

    private static func isChatID(_ id: String) -> Bool { id.range(of: #"\Agrp_[a-z0-9]+\z"#, options: .regularExpression) != nil }

    private static func isDate(_ value: Any?) -> Bool {
        guard let text = value as? String else { return false }
        return ISO8601DateFormatter().date(from: text) != nil || fractional.date(from: text) != nil
    }

    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static func strings(_ value: Any?) -> [String]? { value as? [String] }
    private static func stringMap(_ value: Any?) -> [String: String]? { value as? [String: String] }

    /// A chat's messages as its file has them, each as the bridge reads one; one that isn't (a file
    /// someone changed) is left out, the rest kept.
    private static func messages(from file: URL) -> [[String: Any]] {
        guard let data = try? Data(contentsOf: file), let all = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        let kinds: Set<String> = ["message", "wrapUp", "note", "meeting"]
        let states: Set<String> = ["proposed", "waiting", "working", "done", "failed"]
        return all.compactMap { raw in
            var message = raw
            guard message["id"] is String, message["text"] is String, isDate(message["time"]) else { return nil }
            if message["kind"] == nil { message["kind"] = "message" }
            guard let kind = message["kind"] as? String, kinds.contains(kind) else { return nil }
            if message["author"] is NSNull { message["author"] = nil }
            if let author = message["author"], !(author is String) { return nil }
            if let tasks = message["tasks"] {
                guard let tasks = tasks as? [[String: Any]], tasks.allSatisfy({ $0["id"] is String && $0["bot"] is String && $0["task"] is String && ($0["state"] as? String).map(states.contains) == true }) else { return nil }
            }
            return message
        }
    }

    /// A chat's record as the bridge reads one (`isGroup`), from what an older version wrote.
    private static func group(from raw: [String: Any], id: String, messages: [[String: Any]]) -> [String: Any]? {
        guard let members = strings(raw["members"]) else { return nil }
        var group: [String: Any] = ["id": id, "name": (raw["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Group Chat", "members": members]
        group["seats"] = stringMap(raw["seats"]) ?? [:]
        group["heard"] = stringMap(raw["heard"]) ?? [:]
        group["created"] = isDate(raw["created"]) ? raw["created"] : (messages.first?["time"] ?? ISO8601DateFormatter().string(from: .now))
        if let purpose = raw["purpose"] as? String, !purpose.isEmpty { group["purpose"] = purpose }
        if let seats = strings(raw["agentSeats"]) { group["agentSeats"] = seats }
        if isDate(raw["viewed"]) { group["viewed"] = raw["viewed"] }
        if let retracted = stringMap(raw["retracted"]), !retracted.isEmpty { group["retracted"] = retracted }
        if let meeting = raw["meeting"] as? [String: Any], isDate(meeting["next"]), meeting["topic"] is String {
            var kept: [String: Any] = ["next": meeting["next"]!, "topic": meeting["topic"]!]
            if let every = meeting["every"] as? String { kept["every"] = every }
            if let at = meeting["at"] as? Int { kept["at"] = at }
            if let weekday = meeting["weekday"] as? Int { kept["weekday"] = weekday }
            group["meeting"] = kept
        }
        return group
    }

    /// The group chats moving when the app last quit (`Moves`' records).
    private static func movingChats(_ defaults: UserDefaults) -> Set<String> {
        guard let data = defaults.data(forKey: movesKey), let records = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return Set(records.compactMap { $0["kind"] as? String == "group" ? $0["id"] as? String : nil })
    }

    private static func decode<Value: Decodable>(_ type: Value.Type, from value: Any) -> Value? {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(type, from: data)
    }

    // MARK: Writing

    /// Written whole, then renamed into place, readable by you only.
    private static func write(_ data: Data, to file: URL) throws {
        let staged = file.deletingLastPathComponent().appending(path: "." + file.lastPathComponent + ".new")
        guard FileManager.default.createFile(atPath: staged.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        if FileManager.default.fileExists(atPath: file.path) {
            _ = try FileManager.default.replaceItemAt(file, withItemAt: staged)
        } else {
            try FileManager.default.moveItem(at: staged, to: file)
        }
    }

    /// What the window keeps of the chats it shows, with these added, so they show from its first frame.
    private static func seed(_ chats: [BoxGroups.Chat], logs: [String: Data]) {
        guard !chats.isEmpty else { return }
        var kept = JSONFile.read([BoxGroups.Chat].self, from: BoxGroups.file, isoDates: true) ?? []
        kept.removeAll { chat in chats.contains { $0.group.id == chat.group.id && $0.machine == nil } }
        JSONFile.write(kept + chats, to: BoxGroups.file, isoDates: true, readable: true)
        try? FileManager.default.createDirectory(at: BoxGroups.folder, withIntermediateDirectories: true)
        for (id, data) in logs { try? data.write(to: BoxGroups.folder.appending(path: "\(id).json"), options: .atomic) }
    }

    /// Each bot here with its description and its conversation beside its memory, where the bridge
    /// reads a bot (a bot made by 0.5 has no description yet). What's there is left as it is: the
    /// app writes it again as a bot changes.
    private static func describeBots() {
        let file = AppInfo.supportDirectory.appending(path: "bots.json")
        guard let data = try? Data(contentsOf: file) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let bots = try? decoder.decode([Bot].self, from: data) else { return }
        let manager = FileManager.default
        for bot in bots where bot.machine == nil {
            var isFolder: ObjCBool = false
            guard manager.fileExists(atPath: bot.folder, isDirectory: &isFolder), isFolder.boolValue else { continue }
            let folder = URL(filePath: bot.folder)
            if !manager.fileExists(atPath: folder.appending(path: Bot.Descriptor.file).path), let described = Bots.descriptorData(bot) {
                try? write(described, to: folder.appending(path: Bot.Descriptor.file))
            }
            if (try? String(contentsOf: folder.appending(path: "session"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) != bot.sessionID {
                try? write(Data(bot.sessionID.utf8), to: folder.appending(path: "session"))
            }
            if !manager.fileExists(atPath: folder.appending(path: "directory").path) {
                try? write(Data(bot.directory.utf8), to: folder.appending(path: "directory"))
            }
            if bot.agents == true, !manager.fileExists(atPath: folder.appending(path: "via").path) {
                try? write(Data("bridge".utf8), to: folder.appending(path: "via"))
            }
        }
    }

    /// `groups.json` and each chat's old messages, to `Backups/groups-<version>` (another name for a
    /// second time the same version moves them, after an older version wrote them again).
    private static func keepOldFiles(version: String) -> URL? {
        let manager = FileManager.default
        var target = Backups.folder.appending(path: "groups-\(version)")
        var number = 2
        while manager.fileExists(atPath: target.path) {
            target = Backups.folder.appending(path: "groups-\(version) \(number)")
            number += 1
        }
        do {
            try manager.createDirectory(at: target.appending(path: "groups"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let old = (try? manager.contentsOfDirectory(atPath: root.path)) ?? []
            for name in old where name.hasSuffix(".json") && isChatID(String(name.dropLast(5))) {
                try manager.moveItem(at: root.appending(path: name), to: target.appending(path: "groups/\(name)"))
            }
            // The list last: while it's there, a run cut short does this again.
            try manager.moveItem(at: oldList, to: target.appending(path: "groups.json"))
            return target
        } catch {
            log.error("The old group chat files couldn't be kept in Backups: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }
}
