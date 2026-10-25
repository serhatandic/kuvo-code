import Foundation

// Starts processes, so only on the Mac; the phone reaches engines through Kuvo Link.
#if os(macOS)

/// Runs a program to its end and gives what it said: the one way the app and its packages run a
/// command and wait for it (git, ssh, tar, a shell…).
///
/// It never waits the way that could hang for ever:
/// - it learns that the program ended from its termination handler, never `waitUntilExit()`,
///   which on one of Swift's threads could miss the exit and wait on, the program long gone;
/// - it reads stdout and stderr as they come, so a program that says a lot never blocks on a
///   full pipe (a pipe holds 64 KB) waiting for a reader that only reads once it has ended;
/// - once the program has ended, it waits only a moment for the end of its output: something it
///   left running in the background (a daemon a hook or a profile starts) can hold that open;
/// - given a `limit`, a program still running then is sent SIGTERM and, if it takes no notice
///   (an interactive shell doesn't), SIGKILL a moment later. Without one it runs as long as it
///   takes, for what has no natural end (a push, an upload, a machine's install).
///
/// `run` waits without holding a thread, and a cancelled task stops the program. `runBlocking`
/// is the same for code that is synchronous (git's and a machine's short commands, read off the
/// main thread): it holds only the calling thread, which must never be the main one.
public enum ChildProcess {
    /// What the program reads.
    public enum Input: Sendable {
        /// Nothing (`/dev/null`): it never waits on the app's own stdin.
        case nothing
        /// A file, from its start.
        case file(URL)
    }

    /// Where what it says on stdout goes.
    public enum Output: Sendable {
        case collect
        case discard
        /// Into a file that's there already (made with the permissions it needs), as it comes.
        case file(URL)
    }

    /// Where what it says on stderr goes.
    public enum Errors: Sendable {
        case collect
        case discard
        /// With stdout, in the order it says them (`2>&1`).
        case withOutput
    }

    public struct Result: Sendable {
        public var status: Int32
        public var reason: Process.TerminationReason
        public var output: Data
        public var errors: Data
        /// It was still running at its limit, and was stopped.
        public var timedOut: Bool

        /// It ran to its end by itself and said it worked.
        public var succeeded: Bool { !timedOut && reason == .exit && status == 0 }
        public var outputText: String { String(decoding: output, as: UTF8.self) }
        public var errorText: String { String(decoding: errors, as: UTF8.self) }
    }

    /// From SIGTERM to SIGKILL, for a program that doesn't stop.
    static let grace: Duration = .seconds(2)
    /// From its end to giving up on the end of its output (something it left running holds it).
    static let afterExit: Duration = .milliseconds(500)

    /// Runs `executable` and waits for it, without holding a thread. Throws when it can't start,
    /// and `CancellationError` when the task is cancelled (the program is stopped first), unless
    /// it isn't `cancellable`: then it runs to its end however the task goes (a change on a
    /// machine that shouldn't stop half done because a view that asked for it went away).
    public static func run(_ executable: String, _ arguments: [String] = [], environment: [String: String]? = nil,
                           directory: URL? = nil, input: Input = .nothing, output: Output = .collect,
                           errors: Errors = .collect, limit: Duration? = nil, cancellable: Bool = true) async throws -> Result {
        let running = try Running(executable, arguments, environment: environment, directory: directory, input: input,
                                  output: output, errors: errors, limit: limit)
        let finished = {
            try await withCheckedThrowingContinuation { continuation in
                running.start { continuation.resume(with: $0) }
            }
        }
        guard cancellable else { return try await finished() }
        return try await withTaskCancellationHandler {
            try await finished()
        } onCancel: {
            running.stop(timedOut: false)
        }
    }

    /// As `run`, holding the calling thread until it's done. Never on the main thread: for the
    /// synchronous code already run off it (in a detached task, say), or a command-line run.
    public static func runBlocking(_ executable: String, _ arguments: [String] = [], environment: [String: String]? = nil,
                                   directory: URL? = nil, input: Input = .nothing, output: Output = .collect,
                                   errors: Errors = .collect, limit: Duration? = nil) throws -> Result {
        let running = try Running(executable, arguments, environment: environment, directory: directory, input: input,
                                  output: output, errors: errors, limit: limit)
        let done = DispatchSemaphore(value: 0)
        let outcome = Outcome()
        running.start {
            outcome.value = $0
            done.signal()
        }
        done.wait()
        return try outcome.value!.get()
    }

    private final class Outcome: @unchecked Sendable {
        var value: Swift.Result<Result, Error>?
    }

    /// One program, from its start to what it said.
    private final class Running: @unchecked Sendable {
        private let process = Process()
        private let limit: Duration?
        private let lock = NSLock()
        private var said = Data()
        private var complained = Data()
        /// Pipes not at their end yet.
        private var open = 0
        private var readers: [FileHandle] = []
        /// Files handed to it, closed once it's done.
        private var files: [FileHandle] = []
        private var started = false
        private var ended: (status: Int32, reason: Process.TerminationReason)?
        private var timedOut = false
        private var cancelled = false
        private var done = false
        private var completion: (@Sendable (Swift.Result<Result, Error>) -> Void)?

        init(_ executable: String, _ arguments: [String], environment: [String: String]?, directory: URL?,
             input: Input, output: Output, errors: Errors, limit: Duration?) throws {
            self.limit = limit
            process.executableURL = URL(filePath: executable)
            process.arguments = arguments
            if let environment { process.environment = environment }
            if let directory { process.currentDirectoryURL = directory }
            switch input {
            case .nothing:
                process.standardInput = FileHandle.nullDevice
            case .file(let url):
                let file = try FileHandle(forReadingFrom: url)
                files.append(file)
                process.standardInput = file
            }
            // Pipes of its own, so a terminal's shell started meanwhile doesn't keep them open
            // (see `Pipe.unshared`).
            var outputPipe: Pipe?
            switch output {
            case .collect:
                let pipe = Pipe.unshared()
                outputPipe = pipe
                process.standardOutput = pipe
                read(pipe.fileHandleForReading, errors: false)
            case .discard:
                process.standardOutput = FileHandle.nullDevice
            case .file(let url):
                let file = try FileHandle(forWritingTo: url)
                files.append(file)
                process.standardOutput = file
            }
            switch errors {
            case .collect:
                let pipe = Pipe.unshared()
                process.standardError = pipe
                read(pipe.fileHandleForReading, errors: true)
            case .discard:
                process.standardError = FileHandle.nullDevice
            case .withOutput:
                if let outputPipe {
                    process.standardError = outputPipe
                } else {
                    let pipe = Pipe.unshared()
                    process.standardError = pipe
                    read(pipe.fileHandleForReading, errors: true)
                }
            }
        }

        /// Reads `handle` as it comes, on its own queue, into what it said or what it complained.
        private func read(_ handle: FileHandle, errors: Bool) {
            open += 1
            readers.append(handle)
            handle.readabilityHandler = { [self] handle in
                let data = handle.availableData
                if data.isEmpty {
                    handle.readabilityHandler = nil
                    let finished = lock.withLock { () -> Bool in
                        open -= 1
                        return open == 0 && ended != nil
                    }
                    if finished { finish() }
                } else {
                    lock.withLock { errors ? complained.append(data) : said.append(data) }
                }
            }
        }

        func start(_ completion: @escaping @Sendable (Swift.Result<Result, Error>) -> Void) {
            let goes = lock.withLock { () -> Bool in
                self.completion = completion
                return !cancelled
            }
            guard goes else { return fail(CancellationError()) }
            process.terminationHandler = { [self] process in
                let status = process.terminationStatus, reason = process.terminationReason
                let finished = lock.withLock { () -> Bool in
                    ended = (status, reason)
                    return open == 0
                }
                if finished {
                    finish()
                } else {
                    // The end of its output, or what came by a moment after.
                    DispatchQueue.global().asyncAfter(deadline: .now() + ChildProcess.afterExit.dispatch) { [weak self] in self?.finish() }
                }
            }
            do {
                try process.run()
            } catch {
                return fail(error)
            }
            let stopNow = lock.withLock { () -> Bool in
                started = true
                return cancelled
            }
            if stopNow { stop(timedOut: false) }
            if let limit {
                DispatchQueue.global().asyncAfter(deadline: .now() + limit.dispatch) { [weak self] in self?.stop(timedOut: true) }
            }
        }

        /// Stops it, if it's still running: SIGTERM, then SIGKILL if that doesn't do it.
        func stop(timedOut: Bool) {
            let signal = lock.withLock { () -> Bool in
                guard ended == nil, !done else { return false }
                if timedOut { self.timedOut = true } else { cancelled = true }
                return started
            }
            guard signal else { return }
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + ChildProcess.grace.dispatch) { [weak self] in
                guard let self else { return }
                let running = lock.withLock { ended == nil }
                if running { kill(process.processIdentifier, SIGKILL) }
            }
        }

        private func fail(_ error: Error) {
            let completion = lock.withLock { () -> (@Sendable (Swift.Result<Result, Error>) -> Void)? in
                guard !done else { return nil }
                done = true
                return self.completion
            }
            letGo()
            completion?(.failure(error))
        }

        private func finish() {
            let outcome = lock.withLock { () -> (Swift.Result<Result, Error>, (@Sendable (Swift.Result<Result, Error>) -> Void)?)? in
                guard !done, let ended else { return nil }
                done = true
                if cancelled, !timedOut { return (.failure(CancellationError()), completion) }
                return (.success(Result(status: ended.status, reason: ended.reason, output: said, errors: complained, timedOut: timedOut)), completion)
            }
            guard let outcome else { return }
            letGo()
            outcome.1?(outcome.0)
        }

        /// Stops reading (what it left running no longer holds this end) and closes its files.
        private func letGo() {
            process.terminationHandler = nil
            for reader in readers { reader.readabilityHandler = nil }
            for file in files { try? file.close() }
        }
    }
}

extension Duration {
    /// As GCD takes it.
    var dispatch: DispatchTimeInterval {
        let (seconds, attoseconds) = components
        return .nanoseconds(Int(clamping: seconds) &* 1_000_000_000 &+ Int(attoseconds / 1_000_000_000))
    }
}

#endif
