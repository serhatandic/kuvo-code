import Darwin
import Foundation
import OpenCodeKit
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "keeper")

/// This Mac's keeper: Kuvo Code's own executable, started by launchd with `--box` from the launch
/// agent in the app (`BackgroundWork`), with no window, menu or Dock icon. It keeps this Mac's box
/// running whether or not the app is open, as a machine's keeper does there: you quit the app, and
/// your bots, goals, wake-ups and sessions go on. The app (and later another Mac) is a client: it
/// finds what runs by the records in the box's `run` folder (`KeeperRecord`, `run/engine.json`,
/// `run/bridge.json`), and asks the keeper for what only it does (`KeeperControl`).
///
/// It's the app's own executable so that what you allowed Kuvo Code stays allowed: the Keychain's
/// items trust the app's signature, and the folders and network macOS asked you about were allowed
/// to the app.
@MainActor
final class Keeper {
    /// How it exits: Stop Background Work ends it for good (launchd leaves a keeper that exited
    /// cleanly down, until you log in or open the app), and making way for a newer app's keeper
    /// ends it to be started again (launchd starts one that exited with anything else).
    enum Exit: Int32 {
        case stopped = 0
        case again = 75
    }

    private let password = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    private lazy var server = LoopbackServer { [weak self] request in await self?.respond(to: request) ?? .init(status: 503) }
    private let started = Date.now
    /// The box it keeps: the box itself, the engine and the coding agents' bridge.
    private let box: MacBoxRunner
    /// The app it was started from, as it records itself (a test's keeper can be an older one's).
    private let version: String
    private let build: String
    /// How it goes, once everything it started has stopped: the process exits (a test's keeper
    /// only says so).
    private let exits: (Exit) -> Void
    /// The version of the app now at its place, as `installedVersion` reads it (a test's keeper
    /// can be given another).
    private let installed: () -> String?
    /// This Mac's link, for its keys alone (the box's relay asks for them through the host
    /// interface); the app's own follows the phones.
    private let link = PhoneLink()
    /// The browser's tools, for the engine and the agents: the open app's, or saying it isn't.
    private let tools = KeeperTools()
    /// Making way for a newer app's keeper: it goes the first moment nothing is under way.
    private var handingOver = false
    /// Gone (`finish`): nothing more is looked at.
    private var finished = false
    /// What's under way, looked at every so often (`watch`).
    private var watching: Task<Void, Never>?
    /// This Mac kept awake while agents work on it, as Settings › General says (the app's own
    /// setting, read as you change it): whether or not the app is open, after a restart too. An
    /// app following this keeper holds nothing of its own besides (`Awake.keeper`).
    private let awake = Awake()

    init(box: MacBoxRunner = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface()),
         version: String = AppInfo.version, build: String = AppInfo.build, exits: @escaping (Exit) -> Void = { Darwin.exit($0.rawValue) },
         installed: @escaping () -> String? = { Keeper.installedVersion() }) {
        self.box = box
        self.version = version
        self.build = build
        self.exits = exits
        self.installed = installed
    }

    /// `--box`: runs until launchd stops it, or it's told to stop. Never returns.
    nonisolated static func main() -> Never {
        // A box already on this Mac (one you set up as a machine) that the app attaches to in place
        // is the only one: a keeper registered before, or by Turn On, starts no second one, and
        // writes nothing first (its record would make it this Mac's box from then on). Nor does one
        // that couldn't tell, with a box there.
        guard AppModel.attachesInPlace else {
            run()
            dispatchMain()
        }
        Task { @MainActor in
            let engine = await Task.detached { EngineInstaller(root: AppInfo.supportDirectory.appending(path: "engine")).installed() }.value
            if let exit = await gated(engine: engine, checked: true) { Darwin.exit(exit.rawValue) }
            run()
        }
        dispatchMain()
    }

    /// Whether this keeper may start this Mac's box (nil), or how it ends instead: as it should
    /// (`stopped`) where the box already here is this Mac's; or to be started again in a while
    /// (`again`, launchd waits between) where it couldn't tell with a box here.
    static func gated(engine: URL?, checked: Bool) async -> Exit? {
        switch await Here.gate(engine: engine, script: BoxProcess.script, appBox: BoxProcess.home, engineData: AppModel.engineFolders.dataDirectory,
                               home: AppModel.hereHome, checked: checked) {
        case .own:
            return nil
        case .attach:
            log.notice("The box already on this Mac is its box: no keeper of the app's")
            return .stopped
        case .unknown(let why):
            log.error("Couldn't tell whether the box already on this Mac is its box: \(why ?? "here didn't answer", privacy: .public)")
            return .again
        }
    }

    /// The keeper's own start, once it's this Mac's box's (on the main thread, before or within
    /// `dispatchMain`).
    private nonisolated static func run() {
        try? FileManager.default.createDirectory(at: KeeperRecord.run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // One keeper at a time: one started while another runs (the app starting it while launchd
        // already has) goes at once, and cleanly, so launchd doesn't start it again.
        let lock = open(KeeperRecord.lock.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else {
            log.info("Another keeper runs already")
            exit(Exit.stopped.rawValue)
        }
        let keeper = MainActor.assumeIsolated { Keeper() }
        // launchd stopping it (you log out, or its launch agent was taken away): what runs stops
        // first, cleanly.
        signal(SIGTERM, SIG_IGN)
        let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        terminate.setEventHandler { MainActor.assumeIsolated { keeper.finish(.stopped) } }
        terminate.resume()
        MainActor.assumeIsolated { keeper.terminate = terminate }
        Task { @MainActor in await keeper.start() }
    }

    private var terminate: DispatchSourceSignal?

    func start() async {
        do {
            let port = try await server.start()
            try KeeperRecord(pid: getpid(), version: version, build: build, url: "http://127.0.0.1:\(port)",
                             password: password, started: started.timeIntervalSince1970 * 1000).write()
            Self.writeStart()
            // Its process, as a machine's keeper records its own.
            FileManager.default.createFile(atPath: KeeperRecord.run.appending(path: "box.pid").path, contents: Data("\(getpid())".utf8), attributes: [.posixPermissions: 0o600])
            log.info("Keeper \(self.version, privacy: .public) (\(self.build, privacy: .public)) started")
            Machines.moveFromSettings()
            link.hasMachines = { Machines.anySaved }
            box.host.phoneLink = link
            box.host.appAnswers = false
            // kuvo-wake run for the wake-up tools gets your shell's environment, as the engine does.
            tools.boxTools.shell = { [box] in box.shell }
            do {
                box.tools = try await tools.start()
            } catch {
                log.error("The browser's tools didn't start: \(error.localizedDescription, privacy: .public)")
            }
            // An app that runs this Mac's box itself (it did while the keeper wasn't allowed) keeps
            // it until it quits: then it's the keeper's.
            while !box.claim() {
                try? await Task.sleep(for: .seconds(5))
            }
            await box.start()
            watch()
        } catch {
            // Nothing could reach it: gone, to be started again by launchd.
            log.error("The keeper couldn't start: \(error.localizedDescription, privacy: .public)")
            finish(.again)
        }
    }

    /// Everything it started stopped, its record taken away, and gone.
    func finish(_ how: Exit) {
        guard !finished else { return }
        finished = true
        watching?.cancel()
        awake.agentsWork(false)
        box.stop()
        tools.stop()
        server.stop()
        KeeperRecord.forget(pid: getpid())
        if (try? String(contentsOf: KeeperRecord.run.appending(path: "box.pid"), encoding: .utf8)) == "\(getpid())" {
            try? FileManager.default.removeItem(at: KeeperRecord.run.appending(path: "box.pid"))
        }
        log.info("Keeper stopped (\(how.rawValue))")
        exits(how)
    }

    // MARK: Control

    private func respond(to request: HTTPRequest) async -> HTTPResponse {
        guard let authorization = request.headers["authorization"], authorization.hasPrefix("Bearer "),
              samePassword(String(authorization.dropFirst(7)), password) else { return .init(status: 401) }
        guard let command = KeeperControl.Command(rawValue: String(request.path.dropFirst())) else { return .init(status: 404) }
        guard request.method == (command == .status ? "GET" : "POST") else { return .init(status: 405) }
        switch command {
        case .status:
            return .json(await status)
        case .stop:
            // Said first, then done: the client hears it was taken before it goes.
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(300))
                self.finish(.stopped)
            }
            return .json([:])
        case .restartEngine:
            box.restartEngine()
            return .json([:])
        case .restartAgents:
            Task {
                box.agents.stop()
                await box.agents.startAgain()
            }
            return .json([:])
        case .restartBox:
            Task { await box.box.startAgain() }
            return .json([:])
        case .update:
            update()
            return .json(["updating": handingOver])
        case .app:
            let given = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]) ?? [:]
            tools.use(given["tools"] as? [String: Any] ?? [:])
            box.host.useApp(given["host"] as? [String: Any] ?? [:])
            return .json([:])
        }
    }

    /// Whether it keeps this Mac awake, with the setting as it is now (a phone that just changed it
    /// hears what it changed, not what the last look found).
    private var awakeNow: Bool {
        awake.update()
        return awake.isHolding
    }

    /// What runs, and how: the engine, the box and the bridge, whether anything is under way, and
    /// whether it keeps this Mac awake for it.
    private var status: [String: Any] {
        get async {
            var engine: [String: Any] = [:]
            switch box.engine {
            case .starting: engine["state"] = "starting"
            case .downloading(let progress): engine = ["state": "downloading", "progress": progress]
            case .ready: engine["state"] = "ready"
            case .failed(let reason): engine = ["state": "failed", "reason": reason]
            }
            var answer: [String: Any] = [
                "pid": Int(getpid()), "version": version, "build": build,
                "started": started.timeIntervalSince1970 * 1000, "engine": engine, "busy": await box.isBusy(),
                "updating": handingOver, "awake": awakeNow,
            ]
            if let failure = box.box.failure { answer["box"] = ["failure": failure] }
            if let failure = box.agents.failure { answer["agents"] = ["failure": failure] }
            return answer
        }
    }

    // MARK: What's under way

    /// What's under way, looked at now and again every so often: every 10 seconds, and every 2
    /// while it makes way for a newer keeper, so it goes soon after the last session ends.
    private func watch() {
        watching?.cancel()
        watching = Task { @MainActor in
            while await look() {
                await Self.clock(handingOver ? 2 : 10)
                if Task.isCancelled { return }
            }
        }
    }

    /// One look: this Mac kept awake while something is under way (and the setting says so), an
    /// app installed over this one noticed (an update installed as you quit, with no app open to
    /// say so), and once it makes way with nothing under way, gone. Whether to look again.
    private func look() async -> Bool {
        let busy = await box.isBusy()
        guard !Task.isCancelled, !finished else { return false }
        awake.agentsWork(busy)
        // The setting as you last changed it, in the app or from a phone.
        awake.update()
        if !handingOver, let installed = installed(), installed != "\(version) (\(build))" {
            log.info("Kuvo Code \(installed, privacy: .public) is installed now")
            handingOver = true
        }
        guard handingOver, !busy else { return true }
        finish(.again)
        return false
    }

    /// Gone the first moment nothing is under way on the engine or with the coding agents, however
    /// long what runs takes (a running session is never stopped for an update), to be started again
    /// from the app now installed (launchd starts it from there). Until then, an app following it
    /// says the update waits.
    private func update() {
        guard !handingOver, !finished else { return }
        // launchd starts it again from its own place: with that app still its own version (the app
        // asking is another copy, opened from elsewhere), it would only come back as it was, and be
        // asked again.
        guard let installed = installed(), installed != "\(version) (\(build))" else {
            log.info("Asked to make way, but the app at its place is its own version")
            return
        }
        log.info("Making way for a newer keeper once nothing is under way")
        handingOver = true
        // Looked at now, unless the box is still starting: its first look comes once it has.
        if watching != nil { watch() }
    }

    /// The version of the app now at this one's place, as "0.9.0 (123)": read from its file, as the
    /// running one's own is kept from when it started.
    nonisolated static func installedVersion(of app: URL = Bundle.main.bundleURL) -> String? {
        guard let data = try? Data(contentsOf: app.appending(path: "Contents/Info.plist")),
              let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let version = info["CFBundleShortVersionString"] as? String, let build = info["CFBundleVersion"] as? String else { return nil }
        return "\(version) (\(build))"
    }

    #if DEBUG
    /// Tests move a clock of their own on.
    static var clock: (Int) async -> Void = sleep
    #else
    private static let clock: (Int) async -> Void = sleep
    #endif

    private static func sleep(_ seconds: Int) async {
        try? await Task.sleep(for: .seconds(seconds))
    }

    // MARK: Asked as a machine's keeper is

    /// `bin/kuvo-start`, as a machine has it (`kuvo-start restart`, which its box runs for
    /// `kuvo/engine/restart`): here it asks this keeper (`--box-control`), from wherever the app
    /// is now.
    private static func writeStart() {
        guard let executable = Bundle.main.executablePath else { return }
        let bin = KeeperRecord.run.deletingLastPathComponent().appending(path: "bin")
        let quoted = "'" + executable.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let script = """
        #!/bin/sh
        # This Mac's keeper, asked as a machine's is: kuvo-start start | restart | keep | stop | status.
        exec \(quoted) --box-control "$@"

        """
        let file = bin.appending(path: "kuvo-start")
        guard (try? String(contentsOf: file, encoding: .utf8)) != script else { return }
        try? FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        FileManager.default.createFile(atPath: file.path, contents: Data(script.utf8), attributes: [.posixPermissions: 0o700])
    }

    /// `--box-control <command>`: one command to the keeper running now, what it answered printed;
    /// exits 0 once it's done. A machine's keeper's words are taken as they are there (its box runs
    /// `kuvo-start restart` for `kuvo/engine/restart`): `restart` the engine, `start` it if it isn't
    /// running, `keep` (launchd keeps the keeper here, so there's nothing to do).
    nonisolated static func control(_ arguments: [String]) -> Never {
        let name = arguments.first ?? "status"
        if name == "keep" { exit(0) }
        let aliases = ["restart": KeeperControl.Command.restartEngine.rawValue, "start": KeeperControl.Command.status.rawValue]
        guard let command = KeeperControl.Command(rawValue: aliases[name] ?? name) else {
            FileHandle.standardError.write(Data("Usage: --box-control start|restart|keep|\(KeeperControl.Command.allCases.map(\.rawValue).joined(separator: "|"))\n".utf8))
            exit(64)
        }
        Task {
            do {
                if name == "start" {
                    // Started if it isn't running: the engine, by the keeper, or the keeper by launchd.
                    guard let status = try? await KeeperControl.send(.status) else {
                        // Its end from `ChildProcess`, which never misses it.
                        let result = try await ChildProcess.run(BackgroundWork.launchctl, ["kickstart", "gui/\(getuid())/\(BackgroundWork.label)"],
                                                                output: .discard, errors: .discard, limit: .seconds(30), cancellable: false)
                        exit(result.timedOut ? 1 : result.status)
                    }
                    if (status["engine"] as? [String: Any])?["state"] as? String != "ready" { try await KeeperControl.send(.restartEngine) }
                    exit(0)
                }
                let answer = try await KeeperControl.send(command)
                let data = (try? JSONSerialization.data(withJSONObject: answer, options: [.sortedKeys])) ?? Data()
                FileHandle.standardOutput.write(data + Data("\n".utf8))
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
                exit(1)
            }
        }
        dispatchMain()
    }
}
