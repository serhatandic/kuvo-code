import Darwin
import Foundation
import XCTest
@testable import UsageKit

final class ProcessRunnerTests: XCTestCase {
    /// Regression: a child whose output exceeds the ~64KB OS pipe buffer must not deadlock. Before the
    /// pipes were drained concurrently, this blocked the child on write, so it never exited and tripped
    /// the timeout. (`ps -ax -o command=` — used by language-server discovery — is ~240KB.)
    func testLargeStdoutDoesNotDeadlock() throws {
        let runner = SystemProcessRunner()
        let result = try runner.run(
            executable: "/bin/sh",
            arguments: ["-c", "yes 0123456789 | head -c 200000"],
            environment: [:],
            timeout: 10
        )
        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(result.stdout.count, 200_000)
    }

    func testCapturesStdoutAndExitCode() throws {
        let runner = SystemProcessRunner()
        let result = try runner.run(executable: "/bin/echo", arguments: ["hello"], environment: [:], timeout: 5)
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "hello")
    }

    /// A leftover that waits on `go`, then prints more than a pipe holds and says on `told` whether
    /// that worked. It takes no notice of SIGPIPE, so a closed pipe shows as a failed print rather
    /// than a leftover that's gone and a test waiting on it.
    private func leftover(_ index: Int, in directory: URL) throws -> (script: String, go: URL, told: URL) {
        let go = directory.appendingPathComponent("go-\(index)"), told = directory.appendingPathComponent("told-\(index)")
        XCTAssertEqual(mkfifo(go.path, 0o600), 0)
        XCTAssertEqual(mkfifo(told.path, 0o600), 0)
        let script = "(trap '' PIPE; read x < '\(go.path)'; /usr/bin/head -c 200000 /dev/zero; echo \"printed $?\" > '\(told.path)') & echo now"
        return (script, go, told)
    }

    /// Lets the leftover go on, and what it says about its print. Opening each end waits for the
    /// other: the leftover reading `go`, then writing `told`.
    private func release(_ leftover: (script: String, go: URL, told: URL)) throws -> String {
        let writer = try XCTUnwrap(FileHandle(forWritingAtPath: leftover.go.path))
        try writer.write(contentsOf: Data("go\n".utf8))
        try writer.close()
        let reader = try XCTUnwrap(FileHandle(forReadingAtPath: leftover.told.path))
        defer { try? reader.close() }
        return String(decoding: try reader.readToEnd() ?? Data(), as: UTF8.self)
    }

    private func temporaryFolder() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    /// Runs that something they left running keeps read are capped, so they can never use up the
    /// host's descriptors: past the cap the oldest are let go (their pipes closed), and the rest
    /// read on.
    func testLingeringRunsAreCappedOldestFirst() throws {
        let directory = try temporaryFolder()
        defer { try? FileManager.default.removeItem(at: directory) }
        let lingering = LingeringReads(cap: 32, limit: 600, now: { ProcessInfo.processInfo.systemUptime })
        let runner = SystemProcessRunner(afterExit: 0, lingering: lingering)
        var leftovers: [(script: String, go: URL, told: URL)] = []
        for index in 0..<40 {
            let leftover = try leftover(index, in: directory)
            leftovers.append(leftover)
            _ = try runner.run(executable: "/bin/sh", arguments: ["-c", leftover.script], environment: [:], timeout: 10)
        }
        XCTAssertEqual(lingering.count, 32, "never more than the cap")
        for (index, leftover) in leftovers.enumerated() {
            XCTAssertEqual(try release(leftover), index < 8 ? "printed 1\n" : "printed 0\n", "leftover \(index): the 8 oldest let go, the rest read")
        }
    }

    /// One read on longer than its limit is let go; before that it's read.
    func testALingeringRunIsLetGoAfterItsLimit() throws {
        let directory = try temporaryFolder()
        defer { try? FileManager.default.removeItem(at: directory) }
        let clock = TestClock()
        let lingering = LingeringReads(cap: 32, limit: 600, now: { clock.now })
        let runner = SystemProcessRunner(afterExit: 0, lingering: lingering)
        let (early, late) = (try leftover(0, in: directory), try leftover(1, in: directory))
        _ = try runner.run(executable: "/bin/sh", arguments: ["-c", early.script], environment: [:], timeout: 10)
        clock.advance(by: 599)
        lingering.sweep()
        XCTAssertEqual(lingering.count, 1, "not yet")
        XCTAssertEqual(try release(early), "printed 0\n", "read until then")

        _ = try runner.run(executable: "/bin/sh", arguments: ["-c", late.script], environment: [:], timeout: 10)
        clock.advance(by: 600)
        lingering.sweep()
        XCTAssertEqual(lingering.count, 0)
        XCTAssertEqual(try release(late), "printed 1\n", "let go: its pipes closed")
    }

    /// A clock the test moves.
    private final class TestClock: @unchecked Sendable {
        private let lock = NSLock()
        private var seconds: TimeInterval = 1000
        var now: TimeInterval { lock.withLock { seconds } }
        func advance(by interval: TimeInterval) { lock.withLock { seconds += interval } }
    }

    /// Re-run only this test in a fresh process. A broken drain can otherwise hang in drained.wait()
    /// even after the command's own timeout; the outer watchdog must not use SystemProcessRunner.
    func testOutputAndTimeoutInIsolatedProcess() throws {
        let modeKey = "OPENUSAGE_PROCESS_RUNNER_FIXTURE"
        if let directory = ProcessInfo.processInfo.environment[modeKey] {
            // Give only this fixture and its synthetic descendants a killable process group.
            guard getpgrp() == getpid() || setpgid(0, 0) == 0 else {
                XCTFail("Could not isolate the process fixture: errno \(errno)")
                return
            }
            try checkOutputAndTimeout(in: URL(fileURLWithPath: directory))
            try Data("completed".utf8).write(to: URL(fileURLWithPath: directory).appendingPathComponent("completed"))
            return
        }

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let logURL = directory.appendingPathComponent("fixture.log")
        _ = FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let log = try FileHandle(forWritingTo: logURL)
        defer { try? log.close() }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = [
            "xctest", "-XCTest",
            "UsageKitTests.ProcessRunnerTests/testOutputAndTimeoutInIsolatedProcess",
            Bundle(for: ProcessRunnerTests.self).bundleURL.path,
        ]
        var environment = ProcessInfo.processInfo.environment
        environment[modeKey] = directory.path
        // A configuration inherited from Xcode must not override our exact one-test selection.
        environment.removeValue(forKey: "XCTestConfigurationFilePath")
        process.environment = environment
        process.standardOutput = log
        process.standardError = log
        try process.run()

        let deadline = ProcessInfo.processInfo.systemUptime + 30
        while process.isRunning && ProcessInfo.processInfo.systemUptime < deadline {
            Thread.sleep(forTimeInterval: 0.01)
        }
        let timedOut = process.isRunning
        if timedOut {
            let pid = process.processIdentifier
            // Never signal the test suite's group if the fixture failed before setpgid().
            if getpgid(pid) == pid { kill(-pid, SIGKILL) }
            kill(pid, SIGKILL)
        }
        process.waitUntilExit()
        let diagnostic = try String(contentsOf: logURL, encoding: .utf8)
        XCTAssertFalse(timedOut, "ProcessRunner fixture exceeded 30s:\n\(diagnostic)")
        XCTAssertEqual(process.terminationStatus, 0, diagnostic)
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: directory.appendingPathComponent("completed").path),
            "The selected fixture did not complete:\n\(diagnostic)"
        )
    }

    private func checkOutputAndTimeout(in directory: URL) throws {
        let runner = SystemProcessRunner()
        // A command that exits but leaves something running in the background with its output (a
        // daemon a login shell's profile starts) gives what it said, without waiting for that to
        // end. Reading each pipe to its end used to wait the whole 600s, past the watchdog.
        let pidFile = directory.appendingPathComponent("background.pid")
        defer {
            if let pid = (try? String(contentsOf: pidFile, encoding: .utf8)).flatMap({ Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }) {
                kill(pid, SIGKILL)
            }
        }
        let leftover = try runner.run(
            executable: "/bin/sh",
            arguments: ["-c", "/bin/sleep 600 & echo $! > '\(pidFile.path)'; echo said; echo complained >&2"],
            environment: [:],
            timeout: 5
        )
        XCTAssertEqual(leftover.exitCode, 0)
        XCTAssertEqual(leftover.stdout, "said\n")
        XCTAssertEqual(leftover.stderr, "complained\n")

        // What it left running goes on printing after the result is in, more than a pipe holds,
        // and finishes: never killed by a closed pipe, nor stuck on one nobody reads (that waited
        // for ever, past the watchdog). Waited on through named pipes, never a clock.
        let go = directory.appendingPathComponent("go"), told = directory.appendingPathComponent("told")
        XCTAssertEqual(mkfifo(go.path, 0o600), 0)
        XCTAssertEqual(mkfifo(told.path, 0o600), 0)
        // It takes no notice of SIGPIPE here, so a closed pipe shows as a failed print rather than
        // a leftover that's gone and a fixture waiting on it.
        let later = "(trap '' PIPE; read x < '\(go.path)'; /usr/bin/head -c 200000 /dev/zero; echo \"printed $?\" > '\(told.path)') &"
        let talker = try runner.run(executable: "/bin/sh", arguments: ["-c", later + " echo now"], environment: [:], timeout: 5)
        XCTAssertEqual(talker.stdout, "now\n")
        // Opening each end waits for the other: the leftover reading `go`, then writing `told`.
        let writer = try XCTUnwrap(FileHandle(forWritingAtPath: go.path))
        try writer.write(contentsOf: Data("go\n".utf8))
        try writer.close()
        let reader = try XCTUnwrap(FileHandle(forReadingAtPath: told.path))
        defer { try? reader.close() }
        XCTAssertEqual(String(decoding: try reader.readToEnd() ?? Data(), as: UTF8.self), "printed 0\n", "it printed, and finished")

        // Keep stdout open while writing more than a pipe buffer to stderr first. A shared serial
        // drain queue blocks waiting for stdout EOF and cannot start the stderr read.
        let result = try runner.run(
            executable: "/bin/sh",
            arguments: ["-c", "/usr/bin/yes e | /usr/bin/head -c 200000 >&2; /usr/bin/yes o | /usr/bin/head -c 200000; exit 7"],
            environment: [:],
            timeout: 5
        )
        XCTAssertEqual(result.exitCode, 7)
        XCTAssertEqual(result.stdout, String(repeating: "o\n", count: 100_000))
        XCTAssertEqual(result.stderr, String(repeating: "e\n", count: 100_000))

        let start = ProcessInfo.processInfo.systemUptime
        XCTAssertThrowsError(try runner.run(
            executable: "/bin/sleep", arguments: ["5"], environment: [:], timeout: 0.1
        )) { error in
            XCTAssertEqual(error as? ProcessRunnerError, .timedOut(executable: "/bin/sleep", timeout: 0.1))
        }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 3, "Timeout cleanup should return promptly")
    }
}
