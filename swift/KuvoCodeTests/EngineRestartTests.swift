import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The engine stops on its own (J3): Kuvo Code starts it again by itself, ready with your sessions
/// listed as they were. One that keeps stopping, a few times within minutes, isn't started over
/// for ever: the app says it stopped, with what the engine wrote. The engine is a stand-in (a
/// script, as `KUVO_OPENCODE_BINARY` allows) that answers at a stubbed address and stops when the
/// test says.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct EngineRestartTests {
    let engine = StubEngine(port: 47998)
    let folder = AppInfo.testRoot.appending(path: "FakeEngine-\(UUID().uuidString.prefix(6))")
    var folderPath: String { folder.path(percentEncoded: false) }
    var crashFile: String { folder.appending(path: "crash").path(percentEncoded: false) }

    /// Says where it answers (the stub), then runs until told to stop, and says why as it does;
    /// each start noted (`engineStarts`). `box`: this Mac's box runs as it does with the engine's
    /// Bun, with Node (`TestBox.node`); without it, this Mac's box doesn't start.
    private func fakeEngine(box node: URL? = nil) throws -> URL {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // (The box runs as `run --config=/dev/null --no-env-file <script> serve`: Bun's settings and
        // a `.env` from nowhere, which Node has no options for.)
        let box = node.map { "case \"$4\" in *kuvo-link.js) shift 3; exec '\($0.path(percentEncoded: false))' \"$@\";; esac\n" } ?? ""
        let script = """
            #!/bin/sh
            \(box)# The coding agents' bridge, which runs with the engine's Bun: none here.
            [ "$1" = "run" ] && exit 1
            echo >> '\(startsFile)'
            echo '{"url":"\(engine.url)"}'
            # (Gone with its test's folder too: one cut short leaves nothing running.)
            while [ ! -e '\(crashFile)' ] && [ -d '\(folderPath)' ]; do sleep 0.05; done
            rm -f '\(crashFile)'
            echo 'Error: the database disk image is malformed' >&2
            exit 7
            """
        let file = folder.appending(path: "opencode")
        try script.write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path(percentEncoded: false))
        return file
    }

    private var starts: Int { engine.requests("GET", "/api/info").count }

    var startsFile: String { folder.appending(path: "starts").path(percentEncoded: false) }
    /// How many times the engine was started.
    private var engineStarts: Int { ((try? String(contentsOfFile: startsFile, encoding: .utf8)) ?? "").filter { $0 == "\n" }.count }

    /// The engine stops, as it would on a crash.
    private func crash() {
        FileManager.default.createFile(atPath: crashFile, contents: nil)
    }

    @Test func aStoppedEngineComesBackUntilItKeepsStopping() async throws {
        let binary = try fakeEngine()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let app = AppModel()
        defer {
            app.stop()
            unsetenv("KUVO_OPENCODE_BINARY")
            try? FileManager.default.removeItem(at: folder)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        engine.list([StubEngine.session("ses_keep", title: "Keep going", directory: "/tmp/kuvo-tests-restart")])
        await app.start()
        #expect(app.engine == .ready)
        #expect(app.workspace.session("ses_keep") != nil)

        // It stops: started again by itself, ready, the sessions still there.
        crash()
        try await until { engineStarts == 2 && app.engine == .ready }
        #expect(engineStarts == 2, "started again")
        #expect(app.engine == .ready)
        #expect(app.workspace.session("ses_keep") != nil)

        // It keeps stopping: started over at once a few times, then it says so, with what it wrote, and waits between tries.
        var failure: String?
        for _ in 0..<5 where failure == nil {
            let before = engineStarts
            crash()
            try await until { engineStarts > before && app.engine == .ready || { if case .failed = app.engine { true } else { false } }() }
            if case .failed(let reason) = app.engine { failure = reason }
        }
        let reason = try #require(failure, "it never said so")
        #expect(reason.contains("stopped unexpectedly"))
        #expect(reason.contains("the database disk image is malformed"), "with what the engine wrote: \(reason)")
        #expect(engineStarts <= 4, "not at once for ever: \(engineStarts) starts")
        #expect(!FileManager.default.fileExists(atPath: crashFile))

        // You try again: it's ready, and one stop after that is started over by itself as before,
        // not given up on at once for the stops before you tried.
        await app.restart()
        #expect(app.engine == .ready)
        let before = engineStarts
        crash()
        try await until { engineStarts > before && app.engine == .ready || { if case .failed = app.engine { true } else { false } }() }
        #expect(app.engine == .ready, "started over by itself: \(app.engine)")
    }

    /// Accounts and onboarding's subscriptions say the engine stopped (dimming what needs it) only
    /// once it has: not while it first starts, all the while it's down, through Try Again's start,
    /// and no longer once it's back.
    @Test func accountsSayTheEngineStoppedUntilItsBack() async throws {
        let binary = try fakeEngine()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let app = AppModel()
        // It doesn't answer before it's up the first time, nor once held, until let go.
        let up = Gate(), held = Gate(), letGo = Gate()
        defer {
            up.open()
            letGo.open()
            app.stop()
            unsetenv("KUVO_OPENCODE_BINARY")
            try? FileManager.default.removeItem(at: folder)
            engine.stop()
        }
        engine.on("GET", "/api/info") { _ in
            !up.isOpen || held.isOpen && !letGo.isOpen ? StubWeb.Answer(status: 503) : StubWeb.json(["version": OpenCodeEngine.version, "pid": 1])
        }
        engine.list([])
        #expect(!app.engineIsDown)
        let starting = Task { await app.start() }
        try await until { engineStarts > 0 }
        #expect(app.engine != .ready)
        #expect(!app.engineIsDown, "starting for the first time isn't stopped")
        up.open()
        await starting.value
        #expect(app.engine == .ready && !app.engineIsDown)

        var failed = false
        for _ in 0..<5 where !failed {
            let before = engineStarts
            crash()
            try await until { engineStarts > before && app.engine == .ready || { if case .failed = app.engine { true } else { false } }() }
            if case .failed = app.engine { failed = true }
        }
        #expect(failed, "it never said so")
        #expect(app.engineIsDown)

        // Try Again: still down while it starts (it doesn't answer yet), and not once it's back.
        held.open()
        let startsBefore = engineStarts
        let restarting = Task { await app.restart() }
        try await until { engineStarts > startsBefore }
        #expect(app.engine != .ready)
        #expect(app.engineIsDown, "starting again after it stopped")
        letGo.open()
        await restarting.value
        #expect(app.engine == .ready)
        #expect(!app.engineIsDown)
    }

    /// One that keeps stopping, which the app goes on trying with waits: a phone asking this Mac's
    /// box hears it stopped and why, and that it's being tried, not that it's starting, until it's
    /// started again.
    @Test func aPhoneHearsThisMacsEngineKeepsStoppingAndIsBeingTried() async throws {
        let binary = try fakeEngine(box: try #require(TestBox.node, "Node runs this Mac's box in the tests"))
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let app = AppModel()
        let clock = FailedStartRetryTests.TestClock()
        app.ownBox.retries.clock = clock.wait
        // The engine at its address for the box too, which reaches it itself.
        try await StubWeb.listen(port: 47998)
        defer {
            clock.goOn()
            app.stop()
            app.host.stop()
            unsetenv("KUVO_OPENCODE_BINARY")
            try? FileManager.default.removeItem(at: folder)
            StubWeb.stopListening(port: 47998)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        engine.list([])
        await app.start()
        #expect(app.engine == .ready)
        var failed = false
        for _ in 0..<5 where !failed {
            let before = engineStarts
            crash()
            try await until { engineStarts > before && app.engine == .ready || { if case .failed = app.engine { true } else { false } }() }
            if case .failed = app.engine { failed = true }
        }
        #expect(failed, "it never said so")
        let box = try #require(app.box.endpoint, "this Mac's box runs on")
        let ask = { () async throws -> (Int?, String) in
            var request = URLRequest(url: try #require(URL(string: "api/session", relativeTo: box.url)))
            if let password = box.password { request.setValue("Basic " + Data("opencode:\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization") }
            let (body, response) = try await URLSession(configuration: .ephemeral).data(for: request)
            return ((response as? HTTPURLResponse)?.statusCode, String(decoding: body, as: UTF8.self))
        }
        let (status, said) = try await ask()
        #expect(status == 503)
        #expect(said.contains("This Mac's engine isn't running. It stopped unexpectedly (exit code 7), and again after starting over. \(StartRetries.note)"), "\(said)")
        #expect(!said.contains("Try Again in Kuvo Code"), "\(said)")
        // Try Again: started, it's asked again.
        await app.restart()
        #expect(app.engine == .ready)
        let (again, _) = try await ask()
        #expect(again == 200)
    }

    /// You restart the engine while it's still starting (it hasn't answered yet): it starts
    /// again and is ready, not left stopped with nothing said. (An engine that stops while its
    /// start is finishing is started again the same way.)
    @Test func aRestartWhileTheEngineStartsStartsItAgain() async throws {
        let binary = try fakeEngine()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let app = AppModel()
        // It says it isn't ready yet until the test lets it answer.
        let answering = Gate()
        defer {
            answering.open()
            app.stop()
            unsetenv("KUVO_OPENCODE_BINARY")
            try? FileManager.default.removeItem(at: folder)
            engine.stop()
        }
        engine.on("GET", "/api/info") { _ in
            answering.isOpen ? StubWeb.json(["version": OpenCodeEngine.version, "pid": 1]) : StubWeb.Answer(status: 503)
        }
        engine.list([StubEngine.session("ses_keep", title: "Keep going", directory: "/tmp/kuvo-tests-restart")])
        let starting = Task { await app.start() }
        try await until { starts >= 1 }
        let restarting = Task { await app.restart() }
        // Started again: its engine answers now.
        try await until { engineStarts == 2 }
        answering.open()
        await restarting.value
        await starting.value
        #expect(app.engine == .ready)
        #expect(app.workspace.session("ses_keep") != nil)
    }

    /// This Mac's box, as the app starts it before its engine: able to send this Mac's wake-ups
    /// (the app's own kuvo-wake) and to reach your Keychain through the app, which it's told keeps
    /// its keys. Started without them, its wake-ups never went, and bots' keys went to files of its
    /// own. It starts the first time, as it does with the engine's Bun, so what it's started with
    /// is what it runs with.
    @Test func thisMacsBoxStartsAbleToSendWakeUpsAndReachYourKeychain() async throws {
        let binary = try fakeEngine(box: try #require(TestBox.node, "Node runs this Mac's box in the tests"))
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        // What only the tests' own box may run with, in the environment it's started from.
        setenv("KUVO_TEST_NO_PEERS", "1", 1)
        let app = AppModel()
        defer {
            app.stop()
            app.host.stop()
            unsetenv("KUVO_OPENCODE_BINARY")
            unsetenv("KUVO_TEST_NO_PEERS")
            try? FileManager.default.removeItem(at: folder)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        engine.list([])
        await app.start()
        #expect(app.box.endpoint != nil, "it's running")
        let started = try #require(app.box.environment, "the box was started")
        #expect(started["KUVO_TEST_NO_PEERS"] == nil, "it meets your other computers")
        #expect(started["KUVO_WAKE_COMMAND"] == WakeUps.command.path)
        #expect(started["KUVO_KEYS_ON_HOST"] == "1")
        // Where the app answers for your Keychain, in its folder, which it reads for each call.
        #expect(started["KUVO_HOST_URL"] == nil && started["KUVO_HOST_PASSWORD"] == nil)
        let said = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: HostInterface.file)) as? [String: String])
        #expect(said["url"]?.hasPrefix("http://127.0.0.1:") == true && said["password"] != nil)
    }
}
