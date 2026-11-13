import Foundation
import Testing
@testable import OpenCodeKit

/// A Mac's own box in a home of its own (#333: `box/kind` says `mac`) keeps its Mac awake itself,
/// while agents work and as its own setting says, once its link runs to do so (`run/work-awake.json`
/// names it): then its keeper (`kuvo-start keep`) holds nothing for it and lets go of a hold it had;
/// until then it holds the Mac awake as a machine's does (`RebootTests`). Its engine's start
/// (`kuvo-launch`) leaves its settings in `config` as they are, whatever a machine's start left in
/// that home. Run here in a home of the test's own, with stand-ins for `caffeinate` (never this Mac
/// held for real), `sleep` (the keeper's rounds made quick, each counted), `pkill` (what the keeper's
/// COMPAT line would run, never run for real), the box's link and the engine. Each stand-in that
/// waits gives up by itself after two minutes, and what a test started is stopped by its process.
@Suite(.serialized, AccountUntouched()) struct MacKindKeeperTests {
    let home: URL
    let tools: URL
    var root: URL { home.appending(path: RemoteEngineInstaller.root) }
    var run: URL { root.appending(path: "run") }
    /// Waits, two minutes at most.
    static let waits = "i=0; while [ $i -lt 120 ]; do /bin/sleep 1; i=$((i + 1)); done"

    init() throws {
        home = FileManager.default.temporaryDirectory.appending(path: "opencodekit-mac-kind-\(UUID().uuidString)")
        tools = home.appending(path: "tools")
        try FileManager.default.createDirectory(at: tools, withIntermediateDirectories: true)
        try tool("caffeinate", "echo \"$*\" >>\"$HOME/awake\"; \(Self.waits)")
        try tool("sleep", "echo round >>\"$HOME/rounds\"; exec /bin/sleep 0.02")
        try tool("pkill", "echo \"$*\" >>\"$HOME/pkill\"")
        // The box's link as `serve` runs (its command line names kuvo-link).
        try tool("kuvo-link", Self.waits)
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
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
        if executable { try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path) }
    }

    private func text(_ file: URL) -> String { (try? String(contentsOf: file, encoding: .utf8)) ?? "" }
    private func lines(_ name: String) -> [Substring] { text(home.appending(path: name)).split(separator: "\n") }

    /// `condition`, looked at until it holds (a minute at most, for a slow machine).
    private func until(_ condition: () -> Bool) {
        let end = Date().addingTimeInterval(60)
        while !condition(), Date() < end { usleep(20_000) }
    }

    private func started(_ arguments: [String]) throws -> Process {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = arguments
        process.environment = ["HOME": home.path, "PATH": "\(tools.path):/usr/bin:/bin"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        return process
    }

    /// What a test started, stopped by its process, with what it recorded starting (a keeper the
    /// engine's start started first, then what it held and ran), and the test's folder gone.
    private func cleanUp(_ processes: [Process]) {
        for process in processes where process.isRunning { process.terminate(); process.waitUntilExit() }
        for record in ["box.pid", "awake.pid", "engine.json"] {
            let said = text(run.appending(path: record))
            let pid = Int32(said.trimmingCharacters(in: .whitespacesAndNewlines)) ?? Int32(said.firstMatch(of: /"pid":(\d+)/)?.1 ?? "")
            if let pid, pid > 1 { kill(pid, SIGTERM) }
        }
        try? FileManager.default.removeItem(at: home)
    }

    @Test func whileItsLinkKeepsTheMacAwakeTheKeeperHoldsNothingAndLetsGoOfAHoldItHad() throws {
        var processes: [Process] = []
        defer { cleanUp(processes) }
        let link = try started([tools.appending(path: "kuvo-link").path])
        processes.append(link)
        try write(run.appending(path: "work-awake.json"), #"{"by":\#(link.processIdentifier),"hold":null}"#)
        // A hold a keeper had before (the stand-in, started here).
        let before = try started([tools.appending(path: "caffeinate").path, "-s", "-w", "1"])
        processes.append(before)
        try write(run.appending(path: "awake.pid"), "\(before.processIdentifier)")
        let keeper = try started([root.appending(path: "bin/kuvo-start").path, "keep"])
        processes.insert(keeper, at: 0)
        until { !before.isRunning }
        #expect(!before.isRunning, "the hold it had, let go")
        // A few of its rounds, each quick here: it held nothing of its own meanwhile.
        until { lines("rounds").count > 6 }
        #expect(lines("rounds").count > 6)
        #expect(keeper.isRunning)
        #expect(lines("awake") == ["-s -w 1"], "only the one from before")
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "awake.pid").path))
    }

    @Test func untilItsLinkRunsTheKeeperHoldsTheMacAwakeAsAMachinesDoes() throws {
        var processes: [Process] = []
        defer { cleanUp(processes) }
        // What a link that has since gone said.
        try write(run.appending(path: "work-awake.json"), #"{"by":999999,"hold":null}"#)
        let keeper = try started([root.appending(path: "bin/kuvo-start").path, "keep"])
        processes.append(keeper)
        until { !lines("awake").isEmpty }
        #expect(lines("awake") == ["-s -w \(keeper.processIdentifier)"])
    }

    @Test func itsEngineStartsWithItsOwnSettingsWhateverAMachinesStartLeft() throws {
        var processes: [Process] = []
        defer { cleanUp(processes) }
        // The engine: notes how it was started, says where it listens, and runs until stopped.
        let engine = root.appending(path: "engine/\(OpenCodeEngine.version)/opencode")
        try write(engine, "#!/bin/sh\nenv | sort >\"$HOME/engine.env\"\necho \"server listening on http://127.0.0.1:$3\"\n\(Self.waits)\n", executable: true)
        try write(run.appending(path: "launch.env"), "PATH=\(tools.path):/usr/bin:/bin\nLANG=en_US.UTF-8\n")
        try write(run.appending(path: "launch.notes"), #"{"mac":"test-mac"}"#)
        // What this home kept from when it was a machine's: its adopted settings, and the global
        // file's mark, which a machine's start empties.
        try write(root.appending(path: "box/opencode.json"), #"{"model":"a-machine's"}"#)
        try write(root.appending(path: "box/global-adopted"), "")
        let own = root.appending(path: "config/opencode/opencode.json")
        try write(own, #"{"model":"this Mac's"}"#)
        // And an older Mac's private settings, which nothing reads here.
        let older = root.appending(path: "keys/settings.json")
        try write(older, #"{"model":"an older Mac's"}"#)
        let start = try started([root.appending(path: "bin/kuvo-start").path, "engine"])
        processes.append(start)
        until { FileManager.default.fileExists(atPath: home.appending(path: "engine.env").path) && FileManager.default.fileExists(atPath: run.appending(path: "engine.json").path) }
        #expect(text(own) == #"{"model":"this Mac's"}"#, "its own settings, as they were")
        let environment = text(home.appending(path: "engine.env"))
        #expect(!environment.isEmpty)
        #expect(!environment.contains("OPENCODE_CONFIG="), "nothing read before them")
        #expect(environment.contains("XDG_CONFIG_HOME=\(root.path)/config"))
        #expect(!FileManager.default.fileExists(atPath: older.path), "an older Mac's settings, gone")
    }
}
