import Foundation
import os
import Testing
@testable import OpenCodeKit

/// Running a command and waiting for it (git, ssh, tar, a shell): whatever the command does, the
/// app hears all it says and goes on, rather than waiting for ever on a stuck pipe or a program
/// that never ends.
@Suite(.timeLimit(.minutes(1))) struct ChildProcessTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "opencodekit-child-\(UUID().uuidString)")

    init() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    /// 200 KB of `a` on stdout and of `b` on stderr, stderr first: more than a pipe holds, on each.
    private let talker = "head -c 200000 /dev/zero | tr '\\0' b >&2; head -c 200000 /dev/zero | tr '\\0' a"

    private func pid(in file: URL) -> pid_t? {
        (try? String(contentsOf: file, encoding: .utf8)).flatMap { pid_t($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    /// A named pipe in the test's folder, for a program and the test to wait on each other
    /// without a clock.
    private func fifo(_ name: String) throws -> URL {
        let file = root.appending(path: name)
        guard mkfifo(file.path, 0o600) == 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }
        return file
    }

    /// What's written to `fifo`, once something has and has closed it (waits for that).
    private static func read(_ fifo: URL) async -> String {
        await Task.detached { () -> String in
            guard let handle = FileHandle(forReadingAtPath: fifo.path) else { return "" }
            defer { try? handle.close() }
            return String(decoding: (try? handle.readToEnd()) ?? Data(), as: UTF8.self)
        }.value
    }

    /// Writes `text` to `fifo`, once something reads it (waits for that).
    private static func write(_ text: String, to fifo: URL) async {
        await Task.detached {
            guard let handle = FileHandle(forWritingAtPath: fifo.path) else { return }
            try? handle.write(contentsOf: Data(text.utf8))
            try? handle.close()
        }.value
    }

    /// All of what it says on both, however much, and how it ended.
    @Test func aProgramThatSaysALotOnBothIsHeardInFull() async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let result = try await ChildProcess.run("/bin/sh", ["-c", talker + "; exit 3"])
        #expect(result.output == Data(repeating: UInt8(ascii: "a"), count: 200_000))
        #expect(result.errors == Data(repeating: UInt8(ascii: "b"), count: 200_000))
        #expect(result.status == 3)
        #expect(!result.succeeded && !result.timedOut)
    }

    /// The same for synchronous code (git's, a machine's short commands), and with stderr in
    /// with stdout.
    @Test func blockingHearsItAllToo() throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let result = try ChildProcess.runBlocking("/bin/sh", ["-c", talker], errors: .withOutput)
        #expect(result.output.count == 400_000)
        #expect(result.output.prefix(200_000) == Data(repeating: UInt8(ascii: "b"), count: 200_000))
        #expect(result.errors.isEmpty)
        #expect(result.succeeded)
    }

    /// One that ended but left something running with its output is heard, and the app goes
    /// on, without waiting for that to end.
    @Test func whatALeftoverHoldsDoesntHoldUpTheResult() async throws {
        let pidFiles = [root.appending(path: "background-1.pid"), root.appending(path: "background-2.pid")]
        defer {
            for file in pidFiles { if let pid = pid(in: file) { kill(pid, SIGKILL) } }
            try? FileManager.default.removeItem(at: root)
        }
        func script(_ pidFile: URL) -> String { "/bin/sleep 600 & echo $! > '\(pidFile.path)'; echo said; echo complained >&2" }
        let result = try await ChildProcess.run("/bin/sh", ["-c", script(pidFiles[0])])
        #expect(result.outputText == "said\n")
        #expect(result.errorText == "complained\n")
        #expect(result.succeeded)
        let blocking = try ChildProcess.runBlocking("/bin/sh", ["-c", script(pidFiles[1])], errors: .withOutput)
        #expect(blocking.outputText == "said\ncomplained\n")
    }

    /// A program that never ends, and takes no notice of SIGTERM, is killed at its limit, and
    /// gone: nothing is left running.
    @Test func oneThatNeverEndsIsKilledAtItsLimit() async throws {
        let pidFile = root.appending(path: "child.pid")
        defer {
            if let pid = pid(in: pidFile) { kill(pid, SIGKILL) }
            try? FileManager.default.removeItem(at: root)
        }
        let script = "trap '' TERM; echo $$ > '\(pidFile.path)'; echo started; exec /bin/sleep 600"
        let result = try await ChildProcess.run("/bin/sh", ["-c", script], limit: .seconds(2))
        #expect(result.timedOut)
        #expect(!result.succeeded)
        #expect(result.reason == .uncaughtSignal && result.status == SIGKILL, "SIGTERM did nothing; SIGKILL did")
        #expect(result.outputText == "started\n", "what it said before")
        let child = try #require(pid(in: pidFile))
        #expect(kill(child, 0) != 0, "it's gone")
    }

    /// A run called off once its program is running (the task cancelled: a panel closed, a
    /// reconnect called off) stops the program rather than leaving it running.
    @Test func aCancelledRunStopsItsProgram() async throws {
        let started = try fifo("started")
        nonisolated(unsafe) var child: pid_t?
        defer {
            if let child { kill(child, SIGKILL) }
            try? FileManager.default.removeItem(at: root)
        }
        let task = Task {
            try await ChildProcess.run("/bin/sh", ["-c", "echo $$ > '\(started.path)'; exec /bin/sleep 600"])
        }
        child = pid_t(await Self.read(started).trimmingCharacters(in: .whitespacesAndNewlines))
        let running = try #require(child)
        #expect(kill(running, 0) == 0, "it's running")
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(kill(running, 0) != 0, "it's gone")
    }

    /// What a program leaves running in the background (a hook's `git push &`) runs on after
    /// the result is in, printing as it goes (more than a pipe holds), and finishes: it isn't
    /// killed by a closed pipe the next time it prints, nor stuck on one nobody reads.
    @Test func whatALeftoverSaysLaterDoesntStopIt() async throws {
        let go = try fifo("go"), told = try fifo("told")
        defer { try? FileManager.default.removeItem(at: root) }
        // It takes no notice of SIGPIPE here, so a closed pipe shows as a failed print rather
        // than a leftover that's gone and a test waiting on it.
        let leftover = "(trap '' PIPE; read x < '\(go.path)'; /usr/bin/head -c 200000 /dev/zero; echo \"printed $?\" > '\(told.path)') &"
        let result = try await ChildProcess.run("/bin/sh", ["-c", leftover + " echo now"])
        #expect(result.outputText == "now\n")
        await Self.write("go\n", to: go)
        #expect(await Self.read(told) == "printed 0\n", "it printed, and finished")
    }

    /// A leftover that waits on `go`, then prints more than a pipe holds and says on `told`
    /// whether that worked. It takes no notice of SIGPIPE, so a closed pipe shows as a failed
    /// print rather than a leftover that's gone and a test waiting on it.
    private func leftover(_ index: Int) throws -> (script: String, go: URL, told: URL) {
        let go = try fifo("go-\(index)"), told = try fifo("told-\(index)")
        let script = "(trap '' PIPE; read x < '\(go.path)'; /usr/bin/head -c 200000 /dev/zero; echo \"printed $?\" > '\(told.path)') & echo now"
        return (script, go, told)
    }

    /// Runs that something they left running keeps read are capped across the app, so they can
    /// never use up its descriptors: past the cap the oldest are let go (their pipes closed), and
    /// the rest read on.
    @Test func lingeringRunsAreCappedOldestFirst() async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let lingering = ChildProcess.Lingering(cap: 32, limit: .seconds(600), now: { ContinuousClock.now })
        var leftovers: [(script: String, go: URL, told: URL)] = []
        for index in 0..<40 {
            let leftover = try leftover(index)
            leftovers.append(leftover)
            let result = try await ChildProcess.run("/bin/sh", ["-c", leftover.script], afterExit: .zero, lingering: lingering)
            #expect(result.outputText == "now\n")
        }
        #expect(lingering.count == 32, "never more than the cap")
        for (index, leftover) in leftovers.enumerated() {
            await Self.write("go\n", to: leftover.go)
            let told = await Self.read(leftover.told)
            #expect(told == (index < 8 ? "printed 1\n" : "printed 0\n"), "leftover \(index): the 8 oldest let go, the rest read")
        }
    }

    /// One read on longer than its limit is let go; before that it's read.
    @Test func aLingeringRunIsLetGoAfterItsLimit() async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let clock = TestClock()
        let lingering = ChildProcess.Lingering(cap: 32, limit: .seconds(600), now: { clock.now })
        let (early, late) = (try leftover(0), try leftover(1))
        _ = try await ChildProcess.run("/bin/sh", ["-c", early.script], afterExit: .zero, lingering: lingering)
        clock.advance(by: .seconds(599))
        lingering.sweep()
        #expect(lingering.count == 1, "not yet")
        await Self.write("go\n", to: early.go)
        #expect(await Self.read(early.told) == "printed 0\n", "read until then")

        _ = try await ChildProcess.run("/bin/sh", ["-c", late.script], afterExit: .zero, lingering: lingering)
        clock.advance(by: .seconds(600))
        lingering.sweep()
        #expect(lingering.count == 0)
        await Self.write("go\n", to: late.go)
        #expect(await Self.read(late.told) == "printed 1\n", "let go: its pipes closed")
    }

    /// A clock the test moves.
    private final class TestClock: @unchecked Sendable {
        private let lock = NSLock()
        private var instant = ContinuousClock.now
        var now: ContinuousClock.Instant { lock.withLock { instant } }
        func advance(by duration: Duration) { lock.withLock { instant += duration } }
    }

    /// All it said before it ended is in the result even when what it left running holds its
    /// output and its end of it is given up on at once: the cutoff waits for the reading to
    /// catch up.
    @Test func whatItSaidBeforeTheCutoffIsKept() async throws {
        let pidFile = root.appending(path: "background.pid")
        defer {
            if let pid = pid(in: pidFile) { kill(pid, SIGKILL) }
            try? FileManager.default.removeItem(at: root)
        }
        let script = "/bin/sleep 600 & echo $! > '\(pidFile.path)'; head -c 1000000 /dev/zero | tr '\\0' a"
        let result = try await ChildProcess.run("/bin/sh", ["-c", script], afterExit: .zero)
        #expect(result.output.count == 1_000_000)
    }

    /// One that can't start says why.
    @Test func oneThatCantStartThrows() async {
        defer { try? FileManager.default.removeItem(at: root) }
        await #expect(throws: (any Error).self) { try await ChildProcess.run(root.appending(path: "missing").path) }
    }

    /// Input from a file, and output into one, as it comes.
    @Test func filesInAndOut() async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appending(path: "in"), target = root.appending(path: "out")
        try Data(repeating: 7, count: 300_000).write(to: source)
        FileManager.default.createFile(atPath: target.path, contents: nil)
        let result = try await ChildProcess.run("/bin/cat", input: .file(source), output: .file(target))
        #expect(result.succeeded)
        #expect(try Data(contentsOf: target) == Data(repeating: 7, count: 300_000))
    }

    /// A file sent to a program (the engine's package to a machine, over SSH) says how far into it
    /// the program has read, onward only, all of it by the end.
    @Test func aFileSentToAProgramSaysHowFarItsBeenRead() async throws {
        let file = root.appending(path: "package")
        try Data(repeating: 7, count: 3_000_000).write(to: file)
        let heard = OSAllocatedUnfairLock(initialState: [Int64]())
        let result = try await ChildProcess.run("/bin/sh", ["-c", "cat >/dev/null"], input: .reported(file, read: { read in heard.withLock { $0.append(read) } }))
        #expect(result.succeeded)
        let reads = heard.withLock { $0 }
        #expect(reads.last == 3_000_000)
        #expect(reads == reads.sorted())
    }

}
