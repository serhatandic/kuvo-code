import Foundation
import Testing
@testable import OpenCodeKit

struct RemoteEngineTests {
    @Test func quotesForTheShell() {
        #expect(SSHConnection.quoted("plain") == "'plain'")
        #expect(SSHConnection.quoted("it's") == #"'it'\''s'"#)
        #expect(SSHConnection.quoted("$HOME; rm -rf /") == "'$HOME; rm -rf /'")
    }

    @Test func runsAScriptWithShWhateverTheLoginShell() {
        let arguments = SSHConnection(destination: "box").arguments(running: "echo \"$HOME\"", extra: ["-L", "1:127.0.0.1:2"])
        #expect(arguments.contains("BatchMode=yes"))
        #expect(arguments.suffix(4) == ["-L", "1:127.0.0.1:2", "box", SSHConnection.command(running: "echo \"$HOME\"")])
        // Only base64 between the quotes the login shell reads: nothing in it that fish, csh or sh
        // would take as an escape.
        let command = SSHConnection.command(running: "printf '%s\\n' \"a'b\\\\c\"")
        #expect(command.hasPrefix("exec sh -c 'kuvo_script=$(printf %s "))
        #expect(!command.dropFirst("exec sh -c '".count).dropLast().contains { $0 == "'" || $0 == "\\" })
        #expect(arguments.contains("ControlMaster=auto"))
        // The engine's connection never joins the shared one.
        #expect(SSHConnection(destination: "box").arguments(running: "true", shared: false).contains("ControlPath=none"))
    }

    /// A machine with several addresses (its local name, its VPN one): every connection to it goes
    /// to the one in use, by the name it was added under, and back to that name when let go.
    @Test func aMachineIsReachedAtTheAddressInUse() {
        let name = "home-\(UUID().uuidString.prefix(6))"
        defer { SSHConnection.route(name, to: nil) }
        SSHConnection.route(name, to: name + ".tailnet")
        #expect(SSHConnection(destination: name).arguments(running: "true").suffix(2).first == name + ".tailnet")
        #expect(SSHConnection(destination: name).address == name + ".tailnet")
        // Others aren't.
        #expect(SSHConnection(destination: "box").address == "box")
        SSHConnection.route(name, to: nil)
        #expect(SSHConnection(destination: name).arguments(running: "true").suffix(2).first == name)
    }

    @Test func theEngineRunsOnItsOwnOnTheMachinesLocalhost() {
        let script = RemoteServer.launchScript
        #expect(script.contains("read -r line"))
        #expect(script.contains("XDG_DATA_HOME=\"$K/data\""))
        #expect(script.contains("setsid"))
        #expect(script.contains("--hostname 127.0.0.1"))
        #expect(script.contains("engine/\(OpenCodeEngine.version)/opencode"))
        // Nothing secret on its command line: those come over the input. (kuvo-wake, in it, only
        // unsets the engine's password before running a check; kuvo-start, which it writes, makes
        // its own on the machine and hands them over the same way.)
        #expect(!script.replacingOccurrences(of: RemoteServer.bootScript, with: "").contains("PASSWORD="))
        #expect(!RemoteServer.bootLaunchScript.contains("PASSWORD="))
        // Well within the machine's limit for one argument (128 KB), as base64 on the command line.
        #expect(SSHConnection.command(running: script).utf8.count < 100_000)
        // Only its user can read how to find it.
        #expect(script.contains("umask 077"))
    }

    /// Settings given as `KUVO_SETTINGS` become the engine's own settings file, in its folder, for
    /// its user only, and aren't left in its environment; without them, the file is left alone.
    @Test func settingsGoInTheEnginesOwnFile() throws {
        // Up to its keys: past the start lock and the check for one running, before which a start
        // that won't go ahead (another Mac's engine came up meanwhile) writes nothing.
        let setup = try #require(RemoteServer.launchScript.components(separatedBy: "mkdir -p \"$K/keys\";").first) + "env | grep -c '^KUVO_SETTINGS=' || true\n"
        for shell in WakesTests.shells {
            let home = FileManager.default.temporaryDirectory.appending(path: "opencodekit-home-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: home) }
            try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
            let file = home.appending(path: "\(RemoteEngineInstaller.root)/config/opencode/opencode.json")
            func run(_ input: String) throws -> String {
                let process = Process()
                process.executableURL = URL(filePath: shell)
                process.arguments = ["-c", setup]
                process.environment = ["PATH": "/usr/bin:/bin", "HOME": home.path]
                let stdin = Pipe(), stdout = Pipe()
                process.standardInput = stdin
                process.standardOutput = stdout
                try process.run()
                stdin.fileHandleForWriting.write(Data(input.utf8))
                try stdin.fileHandleForWriting.close()
                process.waitUntilExit()
                return String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            }
            let settings = #"{"websearch":{"provider":"random"}}"#
            #expect(try run("KUVO_PORT=1\nKUVO_SETTINGS=\(settings)\n\n").trimmingCharacters(in: .whitespacesAndNewlines) == "0", "\(shell)")
            #expect(try String(contentsOf: file, encoding: .utf8) == settings + "\n", "\(shell)")
            let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int
            #expect(permissions == 0o600, "\(shell)")
            _ = try run("KUVO_PORT=1\n\n")
            #expect(try String(contentsOf: file, encoding: .utf8) == settings + "\n", "\(shell)")
            _ = try run("KUVO_PORT=1\nKUVO_SETTINGS={}\n\n")
            #expect(try String(contentsOf: file, encoding: .utf8) == "{}\n", "\(shell)")
        }
    }

    /// A start from the Mac puts its keys in place of what it sent before, and leaves the box's
    /// own alone: its shared keys and its bots' own, which no Mac sends.
    @Test func aStartFromTheMacLeavesTheBoxsOwnKeys() throws {
        let setup = try #require(RemoteServer.launchScript.components(separatedBy: "mkdir -p \"$K/keys\";").first)
        for shell in WakesTests.shells {
            let home = FileManager.default.temporaryDirectory.appending(path: "opencodekit-home-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: home) }
            let root = home.appending(path: RemoteEngineInstaller.root)
            let sent = root.appending(path: "keys/KUVO_KEY_SENT")
            let botKey = root.appending(path: "box/bot-keys/KUVO_KEY_GITHUB_TOKEN__BOT_SCOUT")
            let shared = root.appending(path: "box/keys/KUVO_KEY_GITHUB_TOKEN")
            for file in [sent, botKey, shared] {
                try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                try Data("secret".utf8).write(to: file)
            }
            let process = Process()
            process.executableURL = URL(filePath: shell)
            process.arguments = ["-c", setup]
            process.environment = ["PATH": "/usr/bin:/bin", "HOME": home.path]
            let stdin = Pipe()
            process.standardInput = stdin
            process.standardOutput = FileHandle.nullDevice
            try process.run()
            stdin.fileHandleForWriting.write(Data("KUVO_PORT=1\n\n".utf8))
            try stdin.fileHandleForWriting.close()
            process.waitUntilExit()
            #expect(!FileManager.default.fileExists(atPath: sent.path), "what a Mac sent before goes: \(shell)")
            #expect(FileManager.default.fileExists(atPath: botKey.path), "a bot's own key stays: \(shell)")
            #expect(FileManager.default.fileExists(atPath: shared.path), "the box's shared key stays: \(shell)")
        }
    }

    @Test func linuxBuildsAreThePinnedVersion() {
        for machine in ["x86_64", "aarch64"] {
            let release = EngineRelease.linux(machine: machine)
            #expect(release?.version == OpenCodeEngine.version)
            #expect(release?.tarball.lastPathComponent.contains(OpenCodeEngine.version) == true)
            #expect(release?.integrity.hasPrefix("sha512-") == true)
        }
        #expect(EngineRelease.linux(machine: "riscv64") == nil)
    }

    @Test func aMachinesFoldersAreKeyedApartAndSentPlain() {
        let api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: "http://127.0.0.1:1")!, password: nil), folderPrefix: "ssh://box")
        #expect(api.enginePath("ssh://box/home/me/app") == "/home/me/app")
        #expect(api.appFolder("/home/me/app") == "ssh://box/home/me/app")
        // Already the app's, or another machine's: left as it is.
        #expect(api.appFolder("ssh://box/home/me/app") == "ssh://box/home/me/app")
        #expect(api.enginePath("/Users/me/app") == "/Users/me/app")
    }

    @Test func findsAFreeLocalPort() throws {
        let port = try RemoteServer.freeLocalPort()
        #expect((1024...65535).contains(port))
    }
}

/// Against a real machine over SSH. Skipped unless KUVO_TEST_SSH_HOST names one this Mac can reach
/// with its keys (it installs the engine in that machine's ~/.kuvo-code-test, apart from the app's):
///
///     KUVO_TEST_SSH_HOST=my-server swift test --filter LiveRemoteEngineTests
@Suite(.enabled(if: ProcessInfo.processInfo.environment["KUVO_TEST_SSH_HOST"] != nil), .serialized)
struct LiveRemoteEngineTests {
    let connection = SSHConnection(destination: ProcessInfo.processInfo.environment["KUVO_TEST_SSH_HOST"] ?? "")

    init() {
        // A folder of its own, so the tests never stop an engine the app runs there.
        RemoteEngineInstaller.root = ".kuvo-code-test"
    }

    @Test func runsOnItsOwnAndIsFoundAgain() async throws {
        let cache = FileManager.default.temporaryDirectory.appending(path: "opencodekit-remote-cache")
        defer { try? FileManager.default.removeItem(at: cache) }
        try await RemoteEngineInstaller(connection: connection, cache: cache).install()
        try await RemoteServer.stop(on: connection)
        #expect(try await RemoteServer.running(on: connection) == nil)

        let engine = try await RemoteServer.launch(on: connection, environment: [:], notes: ["test": "yes"])
        let server = try await RemoteServer.attach(to: engine, on: connection)
        let client = HTTPClient(endpoint: server.endpoint)
        struct Info: Decodable { var version: String }
        let info = try await client.send(client.request("GET", "api/info"), as: Info.self)
        #expect(info.version == OpenCodeEngine.version)

        // Without the password, nothing.
        let anonymous = HTTPClient(endpoint: ServerEndpoint(url: server.endpoint.url, password: nil))
        await #expect(throws: (any Error).self) { try await anonymous.send(anonymous.request("GET", "api/info"), as: Info.self) }

        // The connection goes; the engine stays, and is found again.
        server.disconnect()
        try await Task.sleep(for: .seconds(1))
        let found = try await RemoteServer.running(on: connection)
        #expect(found == engine)
        #expect(found?.notes["test"] == "yes")
        let again = try await RemoteServer.attach(to: try #require(found), on: connection)
        let reconnected = HTTPClient(endpoint: again.endpoint)
        #expect((try? await reconnected.send(reconnected.request("GET", "api/info"), as: Info.self)) != nil)
        again.disconnect()

        try await RemoteServer.stop(on: connection)
        try await Task.sleep(for: .seconds(2))
        #expect(try await RemoteServer.running(on: connection) == nil)
        let left = try await connection.run("ps -eo pid,args | grep '[o]pencode serve --port \(engine.port)' || true")
        #expect(left.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

        // Nothing of the test's stays on the machine: its watchdog, and its folder.
        _ = try await connection.run("pkill -f '[/]\\.kuvo-code-test/' || true; rm -rf \"$HOME/.kuvo-code-test\"")
        #expect(try await connection.run("[ -e \"$HOME/.kuvo-code-test\" ] && echo left || true").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    /// Settings that can hold secrets (a server's environment) reach the engine in a file only you
    /// can read, never its environment, which the agent's `env` would print.
    @Test func privateSettingsStayOutOfTheEnvironment() async throws {
        let cache = FileManager.default.temporaryDirectory.appending(path: "opencodekit-remote-cache")
        defer { try? FileManager.default.removeItem(at: cache) }
        try await RemoteEngineInstaller(connection: connection, cache: cache).install()
        try await RemoteServer.stop(on: connection)

        let secret = "kuvo-test-secret-" + UUID().uuidString.prefix(8)
        let settings = #"{"mcp":{"servers":{"private-test":{"type":"local","command":["true"],"disabled":true,"environment":{"TOKEN":"\#(secret)"}}}}}"#
        let engine = try await RemoteServer.launch(on: connection, environment: [RemoteServer.privateSettingsVariable: settings])
        let environment = try await connection.run("tr '\\0' '\\n' </proc/\(engine.pid)/environ")
        #expect(!environment.isEmpty)
        #expect(!environment.contains(secret))
        #expect(!environment.contains(RemoteServer.privateSettingsVariable))
        #expect(environment.contains("OPENCODE_CONFIG="))
        // Bots' wake-ups are found under this root, not the app's own.
        #expect(environment.contains("KUVO_BOTS=") && environment.contains("/.kuvo-code-test/bots"))
        let file = "\"$HOME/.kuvo-code-test/keys/settings.json\""
        #expect(try await connection.run("stat -c %a \(file)").trimmingCharacters(in: .whitespacesAndNewlines) == "600")

        // The engine has them.
        let server = try await RemoteServer.attach(to: engine, on: connection)
        let client = HTTPClient(endpoint: server.endpoint)
        let config = try await client.send(client.request("GET", "api/config"), as: JSONValue.self)
        let text = String(decoding: try JSONEncoder().encode(config), as: UTF8.self)
        #expect(text.contains("private-test"))
        server.disconnect()

        // They stay when it stops, for a start after a restart, still only yours to read; how it
        // was started is kept without them.
        try await RemoteServer.stop(on: connection)
        #expect(try await connection.run("stat -c %a \(file)").trimmingCharacters(in: .whitespacesAndNewlines) == "600")
        let kept = try await connection.run("cat \"$HOME/.kuvo-code-test/run/launch.env\"")
        #expect(!kept.contains(secret) && !kept.contains(RemoteServer.privateSettingsVariable) && !kept.contains("PASSWORD"))
        _ = try await connection.run("pkill -f '[/]\\.kuvo-code-test/' || true; rm -rf \"$HOME/.kuvo-code-test\"")
    }

    /// After a restart (its keeper, engine, agents bridge and phone link gone), `kuvo-start` starts
    /// its keeper again, which starts the engine as the Mac last did, with its settings and keys
    /// and new passwords, and the Mac finds it as its own; while one runs, it starts none. A test's
    /// folder never touches the crontab.
    @Test func comesBackAfterARestart() async throws {
        let cache = FileManager.default.temporaryDirectory.appending(path: "opencodekit-remote-cache")
        defer { try? FileManager.default.removeItem(at: cache) }
        try await RemoteEngineInstaller(connection: connection, cache: cache).install()
        try await RemoteServer.stop(on: connection)
        let before = try await connection.run("crontab -l 2>/dev/null || true")

        let secret = "kuvo-test-secret-" + UUID().uuidString.prefix(8)
        let settings = #"{"mcp":{"servers":{"private-test":{"type":"local","command":["true"],"disabled":true,"environment":{"TOKEN":"\#(secret)"}}}}}"#
        let first = try await RemoteServer.launch(on: connection, environment: [RemoteServer.privateSettingsVariable: settings, "KUVO_KEY_TEST_TOKEN": secret, "KUVO_TZ": "Europe/Istanbul"], notes: ["mac": "test-mac", "settings": "abc"])
        // As a restart leaves it: nothing of it running.
        _ = try await connection.run("pkill -f '[/]\\.kuvo-code-test/' || true; kill \(first.pid) 2>/dev/null; sleep 1; true")
        #expect(try await connection.run("pgrep -f '[.]kuvo-code-test/' || true").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

        _ = try await connection.run("sh \"$HOME/.kuvo-code-test/bin/kuvo-start\"")
        let again = try #require(try await runningSoon { $0.pid != first.pid })
        #expect(again.pid != first.pid && again.password != first.password)
        #expect(again.notes == ["mac": "test-mac", "settings": "abc"], "the Mac knows it as its own, with the same settings")
        let server = try await RemoteServer.attach(to: again, on: connection)
        let client = HTTPClient(endpoint: server.endpoint)
        let config = try await client.send(client.request("GET", "api/config"), as: JSONValue.self)
        #expect(String(decoding: try JSONEncoder().encode(config), as: UTF8.self).contains("private-test"))
        server.disconnect()
        #expect(try await connection.run("cat \"$HOME/.kuvo-code-test/keys/KUVO_KEY_TEST_TOKEN\"") == secret, "its keys are still there")
        let environment = try await connection.run("tr '\\0' '\\n' </proc/\(again.pid)/environ")
        #expect(!environment.contains(secret) && environment.contains("KUVO_TZ=Europe/Istanbul") && !environment.contains("KUVO_BOOT"))

        // One running: it starts none.
        _ = try await connection.run("sh \"$HOME/.kuvo-code-test/bin/kuvo-start\"")
        #expect(try await RemoteServer.running(on: connection)?.pid == again.pid)
        #expect(try await connection.run("crontab -l 2>/dev/null || true") == before, "a test's folder leaves the crontab alone")

        // Two at once after a restart: one keeper, one engine.
        _ = try await connection.run("pkill -f '[/]\\.kuvo-code-test/' || true; kill \(again.pid) 2>/dev/null; sleep 1; true")
        _ = try await connection.run("sh \"$HOME/.kuvo-code-test/bin/kuvo-start\" & sh \"$HOME/.kuvo-code-test/bin/kuvo-start\"; wait")
        _ = try #require(try await runningSoon { $0.pid != again.pid })
        try await Task.sleep(for: .seconds(2))
        let engines = try await connection.run("pgrep -fc '[.]kuvo-code-test/engine/.*/opencode serve' || true")
        #expect(engines.trimmingCharacters(in: .whitespacesAndNewlines) == "1")
        let keepers = try await connection.run("pgrep -fc '[.]kuvo-code-test/bin/kuvo-start keep' || true")
        #expect(keepers.trimmingCharacters(in: .whitespacesAndNewlines) == "1")

        // One stopped on purpose stays stopped.
        try await RemoteServer.stopEngine(on: connection)
        _ = try await connection.run("sh \"$HOME/.kuvo-code-test/bin/kuvo-start\"")
        try await Task.sleep(for: .seconds(3))
        #expect(try await RemoteServer.find(on: connection) == .stopped)
        _ = try await connection.run("pkill -f '[/]\\.kuvo-code-test/' || true; rm -rf \"$HOME/.kuvo-code-test\"")
    }

    /// The engine running now, once it is (the keeper starts it in the background): a minute at
    /// most, and one `matching`.
    private func runningSoon(_ matching: (RemoteServer.Engine) -> Bool = { _ in true }) async throws -> RemoteServer.Engine? {
        for _ in 0..<120 {
            if let found = try await RemoteServer.running(on: connection), matching(found) { return found }
            try await Task.sleep(for: .milliseconds(500))
        }
        return nil
    }

    /// The machine keeps its engine running by itself: one that crashes comes back; Stop keeps it
    /// down, though its keeper runs on; Start brings it back.
    @Test func itKeepsItselfRunningUntilStopped() async throws {
        let cache = FileManager.default.temporaryDirectory.appending(path: "opencodekit-remote-cache")
        defer { try? FileManager.default.removeItem(at: cache) }
        try await RemoteEngineInstaller(connection: connection, cache: cache).install()
        try await RemoteServer.stop(on: connection)
        let first = try await RemoteServer.launch(on: connection, environment: [:], notes: ["mac": "test-mac", "settings": "abc"])

        _ = try await connection.run("kill -9 \(first.pid)")
        let back = try #require(try await runningSoon { $0.pid != first.pid }, "its keeper started it again")
        #expect(back.notes == ["mac": "test-mac", "settings": "abc"])

        try await RemoteServer.stopEngine(on: connection)
        #expect(try await RemoteServer.find(on: connection) == .stopped)
        try await Task.sleep(for: .seconds(20))
        #expect(try await RemoteServer.find(on: connection) == .stopped, "it stays stopped")
        #expect(!(try await connection.run("pgrep -f '[.]kuvo-code-test/bin/kuvo-start keep' || true")).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "its keeper runs on")
        // A start from the Mac keeps it so; Start doesn't.
        await #expect(throws: RemoteEngineError.self) { try await RemoteServer.launch(on: connection, environment: [:], notes: [:]) }
        try await RemoteServer.startEngine(on: connection)
        #expect(try await runningSoon() != nil)

        try await RemoteServer.stop(on: connection)
        _ = try await connection.run("pkill -f '[/]\\.kuvo-code-test/' || true; rm -rf \"$HOME/.kuvo-code-test\"")
    }

    /// A phone's restart, as the machine's bridge does it (`kuvo/engine/restart` in kuvo-link.js,
    /// run as the bridge runs, by the engine's runtime as Bun): the engine stops and starts again
    /// as after a restart, as itself, never as Bun.
    @Test func aPhonesRestartThroughTheBridgeBringsItBack() async throws {
        let cache = FileManager.default.temporaryDirectory.appending(path: "opencodekit-remote-cache")
        defer { try? FileManager.default.removeItem(at: cache) }
        try await RemoteEngineInstaller(connection: connection, cache: cache).install()
        try await RemoteServer.stop(on: connection)
        let first = try await RemoteServer.launch(on: connection, environment: [:], notes: ["mac": "test-mac", "settings": "abc"])

        let bridge = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js").standardizedFileURL
        let runner = FileManager.default.temporaryDirectory.appending(path: "restart-\(UUID().uuidString).mjs")
        defer { try? FileManager.default.removeItem(at: runner) }
        try Data("""
            const link = await import(process.env.KUVO_HOME + "/bin/kuvo-link.js");
            for await (const part of link.engineHandler()({ method: "POST", path: "kuvo/engine/restart", headers: {}, body: Buffer.alloc(0) }, {}, undefined)) {
              if (part.head) console.log(part.head.status);
            }
            await new Promise(done => setTimeout(done, 1500));
            """.utf8).write(to: runner)
        _ = try await connection.run("cat >\"$HOME/.kuvo-code-test/bin/kuvo-link.js\"", input: bridge)
        _ = try await connection.run("cat >\"$HOME/.kuvo-code-test/bin/restart.mjs\"", input: runner)
        let answered = try await connection.run("""
            K="$HOME/.kuvo-code-test"; cd "$K/workspace" && KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$K/engine/\(OpenCodeEngine.version)/opencode" "$K/bin/restart.mjs"
            """)
        #expect(answered.trimmingCharacters(in: .whitespacesAndNewlines) == "202")

        var again: RemoteServer.Engine?
        for _ in 0..<60 {
            try await Task.sleep(for: .milliseconds(500))
            if let found = try await RemoteServer.running(on: connection), found.pid != first.pid { again = found; break }
        }
        let back = try #require(again, "started again")
        #expect(back.notes == ["mac": "test-mac", "settings": "abc"], "the Mac knows it as its own")
        let server = try await RemoteServer.attach(to: back, on: connection)
        struct Info: Decodable { var version: String }
        let client = HTTPClient(endpoint: server.endpoint)
        #expect((try? await client.send(client.request("GET", "api/info"), as: Info.self)) != nil, "it answers as the engine")
        server.disconnect()
        let environment = try await connection.run("tr '\\0' '\\n' </proc/\(back.pid)/environ")
        #expect(!environment.contains("BUN_BE_BUN"))
        #expect(try await connection.run("kill -0 \(first.pid) 2>/dev/null && echo alive || true").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

        try await RemoteServer.stop(on: connection)
        _ = try await connection.run("pkill -f '[/]\\.kuvo-code-test/' || true; rm -rf \"$HOME/.kuvo-code-test\"")
    }

    /// A machine's settings become its own (a box of its own): what an older Mac's start left goes
    /// in its box, with its key; a start then reads the box, nothing of a Mac's below it; and a
    /// change made through the box's tool, as a phone's or a Mac's is, reaches the engine running
    /// without starting it over.
    @Test func aMachinesSettingsBecomeItsOwnAndReloadAsTheyChange() async throws {
        let cache = FileManager.default.temporaryDirectory.appending(path: "opencodekit-remote-cache")
        defer { try? FileManager.default.removeItem(at: cache) }
        try await RemoteEngineInstaller(connection: connection, cache: cache).install()
        try await RemoteServer.stop(on: connection)
        // As an older Mac started it: its settings, the integrations' in the global file, a key.
        let older = try await RemoteServer.launch(on: connection, environment: [
            RemoteServer.privateSettingsVariable: #"{"agents":{"reviewer":{"description":"Reviews code","mode":"subagent","prompt":"Review."}}}"#,
            "KUVO_SETTINGS": #"{"websearch":{"provider":"exa"}}"#,
            "KUVO_KEY_TEST_TOKEN": "box-secret",
        ], notes: ["mac": "test-mac"])

        let tool = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js").standardizedFileURL
        _ = try await connection.run("cat >\"$HOME/.kuvo-code-test/bin/kuvo-link.js\"", input: tool)
        let box = { (command: String) in
            try await self.connection.run("""
                K="$HOME/.kuvo-code-test"; cd "$K/workspace" && KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$K/engine/\(OpenCodeEngine.version)/opencode" "$K/bin/kuvo-link.js" box \(command)
                """)
        }
        let adopted = try await box("adopt </dev/null")
        #expect(adopted.contains(#""status":"adopted""#), "\(adopted)")
        let own = try await connection.run("cat \"$HOME/.kuvo-code-test/box/opencode.json\"")
        #expect(own.contains("Reviews code") && own.contains("exa"), "both of what the older start left: \(own)")
        #expect(try await connection.run("cat \"$HOME/.kuvo-code-test/box/keys/KUVO_KEY_TEST_TOKEN\"") == "box-secret")

        // A start from this Mac now: nothing of its settings sent, the box read.
        let started = try await RemoteServer.launch(on: connection, environment: [:], notes: ["mac": "test-mac"], replace: older.pid)
        let environment = try await connection.run("tr '\\0' '\\n' </proc/\(started.pid)/environ")
        #expect(environment.contains("OPENCODE_CONFIG=\(try await connection.run("printf %s \"$HOME\"").trimmingCharacters(in: .whitespacesAndNewlines))/.kuvo-code-test/box/opencode.json"))
        #expect(try await connection.run("cat \"$HOME/.kuvo-code-test/config/opencode/opencode.json\"").trimmingCharacters(in: .whitespacesAndNewlines) == "{}")
        #expect(try await connection.run("[ -e \"$HOME/.kuvo-code-test/keys/settings.json\" ] && echo there || true").isEmpty)

        let server = try await RemoteServer.attach(to: started, on: connection)
        defer { server.disconnect() }
        let api = OpenCodeAPI(endpoint: server.endpoint)
        let sources = { String(decoding: try JSONEncoder().encode(try await api.configSources()), as: UTF8.self) }
        #expect(try await sources().contains("Reviews code"), "the engine reads the box")

        // Changed through the box's tool, as from a phone: the engine running takes it.
        let changes = FileManager.default.temporaryDirectory.appending(path: "box-change-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: changes) }
        try Data(#"{"changes":[{"path":["agents","reviewer","description"],"value":"Reviews code carefully"}]}"#.utf8).write(to: changes)
        _ = try await connection.run("cat >\"$HOME/.kuvo-code-test/run/change.json\"", input: changes)
        let changed = try await box("change <\"$HOME/.kuvo-code-test/run/change.json\"")
        #expect(changed.contains("Reviews code carefully"), "\(changed)")
        var reloaded = false
        for _ in 0..<40 where !reloaded {
            try await Task.sleep(for: .milliseconds(250))
            reloaded = (try? await sources().contains("Reviews code carefully")) == true
        }
        #expect(reloaded, "reloaded, not started over")
        #expect(try await RemoteServer.running(on: connection)?.pid == started.pid)

        try await RemoteServer.stop(on: connection)
        _ = try await connection.run("pkill -f '[/]\\.kuvo-code-test/' || true; rm -rf \"$HOME/.kuvo-code-test\"")
    }

    /// The crontab line that starts it after a restart: added once, beside what's there; a crontab
    /// that can't be read is left as it is; taken out with the machine, the rest kept. Against a
    /// stand-in `crontab` in a folder of the test's own, never the machine's.
    @Test func theCrontabLineIsAddedOnceAndTakenOut() async throws {
        let folder = "\"$HOME/.kuvo-code-test/crontab-test\""
        let stand = """
            mkdir -p \(folder)/bin && R=\(folder) && cat >\(folder)/bin/crontab <<'EOF'
            #!/bin/sh
            f="$HOME/.kuvo-code-test/crontab-test/tab"
            [ -f "$HOME/.kuvo-code-test/crontab-test/broken" ] && { echo "crontab: cannot read" >&2; exit 1; }
            if [ "$1" = -l ]; then [ -f "$f" ] || { echo "no crontab for test" >&2; exit 1; }; cat "$f"; else cat >"$f"; fi
            EOF
            chmod +x \(folder)/bin/crontab
            export PATH=\(folder)/bin:$PATH
            # Never the machine's own.
            [ "$(command -v crontab)" = "$HOME/.kuvo-code-test/crontab-test/bin/crontab" ] || exit 9
            """
        let tab = "cat \(folder)/tab 2>/dev/null || true"
        _ = try await connection.run("\(stand)\n\(RemoteServer.rebootCrontabScript)")
        #expect(try await connection.run(tab) == RemoteServer.rebootLine + "\n", "none yet: just the line")
        _ = try await connection.run("printf '0 3 * * * backup\\n%s\\n' \(SSHConnection.quoted(RemoteServer.rebootLine)) >\(folder)/tab")
        _ = try await connection.run("\(stand)\n\(RemoteServer.rebootCrontabScript)")
        #expect(try await connection.run(tab) == "0 3 * * * backup\n" + RemoteServer.rebootLine + "\n", "once, beside what's there")
        _ = try await connection.run("printf '0 3 * * * backup\\n' >\(folder)/tab; touch \(folder)/broken")
        _ = try await connection.run("\(stand)\n\(RemoteServer.rebootCrontabScript)")
        #expect(try await connection.run(tab) == "0 3 * * * backup\n", "one that can't be read is left as it is")
        _ = try await connection.run("rm -f \(folder)/broken; printf '0 3 * * * backup\\n%s\\n' \(SSHConnection.quoted(RemoteServer.rebootLine)) >\(folder)/tab")
        _ = try await connection.run("\(stand)\n\(RemoteServer.crontabRemovalScript)")
        #expect(try await connection.run(tab) == "0 3 * * * backup\n", "taken out, the rest kept")
        _ = try await connection.run("rm -rf \"$HOME/.kuvo-code-test\"")
    }

    /// The commands the agent runs there get the machine's own folders, not the engine's in
    /// `~/.kuvo-code`.
    @Test func commandsGetTheMachinesOwnFolders() async throws {
        let cache = FileManager.default.temporaryDirectory.appending(path: "opencodekit-remote-cache")
        defer { try? FileManager.default.removeItem(at: cache) }
        try await RemoteEngineInstaller(connection: connection, cache: cache).install()
        try await RemoteServer.stop(on: connection)
        let home = try await connection.run("printf %s \"$HOME\"")
        let project = home + "/.kuvo-code-test/test-project"
        _ = try await connection.run("mkdir -p '\(project)'")

        let engine = try await RemoteServer.launch(on: connection, environment: [:])
        let server = try await RemoteServer.attach(to: engine, on: connection)
        let api = OpenCodeAPI(endpoint: server.endpoint)
        let session = try await api.createSession(directory: project)
        try await api.runShell(session: session.id, command: #"printf '%s|%s' "${XDG_CONFIG_HOME:-unset}" "${KUVO_OWN_XDG_CONFIG_HOME-unset}" >seen"#)
        var seen = ""
        for _ in 0..<50 where seen.isEmpty {
            seen = try await connection.run("cat '\(project)/seen' 2>/dev/null || true")
            if seen.isEmpty { try await Task.sleep(for: .milliseconds(200)) }
        }
        let own = try await connection.run("printf %s \"${XDG_CONFIG_HOME:-unset}\"")
        #expect(seen == own + "|unset")
        // Only you can open its folder there.
        #expect(try await connection.run("stat -c %a \"$HOME/.kuvo-code-test\"").trimmingCharacters(in: .whitespacesAndNewlines) == "700")
        server.disconnect()

        try await RemoteServer.stop(on: connection)
        _ = try await connection.run("pkill -f '[/]\\.kuvo-code-test/' || true; rm -rf \"$HOME/.kuvo-code-test\"")
    }
}
