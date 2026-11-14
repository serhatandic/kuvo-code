import Foundation

/// A shell the engine can run commands in.
public struct ShellOption: Codable, Sendable, Hashable, Identifiable {
    public var name: String
    public var path: String
    public var acceptable: Bool

    public var id: String { path }
}

/// An MCP server the engine knows, and whether it's connected.
public struct MCPServer: Decodable, Sendable, Hashable, Identifiable {
    public var name: String
    public var status: Status
    /// Where its sign-in goes, for a server that needs one.
    public var integrationID: String?

    public var id: String { name }

    public struct Status: Decodable, Sendable, Hashable {
        /// `connected`, `pending`, `disabled`, `failed` or `needs_auth`.
        public var status: String
        public var error: String?
    }
}

/// A skill the agent can use, wherever it was found.
public struct Skill: Decodable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var description: String?
    /// Its file, or a `/builtin/…` path for the engine's own.
    public var path: String?
}

public struct WebSearchProvider: Decodable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
}

/// A plugin the engine loaded, its own or one from the settings.
public struct PluginInfo: Decodable, Sendable, Hashable, Identifiable {
    /// The engine's name for it; one that failed to load has none, and goes by what it was added
    /// as (`source.entry`).
    public var id: String
    public var source: Source
    public var state: State

    public struct Source: Decodable, Sendable, Hashable {
        /// `builtin`, or where a configured plugin came from: `package` (npm) or `local` (a folder).
        public var type: String
        /// A package's name as the settings give it (with a version, if they do).
        public var target: String?
        /// The version installed, for a package that loaded.
        public var version: String?
        /// A local plugin's folder.
        public var path: String?

        /// What it was added as in the settings: a package's name or a local plugin's folder.
        public var entry: String? { target ?? path }
    }

    public struct State: Decodable, Sendable, Hashable {
        /// `active` or `failed`.
        public var status: String
        public var error: String?
    }

    private enum CodingKeys: String, CodingKey { case id, source, state }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        source = try container.decode(Source.self, forKey: .source)
        state = try container.decode(State.self, forKey: .state)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? source.entry ?? ""
    }
}

/// An approval saved with "Always": the agent may do this in that project without asking.
public struct SavedPermission: Decodable, Sendable, Hashable, Identifiable {
    public var id: String
    public var projectID: String
    public var action: String
    public var resource: String
}
