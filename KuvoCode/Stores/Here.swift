import Foundation
import OpenCodeKit
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "here")

/// Kuvo Code opening on a Mac where a box may already run (PROTOCOL.md, "Your setup", "Already in a
/// setup?"): what the box's own CLI says (`kuvo-link.js here`), before the app starts a box of its
/// own or registers its keeper. A Mac someone set up as a machine (`~/.kuvo-code`, with its keys,
/// its sessions' paths and its start at boot) keeps that one box: the app attaches to it in place,
/// never making a second. The box decides; the app only does what it says.
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

    /// What the box CLI says here: the app's own script, run as the box runs it (`engine`, the
    /// engine's Bun), with `KUVO_HOME` the app's own box's folder, which it only reads. Nil when it
    /// can't say (it didn't run, or said something else): then the app goes on as it always has.
    static func ask(engine: URL, script: URL, appBox: URL, home: URL, root: String, timeout: TimeInterval = 10) async -> Here? {
        var env = ["HOME": home.path, "PATH": "/usr/bin:/bin", "BUN_BE_BUN": "1", "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0", "KUVO_HOME": appBox.path]
        env["TMPDIR"] = FileManager.default.temporaryDirectory.path
        // (From the home folder: never the app's box's, which mustn't be made by asking.)
        guard let result = try? await ChildProcess.run(engine.path, ["run", "--config=/dev/null", "--no-env-file", script.path, "here", root],
                                                       environment: env, directory: home, errors: .discard, limit: .seconds(timeout)),
              !result.timedOut, result.reason == .exit, result.status == 0 else {
            log.error("kuvo-link.js here didn't answer")
            return nil
        }
        let line = String(decoding: result.output, as: UTF8.self).split(separator: "\n").last.map(String.init) ?? ""
        return try? JSONDecoder().decode(Here.self, from: Data(line.utf8))
    }
}
