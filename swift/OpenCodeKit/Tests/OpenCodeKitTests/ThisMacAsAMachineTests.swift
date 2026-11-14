import Foundation
import Testing
@testable import OpenCodeKit

/// A Mac as a machine, for real, without a second Mac or SSH: what would be said over SSH runs here
/// by `sh`, in a home folder of the test's own, with no `KUVO_*` around it: macOS's own tools, the
/// engine's real Mac build, the keeper, its session and its reboot recovery, and the box's link and
/// agents bridge. It downloads the engine, so it runs only when asked:
///
///     KUVO_TEST_THIS_MAC=1 swift test --filter ThisMacAsAMachineTests
///
/// It has no SSH and no browser in it: `LiveRemoteEngineTests`, with `KUVO_TEST_SSH_HOST` naming a Mac,
/// takes it over SSH.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["KUVO_TEST_THIS_MAC"] != nil), .serialized, OwnMachineFolder(), AccountUntouched())
struct ThisMacAsAMachineTests {
    /// Short, as a real home is, as sockets need.
    let home = URL(filePath: "/private/tmp/kuvo-mac-machine-\(UUID().uuidString.prefix(6))")
    var box: URL { home.appending(path: ".kuvo-code-test") }
    let connection = SSHConnection(destination: "this-mac.invalid")

    /// Where this checkout's built files are.
    private static let repository = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    /// Beside the home: stand-ins for the account's crontab and launchd, which a home of the test's
    /// own doesn't keep it from, first on the PATH. Each notes that it was run.
    private static func standIns(home: URL) -> URL { URL(filePath: home.path + "-account") }

    private static func environment(home: URL) -> [String: String] {
        ["HOME": home.path, "USER": NSUserName(), "LOGNAME": NSUserName(), "SHELL": "/bin/zsh", "PATH": "\(standIns(home: home).path):/usr/bin:/bin:/usr/sbin:/sbin"]
    }

    @discardableResult
    private static func runHere(_ script: String, input: URL?, home: URL) -> String? {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", script]
        process.environment = environment(home: home)
        process.currentDirectoryURL = home
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        if let input, let file = try? FileHandle(forReadingFrom: input) { process.standardInput = file } else { process.standardInput = FileHandle.nullDevice }
        guard (try? process.run()) != nil else { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
    }

    private func here(_ script: String) -> String {
        (Self.runHere(script, input: nil, home: home) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func until(seconds: TimeInterval = 90, _ condition: () async throws -> Bool) async rethrows -> Bool {
        let end = Date.now.addingTimeInterval(seconds)
        while Date.now < end {
            if try await condition() { return true }
            try? await Task.sleep(for: .milliseconds(250))
        }
        return false
    }

    /// Whatever's still running from its folder is stopped by its process, and the folder goes.
    private func cleanUp() {
        for line in here("ps -axww -o pid=,command= | grep -F \(SSHConnection.quoted(home.path)) | grep -v grep").split(separator: "\n") {
            if let pid = pid_t(line.split(separator: " ").first ?? "") { kill(pid, SIGKILL) }
        }
        try? FileManager.default.removeItem(at: home)
        try? FileManager.default.removeItem(at: Self.standIns(home: home))
        SSHConnection.fedStandIn = nil
    }

    @Test(.timeLimit(.minutes(10))) func itInstallsRunsSurvivesAndStopsWithAMacsOwnTools() async throws {
        defer { cleanUp() }
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let home = home
        let account = Self.standIns(home: home)
        try FileManager.default.createDirectory(at: account, withIntermediateDirectories: true)
        for tool in ["crontab", "launchctl"] {
            let file = account.appending(path: tool)
            try Data("#!/bin/sh\necho \"\(tool) $*\" >>\"\(account.path)/used\"\n".utf8).write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        }
        SSHConnection.fedStandIn = { _, script, input in Self.runHere(script, input: input, home: home) }
        let realHomeBefore = try FileManager.default.contentsOfDirectory(atPath: NSHomeDirectory()).sorted()

        // The build for this Mac, from npm, checked and put there, and it runs.
        let installer = RemoteEngineInstaller(connection: connection, cache: home.appending(path: "cache"))
        try await installer.install()
        #expect(try await installer.check().isInstalled)
        let engine = box.appending(path: "engine/\(OpenCodeEngine.version)/opencode")

        // The box's own code beside it.
        for (name, file) in [("kuvo-link.js", "swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js"), ("kuvo-agents.js", "box/dist/kuvo-agents.js")] {
            let to = box.appending(path: "bin/\(name)")
            try FileManager.default.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: Self.repository.appending(path: file), to: to)
        }

        // Started by a shell that's gone by now, as a command over SSH is.
        let started = try await RemoteServer.launch(on: connection, environment: ["KUVO_TZ": "Europe/Istanbul"], notes: ["test": "yes", "mac": "test-mac"], withAgents: true)
        #expect(getsid(pid_t(started.pid)) == pid_t(started.pid), "a session of its own")
        struct Info: Decodable { var version: String }
        func asked(_ port: Int, password: String) async -> Bool {
            let client = HTTPClient(endpoint: ServerEndpoint(url: URL(string: "http://127.0.0.1:\(port)")!, password: password))
            return (try? await client.send(client.request("GET", "api/info"), as: Info.self))?.version == OpenCodeEngine.version
        }
        #expect(await until { await asked(started.port, password: started.password) }, "the engine answers")
        #expect(here("cat \"$HOME/.kuvo-code-test/run/login-path\"").contains("/usr/bin"), "your login shell's PATH was read")

        // Its keeper runs, holds it awake, and finds it again as it is.
        #expect(await until(seconds: 30) { !here("cat \"$HOME/.kuvo-code-test/run/box.pid\" 2>/dev/null").isEmpty })
        let keeper = here("cat \"$HOME/.kuvo-code-test/run/box.pid\"")
        #expect(here("ps -ww -o command= -p \(keeper)").contains("kuvo-start"))
        #expect(await until(seconds: 30) { here("ps -ww -o command= -p \"$(cat \"$HOME/.kuvo-code-test/run/awake.pid\" 2>/dev/null)\"").contains("caffeinate -s -w \(keeper)") })
        #expect(try await RemoteServer.running(on: connection) == started)

        // The agents bridge beside it.
        let bridge = try #require(started.agents)
        #expect(await until(seconds: 60) { here("curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:\(bridge.port)/") != "000" }, "the agents bridge answers")

        // The box's link, as a machine's, on a Mac: its code runs, and it's no "Mac" of the app's.
        #expect(here("cd \"$HOME/.kuvo-code-test\" && KUVO_HOME=\"$PWD\" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 engine/\(OpenCodeEngine.version)/opencode --config=/dev/null --no-env-file bin/kuvo-link.js selftest").contains("ok"))

        // Ended by something (a crash): its keeper starts it again.
        kill(pid_t(started.pid), SIGKILL)
        var back: RemoteServer.Engine?
        #expect(try await until { back = try await RemoteServer.running(on: self.connection); return back != nil && back?.pid != started.pid }, "its keeper started it again")
        let again = try #require(back)
        #expect(again.notes == started.notes)
        #expect(await until { await asked(again.port, password: again.password) })

        // Stopped, it all stops, and nothing's left running from it.
        try await RemoteServer.stop(on: connection)
        #expect(await until(seconds: 30) { here("ps -axww -o command= | grep -F \(SSHConnection.quoted(home.path)) | grep -v grep | wc -l") == "0" }, "nothing's left running")

        // And nothing of it landed outside its folder, or in the account's crontab or launchd.
        #expect(!FileManager.default.fileExists(atPath: account.appending(path: "used").path), "a test's folder adds no way back after a restart")
        #expect(try FileManager.default.contentsOfDirectory(atPath: NSHomeDirectory()).sorted() == realHomeBefore)
        #expect(!FileManager.default.fileExists(atPath: NSHomeDirectory() + "/Library/LaunchAgents/\(RemoteServer.launchAgent).plist"))
        #expect(try FileManager.default.contentsOfDirectory(atPath: home.path).sorted() == [".kuvo-code-test", "cache"])
    }
}
