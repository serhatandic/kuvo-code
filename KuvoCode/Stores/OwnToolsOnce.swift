import Foundation
import OpenCodeKit
import os

// COMPAT(agent-tools.own): an older box still running after an update, which doesn't answer Kuvo Code's own tools yet. Goes 3 months after 0.8.0.
/// Kuvo Code's own tools (`AgentMail.ownTools`) while this Mac's box doesn't answer them yet: after
/// an update, the keeper keeps the older box until the work under way ends, which can take hours,
/// and the older box answers these 400. Then the call goes to this app's own box script, run once
/// as a machine's tool server runs it (`kuvo-link.js box route`), with the box's own folders and
/// environment: the box's logic, never a copy of it. Nothing else changes about the running box.
@MainActor
enum OwnToolsOnce {
    nonisolated private static let log = Logger(subsystem: "run.kuvo.code", category: "agents")

    /// What runs the script: the engine's Bun (`engine`), the pinned build this app downloads,
    /// checked as the box's start checks it (`checked`; not one you named with
    /// `KUVO_OPENCODE_BINARY`); nil while there's none. (A test's: Node.)
    static var runtime: @MainActor () async -> (executable: URL, engine: Bool, checked: Bool)? = {
        if let override = AppModel.engineOverride { return (URL(filePath: override), true, false) }
        let installer = EngineInstaller(root: AppInfo.supportDirectory.appending(path: "engine"))
        guard let engine = await Task.detached(operation: { installer.installed() }).value else { return nil }
        return (engine, true, true)
    }

    /// The tools that change what's kept, which the call stopping doesn't cut off half way.
    static let keptWhole: Set<String> = ["schedule_wake_up", "watch_for_change", "cancel_wake_up", "set_job"]

    /// A call (`body`, as `POST kuvo/agent-tools` takes it) answered by this app's box script, in
    /// your shell's `environment`: what the tool says, or nil where it can't run here.
    static func call(_ name: String, body: Data, environment: [String: String]) async -> (text: String, isError: Bool)? {
        guard let script = BoxProcess.script, let runtime = await runtime() else { return nil }
        if runtime.checked {
            let engine = runtime.executable
            if let trouble = await Task.detached(operation: { BoxIntegrity.trouble(engine: engine) }).value {
                log.error("Kuvo Code's own tools couldn't run with this app's box script: \(trouble, privacy: .public)")
                return nil
            }
        }
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
