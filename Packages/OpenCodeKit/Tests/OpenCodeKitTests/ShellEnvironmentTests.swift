import Foundation
import Testing
@testable import OpenCodeKit

/// Your login shell's environment, read as the engine starts (its PATH, for the agent's commands):
/// a shell that doesn't finish as expected never keeps the engine from starting.
@Suite(.timeLimit(.minutes(1))) struct ShellEnvironmentTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "opencodekit-shell-\(UUID().uuidString)")

    init() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    /// A shell that runs `script` before what it's asked to run.
    private func shell(_ script: String) throws -> String {
        let file = root.appending(path: "shell")
        try "#!/bin/sh\n\(script)\nexec /bin/sh -c \"$2\"\n".write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        return file.path
    }

    @Test func whatYourShellSetsIsRead() async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let environment = await ShellEnvironment.run(shell: try shell("export KUVO_FROM_PROFILE=yes"), flags: "-lc", timeout: .seconds(30))
        #expect(environment?["KUVO_FROM_PROFILE"] == "yes")
    }

    /// One whose profile leaves something running in the background with its output (a daemon it
    /// starts) is given up on when its time is up: reading its output to the end used to wait for
    /// that to stop too, and the engine's start with it.
    @Test func somethingYourProfileLeavesRunningDoesntHoldUpTheStart() async throws {
        let pidFile = root.appending(path: "background.pid")
        defer {
            if let pid = (try? String(contentsOf: pidFile, encoding: .utf8)).flatMap({ pid_t($0.trimmingCharacters(in: .whitespacesAndNewlines)) }) {
                kill(pid, SIGKILL)
            }
            try? FileManager.default.removeItem(at: root)
        }
        let environment = await ShellEnvironment.run(shell: try shell("/bin/sleep 600 & echo $! > '\(pidFile.path)'"), flags: "-lc",
                                                     timeout: .milliseconds(300))
        #expect(environment == nil, "the app goes on with its own")
    }
}
