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

    let verdict: String
    let use: Use
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

    /// The box's `OWN_BOX_RAN` (`judge.ts`), as it is there (a test holds them the same).
    static let ownBoxFiles = ["setup-card.json", "link.json", "serve.json", "keeper.json"]

    /// What `here` counts as the app's own box having run (`judge.ts`, `OWN_BOX_RAN`, and its engine's
    /// database), for a start that can't ask it: one whose own box ran keeps it, whatever is beside
    /// it, as the box would say. (An update whose engine isn't downloaded yet, say.)
    static func ownBoxRan(appBox: URL, engineData: URL) -> Bool {
        let manager = FileManager.default
        let kept = (try? manager.contentsOfDirectory(atPath: engineData.path)) ?? []
        return ownBoxFiles.contains { manager.fileExists(atPath: appBox.appending(path: "run").appending(path: $0).path) }
            || kept.contains { $0.hasPrefix("opencode") && $0.hasSuffix(".db") }
    }

    /// Whether this start uses its own box (in `appBox`, its engine's data in `engineData`): asked of
    /// the box with `engine` (the engine's Bun, checked first when `checked`) running the app's own
    /// `script`, twice before it gives up. With no box in the machines' folder there's nothing to ask
    /// (the box would say its own). One that can't ask keeps its own box where that ran, else starts
    /// nothing with a box here.
    static func gate(engine: URL?, script: URL?, appBox: URL, engineData: URL, home: URL, checked: Bool) async -> Outcome {
        guard let root, FileManager.default.fileExists(atPath: home.appending(path: root).appending(path: "run").path) else { return .own }
        func cantAsk(_ why: String?) -> Outcome { Self.ownBoxRan(appBox: appBox, engineData: engineData) ? .own : .unknown(why) }
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
