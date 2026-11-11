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
            \(hereFails ? "[ \"$5\" = here ] && exit 3" : "[ \"$5\" = here ] && shift 3 && exec '\(node.path(percentEncoded: false))' \"$@\"")
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
        BackgroundWork.attachedHere = false
        for database in databases { try? FileManager.default.removeItem(at: database) }
        AppModel.hereHome = FileManager.default.homeDirectoryForCurrentUser
        unsetenv("KUVO_OPENCODE_BINARY")
        try? FileManager.default.removeItem(at: folder)
        engine.stop()
    }

    /// MacBook set up this Mac as a machine, and hasn't been heard from for 40 days.
    private func memberOfMacBooks() throws {
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
        #expect(attached.use == .attach && attached.verdict == "elsewhere")
        #expect(attached.box?.primary?.name == "MacBook" && attached.box?.role == "member")
        #expect(app?.engine != .ready)
        #expect(!BackgroundWork.shared.register() && BackgroundWork.shared.failure?.contains("already here") == true, "Turn On registers no keeper beside it")
        #expect(!FileManager.default.fileExists(atPath: BoxProcess.home.path), "no box of its own: not even its folder")
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

        let silent = try prepared(hereFails: true) { try memberOfMacBooks() }
        #expect(await Keeper.gated(engine: silent, checked: false) == .again)

        let own = try prepared(ownSessions: true) { try memberOfMacBooks() }
        #expect(await Keeper.gated(engine: own, checked: false) == nil)
        // An update whose engine isn't downloaded yet can't ask: its own sessions keep its own box.
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
    }
}
