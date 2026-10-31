import Foundation
import OpenCodeKit
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

    @Test func aKeeperMakingWayForANewerAppWaitsWhileASessionRunsThenGoes() async throws {
        let node = try #require(TestBox.node, "Node runs this Mac's box in the tests")
        let binary = try standIns(node: node)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        try await StubWeb.listen(port: 47921)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        defer {
            keeper.stop()
            unsetenv("KUVO_OPENCODE_BINARY")
            try? FileManager.default.removeItem(at: folder)
            StubWeb.stopListening(port: 47921)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        bridge.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 2])
        // A session runs on the engine for the first two looks, then it's done.
        let looks = Looks()
        // (Answered on the listener's own queue, not the test's actor.)
        engine.on("GET", "/api/session/active") { @Sendable _ in
            StubWeb.json(["data": looks.next() <= 2 ? ["ses_busy": ["type": "busy"]] : [:] as [String: Any]])
        }
        bridge.on("GET", "/api/session/active", json: ["data": [:] as [String: Any]])
        await keeper.start()

        // Asked to make way: it waits while the session runs, and goes once it's done.
        let idle = await Keeper.makeWay(within: 3600, every: .zero, busy: keeper.isBusy)
        #expect(idle)
        #expect(looks.count == 3, "it waited for the session: \(looks.count) looks")

        // One that would run past the wait goes anyway once it's over.
        looks.reset()
        let gaveUp = await Keeper.makeWay(within: 0, every: .zero, busy: keeper.isBusy)
        #expect(!gaveUp)
        #expect(looks.count == 1)
    }
}

/// How many times the engine was asked what runs.
nonisolated private final class Looks: @unchecked Sendable {
    private let lock = NSLock()
    private var looked = 0
    var count: Int { lock.withLock { looked } }
    func next() -> Int { lock.withLock { looked += 1; return looked } }
    func reset() { lock.withLock { looked = 0 } }
}
