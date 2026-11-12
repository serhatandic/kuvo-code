import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Kuvo Code opening on a Mac you set up as a machine (#183, PROTOCOL.md "Already in a setup?"):
/// the box already there, a member of MacBook's setup, is the one it uses, in place. It asks the
/// box's own CLI (`kuvo-link.js here`, run as the app runs its box: by the engine, here a stand-in
/// that hands it to Node) before anything of its own, and starts, claims or registers no box: its
/// box's folder is never made. With nothing there, it opens as it always has. State only, in a home
/// folder of the test's own.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct AttachInPlaceTests {
    let engine = StubEngine(port: 47_183)
    let folder = AppInfo.testRoot.appending(path: "Attach-\(UUID().uuidString.prefix(6))")
    var home: URL { folder.appending(path: "home") }

    /// The engine's stand-in: the box's script it's asked to run goes to Node; otherwise it says
    /// where it answers (the stub) and runs until its folder goes.
    private func fakeEngine(hereFails: Bool = false) throws -> URL {
        let node = try #require(TestBox.node)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let script = """
            #!/bin/sh
            \(hereFails ? "[ \"$5\" = here ] && exit 3" : "")
            case "$5" in here|box) shift 3; exec '\(node.path(percentEncoded: false))' "$@";; esac
            [ "$1" = "run" ] && exit 1
            echo '{"url":"\(engine.url)"}'
            while [ -d '\(folder.path(percentEncoded: false))' ]; do sleep 0.05; done
            """
        let file = folder.appending(path: "opencode")
        try script.write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path(percentEncoded: false))
        return file
    }

    private func write(_ value: [String: Any], to path: String) throws {
        let url = home.appending(path: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: value).write(to: url)
    }

    /// The engine's databases in its data folder (`opencode.db` and the like), as it keeps them.
    private var databases: [URL] {
        let data = AppModel.engineFolders.dataDirectory
        let files = (try? FileManager.default.contentsOfDirectory(atPath: data.path)) ?? []
        return files.filter { $0.hasPrefix("opencode") && $0.hasSuffix(".db") }.map { data.appending(path: $0) }
    }

    /// The engine's stand-in, with `setUp`'s home; `ownSessions`: this app's own engine kept your
    /// sessions before, its database where the engine keeps it.
    private func prepared(ownSessions: Bool = false, hereFails: Bool = false, _ setUp: () throws -> Void) throws -> URL {
        let binary = try fakeEngine(hereFails: hereFails)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try setUp()
        try? FileManager.default.removeItem(at: BoxProcess.home)
        for database in databases { try? FileManager.default.removeItem(at: database) }
        if ownSessions {
            let data = AppModel.engineFolders.dataDirectory
            try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
            try Data().write(to: data.appending(path: "opencode.db"))
        }
        AppModel.hereHome = home
        // (No projects of another test's: a new session with none is a chat.)
        for key in ["projectFolders", "projectSettings", "worktrees"] { UserDefaults.standard.removeObject(forKey: key) }
        return binary
    }

    /// Started, as `prepared`.
    private func started(ownSessions: Bool = false, hereFails: Bool = false, _ setUp: () throws -> Void) async throws -> AppModel {
        let binary = try prepared(ownSessions: ownSessions, hereFails: hereFails, setUp)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        AppModel.attachesInPlace = true
        let app = AppModel()
        await app.start()
        return app
    }

    private func cleanUp(_ app: AppModel?) {
        app?.stop()
        AppModel.attachesInPlace = false
        BackgroundWork.heldBack = nil
        for database in databases { try? FileManager.default.removeItem(at: database) }
        AppModel.hereHome = AppModel.defaultHereHome
        SSHConnection.thisMacHome = AppModel.defaultHereHome.path(percentEncoded: false)
        MachineEngine.standIn = nil
        BoxClient.thisMac = BoxClient.mac
        unsetenv("KUVO_OPENCODE_BINARY")
        try? FileManager.default.removeItem(at: folder)
        engine.stop()
    }

    /// The card of the box in the machines' folder, as it is now.
    private func card() -> [String: Any]? {
        let file = home.appending(path: "\(RemoteEngineInstaller.root)/run/setup-card.json")
        return (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    /// MacBook set up this Mac as a machine, and hasn't been heard from for 40 days. Its box `runs`:
    /// its keeper running (`bin/kuvo-start keep`, until the test's folder goes), stopped (its way to
    /// start there: which starts its keeper, as a box's does, where it `starts`), or gone (MacBook
    /// removed it: its way to start went, its card stayed).
    private func memberOfMacBooks(runs: Here.Runs = .running, starts: Bool = true) throws {
        let box = home.appending(path: RemoteEngineInstaller.root)
        if runs != .gone {
            let start = box.appending(path: "bin/kuvo-start")
            let pid = box.appending(path: "run/box.pid").path(percentEncoded: false)
            try FileManager.default.createDirectory(at: start.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: box.appending(path: "run"), withIntermediateDirectories: true)
            try """
                #!/bin/sh
                if [ "$1" = keep ]; then while [ -d '\(folder.path(percentEncoded: false))' ]; do sleep 0.2; done; exit 0; fi
                \(starts ? "sh \"$0\" keep </dev/null >/dev/null 2>&1 & echo $! >'\(pid)'" : "exit 0")

                """.write(to: start, atomically: true, encoding: .utf8)
            // Its own engine and CLI (`box route`), which tell what ran them.
            let node = try #require(TestBox.node)
            let engine = box.appending(path: "engine/\(OpenCodeEngine.version)/opencode")
            try FileManager.default.createDirectory(at: engine.deletingLastPathComponent(), withIntermediateDirectories: true)
            try "#!/bin/sh\nshift 2\nexec '\(node.path(percentEncoded: false))' \"$@\"\n".write(to: engine, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path(percentEncoded: false))
            try """
                const fs = require("fs"), path = require("path"), run = path.join(process.env.KUVO_HOME, "run");
                fs.writeFileSync(path.join(run, "app-attached.json"), "{}");
                fs.writeFileSync(path.join(run, "setup-card.json"), JSON.stringify({ app: true, by: "its own" }));
                // (Where its chats go, as its `kuvo/info` says; every route answers the same.)
                console.log(JSON.stringify({ status: 200, body: JSON.stringify({ chats: path.join(process.env.KUVO_HOME, "box-chats") }) }));

                """.write(to: box.appending(path: "bin/kuvo-link.js"), atomically: true, encoding: .utf8)
            if runs == .running {
                let keeper = Process()
                keeper.executableURL = URL(filePath: "/bin/sh")
                keeper.arguments = [start.path(percentEncoded: false), "keep"]
                try keeper.run()
                try Data(String(keeper.processIdentifier).utf8).write(to: box.appending(path: "run/box.pid"))
            }
        }
        let heard = (Date.now.timeIntervalSince1970 - 40 * 86_400) * 1000
        try write(["setup": "set_" + String(repeating: "m", count: 22), "epoch": 1, "role": "member",
                   "primary": ["key": String(repeating: "B", count: 43), "name": "MacBook", "heard": heard],
                   "self": ["key": String(repeating: "M", count: 43), "name": "Mini", "kind": "machine"], "app": false,
                   "computers": 2, "items": 9, "heldBy": [], "macs": [["key": String(repeating: "B", count: 43), "name": "MacBook"]]],
                  to: "\(RemoteEngineInstaller.root)/run/setup-card.json")
    }

    @Test func aMacMiniMacBookSetUpKeepsItsOneBox() async throws {
        var app: AppModel?
        defer { cleanUp(app) }
        app = try await started { try memberOfMacBooks() }
        let attached = try #require(app?.attached)
        #expect(attached.use == .attach && attached.verdict == "elsewhere" && attached.runs == .running)
        #expect(attached.box?.primary?.name == "MacBook" && attached.box?.role == "member")
        #expect(app?.api == nil, "no engine of its own")
        #expect(!BackgroundWork.shared.register() && BackgroundWork.shared.failure?.contains("already here") == true, "Turn On registers no keeper beside it")
        #expect(!FileManager.default.fileExists(atPath: BoxProcess.home.path), "no box of its own: not even its folder")
        // Told so, by its own CLI and engine, its card says Kuvo Code is on this Mac: a Mac adding it
        // asks before it joins.
        #expect(card()?["app"] as? Bool == true && card()?["by"] as? String == "its own")
    }

    /// The box here isn't running now (its keeper ended, and only a login starts it by itself): the
    /// app starts it in place, as its start at login does; and starts nothing of its own.
    @Test func aStoppedBoxIsStartedInPlace() async throws {
        var app: AppModel?
        defer { cleanUp(app) }
        app = try await started { try memberOfMacBooks(runs: .stopped) }
        #expect(app?.attached?.runs == .running)
        #expect(app?.api == nil)
        #expect(!FileManager.default.fileExists(atPath: BoxProcess.home.path))
    }

    /// The window opens on the box here (#333): this Mac is that box, reached as a machine with no SSH,
    /// from its own home folder, named as this Mac; never saved with your machines (whose list is in
    /// the app's own box's folder, never made) nor removed from here; and the app starts no engine.
    @Test func theWindowOpensOnTheBoxHere() async throws {
        var app: AppModel?
        defer { cleanUp(app) }
        // Its connection isn't followed here: only that it's tried.
        MachineEngine.standIn = { _ in nil }
        app = try await started { try memberOfMacBooks() }
        let model = try #require(app)
        #expect(model.engine == .ready && model.api == nil)
        #expect(model.boxes == [.attached] && model.boxInView == .attached && model.thisMacsBox == .attached)
        #expect(model.name(of: .attached) == PhoneLink.computerName)
        let box = try #require(model.machines.engine(SSHConnection.thisMac))
        #expect(box.machine.connection.isLocal && box.machine.name == PhoneLink.computerName)
        #expect(SSHConnection.thisMacHome == home.path(percentEncoded: false))
        #expect(engine.requests("GET", "/api/info").isEmpty, "the app's own engine never started")
        model.removeMachine(SSHConnection.thisMac, uninstall: true)
        #expect(model.machines.engine(SSHConnection.thisMac) != nil, "not removed from here")
        #expect(!FileManager.default.fileExists(atPath: Machines.file.path(percentEncoded: false)) && !FileManager.default.fileExists(atPath: BoxProcess.home.path))
        // Its name is never one of your machines to add.
        #expect(MachineForm.problem(with: SSHConnection.thisMac) == "That’s this Mac.")
    }

    /// What has no computer of its own is on the box here (#333): Settings and ⌘, open on it, this
    /// Mac's own pages with it; a new session with no project is a chat in its chats folder, and a
    /// folder you open is one of its folders; and Settings › Machines offers nothing that would
    /// disconnect, start or remove this Mac's box.
    @Test func whatHasNoComputerIsOnTheBoxHere() async throws {
        var app: AppModel?
        defer { cleanUp(app) }
        MachineEngine.standIn = { _ in nil }
        app = try await started { try memberOfMacBooks() }
        let model = try #require(app)
        // (As ⌘, and Settings… open it, without bringing the window forward.)
        model.settingsTabs.show(.general)
        #expect(model.settingsTabs.page == .general && model.settingsTabs.box == .attached)
        model.settingsTabs.show(.accounts)
        #expect(model.settingsTabs.page == .accounts && model.settingsTabs.box == .attached)
        // Its chats where its box says they go.
        await model.readChatsHere()
        model.tabs.newSession(in: nil, conversation: true)
        let chats = RemoteFolder.folder(home.path(percentEncoded: false) + "/\(RemoteEngineInstaller.root)/box-chats", on: SSHConnection.thisMac)
        #expect(model.tabs.selection == .draft(chats))
        #expect(Workspace.onThisMac("/Users/me/project") == RemoteFolder.folder("/Users/me/project", on: SSHConnection.thisMac))
        #expect(Workspace.box(of: "/Users/me/project") == SSHConnection.thisMac)
    }

    /// A new chat before the box here has said where its chats go: it's asked then, and the chat
    /// opens there.
    @Test func aNewChatAsksTheBoxHereWhereItsChatsGo() async throws {
        var app: AppModel?
        defer { cleanUp(app) }
        MachineEngine.standIn = { _ in nil }
        app = try await started { try memberOfMacBooks() }
        let model = try #require(app)
        model.workspace.attachedChats = nil
        model.tabs.newChat()
        let chats = RemoteFolder.folder(home.path(percentEncoded: false) + "/\(RemoteEngineInstaller.root)/box-chats", on: SSHConnection.thisMac)
        try await until { model.tabs.selection == .draft(chats) }
        #expect(model.tabs.selection == .draft(chats))
    }

    /// The box here went (its Mac removed it) and the app starts again: it runs its own box, and
    /// this Mac shows once, as its own; nothing of the box that was is left listed.
    @Test func aBoxThatWentIsNoLongerListed() async throws {
        var app: AppModel?
        defer { cleanUp(app) }
        MachineEngine.standIn = { _ in nil }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        engine.list([])
        app = try await started { try memberOfMacBooks() }
        let model = try #require(app)
        #expect(model.boxes == [.attached])
        // Its Mac removed it: its way to start and its engine went, its card stayed.
        let box = home.appending(path: RemoteEngineInstaller.root)
        for gone in ["bin", "engine", "run/box.pid"] { try FileManager.default.removeItem(at: box.appending(path: gone)) }
        await model.restart()
        #expect(model.attached == nil && model.engine == .ready)
        #expect(model.boxes == [.mac] && model.machines.engine(SSHConnection.thisMac) == nil)
        #expect(BoxClient.thisMac == BoxClient.mac && model.settingsTabs.box == .mac)
    }

    /// Connected, this Mac's own box offers nothing in Settings › Machines (or to a phone): it's
    /// never disconnected from the window that's on it, nor started or removed from here.
    @Test func thisMacsBoxIsntDisconnectedFromHere() async throws {
        var app: AppModel?
        defer { cleanUp(app) }
        engine.list([])
        engine.on("GET", "/api/mcp", json: ["location": ["directory": "/"], "data": []])
        engine.on("GET", "/api/credential", json: ["data": []])
        let api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: engine.url)!, password: "test"), folderPrefix: RemoteFolder.prefix(for: SSHConnection.thisMac))
        MachineEngine.standIn = { _ in api }
        app = try await started { try memberOfMacBooks() }
        let box = try #require(app?.machines.engine(SSHConnection.thisMac))
        try await until { box.isReady }
        #expect(box.offer == nil, "no Disconnect")
    }

    /// Its routes go to its own CLI here, in its own home folder, with no SSH: as a machine's do.
    @Test func itsRoutesGoToItsOwnCLIHere() async throws {
        var app: AppModel?
        defer { cleanUp(app) }
        MachineEngine.standIn = { _ in nil }
        app = try await started { try memberOfMacBooks() }
        let card = home.appending(path: "\(RemoteEngineInstaller.root)/run/setup-card.json")
        try FileManager.default.removeItem(at: card)
        let (status, _) = try await BoxClient.machine(SSHConnection.thisMac).send("POST", "kuvo/setup/attached")
        #expect(status == 200)
        #expect(self.card()?["by"] as? String == "its own", "answered by the box's own CLI, in its home folder")
    }

    /// One that won't start is said so, to try again, rather than waited on.
    @Test func aBoxThatWontStartIsSaidSo() async throws {
        var app: AppModel?
        defer { cleanUp(app) }
        app = try await started { try memberOfMacBooks(runs: .stopped, starts: false) }
        #expect(app?.attached?.runs == .stopped)
        guard case .failed(let reason) = app?.engine else { Issue.record("waits on it: \(String(describing: app?.engine))"); return }
        #expect(reason.contains("didn’t start"))
        #expect(!FileManager.default.fileExists(atPath: BoxProcess.home.path))
        #expect(card()?["app"] as? Bool == false, "not said attached to a box that didn't start")
    }

    /// Started again by launchd, through the launch agent its Mac put in place, as at login (never
    /// under Kuvo Code's own permissions): started, or loaded where launchd hasn't it loaded yet,
    /// and never by the app then; by its own script only where there's no agent.
    @Test func aStoppedBoxIsStartedByLaunchdWhereItCanBe() throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let own = Here.startCommands(home: home, root: ".kuvo-code", user: 501, real: true)
        #expect(own.map(\.path) == ["/bin/sh"] && own.first?.arguments == [home.appending(path: ".kuvo-code/bin/kuvo-start").path])
        let agent = home.appending(path: "Library/LaunchAgents/\(RemoteServer.launchAgent).plist")
        try FileManager.default.createDirectory(at: agent.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: agent)
        let launchd = Here.startCommands(home: home, root: ".kuvo-code", user: 501, real: true)
        #expect(launchd.map(\.path) == ["/bin/launchctl", "/bin/launchctl"])
        #expect(launchd.map(\.arguments) == [["kickstart", "gui/501/run.kuvo.code.machine"], ["bootstrap", "gui/501", agent.path]])
        // A test's home is never the account's, whose agent launchd would start.
        #expect(Here.startCommands(home: home, root: ".kuvo-code", user: 501).map(\.path) == ["/bin/sh"])
    }

    /// MacBook removed this Mac as a machine (its way to start and keys went, its card stayed): no box
    /// any more, so the app's own starts, as with none.
    @Test func aBoxItsMacRemovedIsNoBox() async throws {
        var app: AppModel?
        defer { cleanUp(app) }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        engine.list([])
        app = try await started { try memberOfMacBooks(runs: .gone) }
        #expect(app?.attached == nil)
        #expect(app?.engine == .ready)
    }

    @Test func withNothingHereItOpensAsItAlwaysHas() async throws {
        var app: AppModel?
        defer { cleanUp(app) }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        engine.list([])
        app = try await started {}
        #expect(app?.attached == nil)
        #expect(app?.engine == .ready)
    }

    /// Your Mac with Kuvo Code from before its box had a folder (its engine kept your sessions),
    /// which another Mac also set up as a machine: the app keeps its own, as it always has.
    @Test func anAppWithSessionsOfItsOwnKeepsItsOwnBox() async throws {
        var app: AppModel?
        defer { cleanUp(app) }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        engine.list([])
        app = try await started(ownSessions: true) { try memberOfMacBooks() }
        #expect(app?.attached == nil)
        #expect(app?.engine == .ready)
    }

    /// The box's CLI can't answer, with a box here: the app starts nothing of its own (that would be a
    /// second box for good), and says so, to try again.
    @Test func whenItCantTellWithABoxHereItStartsNothing() async throws {
        var app: AppModel?
        defer { cleanUp(app) }
        app = try await started(hereFails: true) { try memberOfMacBooks() }
        #expect(app?.attached == nil)
        guard case .failed(let reason) = app?.engine else { Issue.record("it doesn't start: \(String(describing: app?.engine))"); return }
        #expect(reason.contains("didn’t start one of its own"))
        #expect(!BackgroundWork.shared.register() && BackgroundWork.shared.failure?.contains("couldn’t check") == true, "Turn On registers no keeper either")
        #expect(!FileManager.default.fileExists(atPath: BoxProcess.home.path))
    }

    /// The keeper launchd starts (registered before, or by Turn On) asks too, before it writes
    /// anything: on the Mac mini it starts no box and ends as it should; where it can't tell, it's
    /// started again later; beside sessions of the app's own, it runs as always.
    @Test func theKeeperStartsNoSecondBox() async throws {
        defer { cleanUp(nil) }
        let mini = try prepared { try memberOfMacBooks() }
        #expect(await Keeper.gated(engine: mini, checked: false) == .stopped)
        #expect(!FileManager.default.fileExists(atPath: BoxProcess.home.path), "nothing of its own written: not even its folder")

        // (Opening the app asks again; launchd leaves it, rather than start it every few seconds.)
        let silent = try prepared(hereFails: true) { try memberOfMacBooks() }
        #expect(await Keeper.gated(engine: silent, checked: false) == .stopped)
        #expect(!FileManager.default.fileExists(atPath: BoxProcess.home.path))

        let own = try prepared(ownSessions: true) { try memberOfMacBooks() }
        #expect(await Keeper.gated(engine: own, checked: false) == nil, "the box, asked, says its own")
        // An update whose engine isn't downloaded yet can't ask: only what the app itself wrote as its
        // box started (its keeper's record) keeps its own box; the engine's database is the box's to
        // weigh, so without it, it can't tell.
        #expect(await Keeper.gated(engine: nil, checked: false) == .stopped)
        try FileManager.default.createDirectory(at: BoxProcess.home.appending(path: "run"), withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: BoxProcess.home.appending(path: "run/keeper.json"))
        #expect(await Keeper.gated(engine: nil, checked: false) == nil)
    }

    /// An engine that isn't the one Kuvo Code downloaded runs nothing, the box's CLI neither: with a
    /// box here, the start says what to do about it.
    @Test func anEngineThatIsntItsOwnIsNeverAsked() async throws {
        defer { cleanUp(nil) }
        let binary = try prepared { try memberOfMacBooks() }
        let outcome = await Here.gate(engine: binary, script: BoxProcess.script, appBox: BoxProcess.home, engineData: AppModel.engineFolders.dataDirectory,
                                      home: home, checked: true)
        guard case .unknown(let why) = outcome else { Issue.record("asked all the same: \(outcome)"); return }
        #expect(why?.contains("engine") == true)
    }

    /// Only the real app looks at the real `~/.kuvo-code`; a demo, test or measurement copy does with
    /// a folder of its own.
    @Test func copiesNeverLookAtTheRealMachinesFolder() {
        #expect(Here.machinesRoot(bundleID: "run.kuvo.code", hostingTests: false, given: ".kuvo-code") == ".kuvo-code")
        #expect(Here.machinesRoot(bundleID: "run.kuvo.code.demo", hostingTests: false, given: ".kuvo-code") == nil)
        #expect(Here.machinesRoot(bundleID: "run.kuvo.code.demo", hostingTests: false, given: ".kuvo-code-demo") == ".kuvo-code-demo")
        #expect(Here.machinesRoot(bundleID: "Run.Kuvo.Code", hostingTests: false, given: ".kuvo-code") == ".kuvo-code")
        #expect(Here.machinesRoot(bundleID: "run.kuvo.code.tests", hostingTests: true, given: ".kuvo-code") == ".kuvo-code", "the tests' home is their own")
    }

    /// The files the app counts as its own box having run, when the box can't be asked, are the box's
    /// own (`Vectors/routes/setup/own-box-ran.json`, which the bridge's tests hold the box's list to):
    /// one the box stopped counting would make the app keep a box the box would attach.
    @Test func whatCountsAsItsOwnBoxIsTheBoxs() throws {
        let folder = try #require(RouteScenarios.folder, "The routes folder isn't in the test bundle.")
        let vector = try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appending(path: "setup/own-box-ran.json"))) as? [String: Any]
        #expect(vector?["files"] as? [String] == Here.ownBoxFiles)
    }
}
