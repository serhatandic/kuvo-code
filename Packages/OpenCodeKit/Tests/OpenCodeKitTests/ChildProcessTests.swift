import Foundation
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

    /// Before: the old way, waiting for the program to end and only then reading what it said
    /// (`waitUntilExit`, then `readDataToEndOfFile`), can never finish with a program that says
    /// more than a pipe holds. Shown without waiting on a clock: once its pipe is full and it's
    /// still running with more to say, it can't go on until something reads, and the old way
    /// reads only after it has ended.
    @Test func theOldWayCantFinishWithAProgramThatSaysALot() async throws {
        defer { try? FileManager.default.removeItem(at: root) }
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", "head -c 1000000 /dev/zero"]
        let pipe = Pipe()
        process.standardOutput = pipe
        let reading = pipe.fileHandleForReading.fileDescriptor
        let ended = Arrival<Void>()
        let oldWay = Thread {
            process.waitUntilExit()
            _ = pipe.fileHandleForReading.readDataToEndOfFile()
            ended.deliver(())
        }
        try process.run()
        oldWay.start()
        await Self.untilFull(reading)
        #expect(process.isRunning, "blocked on its full pipe, with 1 MB to say")
        #expect(!ended.hasArrived, "the old way still waits for it to end")
        // Let it go, so nothing's left running.
        kill(process.processIdentifier, SIGKILL)
        _ = await ended.wait()
    }

    /// Before: reading to the end of what it said can't finish when it has ended but left
    /// something running in the background that holds its output (a daemon a hook starts): the
    /// pipe has no more to read, and isn't at its end either.
    @Test func theOldWayCantFinishWhenSomethingLeftRunningHoldsTheOutput() async throws {
        let pidFile = root.appending(path: "background.pid")
        defer {
            if let pid = pid(in: pidFile) { kill(pid, SIGKILL) }
            try? FileManager.default.removeItem(at: root)
        }
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", "/bin/sleep 600 & echo $! > '\(pidFile.path)'; echo said"]
        let pipe = Pipe()
        process.standardOutput = pipe
        let exited = Arrival<Void>()
        process.terminationHandler = { _ in exited.deliver(()) }
        try process.run()
        _ = await exited.wait()
        let reading = pipe.fileHandleForReading.fileDescriptor
        _ = fcntl(reading, F_SETFL, fcntl(reading, F_GETFL) | O_NONBLOCK)
        var buffer = [UInt8](repeating: 0, count: 64)
        #expect(Darwin.read(reading, &buffer, buffer.count) == 5, "what it said")
        #expect(Darwin.read(reading, &buffer, buffer.count) == -1 && errno == EAGAIN,
                "not at its end: `readDataToEndOfFile` would wait for the background job to end")
    }

    /// After: all of what it says on both, however much, and how it ended.
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

    /// After: one that ended but left something running with its output is heard, and the app
    /// goes on, without waiting for that to end.
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

    /// A run called off (the task cancelled: a panel closed, a reconnect called off) stops its
    /// program rather than leaving it running.
    @Test func aCancelledRunStopsItsProgram() async throws {
        let pidFile = root.appending(path: "child.pid")
        defer {
            if let pid = pid(in: pidFile) { kill(pid, SIGKILL) }
            try? FileManager.default.removeItem(at: root)
        }
        let task = Task {
            try await ChildProcess.run("/bin/sh", ["-c", "echo $$ > '\(pidFile.path)'; exec /bin/sleep 600"])
        }
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
        if let child = pid(in: pidFile) { #expect(kill(child, 0) != 0, "it's gone") }
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

    /// Waits until the pipe that `descriptor` reads holds all it can: woken by each write, never by
    /// a clock.
    private static func untilFull(_ descriptor: Int32) async {
        await Task.detached {
            let queue = kqueue()
            defer { close(queue) }
            var change = kevent(ident: UInt(descriptor), filter: Int16(EVFILT_READ), flags: UInt16(EV_ADD | EV_CLEAR),
                                fflags: 0, data: 0, udata: nil)
            _ = kevent(queue, &change, 1, nil, 0, nil)
            while true {
                var info = stat()
                fstat(descriptor, &info)
                if info.st_blksize > 0, info.st_size >= Int64(info.st_blksize) { return }
                var event = kevent()
                _ = kevent(queue, nil, 0, &event, 1, nil)
            }
        }.value
    }
}
