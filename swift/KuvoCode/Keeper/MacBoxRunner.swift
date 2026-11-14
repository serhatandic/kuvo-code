import Darwin
import Foundation
import OpenCodeKit
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "box")

/// This Mac's box, started and kept running as a machine's keeper keeps one there: the box itself
/// (`kuvo-link.js serve`, `BoxProcess`), the engine, and the coding agents' bridge (`OutsideAgents`),
/// each recorded in the box's `run` folder for whoever uses them (`run/engine.json`,
/// `run/serve.json`, `run/bridge.json`). The keeper runs it (`Keeper`), so it goes on when you quit
/// Kuvo Code; the app runs it itself only while macOS doesn't let the keeper run (`BackgroundWork`),
/// and then it stops when you quit.
@MainActor
final class MacBoxRunner {
    enum Engine: Equatable {
        case starting
        case downloading(progress: Double)
        case ready(ServerEndpoint)
        case failed(String)
    }

    /// The engine, as it's doing: told to `onEngine` as it changes.
    private(set) var engine: Engine = .starting {
        didSet {
            guard engine != oldValue else { return }
            waiting.settle(engine)
            onEngine(engine)
        }
    }
    var onEngine: (Engine) -> Void = { _ in }
    private let waiting = EngineWaiters()

    /// Where the engine answers once it's up (now, if it is), or why it couldn't start.
    func ready() async throws -> ServerEndpoint {
        try await waiting.wait(for: engine)
    }

    let box: BoxProcess
    let agents: OutsideAgents
    let host: HostInterface

    /// What the engine and the agents are given for Kuvo Code's own tools (the panel's browser):
    /// set before `start`.
    struct Tools {
        var engineConfig: [String: Any]
        var agents: OutsideAgents.ToolServer
    }
    var tools: Tools?

    private(set) var server: ServerProcess?
    private(set) var binary: URL?
    private(set) var shell: [String: String] = [:]
    /// Each start, so one stopped meanwhile (a restart, a stop) gives up, and its exit is expected.
    private var launch = UUID()
    private var restarts: [Date] = []
    /// One whose start failed, or that keeps stopping, tried again by itself: stopping the engine
    /// calls off the next try.
    let retries = StartRetries()
    /// When it came up, this time.
    private var upSince: Date?
    /// The engine's process starting: stopping the engine tells it to go at once, rather than
    /// leaving it beside a new start until its time is up.
    private var starting: Task<ServerProcess, Error>?
    /// How long it's given to say where it listens (a test's is short).
    var startTimeout: Duration = .seconds(60)
    /// Whether macOS is asking you something: each of this box's servers' tries goes by it.
    let asking = SystemAsking()
    /// Tells the box's watch of its servers while macOS asks you something (`BoxProcess.systemAsking`).
    private var askingWatch: Task<Void, Never>?

    init(box: BoxProcess, agents: OutsideAgents, host: HostInterface) {
        self.box = box
        self.agents = agents
        self.host = host
        retries.asking = asking
        box.retries.asking = asking
        agents.retries.asking = asking
    }

    /// Held while this process runs the box (`run/box.lock`): never two at once on the same
    /// folders, the keeper and an app that ran its own while the keeper wasn't allowed.
    private var lock: Int32 = -1

    /// Takes it to run: whether no other process runs it now.
    func claim() -> Bool {
        if lock >= 0 { return true }
        try? FileManager.default.createDirectory(at: KeeperRecord.run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = open(KeeperRecord.run.appending(path: "box.lock").path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard file >= 0 else { return false }
        guard flock(file, LOCK_EX | LOCK_NB) == 0 else {
            close(file)
            return false
        }
        lock = file
        return true
    }

    private var installer: EngineInstaller {
        EngineInstaller(root: AppInfo.supportDirectory.appending(path: "engine"))
    }

    /// The box, the bridge and the engine, started (or started again after `stop`). Says how the
    /// engine is doing by `engine`; the box and the bridge say so themselves.
    func start() async {
        let launch = UUID()
        self.launch = launch
        var began = ContinuousClock.now
        upSince = nil
        engine = .starting
        // Why one before stopped (a keeper killed before it could take it away) isn't this one's.
        BoxProcess.forgetEngineStopped()
        watchSystemAsking()
        do {
            async let environment = ShellEnvironment.load()
            let binary: URL
            if let override = AppModel.engineOverride {
                binary = URL(filePath: override)
            } else if let installed = await Task.detached(operation: { [installer] in installer.installed() }).value {
                // Checking its signature reads all of it, a second or so: off the main thread.
                binary = installed
            } else {
                engine = .downloading(progress: 0)
                binary = try await installer.install { progress in
                    Task { @MainActor in
                        if case .downloading = self.engine { self.engine = .downloading(progress: progress) }
                    }
                }
                guard launch == self.launch else { return }
                engine = .starting
            }
            // Neither the engine nor the box starts from an app changed since it was signed (the
            // box's script is in it): the engine itself was checked as it was found or downloaded.
            if AppModel.engineOverride == nil, await !Task.detached(operation: { BoxIntegrity.appIsSealed() }).value {
                gaveUp("Kuvo Code on this Mac was changed since it was installed, so its engine didn’t start. Install Kuvo Code again.")
                return
            }
            self.binary = binary
            var shell = await environment
            guard launch == self.launch else { return }
            // A copy that never prompts leaves out the skills in ~/.claude/skills: one can be a link
            // into your Desktop, and macOS would ask whether the copy may read it.
            if AppInfo.neverPrompts { shell["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"] = "1" }
            self.shell = shell
            // Bots' wake-up command, by name, and where their folders are; and the launcher
            // integrations' servers run with.
            try? Launcher.install(in: Bots.command.deletingLastPathComponent(), engine: binary)
            shell["PATH"] = Bots.command.deletingLastPathComponent().path + ":" + (shell["PATH"] ?? "/usr/bin:/bin")
            shell["KUVO_BOTS"] = Bots.root.path
            shell["KUVO_WAKES"] = WakeUps.root.path
            // Keys you brought for integrations, in the files their settings name with {file:…}
            // (not the engine's environment, where the agent's commands would see them), and a
            // folder for what their servers keep (a sign-in).
            #if DEBUG
            // KUVO_DEMO_INTEGRATION_KEY=<id>|<NAME>|<value>: saves that key as Add Key… does
            // (no value removes it).
            if let spec = ProcessInfo.processInfo.environment["KUVO_DEMO_INTEGRATION_KEY"] {
                let parts = spec.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
                if parts.count == 3 { IntegrationKeys.set(parts[2], for: IntegrationKeys.variable(parts[0], parts[1])) }
            }
            #endif
            // Read off the main thread: the keychain can wait on you (a prompt to allow it).
            await Task.detached { IntegrationKeys.writeFiles() }.value
            IntegrationKeys.keepFresh()
            let integrations = BoxProcess.integrations
            try? FileManager.default.createDirectory(at: integrations, withIntermediateDirectories: true)
            shell["KUVO_INTEGRATIONS"] = integrations.path
            // The box, before the engine: it keeps the engine's settings, and goes on through the
            // engine's restarts.
            await box.start(engine: binary, environment: await boxEnvironment(shell), checked: AppModel.engineOverride == nil)
            guard launch == self.launch else { return }
            // The coding agents' bridge once the box has set up its sandbox (it waits for that, but no
            // longer than a while): no coding agent runs outside it. This Mac's group chats run there,
            // and show (and meet) from now, while the engine starts.
            startAgents(engine: binary)
            // What the engine starts with, as the box gives it (as a machine's start asks it). (What
            // some providers need, the box keeps beside the engine's settings, where it reads it.)
            shell["OPENCODE_CONFIG_CONTENT"] = await box.engineConfig(engine: binary, content: shell["OPENCODE_CONFIG_CONTENT"], environment: shell)
            #if DEBUG
            // KUVO_PERF_PROVIDER: the stand-in model a group chat's discussion is measured on (PerfGroups).
            if let perf = PerfGroups.providerConfig { shell["OPENCODE_CONFIG_CONTENT"] = AppModel.merged(perf, into: shell["OPENCODE_CONFIG_CONTENT"]) }
            #endif
            // Kuvo Code's own tools (the browser). Without them the agent still works, just without
            // the browser.
            if let tools {
                shell["OPENCODE_CONFIG_CONTENT"] = AppModel.merged(tools.engineConfig, into: shell["OPENCODE_CONFIG_CONTENT"])
                agents.toolServer = tools.agents
            }
            guard launch == self.launch else { return }
            let environmentNow = shell
            let timeout = startTimeout
            // (What's held the box up before this isn't this try's.)
            began = .now
            let starting = Task {
                try await ServerProcess.start(
                    executable: binary,
                    folders: AppModel.engineFolders,
                    environment: environmentNow,
                    timeout: timeout,
                    onExit: { status in Task { @MainActor in self.engineExited(status: status, launch: launch) } }
                )
            }
            self.starting = starting
            let server = try await withTaskCancellationHandler { try await starting.value } onCancel: { starting.cancel() }
            guard launch == self.launch else {
                server.stop()
                return
            }
            self.server = server
            try await Self.waitUntilReady(OpenCodeAPI(endpoint: server.endpoint))
            guard launch == self.launch else { return }
            // The box finds the engine as a machine's does; the bridge runs the engine's models.
            BoxProcess.engineChanged(server.endpoint, version: OpenCodeEngine.version, pid: server.processID)
            agents.engineEndpoint = server.endpoint
            upSince = .now
            retries.cameUp(since: began)
            engine = .ready(server.endpoint)
            // Started once already (above); tried again here if it didn't start then and isn't
            // waiting to by itself.
            let boxEnvironment = await boxEnvironment(shell)
            guard launch == self.launch else { return }
            await box.start(engine: binary, environment: boxEnvironment, checked: AppModel.engineOverride == nil)
        } catch {
            guard launch == self.launch else { return }
            var reason = error.localizedDescription
            if let server {
                let output = String(server.recentOutput.trimmingCharacters(in: .whitespacesAndNewlines).suffix(600))
                if let status = server.exitStatus {
                    reason = ServerProcessError.exited(status: status, output: output).localizedDescription
                } else if !output.isEmpty {
                    reason += "\n\n" + output
                }
            }
            log.error("Engine failed to start: \(reason, privacy: .public)")
            // One that started and stopped says so as the server does, whatever waiting on it said.
            let cause: any Error = if let status = server?.exitStatus { ServerProcessError.exited(status: status, output: "") } else { error }
            let asked = retries.wasAsked(cause, since: began)
            stopEngine()
            guard StartRetries.canHelp(cause) else {
                gaveUp(reason)
                return
            }
            tryAgain(reason, asked: asked)
        }
    }

    /// It failed, for a reason another try can help: it says so, and goes on trying.
    private func tryAgain(_ reason: String, asked: Bool = false) {
        let wait = retries.next(asked: asked)
        log.info("Trying the engine again in \(wait) seconds")
        gaveUp(StartRetries.noted(reason, asked: asked), retryingAfter: wait)
        retries.schedule(after: wait, orAnswered: asked) { [weak self] in await self?.start() }
    }

    /// The engine started over (it says it's starting at once); the box and the bridge stay up.
    /// Asked for (Try Again, Restart), so its stops before count no more.
    func restartEngine() {
        restarts.removeAll()
        retries.reset()
        stopEngine()
        let restart = launch
        engine = .starting
        // The bridge and the box, down, go with it: for many, this is the only Restart there is.
        if agents.failure != nil { Task { await agents.startAgain() } }
        // (The box first, as `start` has it: it keeps the engine's settings.)
        Task {
            if box.failure != nil { await box.startAgain() }
            // (Stopped or restarted again meanwhile: that's what stands.)
            guard restart == launch else { return }
            await start()
        }
    }

    /// The engine stopped (a start still on its way gives up); the box and the bridge stay up.
    func stopEngine() {
        launch = UUID()
        retries.callOff()
        starting?.cancel()
        starting = nil
        server?.stop()
        server = nil
        BoxProcess.engineChanged(nil, version: nil, pid: nil)
        if case .ready = engine { engine = .starting }
    }

    /// Everything stopped: the engine, the bridge and the box, waited for (a few seconds at most)
    /// before another process may run the box (the keeper, as the app quits): never two engines on
    /// the same data, and the engine always gets to close its database itself. `keepingClaim`: its
    /// lock still held, so no other process runs the box meanwhile (the keeper, as the box moves).
    func stop(keepingClaim: Bool = false) {
        let running = [server?.processID, agents.processID, box.processID].compactMap(\.self)
        askingWatch?.cancel()
        askingWatch = nil
        BoxProcess.systemAsking(false)
        stopEngine()
        agents.stop()
        box.stop()
        host.stop()
        IntegrationKeys.removeFiles()
        Self.waitForExit(running)
        if lock >= 0, !keepingClaim {
            close(lock)
            lock = -1
        }
    }

    /// Waits for `processes` to exit after being told to stop, `within` seconds at most; ones still
    /// running then are terminated, and killed a second after.
    nonisolated static func waitForExit(_ processes: [Int32], within: TimeInterval = 4) {
        func running() -> [Int32] { processes.filter { kill($0, 0) == 0 } }
        func wait(_ seconds: TimeInterval) -> Bool {
            let until = Date.now.addingTimeInterval(seconds)
            while !running().isEmpty {
                guard Date.now < until else { return false }
                usleep(50_000)
            }
            return true
        }
        guard !processes.isEmpty, !wait(within) else { return }
        for process in running() { kill(process, SIGTERM) }
        guard !wait(1) else { return }
        for process in running() { kill(process, SIGKILL) }
    }

    /// Whether something is under way: a session running on the engine or with the coding agents.
    /// One that can't be asked counts as nothing.
    func isBusy() async -> Bool {
        for endpoint in [server?.endpoint, agents.address.endpoint].compactMap(\.self) {
            if let active = try? await OpenCodeAPI(endpoint: endpoint).activeSessions(), !active.isEmpty { return true }
        }
        return false
    }

    /// Looks for as long as this runs: only the Mac's own side can see macOS asking.
    private func watchSystemAsking() {
        guard askingWatch == nil else { return }
        askingWatch = Task { [weak self] in
            while !Task.isCancelled, let self {
                BoxProcess.systemAsking(self.asking.look())
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    private func gaveUp(_ reason: String, retryingAfter wait: Int? = nil) {
        engine = .failed(reason)
        BoxProcess.engineGaveUp(reason, retryingAfter: wait)
    }

    private func engineExited(status: Int32, launch: UUID) {
        // One stopped (for a restart, or as the box stops) exits a moment later, after the stop.
        guard launch == self.launch, case .ready = engine else { return }
        let output = server?.recentOutput.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        log.error("Engine exited with status \(status): \(output, privacy: .public)")
        retries.stopped(ranFor: upSince.map { -$0.timeIntervalSinceNow } ?? 0)
        stopEngine()
        // Started again, as it was, at once unless it has stopped like this a few times in the last
        // minutes: then with the waits of one that won't start, saying why.
        restarts.removeAll { $0 < .now.addingTimeInterval(-300) }
        if restarts.count < 3, !retries.isBackingOff {
            restarts.append(.now)
            Task { await start() }
            return
        }
        tryAgain("It stopped unexpectedly (exit code \(status)), and again after starting over.\(output.isEmpty ? "" : "\n\n" + String(output.suffix(600)))")
    }

    /// The server answers 503 until it has loaded.
    static func waitUntilReady(_ api: OpenCodeAPI) async throws {
        let deadline = ContinuousClock.now + .seconds(60)
        while true {
            do {
                _ = try await api.info()
                return
            } catch let error as ServerError where error.status == 503 {
                if ContinuousClock.now > deadline { throw error }
                try await Task.sleep(for: .milliseconds(150))
            }
        }
    }

    // MARK: The bridge

    /// The agents bridge, with the engine's Bun, once: it goes on through the engine's restarts.
    private func startAgents(engine binary: URL) {
        guard !agents.wasStarted else { return }
        var environment = shell
        // Bots' wake-up command by name, and where their folders are, for their sessions with the
        // coding agents too, as the engine's commands have them.
        let bin = Bots.command.deletingLastPathComponent().path
        environment["PATH"] = bin + ":" + (environment["PATH"] ?? "/usr/bin:/bin")
        environment["KUVO_BOTS"] = Bots.root.path
        environment["KUVO_WAKES"] = WakeUps.root.path
        environment["KUVO_BIN"] = bin
        // The box's sandbox, which the coding agents run their commands in while it's on, as a
        // machine's is in `~/.kuvo-code/run/fence`.
        environment["KUVO_FENCE"] = BoxProcess.run.appending(path: "fence").path
        // The box's queues, where a chat's part for a conversation you stopped waits until you
        // resume it, as a machine's are in `~/.kuvo-code/run`.
        environment["KUVO_RUN"] = BoxProcess.run.path
        // Where this Mac's engine settings are, as its box has them: the model your subagents use
        // (Settings › Agents) is in them, for the coding agents' subagents too.
        environment["KUVO_ENGINE_CONFIG"] = AppModel.engineFolders.configHome.path
        // This Mac's group chats, in its own folder, as a machine's are in `~/.kuvo-code`: their
        // bots are its bots, what they let go of goes to the box's trash (and on to the Finder's,
        // `kuvo.group.trashed`), and a bot remembers them under the key it always has.
        environment["KUVO_GROUPS"] = GroupMigration.root.path
        environment["KUVO_TRASH"] = BoxGroups.macTrash.path
        environment["KUVO_GROUPS_MEMORY_KEY"] = BotGroups.memoryKey
        // Who can be named with & in a chat: this Mac's agents and its machines', as its box lists them.
        environment["KUVO_AGENTS_FILE"] = AgentMail.boxDirectoryFile.path
        // Its record of what agents made, in the box's own folder, as a machine's is in `~/.kuvo-code`.
        environment["KUVO_ARTIFACTS"] = BoxProcess.home.appending(path: "artifacts").path
        // Where this Mac's engine keeps its database, which the box reads (only reads) for what your
        // ChatGPT sign-in used through the engine's models, as a machine's box reads its engine's.
        environment["KUVO_ENGINE_DB_FOLDER"] = AppModel.engineFolders.dataDirectory.path
        // What the app writes in your Library, which a session in your home folder walks over: never
        // what an agent made (the support folder, which holds the box's, it knows already).
        let library = URL.libraryDirectory, own = [
            library.appending(path: "Caches/\(AppInfo.bundleID)"), StorageReport.appLogs, library.appending(path: "WebKit/\(AppInfo.bundleID)"),
            library.appending(path: "HTTPStorages/\(AppInfo.bundleID)"), library.appending(path: "Preferences/\(AppInfo.bundleID).plist"),
        ]
        environment["KUVO_OWN_FOLDERS"] = String(decoding: (try? JSONEncoder().encode(own.map(\.path))) ?? Data("[]".utf8), as: UTF8.self)
        Task { await agents.start(engine: binary, environment: environment) }
    }

    // MARK: The box

    /// What the box is started with, beside your shell's environment: Kuvo Code's own kuvo-wake,
    /// with which it sends this Mac's wake-ups as a machine's keeper sends its own; the host
    /// interface, through which it keeps bots' keys in your Keychain (without it, it can't reach
    /// them, and says so, rather than keep them elsewhere: it finds where it answers in its
    /// `run/host.json`, for each call, so one started again later is reached); and Settings ›
    /// Integrations' catalog with this Mac's own paths.
    func boxEnvironment(_ shell: [String: String]) async -> [String: String] {
        // COMPAT(0.7 mac-personalities): personalities where Kuvo Code kept them before, moved to the box. Goes 3 months after 0.8.0.
        // Your personalities, where it keeps them, from where Kuvo Code kept them before (once).
        Personalities.moveToBox()
        try? WakeUps.installCommand()
        var environment = shell
        environment["KUVO_WAKE_COMMAND"] = WakeUps.command.path
        environment["KUVO_KEYS_ON_HOST"] = "1"
        // Where this app keeps the files its sessions sent, a folder for each: they go as the
        // box hears their session's deleted.
        environment["KUVO_MAC_ATTACHMENTS"] = Attachments.directory.path
        // Where it answers is in the box's folder, never its environment.
        environment["KUVO_HOST_URL"] = nil
        environment["KUVO_HOST_PASSWORD"] = nil
        // Agents use the vault only where their commands are fenced (the box decides), never because
        // your shell says so.
        environment["KUVO_VAULT_AGENTS"] = nil
        // The vault's secrets, for it alone (HostInterface.vaultSecret, VaultValues.fileKey).
        environment["KUVO_HOST_VAULT_SECRET"] = host.vaultSecret
        environment["KUVO_VAULT_FILE_KEY"] = VaultValues.fileKey()
        #if DEBUG
        // KUVO_DEMO_KEYS_UNREAD: not answering as the box starts, so its keys can't be reached, to
        // see how that shows (Try Again in Settings › Integrations starts it).
        if ProcessInfo.processInfo.environment["KUVO_DEMO_KEYS_UNREAD"] != nil {
            host.stop()
        } else {
            await host.keepUp()
        }
        #else
        // One that can't start now is tried again until it does.
        await host.keepUp()
        #endif
        MachineBox.writeMacCatalog()
        return environment
    }
}

/// Those waiting for an engine to be up, or to have failed: each told once, as it is.
@MainActor
final class EngineWaiters {
    struct Failed: LocalizedError {
        var reason: String
        var errorDescription: String? { reason }
    }

    private var waiting: [CheckedContinuation<ServerEndpoint, Error>] = []

    func wait(for engine: MacBoxRunner.Engine) async throws -> ServerEndpoint {
        switch engine {
        case .ready(let endpoint): return endpoint
        case .failed(let reason): throw Failed(reason: reason)
        case .starting, .downloading: return try await withCheckedThrowingContinuation { waiting.append($0) }
        }
    }

    func settle(_ engine: MacBoxRunner.Engine) {
        let result: Result<ServerEndpoint, Error>
        switch engine {
        case .ready(let endpoint): result = .success(endpoint)
        case .failed(let reason): result = .failure(Failed(reason: reason))
        case .starting, .downloading: return
        }
        let waiting = waiting
        self.waiting = []
        for continuation in waiting { continuation.resume(with: result) }
    }
}
