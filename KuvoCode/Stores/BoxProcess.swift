import Foundation
import KuvoLink
import OpenCodeKit
import os
import Security

private let log = Logger(subsystem: "run.kuvo.code", category: "box")

/// This Mac's box: the same box a machine runs (`kuvo-link.js`), here as `kuvo-link.js serve`,
/// which answers its routes to this app on 127.0.0.1 (PROTOCOL.md, "This Mac's box"). Started with
/// the engine's Bun, as the agents bridge is, it keeps what it has in `box` in the app's own
/// folder and goes when the app does. It finds the engine and the agents bridge as a machine's
/// box does, by their records in `box/run`, which this writes as they start and stop.
///
/// It answers every route but this Mac's own (`PhoneLink.appRoutes`): PhoneLink forwards the rest
/// here, and the app's own stores reach them through `BoxClient`.
@MainActor @Observable
final class BoxProcess {
    /// Where the box keeps what it has: its `KUVO_HOME`.
    static var home: URL { AppInfo.supportDirectory.appending(path: "box") }
    static var run: URL { home.appending(path: "run") }
    /// What integrations' servers keep, which the engine is given too (`KUVO_INTEGRATIONS`).
    static var integrations: URL { AppInfo.supportDirectory.appending(path: "integrations") }

    /// Where it's reached while it runs.
    private(set) var endpoint: ServerEndpoint?
    /// Why it isn't running: it can't start, or it keeps stopping, and says if it's tried again.
    private(set) var failure: String?
    /// Whether its last start was refused because what it runs isn't what it was (`BoxIntegrity`):
    /// then nothing else runs the box's script with the engine's Bun either.
    @ObservationIgnored private(set) var refused = false
    /// When what it runs was last found to be what it was.
    @ObservationIgnored private var checkedAt: Date?

    @ObservationIgnored private var server: ServerProcess?
    /// Its process, while it runs.
    var processID: Int32? { server?.processID }
    /// What it was started with, to start it again the same way.
    @ObservationIgnored private var runtime: (executable: URL, environment: [String: String], arguments: (URL) -> [String])?

    /// What it was last started with, beside what it sets itself.
    var environment: [String: String]? { runtime?.environment }
    @ObservationIgnored private var restarts: [Date] = []
    /// One whose start failed, or that keeps stopping, tried again by itself: `stop` and Try Again
    /// call off the next try.
    @ObservationIgnored let retries = StartRetries()
    /// When it came up, this time.
    @ObservationIgnored private var upSince: Date?
    /// The start under way, and the one that's running: one stopped or given up on meanwhile is
    /// neither, so what it does later changes nothing.
    @ObservationIgnored private var startInFlight: UUID?
    @ObservationIgnored private var runningStart: UUID?
    /// Its process starting: stopping it tells it to go at once.
    @ObservationIgnored private var starting: Task<ServerProcess, Error>?
    /// How long it's given to say where it listens (a test's is short). Up in well under a second:
    /// the engine's start waits for it (its settings first), so one that's held up (macOS asking
    /// about a folder its script is in) doesn't hold the engine up for long.
    @ObservationIgnored var startTimeout: Duration = .seconds(15)
    /// Up, the first time or again (late, after Try Again, or after it stopped by itself).
    @ObservationIgnored var onStarted: () -> Void = {}
    /// It was given what it starts with (the engine's start got that far): Try Again can start it.
    var canStartAgain: Bool { runtime != nil || follows }

    /// The box's script: KUVO_BOX_SCRIPT's (a checkout's `kuvo-link.js`, or its source,
    /// `Packages/Box/src/link/main.ts`) in a debug build, else the app's own.
    private static var script: URL? {
        #if DEBUG
        if let path = ProcessInfo.processInfo.environment["KUVO_BOX_SCRIPT"] { return URL(filePath: path) }
        #endif
        return Bridge.scriptURL
    }

    /// `content` (what the engine starts with in `OPENCODE_CONFIG_CONTENT`) with what some providers
    /// need from the engine on top, as this Mac's box last learned it from its engine (nothing before
    /// it has; `kuvo-link.js engine-config`, as a machine's start adds it); as it
    /// is when that can't be run, or doesn't answer within `timeout` seconds (it's stopped then, and
    /// the engine's start waits only for that), or the box's start was refused (what it would run isn't what it was), or
    /// it isn't any more (checked again here when the box's own check is over a minute old: the
    /// engine restarts under a box that keeps running).
    func engineConfig(engine: URL, content: String?, environment: [String: String], timeout: TimeInterval = 10) async -> String? {
        guard !refused, let script = Self.script else { return content }
        if checksRuntime, checkedAt.map({ -$0.timeIntervalSinceNow > 60 }) ?? true {
            guard await Task.detached(operation: { BoxIntegrity.trouble(engine: engine) }).value == nil else { return content }
            checkedAt = Date()
        }
        let home = Self.home
        var env = environment
        // As the box starts (`launch`): nothing from your shell that runs before its code.
        for name in env.keys where name.hasPrefix("DYLD_") || name.hasPrefix("BUN_") || name == "NODE_OPTIONS" { env[name] = nil }
        env["BUN_BE_BUN"] = "1"
        env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"] = "0"
        env["KUVO_HOME"] = home.path
        env["OPENCODE_CONFIG_CONTENT"] = content
        // In its folder, as the box starts. Its end from `ChildProcess`, which never misses it, nor
        // waits on something it left running that holds its output open.
        guard let result = try? await ChildProcess.run(engine.path, ["run", "--config=/dev/null", "--no-env-file", script.path, "engine-config"],
                                                       environment: env, directory: home, errors: .discard, limit: .seconds(timeout)),
              !result.timedOut, result.reason == .exit, result.status == 0,
              let text = String(data: result.output, encoding: .utf8), text.hasPrefix("{"), text.hasSuffix("}") else { return content }
        return text
    }

    /// Whether what it runs with is checked for opencode's signature before each start (the
    /// engine's Bun; a test's Node isn't).
    private var checksRuntime = false
    /// Whether it runs with the engine's Bun (a test's runs with Node).
    private var runsEngine = false

    /// Starts it with the engine's Bun, once: it goes on through the engine's restarts. `checked`:
    /// the engine is checked for opencode's signature before each start (not one you named with
    /// `KUVO_OPENCODE_BINARY`, a build of your own).
    func start(engine: URL, environment: [String: String], checked: Bool = true) async {
        // (Waiting for its next try, it isn't tried sooner for the engine's. That's its own to go by,
        // and each engine try would bring back a question macOS is asking about it.)
        guard !retries.isWaiting else { return }
        checksRuntime = checked
        runsEngine = true
        var env = environment
        // The tests' stand-ins (GitHub's, npm's, a box kept from your other computers, one that may
        // work on goals alone without the sandbox) are for the tests' box only (`TestBox`), never the
        // app's.
        for name in env.keys where name.hasPrefix("KUVO_TEST_") { env[name] = nil }
        env["BUN_BE_BUN"] = "1"
        // Bun would otherwise keep a copy of the script, compiled, in ~/Library/Caches/bun.
        env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"] = "0"
        // Bun's settings only from nowhere, and no `.env` from its folder: either (which an agent's
        // command can write) could load a script of its own first, or set what the box reads
        // (a stand-in's address, the vault's key) before it reads its secrets.
        await launch(engine, environment: env) { ["run", "--config=/dev/null", "--no-env-file", $0.path, "serve"] }
    }

    #if DEBUG
    /// For tests: started with Node instead, which runs the same script.
    func start(node: URL, environment: [String: String] = [:]) async {
        await launch(node, environment: environment) { [$0.path, "serve"] }
    }
    #endif

    private func launch(_ runtime: URL, environment: [String: String], arguments: @escaping (URL) -> [String]) async {
        guard server == nil, startInFlight == nil else { return }
        let start = UUID()
        startInFlight = start
        defer { if startInFlight == start { startInFlight = nil } }
        let began = ContinuousClock.now
        upSince = nil
        self.runtime = (runtime, environment, arguments)
        guard let script = Self.script else {
            failure = "Kuvo Code’s background service is missing from the app. Install Kuvo Code again."
            return
        }
        var env = environment
        // Nothing from your shell's environment that changes what runs before the box's own code:
        // libraries loaded into it, Bun's or Node's options (an agent's command can write your
        // shell's profile). The engine's Bun gets its two from `start` again.
        for name in env.keys where name.hasPrefix("DYLD_") || name.hasPrefix("BUN_") || name == "NODE_OPTIONS" { env[name] = nil }
        if runsEngine {
            env["BUN_BE_BUN"] = "1"
            env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"] = "0"
        }
        if checksRuntime {
            // And what it runs is what it was: the engine's Bun the pinned build (opencode's
            // signature and the binary's own hash), and the box's script the app's own, sealed with it.
            // Checked again each time, as a file replaced in the app's folder or its bundle (both
            // yours to write, so an agent's command's too) would run as the box. (Off the main
            // thread: reading them takes a second or so.)
            let engine = runtime
            let trouble = await Task.detached(operation: { BoxIntegrity.trouble(engine: engine) }).value
            guard startInFlight == start else { return }
            if let trouble {
                failure = trouble
                refused = true
                return
            }
            refused = false
            checkedAt = Date()
        }
        env["KUVO_HOME"] = Self.home.path
        // A Mac's box: its bots are this Mac's own, made with the kit the app gives it.
        env["KUVO_BOX"] = "mac"
        // What it says of this Mac with the app closed too (`kuvo/info`): the app's version, and
        // the engine's it brings.
        env["KUVO_APP_VERSION"] = AppInfo.version
        env["KUVO_ENGINE_VERSION"] = OpenCodeEngine.version
        // This Mac's chats, where a session a bot starts from its own folder goes, and which a phone
        // lists as Chats.
        env["KUVO_CHATS"] = Workspace.chatsFolder
        // The engine's settings folder, where it reads its settings and the skills you add (a machine's box finds its
        // engine's in its own folder): this Mac's settings and skills stay where they've always been. And
        // where the engine reads the keys you keep in the Keychain, which its settings name.
        env["KUVO_ENGINE_CONFIG"] = AppModel.engineFolders.configHome.path
        // Where the engine keeps its own, new worktrees by default among it (Settings › Worktrees).
        env["KUVO_ENGINE_DATA"] = AppModel.engineFolders.dataDirectory.path
        env["KUVO_KEYS"] = IntegrationKeys.folder.path
        // What integrations' servers keep (a sign-in), where the engine runs them with it.
        env["KUVO_INTEGRATIONS"] = Self.integrations.path
        // The defaults it adds to them once, as it starts: those an earlier version added here
        // noted as done, so one you took out stays out.
        Self.noteDefaultsAdded(EngineConfig.defaultsAdded())
        // Settings › MCP Servers' popular servers, as a machine's box has them from its Mac.
        let bin = Self.home.appending(path: "bin")
        try? FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try? MachineBox.catalogJSON().write(to: bin.appending(path: "mcp-catalog.json"), options: .atomic)
        // What it makes this Mac's bots with and tells them, as a machine's box has it.
        if let words = try? BotWords.data, (try? Data(contentsOf: bin.appending(path: BotWords.fileName))) != words {
            try? words.write(to: bin.appending(path: BotWords.fileName), options: .atomic)
        }
        // Its temporary files, in the app's own temporary folder.
        let temporary = FileManager.default.temporaryDirectory.appending(path: Bundle.main.bundleIdentifier ?? "run.kuvo.code").appending(path: "box")
        env["TMPDIR"] = temporary.path + "/"
        do {
            try FileManager.default.createDirectory(at: Self.run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
            // Its password and the vault's secrets on its stdin, never in its environment, which
            // any of your processes can read (`ps -E`): agents' commands among them.
            var secrets: [String: String] = [:]
            for (variable, name) in [("KUVO_HOST_VAULT_SECRET", "hostVaultSecret"), ("KUVO_VAULT_FILE_KEY", "vaultFileKey")] {
                if let value = env.removeValue(forKey: variable) { secrets[name] = value }
            }
            let command = arguments(script), given = env, directory = Self.home, secretsNow = secrets, timeout = startTimeout
            let starting = Task {
                try await ServerProcess.start(
                    executable: runtime,
                    arguments: command,
                    environment: given,
                    directory: directory,
                    secrets: secretsNow,
                    timeout: timeout,
                    onExit: { [weak self] status in Task { @MainActor in self?.exited(status: status, of: start) } }
                )
            }
            self.starting = starting
            let server = try await withTaskCancellationHandler { try await starting.value } onCancel: { starting.cancel() }
            // Stopped meanwhile: it stays stopped.
            guard startInFlight == start else {
                server.stop()
                return
            }
            self.server = server
            runningStart = start
            if let status = server.exitStatus {
                exited(status: status, of: start)
                return
            }
            endpoint = server.endpoint
            PhoneLink.box.withLock { $0 = server.endpoint }
            // Where it answers, for a client that didn't start it (the app, when the keeper runs it).
            Self.write(Record(pid: server.processID, port: server.endpoint.url.port, password: server.endpoint.password, version: nil), to: "serve.json")
            failure = nil
            upSince = .now
            retries.cameUp(since: began)
            onStarted()
        } catch {
            guard startInFlight == start else { return }
            log.error("This Mac's box didn't start: \(error.localizedDescription, privacy: .public)")
            guard StartRetries.canHelp(error) else {
                failure = Self.reason(error)
                return
            }
            tryAgain(Self.reason(error), asked: retries.wasAsked(error, since: began))
        }
    }

    /// Down, for a reason another try can help: it says so, and goes on trying.
    private func tryAgain(_ reason: String, asked: Bool = false) {
        guard let runtime else { return }
        let wait = retries.next(asked: asked)
        failure = StartRetries.noted(reason, asked: asked)
        log.info("Trying this Mac's box again in \(wait) seconds")
        retries.schedule(after: wait, orAnswered: asked) { [weak self] in
            await self?.launch(runtime.executable, environment: runtime.environment, arguments: runtime.arguments)
        }
    }

    /// Why it didn't start, in words of its own (ServerProcess's own say "the engine", which may be fine).
    private static func reason(_ error: any Error) -> String {
        switch error {
        case ServerProcessError.exited(let status, let output):
            "Kuvo Code’s background service stopped (exit code \(status)).\(output.isEmpty ? "" : "\n\n\(output)")"
        case ServerProcessError.unreadableHandshake(let line):
            "Kuvo Code’s background service said something unexpected when starting: \(line)"
        case ServerProcessError.timedOut:
            "Kuvo Code’s background service took too long to start."
        default:
            error.localizedDescription
        }
    }

    /// A start under way ended, and the next try called off.
    private func callOffStart() {
        retries.callOff()
        starting?.cancel()
        starting = nil
        startInFlight = nil
    }

    /// Started again at once (Try Again where it shows), whatever it's doing by itself: by this
    /// Mac's keeper, when it's the keeper's.
    func startAgain() async {
        if follows {
            do { try await KeeperControl.send(.restartBox) } catch { failure = error.localizedDescription }
            return
        }
        guard server == nil, let runtime else { return }
        callOffStart()
        restarts.removeAll()
        retries.reset()
        failure = nil
        await launch(runtime.executable, environment: runtime.environment, arguments: runtime.arguments)
    }

    #if DEBUG
    /// KUVO_DEMO_BOX_FAILED: as if it had stopped for good, to see how that shows.
    func showFailure(_ text: String) {
        stop()
        failure = text
    }
    #endif

    func stop() {
        callOffStart()
        // Stopped, nothing's trying any more, and there's no failure to tell.
        failure = nil
        if server != nil { Self.write(nil, to: "serve.json") }
        server?.stop()
        server = nil
        endpoint = nil
        PhoneLink.box.withLock { $0 = nil }
    }

    // MARK: Run by this Mac's keeper

    /// Whether it's the keeper's (`Keeper`), which runs it whether or not the app is open: this
    /// follows it, by its record (`run/serve.json`), rather than starting it.
    private(set) var follows = false

    /// The keeper's box, as its record and the keeper say: where it answers, or why it doesn't.
    func follow(_ endpoint: ServerEndpoint?, failure: String?) {
        follows = true
        if self.endpoint != endpoint {
            self.endpoint = endpoint
            PhoneLink.box.withLock { $0 = endpoint }
            if endpoint != nil { onStarted() }
        }
        self.failure = endpoint == nil ? failure : nil
    }

    /// Not the keeper's any more (background work switched off): the app runs it itself from now on.
    func unfollow() {
        follow(nil, failure: nil)
        follows = false
    }

    /// It stopped by itself: started again, at once unless it keeps stopping.
    private func exited(status: Int32, of start: UUID) {
        guard server != nil, start == runningStart else { return }
        let output = server?.recentOutput.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        log.error("This Mac's box stopped (\(status)): \(output, privacy: .public)")
        retries.stopped(ranFor: upSince.map { -$0.timeIntervalSinceNow } ?? 0)
        stop()
        restarts.removeAll { $0 < .now.addingTimeInterval(-300) }
        guard restarts.count < 3, !retries.isBackingOff, let runtime else {
            tryAgain("Kuvo Code’s background service stopped unexpectedly (exit code \(status)).\(output.isEmpty ? "" : "\n\n" + String(output.suffix(600)))")
            return
        }
        restarts.append(.now)
        retries.schedule(after: nil) { [weak self] in
            await self?.launch(runtime.executable, environment: runtime.environment, arguments: runtime.arguments)
        }
    }

    /// Notes defaults as added already (`box/defaults-added`, a name a line), beside those noted.
    static func noteDefaultsAdded(_ names: [String]) {
        guard !names.isEmpty else { return }
        let file = home.appending(path: "box/defaults-added")
        let noted = ((try? String(contentsOf: file, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
        let all = noted + names.filter { !noted.contains($0) }
        guard all.count > noted.count else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? Data((all.joined(separator: "\n") + "\n").utf8).write(to: file, options: .atomic)
    }

    // MARK: What the box finds beside it

    /// The engine, as a machine's launch records it (`run/engine.json`): nil once it's stopped.
    /// Started or stopped again, it isn't given up on.
    static func engineChanged(_ endpoint: ServerEndpoint?, version: String?, pid: Int32?) {
        write(endpoint.map { Record(pid: pid, port: $0.url.port, password: $0.password, version: version) }, to: "engine.json")
        forgetEngineStopped()
    }

    /// The engine is down, for you to start or till its next try (`run/engine-stopped`): why, in
    /// the words the window shows (their first paragraph), for the box to tell whoever asks it;
    /// and what the engine wrote last, which the window shows under it (`run/engine-output`), for
    /// the app to show as it shows its own engine's when it follows the keeper's. `retryingAfter`:
    /// it's tried again by itself in that many seconds (`run/engine.retry`, when, as a machine's
    /// keeper says it).
    static func engineGaveUp(_ reason: String, retryingAfter wait: Int? = nil) {
        let paragraphs = reason.components(separatedBy: "\n\n")
        let why = paragraphs.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // As it is, so a client shows the reason in the same words.
        let output = paragraphs.dropFirst().joined(separator: "\n\n")
        do {
            try FileManager.default.createDirectory(at: run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            // The output first: the reason appearing is what a client reads both on.
            if output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                try? FileManager.default.removeItem(at: run.appending(path: "engine-output"))
            } else {
                // (Without it, the reason still: never neither.)
                try? Data(output.utf8).write(to: run.appending(path: "engine-output"), options: .atomic)
            }
            if let wait {
                try? Data("\(Int(Date.now.timeIntervalSince1970) + wait)\n".utf8).write(to: run.appending(path: "engine.retry"), options: .atomic)
            } else {
                try? FileManager.default.removeItem(at: run.appending(path: "engine.retry"))
            }
            try Data(why.utf8).write(to: run.appending(path: "engine-stopped"), options: .atomic)
        } catch {
            log.error("Couldn't tell this Mac's box its engine stopped: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// macOS is asking you something, or isn't any more: a server reading a folder may be waiting
    /// on your answer, so the box's watch for hung servers holds off (`run/.system-asking`).
    static func systemAsking(_ asking: Bool) {
        let file = run.appending(path: ".system-asking")
        guard asking != FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) else { return }
        if asking {
            try? FileManager.default.createDirectory(at: run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            FileManager.default.createFile(atPath: file.path(percentEncoded: false), contents: nil)
        } else {
            try? FileManager.default.removeItem(at: file)
        }
    }

    /// The engine isn't given up on any more (it's up, or starting again): why it was, and what it
    /// wrote then, gone.
    static func forgetEngineStopped() {
        try? FileManager.default.removeItem(at: run.appending(path: "engine-stopped"))
        try? FileManager.default.removeItem(at: run.appending(path: "engine-output"))
        try? FileManager.default.removeItem(at: run.appending(path: "engine.retry"))
    }

    /// The coding agents' bridge is down (`run/agents-stopped`): why, in the words the window shows
    /// (their first paragraph), and whether it's tried again by itself, for the box to tell whoever
    /// asks it what runs on the bridge.
    static func agentsStopped(_ reason: String, retrying: Bool) {
        let why = reason.components(separatedBy: "\n\n").first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        do {
            try FileManager.default.createDirectory(at: run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let data = try JSONSerialization.data(withJSONObject: ["why": why, "retrying": retrying] as [String: Any])
            try data.write(to: run.appending(path: "agents-stopped"), options: .atomic)
        } catch {
            log.error("Couldn't tell this Mac's box its coding agents stopped: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// The bridge is starting, or was stopped: why it was down, gone.
    static func forgetAgentsStopped() {
        try? FileManager.default.removeItem(at: run.appending(path: "agents-stopped"))
    }

    /// The coding agents' bridge, as it records itself on a machine (`run/bridge.json`).
    static func agentsChanged(_ endpoint: ServerEndpoint?, pid: Int32?) {
        write(endpoint.map { Record(pid: pid, port: $0.url.port, password: $0.password, version: nil) }, to: "bridge.json")
    }

    private struct Record: Encodable {
        var pid: Int32?
        var port: Int?
        var password: String?
        var version: String?
    }

    /// Written whole, readable by you only; gone for nil.
    private static func write(_ record: Record?, to name: String) {
        let file = run.appending(path: name)
        guard let record else {
            try? FileManager.default.removeItem(at: file)
            return
        }
        do {
            try FileManager.default.createDirectory(at: run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let data = try JSONEncoder().encode(record)
            let staged = run.appending(path: name + ".new")
            FileManager.default.createFile(atPath: staged.path, contents: data, attributes: [.posixPermissions: 0o600])
            _ = try FileManager.default.replaceItemAt(file, withItemAt: staged)
        } catch {
            log.error("Couldn't tell this Mac's box where \(name, privacy: .public) is: \(error.localizedDescription, privacy: .public)")
        }
    }
}

/// What this Mac's box runs, checked before each start: its engine's Bun is the pinned build
/// (opencode's signature, and the binary's own hash, which an older build of opencode's put in its
/// place wouldn't have), and the app's bundle, with the box's script in it, is the one this app was
/// signed as. (Checked, then run: something that swaps a file in between gets in; fenced agents won't
/// reach them.)
nonisolated enum BoxIntegrity {
    static func trouble(engine: URL) -> String? {
        guard EngineInstaller.isPinnedBuild(engine) else {
            return "Kuvo Code’s engine on this Mac isn’t the one it downloaded any more, so it didn’t start. Quit Kuvo Code and open it again to download it."
        }
        guard appIsSealed() else {
            return "Kuvo Code on this Mac was changed since it was installed, so its background service didn’t start. Install Kuvo Code again."
        }
        return nil
    }

    /// Whether the app's bundle on disk, its code and every resource (the box's script), is the very
    /// one this app was launched from: its code directory's hash, which seals every resource too, as
    /// the kernel has it for the running app (not as the bundle on disk says, which a swapped and
    /// signed-again copy would say of itself). An app rebuilt while it runs fails until it's opened again.
    static func appIsSealed() -> Bool {
        guard let requirement = launchRequirement else { return false }
        var bundle: SecStaticCode?
        guard SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, [], &bundle) == errSecSuccess, let bundle else { return false }
        return SecStaticCodeCheckValidity(bundle, [], requirement) == errSecSuccess
    }

    /// `cdhash H"<the running app's>"`, from the kernel (`csops`), made once.
    nonisolated(unsafe) static let launchRequirement: SecRequirement? = {
        var hash = [UInt8](repeating: 0, count: 20)
        guard csops(getpid(), 5 /* CS_OPS_CDHASH */, &hash, hash.count) == 0, hash.contains(where: { $0 != 0 }) else { return nil }
        var requirement: SecRequirement?
        let text = "cdhash H\"" + hash.map { String(format: "%02x", $0) }.joined() + "\""
        return SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess ? requirement : nil
    }()
}

/// The kernel's code-signing calls for a process (`<sys/codesign.h>`): here, its code directory's hash.
@_silgen_name("csops")
nonisolated private func csops(_ pid: pid_t, _ ops: UInt32, _ address: UnsafeMutableRawPointer?, _ size: Int) -> Int32
