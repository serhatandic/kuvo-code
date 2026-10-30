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
///   left running in the background (a daemon a hook or a profile starts) can hold that open.
///   All it said before it ended is kept, and what that leftover says after is read and let go
///   until it ends, so it runs on as it would have (never killed by a closed pipe), within
///   bounds that keep the app's descriptors from running out (`Lingering`);
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
        /// A file, from its start, saying as it goes how far into it the program has read (a
        /// few times a second, and when it's done): an upload's progress.
        case reported(URL, read: @Sendable (Int64) -> Void)
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
    /// From its end to giving up on the end of its output (something it left running holds it),
    /// once what it said before it ended is all read; that can take up to `catchingUp` more.
    static let afterExit: Duration = .milliseconds(500)
    static let catchingUp: Duration = .seconds(1)

    /// Runs still read after their result is in, because something they left running holds their
    /// pipes (each holds two descriptors a pipe): at most `cap` of them across the app, each for
    /// `limit` at most, so a wake-up check that leaves `something &` every minute can never use
    /// up the app's descriptors. One let go has its pipes closed: what it left running then finds
    /// them closed the next time it prints, as it would have before.
    final class Lingering: @unchecked Sendable {
        static let shared = Lingering(cap: 32, limit: .seconds(600), now: { ContinuousClock.now })

        let cap: Int
        let limit: Duration
        private let now: @Sendable () -> ContinuousClock.Instant
        private let lock = NSLock()
        private var entries: [(id: ObjectIdentifier, until: ContinuousClock.Instant, stop: @Sendable () -> Void)] = []

        init(cap: Int, limit: Duration, now: @escaping @Sendable () -> ContinuousClock.Instant) {
            self.cap = cap
            self.limit = limit
            self.now = now
        }

        var count: Int { lock.withLock { entries.count } }

        /// Notes `id`, still read, until `stop` lets it go: what's over the cap, oldest first, is
        /// for the caller to stop once it holds no lock of its own.
        fileprivate func add(_ id: ObjectIdentifier, stop: @escaping @Sendable () -> Void) -> [@Sendable () -> Void] {
            let over = lock.withLock { () -> [@Sendable () -> Void] in
                entries.append((id, now() + limit, stop))
                let over = max(0, entries.count - cap)
                defer { entries.removeFirst(over) }
                return entries.prefix(over).map(\.stop)
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + limit.dispatch) { [weak self] in self?.sweep() }
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

    /// Runs `executable` and waits for it, without holding a thread. Throws when it can't start,
    /// and `CancellationError` when the task is cancelled (the program is stopped first), unless
    /// it isn't `cancellable`: then it runs to its end however the task goes (a change on a
    /// machine that shouldn't stop half done because a view that asked for it went away).
    public static func run(_ executable: String, _ arguments: [String] = [], environment: [String: String]? = nil,
                           directory: URL? = nil, input: Input = .nothing, output: Output = .collect,
                           errors: Errors = .collect, limit: Duration? = nil, cancellable: Bool = true) async throws -> Result {
        let running = try Running(executable, arguments, environment: environment, directory: directory, input: input,
                                  output: output, errors: errors, limit: limit, afterExit: afterExit, lingering: .shared)
        return try await run(running, cancellable: cancellable)
    }

    /// As `run`, giving up on the end of its output `afterExit` after it ends, and reading on
    /// after that as `lingering` allows (for the tests).
    static func run(_ executable: String, _ arguments: [String], afterExit: Duration, lingering: Lingering = .shared) async throws -> Result {
        let running = try Running(executable, arguments, environment: nil, directory: nil, input: .nothing, output: .collect,
                                  errors: .collect, limit: nil, afterExit: afterExit, lingering: lingering)
        return try await run(running, cancellable: true)
    }

    private static func run(_ running: Running, cancellable: Bool) async throws -> Result {
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
                                  output: output, errors: errors, limit: limit, afterExit: afterExit, lingering: .shared)
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
        /// What tells how far it has read its input (`Input.reported`), stopped once it's done.
        private var inputRead: (timer: DispatchSourceTimer, file: FileHandle, read: @Sendable (Int64) -> Void)?
        private var started = false
        private var ended: (status: Int32, reason: Process.TerminationReason)?
        private var timedOut = false
        private var cancelled = false
        private var done = false
        /// Readers between taking bytes out of a pipe and keeping them.
        private var reading = 0
        private let afterExit: Duration
        private let lingering: Lingering
        /// Noted in `lingering`: still read after its result is in.
        private var lingers = false
        private var completion: (@Sendable (Swift.Result<Result, Error>) -> Void)?

        init(_ executable: String, _ arguments: [String], environment: [String: String]?, directory: URL?,
             input: Input, output: Output, errors: Errors, limit: Duration?, afterExit: Duration,
             lingering: Lingering) throws {
            self.limit = limit
            self.afterExit = afterExit
            self.lingering = lingering
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
            case .reported(let url, let read):
                let file = try FileHandle(forReadingFrom: url)
                files.append(file)
                process.standardInput = file
                // The program reads it through the same open file, so where it is in it here is
                // how far the program has read.
                let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
                timer.schedule(deadline: .now(), repeating: .milliseconds(250))
                timer.setEventHandler { [weak self] in
                    guard let self else { return }
                    // Said under the lock, so none comes after the last, which `letGo` says.
                    lock.withLock {
                        let offset = done ? -1 : lseek(file.fileDescriptor, 0, SEEK_CUR)
                        if offset >= 0 { read(Int64(offset)) }
                    }
                }
                timer.resume()
                inputRead = (timer, file, read)
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
                guard let outputPipe else { preconditionFailure("stderr goes with stdout only when stdout is collected") }
                process.standardError = outputPipe
            }
        }

        /// Reads `handle` as it comes, on its own queue, into what it said or what it complained;
        /// once the result is in, what still comes (from something it left running) is read and
        /// let go until that ends, so it's never killed by a closed pipe the next time it prints.
        /// The handler holds this, and so the pipe, until then.
        private func read(_ handle: FileHandle, errors: Bool) {
            open += 1
            readers.append(handle)
            handle.readabilityHandler = { [self] handle in
                // Counted while it reads: bytes out of the pipe but not kept yet aren't caught up.
                lock.withLock { reading += 1 }
                let data = handle.availableData
                let finished = lock.withLock { () -> Bool in
                    reading -= 1
                    guard data.isEmpty else {
                        if !done { errors ? complained.append(data) : said.append(data) }
                        return false
                    }
                    open -= 1
                    // At the end of its pipes after its result: no longer lingering.
                    if open == 0, lingers {
                        lingers = false
                        lingering.remove(ObjectIdentifier(self))
                    }
                    return open == 0 && ended != nil
                }
                if data.isEmpty { handle.readabilityHandler = nil }
                if finished { finish() }
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
                    // The end of its output, or, if something it left running holds that open,
                    // all it said before it ended a moment after.
                    let giveUp = DispatchTime.now() + afterExit.dispatch + ChildProcess.catchingUp.dispatch
                    DispatchQueue.global().asyncAfter(deadline: .now() + afterExit.dispatch) { [weak self] in self?.finishOnceCaughtUp(by: giveUp) }
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

        /// Finishes once nothing is left in its pipes or between a pipe and what's kept, so
        /// nothing it said before is dropped; by `giveUp` whatever happens (what it left running
        /// may never stop talking).
        private func finishOnceCaughtUp(by giveUp: DispatchTime) {
            let caughtUp = lock.withLock { () -> Bool in
                reading == 0 && readers.allSatisfy { reader in
                    var info = stat()
                    // A pipe's size is what's in it, not read yet.
                    return fstat(reader.fileDescriptor, &info) != 0 || info.st_size == 0
                }
            }
            if caughtUp || DispatchTime.now() >= giveUp { return finish() }
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(10)) { [weak self] in self?.finishOnceCaughtUp(by: giveUp) }
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
            // It never started: nothing will come.
            for reader in readers { reader.readabilityHandler = nil }
            letGo()
            completion?(.failure(error))
        }

        private func finish() {
            var over: [@Sendable () -> Void] = []
            let outcome = lock.withLock { () -> (Swift.Result<Result, Error>, (@Sendable (Swift.Result<Result, Error>) -> Void)?)? in
                guard !done, let ended else { return nil }
                done = true
                defer { said = Data(); complained = Data() }
                // Something it left running holds its pipes: read on, within bounds.
                if open > 0 {
                    lingers = true
                    over = lingering.add(ObjectIdentifier(self)) { [self] in stopReading() }
                }
                if cancelled, !timedOut { return (.failure(CancellationError()), completion) }
                return (.success(Result(status: ended.status, reason: ended.reason, output: said, errors: complained, timedOut: timedOut)), completion)
            }
            guard let outcome else { return }
            for stop in over { stop() }
            letGo()
            outcome.1?(outcome.0)
        }

        /// No longer read: let go of by `lingering`. Each pipe's end here is closed at once,
        /// `/dev/null` put in its place, so a handler still at work reads its end rather than a
        /// closed descriptor; the handlers held this, so it goes after.
        private func stopReading() {
            lock.withLock { lingers = false }
            let nothing = Darwin.open("/dev/null", O_RDONLY | O_CLOEXEC)
            defer { if nothing >= 0 { close(nothing) } }
            for reader in readers {
                reader.readabilityHandler = nil
                // (dup2 clears close-on-exec: set again, as `Pipe.unshared` has it.)
                if nothing >= 0, dup2(nothing, reader.fileDescriptor) >= 0 { _ = fcntl(reader.fileDescriptor, F_SETFD, FD_CLOEXEC) }
            }
        }

        /// Closes its files. Its pipes stay read (and what comes let go) until what it left
        /// running closes them: closed here, that would be killed the next time it printed.
        private func letGo() {
            process.terminationHandler = nil
            if let inputRead {
                inputRead.timer.cancel()
                // Where it got to, last: the whole of it, for one that read it all.
                let offset = lseek(inputRead.file.fileDescriptor, 0, SEEK_CUR)
                if offset >= 0 { inputRead.read(Int64(offset)) }
            }
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
