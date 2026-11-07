import ClientDesign
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The first launch after an update brings what you keep up to date, once: the window says
/// it's updating, a backup of your lists and settings is made first, and each bot gets its
/// description beside its memory, while its list stays as an older version wrote it. A new install
/// has nothing to back up or say. What an earlier version had waiting for a machine waits for it
/// here. A list of machines that won't read is set aside, not written over.
@MainActor
@Suite(.serialized) struct CalibrationTests {
    var botsFile: URL { AppInfo.supportDirectory.appending(path: "bots.json") }

    init() {
        TestEnvironment.prepare()
        Self.clean()
    }

    private static func clean() {
        for key in [Calibration.key, Calibration.backedUpKey, "calibrationTestMarker", "botEditsWaiting", "botEditOutbox"] + Backups.settings {
            UserDefaults.standard.removeObject(forKey: key)
        }
        for name in Backups.files + ["Backups", "bots"] {
            try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: name))
        }
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix(Machines.unreadableKey) {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    /// A bot's folder on this Mac, with its memory.
    private func folder(_ id: String, memory: String) throws -> URL {
        let folder = Bots.root.appending(path: id)
        try FileManager.default.createDirectory(at: folder.appending(path: "workspace"), withIntermediateDirectories: true)
        try Data(memory.utf8).write(to: folder.appending(path: "MEMORY.md"))
        return folder
    }

    /// `bots.json` as Kuvo Code wrote it before descriptions: one bot on this Mac, one on a machine.
    private func savedBefore(macFolder: URL) -> Data {
        Data("""
            [
              {
                "agents" : null, "created" : "2026-10-01T09:00:00Z", "folder" : "\(macFolder.path)",
                "id" : "bot_scout00001", "instructions" : "Watches the build", "job" : "Watches the build",
                "jobInMemory" : true, "look" : { "color" : "sky", "face" : "calm", "shape" : "round" },
                "model" : { "id" : "big-pickle", "providerID" : "opencode" }, "name" : "Scout",
                "personality" : null, "sessionID" : "ses_scout"
              },
              {
                "created" : "2026-10-02T09:00:00Z", "folder" : "/home/me/.kuvo-code/bots/bot_away000001",
                "id" : "bot_away000001", "instructions" : "", "job" : "", "jobInMemory" : true,
                "look" : { "color" : "mint", "face" : "happy", "shape" : "gem" }, "machine" : "my-server",
                "name" : "Away", "sessionID" : "ses_away"
              }
            ]
            """.utf8)
    }

    private static func descriptor(in folder: URL) throws -> Bot.Descriptor {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(Bot.Descriptor.self, from: Data(contentsOf: folder.appending(path: Bot.Descriptor.file)))
    }

    @Test func theFirstLaunchAfterAnUpdateBacksUpThenUpdates() async throws {
        defer { Self.clean() }
        let scout = try folder("bot_scout00001", memory: "# Scout's memory\n\n## Job\nWatches the build\n")
        let saved = savedBefore(macFolder: scout)
        try saved.write(to: botsFile)
        UserDefaults.standard.set("kept", forKey: "calibrationTestMarker")

        let app = AppModel()
        #expect(app.calibration.isRunning, "the window says it's updating from its first moment")
        await app.calibration.run(app)
        #expect(!app.calibration.isRunning)
        #expect(UserDefaults.standard.integer(forKey: Calibration.key) == Calibration.current)

        // A backup first: the list as it was, and the settings.
        let backups = try FileManager.default.contentsOfDirectory(at: Backups.folder, includingPropertiesForKeys: nil)
        #expect(backups.count == 1)
        let backup = try #require(backups.first)
        #expect(try Data(contentsOf: backup.appending(path: "bots.json")) == saved)
        let settings = try PropertyListSerialization.propertyList(from: Data(contentsOf: backup.appending(path: "settings.plist")), format: nil) as? [String: Any]
        #expect(settings?["calibrationTestMarker"] as? String == "kept")

        // The Mac bot's description beside its memory; the list as an older version wrote it.
        let described = try Self.descriptor(in: scout)
        #expect(described.kuvo == 1)
        #expect(described.id == "bot_scout00001" && described.name == "Scout" && described.job == "Watches the build")
        #expect(described.look == BotLook(color: .sky, shape: .round, face: .calm))
        #expect(described.model == ModelRef(id: "big-pickle", providerID: "opencode"))
        #expect(described.project == nil)
        #expect(described.updated == described.created, "not changed since it was made")
        #expect(try Data(contentsOf: botsFile) == saved)

        // Once: the next launch has nothing to do.
        let next = AppModel()
        #expect(!next.calibration.isRunning)
        await next.calibration.run(next)
        #expect(try FileManager.default.contentsOfDirectory(atPath: Backups.folder.path).count == 1)
    }

    @Test func aNewInstallHasNothingToBackUpOrSay() async {
        defer { Self.clean() }
        #expect(!Backups.hasData)
        let app = AppModel()
        #expect(!app.calibration.isRunning)
        await app.calibration.run(app)
        #expect(!FileManager.default.fileExists(atPath: Backups.folder.path))
        #expect(UserDefaults.standard.integer(forKey: Calibration.key) == Calibration.current)
    }

    @Test func onlyTheNewestBackupsStay() throws {
        defer { Self.clean() }
        try Data("[]".utf8).write(to: botsFile)
        // Noon, so the day is the same in any time zone.
        for day in 0..<5 { #expect(Backups.make(now: Date(timeIntervalSince1970: Double(day) * 86_400 + 43_200)) != nil) }
        let names = try FileManager.default.contentsOfDirectory(atPath: Backups.folder.path).sorted()
        #expect(names.count == Backups.kept)
        #expect(names.first?.hasPrefix("1970-01-03") == true)
        #expect(names.last?.hasPrefix("1970-01-05") == true)
    }

    /// One left half made (the app quit while it copied) never counts, and goes with the next.
    @Test func aBackupCutShortDoesntCount() throws {
        defer { Self.clean() }
        try Data("[]".utf8).write(to: botsFile)
        let cut = Backups.folder.appending(path: ".partial-left-from-before")
        try FileManager.default.createDirectory(at: cut, withIntermediateDirectories: true)
        #expect(Backups.make() != nil)
        let names = try FileManager.default.contentsOfDirectory(atPath: Backups.folder.path)
        #expect(names.count == 1 && names.first?.hasPrefix(".") == false)
    }

    /// An update's steps tried again at a later launch (one failed, or the app quit) make no
    /// second backup, which could push the one from before the update out; two starts of the
    /// engine at once run the steps once, the second waiting for the first.
    @Test func oneBackupForAnUpdateAndOneRunAtATime() async throws {
        defer { Self.clean() }
        let scout = try folder("bot_scout00001", memory: "# Scout's memory\n")
        try savedBefore(macFolder: scout).write(to: botsFile)

        let app = AppModel()
        async let first: Void = app.calibration.run(app)
        async let second: Void = app.calibration.run(app)
        _ = await (first, second)
        #expect(try FileManager.default.contentsOfDirectory(atPath: Backups.folder.path).count == 1)
        #expect(FileManager.default.fileExists(atPath: scout.appending(path: Bot.Descriptor.file).path))

        // Its steps not marked done (as if one had failed): tried again, without a new backup.
        UserDefaults.standard.removeObject(forKey: Calibration.key)
        let again = AppModel()
        #expect(again.calibration.isRunning)
        await again.calibration.run(again)
        #expect(try FileManager.default.contentsOfDirectory(atPath: Backups.folder.path).count == 1)
        #expect(UserDefaults.standard.integer(forKey: Calibration.key) == Calibration.current)
    }

    /// What you changed of a machine's bot while it was away, which an earlier version kept in its
    /// list to tell the machine, waits for that machine here, shown as you left it; what the
    /// earlier version kept stays for it.
    @Test func aChangeAnEarlierVersionHadWaitingForAMachineWaitsHere() async throws {
        defer { Self.clean() }
        let scout = try folder("bot_scout00001", memory: "# Scout's memory\n")
        try savedBefore(macFolder: scout).write(to: botsFile)
        UserDefaults.standard.set(["bot_away000001": ["name", "instructions"]], forKey: "botEditsWaiting")

        let app = AppModel()
        await app.calibration.run(app)
        let waiting = try #require(app.bots.edits.waiting["bot_away000001"])
        #expect(waiting.box == "my-server")
        #expect(waiting.fields["name"]?.string == "Away")
        #expect(waiting.fields["look"]?["color"]?.string == "mint")
        #expect(app.bots.waitingFor(try #require(app.bots.bot("bot_away000001"))) == "my-server")
        #expect(app.bots.edits.waiting["bot_scout00001"] == nil, "this Mac's own bot waits for nothing")
        #expect(UserDefaults.standard.dictionary(forKey: "botEditsWaiting") != nil, "kept for the earlier version")
        // Kept across launches, until its machine takes it.
        #expect(BotEdits().waiting["bot_away000001"] == waiting)
    }

    /// A bot of this Mac whose folder an earlier version left without a description or a note of its
    /// conversation (one written half, or not at all) is still there once this Mac's box keeps its
    /// bots: the update writes them, and one whose folder is here is never let go of because its box
    /// can't read it.
    @Test func aBotWhoseFolderIsMissingWhatItsBoxReadsStaysAfterTheUpdate() async throws {
        defer { Self.clean() }
        let scout = try folder("bot_scout00001", memory: "# Scout's memory\n\n## Job\nWatches the build\n")
        try Data("{\"kuvo\": 1, \"id\": \"bot_sco".utf8).write(to: scout.appending(path: Bot.Descriptor.file))
        try savedBefore(macFolder: scout).write(to: botsFile)
        let engine = StubEngine(port: 47_982)
        defer { engine.stop() }
        let box = try await TestBox(engine: engine.url)
        defer { box.stop() }

        let app = AppModel()
        app.bots.app = app
        app.bots.boxes = { _ in box.client(engine: engine.url) }
        // Before the update: its box can't read it, and it stays all the same.
        await app.bots.refresh(BoxClient.mac)
        #expect(app.bots.bot("bot_scout00001")?.name == "Scout", "its folder is here")
        await app.calibration.run(app)
        await app.bots.refresh(BoxClient.mac)
        struct Listed: Decodable { var bots: [ListedBot] }
        let listed = try await box.client(engine: engine.url).value(Listed.self, "GET", "kuvo/bots").bots
        #expect(listed.map(\.id) == ["bot_scout00001"], "its box finds it now")
        #expect(listed.first?.session == "ses_scout")
        #expect(app.bots.bot("bot_scout00001")?.job == "Watches the build")
    }

    /// What's kept of your machines is one file the box reads too; the settings they were in before
    /// give them up only once the file holds them.
    @Test func theListMovesToItsFileAndStaysThere() throws {
        defer { Self.clean() }
        let before = [Machine(destination: "lab", otherAddresses: ["lab.tail"], identity: "a", reachedAt: "lab.tail"), Machine(destination: "vps")]
        UserDefaults.standard.set(try JSONEncoder().encode(before), forKey: "machines")
        #expect(Machines.anySaved, "before anything moved it")
        let machines = Machines()
        #expect(machines.list == before)
        #expect(try JSONDecoder().decode([Machine].self, from: Data(contentsOf: Machines.file)) == before)
        #expect(UserDefaults.standard.object(forKey: "machines") == nil)
        machines.add("gpu")
        machines.addAddress("lab.local", to: "lab")
        let later = Machines()
        #expect(later.list.map(\.id) == ["lab", "vps", "gpu"])
        #expect(later.list.first?.otherAddresses == ["lab.tail", "lab.local"])
        #expect(Machines.anySaved)
    }

    @Test func theKeeperMovesTheListAsTheAppDoes() throws {
        defer { Self.clean() }
        UserDefaults.standard.set(try JSONEncoder().encode([Machine(destination: "lab")]), forKey: "machines")
        Machines.moveFromSettings()
        #expect(try JSONDecoder().decode([Machine].self, from: Data(contentsOf: Machines.file)).map(\.id) == ["lab"])
        #expect(UserDefaults.standard.object(forKey: "machines") == nil)
        // With a file there, what an older version added joins it, for the box too.
        UserDefaults.standard.set(try JSONEncoder().encode([Machine(destination: "old")]), forKey: "machines")
        Machines.moveFromSettings()
        #expect(try JSONDecoder().decode([Machine].self, from: Data(contentsOf: Machines.file)).map(\.id) == ["lab", "old"])
        #expect(UserDefaults.standard.object(forKey: "machines") == nil)
    }

    /// A folder that can't be written: the list stays in the settings, changes to it too, and reaches
    /// the file once it can.
    @Test func aFileThatCantBeWrittenLosesNothing() throws {
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: Machines.file.deletingLastPathComponent().path)
            Self.clean()
        }
        let folder = Machines.file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: folder.path)
        UserDefaults.standard.set(try JSONEncoder().encode([Machine(destination: "lab")]), forKey: "machines")
        let machines = Machines()
        #expect(machines.list.map(\.id) == ["lab"])
        #expect(UserDefaults.standard.object(forKey: "machines") != nil || UserDefaults.standard.object(forKey: "machines.unsaved") != nil, "never out of the settings")
        machines.add("gpu")
        #expect(Machines().list.map(\.id) == ["lab", "gpu"])
        #expect(Machines.anySaved)

        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
        #expect(Machines().list.map(\.id) == ["lab", "gpu"])
        #expect(try JSONDecoder().decode([Machine].self, from: Data(contentsOf: Machines.file)).map(\.id) == ["lab", "gpu"])
        #expect(UserDefaults.standard.object(forKey: "machines") == nil)
        #expect(UserDefaults.standard.object(forKey: "machines.unsaved") == nil)
    }

    /// Removed while the file can't be written, it stays removed: what's in the settings then is the
    /// whole list, not something to add to the file's.
    @Test func oneRemovedWhileTheFileCantBeWrittenDoesntComeBack() throws {
        let folder = Machines.file.deletingLastPathComponent()
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
            Self.clean()
        }
        let machines = Machines()
        machines.add("lab")
        machines.add("vps")
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: folder.path)
        machines.remove("lab", uninstall: false)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
        #expect(Machines().list.map(\.id) == ["vps"])
        #expect(try JSONDecoder().decode([Machine].self, from: Data(contentsOf: Machines.file)).map(\.id) == ["vps"])
    }

    /// A file that won't read isn't an empty list: left as it is, and what's written next goes beside it.
    @Test func aFileThatWontReadIsNeverWrittenOver() throws {
        defer {
            for name in (try? FileManager.default.contentsOfDirectory(at: Machines.file.deletingLastPathComponent(), includingPropertiesForKeys: nil)) ?? [] where name.lastPathComponent.hasPrefix("machines.unreadable") {
                try? FileManager.default.removeItem(at: name)
            }
            Self.clean()
        }
        let damaged = Data("[{\"destination\": 42}]".utf8)
        try FileManager.default.createDirectory(at: Machines.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try damaged.write(to: Machines.file)
        let machines = Machines()
        #expect(machines.list.isEmpty)
        #expect(try Data(contentsOf: Machines.file) == damaged, "left as it is, however many launches find it")
        #expect(Machines.anySaved, "may well have some")
        machines.add("gpu")
        #expect(Machines().list.map(\.id) == ["gpu"])
        let beside = try FileManager.default.contentsOfDirectory(at: Machines.file.deletingLastPathComponent(), includingPropertiesForKeys: nil).filter { $0.lastPathComponent.hasPrefix("machines.unreadable") }
        #expect(beside.count == 1)
        #expect(try beside.first.map { try Data(contentsOf: $0) } == damaged)
    }

    /// One that wouldn't read at launch and reads by the time something's saved (a newer version wrote
    /// it, say) still isn't written over, and one that can't be set aside stays as it is, with what's
    /// new in the settings.
    @Test func aFileThatDidntReadAtLaunchIsStillKept() throws {
        let folder = Machines.file.deletingLastPathComponent()
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
            for name in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] where name.lastPathComponent.contains("unreadable") {
                try? FileManager.default.removeItem(at: name)
            }
            Self.clean()
        }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("{ not json".utf8).write(to: Machines.file)
        let machines = Machines()
        let later = try JSONEncoder().encode([Machine(destination: "vps")])
        try later.write(to: Machines.file)
        machines.add("gpu")
        #expect(try JSONDecoder().decode([Machine].self, from: Data(contentsOf: Machines.file)).map(\.id) == ["gpu"])
        let beside = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil).filter { $0.lastPathComponent.contains("unreadable") }
        #expect(try beside.map { try Data(contentsOf: $0) } == [later])

        let damaged = Data("{ not json".utf8)
        try damaged.write(to: Machines.file)
        let stuck = Machines()
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: folder.path)
        stuck.add("lab")
        #expect(try Data(contentsOf: Machines.file) == damaged)
        #expect(UserDefaults.standard.object(forKey: "machines.unsaved") != nil, "what's new stays in the settings")
        #expect(stuck.fileDidntRead, "still not known to be none")
    }

    /// Back to an older version, which keeps its own list and sees nothing of this one, and forward
    /// again: what you added there joins what you had, and nothing's written over.
    @Test func goingBackToAnOlderVersionAndForwardAgainKeepsThemAll() throws {
        defer { Self.clean() }
        try FileManager.default.createDirectory(at: Machines.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode([Machine(destination: "lab"), Machine(destination: "vps", otherAddresses: ["vps.tail"])]).write(to: Machines.file)
        UserDefaults.standard.set(try JSONEncoder().encode([Machine(destination: "vps"), Machine(destination: "gpu")]), forKey: "machines")
        let machines = Machines()
        #expect(machines.list.map(\.id) == ["lab", "vps", "gpu"])
        #expect(machines.list.first { $0.id == "vps" }?.otherAddresses == ["vps.tail"], "what the file knows of one in both stays")
        #expect(try JSONDecoder().decode([Machine].self, from: Data(contentsOf: Machines.file)) == machines.list)
        #expect(UserDefaults.standard.object(forKey: "machines") == nil)
    }

    @Test func machinesInTheSettingsThatWontReadAreSetAsideNotOverwritten() {
        defer { Self.clean() }
        let damaged = Data("[{\"destination\": 42}]".utf8)
        UserDefaults.standard.set(damaged, forKey: "machines")
        let machines = Machines()
        #expect(machines.list.isEmpty)
        let aside = UserDefaults.standard.dictionaryRepresentation().filter { $0.key.hasPrefix(Machines.unreadableKey) }
        #expect(aside.count == 1)
        #expect(aside.first?.value as? Data == damaged)
        // Once, however many launches find it there.
        _ = Machines()
        #expect(UserDefaults.standard.dictionaryRepresentation().filter { $0.key.hasPrefix(Machines.unreadableKey) }.count == 1)
    }
}
