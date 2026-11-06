import Foundation

// Starts processes, so only on the Mac; the phone reaches engines through Kuvo Link.
#if os(macOS)

/// Folders the engine keeps its database, config, state and caches in. The app
/// gives it its own, so it never migrates or shares an `opencode` install's data.
public struct EngineFolders: Sendable {
    public var root: URL

    public init(root: URL) {
        self.root = root
    }

    /// The engine's own working directory, and so the default project for calls that
    /// don't name one (the catalog). Kept empty on purpose: with the home folder there,
    /// the engine scans ~ and macOS stops it with "would like to access your Desktop".
    public var workspace: URL { root.appending(path: "workspace") }

    /// Where the engine keeps its database (`opencode*.db`) and logs.
    public var dataDirectory: URL { root.appending(path: "data/opencode") }

    /// The engine's global settings file, which it reloads when the file changes. Its
    /// `skills` folder beside it holds skills every project can use.
    public var configFile: URL { root.appending(path: "config/opencode/opencode.json") }

    /// Its `XDG_CONFIG_HOME`: the folder its settings file and skills are under (`opencode/…`).
    public var configHome: URL { root.appending(path: "config") }

    var environment: [String: String] {
        [
            "XDG_DATA_HOME": root.appending(path: "data").path,
            "XDG_CONFIG_HOME": configHome.path,
            "XDG_STATE_HOME": root.appending(path: "state").path,
            "XDG_CACHE_HOME": root.appending(path: "cache").path,
            // What MCP servers it runs with npx or bunx download, in its own cache too (npm's
            // and Bun's own would be in the home folder).
            "npm_config_cache": root.appending(path: "cache/npm").path,
            "BUN_INSTALL": root.appending(path: "cache/bun").path,
            // Temporary files of its own and of what it runs (Bun's, its servers'), rather
            // than the Mac's shared temporary folder.
            "TMPDIR": temporary.path + "/",
        ]
    }

    /// The engine's temporary folder, cleared of what's a few days old when it starts: in the
    /// app's own temporary folder, as a short path without spaces (sockets made under it must fit
    /// in 104 bytes, and scripts don't always quote it).
    public var temporary: URL {
        FileManager.default.temporaryDirectory.appending(path: Bundle.main.bundleIdentifier ?? "opencodekit").appending(path: "engine")
    }

    func create() throws {
        for path in environment.values + [workspace.path] {
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        }
        // Where it was before (a test build's): its long path broke sockets.
        try? FileManager.default.removeItem(at: root.appending(path: "cache/tmp"))
        let old = Date.now.addingTimeInterval(-3 * 86_400)
        for item in (try? FileManager.default.contentsOfDirectory(at: temporary, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            if let modified = try? item.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate, modified < old {
                try? FileManager.default.removeItem(at: item)
            }
        }
    }
}

public enum ServerProcessError: LocalizedError {
    case exited(status: Int32, output: String)
    case unreadableHandshake(String)
    case timedOut

    public var errorDescription: String? {
        switch self {
        case .exited(let status, let output):
            "The engine stopped (exit code \(status)).\(output.isEmpty ? "" : "\n\n\(output)")"
        case .unreadableHandshake(let line): "The engine said something unexpected when starting: \(line)"
        case .timedOut: "The engine took too long to start."
        }
    }
}

/// A private opencode server that lives exactly as long as this object.
///
/// Started as `opencode serve --stdio --port 0`: the server picks a free port,
/// prints `{"url": …}` as its first line, and exits when its stdin closes. One that can't hear
/// that (held up as it starts, or stuck) is stopped by its `ServerWatcher`, so it can't outlive
/// the app even if the app crashes.
public final class ServerProcess: @unchecked Sendable {
    public let endpoint: ServerEndpoint
    private let process: Process
    private let stdin: Pipe
    private let watcher: ServerWatcher
    private let log: LogTail

    private init(endpoint: ServerEndpoint, process: Process, stdin: Pipe, watcher: ServerWatcher, log: LogTail) {
        self.endpoint = endpoint
        self.process = process
        self.stdin = stdin
        self.watcher = watcher
        self.log = log
    }

    /// The process seeing it gone.
    var watcherID: Int32? { watcher.processID }

    public var isRunning: Bool { process.isRunning }

    /// Its process, for a record that names it (the agents bridge's, for this Mac's box).
    public var processID: Int32 { process.processIdentifier }

    /// The last lines the server wrote to stderr, for error reports.
    public var recentOutput: String { log.text }

    /// Its exit code, once it has stopped.
    public var exitStatus: Int32? { process.isRunning ? nil : process.terminationStatus }

    /// Starts the server and waits until it's listening.
    public static func start(
        executable: URL,
        folders: EngineFolders,
        environment base: [String: String],
        timeout: Duration = .seconds(60),
        onExit: @escaping @Sendable (Int32) -> Void = { _ in }
    ) async throws -> ServerProcess {
        try folders.create()
        // The commands it runs get the folders `base` had back ([CommandEnvironment]).
        try? CommandEnvironment.install(in: folders.configFile.deletingLastPathComponent())
        let password = Self.randomPassword()

        var environment = base
        for (key, value) in CommandEnvironment.variables(from: base) { environment[key] = value }
        for (key, value) in folders.environment { environment[key] = value }
        environment["OPENCODE_PASSWORD"] = password
        // Tells the server it's driven by a desktop GUI (what opencode's own desktop app sends).
        environment["OPENCODE_CLIENT"] = "desktop"
        environment.removeValue(forKey: "OPENCODE_SERVER_PASSWORD")
        return try await launch(executable: executable, arguments: ["serve", "--stdio", "--port", "0"], environment: environment,
                                directory: folders.workspace, password: password, timeout: timeout, onExit: onExit)
    }

    /// Starts another server that starts as the engine does (the agents bridge): it prints
    /// `{"url": …}` once it's listening, answers only with the password it's given in
    /// OPENCODE_PASSWORD, and stops when its stdin closes. With `secrets` (this Mac's box), the
    /// password and those go as the first line on its stdin instead, `{"password", …}`: any process
    /// of the user's can read another's environment (`ps -E`), but not what its stdin was sent.
    public static func start(
        executable: URL,
        arguments: [String],
        environment base: [String: String],
        directory: URL,
        secrets: [String: String]? = nil,
        timeout: Duration = .seconds(60),
        onExit: @escaping @Sendable (Int32) -> Void = { _ in }
    ) async throws -> ServerProcess {
        let password = Self.randomPassword()
        var environment = base
        var first: Data?
        if let secrets {
            environment.removeValue(forKey: "OPENCODE_PASSWORD")
            first = try JSONSerialization.data(withJSONObject: secrets.merging(["password": password]) { $1 }) + Data("\n".utf8)
        } else {
            environment["OPENCODE_PASSWORD"] = password
        }
        return try await launch(executable: executable, arguments: arguments, environment: environment, directory: directory,
                                password: password, firstInput: first, timeout: timeout, onExit: onExit)
    }

    private static func launch(
        executable: URL,
        arguments: [String],
        environment: [String: String],
        directory: URL,
        password: String,
        firstInput: Data? = nil,
        timeout: Duration,
        onExit: @escaping @Sendable (Int32) -> Void
    ) async throws -> ServerProcess {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.currentDirectoryURL = directory
        // Its own: a terminal's shell started meanwhile mustn't hold stdin open after the app
        // has gone.
        let stdin = Pipe.unshared()
        // A server gone before it reads what it's sent: that write fails, rather than the signal
        // for it ending this process too.
        _ = fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        let stdout = Pipe.unshared()
        let stderr = Pipe.unshared()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        let log = LogTail()
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                log.close()
            } else {
                log.append(data)
            }
        }
        let exit = Arrival<Int32>()
        // First: a server it can't watch doesn't start.
        let watcher = try ServerWatcher()
        process.terminationHandler = { process in
            watcher.letGo()
            exit.deliver(process.terminationStatus)
            onExit(process.terminationStatus)
        }
        let firstLine = FirstLine(stdout.fileHandleForReading)
        do {
            try process.run()
        } catch {
            watcher.letGo()
            throw error
        }
        watcher.watch(process.processIdentifier)
        if let firstInput { try? stdin.fileHandleForWriting.write(contentsOf: firstInput) }

        let url: URL
        do {
            url = try await withThrowingTaskGroup(of: URL.self) { group in
                group.addTask { try await Self.readHandshake(firstLine, exit: exit, log: log) }
                group.addTask {
                    try await Task.sleep(for: timeout)
                    throw ServerProcessError.timedOut
                }
                // The other one, given up: waiting on the server ends with it.
                defer { group.cancelAll() }
                return try await group.next()!
            }
        } catch {
            // As `stop` does (its stdin closed, a server's signal to go, and seen gone), and told
            // at once: it has had its time.
            try? stdin.fileHandleForWriting.close()
            process.terminate()
            watcher.letGo()
            throw error
        }
        return ServerProcess(endpoint: ServerEndpoint(url: url, password: password), process: process, stdin: stdin, watcher: watcher, log: log)
    }

    /// Closing stdin is the server's signal to shut down cleanly; one that doesn't is stopped
    /// (`ServerWatcher`), whether or not this process is still here by then.
    public func stop() {
        try? stdin.fileHandleForWriting.close()
        watcher.letGo()
    }

    deinit { stop() }

    /// Its first line, `{"url": …}`, waited for without holding a thread: given up (its time is
    /// up, or its start was) as soon as that's asked.
    private static func readHandshake(_ firstLine: FirstLine, exit: Arrival<Int32>, log: LogTail) async throws -> URL {
        guard let said = await firstLine.arrival.wait() else { throw CancellationError() }
        guard case .line(let line) = said, !line.isEmpty else {
            // stdout closed before the handshake: the server died while starting. What it said
            // as it went, read to its end (not after a moment, if something it started keeps it).
            guard let status = await exit.wait() else { throw CancellationError() }
            await log.closed(within: .seconds(1))
            throw ServerProcessError.exited(status: status, output: log.text)
        }
        struct Handshake: Decodable { var url: URL }
        guard let handshake = try? JSONDecoder().decode(Handshake.self, from: line) else {
            throw ServerProcessError.unreadableHandshake(String(decoding: line, as: UTF8.self))
        }
        return handshake.url
    }

    static func randomPassword() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// Sees a server gone, however what started it goes. macOS stops nothing when a process's parent
/// dies, and a server can only hear that by running: one held up before its code runs (at a privacy
/// prompt nobody can answer) or stuck in it would stay for good. So a small process of its own
/// waits on a pipe only this one holds, which the system closes as this process goes, even in a
/// crash, and `letGo` closes when the server is to stop. The server then has its time to go, is
/// told to, has that time again, and is killed, by its own process number. One that has gone ends
/// it at once.
final class ServerWatcher: @unchecked Sendable {
    private static let script = """
        trap '' HUP INT TERM
        read server || exit 0
        read line
        wait_for_it() {
            i=0
            while [ "$i" -lt 50 ]; do
                kill -0 "$server" 2>/dev/null || exit 0
                /bin/sleep 0.1
                i=$((i + 1))
            done
        }
        wait_for_it
        kill -TERM "$server" 2>/dev/null
        wait_for_it
        kill -KILL "$server" 2>/dev/null
        """

    private let held = Pipe.unshared()
    private let lock = NSLock()
    private var isHolding = true
    let processID: Int32

    /// Started before its server: told which that is by `watch`, it ends if it's never told. It
    /// starts in `/` with nothing in its environment and reads no file, so it never brings up a
    /// prompt of macOS's.
    init() throws {
        _ = fcntl(held.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", Self.script, "kuvo-server-watcher"]
        process.environment = [:]
        process.currentDirectoryURL = URL(filePath: "/")
        process.standardInput = held
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        processID = process.processIdentifier
    }

    /// Its server, unless that has gone already.
    func watch(_ server: Int32) {
        lock.withLock {
            guard isHolding else { return }
            try? held.fileHandleForWriting.write(contentsOf: Data("\(server)\n".utf8))
        }
    }

    /// The server has gone or is to go.
    func letGo() {
        lock.withLock {
            guard isHolding else { return }
            isHolding = false
            try? held.fileHandleForWriting.close()
        }
    }
}

extension Pipe {
    /// A pipe only the process it's handed to gets. A `Process` passes on just the ends it's
    /// given, but a program started another way, like a terminal's shell (forkpty, then exec),
    /// would get a copy of both ends unless they close on exec, and keep the pipe open after the
    /// app has gone.
    public static func unshared() -> Pipe {
        let pipe = Pipe()
        for descriptor in [pipe.fileHandleForReading.fileDescriptor, pipe.fileHandleForWriting.fileDescriptor] {
            _ = fcntl(descriptor, F_SETFD, fcntl(descriptor, F_GETFD) | FD_CLOEXEC)
        }
        return pipe
    }
}

/// The last few kilobytes of a stream.
public final class LogTail: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()
    private let limit = 16 * 1024
    /// Everything's been read: the other end closed.
    let closed = Arrival<Void>()

    public init() {}

    public func append(_ data: Data) {
        lock.withLock {
            buffer.append(data)
            if buffer.count > limit { buffer.removeFirst(buffer.count - limit) }
        }
    }

    public func close() {
        closed.deliver(())
    }

    /// Waits until it's closed, or `limit` at most (something the process started can keep it).
    public func closed(within limit: Duration) async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { _ = await self.closed.wait() }
            group.addTask { try? await Task.sleep(for: limit) }
            await group.next()
            group.cancelAll()
        }
    }

    public var text: String {
        lock.withLock { String(decoding: buffer, as: UTF8.self) }
    }
}

/// The first line a server says on its stdout, read as it comes, on the pipe's own queue: a
/// FileHandle's `bytes` reads one at a time across the whole app, so a server that said nothing
/// held up every other one's start, and its own time limit with it. What it says after is read
/// and let go, so it never blocks on a full pipe.
final class FirstLine: @unchecked Sendable {
    enum Said: Sendable {
        case line(Data)
        /// stdout closed first.
        case closed
    }

    let arrival = Arrival<Said>()
    private let lock = NSLock()
    private var buffer = Data()

    init(_ handle: FileHandle) {
        handle.readabilityHandler = { [self] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                arrival.deliver(.closed)
                return
            }
            let line: Data? = lock.withLock {
                guard !arrival.hasArrived else { return nil }
                buffer.append(data)
                guard let end = buffer.firstIndex(of: UInt8(ascii: "\n")) else { return nil }
                defer { buffer = Data() }
                return buffer[..<end]
            }
            if let line { arrival.deliver(.line(Data(line))) }
        }
    }
}

/// A value that comes once, from any thread, waited for without holding a thread.
final class Arrival<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value?
    private var waiting: [UUID: CheckedContinuation<Value?, Never>] = [:]

    var hasArrived: Bool { lock.withLock { value != nil } }

    /// The first one counts; any after are let go.
    func deliver(_ value: Value) {
        let resumed = lock.withLock { () -> [CheckedContinuation<Value?, Never>] in
            guard self.value == nil else { return [] }
            self.value = value
            defer { waiting = [:] }
            return Array(waiting.values)
        }
        for continuation in resumed { continuation.resume(returning: value) }
    }

    /// It, once it's come; nil if the waiting task is cancelled first.
    func wait() async -> Value? {
        let id = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Value?, Never>) in
                let now: Value?? = lock.withLock {
                    if let value { return .some(value) }
                    if Task.isCancelled { return .some(nil) }
                    waiting[id] = continuation
                    return nil
                }
                if let now { continuation.resume(returning: now) }
            }
        } onCancel: {
            let continuation = lock.withLock { waiting.removeValue(forKey: id) }
            continuation?.resume(returning: nil)
        }
    }
}

#endif
