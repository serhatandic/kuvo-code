import Foundation
import Testing
@testable import OpenCodeKit

/// A Mac's own box in a home of its own (#333: `box/kind` says `mac`) keeps its Mac awake itself,
/// while agents work and as its own setting says: its keeper (`kuvo-start keep`) holds nothing for
/// it, and lets go of a hold it had, where a machine's holds its Mac awake for as long as it runs
/// (`RebootTests`). Run here in a home of the test's own, with stand-ins for `caffeinate` (never this
/// Mac held for real), `sleep` (the keeper's rounds made quick, each counted) and `pkill` (what the
/// keeper's COMPAT line would run, never run for real).
@Suite(.serialized, AccountUntouched()) struct MacKindKeeperTests {
    let home: URL
    let tools: URL
    var root: URL { home.appending(path: RemoteEngineInstaller.root) }
    var run: URL { root.appending(path: "run") }

    init() throws {
        home = FileManager.default.temporaryDirectory.appending(path: "opencodekit-mac-kind-\(UUID().uuidString)")
        tools = home.appending(path: "tools")
        try FileManager.default.createDirectory(at: tools, withIntermediateDirectories: true)
        try tool("caffeinate", "echo \"$*\" >>\"$HOME/awake\"; while :; do /bin/sleep 1; done")
        try tool("sleep", "echo round >>\"$HOME/rounds\"; exec /bin/sleep 0.02")
        try tool("pkill", "echo \"$*\" >>\"$HOME/pkill\"")
        try FileManager.default.createDirectory(at: run, withIntermediateDirectories: true)
        let bin = root.appending(path: "bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        for (name, text) in RemoteServer.bootFiles.files { try write(bin.appending(path: name), text, executable: true) }
        try write(bin.appending(path: ".kuvo-boot"), "1")
        try FileManager.default.createDirectory(at: root.appending(path: "box"), withIntermediateDirectories: true)
        try write(root.appending(path: "box/kind"), "mac\n")
    }

    private func tool(_ name: String, _ body: String) throws {
        try write(tools.appending(path: name), "#!/bin/sh\n" + body + "\n", executable: true)
    }

    private func write(_ file: URL, _ text: String, executable: Bool = false) throws {
        try Data(text.utf8).write(to: file)
        if executable { try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path) }
    }

    private func lines(_ name: String) -> [Substring] {
        ((try? String(contentsOf: home.appending(path: name), encoding: .utf8)) ?? "").split(separator: "\n")
    }

    /// `condition`, looked at until it holds (a minute at most, for a slow machine).
    private func until(_ condition: () -> Bool) {
        let end = Date().addingTimeInterval(60)
        while !condition(), Date() < end { usleep(20_000) }
    }

    private func started(_ executable: String, _ arguments: [String]) throws -> Process {
        let process = Process()
        process.executableURL = URL(filePath: executable)
        process.arguments = arguments
        process.environment = ["HOME": home.path, "PATH": "\(tools.path):/usr/bin:/bin"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        return process
    }

    @Test func aMacsOwnBoxKeeperHoldsNothingAwakeAndLetsGoOfAHoldItHad() throws {
        // A hold a keeper had before the box recorded its kind (the stand-in, started here).
        let before = try started("/bin/sh", [tools.appending(path: "caffeinate").path, "-s", "-w", "1"])
        try write(run.appending(path: "awake.pid"), "\(before.processIdentifier)")
        let keeper = try started("/bin/sh", [root.appending(path: "bin/kuvo-start").path, "keep"])
        defer {
            for process in [keeper, before] where process.isRunning { process.terminate(); process.waitUntilExit() }
            try? FileManager.default.removeItem(at: home)
        }
        until { !before.isRunning }
        #expect(!before.isRunning, "the hold it had, let go")
        // A few of its rounds, each quick here: it held nothing of its own meanwhile.
        until { lines("rounds").count > 6 }
        #expect(lines("rounds").count > 6)
        #expect(keeper.isRunning)
        #expect(lines("awake") == ["-s -w 1"], "only the one from before")
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "awake.pid").path))
    }
}
