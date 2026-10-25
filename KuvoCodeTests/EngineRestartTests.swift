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

    /// Says where it answers (the stub), then runs until told to stop, and says why as it does.
    /// `box`: this Mac's box runs as it does with the engine's Bun, with Node (`TestBox.node`).
    /// Without it, this Mac's box doesn't start, at once; or, once the test holds it (`holdBox`),
    /// from its second start (the one after the engine is ready) only when it lets it go
    /// (`letBoxGo`).
    private func fakeEngine(box node: URL? = nil) throws -> URL {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let box = node.map { "case \"$2\" in *kuvo-link.js) shift; exec '\($0.path(percentEncoded: false))' \"$@\";; esac\n" }
            ?? """
            case "$2" in *kuvo-link.js)
              echo >> '\(boxStartsFile)'
              if [ -e '\(holdFile)' ] && [ "$(wc -l < '\(boxStartsFile)')" -ge 2 ]; then while [ ! -e '\(goFile)' ] && [ -d '\(folderPath)' ]; do sleep 0.05; done; fi
              exit 1;;
            esac

            """
        let script = """
            #!/bin/sh
            \(box)# The coding agents' bridge, which runs with the engine's Bun: none here.
            [ "$1" = "run" ] && exit 1
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

    var holdFile: String { folder.appending(path: "hold-box").path(percentEncoded: false) }
    var goFile: String { folder.appending(path: "box-go").path(percentEncoded: false) }
    var boxStartsFile: String { folder.appending(path: "box-starts").path(percentEncoded: false) }
    private func holdBox() { FileManager.default.createFile(atPath: holdFile, contents: nil) }
    private func letBoxGo() { FileManager.default.createFile(atPath: goFile, contents: nil) }

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
        try await until { starts == 2 && app.engine == .ready }
        #expect(starts == 2, "started again")
        #expect(app.engine == .ready)
        #expect(app.workspace.session("ses_keep") != nil)

        // It keeps stopping: started over a few times, then it says so, with what it wrote.
        var failure: String?
        for _ in 0..<5 where failure == nil {
            let before = starts
            crash()
            try await until { starts > before && app.engine == .ready || { if case .failed = app.engine { true } else { false } }() }
            if case .failed(let reason) = app.engine { failure = reason }
        }
        let reason = try #require(failure, "it never stopped trying")
        #expect(reason.contains("stopped unexpectedly"))
        #expect(reason.contains("the database disk image is malformed"), "with what the engine wrote: \(reason)")
        #expect(starts <= 4, "not started over for ever: \(starts) starts")
        #expect(!FileManager.default.fileExists(atPath: crashFile))
    }

    /// The engine stops while its start is still finishing what comes once it's ready (this Mac's
    /// box starting, held up): it's started again all the same, not left stopped with nothing said.
    @Test func anEngineThatStopsWhileItsStartFinishesIsStartedAgain() async throws {
        let binary = try fakeEngine()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let app = AppModel()
        defer {
            letBoxGo()
            app.stop()
            unsetenv("KUVO_OPENCODE_BINARY")
            try? FileManager.default.removeItem(at: folder)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        engine.list([StubEngine.session("ses_keep", title: "Keep going", directory: "/tmp/kuvo-tests-restart")])
        // The box it starts once the engine is ready waits until it's let go.
        holdBox()
        let starting = Task { await app.start() }
        try await until { app.engine == .ready }
        crash()
        try await until { starts == 2 && app.engine == .ready }
        #expect(app.workspace.session("ses_keep") != nil)
        letBoxGo()
        await starting.value
    }

    /// This Mac's box, as the app starts it before its engine: able to send this Mac's wake-ups
    /// (the app's own kuvo-wake) and to reach your Keychain through the app, which it's told keeps
    /// its keys. Started without them, its wake-ups never went, and bots' keys went to files of its
    /// own. It starts the first time, as it does with the engine's Bun, so what it's started with
    /// is what it runs with.
    @Test func thisMacsBoxStartsAbleToSendWakeUpsAndReachYourKeychain() async throws {
        let binary = try fakeEngine(box: try #require(TestBox.node, "Node runs this Mac's box in the tests"))
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let app = AppModel()
        defer {
            app.stop()
            app.host.stop()
            unsetenv("KUVO_OPENCODE_BINARY")
            try? FileManager.default.removeItem(at: folder)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        engine.list([])
        await app.start()
        #expect(app.box.endpoint != nil, "it's running")
        let started = try #require(app.box.environment, "the box was started")
        #expect(started["KUVO_WAKE_COMMAND"] == WakeUps.command.path)
        #expect(started["KUVO_KEYS_ON_HOST"] == "1")
        #expect(started["KUVO_HOST_URL"]?.hasPrefix("http://127.0.0.1:") == true)
        #expect(started["KUVO_HOST_PASSWORD"] != nil)
    }
}
