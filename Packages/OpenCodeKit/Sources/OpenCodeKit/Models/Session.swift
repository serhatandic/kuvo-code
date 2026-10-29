import Foundation

/// A conversation with an agent, in one project folder.
public struct Session: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var parentID: String?
    public var projectID: String
    public var agent: String?
    public var model: ModelRef?
    /// Total cost so far, in US dollars.
    public var cost: Double
    public var tokens: TokenUsage
    public var outcome: Outcome?
    public var time: Time
    public var title: String?
    public var location: Location
    public var subpath: String?
    /// Rules on top of the agent's own, for this session. Later rules win.
    public var permissions: [PermissionRule]?
    /// Clients' own notes on the session, as a JSON object.
    public var metadata: JSONValue?
    /// An undo waiting to be kept or taken back: the conversation is back to before this
    /// message. Sending the next message makes it final.
    public var revert: Revert?

    public struct Revert: Codable, Sendable, Hashable {
        public var messageID: String
        /// The files it put back.
        public var files: [FileDiff]?
    }

    public struct Time: Codable, Sendable, Hashable {
        public var created: Milliseconds
        public var updated: Milliseconds
        /// When the last run finished.
        public var idle: Milliseconds?
        /// When someone last looked at it. Unread means `idle > viewed`.
        public var viewed: Milliseconds?
        public var archived: Milliseconds?
    }

    public enum Outcome: Codable, Sendable, Hashable {
        case succeeded, failed, interrupted
        /// One a newer engine says that this app doesn't know: shown as stopped, and kept as it was
        /// (rather than losing the list it's in, or being written back as another).
        case unknown(String)

        public init(rawValue: String) {
            switch rawValue {
            case "succeeded": self = .succeeded
            case "failed": self = .failed
            case "interrupted": self = .interrupted
            default: self = .unknown(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .succeeded: "succeeded"
            case .failed: "failed"
            case .interrupted: "interrupted"
            case .unknown(let word): word
            }
        }

        public init(from decoder: Decoder) throws {
            self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public var isUnread: Bool {
        guard let idle = time.idle else { return false }
        return idle > (time.viewed ?? 0)
    }
}

/// "For this action on these resources: allow, deny, or ask." The engine checks the
/// agent's rules, then the session's, then saved "always allow" answers; the last match wins.
public struct PermissionRule: Codable, Sendable, Hashable {
    public var action: String
    public var resource: String
    public var effect: Effect

    public enum Effect: Codable, Sendable, Hashable {
        case allow, deny, ask
        /// One a newer engine has that this app doesn't know: kept as it was, and taken as Don't
        /// Allow wherever this app decides what a rule lets through (`holdsBack`), never as Ask
        /// (which Approve All turns into Allow).
        case unknown(String)

        public init(rawValue: String) {
            switch rawValue {
            case "allow": self = .allow
            case "deny": self = .deny
            case "ask": self = .ask
            default: self = .unknown(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .allow: "allow"
            case .deny: "deny"
            case .ask: "ask"
            case .unknown(let word): word
            }
        }

        /// What it matches is held back, as far as this app decides: Don't Allow, or one it
        /// doesn't know.
        public var holdsBack: Bool {
            switch self {
            case .deny, .unknown: true
            case .allow, .ask: false
            }
        }

        public init(from decoder: Decoder) throws {
            self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public init(action: String, resource: String = "*", effect: Effect) {
        self.action = action
        self.resource = resource
        self.effect = effect
    }
}

/// A queued input that hasn't reached the agent yet.
public struct InboxItem: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var sessionID: String
    public var type: String
    public var payload: JSONValue
    public var delivery: Delivery

    public enum Delivery: String, Codable, Sendable {
        /// Delivered at the next step of the current run.
        case steer
        /// Waits until the run finishes.
        case queue

        /// One a newer engine has that this app doesn't know: it waits its turn.
        public init(from decoder: Decoder) throws {
            self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .queue
        }
    }

    public var text: String? { payload["text"]?.string }

    /// Files attached to user input, where they're files on this Mac.
    public var files: [URL] { Self.files(in: payload) }

    /// The engine keeps each file as `{data, mime, name, source: {type: "uri", uri}}`, or
    /// `source: {type: "inline"}` for one sent in the message itself; as sent, `{uri, name}`.
    static func files(in payload: JSONValue) -> [URL] {
        (payload["files"]?.array ?? []).compactMap { file in
            (file["source"]?["uri"]?.string ?? file["uri"]?.string).flatMap(URL.init(string:)).flatMap { $0.isFileURL ? $0 : nil }
        }
    }

    /// Files the input carries in itself (`data:`, like a photo sent from a phone).
    static func inlineFiles(in payload: JSONValue) -> [Message.User.Attachment] {
        (payload["files"]?.array ?? []).compactMap { file in
            let name = file["name"]?.string
            if file["source"]?["type"]?.string == "inline", let data = file["data"]?.string {
                let mime = file["mime"]?.string ?? "application/octet-stream"
                return Message.User.Attachment(mime: mime, name: name, source: .uri("data:\(mime);base64,\(data)"))
            }
            guard let uri = file["uri"]?.string, uri.hasPrefix("data:") else { return nil }
            return Message.User.Attachment(mime: dataType(uri), name: name, source: .uri(uri))
        }
    }

    /// The type a `data:` URL's header names ("data:image/jpeg;base64,…"); plain text without one.
    static func dataType(_ uri: String) -> String {
        let type = uri.dropFirst("data:".count).prefix { $0 != "," && $0 != ";" }
        return type.isEmpty ? "text/plain" : String(type)
    }
}

/// What the agent is waiting for permission to do.
public struct PermissionRequest: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var sessionID: String
    /// The kind of access: `edit`, `shell`, `read`, `external_directory`, …
    public var action: String
    /// What it applies to: paths, commands, directory patterns.
    public var resources: [String]
    /// The patterns "Always allow" would save.
    public var save: [String]?
    public var metadata: JSONValue?
    public var source: Source?
    public var message: String?

    public struct Source: Codable, Sendable, Hashable {
        public var type: String
        public var messageID: String
        public var id: String
    }

    public enum Decision: String, Codable, Sendable {
        case once, always, reject
    }

    /// File changes, for edit/write/patch requests.
    public var diffs: [FileDiff] {
        (try? metadata?["files"]?.decode(as: [FileDiff].self)) ?? []
    }
}
