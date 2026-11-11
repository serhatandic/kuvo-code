import Foundation
import OpenCodeKit
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "here")

/// Kuvo Code opening on a Mac where a box may already run (PROTOCOL.md, "Your setup", "Already in a
/// setup?"): what the box's own CLI says (`kuvo-link.js here`), before the app or its keeper starts
/// a box of its own or registers one. A Mac someone set up as a machine (`~/.kuvo-code`, with its
/// keys, its sessions' paths and its start at boot) keeps that one box: the app attaches to it in
/// place, never making a second. The box decides; the app gives it what only the app knows (whether
/// its own engine kept your sessions) and does what it says.
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
    /// tell with a box here (starting its own then could make a second for good).
    enum Outcome: Equatable, Sendable {
        case own
        case attach(Here)
        case unknown
    }

    /// The machines' folder `here` looks at: the real app's `~/.kuvo-code`, or a copy's own folder
    /// (`KUVO_DEMO_MACHINE_ROOT`); a demo, test or measurement copy without one of its own never
    /// looks at the real one. The tests' own home is theirs.
    static var root: String? {
        let root = RemoteEngineInstaller.root
        return AppInfo.isHostingTests || AppInfo.bundleID == "run.kuvo.code" || root != ".kuvo-code" ? root : nil
    }

    /// Whether this app's own engine kept your sessions here (its database): an app from before its
    /// box had a folder, or one that quit cleanly, leaves nothing else to say so.
    static var ownData: Bool {
        let folder = AppModel.engineFolders.dataDirectory.appending(path: "opencode")
        let files = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        return files.contains { $0.hasPrefix("opencode") && $0.hasSuffix(".db") }
    }

    /// Whether this start uses its own box (in `appBox`): asked of the box with `engine` (the engine's
    /// Bun, checked first when `checked`) running the app's own `script`, twice before it gives up. With
    /// no box in the machines' folder, a start that can't ask goes on as it always has.
    static func gate(engine: URL?, script: URL?, appBox: URL, home: URL, checked: Bool) async -> Outcome {
        guard let root else { return .own }
        let there = FileManager.default.fileExists(atPath: home.appending(path: root).appending(path: "run").path)
        guard let engine, let script else { return there ? .unknown : .own }
        if checked, let trouble = await Task.detached(operation: { BoxIntegrity.trouble(engine: engine) }).value {
            log.error("here wasn't asked: \(trouble, privacy: .public)")
            return there ? .unknown : .own
        }
        let ownData = Self.ownData
        for _ in 0..<2 {
            if let here = await ask(engine: engine, script: script, appBox: appBox, home: home, root: root, ownData: ownData) {
                return here.use == .attach ? .attach(here) : .own
            }
        }
        return there ? .unknown : .own
    }

    /// What the box CLI says here: the app's own script, run as the box runs it (`engine`, the
    /// engine's Bun), with `KUVO_HOME` the app's own box's folder, which it only reads. Nil when it
    /// can't say (it didn't run, or said something else).
    static func ask(engine: URL, script: URL, appBox: URL, home: URL, root: String, ownData: Bool, timeout: TimeInterval = 20) async -> Here? {
        let env = ["HOME": home.path, "PATH": "/usr/bin:/bin", "BUN_BE_BUN": "1", "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0", "KUVO_HOME": appBox.path,
                   "TMPDIR": FileManager.default.temporaryDirectory.path]
        // (From the home folder: never the app's box's, which mustn't be made by asking.)
        let arguments = ["run", "--config=/dev/null", "--no-env-file", script.path, "here", root] + (ownData ? ["--own-data"] : [])
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
