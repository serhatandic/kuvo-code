#if os(macOS)
import CoreGraphics
import Darwin
import Foundation
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "box-helper")

/// Kuvo Code Box: the program a Mac's box in a home of its own runs under (#333 piece 4; KuvoLink's
/// PROTOCOL.md, "This Mac's box: its helper"). launchd starts it at login (the launch agent
/// `run.kuvo.code.machine`), or the app opens it once while Login Items doesn't. It holds no box
/// logic: everything the box does is `kuvo-start`'s and the box's own, as on every computer. It's
/// there for what only a signed program of Kuvo Code's own can be:
///
/// - **what macOS asks about**: it's the parent of `kuvo-start keep` (and so the responsible process
///   of the engine, the bridge and every agent's command), so folders, Screen Recording and the
///   rest are asked for Kuvo Code Box, and kept for it;
/// - **the box's host interface** (`BoxHelperHost`): its keys in your Keychain;
/// - **`serve`**, which it starts (`kuvo-start serve`) and keeps running with the vault's secrets on
///   its stdin, never in a file or its environment;
/// - **macOS asking you something**, noted in `run/.system-asking` for the box's watch.
@MainActor
public final class BoxHelper {
    let home: URL
    let host: BoxHelperHost
    /// The children's environment: the few of its own a shell needs (launchd's is clean).
    let environment: [String: String]
    /// Whether macOS is asking you something now (a test's says).
    var asking: () -> Bool = { BoxHelper.systemPromptOpen }

    private var keeper: Child?
    private var serve: Child?
    /// Whether `serve` started without the vault's file key (the Keychain was locked): started again
    /// once it can be read.
    private var serveLacksFileKey = false
    private var finishing = false
    private var signals: [DispatchSourceSignal] = []
    private var looking: Task<Void, Never>?
    /// How it goes once everything it started has stopped (a test's only says so).
    var exits: (Int32) -> Void = { Darwin.exit($0) }

    init(home: URL, host: BoxHelperHost, environment: [String: String]) {
        self.home = home
        self.host = host
        self.environment = environment
    }

    var run: URL { home.appending(path: "run") }
    var start: URL { home.appending(path: "bin/kuvo-start") }

    // MARK: Entry

    /// `Kuvo Code Box [keep] [--home <box>]`: runs the box until launchd stops it, or the box is
    /// turned off (`kuvo-start off`). `keys check|uncopy|back [--app <Kuvo Code.app>]`: one of the
    /// Keychain's steps a box's move owes it (`KeychainMove`), said in JSON; 0 once done.
    public nonisolated static func main(_ arguments: [String]) -> Never {
        HostKeychain.neverAsk()
        signal(SIGPIPE, SIG_IGN)
        var words = Array(arguments.dropFirst())
        func option(_ name: String) -> String? {
            guard let index = words.firstIndex(of: name), index + 1 < words.count else { return nil }
            defer { words.removeSubrange(index...(index + 1)) }
            return words[index + 1]
        }
        let given = option("--home")
        let appBundle = option("--app")
        var keychain = HostKeychain()
        #if DEBUG
        // Tests alone: a keychain file of their own.
        if let file = option("--test-keychain"), let password = option("--test-keychain-password") { keychain = HostKeychain(testFile: file, password: password) }
        // (A debug build is the tests' alone, and never reaches your login keychain: the release's is
        // built by scripts/build-box-helper.sh.)
        guard keychain.isTests else { fail("A test build of \(BoxHelperBundle.name) reads only a test's keychain: --test-keychain <file> --test-keychain-password <password>.") }
        #endif
        // (launchd's `open` adds a process serial number for an app it opens.)
        words.removeAll { $0.hasPrefix("-psn_") }
        guard let prefix = Bundle.main.bundleIdentifier, let app = BoxHelperBundle.appID(ofHelper: prefix) else {
            fail("\(BoxHelperBundle.name) runs from its bundle, whose ID is Kuvo Code’s with .box after it.")
        }
        let command = words.first ?? "keep"
        #if DEBUG
        let pinned = false
        #else
        let pinned = true
        #endif
        let home: URL
        switch box(given: given, bundle: Bundle.main.bundleURL, accountHome: accountHome(), pinned: pinned, keeping: command == "keep") {
        case .success(let found): home = found
        case .failure(let refused):
            // (Kept by launchd, a box it won't run ends cleanly: it isn't started again and again.)
            if command == "keep" {
                log.error("\(refused.why, privacy: .public)")
                FileHandle.standardError.write(Data((refused.why + "\n").utf8))
                exit(0)
            }
            fail(refused.why)
        }
        switch command {
        case "keep" where words.count <= 1:
            MainActor.assumeIsolated { keep(home: home, keychain: keychain, prefix: prefix, app: app) }
            dispatchMain()
        case "keys" where words.count == 2:
            let move = KeychainMove(keychain: keychain, home: home, app: app, helper: prefix)
            // What changes the box's keys never runs beside the helper keeping it (its lock), whose
            // host interface may be changing them meanwhile.
            if words[1] != "check" {
                let run = home.appending(path: "run")
                try? FileManager.default.createDirectory(at: run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let lock = open(run.appending(path: "helper.lock").path(percentEncoded: false), O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
                guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else { fail("\(BoxHelperBundle.name) is running this box: it’s stopped first.") }
            }
            do {
                switch words[1] {
                case "check":
                    let unreadable = try move.unreadable()
                    say(["unreadable": unreadable])
                    exit(unreadable.isEmpty ? 0 : 1)
                case "uncopy":
                    try move.uncopy()
                case "clear":
                    say(["kept": try move.clearLeftovers()])
                    exit(0)
                case "back":
                    // Kuvo Code itself is given every key: never one signed ad hoc (anything could be),
                    // but in the tests' own build.
                    #if DEBUG
                    let adHoc = true
                    #else
                    let adHoc = false
                    #endif
                    guard let appBundle, appBundle.hasPrefix("/"), BoxHelperBundle.isKuvoCode(URL(filePath: appBundle), identifier: app, adHoc: adHoc) else {
                        fail("Moving back needs Kuvo Code itself, signed by its team: --app <its bundle>.")
                    }
                    try move.back(trusting: URL(filePath: appBundle))
                default:
                    fail("Usage: \(BoxHelperBundle.name) keys check|uncopy|clear|back")
                }
                say([:])
                exit(0)
            } catch {
                fail(error.localizedDescription)
            }
        default:
            fail("Usage: \(BoxHelperBundle.name) [keep] [--home <box>] | keys check|uncopy|clear|back [--app <Kuvo Code.app>]")
        }
    }

    struct Refused: Error, Equatable {
        let why: String
    }

    /// Your account's own home folder, as the system has it (never `$HOME`, which whatever starts
    /// it sets).
    nonisolated static func accountHome() -> URL? {
        guard let entry = getpwuid(getuid()), let directory = entry.pointee.pw_dir else { return nil }
        return URL(filePath: String(cString: directory))
    }

    /// The box this helper runs or changes the keys of. Its own build (`pinned`) only ever your
    /// account's `~/.kuvo-code` (`--home` may only name that), and keeps it only from the bundle
    /// installed there (`keeping`): a copy anywhere else, or a folder of anyone's making, would
    /// otherwise be handed the vault's secrets and serve your keys. The tests' build takes the box
    /// it's given. Either way the box and its `bin` are yours alone to change (not anyone else's,
    /// nor open to others' writes).
    nonisolated static func box(given: String?, bundle: URL, accountHome: URL?, pinned: Bool, keeping: Bool) -> Result<URL, Refused> {
        // (Where it really is, links and all, as the kernel says; as written where it isn't there.)
        func place(_ url: URL) -> String {
            let path = url.standardizedFileURL.path(percentEncoded: false)
            guard let real = realpath(path, nil) else { return path.hasSuffix("/") && path.count > 1 ? String(path.dropLast()) : path }
            defer { free(real) }
            return String(cString: real)
        }
        let home: URL
        if pinned {
            guard let accountHome else { return .failure(Refused(why: "Your home folder can’t be found.")) }
            home = accountHome.appending(path: RemoteEngineInstaller.root)
            if let given, place(URL(filePath: given)) != place(home) {
                return .failure(Refused(why: "\(BoxHelperBundle.name) runs only this Mac’s box, \(home.path(percentEncoded: false))."))
            }
            if keeping, place(bundle) != place(BoxHelperBundle.installed(in: home)) {
                return .failure(Refused(why: "\(BoxHelperBundle.name) runs this Mac’s box only from its place in it, \(BoxHelperBundle.installed(in: home).path(percentEncoded: false))."))
            }
        } else {
            guard let given, given.hasPrefix("/") else { return .failure(Refused(why: "Say which box: --home <its folder>.")) }
            home = URL(filePath: given)
        }
        // (Its `bin` too, where its keeper is: there by the time it's kept, maybe not yet as a move
        // copies its keys.)
        for folder in [home, home.appending(path: "bin")] {
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: folder.path(percentEncoded: false)) else {
                if folder != home, !keeping { continue }
                return .failure(Refused(why: "There’s no box at \(home.path(percentEncoded: false))."))
            }
            let owner = (attributes[.ownerAccountID] as? NSNumber)?.uint32Value
            let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0o777
            guard owner == getuid(), mode & 0o022 == 0 else {
                return .failure(Refused(why: "\(folder.path(percentEncoded: false)) can be changed by someone other than you, so \(BoxHelperBundle.name) doesn’t run it."))
            }
        }
        return .success(home)
    }

    private nonisolated static func say(_ answer: [String: Any]) {
        let data = (try? JSONSerialization.data(withJSONObject: answer, options: [.sortedKeys])) ?? Data("{}".utf8)
        FileHandle.standardOutput.write(data + Data("\n".utf8))
    }

    private nonisolated static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        log.error("\(message, privacy: .public)")
        exit(2)
    }

    /// The box kept, in this process, for as long as it runs.
    private static func keep(home: URL, keychain: HostKeychain, prefix: String, app: String) {
        let run = home.appending(path: "run")
        try? FileManager.default.createDirectory(at: run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // One at a time: one opened while launchd's runs goes at once, and cleanly.
        let lock = open(run.appending(path: "helper.lock").path(percentEncoded: false), O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else {
            log.info("Another Kuvo Code Box runs this box already")
            exit(0)
        }
        // Nothing starts from a helper changed since it was signed (what it runs as is what macOS
        // and your Keychain trust).
        guard CodeSeal.isSealed(Bundle.main.bundleURL) else {
            let why = "\(BoxHelperBundle.name) was changed since it was installed, so this Mac’s box didn’t start. Open Kuvo Code to put it back."
            try? PrivateFile.write(Data(why.utf8), to: run.appending(path: "helper-trouble"))
            log.error("\(why, privacy: .public)")
            // (Exiting cleanly: launchd doesn't start it again and again.)
            exit(0)
        }
        // Nor while a move of the box is unfinished, or its keys are half moved: the old box may
        // start too, with the same keys (two boxes as one), and the app's keeper finishes it.
        if let why = unsettled(home: home, keychain: keychain, prefix: prefix, app: app) {
            try? PrivateFile.write(Data(why.utf8), to: run.appending(path: "helper-trouble"))
            log.notice("\(why, privacy: .public)")
            exit(0)
        }
        // Its keeper names its box from HOME (`K="$HOME/<name>"`): only one that names this very
        // box, run with HOME the folder around it, so another box is never what runs.
        guard ownKeeper(of: home) else {
            let why = "This Mac’s box’s keeper isn’t its own, so \(BoxHelperBundle.name) didn’t start it."
            try? PrivateFile.write(Data(why.utf8), to: run.appending(path: "helper-trouble"))
            log.error("\(why, privacy: .public)")
            exit(0)
        }
        try? FileManager.default.removeItem(at: run.appending(path: "helper-trouble"))
        var environment = childEnvironment(ProcessInfo.processInfo.environment)
        environment["HOME"] = home.deletingLastPathComponent().path(percentEncoded: false)
        let helper = BoxHelper(home: home, host: BoxHelperHost(home: home, keychain: keychain, prefix: prefix, app: app), environment: environment)
        helper.begin()
    }

    /// Why the box shouldn't run now, or nil: a move of it under way (its journal not done), or its
    /// keys copied by a move that hasn't finished (`copying`, `returning`; `copied` before the move
    /// cleared the old place).
    nonisolated static func unsettled(home: URL, keychain: HostKeychain, prefix: String, app: String) -> String? {
        let folder = home.appending(path: "updates/rehome")
        func object(_ name: String) -> [String: Any]? {
            guard let data = try? Data(contentsOf: folder.appending(path: name)) else { return nil }
            return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? ["unreadable": true]
        }
        if let journal = object("journal.json"), journal["step"] as? String != "done" {
            return "This Mac’s box is moving: Kuvo Code Box starts it once the move’s finished."
        }
        let journal: KeychainMove.Journal?
        do {
            journal = try KeychainMove(keychain: keychain, home: home, app: app, helper: prefix).journal()
        } catch {
            return error.localizedDescription
        }
        guard let journal else { return nil }
        let state = object("state.json")
        let moved = state?["state"] as? String == "done" && state?["way"] as? String == "move"
        switch journal.state {
        case .settled: return nil
        case .copied, .settling: return moved ? nil : "This Mac’s box’s keys are copied for a move that didn’t finish: Kuvo Code finishes it."
        case .copying, .returning: return "This Mac’s box’s keys are moving: Kuvo Code finishes that first."
        }
    }

    /// Whether the box's keeper names this very box (`K="$HOME/<its folder's name>"`).
    nonisolated static func ownKeeper(of home: URL) -> Bool {
        guard let text = try? String(contentsOf: home.appending(path: "bin/kuvo-start"), encoding: .utf8),
              let named = text.firstMatch(of: /(?m)^K="\$HOME\/([^"\/]+)"/)?.1 else { return false }
        return String(named) == home.lastPathComponent
    }

    /// What its children start with: a shell's few, from its own (launchd's, or a test's).
    nonisolated static func childEnvironment(_ own: [String: String]) -> [String: String] {
        var environment = own.filter { ["HOME", "USER", "LOGNAME", "TMPDIR", "SHELL", "LANG", "PATH"].contains($0.key) }
        if environment["PATH"]?.isEmpty ?? true { environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin" }
        return environment
    }

    // MARK: Running

    /// Started: its host interface, `serve`, and the keeper; then it looks after them.
    func begin() {
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        for number in [SIGTERM, SIGINT] {
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { MainActor.assumeIsolated { self.finish(0) } }
            source.resume()
            signals.append(source)
        }
        host.failed = { [weak self] in Task { @MainActor in await self?.startHost() } }
        Task {
            await startHost()
            startServe()
            startKeeper()
            looking = Task { await look() }
        }
    }

    /// Its host interface, started (again): tried every so often until it does.
    private func startHost() async {
        var wait = 1.0
        while !finishing {
            do {
                try await host.start()
                return
            } catch {
                log.error("The box's host interface didn't start: \(error.localizedDescription, privacy: .public)")
                try? await Task.sleep(for: .seconds(wait))
                wait = min(wait * 2, 60)
            }
        }
    }

    /// Whether the box was turned off for good (`kuvo-start off`, uninstalling).
    var isOff: Bool { FileManager.default.fileExists(atPath: run.appending(path: "off").path(percentEncoded: false)) }

    private func startKeeper() {
        guard !finishing else { return }
        // (In a session of its own, as `kuvo-start` starts its keeper: `off` ends it with what it's at.)
        keeper = Child.spawn("/bin/sh", [start.path(percentEncoded: false), "keep"], environment: environment, directory: home, session: true,
                             previous: keeper) { [weak self] child in self?.ended(child) }
        if keeper == nil { again(startKeeper) }
    }

    /// One that couldn't be started at all, tried again in half a minute.
    private func again(_ start: @escaping () -> Void) {
        Task {
            try? await Task.sleep(for: .seconds(30))
            if !finishing { start() }
        }
    }

    private func startServe() {
        guard !finishing else { return }
        let (fileKey, retry) = host.vaultFileKey()
        serveLacksFileKey = fileKey == nil && retry
        var secrets = ["password": HostProof.secret(), "hostVaultSecret": host.vaultSecret]
        if let fileKey { secrets["vaultFileKey"] = fileKey }
        let first = ((try? JSONSerialization.data(withJSONObject: secrets)) ?? Data()) + Data("\n".utf8)
        serve = Child.spawn("/bin/sh", [start.path(percentEncoded: false), "serve"], environment: environment, directory: home, session: false,
                            input: first, previous: serve) { [weak self] child in self?.ended(child) }
        if serve == nil { again(startServe) }
    }

    /// One of its children ended: started again after a wait that grows while it keeps ending soon
    /// after it started, unless the box was turned off, when everything goes.
    private func ended(_ child: Child) {
        guard !finishing else { return }
        if isOff {
            log.notice("This Mac's box was turned off: Kuvo Code Box goes too")
            return finish(0)
        }
        let wait = child.nextWait()
        log.info("\(child === self.keeper ? "kuvo-start keep" : "serve", privacy: .public) ended (\(child.status)): started again in \(wait) s")
        Task {
            try? await Task.sleep(for: .seconds(wait))
            guard !finishing else { return }
            if child === keeper { startKeeper() } else if child === serve { startServe() }
        }
    }

    /// Every ten seconds: macOS asking you something noted for the box, and `serve` started again
    /// once the vault's file key it lacked can be read.
    private func look() async {
        while !finishing, !Task.isCancelled {
            noteAsking(asking())
            if serveLacksFileKey, let serve, serve.isRunning, host.vaultFileKey().key != nil {
                log.info("The vault's key can be read now: the box's server starts again with it")
                serve.planned = true
                serve.terminate()
            }
            if isOff, keeper?.isRunning != true { return finish(0) }
            try? await Task.sleep(for: .seconds(10))
        }
    }

    func noteAsking(_ open: Bool) {
        let file = run.appending(path: ".system-asking")
        guard open != FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) else { return }
        if open { FileManager.default.createFile(atPath: file.path(percentEncoded: false), contents: nil) } else { try? FileManager.default.removeItem(at: file) }
    }

    /// Everything it started, told to stop (`serve` by its stdin closing, the keeper by SIGTERM: the
    /// engine, link and bridge, detached, go on for the next keeper to take over); its record taken
    /// away, and gone.
    func finish(_ status: Int32) {
        guard !finishing else { return }
        finishing = true
        looking?.cancel()
        serve?.terminate()
        keeper?.terminate()
        host.stop()
        noteAsking(false)
        let children = [serve, keeper].compactMap { $0 }
        Task {
            // A few seconds for them to go, then SIGTERM, and a second after that, SIGKILL.
            for _ in 0..<30 where children.contains(where: \.isRunning) { try? await Task.sleep(for: .milliseconds(100)) }
            for child in children { child.signal(SIGTERM) }
            for _ in 0..<10 where children.contains(where: \.isRunning) { try? await Task.sleep(for: .milliseconds(100)) }
            for child in children { child.signal(SIGKILL) }
            exits(status)
        }
    }

    /// Whether macOS shows a question now (its UserNotificationCenter's window).
    nonisolated static var systemPromptOpen: Bool {
        let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
        return windows.contains { $0[kCGWindowOwnerName as String] as? String == "UserNotificationCenter" }
    }
}

/// A process the helper started and watches: its end told once (`ended`), on the main actor.
@MainActor
final class Child {
    let pid: pid_t
    private(set) var status: Int32 = 0
    private(set) var isRunning = true
    private var input: Int32 = -1
    private var source: DispatchSourceProcess?
    let started = ContinuousClock.now
    /// When it ended (its run, not the wait before the next).
    private(set) var endedAt: ContinuousClock.Instant?
    /// How many times in a row it ended soon after it started.
    var failures = 0

    /// Ended because the helper asked it to (started again at once, not counted as failing).
    var planned = false
    /// Whether it ran under ten minutes before it ended, by itself.
    var endedSoon: Bool { !planned && (endedAt.map { started.duration(to: $0) < .seconds(600) } ?? false) }

    private init(pid: pid_t) {
        self.pid = pid
    }

    /// `executable` started with `arguments`, its stdin `input` (kept open after it, for as long as
    /// it runs) or nothing, its output nowhere; `session`: in a session of its own.
    static func spawn(_ executable: String, _ arguments: [String], environment: [String: String], directory: URL, session: Bool,
                      input: Data? = nil, previous: Child? = nil, ended: @escaping (Child) -> Void) -> Child? {
        var pipe: [Int32] = [-1, -1]
        if input != nil {
            guard Darwin.pipe(&pipe) == 0 else { return nil }
            // (Neither end for anything else started meanwhile: only this child's stdin, given below.)
            for end in pipe { _ = fcntl(end, F_SETFD, FD_CLOEXEC) }
        }
        let null = open("/dev/null", O_RDWR | O_CLOEXEC)
        defer {
            if null >= 0 { close(null) }
            if pipe[0] >= 0 { close(pipe[0]) }
        }
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_adddup2(&actions, input != nil ? pipe[0] : null, 0)
        posix_spawn_file_actions_adddup2(&actions, null, 1)
        posix_spawn_file_actions_adddup2(&actions, null, 2)
        posix_spawn_file_actions_addchdir(&actions, directory.path(percentEncoded: false))
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        // Only the three it's given, every signal as it would be by default, none held.
        var flags = Int32(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)
        if session { flags |= Int32(POSIX_SPAWN_SETSID) }
        posix_spawnattr_setflags(&attributes, Int16(flags))
        var all = sigset_t()
        sigfillset(&all)
        posix_spawnattr_setsigdefault(&attributes, &all)
        var none = sigset_t()
        sigemptyset(&none)
        posix_spawnattr_setsigmask(&attributes, &none)
        let argv = ([executable] + arguments).map { strdup($0) } + [nil]
        let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            for pointer in argv { free(pointer) }
            for pointer in envp { free(pointer) }
        }
        var pid: pid_t = 0
        let spawned = posix_spawn(&pid, executable, &actions, &attributes, argv, envp)
        guard spawned == 0 else {
            log.error("Couldn't start \(executable, privacy: .public) \(arguments.joined(separator: " "), privacy: .public): \(String(cString: strerror(spawned)), privacy: .public)")
            if pipe[1] >= 0 { close(pipe[1]) }
            return nil
        }
        let child = Child(pid: pid)
        // (The one before it ended soon after it started: one more in a row.)
        if let previous { child.failures = previous.endedSoon ? previous.failures + 1 : 0 }
        if let input {
            input.withUnsafeBytes { _ = Darwin.write(pipe[1], $0.baseAddress, $0.count) }
            child.input = pipe[1]
        }
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak child] in
            MainActor.assumeIsolated {
                guard let child, child.isRunning else { return }
                // (It has exited: collected now, however soon the notice came.)
                var status: Int32 = 0
                var collected: pid_t
                repeat { collected = waitpid(child.pid, &status, 0) } while collected < 0 && errno == EINTR
                guard collected == child.pid else { return }
                child.status = status
                child.isRunning = false
                child.endedAt = .now
                child.closeInput()
                child.source?.cancel()
                child.source = nil
                ended(child)
            }
        }
        child.source = source
        source.resume()
        // (Ended before its watch began: the watch never fires.)
        var status: Int32 = 0
        if waitpid(pid, &status, WNOHANG) == pid {
            child.status = status
            child.isRunning = false
            child.endedAt = .now
            child.closeInput()
            source.cancel()
            child.source = nil
            DispatchQueue.main.async { MainActor.assumeIsolated { ended(child) } }
        }
        return child
    }

    /// How long before it's started again: none the first time it ends after running a while, then
    /// longer for each time in a row it ended soon after it started, up to ten minutes.
    func nextWait() -> Int {
        let tries = endedSoon ? failures + 1 : 0
        return [1, 2, 5, 15, 30, 60, 120, 300, 600][min(tries, 8)]
    }

    private func closeInput() {
        if input >= 0 { close(input) }
        input = -1
    }

    /// Told to go: one given a stdin by its stdin closing (`serve` leaves then, once what its link
    /// queued is out, and takes its record away), any other by SIGTERM.
    func terminate() {
        if input >= 0 { return closeInput() }
        signal(SIGTERM)
    }

    func signal(_ number: Int32) {
        if isRunning { Darwin.kill(pid, number) }
    }
}
#endif
