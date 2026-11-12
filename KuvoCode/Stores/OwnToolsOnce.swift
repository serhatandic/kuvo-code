import Foundation
import OpenCodeKit
import os

// COMPAT(agent-tools.own): an older box still running after an update, which doesn't answer Kuvo Code's own tools yet. Goes once 0.8.0 ships (every released box has `agent-tools.own` from then on).
/// Kuvo Code's own tools (`AgentMail.ownTools`) while this Mac's box doesn't answer them yet: after
/// an update, the keeper keeps the older box until the work under way ends, which can take hours,
/// and the older box answers these 400. Then the call goes to this app's own box script, run once
/// as a machine's tool server runs it (`kuvo-link.js box route`), with the box's own folders and
/// environment: the box's logic, never a copy of it. Nothing else changes about the running box.
@MainActor
enum OwnToolsOnce {
    nonisolated private static let log = Logger(subsystem: "run.kuvo.code", category: "agents")

    /// What runs the script: the engine's Bun (`engine`), checked as the box's start checks it
    /// (`engineToRun`); nil while there's none. (A test's: Node.)
    static var runtime: @MainActor () async -> (executable: URL, engine: Bool)? = { await engineToRun().map { ($0, true) } }

    /// When each engine was last found sound, by its path: looked at again after a minute, as the
    /// box's own start does (`BoxProcess.checkedAt`), as reading it takes a second or two.
    private static var soundAt: [String: Date] = [:]

    /// The engine to run it with: this version's, once it's downloaded (its signature, its own hash);
    /// else the one the older box runs with, which this version's start doesn't download over while
    /// that box makes way (its record names its version; its signature, as no hash of it is known
    /// here). Either only from an app that's as it was signed (`BoxIntegrity.appIsSealed`). The one
    /// you named with `KUVO_OPENCODE_BINARY` as it is, as the box's start takes it.
    private static func engineToRun() async -> URL? {
        if let override = AppModel.engineOverride { return URL(filePath: override) }
        let root = AppInfo.supportDirectory.appending(path: "engine")
        var candidates: [(binary: URL, pinned: Bool)] = [(EngineInstaller(root: root).executable, true)]
        struct Record: Decodable { var version: String? }
        if let data = try? Data(contentsOf: BoxProcess.run.appending(path: "engine.json")),
           let version = (try? JSONDecoder().decode(Record.self, from: data))?.version, version != OpenCodeEngine.version,
           !version.isEmpty, !version.hasPrefix("."), version.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) }) {
            candidates.append((root.appending(path: version).appending(path: "opencode"), false))
        }
        for (binary, pinned) in candidates where FileManager.default.isExecutableFile(atPath: binary.path) {
            if let at = soundAt[binary.path], at.timeIntervalSinceNow > -60 { return binary }
            let sound = await Task.detached(operation: {
                (pinned ? EngineInstaller.isPinnedBuild(binary) : EngineInstaller.carriesSignature(binary)) && BoxIntegrity.appIsSealed()
            }).value
            if sound {
                soundAt[binary.path] = .now
                return binary
            }
            log.error("Kuvo Code's own tools didn't run with \(binary.path, privacy: .public): it isn't the engine Kuvo Code downloaded, or the app changed since it was installed.")
        }
        return nil
    }

    /// The tools that change what's kept, which the call stopping doesn't cut off half way.
    static let keptWhole: Set<String> = ["schedule_wake_up", "watch_for_change", "cancel_wake_up", "set_job"]

    /// A call (`body`, as `POST kuvo/agent-tools` takes it) answered by this app's box script, in
    /// your shell's `environment`: what the tool says, or nil where it can't run here.
    static func call(_ name: String, body: Data, environment: [String: String]) async -> (text: String, isError: Bool)? {
        guard let script = BoxProcess.script, let runtime = await runtime() else { return nil }
        // As the box runs: its own environment (`BoxProcess.boxEnvironment`), with the app's
        // wake-up folders and its kuvo-wake, as the keeper starts it (`MacBoxRunner`).
        var shell = environment
        let bin = Bots.command.deletingLastPathComponent().path
        shell["PATH"] = bin + ":" + (shell["PATH"] ?? "/usr/bin:/bin")
        shell["KUVO_BOTS"] = Bots.root.path
        shell["KUVO_WAKES"] = WakeUps.root.path
        try? WakeUps.installCommand()
        shell["KUVO_WAKE_COMMAND"] = WakeUps.command.path
        shell["KUVO_KEYS_ON_HOST"] = "1"
        shell["KUVO_MAC_ATTACHMENTS"] = Attachments.directory.path
        // Never what's only for the tests' box, nor where the host interface answers, the vault's
        // secrets or whether agents use it, from your shell (`BoxProcess.start`, `MacBoxRunner`).
        for name in shell.keys where name.hasPrefix("KUVO_TEST_") { shell[name] = nil }
        for name in ["KUVO_HOST_URL", "KUVO_HOST_PASSWORD", "KUVO_VAULT_AGENTS", "KUVO_HOST_VAULT_SECRET", "KUVO_VAULT_FILE_KEY"] { shell[name] = nil }
        let env = BoxProcess.boxEnvironment(shell, runsEngine: runtime.engine)
        // The box's runtime flags: Bun's settings only from nowhere, and no `.env` (`BoxProcess.start`).
        let flags = runtime.engine ? ["run", "--config=/dev/null", "--no-env-file"] : []
        // The request on its stdin, from a file only you can read, in the box's temporary folder.
        guard let given = try? JSONSerialization.jsonObject(with: body),
              let request = try? JSONSerialization.data(withJSONObject: ["method": "POST", "path": "kuvo/agent-tools", "body": given]) else { return nil }
        let file = BoxProcess.temporary.appending(path: "tool-\(UUID().uuidString).json")
        do {
            try FileManager.default.createDirectory(at: BoxProcess.temporary, withIntermediateDirectories: true)
            guard FileManager.default.createFile(atPath: file.path, contents: request, attributes: [.posixPermissions: 0o600]) else { return nil }
        } catch {
            return nil
        }
        defer { try? FileManager.default.removeItem(at: file) }
        let result: ChildProcess.Result
        do {
            result = try await ChildProcess.run(runtime.executable.path, flags + [script.path, "box", "route"], environment: env,
                                                directory: BoxProcess.home, input: .file(file), errors: .discard,
                                                limit: .seconds(TimeInterval(BrowserTools.executionTimeout) / 1000),
                                                cancellable: !keptWhole.contains(name))
        } catch {
            return nil
        }
        // Its last line: `{status, body}`, the body the route's answer as text.
        struct Answer: Decodable { var status: Int; var body: String }
        struct Said: Decodable { var text: String?; var isError: Bool?; var message: String? }
        guard let line = result.outputText.split(separator: "\n").last,
              let answer = try? JSONDecoder().decode(Answer.self, from: Data(line.utf8)),
              let said = try? JSONDecoder().decode(Said.self, from: Data(answer.body.utf8)) else { return nil }
        guard answer.status == 200, let text = said.text else { return said.message.map { ($0, true) } }
        return (text, said.isError ?? false)
    }
}
