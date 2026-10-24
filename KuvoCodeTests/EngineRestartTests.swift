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
    var crashFile: String { folder.appending(path: "crash").path(percentEncoded: false) }

    /// Says where it answers (the stub), then runs until told to stop, and says why as it does.
    private func fakeEngine() throws -> URL {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let script = """
            #!/bin/sh
            # The coding agents' bridge, which runs with the engine's Bun: none here.
            [ "$1" = "run" ] && exit 1
            echo '{"url":"\(engine.url)"}'
            while [ ! -e '\(crashFile)' ]; do sleep 0.05; done
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
}
