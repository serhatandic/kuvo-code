import Foundation
import OpenCodeKit
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "here")

/// Kuvo Code opening on a Mac where a box may already run (PROTOCOL.md, "Your setup", "Already in a
/// setup?"): what the box's own CLI says (`kuvo-link.js here`), before the app or its keeper starts
/// a box of its own or registers one. A Mac someone set up as a machine (`~/.kuvo-code`, with its
/// keys, its sessions' paths and its start at boot) keeps that one box: the app attaches to it in
/// place, never making a second. The box decides (told where the app's own box and its engine's data
/// are); the app does what it says.
nonisolated struct Here: Decodable, Equatable, Sendable {
    enum Use: String, Decodable, Sendable { case own, attach }

    /// A box found here, as the box says it.
    struct Box: Decodable, Equatable, Sendable {
        struct Primary: Decodable, Equatable, Sendable {
            let key: String
            let name: String
            /// When it was last heard from (ms), as that box counts it.
            let heard: Double?
        }
        let folder: String
        let verdict: String
        let key: String?
        let name: String
        let setup: String?
        let role: String?
        let primary: Primary?
    }

    /// Whether the box in the machines' folder runs: its keeper running now, stopped (it has its way
    /// to start), or gone (its Mac removed it: no box any more, which the app doesn't attach to).
    enum Runs: String, Decodable, Sendable { case running, stopped, gone }

    let verdict: String
    let use: Use
    let runs: Runs?
    /// The box in the machines' folder, if there is one.
    let box: Box?

    /// What a start does: its own box, as always; attach to the one here; or neither, as it couldn't
    /// tell with a box here (starting its own then could make a second for good), with why where
    /// there's something to do about it (the engine to download again).
    enum Outcome: Equatable, Sendable {
        case own
        case attach(Here)
        case unknown(String?)
    }

    /// The machines' folder `here` looks at: the real app's `~/.kuvo-code`, or a copy's own folder
    /// (`KUVO_DEMO_MACHINE_ROOT`); a demo, test or measurement copy without one of its own never
    /// looks at the real one. The tests' own home is theirs.
    static var root: String? { machinesRoot(bundleID: AppInfo.bundleID, hostingTests: AppInfo.isHostingTests, given: RemoteEngineInstaller.root) }

    static func machinesRoot(bundleID: String, hostingTests: Bool, given: String) -> String? {
        hostingTests || bundleID.lowercased() == AppInfo.realBundleID || given != ".kuvo-code" ? given : nil
    }

    /// What in the app's own box's folder says a box ran there: what the box writes itself (its card,
    /// its link.json, which stay when it stops) and what the app or its keeper writes as they start
    /// one. The box's `OWN_BOX_RAN` (`judge.ts`; a test holds the two the same).
    static let ownBoxFiles = ["setup-card.json", "link.json", "serve.json", "keeper.json"]

    /// Whether this app's own box ran here, by its own folder alone (the engine's database, outside
    /// it, is the box's to weigh). For a start that can't ask the box: one whose own box ran keeps it
    /// (an update whose engine isn't downloaded yet, say).
    static func ownBoxRan(appBox: URL) -> Bool {
        ownBoxFiles.contains { FileManager.default.fileExists(atPath: appBox.appending(path: "run").appending(path: $0).path) }
    }

    /// Whether this start uses its own box (in `appBox`, its engine's data in `engineData`): asked of
    /// the box with `engine` (the engine's Bun, checked first when `checked`) running the app's own
    /// `script`, twice before it gives up. With nothing in the machines' folder's `run`, where `here`
    /// finds its box, there's nothing to ask (it says its own: asked, it would cost every launch a
    /// second or so). One that can't ask keeps its own box where that ran; else it starts nothing.
    static func gate(engine: URL?, script: URL?, appBox: URL, engineData: URL, home: URL, checked: Bool) async -> Outcome {
        guard let root, FileManager.default.fileExists(atPath: home.appending(path: root).appending(path: "run").path) else { return .own }
        func cantAsk(_ why: String?) -> Outcome { Self.ownBoxRan(appBox: appBox) ? .own : .unknown(why) }
        guard let engine, let script else {
            log.error("here wasn't asked: no engine yet")
            return cantAsk(nil)
        }
        if checked, let trouble = await Task.detached(operation: { BoxIntegrity.trouble(engine: engine) }).value {
            log.error("here wasn't asked: \(trouble, privacy: .public)")
            return cantAsk(trouble)
        }
        for _ in 0..<2 {
            if let here = await ask(engine: engine, script: script, appBox: appBox, engineData: engineData, home: home, root: root) {
                return here.use == .attach ? .attach(here) : .own
            }
        }
        return cantAsk(nil)
    }

    /// Tells the box in the machines' folder that the app attached to it in place (`POST
    /// kuvo/setup/attached`): its card says Kuvo Code is on this Mac from then on, so a Mac adding it
    /// never has it join another setup unasked. By that box's own CLI and engine (`box route`, as a
    /// Mac reaches a machine's box over SSH, here without SSH), never the app's: what it writes is
    /// that box's, in its version.
    static func sayAttached(home: URL) async {
        guard let root else { return }
        let box = home.appending(path: root)
        // (Said once: it's kept.)
        guard !FileManager.default.fileExists(atPath: box.appending(path: "run/app-attached.json").path) else { return }
        let command = RemoteEngineInstaller.$scopedRoot.withValue(root) {
            RemoteEngineInstaller.script(#"KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$E" --config=/dev/null --no-env-file "$K/bin/kuvo-link.js" box route"#)
        }
        let env = ["HOME": home.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        let request = Data(#"{"method":"POST","path":"kuvo/setup/attached"}"#.utf8)
        let input = FileManager.default.temporaryDirectory.appending(path: "kuvo-attached-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: input) }
        do {
            try request.write(to: input)
            let result = try await ChildProcess.run("/bin/sh", ["-c", command], environment: env, directory: box, input: .file(input), limit: .seconds(20))
            if !result.succeeded || !result.outputText.contains(#""status":200"#) {
                log.error("The box here wasn't told the app attached: \(result.outputText.suffix(200), privacy: .public) \(result.errorText.suffix(200), privacy: .public)")
            }
        } catch {
            log.error("The box here wasn't told the app attached: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// How the box in the machines' folder is started again, each tried in turn: by launchd, through
    /// the launch agent its Mac put in place (the real `~/.kuvo-code`'s), as at login, so it runs as
    /// its own and never under Kuvo Code's privacy permissions: started where launchd has it loaded,
    /// else loaded (its agent starts it as it loads, as at login). Never by the app then. With no
    /// agent, by its own `bin/kuvo-start`.
    /// (`real`: the account's own home, which launchd's agents are of: never a test's.)
    static func startCommands(home: URL, root: String, user: uid_t = getuid(), real: Bool? = nil) -> [(path: String, arguments: [String])] {
        let real = real ?? (!AppInfo.isHostingTests && home.standardizedFileURL == FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL)
        let agent = home.appending(path: "Library/LaunchAgents/\(RemoteServer.launchAgent).plist")
        if real, root == ".kuvo-code", FileManager.default.fileExists(atPath: agent.path) {
            return [("/bin/launchctl", ["kickstart", "gui/\(user)/\(RemoteServer.launchAgent)"]),
                    ("/bin/launchctl", ["bootstrap", "gui/\(user)", agent.path])]
        }
        return [("/bin/sh", [home.appending(path: root).appending(path: "bin/kuvo-start").path])]
    }

    /// Whether the box here is started by launchd, through its login item (`startCommands`).
    static func startsByLaunchd(home: URL) -> Bool {
        root.map { startCommands(home: home, root: $0).first?.path == "/bin/launchctl" } ?? false
    }

    /// The box in the machines' folder, stopped, started again in place (`startCommands`): what
    /// `here` says then, once it runs or after a few seconds.
    static func started(engine: URL, script: URL, appBox: URL, engineData: URL, home: URL) async -> Here? {
        guard let root else { return nil }
        let box = home.appending(path: root)
        let env = ["HOME": home.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": FileManager.default.temporaryDirectory.path]
        for command in startCommands(home: home, root: root) {
            do {
                let result = try await ChildProcess.run(command.path, command.arguments, environment: env, directory: box, limit: .seconds(20))
                if result.succeeded { break }
                log.error("The box here didn't start (\(command.arguments.first ?? command.path, privacy: .public)): \(result.errorText.suffix(200), privacy: .public)")
            } catch {
                log.error("The box here didn't start: \(error.localizedDescription, privacy: .public)")
            }
        }
        var here: Here?
        for attempt in 0..<6 {
            if attempt > 0 { try? await Task.sleep(for: .milliseconds(500)) }
            here = await ask(engine: engine, script: script, appBox: appBox, engineData: engineData, home: home, root: root, timeout: 5)
            if here?.runs == .running { break }
        }
        return here
    }

    /// What the box CLI says here: the app's own script, run as the box runs it (`engine`, the
    /// engine's Bun), with `KUVO_HOME` the app's own box's folder and `KUVO_ENGINE_DATA` its engine's
    /// data, which it only reads. Nil when it can't say (it didn't run, or said something else).
    static func ask(engine: URL, script: URL, appBox: URL, engineData: URL, home: URL, root: String, timeout: TimeInterval = 20) async -> Here? {
        let env = ["HOME": home.path, "PATH": "/usr/bin:/bin", "BUN_BE_BUN": "1", "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0", "KUVO_HOME": appBox.path,
                   "KUVO_ENGINE_DATA": engineData.path, "TMPDIR": FileManager.default.temporaryDirectory.path]
        // (From the home folder: never the app's box's, which mustn't be made by asking.)
        let arguments = ["run", "--config=/dev/null", "--no-env-file", script.path, "here", root]
        let result: ChildProcess.Result
        do {
            result = try await ChildProcess.run(engine.path, arguments, environment: env, directory: home, limit: .seconds(timeout))
        } catch {
            log.error("kuvo-link.js here didn't run: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        let errors = String(decoding: result.errors, as: UTF8.self).suffix(400)
        guard !result.timedOut, result.reason == .exit, result.status == 0 else {
            log.error("kuvo-link.js here didn't answer (status \(result.status), timed out \(result.timedOut)): \(errors, privacy: .public)")
            return nil
        }
        let line = String(decoding: result.output, as: UTF8.self).split(separator: "\n").last.map(String.init) ?? ""
        do {
            return try JSONDecoder().decode(Here.self, from: Data(line.utf8))
        } catch {
            // (Its answer has only public keys and names in it.)
            log.error("kuvo-link.js here said \(line, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }
}
