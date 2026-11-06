import Foundation

/// A project folder on disk. Most of the API is scoped to one.
public struct Location: Codable, Sendable, Hashable {
    public var directory: String

    public init(directory: String) {
        self.directory = directory
    }
}

/// A folder as the engine sees it: the project it's in, and where that project's main
/// checkout is (a worktree's project is its repository's).
public struct LocationInfo: Codable, Sendable, Hashable {
    public var directory: String
    public var project: Project

    public struct Project: Codable, Sendable, Hashable {
        public var id: String
        public var directory: String
        public var canonical: String
    }
}

/// A project the engine knows: a repository (by its first commit) or a folder.
public struct ProjectInfo: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    /// The main checkout.
    public var canonical: String
    public var vcs: String?
    public var commands: Commands?

    public struct Commands: Codable, Sendable, Hashable {
        /// Runs in each new worktree, from its folder.
        public var start: String?

        public init(start: String? = nil) {
            self.start = start
        }
    }
}

/// `{ "data": … }`, the envelope of most responses.
public struct DataEnvelope<Value: Decodable & Sendable>: Decodable, Sendable {
    public var data: Value
}

/// `{ "location": …, "data": … }`, the envelope of location-scoped responses.
public struct LocatedEnvelope<Value: Decodable & Sendable>: Decodable, Sendable {
    public var location: Location?
    public var data: Value
}

/// One page of a list, with opaque cursors for the pages around it.
public struct Page<Item: Decodable & Sendable>: Decodable, Sendable {
    public var data: [Item]
    public var cursor: Cursor?

    public struct Cursor: Codable, Sendable, Hashable {
        public var previous: String?
        public var next: String?
    }
}

/// A model, by provider, with an optional variant (reasoning effort: `low`, `high`, …).
///
/// The engine reports a session with no effort chosen as variant `"default"`. That isn't
/// one of the model's levels, so it's read as `nil` here: the app shows "Default" and
/// never sends the word back.
public struct ModelRef: Codable, Sendable, Hashable {
    public var id: String
    public var providerID: String
    public var variant: String?

    /// The engine's name for "no effort chosen".
    public static let defaultVariant = "default"

    public init(id: String, providerID: String, variant: String? = nil) {
        self.id = id
        self.providerID = providerID
        self.variant = variant == Self.defaultVariant ? nil : variant
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decode(String.self, forKey: .id),
            providerID: try container.decode(String.self, forKey: .providerID),
            variant: try container.decodeIfPresent(String.self, forKey: .variant)
        )
    }

    /// Ignores the variant, for "is this the same model?".
    public func sameModel(as other: ModelRef?) -> Bool {
        other.map { $0.id == id && $0.providerID == providerID } ?? false
    }
}

public struct TokenUsage: Codable, Sendable, Hashable {
    public var input: Int
    public var output: Int
    public var reasoning: Int
    public var cache: Cache

    public struct Cache: Codable, Sendable, Hashable {
        public var read: Int
        public var write: Int
    }

    public static let zero = TokenUsage(input: 0, output: 0, reasoning: 0, cache: Cache(read: 0, write: 0))

    public var total: Int { input + output + reasoning + cache.read + cache.write }
}

/// An error the engine reports in a message or event: from a provider, a tool, or itself.
public struct StructuredError: Codable, Sendable, Hashable, LocalizedError {
    public var type: String
    public var message: String
    public var status: Int?

    public var errorDescription: String? { message }

    /// The step or tool was stopped (Stop, or a message sent right away), not broken.
    public var isInterruption: Bool { type == "aborted" }
}

/// Times on the wire are milliseconds since 1970.
public typealias Milliseconds = Double

extension Milliseconds {
    public var date: Date { Date(timeIntervalSince1970: self / 1000) }
}

/// A file's change, as a unified diff.
public struct FileDiff: Codable, Sendable, Hashable, Identifiable {
    public var file: String
    public var patch: String
    public var additions: Int
    public var deletions: Int
    public var status: Status?

    public init(file: String, patch: String, additions: Int, deletions: Int, status: Status? = nil) {
        self.file = file
        self.patch = patch
        self.additions = additions
        self.deletions = deletions
        self.status = status
    }

    public var id: String { file }

    public enum Status: String, Codable, Sendable {
        case added, deleted, modified
    }
}

/// IDs the client mints, in the engine's format, so they sort among the server's:
/// a prefix, 12 hex digits of (milliseconds × 4096 + counter), then 14 random base62 characters.
public enum Identifier {
    private static let alphabet = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
    nonisolated(unsafe) private static var last: (timestamp: UInt64, counter: UInt64) = (0, 0)
    private static let lock = NSLock()

    public static func message() -> String { "msg_" + ascending() }

    static func ascending(now: Date = Date()) -> String {
        let timestamp = UInt64(now.timeIntervalSince1970 * 1000)
        let counter: UInt64 = lock.withLock {
            if last.timestamp != timestamp { last = (timestamp, 0) }
            last.counter += 1
            return last.counter
        }
        let value = (timestamp &* 0x1000 &+ counter) & 0xFFFF_FFFF_FFFF
        let time = String(value, radix: 16).leftPadded(to: 12)
        let random = (0..<14).map { _ in alphabet[Int.random(in: 0..<alphabet.count)] }
        return time + String(random)
    }
}

private extension String {
    func leftPadded(to length: Int) -> String {
        count >= length ? self : String(repeating: "0", count: length - count) + self
    }
}
