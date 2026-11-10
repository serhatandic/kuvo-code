import Foundation
import IOKit.pwr_mgt
import KuvoLink
import OpenCodeKit
import ServiceManagement
import Testing
@testable import KuvoCode

/// This Mac's box keeps going when you quit the app: the keeper (`Keeper`, here its `MacBoxRunner` in
/// the test's process, as launchd's runs it) runs the engine, the box and the coding agents'
/// bridge, and the app only follows them by their records. The engine and the bridge are stand-ins
/// (one script, as `KUVO_OPENCODE_BINARY` allows, saying where StubEngine answers), and the box is
/// the real `kuvo-link.js serve`, run with Node.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BackgroundWorkTests {
    let engine = StubEngine(port: 47921)
    let bridge = StubEngine(port: 47922, alongside: true)
    let folder = AppInfo.testRoot.appending(path: "Keeper-\(UUID().uuidString.prefix(6))")
    var folderPath: String { folder.path(percentEncoded: false) }
    var startsFile: String { folder.appending(path: "starts").path(percentEncoded: false) }
    /// How many times the engine was started.
    var engineStarts: Int { ((try? String(contentsOfFile: startsFile, encoding: .utf8)) ?? "").filter { $0 == "\n" }.count }

    /// The engine, the bridge and the box, by what they're started with: each runs until the test's
    /// folder goes. `failing`: the engine writes it and stops as it starts, never answering.
    private func standIns(node: URL, failing: String? = nil) throws -> URL {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let script = """
            #!/bin/sh
            for a in "$@"; do
              case "$a" in
                *kuvo-link.js) while [ "$1" != "$a" ]; do shift; done; exec '\(node.path(percentEncoded: false))' "$@";;
                *kuvo-agents.js) echo '{"url":"\(bridge.url)"}'; while [ -d '\(folderPath)' ]; do sleep 0.05; done; exit 0;;
              esac
            done
            echo >> '\(startsFile)'
            \(failing.map { "echo '\($0)' >&2; exit 3" } ?? "")
            echo '{"url":"\(engine.url)"}'
            while [ -d '\(folderPath)' ]; do sleep 0.05; done
            """
        let file = folder.appending(path: "opencode")
        try script.write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path(percentEncoded: false))
        return file
    }

    private func recorded(_ name: String) -> ServerEndpoint? { KeeperFollower.record(name) }

    @Test func quittingTheAppLeavesThisMacsBoxRunningWhereLettersReachIt() async throws {
        let node = try #require(TestBox.node, "Node runs this Mac's box in the tests")
        let binary = try standIns(node: node)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        setenv("KUVO_KEEPER", "follow", 1)
        try await StubWeb.listen(port: 47921)
        // The keeper, as launchd runs it, recorded where the app finds it.
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        let app = AppModel()
        defer {
            app.stop()
            app.stopBox()
            keeper.stop()
            KeeperRecord.forget(pid: getpid())
            unsetenv("KUVO_OPENCODE_BINARY")
            unsetenv("KUVO_KEEPER")
            try? FileManager.default.removeItem(at: folder)
            StubWeb.stopListening(port: 47921)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        bridge.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 2])
        engine.list([StubEngine.session("ses_keep", title: "Keep going", directory: "/tmp/kuvo-tests-keeper")])
        try KeeperRecord(pid: getpid(), version: AppInfo.version, build: AppInfo.build, url: "http://127.0.0.1:9", password: "x", started: 0).write()
        await keeper.start()
        let keepers = try #require(recorded("serve.json"), "the keeper's box runs")
        #expect(engineStarts == 1)

        // The app follows what the keeper runs, and starts nothing of its own.
        await app.start()
        #expect(app.engine == .ready)
        #expect(app.workspace.session("ses_keep") != nil)
        #expect(app.box.endpoint == keepers)
        try await until { app.agents.address.endpoint?.url.port == 47922 }
        #expect(engineStarts == 1, "the app started no engine of its own")

        // You quit it: the engine, the box and the coding agents' bridge go on, where a letter
        // from your other computers reaches them (the box finds both by their records).
        app.stop()
        app.stopBox()
        #expect(recorded("engine.json")?.url.port == 47921)
        #expect(recorded("bridge.json")?.url.port == 47922, "the coding agents' bridge is still there for letters")
        #expect(recorded("serve.json") == keepers)
        var request = URLRequest(url: try #require(URL(string: "api/session", relativeTo: keepers.url)))
        if let password = keepers.password { request.setValue("Basic " + Data("opencode:\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization") }
        let (_, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 200, "the box still answers, its engine with it")
        #expect(engineStarts == 1, "nothing was started over")
    }

    /// The keeper's engine can't start (its database is damaged, say): the app, following the
    /// keeper, says so with what the engine wrote last, as it does when it runs the engine itself,
    /// rather than only that it stopped.
    @Test func whenTheKeepersEngineCantStartTheAppShowsWhatItWrote() async throws {
        let node = try #require(TestBox.node, "Node runs this Mac's box in the tests")
        let binary = try standIns(node: node, failing: "Error: the database disk image is malformed")
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        setenv("KUVO_KEEPER", "follow", 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        let app = AppModel()
        defer {
            app.stop()
            app.stopBox()
            keeper.stop()
            KeeperRecord.forget(pid: getpid())
            BoxProcess.forgetEngineStopped()
            unsetenv("KUVO_OPENCODE_BINARY")
            unsetenv("KUVO_KEEPER")
            try? FileManager.default.removeItem(at: folder)
            engine.stop()
        }
        bridge.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 2])
        // The keeper, as launchd runs it, recorded where the app finds it.
        try KeeperRecord(pid: getpid(), version: AppInfo.version, build: AppInfo.build, url: "http://127.0.0.1:9", password: "x", started: 0).write()
        await keeper.start()
        guard case .failed(let kept) = keeper.engine else {
            Issue.record("the keeper's engine started: \(keeper.engine)")
            return
        }

        await app.start()
        guard case .failed(let shown) = app.engine else {
            Issue.record("the app says \(app.engine)")
            return
        }
        #expect(shown.contains("the database disk image is malformed"), "with what the engine wrote: \(shown)")
        #expect(shown == kept, "as the window shows its own engine's")
    }

    @Test func anUpdateWaitsForTheSessionHoweverLongItRunsThenTheAppIsOnTheNewKeeper() async throws {
        let node = try #require(TestBox.node, "Node runs this Mac's box in the tests")
        let binary = try standIns(node: node)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        setenv("KUVO_KEEPER", "follow", 1)
        try await StubWeb.listen(port: 47921)
        let clock = TestClock()
        let realClock = Keeper.clock
        Keeper.clock = { [clock] seconds in await clock.wait(seconds) }
        // The keeper of the version before, still running as the update is installed; and the
        // installed app's, which launchd starts once it has gone.
        let olderGone = Gone(), newerGone = Gone()
        let older = Keeper(version: "0.0.1", build: "1", exits: { olderGone.say($0) })
        let newer = Keeper(exits: { newerGone.say($0) })
        let app = AppModel()
        defer {
            app.stop()
            app.stopBox()
            older.finish(.stopped)
            newer.finish(.stopped)
            Keeper.clock = realClock
            unsetenv("KUVO_OPENCODE_BINARY")
            unsetenv("KUVO_KEEPER")
            try? FileManager.default.removeItem(at: folder)
            StubWeb.stopListening(port: 47921)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        bridge.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 2])
        bridge.on("GET", "/api/session/active", json: ["data": [:] as [String: Any]])
        let long = StubEngine.session("ses_long", title: "A long task", directory: "/tmp/kuvo-tests-keeper")
        engine.list([long], running: ["ses_long"])
        await older.start()
        try Self.reach(keeper: KeeperRecord.read())
        let olderBox = try #require(recorded("serve.json"), "the older keeper's box runs")

        // The new app opens beside it: it follows the older keeper's box, with the session still
        // running there, says the update waits for it, and starts nothing of its own.
        await app.start()
        #expect(app.engine == .ready)
        #expect(app.box.endpoint == olderBox)
        #expect(app.keeperMakesWay, "Settings and the menu bar say the update waits for what's running")
        #expect(engineStarts == 1)

        // However long the session runs (well past the half hour an update once waited), it's
        // never stopped for the update.
        var passed = 0
        while passed <= 40 * 60 {
            try await until { olderGone.how != nil || !clock.waits.isEmpty }
            guard olderGone.how == nil else { break }
            let wait = try #require(clock.waits.first)
            clock.pass(wait)
            passed += wait
        }
        #expect(olderGone.how == nil, "the keeper stopped a running session \(passed / 60) minutes in")
        #expect(app.box.endpoint == olderBox)

        // The session ends: the keeper goes at once, to be started again from the installed app,
        // and the app waits for it, starting nothing of its own meanwhile.
        engine.list([long])
        try await until { olderGone.how != nil || !clock.waits.isEmpty }
        if let wait = clock.waits.first { clock.pass(wait) }
        try await until { olderGone.how != nil }
        #expect(olderGone.how == .again)
        try await until { app.engine == .starting }
        #expect(engineStarts == 1, "the app started no engine of its own")

        // launchd starts the installed app's keeper: the app is on its box and engine, with nothing
        // more to wait for.
        await newer.start()
        try Self.reach(keeper: KeeperRecord.read())
        let newerBox = try #require(recorded("serve.json"), "the newer keeper's box runs")
        #expect(newerBox != olderBox)
        try await until { app.box.endpoint == newerBox && app.engine == .ready }
        #expect(!app.keeperMakesWay)
        #expect(app.workspace.session("ses_long") != nil)
        try await until { !app.workspace.running.contains("ses_long") }
        #expect(engineStarts == 2, "the older keeper's engine and the newer's, none of the app's")
        #expect(newerGone.how == nil)
    }

    /// The first launch after an update, with nothing under way: the keeper of the version before
    /// goes the moment the app asks it to make way. The window shows one start, until the installed
    /// app's keeper is up, rather than the workspace on the keeper that's going, then the loader
    /// again as it goes.
    @Test func afterAnUpdateWithNothingUnderWayTheWindowStartsOnceOnTheNewKeeper() async throws {
        let node = try #require(TestBox.node, "Node runs this Mac's box in the tests")
        let binary = try standIns(node: node)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        setenv("KUVO_KEEPER", "follow", 1)
        try await StubWeb.listen(port: 47921)
        let clock = TestClock()
        let realClock = Keeper.clock
        Keeper.clock = { [clock] seconds in await clock.wait(seconds) }
        let olderGone = Gone(), newerGone = Gone()
        let older = Keeper(version: "0.0.1", build: "1", exits: { olderGone.say($0) })
        let newer = Keeper(exits: { newerGone.say($0) })
        let app = AppModel()
        // A session finishing as the update is installed: the older keeper's first look after the
        // app asks it to make way still sees it at work (and looks again two seconds on); by the
        // time the app asks, nothing is. The one busy answer is the look's: the keeper starts it as
        // it takes the request to make way, a whole round trip before the app's question reaches it.
        let finishing = Finishing()
        var starting: Task<Void, Never>?
        defer {
            starting?.cancel()
            app.stop()
            app.stopBox()
            older.finish(.stopped)
            newer.finish(.stopped)
            Keeper.clock = realClock
            unsetenv("KUVO_OPENCODE_BINARY")
            unsetenv("KUVO_KEEPER")
            try? FileManager.default.removeItem(at: folder)
            StubWeb.stopListening(port: 47921)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        bridge.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 2])
        bridge.on("GET", "/api/session/active", json: ["data": [:] as [String: Any]])
        engine.on("GET", "/api/session/active") { [finishing] _ in
            StubWeb.json(["data": finishing.once() ? ["ses_done": ["type": "busy"]] : [:] as [String: Any]])
        }
        engine.list([StubEngine.session("ses_done", title: "Done", directory: "/tmp/kuvo-tests-keeper")])
        await older.start()
        try Self.reach(keeper: KeeperRecord.read())
        let olderBox = try #require(recorded("serve.json"), "the older keeper's box runs")
        let looked = engine.requests("GET", "/api/session/active").count

        // The new app opens, and asks the older keeper to make way: the keeper's look and the app's
        // question to it (before the app asks the engine anything itself), and the window still
        // says it's starting.
        finishing.arm()
        starting = Task { await app.start() }
        try await until { app.engine == .ready || engine.requests("GET", "/api/session/active").count >= looked + 2 }
        #expect(app.engine != .ready, "the workspace showed on the keeper that's going")

        // Nothing's under way when it looks again: it goes, launchd starts the installed app's
        // keeper, and the window shows the workspace on it, once.
        try await until { clock.waits.contains(2) }
        clock.pass(2)
        try await until { olderGone.how != nil }
        #expect(olderGone.how == .again)
        #expect(app.engine != .ready)
        await newer.start()
        try Self.reach(keeper: KeeperRecord.read())
        let newerBox = try #require(recorded("serve.json"), "the newer keeper's box runs")
        await starting?.value
        #expect(app.engine == .ready)
        #expect(app.box.endpoint == newerBox && newerBox != olderBox)
        #expect(!app.engineStoppedWhileRunning, "the workspace never showed an engine that then stopped")
        #expect(!app.keeperMakesWay)
        #expect(app.workspace.session("ses_done") != nil)
        #expect(engineStarts == 2, "the older keeper's engine and the newer's, none of the app's")
    }

    /// A session at work for the next look at it only, once armed.
    nonisolated final class Finishing: @unchecked Sendable {
        private let lock = NSLock()
        private var armed = false
        func arm() { lock.withLock { armed = true } }
        func once() -> Bool {
            lock.withLock {
                defer { armed = false }
                return armed
            }
        }
    }

    /// macOS has background work on for this copy, but launchd has no keeper to start (the app it
    /// was registered from was moved or deleted): the app runs this Mac's box itself at once, never
    /// waiting on a keeper that isn't coming; Settings says it didn't start, and quitting stops the
    /// work rather than leaving it to nothing.
    @Test func withBackgroundWorkOnButNoKeeperLaunchdCanStartTheAppRunsTheBoxItself() async throws {
        let node = try #require(TestBox.node, "Node runs this Mac's box in the tests")
        let binary = try standIns(node: node)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        try await StubWeb.listen(port: 47921)
        // On in Login Items & Extensions, for a copy that registers as a user's does; launchd has
        // no such agent (this copy's label was never loaded).
        BackgroundWork.status = { .enabled }
        BackgroundWork.asUsersCopy = true
        BackgroundWork.shared.refresh()
        let app = AppModel()
        defer {
            app.stop()
            app.stopBox()
            BackgroundWork.status = nil
            BackgroundWork.asUsersCopy = false
            BackgroundWork.shared.didntStart = false
            BackgroundWork.shared.refresh()
            unsetenv("KUVO_OPENCODE_BINARY")
            try? FileManager.default.removeItem(at: folder)
            StubWeb.stopListening(port: 47921)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        engine.list([StubEngine.session("ses_here", title: "Here", directory: "/tmp/kuvo-tests-keeper")])

        await app.start()
        #expect(app.engine == .ready, "the app runs its own engine rather than wait")
        #expect(app.workspace.session("ses_here") != nil)
        #expect(engineStarts == 1)
        #expect(BackgroundWork.shared.didntStart, "Settings says background work didn't start")
        #expect(!app.keepsWorkingAfterQuit, "quitting stops the work, which nothing would carry on")
    }

    /// A demo's, test's or measurement's copy whose bundle ID macOS has registered (a copy run
    /// with KUVO_KEEPER=on before): it runs its work itself, as such a copy always does, never
    /// following a keeper launchd would start from wherever that copy was.
    @Test func aDemoCopyWhoseBundleIsRegisteredStillRunsTheBoxItself() async throws {
        let node = try #require(TestBox.node, "Node runs this Mac's box in the tests")
        let binary = try standIns(node: node)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        try await StubWeb.listen(port: 47921)
        BackgroundWork.status = { .enabled }
        BackgroundWork.shared.refresh()
        let app = AppModel()
        defer {
            app.stop()
            app.stopBox()
            BackgroundWork.status = nil
            BackgroundWork.shared.refresh()
            unsetenv("KUVO_OPENCODE_BINARY")
            try? FileManager.default.removeItem(at: folder)
            StubWeb.stopListening(port: 47921)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        engine.list([StubEngine.session("ses_demo", title: "Demo", directory: "/tmp/kuvo-tests-keeper")])

        await app.start()
        #expect(app.engine == .ready, "the copy runs its own engine rather than wait on a keeper")
        #expect(app.workspace.session("ses_demo") != nil)
        #expect(engineStarts == 1)
        #expect(!app.keepsWorkingAfterQuit)
    }

    /// Another copy of Kuvo Code, of another version, opened while the one launchd runs the keeper
    /// from stays as it is (a newer one from Downloads, or an older one): the keeper doesn't go to
    /// make way, since launchd would only start it again as it was, to be asked again, its engine
    /// and box stopping and starting over and over. The app follows it, with no update to wait for.
    @Test func anotherCopyOfAnotherVersionNeverMakesTheKeeperGoOverAndOver() async throws {
        let node = try #require(TestBox.node, "Node runs this Mac's box in the tests")
        let binary = try standIns(node: node)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        setenv("KUVO_KEEPER", "follow", 1)
        try await StubWeb.listen(port: 47921)
        let clock = TestClock()
        let realClock = Keeper.clock
        Keeper.clock = { [clock] seconds in await clock.wait(seconds) }
        // The keeper's own app, still at its place: no update was installed there.
        let gone = Gone()
        let keeper = Keeper(version: "0.0.1", build: "1", exits: { gone.say($0) }, installed: { "0.0.1 (1)" })
        let app = AppModel()
        defer {
            app.stop()
            app.stopBox()
            keeper.finish(.stopped)
            Keeper.clock = realClock
            unsetenv("KUVO_OPENCODE_BINARY")
            unsetenv("KUVO_KEEPER")
            try? FileManager.default.removeItem(at: folder)
            StubWeb.stopListening(port: 47921)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        bridge.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 2])
        bridge.on("GET", "/api/session/active", json: ["data": [:] as [String: Any]])
        engine.list([])
        await keeper.start()
        try Self.reach(keeper: KeeperRecord.read())
        let box = try #require(recorded("serve.json"), "the keeper's box runs")

        // The other copy opens: it follows the keeper's box, and says no update waits.
        await app.start()
        #expect(app.engine == .ready)
        #expect(app.box.endpoint == box)
        #expect(!app.keeperMakesWay, "no update waits: the keeper stays as it is")

        // With nothing under way, the keeper looks again and again, and stays.
        for _ in 0..<3 {
            try await until { gone.how != nil || !clock.waits.isEmpty }
            guard gone.how == nil else { break }
            clock.pass(try #require(clock.waits.first))
        }
        #expect(gone.how == nil, "the keeper went, to come back as it was")
        #expect(app.box.endpoint == box)
        #expect(engineStarts == 1)
    }

    @Test func afterARestartTheKeeperKeepsThisMacAwakeWhileASessionRunsAndTheAppNeverHoldsItTwice() async throws {
        let node = try #require(TestBox.node, "Node runs this Mac's box in the tests")
        let binary = try standIns(node: node)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        setenv("KUVO_KEEPER", "follow", 1)
        try await StubWeb.listen(port: 47921)
        let clock = TestClock()
        let realClock = Keeper.clock
        Keeper.clock = { [clock] seconds in await clock.wait(seconds) }
        UserDefaults.standard.removeObject(forKey: Awake.key)
        let keeper = Keeper(exits: { _ in })
        let app = AppModel()
        defer {
            app.stop()
            app.stopBox()
            keeper.finish(.stopped)
            Awake.shared.agentsWork(false)
            UserDefaults.standard.removeObject(forKey: Awake.key)
            Keeper.clock = realClock
            unsetenv("KUVO_OPENCODE_BINARY")
            unsetenv("KUVO_KEEPER")
            try? FileManager.default.removeItem(at: folder)
            StubWeb.stopListening(port: 47921)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        bridge.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 2])
        bridge.on("GET", "/api/session/active", json: ["data": [:] as [String: Any]])
        let task = StubEngine.session("ses_task", title: "Overnight", directory: "/tmp/kuvo-tests-keeper")
        engine.list([task], running: ["ses_task"])
        #expect(!Self.macHeldAwake)

        // The Mac started again and nobody opened Kuvo Code: launchd's keeper runs the box, and
        // keeps the Mac awake while the session works there.
        await keeper.start()
        try Self.reach(keeper: KeeperRecord.read())
        // The keeper looked at what runs again (it waits between looks).
        func looked() async throws {
            try await until { !clock.waits.isEmpty }
        }
        /// Whether the keeper says it keeps the Mac awake, as it tells the app.
        func keeperHolds() async throws -> Bool? {
            try await KeeperControl.send(.status)["awake"] as? Bool
        }
        try await looked()
        #expect(Self.macHeldAwake, "kept awake while the session works")
        #expect(try await keeperHolds() == true)

        // Done: it may sleep.
        engine.list([task])
        clock.pass(try #require(clock.waits.first))
        try await looked()
        #expect(!Self.macHeldAwake)
        #expect(try await keeperHolds() == false)

        // Turned off in Settings (the app's own setting, which the keeper reads as you change it):
        // a session working doesn't keep it awake; turned on again, it does.
        UserDefaults.standard.set(false, forKey: Awake.key)
        engine.list([task], running: ["ses_task"])
        clock.pass(try #require(clock.waits.first))
        try await looked()
        #expect(!Self.macHeldAwake)
        UserDefaults.standard.set(true, forKey: Awake.key)
        clock.pass(try #require(clock.waits.first))
        try await looked()
        #expect(Self.macHeldAwake)

        // You open Kuvo Code: it follows the keeper's box and sees the session working, but holds
        // nothing of its own beside the keeper's, and a phone hears the Mac is kept awake.
        await app.start()
        #expect(app.engine == .ready)
        app.workspace.handle(try ServerEvent(json: JSONSerialization.data(withJSONObject: [
            "id": "evt_awake", "type": "session.execution.started", "created": 1, "data": ["sessionID": "ses_task"],
        ])))
        #expect(!Awake.shared.isHolding, "the app holds nothing beside the keeper")
        #expect(try await keeperHolds() == true)
        #expect(Self.macHeldAwake)
        let request = LinkRequest(method: "GET", path: "kuvo/mac", headers: [:], body: Data())
        var answer = Data()
        for try await part in PhoneLink.respond(to: request, link: app.phoneLink, engine: URL(string: engine.url + "/")!, password: nil, agents: nil) {
            if case .body(let chunk) = part { answer += chunk }
        }
        let mac = try #require(try JSONSerialization.jsonObject(with: answer) as? [String: Any])
        #expect(mac["awakeNow"] as? Bool == true, "the phone hears the keeper keeps it awake")

        // The phone turns it off: it hears at once that the Mac may sleep, and it may, without
        // waiting for the keeper's next look.
        let off = LinkRequest(method: "PATCH", path: "kuvo/mac", headers: [:], body: try JSONSerialization.data(withJSONObject: ["keepsAwake": false]))
        answer = Data()
        for try await part in PhoneLink.respond(to: off, link: app.phoneLink, engine: URL(string: engine.url + "/")!, password: nil, agents: nil) {
            if case .body(let chunk) = part { answer += chunk }
        }
        let changed = try #require(try JSONSerialization.jsonObject(with: answer) as? [String: Any])
        #expect(changed["keepsAwake"] as? Bool == false)
        #expect(changed["awakeNow"] as? Bool == false, "the phone hears what it changed")
        #expect(!Self.macHeldAwake)
    }

    /// Background work is on, but the keeper launchd was asked to start didn't come up this time
    /// (the app gave it its while, and Settings says it didn't start): the app runs this Mac's box
    /// itself from then on, rather than asking for the keeper again and waiting for it, over and
    /// over, with no engine meanwhile.
    @Test func aKeeperThatDidntComeUpIsntWaitedForAgain() async throws {
        let node = try #require(TestBox.node, "Node runs this Mac's box in the tests")
        try #require(KeeperRecord.read() == nil, "no keeper runs for the tests")
        let binary = try standIns(node: node)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        // Registered and allowed, as KUVO_KEEPER=follow has it, and none started.
        setenv("KUVO_KEEPER", "follow", 1)
        try await StubWeb.listen(port: 47921)
        // What the app heard once the keeper's while was up.
        BackgroundWork.shared.didntStart = true
        let app = AppModel()
        defer {
            app.stop()
            app.stopBox()
            BackgroundWork.shared.didntStart = false
            unsetenv("KUVO_OPENCODE_BINARY")
            unsetenv("KUVO_KEEPER")
            try? FileManager.default.removeItem(at: folder)
            StubWeb.stopListening(port: 47921)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        engine.list([StubEngine.session("ses_here", title: "Here", directory: "/tmp/kuvo-tests-keeper")])

        await app.start()
        #expect(app.engine == .ready, "the app runs its own engine rather than wait for the keeper again")
        #expect(app.workspace.session("ses_here") != nil)
        #expect(engineStarts == 1)
        #expect(!app.keepsWorkingAfterQuit, "quitting stops the work, which nothing would carry on")
    }

    /// You quit the app a moment after opening it, before it found the keeper: the keeper's engine
    /// goes on where the box and your other computers find it, and the app opened next finds it too.
    @Test func quittingBeforeTheAppFoundTheKeeperLeavesItsEngineFound() async throws {
        let node = try #require(TestBox.node, "Node runs this Mac's box in the tests")
        let binary = try standIns(node: node)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        setenv("KUVO_KEEPER", "follow", 1)
        try await StubWeb.listen(port: 47921)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        let app = AppModel()
        defer {
            app.stop()
            app.stopBox()
            keeper.stop()
            KeeperRecord.forget(pid: getpid())
            unsetenv("KUVO_OPENCODE_BINARY")
            unsetenv("KUVO_KEEPER")
            try? FileManager.default.removeItem(at: folder)
            StubWeb.stopListening(port: 47921)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        bridge.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 2])
        try KeeperRecord(pid: getpid(), version: AppInfo.version, build: AppInfo.build, url: "http://127.0.0.1:9", password: "x", started: 0).write()
        await keeper.start()
        let running = try #require(recorded("engine.json"), "the keeper's engine runs")

        app.stopBox()
        #expect(recorded("engine.json") == running, "the keeper's engine is still where it's found")
        #expect(engineStarts == 1)
    }

    /// Asking launchd to start the keeper (as the app opens, or a keeper that stopped answering is
    /// started over) never holds the main thread while launchctl runs, and its answer is heard
    /// from its end however soon that comes.
    @Test func askingLaunchdToStartTheKeeperNeverHoldsTheMainThread() async throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let launchctl = folder.appending(path: "launchctl")
        let asked = folder.appending(path: "asked")
        try "#!/bin/sh\necho \"$*\" >>'\(asked.path(percentEncoded: false))'\nsleep 1\nexit 0\n".write(to: launchctl, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launchctl.path(percentEncoded: false))
        BackgroundWork.status = { .enabled }
        BackgroundWork.asUsersCopy = true
        BackgroundWork.launchctlForTests = launchctl.path(percentEncoded: false)
        BackgroundWork.shared.refresh()
        defer {
            BackgroundWork.status = nil
            BackgroundWork.asUsersCopy = false
            BackgroundWork.launchctlForTests = nil
            BackgroundWork.shared.refresh()
            try? FileManager.default.removeItem(at: folder)
        }
        let ticks = Ticks()
        let ticking = Task { @MainActor in
            while !Task.isCancelled {
                ticks.count += 1
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
        defer { ticking.cancel() }
        let before = ticks.count
        #expect(await BackgroundWork.shared.start(over: true))
        #expect(ticks.count - before >= 5, "the main thread went on while launchctl ran")
        #expect(try String(contentsOf: asked, encoding: .utf8) == "kickstart -k gui/\(getuid())/\(BackgroundWork.label)\n")

        // One that fails says so.
        try "#!/bin/sh\nexit 113\n".write(to: launchctl, atomically: false, encoding: .utf8)
        #expect(await BackgroundWork.shared.start() == false)
    }

    /// The keeper's control address, reached as it is rather than stood in for.
    private static func reach(keeper record: KeeperRecord?) throws {
        let record = try #require(record, "the keeper recorded itself")
        StubWeb.letThrough(port: URL(string: record.url)?.port ?? 0)
    }

    /// Whether this process keeps the Mac from sleeping on its own for agents' work, as macOS has
    /// it (the keeper and the app are both this process here).
    private static var macHeldAwake: Bool {
        var copied: Unmanaged<CFDictionary>?
        guard IOPMCopyAssertionsByProcess(&copied) == kIOReturnSuccess,
              let all = copied?.takeRetainedValue() as? [NSNumber: [[String: Any]]] else { return false }
        return (all[NSNumber(value: getpid())] ?? []).contains { $0["AssertName"] as? String == "Agents are working in Kuvo Code" }
    }
}

/// How many times the main thread came round while something else ran.
@MainActor private final class Ticks {
    var count = 0
}

/// How a test's keeper went (`Keeper.finish`), once it has.
private final class Gone {
    private(set) var how: Keeper.Exit?

    func say(_ how: Keeper.Exit) {
        self.how = how
        TestPulse.beat()
    }
}
