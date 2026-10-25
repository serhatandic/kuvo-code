import Foundation
import Darwin

struct ProcessResult: Sendable, Equatable {
    var exitCode: Int32
    var stdout: String
    var stderr: String

    var succeeded: Bool { exitCode == 0 }
}

protocol ProcessRunning: Sendable {
    func run(
        executable: String,
        arguments: [String],
        environment: [String: String],
        timeout: TimeInterval
    ) throws -> ProcessResult
}

struct SystemProcessRunner: ProcessRunning {
    /// From the child's exit to giving up on the end of its output: something it left running in the
    /// background (a daemon a login shell's profile starts) can hold the pipes open for ever.
    var afterExit: TimeInterval = 0.5

    /// How long, and how many, runs are read on after their result for what they left running.
    var lingering: LingeringReads = .shared

    func run(
        executable: String,
        arguments: [String],
        environment: [String: String],
        timeout: TimeInterval
    ) throws -> ProcessResult {
        let process = Process()
        if executable.hasPrefix("/") {
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = [executable] + arguments
        }
        if !environment.isEmpty {
            process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
        }

        // Debug-only, basename + arg count only: arg *values* can carry paths/identifiers, so they
        // are never logged here.
        AppLog.debug(.subprocess, "launch \((executable as NSString).lastPathComponent) (\(arguments.count) args)")

        // Close-on-exec (fork addition): a program the host starts another way meanwhile, like a
        // terminal's shell, would otherwise get a copy of both ends and keep them open.
        let stdoutPipe = Self.unsharedPipe()
        let stderrPipe = Self.unsharedPipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        // Read both pipes as they come, from before the child runs. A child that writes more than the
        // OS pipe buffer (~64KB) would otherwise block on write, never exit, and trip the timeout below
        // — reading only after exit deadlocks. (`ps -ax -o command=` alone is ~240KB.) Read in pieces,
        // never to EOF in one call, so what came is there even when something holds a pipe open.
        // Semaphores, not groups: a group freed while still entered (a pipe given up on) traps.
        let output = SubprocessOutput(pipes: [stdoutPipe, stderrPipe], lingering: lingering)
        let drained = DispatchSemaphore(value: 0)
        drain(stdoutPipe, into: output, isStdout: true, ended: drained)
        drain(stderrPipe, into: output, isStdout: false, ended: drained)
        // Once the result is in, what the child left running is still read (and let go) until it
        // closes the pipes, within `lingering`'s bounds: closed here, it would be killed the next
        // time it printed.
        defer { output.seal() }

        // Its exit from the termination handler (registered before `run()` so an instantly-exiting
        // child can't race it), never `waitUntilExit()`, which can miss it and wait for ever.
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }

        try process.run()

        if exited.wait(timeout: .now() + timeout) == .timedOut {
            terminateProcessTree(rootPID: process.processIdentifier)
            process.terminate()
            // A child that takes no notice of SIGTERM (an interactive shell) is killed a moment later.
            if exited.wait(timeout: .now() + 0.1) == .timedOut {
                kill(process.processIdentifier, SIGKILL)
                exited.wait()
            }
            waitForBoth(drained)
            throw ProcessRunnerError.timedOut(executable: executable, timeout: timeout)
        }

        waitForBoth(drained)
        AppLog.debug(.subprocess, "exit \(process.terminationStatus)")
        return ProcessResult(exitCode: process.terminationStatus, stdout: output.stdoutString, stderr: output.stderrString)
    }

    /// Reads a pipe as it comes, on the handle's own queue (not the shared utility pool a blocking
    /// caller may hold), into `output`; `ended` is signalled at its end. The handler holds `output`,
    /// and with it the pipes, so their reading ends stay open until then (or until `lingering`
    /// lets them go), however long after the result that is.
    private func drain(_ pipe: Pipe, into output: SubprocessOutput, isStdout: Bool, ended: DispatchSemaphore) {
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                output.pipeEnded()
                ended.signal()
            } else {
                output.append(data, isStdout: isStdout)
            }
        }
    }

    /// A pipe whose two ends close on exec.
    static func unsharedPipe() -> Pipe {
        let pipe = Pipe()
        for descriptor in [pipe.fileHandleForReading.fileDescriptor, pipe.fileHandleForWriting.fileDescriptor] {
            _ = fcntl(descriptor, F_SETFD, fcntl(descriptor, F_GETFD) | FD_CLOEXEC)
        }
        return pipe
    }

    /// Once the child has exited: the end of both pipes, or what came by `afterExit`.
    private func waitForBoth(_ drained: DispatchSemaphore) {
        let deadline = DispatchTime.now() + afterExit
        for _ in 0..<2 where drained.wait(timeout: deadline) == .timedOut { return }
    }

    private func terminateProcessTree(rootPID: Int32) {
        let children = childPIDs(of: rootPID)
        for child in children {
            terminateProcessTree(rootPID: child)
        }
        kill(rootPID, SIGTERM)
        for child in children {
            kill(child, SIGKILL)
        }
    }

    private func childPIDs(of pid: Int32) -> [Int32] {
        let text = (try? run(executable: "/usr/bin/pgrep", arguments: ["-P", String(pid)], environment: [:], timeout: 2))?.stdout ?? ""
        return text
            .split(whereSeparator: \.isNewline)
            .compactMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }
}

enum ProcessRunnerError: Error, LocalizedError, Equatable {
    case timedOut(executable: String, timeout: TimeInterval)

    var errorDescription: String? {
        switch self {
        case .timedOut(let executable, let timeout):
            return "\(executable) timed out after \(Int(timeout))s."
        }
    }
}

/// Runs still read after their result is in, because something they left running holds their pipes
/// (two descriptors a pipe): at most `cap` of them across the app, each for `limit` seconds at most,
/// so a login shell whose profile leaves something running can never use up the host's
/// descriptors. One let go has its pipes closed: what it left running then finds them closed the
/// next time it prints. (Fork addition; the host's ChildProcess has the same bounds.)
final class LingeringReads: @unchecked Sendable {
    static let shared = LingeringReads(cap: 32, limit: 600, now: { ProcessInfo.processInfo.systemUptime })

    let cap: Int
    let limit: TimeInterval
    private let now: @Sendable () -> TimeInterval
    private let lock = NSLock()
    private var entries: [(id: ObjectIdentifier, until: TimeInterval, stop: @Sendable () -> Void)] = []

    init(cap: Int, limit: TimeInterval, now: @escaping @Sendable () -> TimeInterval) {
        self.cap = cap
        self.limit = limit
        self.now = now
    }

    var count: Int { lock.withLock { entries.count } }

    /// Notes `id`, still read, until `stop` lets it go: what's over the cap, oldest first, is for
    /// the caller to stop once it holds no lock of its own.
    fileprivate func add(_ id: ObjectIdentifier, stop: @escaping @Sendable () -> Void) -> [@Sendable () -> Void] {
        let over = lock.withLock { () -> [@Sendable () -> Void] in
            entries.append((id, now() + limit, stop))
            let over = max(0, entries.count - cap)
            defer { entries.removeFirst(over) }
            return entries.prefix(over).map(\.stop)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + limit) { [weak self] in self?.sweep() }
        return over
    }

    /// It came to the end of its pipes by itself.
    fileprivate func remove(_ id: ObjectIdentifier) {
        lock.withLock { entries.removeAll { $0.id == id } }
    }

    /// Lets go of those past their time.
    func sweep() {
        let expired = lock.withLock { () -> [@Sendable () -> Void] in
            let now = now()
            defer { entries.removeAll { $0.until <= now } }
            return entries.filter { $0.until <= now }.map(\.stop)
        }
        for stop in expired { stop() }
    }
}

/// Lock-guarded accumulator for the two concurrently-drained pipes, and what keeps them read after
/// the result (the drains hold it, and it holds the pipes).
private final class SubprocessOutput: @unchecked Sendable {
    private let lock = NSLock()
    private var stdout = Data()
    private var stderr = Data()
    /// The result is in: what comes after is let go.
    private var sealed = false
    private let pipes: [Pipe]
    private let lingering: LingeringReads
    /// Pipes not at their end yet.
    private var open: Int
    /// Noted in `lingering`.
    private var lingers = false

    init(pipes: [Pipe], lingering: LingeringReads) {
        self.pipes = pipes
        self.lingering = lingering
        open = pipes.count
    }

    func append(_ data: Data, isStdout: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard !sealed else { return }
        if isStdout { stdout.append(data) } else { stderr.append(data) }
    }

    func pipeEnded() {
        lock.lock(); defer { lock.unlock() }
        open -= 1
        if open == 0, lingers {
            lingers = false
            lingering.remove(ObjectIdentifier(self))
        }
    }

    /// The result is in: what's still open is read on, as `lingering` allows.
    func seal() {
        var over: [@Sendable () -> Void] = []
        lock.lock()
        sealed = true
        stdout = Data()
        stderr = Data()
        if open > 0 {
            lingers = true
            over = lingering.add(ObjectIdentifier(self)) { [self] in stopReading() }
        }
        lock.unlock()
        for stop in over { stop() }
    }

    /// Let go of: each pipe's end here is closed at once, `/dev/null` put in its place, so a drain
    /// still at work reads its end rather than a closed descriptor.
    private func stopReading() {
        lock.withLock { lingers = false }
        let nothing = Darwin.open("/dev/null", O_RDONLY | O_CLOEXEC)
        defer { if nothing >= 0 { close(nothing) } }
        for pipe in pipes {
            let reader = pipe.fileHandleForReading
            reader.readabilityHandler = nil
            // (dup2 clears close-on-exec: set again.)
            if nothing >= 0, dup2(nothing, reader.fileDescriptor) >= 0 { _ = fcntl(reader.fileDescriptor, F_SETFD, FD_CLOEXEC) }
        }
    }

    var stdoutString: String { lock.lock(); defer { lock.unlock() }; return String(data: stdout, encoding: .utf8) ?? "" }
    var stderrString: String { lock.lock(); defer { lock.unlock() }; return String(data: stderr, encoding: .utf8) ?? "" }
}

