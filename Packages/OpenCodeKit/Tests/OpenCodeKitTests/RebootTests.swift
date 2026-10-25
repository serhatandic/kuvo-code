import Foundation
import Testing
@testable import OpenCodeKit

/// A machine is a box of its own: its keeper (`kuvo-start`, from its crontab after a restart and
/// from every connect) keeps the engine running as Kuvo Code last started it (its settings, keys
/// and environment, with new passwords), with or without a Mac: after a crash or a restart, and a
/// day without the app too. Only a Stop stops it, until a Start. It keeps the phone link up while a
/// phone is paired, sends wake-ups each minute, and goes when its script does. A start from the Mac
/// keeps a stopped engine stopped, unless it's Start, and replaces one in the same start. Run
/// here, in a home folder of the test's own, with a stand-in engine, and stand-ins for what Linux
/// has that a Mac doesn't (`setsid`, `/proc`). The live suite does the same on a real machine.
@Suite(.serialized) struct RebootTests {
    let home: URL
    let tools: URL
    var root: URL { home.appending(path: RemoteEngineInstaller.root) }
    var run: URL { root.appending(path: "run") }

    init() throws {
        home = FileManager.default.temporaryDirectory.appending(path: "opencodekit-reboot-\(UUID().uuidString)")
        tools = home.appending(path: "tools")
        try FileManager.default.createDirectory(at: tools, withIntermediateDirectories: true)
        // `setsid` starts what it's given (a Mac has none); `grep` reads `/proc/<pid>/cmdline` as
        // Linux has it, from `ps`.
        try tool("setsid", #"exec "$@""#)
        try tool("grep", """
            n=$#; i=0; file=
            for a in "$@"; do i=$((i + 1)); if [ $i -lt $n ]; then set -- "$@" "$a"; else file=$a; fi; done
            shift $n
            case "$file" in
              /proc/[0-9]*/cmdline) pid=${file#/proc/}; pid=${pid%/cmdline}; ps -p "$pid" -o args= 2>/dev/null | /usr/bin/grep "$@" ;;
              *) exec /usr/bin/grep "$@" "$file" ;;
            esac
            """)
        // The engine: says it's listening, notes how it was started, and runs until stopped. Run
        // with the phone link's script, it's the phone link: it notes its process, as that does.
        let engine = root.appending(path: "engine/\(OpenCodeEngine.version)/opencode")
        try FileManager.default.createDirectory(at: engine.deletingLastPathComponent(), withIntermediateDirectories: true)
        try write(engine, """
            #!/bin/sh
            case "$1" in *kuvo-link.js) env | sort >"$HOME/link.env"; echo $$ >"$KUVO_HOME/run/link.pid"; while :; do /bin/sleep 1; done ;; esac
            env | sort >"$HOME/engine-$$.env"
            echo "server listening on http://127.0.0.1:$3"
            while :; do /bin/sleep 1; done
            """, executable: true)
        // What the Mac's last start left: how it started it, and its notes.
        try FileManager.default.createDirectory(at: run, withIntermediateDirectories: true)
        try write(run.appending(path: "launch.env"), "PATH=\(tools.path):/usr/bin:/bin\nLANG=tr_TR.UTF-8\nKUVO_TZ=Europe/Istanbul\n")
        try write(run.appending(path: "launch.notes"), #"{"mac":"test-mac","settings":"abc"}"#)
        let bin = root.appending(path: "bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try write(bin.appending(path: "kuvo-start"), RemoteServer.bootScript, executable: true)
        try write(bin.appending(path: "kuvo-launch"), RemoteServer.bootLaunchScript, executable: true)
        try write(bin.appending(path: ".kuvo-boot"), "1")
        // Its keys, which a restart keeps.
        let keys = root.appending(path: "keys")
        try FileManager.default.createDirectory(at: keys, withIntermediateDirectories: true)
        try write(keys.appending(path: "KUVO_KEY_TEST"), "secret-key")
        try write(keys.appending(path: "settings.json"), #"{"mcp":{}}"#)
        // The keeper's rounds made quick (15 seconds each on a machine), each wake-up round counted.
        try tool("sleep", "exec /bin/sleep 0.02")
        try write(bin.appending(path: "kuvo-wake"), "#!/bin/sh\necho >>\"$HOME/rounds\"\n", executable: true)
    }

    private func tool(_ name: String, _ body: String) throws {
        try write(tools.appending(path: name), "#!/bin/sh\n" + body + "\n", executable: true)
    }

    private func write(_ file: URL, _ text: String, executable: Bool = false) throws {
        try Data(text.utf8).write(to: file)
        if executable { try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path) }
    }

    /// Everything it started (the keeper, the engine, the phone link) stopped, and its folder gone.
    private func cleanUp() {
        let stop = Process()
        stop.executableURL = URL(filePath: "/usr/bin/pkill")
        stop.arguments = ["-f", home.path]
        try? stop.run()
        stop.waitUntilExit()
        try? FileManager.default.removeItem(at: home)
    }

    /// The machine's engine record as a restart left it, as it was before (a dead number).
    private func ranBefore(pid: Int32 = 999_999) throws {
        try write(run.appending(path: "engine.json"), #"{"pid":\#(pid),"port":1,"password":"old","version":"\#(OpenCodeEngine.version)","notes":{"mac":"test-mac","settings":"abc"}}"#)
    }

    /// `kuvo-start` as cron runs it (next to nothing in its environment), or with `command`.
    @discardableResult
    private func start(_ command: String? = nil) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = [root.appending(path: "bin/kuvo-start").path] + (command.map { [$0] } ?? [])
        process.environment = ["HOME": home.path, "PATH": "\(tools.path):/usr/bin:/bin"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }

    private func record() -> RemoteServer.Engine? {
        guard let data = try? Data(contentsOf: run.appending(path: "engine.json")) else { return nil }
        return try? JSONDecoder().decode(RemoteServer.Engine.self, from: data)
    }

    /// The engine running now, as its record says.
    private func running() -> RemoteServer.Engine? {
        record().flatMap { alive($0.pid) ? $0 : nil }
    }

    /// The environments engines were started with, one for each.
    private func started() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: home.path).filter { $0.hasPrefix("engine-") }
            .map { try String(contentsOf: home.appending(path: $0), encoding: .utf8) }
    }

    private func alive(_ pid: Int) -> Bool { kill(pid_t(pid), 0) == 0 }

    private func pid(_ file: String) -> Int? {
        (try? String(contentsOf: run.appending(path: file), encoding: .utf8)).flatMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    private var keeper: Int? { pid("box.pid").flatMap { alive($0) ? $0 : nil } }

    private func rounds() -> Int {
        ((try? String(contentsOf: home.appending(path: "rounds"), encoding: .utf8)) ?? "").filter { $0 == "\n" }.count
    }

    /// Until `condition` holds: a minute at most, for a Mac busy with other tests.
    private func until(_ condition: () throws -> Bool) rethrows {
        let end = Date.now.addingTimeInterval(60)
        while try !condition(), Date.now < end { usleep(20_000) }
    }

    @Test func itComesBackAsTheMacLastStartedIt() throws {
        defer { cleanUp() }
        try ranBefore()
        #expect(try start() == 0)
        until { running() != nil }
        let engine = try #require(running(), "its keeper started it")
        #expect(engine.notes == ["mac": "test-mac", "settings": "abc"], "the Mac finds it as its own")
        #expect(engine.password != "old" && engine.password.count == 32, "with a new password")
        #expect((20000..<60000).contains(engine.port))
        let environment = try #require(try started().first)
        // As the Mac started it, under cron's bare environment: its language and time zone, its
        // private settings and its password, and nothing of the start itself.
        #expect(environment.contains("LANG=tr_TR.UTF-8") && environment.contains("KUVO_TZ=Europe/Istanbul"))
        #expect(environment.contains("OPENCODE_CONFIG=\(root.path)/keys/settings.json"))
        #expect(environment.contains("OPENCODE_PASSWORD=\(engine.password)"))
        #expect(!environment.contains("KUVO_BOOT") && !environment.contains("KUVO_RECORD") && !environment.contains("BUN_BE_BUN"))
        // Its keys kept.
        #expect(try String(contentsOf: root.appending(path: "keys/KUVO_KEY_TEST"), encoding: .utf8) == "secret-key")
    }

    /// Down when the machine went off, or never noted: it starts all the same, as the box runs
    /// until it's stopped on purpose.
    @Test func itStartsWhetherOrNotItWasRunning() throws {
        defer { cleanUp() }
        #expect(try start() == 0)
        until { running() != nil }
        #expect(running() != nil)
    }

    @Test func oneStoppedOnPurposeStaysStoppedUntilStarted() throws {
        defer { cleanUp() }
        try write(run.appending(path: "stopped"), "")
        #expect(try start() == 0)
        until { keeper != nil && rounds() >= 0 }
        // Rounds go by; it stays stopped, with its keeper up for whoever starts it.
        try write(root.appending(path: "bin/kuvo-wake"), "#!/bin/sh\n", executable: true)
        usleep(500_000)
        #expect(running() == nil)
        #expect(keeper != nil)
        #expect(try started().isEmpty)
        // Start, from the Mac or a phone.
        #expect(try start("start") == 0)
        #expect(running() != nil)
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "stopped").path))
    }

    @Test func oneTheMacNeverStartedStaysStopped() throws {
        defer { cleanUp() }
        try FileManager.default.removeItem(at: run.appending(path: "launch.env"))
        #expect(try start() == 0)
        usleep(500_000)
        #expect(try started().isEmpty)
    }

    @Test func oneStillRunningIsLeftAlone() throws {
        defer { cleanUp() }
        try start()
        until { running() != nil }
        let first = try #require(running())
        let firstKeeper = try #require(keeper)
        try start()
        usleep(300_000)
        #expect(running() == first)
        #expect(keeper == firstKeeper, "one keeper")
        #expect(try started().count == 1)
    }

    @Test func aNumberAnotherProcessTookAfterTheRestartIsntTheEngine() throws {
        defer { cleanUp() }
        let other = Process()
        other.executableURL = URL(filePath: "/bin/sleep")
        other.arguments = ["30"]
        try other.run()
        defer { other.terminate() }
        try ranBefore(pid: other.processIdentifier)
        #expect(try start() == 0)
        until { running().map { $0.pid != Int(other.processIdentifier) } ?? false }
        let engine = try #require(running())
        #expect(engine.pid != Int(other.processIdentifier))
        #expect(try started().count == 1)
    }

    @Test func aCrashedEngineComesBack() throws {
        defer { cleanUp() }
        try start()
        until { running() != nil }
        let first = try #require(running())
        kill(pid_t(first.pid), SIGKILL)
        until { running().map { $0.pid != first.pid } ?? false }
        let again = try #require(running(), "its keeper started it again")
        #expect(again.pid != first.pid && again.password != first.password)
    }

    /// An engine that won't start is started again a while later, and the keeper notes when
    /// (`run/engine.retry`), for the box to tell whoever asks; once it runs, the note's gone.
    @Test func anEngineThatWontStartIsTriedAgainLaterAndSaysWhen() throws {
        defer { cleanUp() }
        let engine = root.appending(path: "engine/\(OpenCodeEngine.version)/opencode")
        let working = try String(contentsOf: engine, encoding: .utf8)
        try write(engine, "#!/bin/sh\necho 'Error: the database disk image is malformed' >&2\nexit 1\n", executable: true)
        let before = Int(Date.now.timeIntervalSince1970)
        try start()
        until { pid("engine.retry") != nil }
        let retry = try #require(pid("engine.retry"), "it says when it tries again")
        #expect(retry > before, "a start that's still to come")
        #expect(running() == nil)
        // Working again, and started (as from the Mac): the note goes.
        try write(engine, working, executable: true)
        #expect(try start("start") == 0)
        until { running() != nil && pid("engine.retry") == nil }
        #expect(running() != nil)
        #expect(pid("engine.retry") == nil)
    }

    /// No Mac, no phone, for a day, and nothing waiting: it carries on.
    @Test func aDayWithoutTheAppLeavesItRunning() throws {
        defer { cleanUp() }
        try start()
        until { running() != nil }
        let engine = try #require(running())
        FileManager.default.createFile(atPath: run.appending(path: "attached").path, contents: nil)
        try FileManager.default.setAttributes([.modificationDate: Date.now.addingTimeInterval(-25 * 3600)], ofItemAtPath: run.appending(path: "attached").path)
        // More than ten of its wake-up rounds go by: the watchdog used to stop it then.
        until { rounds() >= 12 }
        #expect(rounds() >= 12, "it sends wake-ups each minute")
        #expect(running() == engine)
    }

    @Test func stopKeepsItDownAndStartBringsItBack() throws {
        defer { cleanUp() }
        try start()
        until { running() != nil }
        let first = try #require(running())
        #expect(try start("stop") == 0)
        #expect(!alive(first.pid))
        #expect(record() == nil)
        let counted = rounds()
        try write(root.appending(path: "bin/kuvo-wake"), "#!/bin/sh\necho >>\"$HOME/rounds\"\n", executable: true)
        usleep(800_000)
        #expect(running() == nil, "its keeper leaves it stopped")
        #expect(rounds() == counted, "and sends no wake-ups to a stopped engine")
        #expect(try start("start") == 0)
        #expect(running() != nil)
        // A restart starts it over at once.
        let before = try #require(running())
        #expect(try start("restart") == 0)
        let after = try #require(running())
        #expect(after.pid != before.pid && !alive(before.pid))
    }

    @Test func thePhoneLinkStaysUpWhileAPhoneIsPaired() throws {
        defer { cleanUp() }
        try write(root.appending(path: "bin/kuvo-link.js"), "// the phone link\n")
        try write(run.appending(path: "link.needed"), "")
        try start()
        until { pid("link.pid").map(alive) ?? false }
        let link = try #require(pid("link.pid"))
        #expect(alive(link))
        // It went down: up again.
        kill(pid_t(link), SIGKILL)
        until { pid("link.pid").map { $0 != link && alive($0) } ?? false }
        #expect(pid("link.pid").map { $0 != link && alive($0) } == true)
        // In the box's own folders, as the engine is, nothing of it in the home folder at large.
        let environment = try String(contentsOf: home.appending(path: "link.env"), encoding: .utf8)
        #expect(environment.contains("XDG_CACHE_HOME=\(root.path)/cache") && environment.contains("TMPDIR=\(root.path)/tmp"))
        #expect(environment.contains("LANG=tr_TR.UTF-8"), "as Kuvo Code last started it")
    }

    /// Wake-ups run in the box's own folders, as the engine does, and beside the keeper's rounds:
    /// one held up by a slow watch holds up nothing else, and only one runs at a time.
    @Test func wakeUpsRunInTheBoxsFoldersBesideTheKeeper() throws {
        defer { cleanUp() }
        try write(root.appending(path: "bin/kuvo-wake"), "#!/bin/sh\nenv | sort >\"$HOME/wake.env\"\necho >>\"$HOME/rounds\"\n/bin/sleep 30\n", executable: true)
        try start()
        until { running() != nil && rounds() >= 1 }
        let environment = try String(contentsOf: home.appending(path: "wake.env"), encoding: .utf8)
        #expect(environment.contains("XDG_CONFIG_HOME=\(root.path)/config") && environment.contains("npm_config_cache=\(root.path)/cache/npm"))
        #expect(environment.contains("KUVO_BOTS=\(root.path)/bots") && environment.contains("KUVO_TZ=Europe/Istanbul"))
        // A crash meanwhile is seen to at once.
        let first = try #require(running())
        kill(pid_t(first.pid), SIGKILL)
        until { running().map { $0.pid != first.pid } ?? false }
        #expect(running().map { $0.pid != first.pid } == true)
        #expect(rounds() == 1, "one round of wake-ups at a time")
    }

    /// Kuvo Code updated while the engine of the version before was at work, so this one's isn't
    /// there yet: after a crash or a restart, the one there is starts, as it is.
    @Test func anEngineOfAnotherVersionComesBackWhileThisOnesIsntThere() throws {
        defer { cleanUp() }
        let engines = root.appending(path: "engine")
        try FileManager.default.moveItem(at: engines.appending(path: OpenCodeEngine.version), to: engines.appending(path: "1.9.0"))
        try start()
        until { running() != nil }
        let engine = try #require(running())
        #expect(engine.version == "1.9.0")
    }

    /// Kuvo Code updated: the keeper running hands over to its new script.
    @Test func aNewScriptTakesOverTheKeeping() throws {
        defer { cleanUp() }
        try start()
        until { keeper != nil && running() != nil }
        let box = try #require(keeper)
        let script = RemoteServer.bootScript.replacingOccurrences(of: "\nkeep)\n", with: "\nkeep)\n  touch \"$HOME/handed\"\n")
        #expect(script != RemoteServer.bootScript)
        try write(root.appending(path: "bin/kuvo-start"), script, executable: true)
        try write(root.appending(path: "bin/.kuvo-boot"), "2")
        let handed = home.appending(path: "handed")
        until { FileManager.default.fileExists(atPath: handed.path) }
        #expect(FileManager.default.fileExists(atPath: handed.path))
        #expect(keeper == box, "the same keeper, with the new script")
    }

    /// An older Kuvo Code on a Mac (0.7 and before) puts its own `kuvo-start` and `kuvo-launch` there
    /// as it starts the engine, a script that only starts it after a restart and a launcher that
    /// knows neither Stop nor the box's settings: the keeper carries on, and puts both back (that
    /// Mac's mark left as it is, so it doesn't put its own there again).
    @Test func anOlderMacsScriptLeavesTheKeeperKeeping() throws {
        defer { cleanUp() }
        try start()
        until { keeper != nil && running() != nil }
        let box = try #require(keeper)
        let script = root.appending(path: "bin/kuvo-start"), launcher = root.appending(path: "bin/kuvo-launch"), mark = root.appending(path: "bin/.kuvo-boot")
        #expect(try String(contentsOf: root.appending(path: "bin/.kuvo-start-keeper"), encoding: .utf8) == RemoteServer.bootScript)
        #expect(try String(contentsOf: root.appending(path: "bin/.kuvo-launch-keeper"), encoding: .utf8) == RemoteServer.bootLaunchScript)
        try write(launcher, "#!/bin/sh\n# an older Mac's launcher\nexit 1\n", executable: true)
        try write(script, "#!/bin/sh\n# Kuvo Code: starts its engine on this machine again after a restart.\nexit 0\n", executable: true)
        try write(mark, "older")
        until { (try? String(contentsOf: script, encoding: .utf8)) == RemoteServer.bootScript }
        #expect(try String(contentsOf: script, encoding: .utf8) == RemoteServer.bootScript)
        #expect(try String(contentsOf: launcher, encoding: .utf8) == RemoteServer.bootLaunchScript)
        #expect(try String(contentsOf: mark, encoding: .utf8) == "older")
        // Its mark untouched too: put there without one, it's seen all the same.
        try write(script, "#!/bin/sh\nexit 0\n", executable: true)
        until { (try? String(contentsOf: script, encoding: .utf8)) == RemoteServer.bootScript }
        #expect(try String(contentsOf: script, encoding: .utf8) == RemoteServer.bootScript)
        let before = rounds()
        until { rounds() >= before + 2 }
        #expect(keeper == box)
        // Still keeping it: a crash comes back.
        let engine = try #require(running())
        kill(pid_t(engine.pid), SIGKILL)
        until { running().map { $0.pid != engine.pid } ?? false }
        #expect(running().map { $0.pid != engine.pid } == true)
        #expect(keeper == box)
    }

    /// An older Kuvo Code on a Mac (0.7 and before, which touches `run/attached` as it connects)
    /// puts its own tools over the box's: the keeper puts the box's back, as the Kuvo Code that
    /// marked the box last put them there (`bin/.own`); not while a Mac puts its files in place,
    /// and not a Mac's of this version or newer (no older Mac since the box was marked).
    @Test func anOlderMacsToolsGiveWayToTheBoxs() throws {
        defer { cleanUp() }
        let bin = root.appending(path: "bin"), tool = bin.appending(path: "kuvo-npx"), own = bin.appending(path: ".own/kuvo-npx")
        try FileManager.default.createDirectory(at: own.deletingLastPathComponent(), withIntermediateDirectories: true)
        try write(tool, "the box's\n", executable: true)
        try write(own, "the box's\n", executable: true)
        try write(bin.appending(path: "box-version"), "0.8.0")
        let earlier = Date.now.addingTimeInterval(-600)
        for file in [tool, own, bin.appending(path: "box-version")] {
            try FileManager.default.setAttributes([.modificationDate: earlier], ofItemAtPath: file.path)
        }
        let text = { (try? String(contentsOf: tool, encoding: .utf8)) ?? "" }
        let someRounds = { let before = self.rounds(); self.until { self.rounds() >= before + 2 } }
        try start()
        until { keeper != nil && running() != nil }
        try write(tool, "a Mac's of this version\n", executable: true)
        someRounds()
        #expect(text() == "a Mac's of this version\n")
        // An older Mac connects while a Mac puts its files in place: not yet.
        try write(run.appending(path: "mac-installing"), "")
        try write(run.appending(path: "attached"), "")
        try write(tool, "an older Mac's\n", executable: true)
        someRounds()
        #expect(text() == "an older Mac's\n")
        try FileManager.default.removeItem(at: run.appending(path: "mac-installing"))
        until { text() == "the box's\n" }
        #expect(text() == "the box's\n")
        #expect(FileManager.default.isExecutableFile(atPath: tool.path))
        // One gone comes back too.
        try FileManager.default.removeItem(at: tool)
        until { text() == "the box's\n" }
        #expect(text() == "the box's\n")
    }

    /// An older Kuvo Code on a Mac (0.7 and before) doesn't know Stop: connecting to a stopped box,
    /// it starts the engine itself. Running, it isn't stopped any longer: kept as any engine is.
    @Test func anEngineAnOlderMacStartedOverAStopIsntStopped() throws {
        defer { cleanUp() }
        try start()
        until { running() != nil }
        let stopped = run.appending(path: "stopped")
        try write(stopped, "")
        until { !FileManager.default.fileExists(atPath: stopped.path) }
        #expect(!FileManager.default.fileExists(atPath: stopped.path))
        let engine = try #require(running())
        kill(pid_t(engine.pid), SIGKILL)
        until { running().map { $0.pid != engine.pid } ?? false }
        #expect(running().map { $0.pid != engine.pid } == true)
        // A Stop still stops it, and it stays stopped.
        #expect(try start("stop") == 0)
        let before = rounds()
        until { rounds() >= before + 2 || running() == nil }
        usleep(300_000)
        #expect(running() == nil && FileManager.default.fileExists(atPath: stopped.path))
    }

    @Test func theKeeperGoesWithItsScript() throws {
        defer { cleanUp() }
        try start()
        until { keeper != nil }
        let box = try #require(keeper)
        try FileManager.default.removeItem(at: root.appending(path: "bin/kuvo-start"))
        until { !alive(box) }
        #expect(!alive(box))
    }

    /// Removed: the keeper first, then the phone link and the engine, nothing started again.
    @Test func offStopsEverything() throws {
        defer { cleanUp() }
        try write(root.appending(path: "bin/kuvo-link.js"), "// the phone link\n")
        try write(run.appending(path: "link.needed"), "")
        try start()
        until { running() != nil && (pid("link.pid").map(alive) ?? false) }
        let engine = try #require(running())
        let box = try #require(keeper)
        let link = try #require(pid("link.pid"))
        #expect(try start("off") == 0)
        until { !alive(box) && !alive(link) && !alive(engine.pid) }
        #expect(!alive(box) && !alive(link) && !alive(engine.pid))
        usleep(300_000)
        #expect(running() == nil)
        #expect(keeper == nil && pid("link.pid").map(alive) != true, "nothing started again")
        // Added again, it starts, as one never stopped.
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "stopped").path))
    }

    /// A Stop while a start is under way waits for it, then stops what it started, for good: the
    /// keeper starts nothing again.
    @Test func aStopDuringAStartWaitsForItAndSticks() throws {
        defer { cleanUp() }
        let lock = run.appending(path: ".launching")
        try start()
        // Its keeper's start done.
        until { running() != nil && !FileManager.default.fileExists(atPath: lock.path) }
        // A start under way: it holds the lock.
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: false)
        let stop = Process()
        stop.executableURL = URL(filePath: "/bin/sh")
        stop.arguments = [root.appending(path: "bin/kuvo-start").path, "stop"]
        stop.environment = ["HOME": home.path, "PATH": "\(tools.path):/usr/bin:/bin"]
        try stop.run()
        usleep(300_000)
        #expect(stop.isRunning, "it waits")
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "stopped").path), "and marks nothing yet")
        // The start done, as one that just noted its engine.
        let started = try #require(running())
        try FileManager.default.setAttributes([.modificationDate: Date.now], ofItemAtPath: run.appending(path: "engine.json").path)
        try FileManager.default.removeItem(at: lock)
        stop.waitUntilExit()
        #expect(stop.terminationStatus == 0)
        #expect(!alive(started.pid))
        usleep(800_000)
        #expect(running() == nil, "it stays stopped")
        #expect(FileManager.default.fileExists(atPath: run.appending(path: "stopped").path))
    }

    @Test func twoAtOnceStartOne() async throws {
        defer { cleanUp() }
        try ranBefore()
        async let first = Task.detached { try self.start() }.value
        async let second = Task.detached { try self.start() }.value
        _ = try await (first, second)
        until { running() != nil }
        usleep(300_000)
        #expect(try started().count == 1)
        #expect(running() != nil)
    }

    // MARK: A start from the Mac

    /// The launch as the Mac sends it, with `extra` lines; its exit status.
    private func macLaunch(_ extra: [String] = []) throws -> Int32 {
        let lines = ["PATH=\(tools.path):/usr/bin:/bin", "OPENCODE_PASSWORD=\(String(repeating: "a", count: 32))", "KUVO_PORT=23456",
                     #"KUVO_RECORD="port":23456,"password":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version":"\#(OpenCodeEngine.version)","notes":{"mac":"test-mac"}}"#] + extra
        let input = home.appending(path: "launch-input")
        try write(input, lines.joined(separator: "\n") + "\n\n")
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", RemoteServer.launchScript]
        process.environment = ["HOME": home.path, "PATH": "\(tools.path):/usr/bin:/bin"]
        process.standardInput = try FileHandle(forReadingFrom: input)
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }

    /// A box of its own (settings in `box`): a start reads them, whichever starts it (a Mac, an
    /// older Mac sending its own, the keeper after a crash), and clears what's below them once.
    @Test func aBoxsOwnSettingsAreWhatItsEngineReads() throws {
        defer { cleanUp() }
        let box = root.appending(path: "box")
        try FileManager.default.createDirectory(at: box, withIntermediateDirectories: true)
        try write(box.appending(path: "opencode.json"), #"{"model":"openai/gpt-6"}"#)
        try write(box.appending(path: "global-adopted"), "")
        let global = root.appending(path: "config/opencode/opencode.json")
        try FileManager.default.createDirectory(at: global.deletingLastPathComponent(), withIntermediateDirectories: true)
        try write(global, #"{"websearch":{"provider":"exa"}}"#)
        try write(root.appending(path: "keys/settings.json"), #"{"model":"anthropic/sonnet"}"#)

        // An older Mac's start, sending its settings: they don't count.
        #expect(try macLaunch([#"KUVO_SETTINGS={"websearch":{"provider":"tavily"}}"#, #"KUVO_PRIVATE_SETTINGS={"model":"x/y"}"#]) == 0)
        let first = try #require(running())
        let environment = try #require(try started().first)
        #expect(environment.contains("OPENCODE_CONFIG=\(box.path)/opencode.json"))
        #expect(try String(contentsOf: global, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) == "{}", "what's below it, cleared")
        #expect(!FileManager.default.fileExists(atPath: root.appending(path: "keys/settings.json").path))
        #expect(try String(contentsOf: box.appending(path: "opencode.json"), encoding: .utf8) == #"{"model":"openai/gpt-6"}"#, "its own, untouched")
        let kept = try String(contentsOf: run.appending(path: "launch.env"), encoding: .utf8)
        #expect(!kept.contains("KUVO_SETTINGS"), "no start writes them back")

        // The keeper's, after a crash: the box again.
        kill(pid_t(first.pid), SIGKILL)
        try start()
        until { running().map { $0.pid != first.pid } ?? false }
        _ = try #require(running())
        #expect(try started().allSatisfy { $0.contains("OPENCODE_CONFIG=\(box.path)/opencode.json") })
        #expect(try String(contentsOf: global, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) == "{}")
    }

    @Test func aStartFromTheMacKeepsAStoppedEngineStoppedUnlessItsStart() throws {
        defer { cleanUp() }
        try write(run.appending(path: "stopped"), "")
        #expect(try macLaunch() == 6, "it says it's stopped")
        #expect(running() == nil)
        #expect(try macLaunch(["KUVO_START=1"]) == 0)
        until { running() != nil }
        #expect(running() != nil)
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "stopped").path))
        let kept = try String(contentsOf: run.appending(path: "launch.env"), encoding: .utf8)
        #expect(!kept.contains("KUVO_START"), "what a restart starts it with doesn't start it from a stop")
    }

    @Test func aStartFromTheMacReplacesTheOneRunningInTheSameStart() throws {
        defer { cleanUp() }
        try start()
        until { running() != nil }
        let first = try #require(running())
        #expect(try macLaunch() == 5, "one runs: it's used as it is")
        #expect(try macLaunch(["KUVO_REPLACE=999999"]) == 5, "not the one it found: used as it is")
        #expect(running() == first)
        #expect(try macLaunch(["KUVO_REPLACE=\(first.pid)"]) == 0)
        let second = try #require(running())
        #expect(second.pid != first.pid && !alive(first.pid))
        usleep(300_000)
        #expect(running() == second, "the keeper started no other")
    }
}
