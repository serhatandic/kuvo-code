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
    static let afterExit: TimeInterval = 0.5

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

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        // Read both pipes as they come, from before the child runs. A child that writes more than the
        // OS pipe buffer (~64KB) would otherwise block on write, never exit, and trip the timeout below
        // — reading only after exit deadlocks. (`ps -ax -o command=` alone is ~240KB.) Read in pieces,
        // never to EOF in one call, so what came is there even when something holds a pipe open.
        // Semaphores, not groups: a group freed while still entered (a pipe given up on) traps.
        let output = SubprocessOutput()
        let drained = DispatchSemaphore(value: 0)
        drain(stdoutPipe, into: output, isStdout: true, ended: drained)
        drain(stderrPipe, into: output, isStdout: false, ended: drained)
        // Once the result is in, what the child left running is still read (and let go) until it
        // closes the pipes: closed here, it would be killed the next time it printed.
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
    /// caller may hold), into `output`; `ended` is signalled at its end. The handler holds the
    /// pipe, so its reading end stays open until then, however long after the result that is.
    private func drain(_ pipe: Pipe, into output: SubprocessOutput, isStdout: Bool, ended: DispatchSemaphore) {
        pipe.fileHandleForReading.readabilityHandler = { [pipe] handle in
            _ = pipe  // Held until the end, above.
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                ended.signal()
            } else if isStdout {
                output.appendStdout(data)
            } else {
                output.appendStderr(data)
            }
        }
    }

    /// Once the child has exited: the end of both pipes, or what came by `afterExit`.
    private func waitForBoth(_ drained: DispatchSemaphore) {
        let deadline = DispatchTime.now() + Self.afterExit
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

/// Lock-guarded accumulator for the two concurrently-drained pipes.
private final class SubprocessOutput: @unchecked Sendable {
    private let lock = NSLock()
    private var stdout = Data()
    private var stderr = Data()
    /// The result is in: what comes after is let go.
    private var sealed = false

    func appendStdout(_ data: Data) { lock.lock(); if !sealed { stdout.append(data) }; lock.unlock() }
    func appendStderr(_ data: Data) { lock.lock(); if !sealed { stderr.append(data) }; lock.unlock() }
    func seal() { lock.lock(); sealed = true; stdout = Data(); stderr = Data(); lock.unlock() }

    var stdoutString: String { lock.lock(); defer { lock.unlock() }; return String(data: stdout, encoding: .utf8) ?? "" }
    var stderrString: String { lock.lock(); defer { lock.unlock() }; return String(data: stderr, encoding: .utf8) ?? "" }
}

