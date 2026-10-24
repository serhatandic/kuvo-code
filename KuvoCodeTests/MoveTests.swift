import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Moving a bot or a chat to another computer: it goes whole (a bot's memory, files and wake-ups;
/// a chat's wake-ups) with its conversation and its subagents', which carry on there under the
/// same IDs; the original's conversation goes from its engine and its folder to the trash where it
/// was, with the conversation saved in it. What reached it while it moved goes along. The app
/// follows it there, and the original's going doesn't touch it. One that fails part way leaves the
/// original as it was, and nothing behind where it was going; one cut short (the app quit) is taken
/// back, or finished if it had switched, at the next launch. A bot in a project, one with a coding
/// agent, or one at work doesn't move. The machine is a folder of the test's own and a second
/// engine, stubbed.
@MainActor
@Suite(.serialized) struct MoveTests {
    let mac = StubEngine(port: 47979)
    let box = StubEngine(port: 47978, alongside: true)
    /// The machine's `~/.kuvo-code`.
    let boxRoot = AppInfo.testRoot.appending(path: "box-home/.kuvo-code")
    var botsFile: URL { AppInfo.supportDirectory.appending(path: "bots.json") }

    init() {
        Self.clean()
    }

    private static func clean() {
        for name in ["bots.json", "bots", "wakes"] { try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: name)) }
        try? FileManager.default.removeItem(at: AppInfo.testRoot.appending(path: "box-home"))
        try? FileManager.default.removeItem(at: AppInfo.testTrash)
        UserDefaults.standard.removeObject(forKey: "movesUnderWay")
    }

    /// The app, with this Mac's engine and the machine's.
    private func app() -> AppModel {
        let app = AppModel()
        app.bots.app = app
        app.wakeUps.app = app
        app.groups.app = app
        app.moves.app = app
        app.workspace.api = mac.api
        let boxAPI = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: box.url)!, password: "test"), folderPrefix: RemoteFolder.prefix(for: "box"))
        app.workspace.machineAPI = { $0 == "box" ? boxAPI : nil }
        app.moves.transport = FolderMachine(root: boxRoot)
        for engine in [mac, box] {
            engine.on("PATCH", "/api/session/*", json: [:])
            engine.on("PUT", "/api/experimental/session/*", json: [:])
            engine.on("DELETE", "/api/session/*", json: [:])
        }
        return app
    }

    /// Imports into `engine` answered as the engine does: the session, where it's put.
    private func takesImports(_ engine: StubEngine) {
        engine.on("POST", "/api/experimental/session/import") { Self.imported($0) }
    }

    /// (Answered on the stub's own thread.)
    nonisolated private static func imported(_ request: StubEngine.Request) -> StubWeb.Answer {
        let info = request.body["info"] as? [String: Any] ?? [:]
        var extra: [String: Any] = [:]
        if let parent = info["parentID"] { extra["parentID"] = parent }
        let directory = (request.body["location"] as? [String: Any])?["directory"] as? String ?? ""
        return StubWeb.json(["data": StubEngine.session(info["id"] as? String ?? "", title: info["title"] as? String ?? "", directory: directory, extra: extra)])
    }

    /// A bot's folder, with its memory, a file it made and a wake-up.
    private func botFolder(_ parent: URL, id: String, session: String) throws -> URL {
        let folder = parent.appending(path: id)
        try FileManager.default.createDirectory(at: folder.appending(path: "workspace"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: folder.appending(path: "wakes"), withIntermediateDirectories: true)
        try Data("# Scout's memory\n\n## Job\nWatches the build\n".utf8).write(to: folder.appending(path: "MEMORY.md"))
        try Data("notes".utf8).write(to: folder.appending(path: "workspace/notes.txt"))
        try Data("check the build".utf8).write(to: folder.appending(path: "wakes/1792000500-AbC123"))
        try Data(session.utf8).write(to: folder.appending(path: "session"))
        return folder
    }

    private func saveBots(_ bots: [[String: Any]]) throws {
        try JSONSerialization.data(withJSONObject: bots).write(to: botsFile)
    }

    private func bot(_ id: String, folder: URL, session: String, machine: String? = nil, extra: [String: Any] = [:]) -> [String: Any] {
        var bot: [String: Any] = [
            "id": id, "name": "Scout", "job": "Watches the build", "instructions": "Watches the build", "jobInMemory": true,
            "look": ["color": "sky", "shape": "round", "face": "calm"], "folder": folder.path, "sessionID": session,
            "created": "2026-10-01T09:00:00Z",
        ]
        if let machine { bot["machine"] = machine }
        return bot.merging(extra) { $1 }
    }

    /// A conversation as an engine exports it: its session, with its metadata and rules, and its
    /// messages.
    nonisolated private static func exported(_ id: String, directory: String, bot: String?, parent: String? = nil, messages: Int = 1) -> [String: Any] {
        var info = StubEngine.session(id, title: "Scout", directory: directory)
        if let bot { info["metadata"] = ["kuvo": ["bot": bot]] }
        if let parent { info["parentID"] = parent }
        info["permissions"] = [["action": "external_directory", "resource": "/old/place/*", "effect": "allow"]]
        let said = (1...messages).map { ["id": "msg_\(id)_\($0)", "type": "user", "text": "Remember the number 42.", "time": ["created": $0]] as [String: Any] }
        return ["data": ["info": info, "messages": said]]
    }

    private func trashed(_ name: String, in trash: URL) -> URL? {
        let found = FileManager.default.enumerator(at: trash, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL } ?? []
        return found.first { $0.lastPathComponent == name }
    }

    @Test func aMacBotMovesToAMachineAndCarriesOn() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "bot_scout00001", session = "ses_scout"
        let original = try botFolder(Bots.root, id: id, session: session)
        try saveBots([bot(id, folder: original, session: session)])
        let app = app()
        mac.list([StubEngine.session(session, title: "Scout", directory: original.appending(path: "workspace").path)])
        await app.workspace.refresh()
        mac.on("GET", "/api/session/\(session)/inbox", json: ["data": []])
        mac.on("GET", "/api/experimental/session/\(session)/export", json: Self.exported(session, directory: original.appending(path: "workspace").path, bot: id))
        takesImports(box)
        Drafts.shared[session] = Drafts.Draft(text: "half a thought")
        let there = boxRoot.appending(path: "bots/\(id)")

        try await app.moves.move(bot: id, to: "box")

        // There: its memory, files and wake-ups, not held, and its conversation, under the same ID.
        #expect(FileManager.default.fileExists(atPath: there.appending(path: "MEMORY.md").path))
        #expect(try String(contentsOf: there.appending(path: "workspace/notes.txt"), encoding: .utf8) == "notes")
        #expect(FileManager.default.fileExists(atPath: there.appending(path: "wakes/1792000500-AbC123").path))
        #expect(!FileManager.default.fileExists(atPath: there.appending(path: "paused").path), "its wake-ups go on there")
        let imported = try #require(box.requests("POST", "/api/experimental/session/import").first)
        #expect((imported.body["location"] as? [String: Any])?["directory"] as? String == there.appending(path: "workspace").path)
        #expect((imported.body["info"] as? [String: Any])?["id"] as? String == session)
        #expect((imported.body["messages"] as? [Any])?.count == 1)
        // Its rules there, for its folder there, not where it was.
        let rules = box.requests("PATCH", "/api/session/\(session)").compactMap { $0.body["permissions"] as? [[String: Any]] }.last ?? []
        #expect(rules.contains { $0["resource"] as? String == there.path + "/*" })
        #expect(!rules.contains { ($0["resource"] as? String)?.hasPrefix("/old/place") == true })
        let told = box.requests("PUT", "/api/experimental/session/\(session)/instructions/entries/\(Bots.instructionKey)").last?.body["value"] as? String
        #expect(told?.contains("the Linux machine \"box\"") == true)
        // It lives there now, and the app goes there for it, its draft as it was.
        let moved = try #require(app.bots.bot(id))
        #expect(moved.machine == "box" && moved.folder == there.path && moved.sessionID == session)
        #expect(Bots().bot(id)?.machine == "box", "still there after a relaunch")
        #expect(app.workspace.session(session)?.location.directory == RemoteFolder.folder(there.appending(path: "workspace").path, on: "box"))
        #expect(Drafts.shared[session].text == "half a thought")

        // The original: its conversation gone from this Mac's engine, its folder in the Trash with
        // the conversation saved in it.
        #expect(mac.requests("DELETE", "/api/session/\(session)").count == 1)
        #expect(!FileManager.default.fileExists(atPath: original.path))
        let kept = try #require(trashed(id, in: AppInfo.testTrash))
        let saved = try String(contentsOf: kept.appending(path: "conversation.json"), encoding: .utf8)
        #expect(saved.contains(session) && saved.contains("Remember the number 42."))
        // Done: nothing held, nothing left to finish.
        #expect(!Moves.isFrozen(id) && !Moves.isFrozen(session))
        #expect(UserDefaults.standard.data(forKey: "movesUnderWay") == nil)

        // The original's going, as this Mac's engine says it, leaves the moved one as it is.
        app.workspace.handle(try mac.event("session.deleted", session: session), machine: nil)
        #expect(app.workspace.session(session)?.location.directory == RemoteFolder.folder(there.appending(path: "workspace").path, on: "box"))
        #expect(Drafts.shared[session].text == "half a thought")
        Drafts.shared.remove(session)
    }

    @Test func aBotOnAMachineComesBackToThisMac() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "bot_scout00002", session = "ses_scout2"
        let original = try botFolder(boxRoot.appending(path: "bots"), id: id, session: session)
        try saveBots([bot(id, folder: original, session: session, machine: "box")])
        let app = app()
        box.on("GET", "/api/session/\(session)/inbox", json: ["data": []])
        box.on("GET", "/api/experimental/session/\(session)/export", json: Self.exported(session, directory: original.appending(path: "workspace").path, bot: id))
        takesImports(mac)

        try await app.moves.move(bot: id, to: nil)

        let here = Bots.root.appending(path: id)
        #expect(FileManager.default.fileExists(atPath: here.appending(path: "workspace/notes.txt").path))
        #expect(app.bots.bot(id)?.machine == nil && app.bots.bot(id)?.folder == here.path)
        // Described where it lives now, and its folder says its session and where it works.
        #expect(FileManager.default.fileExists(atPath: here.appending(path: Bot.Descriptor.file).path))
        #expect(try String(contentsOf: here.appending(path: "directory"), encoding: .utf8) == here.appending(path: "workspace").path)
        #expect(box.requests("DELETE", "/api/session/\(session)").count == 1)
        // The original in Kuvo Code's trash on the machine, with its conversation.
        #expect(!FileManager.default.fileExists(atPath: original.path))
        let kept = try #require(trashed(id, in: boxRoot.appending(path: "trash")))
        #expect(FileManager.default.fileExists(atPath: kept.appending(path: "conversation.json").path))
    }

    /// Its subagents' conversations go with it, and what reached it while it moved (a wake-up on its
    /// way) goes along: the copy is made again.
    @Test func subagentsAndWhatCameMeanwhileGoAlong() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "bot_scout00004", session = "ses_scout4", child = "ses_scout4_child"
        let original = try botFolder(Bots.root, id: id, session: session)
        try saveBots([bot(id, folder: original, session: session)])
        let app = app()
        let workspace = original.appending(path: "workspace").path
        mac.list([StubEngine.session(session, title: "Scout", directory: workspace),
                  StubEngine.session(child, title: "Research", directory: workspace, extra: ["parentID": session])])
        await app.workspace.refresh()
        mac.on("GET", "/api/session/\(session)/inbox", json: ["data": []])
        // The second read has one more message: it came while the first copy was made.
        let reads = Counter()
        mac.on("GET", "/api/experimental/session/\(session)/export") { _ in
            StubWeb.json(Self.exported(session, directory: workspace, bot: id, messages: reads.next() == 1 ? 1 : 2))
        }
        mac.on("GET", "/api/experimental/session/\(child)/export", json: Self.exported(child, directory: workspace, bot: nil, parent: session))
        takesImports(box)

        try await app.moves.move(bot: id, to: "box")

        let imports = box.requests("POST", "/api/experimental/session/import")
        let last = imports.filter { ($0.body["info"] as? [String: Any])?["id"] as? String == session }.last
        #expect((last?.body["messages"] as? [Any])?.count == 2, "with what came meanwhile")
        #expect(imports.contains { ($0.body["info"] as? [String: Any])?["id"] as? String == child }, "its subagent's too")
        #expect(box.requests("DELETE", "/api/session/\(session)").count == 1, "the first copy gave way")
        #expect(mac.requests("DELETE", "/api/session/\(child)").count == 1 && mac.requests("DELETE", "/api/session/\(session)").count == 1)
        #expect(app.bots.bot(id)?.machine == "box")
    }

    @Test func aChatMovesWithItsWakeUps() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "ses_chat1"
        let wakes = WakeUps.root.appending(path: id)
        try FileManager.default.createDirectory(at: wakes.appending(path: "wakes"), withIntermediateDirectories: true)
        try Data(id.utf8).write(to: wakes.appending(path: "session"))
        try Data(Workspace.chatsFolder.utf8).write(to: wakes.appending(path: "directory"))
        try Data("ask how it went".utf8).write(to: wakes.appending(path: "wakes/1792000900-Chat01"))
        let app = app()
        mac.list([StubEngine.session(id, title: "Trip plans", directory: Workspace.chatsFolder)])
        await app.workspace.refresh()
        mac.on("GET", "/api/session/\(id)/inbox", json: ["data": []])
        mac.on("GET", "/api/experimental/session/\(id)/export", json: Self.exported(id, directory: Workspace.chatsFolder, bot: nil))
        takesImports(box)

        try await app.moves.move(chat: id, to: "box")

        let chats = boxRoot.appending(path: "chats").path
        let there = boxRoot.appending(path: "wakes/\(id)")
        #expect(FileManager.default.fileExists(atPath: there.appending(path: "wakes/1792000900-Chat01").path))
        #expect(try String(contentsOf: there.appending(path: "directory"), encoding: .utf8) == chats, "its checks run where it is now")
        #expect(!FileManager.default.fileExists(atPath: there.appending(path: "paused").path))
        let directory = RemoteFolder.folder(chats, on: "box")
        #expect(app.workspace.session(id)?.location.directory == directory)
        #expect(Workspace.isChat(directory) && app.workspace.chats.map(\.id) == [id], "with the chats, not a project")
        #expect(mac.requests("DELETE", "/api/session/\(id)").count == 1)
        #expect(!FileManager.default.fileExists(atPath: wakes.path))
        let kept = try #require(trashed(id, in: AppInfo.testTrash))
        #expect(FileManager.default.fileExists(atPath: kept.appending(path: "conversation.json").path))
    }

    /// Its original couldn't be told to go (its engine didn't answer): it's left out of what that
    /// engine lists, so the app keeps going by the moved one, and it goes when it can.
    @Test func anOriginalThatStayedIsLeftOutUntilItGoes() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "ses_chat2"
        let app = app()
        mac.list([StubEngine.session(id, title: "Trip plans", directory: Workspace.chatsFolder)])
        await app.workspace.refresh()
        mac.on("GET", "/api/session/\(id)/inbox", json: ["data": []])
        mac.on("GET", "/api/experimental/session/\(id)/export", json: Self.exported(id, directory: Workspace.chatsFolder, bot: nil))
        mac.on("DELETE", "/api/session/\(id)", json: ["message": "Busy"], status: 500)
        takesImports(box)

        try await app.moves.move(chat: id, to: "box")

        let directory = RemoteFolder.folder(boxRoot.appending(path: "chats").path, on: "box")
        await app.workspace.refresh()
        #expect(app.workspace.session(id)?.location.directory == directory, "this Mac's list doesn't bring it back")
        #expect(app.workspace.chats.map(\.id) == [id])
        // Its engine answers again: it goes.
        mac.on("DELETE", "/api/session/\(id)", json: [:])
        await app.moves.recover()
        #expect(mac.requests("DELETE", "/api/session/\(id)").count == 2)
        #expect(UserDefaults.standard.data(forKey: "movesUnderWay") == nil)
    }

    /// The machine turned the conversation down: nothing of it stays there, and the original is as
    /// it was, its wake-ups going on.
    @Test func aMoveThatFailsLeavesTheOriginalAsItWas() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "bot_scout00003", session = "ses_scout3"
        let original = try botFolder(Bots.root, id: id, session: session)
        try saveBots([bot(id, folder: original, session: session)])
        let before = try Data(contentsOf: botsFile)
        let app = app()
        mac.list([StubEngine.session(session, title: "Scout", directory: original.appending(path: "workspace").path)])
        await app.workspace.refresh()
        mac.on("GET", "/api/session/\(session)/inbox", json: ["data": []])
        mac.on("GET", "/api/experimental/session/\(session)/export", json: Self.exported(session, directory: original.appending(path: "workspace").path, bot: id))
        box.on("POST", "/api/experimental/session/import", json: ["message": "Disk full"], status: 500)

        await #expect(throws: (any Error).self) { try await app.moves.move(bot: id, to: "box") }

        #expect(FileManager.default.fileExists(atPath: original.appending(path: "workspace/notes.txt").path))
        #expect(!FileManager.default.fileExists(atPath: original.appending(path: "paused").path), "its wake-ups go on")
        #expect(!FileManager.default.fileExists(atPath: boxRoot.appending(path: "bots/\(id)").path))
        #expect(mac.requests("DELETE", "/api/session/\(session)").isEmpty)
        #expect(try Data(contentsOf: botsFile) == before)
        #expect(app.bots.bot(id)?.machine == nil)
        #expect(!app.moves.isMoving(id) && !Moves.isFrozen(id) && !Moves.isFrozen(session))
        #expect(UserDefaults.standard.data(forKey: "movesUnderWay") == nil)
    }

    /// A copy there already, from a move cut short, gives way to this one.
    @Test func anEarlierCopyGivesWay() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "bot_scout00005", session = "ses_scout5"
        let original = try botFolder(Bots.root, id: id, session: session)
        try saveBots([bot(id, folder: original, session: session)])
        let app = app()
        mac.list([StubEngine.session(session, title: "Scout", directory: original.appending(path: "workspace").path)])
        await app.workspace.refresh()
        mac.on("GET", "/api/session/\(session)/inbox", json: ["data": []])
        mac.on("GET", "/api/experimental/session/\(session)/export", json: Self.exported(session, directory: original.appending(path: "workspace").path, bot: id))
        let tries = Counter()
        box.on("POST", "/api/experimental/session/import") { request in
            guard tries.next() > 1 else { return StubWeb.json(["_tag": "ConflictError", "message": "Session already exists"], status: 409) }
            return StubWeb.json(["data": StubEngine.session(session, title: "Scout", directory: (request.body["location"] as? [String: Any])?["directory"] as? String ?? "")])
        }

        try await app.moves.move(bot: id, to: "box")

        #expect(box.requests("DELETE", "/api/session/\(session)").count == 1)
        #expect(app.bots.bot(id)?.machine == "box")
    }

    /// The app quit mid-move. One still copying is taken back (the original as it was); one that
    /// had switched is finished (the original goes).
    @Test func aMoveCutShortIsTakenBackOrFinished() async throws {
        defer { Self.clean(); mac.stop() }
        // Copying: the original held for it, a half copy there.
        let first = try botFolder(Bots.root, id: "bot_scout00006", session: "ses_scout6")
        try Data(Moves.hold.utf8).write(to: first.appending(path: "paused"))
        let half = boxRoot.appending(path: "bots/bot_scout00006")
        try FileManager.default.createDirectory(at: half, withIntermediateDirectories: true)
        // Switched: the copy is the bot now; the original still where it was.
        let second = try botFolder(boxRoot.appending(path: "bots"), id: "bot_scout00007", session: "ses_scout7")
        try saveBots([bot("bot_scout00006", folder: first, session: "ses_scout6"),
                      bot("bot_scout00007", folder: Bots.root.appending(path: "bot_scout00007"), session: "ses_scout7")])
        let records: [[String: Any]] = [
            ["kind": "bot", "id": "bot_scout00006", "sessions": ["ses_scout6"], "to": "box", "original": first.path, "copy": half.path, "wasPaused": false, "stage": "copying"],
            ["kind": "bot", "id": "bot_scout00007", "sessions": ["ses_scout7"], "from": "box", "original": second.path, "copy": Bots.root.appending(path: "bot_scout00007").path, "wasPaused": false, "stage": "switched"],
        ]
        UserDefaults.standard.set(try JSONSerialization.data(withJSONObject: records), forKey: "movesUnderWay")
        let app = app()
        box.on("GET", "/api/experimental/session/ses_scout7/export", json: Self.exported("ses_scout7", directory: second.path, bot: "bot_scout00007"))

        await app.moves.recover()

        // Taken back: its copy there gone, its wake-ups going on here.
        #expect(box.requests("DELETE", "/api/session/ses_scout6").count == 1)
        #expect(!FileManager.default.fileExists(atPath: half.path))
        #expect(!FileManager.default.fileExists(atPath: first.appending(path: "paused").path))
        // Finished: its original gone from the machine, in the trash there with its conversation.
        #expect(box.requests("DELETE", "/api/session/ses_scout7").count == 1)
        #expect(!FileManager.default.fileExists(atPath: second.path))
        #expect(trashed("bot_scout00007", in: boxRoot.appending(path: "trash")) != nil)
        #expect(UserDefaults.standard.data(forKey: "movesUnderWay") == nil)
    }

    /// The app quit after the move switched, before the bot itself went over to its copy: at the
    /// next launch it does (its wake-ups going on there), and the original goes.
    @Test func aBotCutShortBeforeItWentOverGoesOverToItsCopy() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "bot_scout00008", session = "ses_scout8"
        let original = try botFolder(Bots.root, id: id, session: session)
        try Data(Moves.hold.utf8).write(to: original.appending(path: "paused"))
        let copy = try botFolder(boxRoot.appending(path: "bots"), id: id, session: session)
        try Data(Moves.hold.utf8).write(to: copy.appending(path: "paused"))
        try saveBots([bot(id, folder: original, session: session)])
        let records: [[String: Any]] = [["kind": "bot", "id": id, "sessions": [session], "original": original.path, "to": "box", "copy": copy.path, "wasPaused": false, "stage": "switched"]]
        UserDefaults.standard.set(try JSONSerialization.data(withJSONObject: records), forKey: "movesUnderWay")
        let app = app()
        box.on("GET", "/api/session/\(session)", json: ["data": StubEngine.session(session, title: "Scout", directory: copy.appending(path: "workspace").path)])
        mac.on("GET", "/api/experimental/session/\(session)/export", json: Self.exported(session, directory: original.appending(path: "workspace").path, bot: id))
        // The machine away at launch: nothing goes to it where it was meanwhile (it'd be lost there).
        let boxAPI = app.workspace.machineAPI
        app.workspace.machineAPI = { _ in nil }
        await app.moves.recover()
        #expect(Moves.isFrozen(id) && Moves.isFrozen(session))
        #expect(app.bots.bot(id)?.machine == nil)
        app.workspace.machineAPI = boxAPI

        await app.moves.recover()

        let moved = try #require(app.bots.bot(id))
        #expect(moved.machine == "box" && moved.folder == copy.path)
        #expect(!FileManager.default.fileExists(atPath: copy.appending(path: "paused").path), "its wake-ups go on there")
        #expect(mac.requests("DELETE", "/api/session/\(session)").count == 1)
        #expect(!FileManager.default.fileExists(atPath: original.path))
        #expect(UserDefaults.standard.data(forKey: "movesUnderWay") == nil)
        #expect(!Moves.isFrozen(id) && !Moves.isFrozen(session), "it takes messages where it is now")
    }

    /// A move taken back whose copy couldn't be taken away (the machine didn't answer): the copy
    /// isn't the chat meanwhile, and it's taken away when the machine answers again. A pause of
    /// yours stays.
    @Test func aCopyThatCouldntBeTakenAwayIsTriedAgain() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "ses_chat3"
        let wakes = WakeUps.root.appending(path: id)
        try FileManager.default.createDirectory(at: wakes.appending(path: "wakes"), withIntermediateDirectories: true)
        try Data("paused".utf8).write(to: wakes.appending(path: "paused"))
        let app = app()
        mac.list([StubEngine.session(id, title: "Trip plans", directory: Workspace.chatsFolder)])
        await app.workspace.refresh()
        mac.on("GET", "/api/session/\(id)/inbox", json: ["data": []])
        // Read once; then its engine stops answering, before the move could switch.
        let reads = Counter()
        mac.on("GET", "/api/experimental/session/\(id)/export") { _ in
            reads.next() == 1 ? StubWeb.json(Self.exported(id, directory: Workspace.chatsFolder, bot: nil)) : StubWeb.json(["message": "Gone away"], status: 500)
        }
        takesImports(box)
        box.on("DELETE", "/api/session/\(id)", json: ["message": "Busy"], status: 500)

        await #expect(throws: (any Error).self) { try await app.moves.move(chat: id, to: "box") }

        #expect(UserDefaults.standard.data(forKey: "movesUnderWay") != nil, "still to be taken away")
        #expect(app.workspace.movedAway[id] == .some("box"), "what the machine says of its copy isn't about the chat")
        #expect(app.workspace.session(id)?.location.directory == Workspace.chatsFolder)
        #expect(FileManager.default.fileExists(atPath: wakes.appending(path: "paused").path), "your pause stays")
        box.on("DELETE", "/api/session/\(id)", json: [:])
        await app.moves.recover()
        #expect(box.requests("DELETE", "/api/session/\(id)").count == 2)
        #expect(UserDefaults.standard.data(forKey: "movesUnderWay") == nil)
        #expect(app.workspace.movedAway[id] == nil)
        #expect(FileManager.default.fileExists(atPath: wakes.appending(path: "paused").path))
    }

    /// Two names for one computer, not yet found to be one: nothing moves, and nothing goes.
    @Test func aMoveToTheSameComputerUnderAnotherNameIsRefused() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "bot_scout00009", session = "ses_scout9"
        let original = try botFolder(Bots.root, id: id, session: session)
        try saveBots([bot(id, folder: original, session: session)])
        let app = app()
        app.moves.transport = OneComputer()
        mac.list([StubEngine.session(session, title: "Scout", directory: original.appending(path: "workspace").path)])
        await app.workspace.refresh()
        mac.on("GET", "/api/session/\(session)/inbox", json: ["data": []])
        mac.on("GET", "/api/experimental/session/\(session)/export", json: Self.exported(session, directory: original.appending(path: "workspace").path, bot: id))
        takesImports(box)

        do {
            try await app.moves.move(bot: id, to: "box")
            Issue.record("it moved")
        } catch {
            #expect(error.localizedDescription.contains("another address"), "\(error.localizedDescription)")
        }

        #expect(box.requests("POST", "/api/experimental/session/import").isEmpty)
        #expect(mac.requests("DELETE", "/api/session/\(session)").isEmpty && box.requests("DELETE", "/api/session/\(session)").isEmpty)
        #expect(FileManager.default.fileExists(atPath: original.appending(path: "workspace/notes.txt").path))
        #expect(!FileManager.default.fileExists(atPath: original.appending(path: "paused").path))
        #expect(app.bots.bot(id)?.machine == nil)
        #expect(UserDefaults.standard.data(forKey: "movesUnderWay") == nil)
    }

    /// A chat come to this Mac from a machine waits for nothing there, its subagents' conversations
    /// get no rows of their own, and what the machine says of its original isn't about it.
    @Test func aChatFromAMachineLivesOnThisMacAlone() async throws {
        defer { Self.clean(); mac.stop() }
        let id = "ses_chat4", child = "ses_chat4_child"
        let chats = boxRoot.appending(path: "chats").path
        let app = app()
        app.workspace.add(try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject:
            StubEngine.session(id, title: "Trip plans", directory: RemoteFolder.folder(chats, on: "box")))))
        #expect(app.workspace.waitingMachine(for: id) == "box")
        box.list([StubEngine.session(id, title: "Trip plans", directory: chats),
                  StubEngine.session(child, title: "Research", directory: chats, extra: ["parentID": id])])
        box.on("GET", "/api/session/\(id)/inbox", json: ["data": []])
        box.on("GET", "/api/experimental/session/\(id)/export", json: Self.exported(id, directory: chats, bot: nil))
        box.on("GET", "/api/experimental/session/\(child)/export", json: Self.exported(child, directory: chats, bot: nil, parent: id))
        takesImports(mac)

        try await app.moves.move(chat: id, to: nil)

        #expect(app.workspace.session(id)?.location.directory == Workspace.chatsFolder)
        #expect(app.workspace.waitingMachine(for: id) == nil, "nothing waits for the machine")
        #expect(!app.workspace.sessions.contains { $0.id == child }, "no row for its subagent")
        #expect(box.requests("DELETE", "/api/session/\(child)").count == 1 && box.requests("DELETE", "/api/session/\(id)").count == 1)
        app.workspace.handle(try box.event("session.deleted", session: id), machine: "box")
        #expect(app.workspace.session(id)?.location.directory == Workspace.chatsFolder)
        #expect(app.workspace.waitingMachine(for: id) == nil)
    }

    @Test func someBotsDontMove() async throws {
        defer { Self.clean(); mac.stop() }
        let folders = try ["bot_project001", "bot_agents0001", "bot_working001"].map { try botFolder(Bots.root, id: $0, session: "ses_" + $0) }
        try saveBots([
            bot("bot_project001", folder: folders[0], session: "ses_bot_project001", extra: ["project": "/Users/me/app"]),
            bot("bot_agents0001", folder: folders[1], session: "ses_bot_agents0001", extra: ["agents": true]),
            bot("bot_working001", folder: folders[2], session: "ses_bot_working001"),
        ])
        let app = app()
        mac.list([StubEngine.session("ses_bot_working001", directory: folders[2].appending(path: "workspace").path)], running: ["ses_bot_working001"])
        await app.workspace.refresh()
        for (id, expected) in [("bot_project001", "projects"), ("bot_agents0001", "coding agent"), ("bot_working001", "working")] {
            do {
                try await app.moves.move(bot: id, to: "box")
                Issue.record("\(id) moved")
            } catch {
                #expect(error.localizedDescription.contains(expected), "\(id): \(error.localizedDescription)")
            }
            #expect(app.bots.bot(id)?.machine == nil)
            #expect(!FileManager.default.fileExists(atPath: boxRoot.appending(path: "bots/\(id)").path))
        }
        #expect(mac.requests("GET", "/export").isEmpty, "nothing was asked for")
    }
}

/// How many times something was asked for, from any thread.
nonisolated private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func next() -> Int { lock.withLock { count += 1; return count } }
}

/// A machine whose `~/.kuvo-code` is a folder here: what goes there over SSH goes there.
struct FolderMachine: MoveTransport {
    let root: URL
    let here = SSHMoveTransport()

    func home(on machine: String?) async throws -> MoveHome {
        guard machine != nil else { return try await here.home(on: nil) }
        for name in ["bots", "wakes", "chats", "trash"] {
            try FileManager.default.createDirectory(at: root.appending(path: name), withIntermediateDirectories: true)
        }
        return MoveHome(root: root.path, bots: root.appending(path: "bots").path, wakes: root.appending(path: "wakes").path, chats: root.appending(path: "chats").path)
    }

    func exists(_ path: String, on machine: String?) async throws -> Bool { try await here.exists(path, on: nil) }
    func pack(_ path: String, on machine: String?, into archive: URL) async throws { try await here.pack(path, on: nil, into: archive) }
    func unpack(_ archive: URL, into parent: String, on machine: String?) async throws { try await here.unpack(archive, into: parent, on: nil) }
    func write(_ data: Data, to path: String, on machine: String?) async throws { try await here.write(data, to: path, on: nil) }
    func remove(_ path: String, on machine: String?) async throws { try await here.remove(path, on: nil) }
    func unpause(_ folder: String, on machine: String?) async throws { try await here.unpause(folder, on: nil) }

    func trash(_ path: String, on machine: String?) async throws {
        guard machine != nil else { return try await here.trash(path, on: nil) }
        guard FileManager.default.fileExists(atPath: path) else { return }
        let into = root.appending(path: "trash/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: into, withIntermediateDirectories: true)
        try FileManager.default.moveItem(atPath: path, toPath: into.appending(path: (path as NSString).lastPathComponent).path)
    }
}

/// A machine that's this Mac at another name: its Kuvo Code folder is this Mac's.
private struct OneComputer: MoveTransport {
    let here = SSHMoveTransport()

    func home(on machine: String?) async throws -> MoveHome { try await here.home(on: nil) }
    func exists(_ path: String, on machine: String?) async throws -> Bool { try await here.exists(path, on: nil) }
    func pack(_ path: String, on machine: String?, into archive: URL) async throws { try await here.pack(path, on: nil, into: archive) }
    func unpack(_ archive: URL, into parent: String, on machine: String?) async throws { try await here.unpack(archive, into: parent, on: nil) }
    func write(_ data: Data, to path: String, on machine: String?) async throws { try await here.write(data, to: path, on: nil) }
    func remove(_ path: String, on machine: String?) async throws { try await here.remove(path, on: nil) }
    func unpause(_ folder: String, on machine: String?) async throws { try await here.unpause(folder, on: nil) }
    func trash(_ path: String, on machine: String?) async throws { try await here.trash(path, on: nil) }
}
