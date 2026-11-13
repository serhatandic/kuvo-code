import Foundation
import Testing
@testable import OpenCodeKit

/// A machine is a box of its own: its keeper (`kuvo-start`, from its crontab after a restart and
/// from every connect) keeps the engine running as Kuvo Code last started it (its settings, keys
/// and environment, with new passwords), with or without a Mac: after a crash or a restart, and a
/// day without the app too. Only a Stop stops it, until a Start. It keeps the phone link up while a
/// phone is paired, sends wake-ups each minute, and goes when its script does. A start from the Mac
/// keeps a stopped engine stopped, unless it's Start, and replaces one in the same start. Run
/// here, in a home folder of the test's own, with a stand-in engine, with what this computer has
/// (on a Mac, no `setsid` and no `/proc`, as on a Mac you add as a machine). The live suite does
/// the same on a real machine.
@Suite(.serialized, AccountUntouched()) struct RebootTests {
    let home: URL
    let tools: URL
    var root: URL { home.appending(path: RemoteEngineInstaller.root) }
    var run: URL { root.appending(path: "run") }

    init() throws {
        home = FileManager.default.temporaryDirectory.appending(path: "opencodekit-reboot-\(UUID().uuidString)")
        tools = home.appending(path: "tools")
        try FileManager.default.createDirectory(at: tools, withIntermediateDirectories: true)
        // The account's crontab and launchd, which a home of the test's own doesn't keep them from:
        // these run in their place, first on the PATH, and note what they're told in that home.
        try Self.write(tools.appending(path: "crontab"), """
            #!/bin/sh
            if [ "$1" = -l ]; then [ -f "$HOME/crontab" ] || { echo "no crontab for test" >&2; exit 1; }; cat "$HOME/crontab"; else cat >"$HOME/crontab"; fi

            """)
        try Self.write(tools.appending(path: "launchctl"), "#!/bin/sh\necho \"$*\" >>\"$HOME/launchctl\"\n")
        // The engine: says it's listening, notes how it was started, and runs until stopped. Run
        // with the phone link's script, it's the phone link: it notes its process, as that does;
        // asked for the engine's settings layer (`engine-config`), it gives one, around what it was
        // given; asked for your login shell's PATH (`login-path`), it adds a folder to the one it has.
        let engine = root.appending(path: "engine/\(OpenCodeEngine.version)/opencode")
        try FileManager.default.createDirectory(at: engine.deletingLastPathComponent(), withIntermediateDirectories: true)
        try write(engine, """
            #!/bin/sh
            # As Bun (BUN_BE_BUN): a .env in the folder it starts in is loaded, unless it's told not to.
            if [ "$BUN_BE_BUN" = 1 ]; then
              [ "$1" = --config=/dev/null ] && shift
              if [ "$1" = --no-env-file ]; then shift; elif [ -f .env ]; then set -a; . ./.env; set +a; fi
            fi
            case "$1 ${2-}" in *"kuvo-link.js engine-config")
              [ -f "$KUVO_HOME/bin/.old-link" ] && { echo "Usage: kuvo-link.js run | serve" >&2; exit 2; }
              env | sort >"$HOME/engine-config.env"
              printf '{"learned":"%s","given":%s}' "$KUVO_HOME" "${OPENCODE_CONFIG_CONTENT:-null}"; exit 0 ;;
            *"kuvo-link.js browser")
              echo "$*" >>"$HOME/browser-setups"; exit 0 ;;
            *"kuvo-link.js login-path")
              [ -f "$KUVO_HOME/bin/.old-link" ] && { echo "Usage: kuvo-link.js run | serve" >&2; exit 2; }
              printf '%s' "$HOME/.nvm/bin:$PATH"; exit 0 ;;
            esac
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
        for (name, text) in RemoteServer.bootFiles.files { try write(bin.appending(path: name), text, executable: true) }
        try write(bin.appending(path: ".kuvo-boot"), "1")
        // Its keys, which a restart keeps.
        let keys = root.appending(path: "keys")
        try FileManager.default.createDirectory(at: keys, withIntermediateDirectories: true)
        try write(keys.appending(path: "KUVO_KEY_TEST"), "secret-key")
        try write(keys.appending(path: "settings.json"), #"{"mcp":{}}"#)
        // The keeper's rounds made quick (15 seconds each on a machine), each wake-up round counted.
        try tool("sleep", "exec /bin/sleep 0.02")
        // Held awake, the way it can be seen: not this test's Mac for real.
        try tool("caffeinate", "echo \"$*\" >>\"$HOME/awake\"; while :; do /bin/sleep 1; done")
        try write(bin.appending(path: "kuvo-wake"), "#!/bin/sh\necho >>\"$HOME/rounds\"\n", executable: true)
    }

    private static func write(_ file: URL, _ text: String) throws {
        try Data(text.utf8).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
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

    /// `kuvo-start` as cron runs it (next to nothing in its environment), or with `command`, by
    /// `shell`.
    @discardableResult
    private func start(_ command: String? = nil, shell: String = "/bin/sh") throws -> Int32 {
        let process = Process()
        process.executableURL = URL(filePath: shell)
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

    /// The shells the scripts run under that this computer has: its own `sh`, and `dash` (Debian's
    /// and Ubuntu's `sh`) where it's here.
    static let shells = ["/bin/sh", "/bin/dash", "/usr/bin/dash"].filter { FileManager.default.isExecutableFile(atPath: $0) }

    /// A process at work as the box's scripts are (its command line names Kuvo Code's), standing in
    /// for one holding the lock: ended with the test.
    private func atWork() throws -> Process {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", "while :; do /bin/sleep 1; done", "kuvo-start", home.path]
        try process.run()
        return process
    }

    /// A process named `name` (in its command line) that notes a TERM it gets (`<name>-ended` in this
    /// home), and answers USR1 (`<name>-here`): ready once it's said so.
    private func watched(_ name: String) throws -> Process {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", """
            trap 'touch "$HOME/\(name)-ended"; exit' TERM
            trap 'touch "$HOME/\(name)-here"' USR1
            touch "$HOME/\(name)-ready"
            while :; do /bin/sleep 1 & wait $!; done
            """, name, home.path]
        process.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin"]
        try process.run()
        until { FileManager.default.fileExists(atPath: home.appending(path: "\(name)-ready").path) }
        return process
    }

    /// Whether `process` (`watched(name)`) was sent a TERM by now: asked with a USR1, which comes after it.
    private func wasEnded(_ process: Process, _ name: String) -> Bool {
        let ended = home.appending(path: "\(name)-ended").path, here = home.appending(path: "\(name)-here").path
        kill(process.processIdentifier, SIGUSR1)
        until { FileManager.default.fileExists(atPath: ended) || FileManager.default.fileExists(atPath: here) }
        return FileManager.default.fileExists(atPath: ended) || !FileManager.default.fileExists(atPath: here)
    }

    /// A folder of tools of a test's own, put first on a PATH.
    private func toolFolder(_ name: String, _ tools: [String: String]) throws -> URL {
        let folder = home.appending(path: name)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for (tool, body) in tools { try write(folder.appending(path: tool), "#!/bin/sh\n" + body + "\n", executable: true) }
        return folder
    }

    private func exists(_ name: String) -> Bool { FileManager.default.fileExists(atPath: home.appending(path: name).path) }

    /// A process that ran and has ended: its number, nobody's now.
    private func ended() throws -> Int32 {
        let gone = Process()
        gone.executableURL = URL(filePath: "/usr/bin/true")
        try gone.run()
        gone.waitUntilExit()
        return gone.processIdentifier
    }

    /// `lines` run by `shell` beside the launch's lock's own (`launchLock`, as both scripts have it),
    /// in this box, as one of the scripts that take it (`kuvo-start`), with `tools` of its own first
    /// on its PATH: started.
    private func withLock(_ shell: String, _ lines: String, tools own: URL? = nil) throws -> Process {
        let process = Process()
        process.executableURL = URL(filePath: shell)
        process.arguments = ["-c", "R=\(SSHConnection.quoted(run.path))\n" + RemoteServer.launchLock + "\n" + lines, "kuvo-start"]
        process.environment = ["HOME": home.path, "PATH": (own.map { "\($0.path):" } ?? "") + "\(tools.path):/usr/bin:/bin"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        return process
    }

    /// Lines that take the launch's lock as a start waits for it, looking again `every` so often,
    /// within `tenths` tries, or exit 3.
    private static func taking(within tenths: Int, every: String = "0.1") -> String {
        "n=0\nuntil mkdir \"$R/.launching\" 2>/dev/null; do unheld; n=$((n + 1)); [ $n -lt \(tenths) ] || exit 3; /bin/sleep \(every); done\nlocked"
    }

    /// Whether `shell` takes the launch's lock within `tenths` of a second.
    private func takes(_ shell: String, within tenths: Int = 30) throws -> Bool {
        let process = try withLock(shell, Self.taking(within: tenths))
        process.waitUntilExit()
        return process.terminationStatus == 0
    }

    /// The lock as one that held it left it: its folder, and what it said beside it, from `pid`;
    /// each made `ago` seconds before now.
    private func leftHeld(by pid: Int32?, ago: TimeInterval = 0) throws {
        let lock = run.appending(path: ".launching")
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: false)
        try FileManager.default.setAttributes([.modificationDate: Date.now.addingTimeInterval(-ago)], ofItemAtPath: lock.path)
        guard let pid else { return }
        let said = run.appending(path: ".launching.pid")
        try write(said, "\(pid)\n")
        try FileManager.default.setAttributes([.modificationDate: Date.now.addingTimeInterval(-ago)], ofItemAtPath: said.path)
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

    /// The browser agents use there: the box sets it up itself as its keeper starts (a newer Kuvo
    /// Code may pin a newer one), and again while it isn't there, with or without a Mac.
    @Test func theBoxSetsUpItsBrowserAsItsKeeperStarts() throws {
        defer { cleanUp() }
        try write(root.appending(path: "bin/kuvo-link.js"), "// the box\n")
        try start()
        let setups = home.appending(path: "browser-setups")
        until { (try? String(contentsOf: setups, encoding: .utf8))?.contains("browser install") == true }
        let asked = try String(contentsOf: setups, encoding: .utf8)
        #expect(asked.contains("kuvo-link.js browser install"))
        #expect(!asked.contains("--now"), "it waits after a failure, as the box does")
    }

    /// A `.env` in the box's folders (which an agent's command can write) sets nothing for its
    /// phone link or what it asks before the engine starts: the engine's Bun would load one before
    /// the link's code runs.
    @Test func aDotEnvInTheBoxsFoldersSetsNothingForIt() throws {
        defer { cleanUp() }
        try write(root.appending(path: "bin/kuvo-link.js"), "// the phone link\n")
        try write(run.appending(path: "link.needed"), "")
        let workspace = root.appending(path: "workspace")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        for folder in [root, workspace] {
            try write(folder.appending(path: ".env"), "KUVO_VAULT_FILE_KEY=forged\nKUVO_TEST_GITHUB=http://127.0.0.1:9\n")
        }
        #expect(try start() == 0)
        until { pid("link.pid").map(alive) ?? false }
        let link = try String(contentsOf: home.appending(path: "link.env"), encoding: .utf8)
        #expect(link.contains("KUVO_HOME="), "the link started")
        #expect(!link.contains("forged") && !link.contains("KUVO_TEST_GITHUB"))
        let asked = try String(contentsOf: home.appending(path: "engine-config.env"), encoding: .utf8)
        #expect(!asked.contains("forged") && !asked.contains("KUVO_TEST_GITHUB"))
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

    /// On a Mac, whatever else is set: the box's running keeps it from sleeping, one hold at a time,
    /// tied to the keeper (Linux has no `caffeinate`).
    @Test func aRunningBoxHoldsItsMacAwakeOnce() throws {
        defer { cleanUp() }
        try ranBefore()
        try start()
        try until { running() != nil && keeper != nil && FileManager.default.fileExists(atPath: home.appending(path: "awake").path) }
        let keeping = try #require(keeper)
        try start("box")
        // (A round or two of the keeper's, each quick here.)
        let rounds = rounds()
        until { self.rounds() > rounds + 2 }
        let held = try String(contentsOf: home.appending(path: "awake"), encoding: .utf8).split(separator: "\n")
        #expect(held == ["-s -w \(keeping)"])

        // Should the hold go (one a keeper before it held, gone with that keeper), it holds again.
        let holding = try String(contentsOf: run.appending(path: "awake.pid"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        kill(try #require(pid_t(holding)), SIGKILL)
        until { (try? String(contentsOf: home.appending(path: "awake"), encoding: .utf8).split(separator: "\n").count) == 2 }
        #expect(try String(contentsOf: home.appending(path: "awake"), encoding: .utf8).split(separator: "\n") == ["-s -w \(keeping)", "-s -w \(keeping)"])
    }

    /// What it starts leaves the connection that started it: a session of its own, so closing SSH
    /// doesn't end it, on a Mac too, which has no `setsid` to run.
    @Test func whatItStartsIsInASessionOfItsOwn() throws {
        defer { cleanUp() }
        try ranBefore()
        try start()
        until { running() != nil && keeper != nil }
        let engine = try #require(running())
        let keeping = try #require(keeper)
        for pid in [engine.pid, keeping] {
            #expect(getsid(pid_t(pid)) != getsid(0))
            #expect(getsid(pid_t(pid)) == pid_t(pid))
        }
    }

    /// A Mac starts it again at login with an agent of its own, in a form `launchd` reads, added once
    /// and left as it is; and takes it out with the machine.
    @Test func aMacsLaunchAgentIsAddedOnceAndTakenOut() throws {
        defer { cleanUp() }
        func run(_ script: String) throws {
            let process = Process()
            process.executableURL = URL(filePath: "/bin/sh")
            process.arguments = ["-c", script]
            process.environment = ["HOME": home.path, "PATH": "\(tools.path):/usr/bin:/bin:/usr/sbin:/sbin"]
            try process.run()
            process.waitUntilExit()
            #expect(process.terminationStatus == 0)
        }
        let plist = home.appending(path: "Library/LaunchAgents/\(RemoteServer.launchAgent).plist")
        try run(RemoteServer.launchAgentRemovalScript)
        #expect(!FileManager.default.fileExists(atPath: home.appending(path: "launchctl").path), "a home without it leaves the account's launchd alone")
        try run(RemoteServer.launchAgentScript)
        try run("plutil -lint \(SSHConnection.quoted(plist.path)) >/dev/null")
        let written = try #require(NSDictionary(contentsOf: plist))
        #expect(written["Label"] as? String == RemoteServer.launchAgent)
        #expect(written["RunAtLoad"] as? Bool == true)
        #expect((written["ProgramArguments"] as? [String])?.last?.contains("bin/kuvo-start") == true)
        try Data("kept".utf8).write(to: plist)
        try run(RemoteServer.launchAgentScript)
        #expect(try String(contentsOf: plist, encoding: .utf8) == "kept", "once")
        try run(RemoteServer.launchAgentRemovalScript)
        #expect(!FileManager.default.fileExists(atPath: plist.path))
        #expect(try String(contentsOf: home.appending(path: "launchctl"), encoding: .utf8) == "bootout gui/\(getuid())/\(RemoteServer.launchAgent)\n")
    }

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
        // Marked off meanwhile (Kuvo Code on this Mac takes it for no box): its start after a restart
        // starts nothing, until a Mac starts it there.
        #expect(FileManager.default.fileExists(atPath: run.appending(path: "off").path))
        #expect(try start() == 0)
        usleep(300_000)
        #expect(keeper == nil, "not started again from its crontab")
    }

    /// One its Mac removed (marked off) starts again once a Mac starts it there: off no longer.
    @Test func aMacsStartTakesOffAway() throws {
        defer { cleanUp() }
        try write(run.appending(path: "off"), "")
        #expect(try start() == 0)
        usleep(300_000)
        #expect(keeper == nil, "off: its start after a restart starts nothing")
        #expect(try macLaunch() == 0)
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "off").path), "a Mac's start: off no longer")
        until { keeper != nil }
        #expect(keeper != nil, "its keeper keeps it again")
    }

    /// A Stop while a start is under way waits for it, then stops what it started, for good: the
    /// keeper starts nothing again.
    @Test func aStopDuringAStartWaitsForItAndSticks() throws {
        defer { cleanUp() }
        let lock = run.appending(path: ".launching")
        try start()
        // Its keeper's start done.
        until { running() != nil && !FileManager.default.fileExists(atPath: lock.path) }
        // A start under way: it holds the lock, and says so.
        let holder = try atWork()
        defer { holder.terminate() }
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: false)
        try write(run.appending(path: ".launching.pid"), "\(holder.processIdentifier)\n")
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
        try FileManager.default.removeItem(at: run.appending(path: ".launching.pid"))
        try FileManager.default.removeItem(at: lock)
        stop.waitUntilExit()
        #expect(stop.terminationStatus == 0)
        #expect(!alive(started.pid))
        usleep(800_000)
        #expect(running() == nil, "it stays stopped")
        #expect(FileManager.default.fileExists(atPath: run.appending(path: "stopped").path))
    }

    /// A start or a stop cut off as it held the launch's lock (killed: `off` ending the keeper as it
    /// took it, say) leaves no wait behind: the next stop, `off` and start take it at once, where
    /// they waited minutes for it to go.
    @Test func aLockWhoseHolderIsGoneIsntWaitedFor() throws {
        defer { cleanUp() }
        let lock = run.appending(path: ".launching")
        // Held by one that has ended.
        let gone = Process()
        gone.executableURL = URL(filePath: "/usr/bin/true")
        try gone.run()
        gone.waitUntilExit()
        func leftBehind() throws {
            try? FileManager.default.removeItem(at: lock)
            try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: false)
            try write(run.appending(path: ".launching.pid"), "\(gone.processIdentifier)\n")
        }
        try leftBehind()
        var began = Date.now
        #expect(try start("stop") == 0)
        #expect(Date.now.timeIntervalSince(began) < 20, "stop took it at once")
        #expect(!FileManager.default.fileExists(atPath: lock.path), "and let it go")
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: ".launching.pid").path))
        try leftBehind()
        began = Date.now
        #expect(try start("off") == 0)
        #expect(Date.now.timeIntervalSince(began) < 20, "off took it at once")
        try leftBehind()
        began = Date.now
        #expect(try macLaunch(["KUVO_START=1"]) == 0)
        #expect(Date.now.timeIntervalSince(began) < 30, "a Mac's start took it at once")
        #expect(running() != nil)
    }

    /// A lock an older Kuvo Code's script took (it says nothing, its folder kept empty for that
    /// script to let go of) isn't taken away for what an earlier holder left beside it: a stop
    /// waits for it.
    @Test func anOlderScriptsLockIsWaitedFor() throws {
        defer { cleanUp() }
        let lock = run.appending(path: ".launching")
        let gone = Process()
        gone.executableURL = URL(filePath: "/usr/bin/true")
        try gone.run()
        gone.waitUntilExit()
        // Left by one before, a minute ago; the older script's lock taken since.
        let left = run.appending(path: ".launching.pid")
        try write(left, "\(gone.processIdentifier)\n")
        try FileManager.default.setAttributes([.modificationDate: Date.now.addingTimeInterval(-60)], ofItemAtPath: left.path)
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: false)
        let stop = Process()
        stop.executableURL = URL(filePath: "/bin/sh")
        stop.arguments = [root.appending(path: "bin/kuvo-start").path, "stop"]
        stop.environment = ["HOME": home.path, "PATH": "\(tools.path):/usr/bin:/bin"]
        try stop.run()
        usleep(800_000)
        #expect(stop.isRunning, "it waits for it")
        // The older script lets it go, as it does: an empty folder, removed.
        try FileManager.default.removeItem(at: lock)
        stop.waitUntilExit()
        #expect(stop.terminationStatus == 0)
        #expect(FileManager.default.fileExists(atPath: run.appending(path: "stopped").path))
    }

    /// One lets go of the launch's lock only while it's said to be its own: one taken from it (held
    /// over five minutes) and taken again since stays the new holder's.
    @Test func eachLetsGoOfItsOwnLockOnly() throws {
        defer { cleanUp() }
        let lock = run.appending(path: ".launching")
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: false)
        try write(run.appending(path: ".launching.pid"), "\(ProcessInfo.processInfo.processIdentifier)\n")
        let letGo = Process()
        letGo.executableURL = URL(filePath: "/bin/sh")
        letGo.arguments = ["-c", "R=\(SSHConnection.quoted(run.path))\n" + RemoteServer.launchLock + "\nunlock"]
        try letGo.run()
        letGo.waitUntilExit()
        #expect(letGo.terminationStatus == 0)
        #expect(FileManager.default.fileExists(atPath: lock.path), "still the other's")
        #expect(FileManager.default.fileExists(atPath: run.appending(path: ".launching.pid").path))
    }

    /// Many waiting at once for a lock whose holder is gone take it away one at a time: none takes
    /// it from one that has just taken it. Each leaves it as one cut off does, for the rest to take
    /// away again.
    @Test(arguments: Self.shells) func manyWaitingForAGoneHoldersLockTakeItInTurn(_ shell: String) throws {
        defer { cleanUp() }
        let overlaps = run.appending(path: "overlaps")
        let inside = """
            \(Self.taking(within: 3000, every: "0.01"))
            mkdir "$R/inside" 2>/dev/null || echo $$ >>"$R/overlaps"
            /bin/sleep 0.02
            rmdir "$R/inside" 2>/dev/null
            exit 0
            """
        for round in 1...6 {
            try? FileManager.default.removeItem(at: run.appending(path: ".launching"))
            try leftHeld(by: try ended())
            let waiting = try (1...12).map { _ in try withLock(shell, inside) }
            waiting.forEach { $0.waitUntilExit() }
            #expect(waiting.allSatisfy { $0.terminationStatus == 0 }, "round \(round): each had it in turn")
        }
        #expect(!FileManager.default.fileExists(atPath: overlaps.path), "never two at once")
    }

    /// The same as the scripts take it (`take_lock`), with a taking away left behind by one that's
    /// gone each time (killed as it took it away): moved aside under one still at it, it still
    /// doesn't let two take it.
    @Test(arguments: Self.shells) func manyWaitingWithATakingAwayLeftBehindTakeItInTurn(_ shell: String) throws {
        defer { cleanUp() }
        let overlaps = run.appending(path: "overlaps")
        let inside = """
            take_lock 3000 || exit 3
            mkdir "$R/inside" 2>/dev/null || echo $$ >>"$R/overlaps"
            /bin/sleep 0.02
            rmdir "$R/inside" 2>/dev/null
            /usr/bin/true & gone=$!; wait $gone
            mkdir "$R/.launching.breaking" 2>/dev/null && echo $gone >"$R/.launching.breaking/pid"
            exit 0
            """
        for round in 1...12 {
            try? FileManager.default.removeItem(at: run.appending(path: ".launching"))
            try? FileManager.default.removeItem(at: run.appending(path: ".launching.breaking"))
            try leftHeld(by: try ended())
            let breaking = run.appending(path: ".launching.breaking")
            try FileManager.default.createDirectory(at: breaking, withIntermediateDirectories: false)
            try write(breaking.appending(path: "pid"), "\(try ended())\n")
            let waiting = try (1...12).map { _ in try withLock(shell, inside) }
            waiting.forEach { $0.waitUntilExit() }
            #expect(waiting.allSatisfy { $0.terminationStatus == 0 }, "round \(round): each had it in turn")
        }
        #expect(!FileManager.default.fileExists(atPath: overlaps.path), "never two at once")
    }

    /// And with every lock left over five minutes old, half of them saying nothing (as after a
    /// restart, or an older script's): taken away one at a time all the same.
    @Test(arguments: Self.shells) func manyWaitingForOldLocksTakeItInTurn(_ shell: String) throws {
        defer { cleanUp() }
        let overlaps = run.appending(path: "overlaps")
        let inside = """
            take_lock 3000 || exit 3
            mkdir "$R/inside" 2>/dev/null || echo $$ >>"$R/overlaps"
            /bin/sleep 0.02
            rmdir "$R/inside" 2>/dev/null
            [ $(($$ % 2)) -eq 0 ] && rm -f "$R/.launching.pid"
            touch -t 202001010000 "$R/.launching"
            /usr/bin/true & gone=$!; wait $gone
            mkdir "$R/.launching.breaking" 2>/dev/null && echo $gone >"$R/.launching.breaking/pid"
            exit 0
            """
        for round in 1...12 {
            try? FileManager.default.removeItem(at: run.appending(path: ".launching"))
            try? FileManager.default.removeItem(at: run.appending(path: ".launching.breaking"))
            try leftHeld(by: try ended(), ago: 400)
            let waiting = try (1...12).map { _ in try withLock(shell, inside) }
            waiting.forEach { $0.waitUntilExit() }
            #expect(waiting.allSatisfy { $0.terminationStatus == 0 }, "round \(round): each had it in turn")
        }
        #expect(!FileManager.default.fileExists(atPath: overlaps.path), "never two at once")
    }

    /// The race step by step (each made to wait where it matters, by tools of its own): after a
    /// restart, an old lock whose holder is gone and a taking away whose taker is gone. A takes
    /// over that taking away and is about to take the lock away; C, which judged the same taker
    /// gone before A took over, goes on. C neither moves A's taking away aside nor takes the lock
    /// away itself, so A, going on, takes it from nobody: never both at once.
    @Test(.enabled(if: !FileManager.default.fileExists(atPath: "/proc/self")), arguments: Self.shells)
    func aTakingAwayTakenOverIsOneAtATime(_ shell: String) throws {
        defer { cleanUp() }
        try leftHeld(by: try ended(), ago: 400)
        let taker = try ended()
        let breaking = run.appending(path: ".launching.breaking")
        try FileManager.default.createDirectory(at: breaking, withIntermediateDirectories: false)
        try write(breaking.appending(path: "pid"), "\(taker)\n")
        let inside = """
            mkdir "$R/inside" 2>/dev/null || touch "$HOME/overlap"
            touch "$HOME/$1-has-it"
            until [ -f "$HOME/$1-done" ]; do /bin/sleep 0.02; done
            rmdir "$R/inside"
            unlock
            """
        // C waits once it has judged that taker gone (asking `ps` of it), and says what else it asks.
        let cTools = try toolFolder("c-tools", ["ps": """
            echo "$*" >>"$HOME/c-asked"
            case "$*" in *"-p \(taker)") touch "$HOME/c-judged"; until [ -f "$HOME/go-c" ]; do /bin/sleep 0.02; done ;; esac
            exec /bin/ps "$@"
            """])
        // A waits just before it takes the lock away.
        let aTools = try toolFolder("a-tools", ["rmdir": """
            case "$*" in *"/run/.launching") touch "$HOME/a-taking"; until [ -f "$HOME/go-a" ]; do /bin/sleep 0.02; done ;; esac
            exec /bin/rmdir "$@"
            """])
        let c = try withLock(shell, "set -- c\ntake_lock 3000 || exit 3\n" + inside, tools: cTools)
        until { exists("c-judged") }
        let a = try withLock(shell, "set -- a\ntake_lock 3000 || exit 3\n" + inside, tools: aTools)
        until { exists("a-taking") }
        // C goes on: it takes the lock, or looks again, at A's taking away.
        try write(home.appending(path: "go-c"), "")
        let askedOfA = "-p \(a.processIdentifier)"
        until { exists("c-has-it") || ((try? String(contentsOf: home.appending(path: "c-asked"), encoding: .utf8)) ?? "").contains(askedOfA) }
        let cTookIt = exists("c-has-it")
        #expect(!cTookIt, "C waits for A")
        // A goes on; then each, in turn, takes it (where C took it, A takes it from C).
        try write(home.appending(path: "go-a"), "")
        until { exists("a-has-it") || !cTookIt && exists("c-has-it") }
        for each in ["a-done", "c-done"] { try write(home.appending(path: each), "") }
        a.waitUntilExit()
        c.waitUntilExit()
        #expect(a.terminationStatus == 0 && c.terminationStatus == 0)
        #expect(!exists("overlap"), "never both at once")
    }

    /// A lock nobody said was theirs (an older Kuvo Code's, or one cut off as it took it) is taken
    /// away once it's five minutes old.
    @Test(arguments: Self.shells) func aLockNobodySaidIsTakenAfterFiveMinutes(_ shell: String) throws {
        defer { cleanUp() }
        try leftHeld(by: nil, ago: 360)
        #expect(try takes(shell))
    }

    /// A taking away left over a minute ago by one that never said it was theirs (an older
    /// script's, or one cut off as it began) is no longer in the way.
    @Test(arguments: Self.shells) func aTakingAwayLeftOverAMinuteIsntWaitedFor(_ shell: String) throws {
        defer { cleanUp() }
        try leftHeld(by: try ended())
        let breaking = run.appending(path: ".launching.breaking")
        try FileManager.default.createDirectory(at: breaking, withIntermediateDirectories: false)
        try FileManager.default.setAttributes([.modificationDate: Date.now.addingTimeInterval(-120)], ofItemAtPath: breaking.path)
        #expect(try takes(shell))
    }

    /// One taking it away says it's theirs: one whose taker is gone (killed as it took it away)
    /// isn't in the way, at once.
    @Test(arguments: Self.shells) func aTakingAwayWhoseTakerIsGoneIsntWaitedFor(_ shell: String) throws {
        defer { cleanUp() }
        try leftHeld(by: try ended())
        let breaking = run.appending(path: ".launching.breaking")
        try FileManager.default.createDirectory(at: breaking, withIntermediateDirectories: false)
        try write(breaking.appending(path: "pid"), "\(try ended())\n")
        #expect(try takes(shell))
        #expect(!FileManager.default.fileExists(atPath: breaking.path), "nor left behind")
    }

    /// One whose taker is still at it is left to it, however long it's been (a box that slept as it
    /// took it away).
    @Test(arguments: Self.shells) func aTakingAwayWhoseTakerRunsIsLeftToIt(_ shell: String) throws {
        defer { cleanUp() }
        try leftHeld(by: try ended())
        let taker = try atWork()
        defer { taker.terminate() }
        let breaking = run.appending(path: ".launching.breaking")
        try FileManager.default.createDirectory(at: breaking, withIntermediateDirectories: false)
        try write(breaking.appending(path: "pid"), "\(taker.processIdentifier)\n")
        try FileManager.default.setAttributes([.modificationDate: Date.now.addingTimeInterval(-120)], ofItemAtPath: breaking.path)
        #expect(try !takes(shell, within: 10))
        #expect(try String(contentsOf: breaking.appending(path: "pid"), encoding: .utf8) == "\(taker.processIdentifier)\n", "still its")
    }

    /// What a holder said is believed only if it isn't older than the lock: what one before left
    /// beside it isn't, within the same second too (an older Kuvo Code's script took the lock since,
    /// without saying), and that lock is waited for.
    @Test(arguments: Self.shells) func whatWasSaidBeforeTheLockIsntBelievedWithinTheSameSecond(_ shell: String) throws {
        defer { cleanUp() }
        let second = (Date.now.timeIntervalSince1970 - 30).rounded(.down)
        let said = run.appending(path: ".launching.pid")
        try write(said, "\(try ended())\n")
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: second + 0.1)], ofItemAtPath: said.path)
        let lock = run.appending(path: ".launching")
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: false)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: second + 0.6)], ofItemAtPath: lock.path)
        #expect(try !takes(shell, within: 10))
    }

    /// One that took the lock but couldn't say so (its file couldn't be written) still lets go of it.
    @Test(arguments: Self.shells) func oneThatCouldntSayItHadTheLockLetsGoOfIt(_ shell: String) throws {
        defer { cleanUp() }
        try FileManager.default.createDirectory(at: run.appending(path: ".launching.pid"), withIntermediateDirectories: false)
        #expect(try start("stop", shell: shell) == 0)
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: ".launching").path))
    }

    /// A stop ended (TERM, or its connection gone) just as it takes the lock or lets go of it leaves
    /// no lock that nobody says is theirs, which would be waited for minutes: it's let go of, or
    /// says it's the stop's, which is gone, and the next takes it at once.
    @Test(arguments: Self.shells) func aStopEndedAsItTakesOrLetsGoOfTheLockLeavesNoneBehind(_ shell: String) throws {
        defer { cleanUp() }
        let lock = run.appending(path: ".launching")
        // Each of those steps slow, and said as it's under way.
        try tool("mkdir", "/bin/mkdir \"$@\" || exit\ncase \"$*\" in *\"/run/.launching\") touch \"$HOME/taking\"; /bin/sleep 1 ;; esac")
        try tool("rm", "/bin/rm \"$@\" || exit\ncase \"$*\" in *\"/run/.launching.pid\") touch \"$HOME/letting-go\"; /bin/sleep 1 ;; esac")
        for mark in ["taking", "letting-go"] {
            let stop = Process()
            stop.executableURL = URL(filePath: shell)
            stop.arguments = [root.appending(path: "bin/kuvo-start").path, "stop"]
            stop.environment = ["HOME": home.path, "PATH": "\(tools.path):/usr/bin:/bin"]
            stop.standardError = FileHandle.nullDevice
            try stop.run()
            until { FileManager.default.fileExists(atPath: home.appending(path: mark).path) }
            stop.terminate()
            stop.waitUntilExit()
            // Its step finished (whole, after it): the lock let go of, or said to be the stop's.
            until { !FileManager.default.fileExists(atPath: lock.path) || pid(".launching.pid") != nil }
            #expect(try takes(shell, within: 10), "ended as it was \(mark)")
            try? FileManager.default.removeItem(at: lock)
            for each in [".launching.pid", "stopped"] { try? FileManager.default.removeItem(at: run.appending(path: each)) }
            for each in ["taking", "letting-go"] { try? FileManager.default.removeItem(at: home.appending(path: each)) }
        }
    }

    /// What a holder said names a process that runs but isn't one of these scripts (its number
    /// another's since, after a restart): it's gone, and its lock is taken at once.
    @Test(arguments: Self.shells) func aHolderWhoseNumberIsAnothersNowIsGone(_ shell: String) throws {
        defer { cleanUp() }
        let other = Process()
        other.executableURL = URL(filePath: "/bin/sleep")
        other.arguments = ["30"]
        try other.run()
        defer { other.terminate() }
        try leftHeld(by: other.processIdentifier)
        #expect(try takes(shell))
    }

    /// Nor is one that names the one waiting for it.
    @Test(arguments: Self.shells) func aHolderWithTheWaitersOwnNumberIsGone(_ shell: String) throws {
        defer { cleanUp() }
        let waiter = try withLock(shell, "mkdir \"$R/.launching\"; echo $$ >\"$R/.launching.pid\"\n" + Self.taking(within: 30))
        waiter.waitUntilExit()
        #expect(waiter.terminationStatus == 0)
    }

    /// `off` while the keeper's start is under way (an engine slow to start, and one that won't
    /// end on a TERM) ends that start, and the engine it was starting, rather than waiting for it:
    /// nothing runs after it, and nothing's left that would start one again.
    @Test func offEndsAStartUnderWay() throws {
        defer { cleanUp() }
        // An engine that listens only once it's told to, and doesn't end on a TERM.
        try write(root.appending(path: "engine/\(OpenCodeEngine.version)/opencode"), """
            #!/bin/sh
            trap '' TERM
            echo $$ >>"$HOME/engines"
            until [ -f "$HOME/listen" ]; do /bin/sleep 0.05; done
            echo "server listening on http://127.0.0.1:$3"
            while :; do /bin/sleep 1; done
            """, executable: true)
        let engines = home.appending(path: "engines")
        try start()
        until { FileManager.default.fileExists(atPath: engines.path) }
        #expect(FileManager.default.fileExists(atPath: run.appending(path: ".launching").path), "its start under way")
        #expect(try start("off") == 0)
        let pids = try String(contentsOf: engines, encoding: .utf8).split(separator: "\n").compactMap { Int32($0) }
        // (Ended whatever happens, if it still runs: it doesn't end on cleanUp's TERM.)
        defer { pids.filter { alive(Int($0)) && isEngine($0) }.forEach { kill($0, SIGKILL) } }
        // Ended by off, not waited for: gone before it was ever told to listen.
        until { pids.allSatisfy { !alive(Int($0)) } }
        #expect(pids.allSatisfy { !alive(Int($0)) }, "off ended the start under way and its engine")
        try write(home.appending(path: "listen"), "")
        #expect(running() == nil && keeper == nil)
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: ".launching").path))
        // Nothing of the box's left at all (the keeper's engine loop and its tries included).
        func left() throws -> Bool {
            let find = Process()
            find.executableURL = URL(filePath: "/usr/bin/pgrep")
            find.arguments = ["-f", root.path]
            find.standardOutput = FileHandle.nullDevice
            try find.run()
            find.waitUntilExit()
            return find.terminationStatus == 0
        }
        try until { try !left() }
        #expect(try !left())
        #expect(try String(contentsOf: engines, encoding: .utf8).split(separator: "\n").count == 1, "nothing started again")
    }

    /// A Mac's start that holds the lock as the machine is removed (its engine starting): `off`
    /// ends it, with the engine it started, rather than waiting for it, and that start says it was
    /// removed (status 7), rather than that SSH stopped; nothing starts after.
    @Test func offEndsAMacsStartUnderWayWhichSaysItWasRemoved() throws {
        defer { cleanUp() }
        // An engine that listens only once it's told to.
        try write(root.appending(path: "engine/\(OpenCodeEngine.version)/opencode"), """
            #!/bin/sh
            echo $$ >>"$HOME/engines"
            until [ -f "$HOME/listen" ]; do /bin/sleep 0.05; done
            echo "server listening on http://127.0.0.1:$3"
            while :; do /bin/sleep 1; done
            """, executable: true)
        let engines = home.appending(path: "engines")
        let lines = ["PATH=\(tools.path):/usr/bin:/bin", "OPENCODE_PASSWORD=\(String(repeating: "a", count: 32))", "KUVO_PORT=23456",
                     #"KUVO_RECORD="port":23456,"password":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version":"\#(OpenCodeEngine.version)","notes":{"mac":"test-mac"}}"#]
        let input = home.appending(path: "launch-input")
        try write(input, lines.joined(separator: "\n") + "\n\n")
        let launch = Process()
        launch.executableURL = URL(filePath: "/bin/sh")
        launch.arguments = ["-c", RemoteServer.launchScript]
        launch.environment = ["HOME": home.path, "PATH": "\(tools.path):/usr/bin:/bin"]
        launch.standardInput = try FileHandle(forReadingFrom: input)
        launch.standardOutput = FileHandle.nullDevice
        launch.standardError = FileHandle.nullDevice
        try launch.run()
        defer { if launch.isRunning { launch.terminate() } }
        until { FileManager.default.fileExists(atPath: engines.path) }
        #expect(pid(".launching.pid") == Int(launch.processIdentifier), "the Mac's start holds the lock, with no keeper about")
        #expect(try start("off") == 0)
        launch.waitUntilExit()
        #expect(launch.terminationStatus == 7, "it says it was removed")
        let pids = try String(contentsOf: engines, encoding: .utf8).split(separator: "\n").compactMap { Int32($0) }
        defer { pids.filter { alive(Int($0)) && isEngine($0) }.forEach { kill($0, SIGKILL) } }
        until { pids.allSatisfy { !alive(Int($0)) } }
        #expect(pids.allSatisfy { !alive(Int($0)) }, "its engine ended with it")
        #expect(running() == nil && keeper == nil)
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: ".launching").path), "let go")
        #expect(FileManager.default.fileExists(atPath: run.appending(path: "off").path), "still off")
        try write(home.appending(path: "listen"), "")
        #expect(try String(contentsOf: engines, encoding: .utf8).split(separator: "\n").count == 1, "nothing started again")
    }

    /// Whether `pid` is still one of the stand-in engines this test made (its command line names
    /// this test's folder): never another process that took its number since.
    private func isEngine(_ pid: Int32) -> Bool {
        let ps = Process()
        ps.executableURL = URL(filePath: "/bin/ps")
        ps.arguments = ["-ww", "-o", "command=", "-p", String(pid)]
        let out = Pipe()
        ps.standardOutput = out
        ps.standardError = FileHandle.nullDevice
        guard (try? ps.run()) != nil else { return false }
        ps.waitUntilExit()
        return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).contains(root.path)
    }

    /// `off` ends only a holder the lock says holds it now, that runs as one of the box's scripts:
    /// a number left beside it that's another process's since (one that only names Kuvo Code, or
    /// one whose lock has gone) is left alone.
    @Test func offEndsNothingElse() throws {
        defer { cleanUp() }
        let other = try watched("vim-kuvo-notes")
        defer { other.terminate() }
        // (Over five minutes old, so `off` doesn't wait for it.)
        try leftHeld(by: other.processIdentifier, ago: 400)
        #expect(try start("off") == 0)
        #expect(!wasEnded(other, "vim-kuvo-notes"), "not one of the scripts")
        try? FileManager.default.removeItem(at: run.appending(path: ".launching"))
        let holder = try watched("kuvo-start")
        defer { holder.terminate() }
        try write(run.appending(path: ".launching.pid"), "\(holder.processIdentifier)\n")
        #expect(try start("off") == 0)
        #expect(!wasEnded(holder, "kuvo-start"), "its lock gone")
    }

    /// A Mac's start that an `off` came after (the machine removed while it waited for the lock)
    /// starts nothing, and says so (status 7): an `off` newer than its start.
    @Test func aMacsStartAfterWhichItWasRemovedStartsNothing() throws {
        defer { cleanUp() }
        // `off` just as it takes the lock.
        try tool("mkdir", "/bin/mkdir \"$@\" || exit\ncase \"$*\" in *\"/run/.launching\") touch \"${1%/.launching}/off\" ;; esac")
        #expect(try macLaunch() == 7)
        #expect(running() == nil && keeper == nil)
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: ".launching").path))
        #expect(FileManager.default.fileExists(atPath: run.appending(path: "off").path))
    }

    /// A Mac's start that comes while an `off` is under way doesn't undo it: the machine stays off
    /// until that `off` is done (it takes `off` away only once it has the lock); then it starts.
    @Test func aMacsStartDuringAnOffWaitsForIt() throws {
        defer { cleanUp() }
        // An `off` under way: marked, and holding the lock.
        try write(run.appending(path: "off"), "")
        let off = try atWork()
        defer { off.terminate() }
        try leftHeld(by: off.processIdentifier)
        // Each try to take it, said.
        try tool("mkdir", "/bin/mkdir \"$@\"; made=$?\ncase \"$*\" in *\"/run/.launching\") echo >>\"$HOME/tries\" ;; esac\nexit $made")
        let lines = ["PATH=\(tools.path):/usr/bin:/bin", "OPENCODE_PASSWORD=\(String(repeating: "a", count: 32))", "KUVO_PORT=23456",
                     #"KUVO_RECORD="port":23456,"password":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version":"\#(OpenCodeEngine.version)","notes":{"mac":"test-mac"}}"#]
        let input = home.appending(path: "launch-input")
        try write(input, lines.joined(separator: "\n") + "\n\n")
        let launch = Process()
        launch.executableURL = URL(filePath: "/bin/sh")
        launch.arguments = ["-c", RemoteServer.launchScript]
        launch.environment = ["HOME": home.path, "PATH": "\(tools.path):/usr/bin:/bin"]
        launch.standardInput = try FileHandle(forReadingFrom: input)
        launch.standardOutput = FileHandle.nullDevice
        launch.standardError = FileHandle.nullDevice
        try launch.run()
        until { exists("tries") }
        #expect(FileManager.default.fileExists(atPath: run.appending(path: "off").path), "still off while the off is under way")
        // The off done: it lets go.
        try FileManager.default.removeItem(at: run.appending(path: ".launching.pid"))
        try FileManager.default.removeItem(at: run.appending(path: ".launching"))
        launch.waitUntilExit()
        #expect(launch.terminationStatus == 0)
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "off").path), "a start after it: off no longer")
        #expect(running() != nil)
    }

    /// `off` ending the keeper doesn't cut short a rollback it's at (an update that never said it's
    /// well): that one finishes.
    @Test func offLeavesARollbackUnderWayToFinish() throws {
        defer { cleanUp() }
        let restore = root.appending(path: "updates/rollback/restore.sh")
        try FileManager.default.createDirectory(at: restore.deletingLastPathComponent(), withIntermediateDirectories: true)
        try write(restore, "#!/bin/sh\ntouch \"$HOME/restoring\"\nuntil [ -f \"$HOME/go\" ]; do /bin/sleep 0.02; done\ntouch \"$HOME/restored\"\n", executable: true)
        let trial = run.appending(path: "update-trial")
        try write(trial, "9.9.9")
        try FileManager.default.setAttributes([.modificationDate: Date.now.addingTimeInterval(-1300)], ofItemAtPath: trial.path)
        try start()
        until { exists("restoring") }
        #expect(try start("off") == 0)
        try write(home.appending(path: "go"), "")
        until { exists("restored") }
        #expect(exists("restored"))
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

    /// A crontab that doesn't answer (macOS asking something on a screen nobody's at) doesn't hold up
    /// the start, and all that waits on it.
    @Test func aCrontabThatHangsDoesntHoldUpTheStart() throws {
        defer { cleanUp() }
        // (Not `exec`: what it goes on to do is how the test tells it wasn't waited for.)
        try tool("crontab", "/bin/sleep 30; touch \"$HOME/crontab-answered\"")
        #expect(try macLaunch() == 0)
        #expect(!FileManager.default.fileExists(atPath: home.appending(path: "crontab-answered").path))
    }

    /// Nor a removal: the rest of it goes on.
    @Test func aCrontabThatHangsDoesntHoldUpARemoval() throws {
        defer { cleanUp() }
        try tool("crontab", "/bin/sleep 30; touch \"$HOME/crontab-answered\"")
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", RemoteServer.crontabRemovalScript]
        process.environment = ["HOME": home.path, "PATH": "\(tools.path):/usr/bin:/bin"]
        try process.run()
        process.waitUntilExit()
        #expect(!FileManager.default.fileExists(atPath: home.appending(path: "crontab-answered").path))
    }

    /// A start from the Mac leaves what starts it again after a restart, in what these tests stand
    /// in for and never the account's own: one line in the crontab, however often it's started, and
    /// on a Mac the login agent, in this home.
    @Test func aStartLeavesOneWayBackAfterARestart() throws {
        defer { cleanUp() }
        #expect(try macLaunch() == 0)
        #expect(try start("off") == 0)
        #expect(try macLaunch(["KUVO_START=1"]) == 0)
        let lines = try String(contentsOf: home.appending(path: "crontab"), encoding: .utf8).split(separator: "\n")
        #expect(lines == [Substring(RemoteServer.rebootLine)])
        #if os(macOS)
        #expect(FileManager.default.fileExists(atPath: home.appending(path: "Library/LaunchAgents/\(RemoteServer.launchAgent).plist").path))
        #endif
    }

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

    /// What some providers need from the engine (its box learns it, `engine-config`) goes on top
    /// of what the Mac started it with, after a restart with no Mac there too; a box too old to
    /// know it starts as before.
    @Test func itStartsWithWhatItsBoxLearnedForItsProviders() throws {
        defer { cleanUp() }
        try write(run.appending(path: "launch.env"), "PATH=\(tools.path):/usr/bin:/bin\nOPENCODE_CONFIG_CONTENT={\"mcp\":{}}\n")
        try write(root.appending(path: "bin/kuvo-link.js"), "")
        try write(root.appending(path: "bin/.old-link"), "")
        #expect(try start() == 0)
        until { running() != nil }
        #expect(try started().first?.contains(#"OPENCODE_CONFIG_CONTENT={"mcp":{}}"#) == true, "a link too old to say: as the Mac started it")
        try start("stop")

        try FileManager.default.removeItem(at: root.appending(path: "bin/.old-link"))
        #expect(try start("start") == 0)
        until { (try? started().count) == 2 }
        let environment = try #require(try started().first { $0.contains("learned") })
        #expect(environment.contains(#"OPENCODE_CONFIG_CONTENT={"learned":"\#(root.path)","given":{"mcp":{}}}"#))
    }

    /// The engine finds what you installed there (nvm's node, `~/.local/bin`): it starts with the
    /// PATH your login shell sets up, as its box reads it (`login-path`), after a restart with no
    /// Mac there too; a box too old to know it starts with the PATH it had.
    @Test func itStartsWithYourLoginShellsPath() throws {
        defer { cleanUp() }
        try write(root.appending(path: "bin/kuvo-link.js"), "")
        try write(root.appending(path: "bin/.old-link"), "")
        #expect(try start() == 0)
        until { running() != nil }
        let before = try #require(try started().first)
        #expect(before.contains("\nPATH=\(root.path)/bin:\(tools.path):/usr/bin:/bin\n"), "a link too old to say: the PATH it had")
        try start("stop")

        try FileManager.default.removeItem(at: root.appending(path: "bin/.old-link"))
        #expect(try start("start") == 0)
        until { (try? started().count) == 2 }
        let environment = try #require(try started().first { $0.contains(".nvm") })
        #expect(environment.contains("\nPATH=\(root.path)/bin:\(home.path)/.nvm/bin:\(tools.path):/usr/bin:/bin\n"))
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
