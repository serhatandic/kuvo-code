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

    /// A profile that says something as the shell starts (a greeting, a system summary) doesn't
    /// take the first of its settings with it.
    @Test func whatYourProfileSaysIsntTakenForASetting() async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appending(path: "chatty")
        try "#!/bin/sh\nprintf 'Welcome to your Mac\\n'\nexec /usr/bin/env -i AAA_FIRST=one PATH=/usr/bin:/bin /bin/sh -c \"$2\"\n".write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        let environment = await ShellEnvironment.run(shell: file.path, flags: "-lc", timeout: .seconds(30))
        #expect(environment?["AAA_FIRST"] == "one")
        #expect(environment?.keys.contains { $0.contains("Welcome") } == false)
    }

    @Test func whatYourShellSetsIsRead() async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let environment = await ShellEnvironment.run(shell: try shell("export KUVO_FROM_PROFILE=yes"), flags: "-lc", timeout: .seconds(30))
        #expect(environment?["KUVO_FROM_PROFILE"] == "yes")
    }

    private func pid(in file: URL) -> pid_t? {
        (try? String(contentsOf: file, encoding: .utf8)).flatMap { pid_t($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    /// One whose profile leaves something running in the background with its output (a daemon it
    /// starts) still gives its environment once it has finished: reading its output to the end
    /// used to wait for that to stop too, and the engine's start with it.
    @Test func somethingYourProfileLeavesRunningDoesntHoldUpTheStart() async throws {
        let pidFile = root.appending(path: "background.pid")
        defer {
            if let pid = pid(in: pidFile) { kill(pid, SIGKILL) }
            try? FileManager.default.removeItem(at: root)
        }
        let profile = "export KUVO_FROM_PROFILE=yes; /bin/sleep 600 & echo $! > '\(pidFile.path)'"
        let environment = await ShellEnvironment.run(shell: try shell(profile), flags: "-lc", timeout: .seconds(30))
        #expect(environment?["KUVO_FROM_PROFILE"] == "yes")
    }

    /// An interactive profile that takes a while (nvm, pyenv) still gives what it sets, rather than
    /// the login shell's without it.
    @Test func aSlowInteractiveProfileIsWaitedFor() async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        // An interactive shell takes no notice of SIGTERM.
        let profile = "case \"$1\" in -ilc) trap '' TERM; /bin/sleep 6; export KUVO_FROM_ZSHRC=yes;; esac"
        let environment = await ShellEnvironment.load(shell: try shell(profile), fallback: [:])
        #expect(environment["KUVO_FROM_ZSHRC"] == "yes")
    }

    /// One given up on is stopped for good, interactive or not: it doesn't run on in the background.
    @Test func oneGivenUpOnIsStopped() async throws {
        let pidFile = root.appending(path: "shell.pid")
        defer {
            if let pid = pid(in: pidFile) { kill(pid, SIGKILL) }
            try? FileManager.default.removeItem(at: root)
        }
        let profile = "trap '' TERM; echo $$ > '\(pidFile.path)'; exec /bin/sleep 600"
        let environment = await ShellEnvironment.run(shell: try shell(profile), flags: "-ilc", timeout: .seconds(2))
        #expect(environment == nil)
        let shell = try #require(pid(in: pidFile))
        #expect(kill(shell, 0) != 0, "it's gone")
    }
}
