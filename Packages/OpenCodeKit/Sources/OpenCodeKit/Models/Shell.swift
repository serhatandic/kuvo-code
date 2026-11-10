import Foundation

/// A shell command the engine runs for an agent, in the background or while its step waits:
/// what `api/shell` lists while it runs.
public struct ShellJob: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    /// "running", then "exited".
    public var status: String
    public var command: String
    public var cwd: String?
    /// Its shell's process, which leads a process group of its own (on the engine's computer).
    public var pid: Int?
    public var exit: Int?
    public var metadata: JSONValue?
    public var time: Time?

    public struct Time: Codable, Sendable, Hashable {
        public var started: Milliseconds?
    }

    public init(id: String, status: String, command: String, cwd: String? = nil, pid: Int? = nil, exit: Int? = nil, metadata: JSONValue? = nil, time: Time? = nil) {
        self.id = id
        self.status = status
        self.command = command
        self.cwd = cwd
        self.pid = pid
        self.exit = exit
        self.metadata = metadata
        self.time = time
    }

    /// The session whose agent started it, if one did.
    public var sessionID: String? { metadata?["sessionID"]?.string }
}

/// A stretch of a shell command's output, stdout and stderr together.
public struct ShellOutput: Decodable, Sendable, Hashable {
    public var output: String
    /// Where the next stretch starts, in bytes.
    public var cursor: Int
    /// How much there is so far, in bytes.
    public var size: Int
}
