import Foundation
import OpenCodeKit
import os
import Testing
@testable import KuvoCode

/// This Mac's box: the same box a machine runs (`kuvo-link.js serve`), started beside the engine.
/// It finds the engine and the coding agents' bridge as a machine's box does, by the records the
/// app writes as they start and stop, and keeps what it has in the app's own folder. Run with
/// Node, which runs the same script as the engine's Bun.
@MainActor
@Suite(.serialized) struct MacBoxTests {
    private func info(_ endpoint: ServerEndpoint) async throws -> [String: Any] {
        var request = URLRequest(url: endpoint.url.appending(path: "kuvo/info"))
        request.setValue("Basic " + Data("opencode:\(endpoint.password ?? "")".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// The engine's start asks this Mac's box what to add to its settings: one that never answers
    /// leaves them as they were, and the engine starts anyway.
    @Test(.timeLimit(.minutes(1))) func anEngineConfigThatNeverAnswersDoesntHoldTheEngineUp() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "kuvo-engine-config-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let engine = folder.appending(path: "opencode")
        try "#!/bin/sh\nexec /bin/sleep 600\n".write(to: engine, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path)
        let content = #"{"model":"mine"}"#
        let given = await BoxProcess().engineConfig(engine: engine, content: content, environment: [:], timeout: 0.5)
        #expect(given == content)
    }

    /// A `.env` in the box's folder (which an agent's command can write) sets nothing for it: the
    /// engine's Bun would load one before the box's code runs, and with it the vault's key, or
    /// the tests' stand-ins. The engine here is a stand-in that loads it as Bun does.
    @Test func aDotEnvInTheBoxsFolderSetsNothingForIt() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "kuvo-dotenv-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let box = BoxProcess()
        defer {
            box.stop()
            try? FileManager.default.removeItem(at: folder)
            try? FileManager.default.removeItem(at: BoxProcess.home)
        }
        let seen = folder.appending(path: "environment")
        let engine = folder.appending(path: "opencode")
        try """
            #!/bin/sh
            # Bun's: a .env in the folder it starts in, unless told not to.
            case " $* " in *" --no-env-file "*) ;; *) [ "$BUN_BE_BUN" = 1 ] && [ -f .env ] && { set -a; . ./.env; set +a; } ;; esac
            env >"\(seen.path)"
            echo '{"url":"http://127.0.0.1:9"}'
            exec cat >/dev/null
            """.write(to: engine, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path)
        try FileManager.default.createDirectory(at: BoxProcess.home, withIntermediateDirectories: true)
        try "KUVO_VAULT_FILE_KEY=forged\nKUVO_TEST_NPM=http://127.0.0.1:9\n".write(to: BoxProcess.home.appending(path: ".env"), atomically: true, encoding: .utf8)

        await box.start(engine: engine, environment: ["PATH": "/usr/bin:/bin"], checked: false)
        let environment = try String(contentsOf: seen, encoding: .utf8)
        #expect(environment.contains("KUVO_HOME="), "it started")
        #expect(!environment.contains("forged") && !environment.contains("KUVO_TEST_NPM"))
        // Nor what it asks before the engine starts (`engine-config`).
        try? FileManager.default.removeItem(at: seen)
        _ = await box.engineConfig(engine: engine, content: nil, environment: ["PATH": "/usr/bin:/bin"], timeout: 5)
        let asked = try String(contentsOf: seen, encoding: .utf8)
        #expect(!asked.contains("forged") && !asked.contains("KUVO_TEST_NPM"))
    }

    /// When this Mac's box doesn't start because its engine isn't the one Kuvo Code downloaded, the
    /// engine's settings aren't asked of the box's script with it either: nothing runs it.
    @Test func aRefusedBoxsEngineRunsNothingElse() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "kuvo-refused-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let box = BoxProcess()
        defer {
            box.stop()
            try? FileManager.default.removeItem(at: folder)
            try? FileManager.default.removeItem(at: BoxProcess.home)
        }
        let ran = folder.appending(path: "ran")
        let engine = folder.appending(path: "opencode")
        try "#!/bin/sh\necho \"$*\" >>\"\(ran.path)\"\necho '{\"url\":\"http://127.0.0.1:9\"}'\n".write(to: engine, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path)
        try FileManager.default.createDirectory(at: BoxProcess.home, withIntermediateDirectories: true)

        await box.start(engine: engine, environment: ["PATH": "/usr/bin:/bin"], checked: true)
        #expect(box.endpoint == nil && box.failure != nil, "it was refused: not the engine Kuvo Code downloaded")
        let content = #"{"model":"mine"}"#
        #expect(await box.engineConfig(engine: engine, content: content, environment: [:], timeout: 5) == content)
        #expect(!FileManager.default.fileExists(atPath: ran.path), "the engine never ran")
    }

    @Test func theBoxFindsTheEngineTheAppStarted() async throws {
        let node = try #require(TestBox.node, "Node runs this Mac's box in the tests")
        let box = BoxProcess()
        defer {
            box.stop()
            BoxProcess.engineChanged(nil, version: nil, pid: nil)
            try? FileManager.default.removeItem(at: BoxProcess.home)
        }
        await box.start(node: node)
        let endpoint = try #require(box.endpoint, "it started: \(box.failure ?? "")")
        #expect(PhoneLink.box.withLock { $0 } == endpoint, "the phone link hands moved areas to it")

        BoxProcess.engineChanged(ServerEndpoint(url: URL(string: "http://127.0.0.1:47970")!, password: "pw"), version: "2.0.32", pid: getpid())
        let running = try await info(endpoint)
        #expect(running["kind"] as? String == "mac")
        #expect(running["engine"] as? String == "2.0.32")
        #expect(running["started"] is Double)
        #expect(running["chats"] as? String == Workspace.chatsFolder, "the Mac's chats, where the app keeps them")
        // Its record is yours alone.
        let record = BoxProcess.run.appending(path: "engine.json").path
        #expect((try FileManager.default.attributesOfItem(atPath: record)[.posixPermissions] as? Int) == 0o600)

        BoxProcess.engineChanged(nil, version: nil, pid: nil)
        // Stopped: it says the engine it brings, and that none runs.
        let stopped = try await info(endpoint)
        #expect(stopped["engine"] as? String == OpenCodeEngine.version)
        #expect(stopped["started"] is NSNull)

        box.stop()
        #expect(PhoneLink.box.withLock { $0 } == nil)
    }
}
