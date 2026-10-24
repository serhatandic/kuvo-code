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

    var environment: [String: String] {
        [
            "XDG_DATA_HOME": root.appending(path: "data").path,
            "XDG_CONFIG_HOME": root.appending(path: "config").path,
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
/// prints `{"url": …}` as its first line, and exits when its stdin closes, so
/// it can't outlive the app even if the app crashes.
public final class ServerProcess: @unchecked Sendable {
    public let endpoint: ServerEndpoint
    private let process: Process
    private let stdin: Pipe
    private let log: LogTail

    private init(endpoint: ServerEndpoint, process: Process, stdin: Pipe, log: LogTail) {
        self.endpoint = endpoint
        self.process = process
        self.stdin = stdin
        self.log = log
    }

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
    /// OPENCODE_PASSWORD, and stops when its stdin closes.
    public static func start(
        executable: URL,
        arguments: [String],
        environment base: [String: String],
        directory: URL,
        timeout: Duration = .seconds(60),
        onExit: @escaping @Sendable (Int32) -> Void = { _ in }
    ) async throws -> ServerProcess {
        let password = Self.randomPassword()
        var environment = base
        environment["OPENCODE_PASSWORD"] = password
        return try await launch(executable: executable, arguments: arguments, environment: environment, directory: directory,
                                password: password, timeout: timeout, onExit: onExit)
    }

    private static func launch(
        executable: URL,
        arguments: [String],
        environment: [String: String],
        directory: URL,
        password: String,
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
        process.terminationHandler = { process in onExit(process.terminationStatus) }
        try process.run()

        let url: URL
        do {
            url = try await withThrowingTaskGroup(of: URL.self) { group in
                group.addTask { try await Self.readHandshake(from: stdout.fileHandleForReading, process: process, log: log) }
                group.addTask {
                    try await Task.sleep(for: timeout)
                    throw ServerProcessError.timedOut
                }
                let url = try await group.next()!
                group.cancelAll()
                return url
            }
        } catch {
            process.terminate()
            throw error
        }

        // Keep draining stdout so the server never blocks on a full pipe.
        stdout.fileHandleForReading.readabilityHandler = { handle in
            if handle.availableData.isEmpty { handle.readabilityHandler = nil }
        }
        return ServerProcess(endpoint: ServerEndpoint(url: url, password: password), process: process, stdin: stdin, log: log)
    }

    /// Closing stdin is the server's signal to shut down cleanly.
    public func stop() {
        try? stdin.fileHandleForWriting.close()
        let process = process
        Task.detached {
            try? await Task.sleep(for: .seconds(5))
            if process.isRunning { process.terminate() }
        }
    }

    deinit { stop() }

    private static func readHandshake(from handle: FileHandle, process: Process, log: LogTail) async throws -> URL {
        var line = Data()
        for try await byte in handle.bytes {
            if byte == UInt8(ascii: "\n") { break }
            line.append(byte)
        }
        guard !line.isEmpty else {
            // stdout closed before the handshake: the server died while starting. What it said
            // as it went, read to its end (not after a moment, if something it started keeps it).
            process.waitUntilExit()
            log.waitUntilClosed(for: 1)
            throw ServerProcessError.exited(status: process.terminationStatus, output: log.text)
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
final class LogTail: @unchecked Sendable {
    private let lock = NSCondition()
    private var buffer = Data()
    private let limit = 16 * 1024
    private var isClosed = false

    func append(_ data: Data) {
        lock.withLock {
            buffer.append(data)
            if buffer.count > limit { buffer.removeFirst(buffer.count - limit) }
        }
    }

    /// Everything's been read: the other end closed.
    func close() {
        lock.withLock {
            isClosed = true
            lock.broadcast()
        }
    }

    func waitUntilClosed(for seconds: TimeInterval) {
        let deadline = Date(timeIntervalSinceNow: seconds)
        lock.withLock {
            while !isClosed, lock.wait(until: deadline) {}
        }
    }

    var text: String {
        lock.withLock { String(decoding: buffer, as: UTF8.self) }
    }
}

#endif
