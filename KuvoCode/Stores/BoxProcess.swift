import Foundation
import KuvoLink
import OpenCodeKit
import os

private let log = Logger(subsystem: "run.kuvo.code", category: "box")

/// This Mac's box: the same box a machine runs (`kuvo-link.js`), here as `kuvo-link.js serve`,
/// which answers its routes to this app on 127.0.0.1 (PROTOCOL.md, "This Mac's box"). Started with
/// the engine's Bun, as the agents bridge is, it keeps what it has in `box` in the app's own
/// folder and goes when the app does. It finds the engine and the agents bridge as a machine's
/// box does, by their records in `box/run`, which this writes as they start and stop.
///
/// Areas move onto it one at a time: PhoneLink forwards a moved area's routes here
/// (`PhoneLink.boxRoutes`), and the app's own stores reach them through `BoxClient`.
@MainActor @Observable
final class BoxProcess {
    /// Where the box keeps what it has: its `KUVO_HOME`.
    static var home: URL { AppInfo.supportDirectory.appending(path: "box") }
    static var run: URL { home.appending(path: "run") }
    /// What integrations' servers keep, which the engine is given too (`KUVO_INTEGRATIONS`).
    static var integrations: URL { AppInfo.supportDirectory.appending(path: "integrations") }

    /// Where it's reached while it runs.
    private(set) var endpoint: ServerEndpoint?
    /// Why it isn't running, when it stopped and didn't start again.
    private(set) var failure: String?

    @ObservationIgnored private var server: ServerProcess?
    /// What it was started with, to start it again the same way.
    @ObservationIgnored private var runtime: (executable: URL, environment: [String: String], arguments: (URL) -> [String])?

    /// What it was last started with, beside what it sets itself.
    var environment: [String: String]? { runtime?.environment }
    @ObservationIgnored private var restarts: [Date] = []
    @ObservationIgnored private var isStarting = false
    /// Up, the first time or again (late, after Try Again, or after it stopped by itself).
    @ObservationIgnored var onStarted: () -> Void = {}
    /// It was given what it starts with (the engine's start got that far): Try Again can start it.
    var canStartAgain: Bool { runtime != nil }

    /// The box's script: KUVO_BOX_SCRIPT's (a checkout's `kuvo-link.js`, or its source,
    /// `Packages/Box/src/link/main.ts`) in a debug build, else the app's own.
    private static var script: URL? {
        #if DEBUG
        if let path = ProcessInfo.processInfo.environment["KUVO_BOX_SCRIPT"] { return URL(filePath: path) }
        #endif
        return Bridge.scriptURL
    }

    /// `content` (what the engine starts with in `OPENCODE_CONFIG_CONTENT`) with what some providers
    /// need from the engine on top, as this Mac's box last learned it from its engine, or Kuvo Code
    /// knows them before it has (`kuvo-link.js engine-config`, as a machine's start adds it); as it
    /// is when that can't be run.
    static func engineConfig(engine: URL, content: String?, environment: [String: String]) async -> String? {
        guard let script else { return content }
        var env = environment
        env["BUN_BE_BUN"] = "1"
        env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"] = "0"
        env["KUVO_HOME"] = home.path
        env["OPENCODE_CONFIG_CONTENT"] = content
        let given = env
        return await Task.detached {
            let process = Process()
            process.executableURL = engine
            process.arguments = ["run", script.path, "engine-config"]
            process.environment = given
            let output = Pipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            process.standardInput = FileHandle.nullDevice
            do { try process.run() } catch { return content }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0, let text = String(data: data, encoding: .utf8), text.hasPrefix("{"), text.hasSuffix("}") else { return content }
            return text
        }.value
    }

    /// Starts it with the engine's Bun, once: it goes on through the engine's restarts.
    func start(engine: URL, environment: [String: String]) async {
        var env = environment
        // GitHub's stand-in, and a box kept from your other computers, are for the tests' box only
        // (`TestBox`), never the app's.
        env["KUVO_TEST_GITHUB"] = nil
        env["KUVO_TEST_NO_PEERS"] = nil
        env["BUN_BE_BUN"] = "1"
        // Bun would otherwise keep a copy of the script, compiled, in ~/Library/Caches/bun.
        env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"] = "0"
        await launch(engine, environment: env) { ["run", $0.path, "serve"] }
    }

    #if DEBUG
    /// For tests: started with Node instead, which runs the same script.
    func start(node: URL, environment: [String: String] = [:]) async {
        await launch(node, environment: environment) { [$0.path, "serve"] }
    }
    #endif

    private func launch(_ runtime: URL, environment: [String: String], arguments: @escaping (URL) -> [String]) async {
        guard server == nil, !isStarting else { return }
        isStarting = true
        defer { isStarting = false }
        self.runtime = (runtime, environment, arguments)
        guard let script = Self.script else {
            failure = "Kuvo Code’s background service is missing from the app. Install Kuvo Code again."
            return
        }
        var env = environment
        env["KUVO_HOME"] = Self.home.path
        // A Mac's box: its bots are this Mac's own, made with the kit the app gives it.
        env["KUVO_BOX"] = "mac"
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
            let server = try await ServerProcess.start(
                executable: runtime,
                arguments: arguments(script),
                environment: env,
                directory: Self.home,
                // Up in well under a second: the engine's start waits for it (its settings first),
                // so one that's held up (macOS asking about a folder its script is in) doesn't
                // hold the engine up for long. It's tried again once the engine is up.
                timeout: .seconds(15),
                onExit: { [weak self] status in Task { @MainActor in self?.exited(status: status) } }
            )
            self.server = server
            if let status = server.exitStatus {
                exited(status: status)
                return
            }
            endpoint = server.endpoint
            PhoneLink.box.withLock { $0 = server.endpoint }
            failure = nil
            onStarted()
        } catch {
            log.error("This Mac's box didn't start: \(error.localizedDescription, privacy: .public)")
            failure = error.localizedDescription
        }
    }

    /// Started again after it stopped for good (Try Again where it shows).
    func startAgain() async {
        guard server == nil, let runtime else { return }
        restarts.removeAll()
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
        server?.stop()
        server = nil
        endpoint = nil
        PhoneLink.box.withLock { $0 = nil }
    }

    /// It stopped by itself: started again, unless it keeps stopping.
    private func exited(status: Int32) {
        guard server != nil else { return }
        let output = server?.recentOutput.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        log.error("This Mac's box stopped (\(status)): \(output, privacy: .public)")
        stop()
        restarts.removeAll { $0 < .now.addingTimeInterval(-300) }
        guard restarts.count < 3, let runtime else {
            failure = "Kuvo Code’s background service stopped unexpectedly (exit code \(status)).\(output.isEmpty ? "" : "\n\n" + String(output.suffix(600)))"
            return
        }
        restarts.append(.now)
        Task { await launch(runtime.executable, environment: runtime.environment, arguments: runtime.arguments) }
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
        try? FileManager.default.removeItem(at: run.appending(path: "engine-stopped"))
    }

    /// The engine stopped and isn't started again until you say (`run/engine-stopped`): why, in
    /// the words the window shows (their first paragraph), for the box to tell whoever asks it.
    static func engineGaveUp(_ reason: String) {
        let why = reason.components(separatedBy: "\n\n").first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        do {
            try FileManager.default.createDirectory(at: run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try Data(why.utf8).write(to: run.appending(path: "engine-stopped"), options: .atomic)
        } catch {
            log.error("Couldn't tell this Mac's box its engine stopped: \(error.localizedDescription, privacy: .public)")
        }
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
