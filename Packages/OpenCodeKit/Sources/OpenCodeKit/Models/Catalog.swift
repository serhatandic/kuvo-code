import Foundation

/// A model the engine can use.
public struct Model: Codable, Sendable, Hashable, Identifiable {
    /// The engine's id, unique within its provider.
    public var id: String
    /// The id the provider is sent, when the engine says: another than `id` for a model set up
    /// under a name of its own (an Azure deployment, another name for a model).
    public var modelID: String?
    public var providerID: String
    public var name: String
    public var family: String?
    /// Other ids the box knows it by, which a saved pick or a conversation may still name it with:
    /// Claude Code's `default` is the model it recommends now, listed under its own id.
    public var aliases: [String]?
    public var capabilities: Capabilities
    /// Reasoning-effort presets (`low`, `high`, …), selected with `ModelRef.variant`.
    public var variants: [Variant]
    public var time: Time
    public var cost: [Cost]
    public var status: String
    public var enabled: Bool
    public var limit: Limit

    public struct Capabilities: Codable, Sendable, Hashable {
        public var tools: Bool
        public var input: [String]
        public var output: [String]
    }

    public struct Variant: Codable, Sendable, Hashable, Identifiable {
        public var id: String
    }

    public struct Time: Codable, Sendable, Hashable {
        public var released: Milliseconds
    }

    /// US dollars per million tokens.
    public struct Cost: Codable, Sendable, Hashable {
        public var input: Double
        public var output: Double
    }

    public struct Limit: Codable, Sendable, Hashable {
        public var context: Int
        /// How much of the window a request may take, when the provider allows less than all of
        /// it (OpenAI's and GitHub Copilot's models); 0 or nil when it doesn't say.
        public var input: Int?
        public var output: Int

        /// What the conversation can fill: the engine summarizes it before this, as it does.
        public var usable: Int {
            if let input, input > 0 { return input }
            return context
        }
    }

    public var ref: ModelRef { ModelRef(id: id, providerID: providerID) }

    /// Whether `ref` names this model: by its id, or an alias of it.
    public func isNamed(by ref: ModelRef) -> Bool {
        providerID == ref.providerID && (id == ref.id || aliases?.contains(ref.id) == true)
    }
    public var key: String { providerID + "/" + id }
    public var acceptsImages: Bool { capabilities.input.contains("image") }
    public var isFree: Bool { cost.allSatisfy { $0.input == 0 && $0.output == 0 } }
    /// Its provider is retiring it.
    public var isDeprecated: Bool { status == "deprecated" }
}

extension Collection where Element == Model {
    /// Saved model keys (starred, picked last), each as the key of the model it names now: a key
    /// that names one by an alias becomes that model's own, and two that come to the same model
    /// are one. One naming no model here stays as it is.
    public func canonicalKeys(_ saved: [String]) -> [String] {
        var seen = Set<String>()
        return saved.compactMap { key in
            let own = first { $0.key == key } ?? first { model in model.aliases?.contains { model.providerID + "/" + $0 == key } == true }
            let canonical = own?.key ?? key
            return seen.insert(canonical).inserted ? canonical : nil
        }
    }
}

/// Model-serving configuration that's ready to use (its integration is connected,
/// or it needs no sign-in).
public struct Provider: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var canonical: String?
    public var integrationID: String?
    public var name: String
    public var activation: String
}

/// Something you can sign in to: an AI provider, a web-search service, an MCP server.
public struct Integration: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var metadata: JSONValue?
    public var methods: [Method]
    public var connections: [Connection]

    public var isConnected: Bool { !connections.isEmpty }
    public var isMCP: Bool { metadata?["source"]?.string == "mcp" }

    /// What the user can pick from (environment variables aren't something you "choose").
    public var signInMethods: [Method] {
        methods.filter { if case .environment = $0 { false } else { true } }
    }

    public var environmentVariables: [String] {
        methods.flatMap { method -> [String] in
            if case .environment(let names) = method { names } else { [] }
        }
    }

    public enum Method: Codable, Sendable, Hashable, Identifiable {
        case oauth(id: String, label: String, form: [FormField]?)
        case key(label: String?, form: [FormField]?)
        case external(id: String, label: String, form: [FormField]?)
        case command(id: String, label: String)
        case environment(names: [String])
        case other(type: String)

        public var id: String {
            switch self {
            case .oauth(let id, _, _): "oauth:" + id
            case .key: "key"
            case .external(let id, _, _): "external:" + id
            case .command(let id, _): "command:" + id
            case .environment: "env"
            case .other(let type): type
            }
        }

        public var form: [FormField] {
            switch self {
            case .oauth(_, _, let form), .key(_, let form), .external(_, _, let form): form ?? []
            default: []
            }
        }

        private enum CodingKeys: String, CodingKey { case type, id, label, form, names, command }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let type = try c.decode(String.self, forKey: .type)
            switch type {
            case "oauth":
                self = .oauth(id: try c.decode(String.self, forKey: .id), label: try c.decode(String.self, forKey: .label), form: try c.decodeIfPresent([FormField].self, forKey: .form))
            case "key":
                self = .key(label: try c.decodeIfPresent(String.self, forKey: .label), form: try c.decodeIfPresent([FormField].self, forKey: .form))
            case "external":
                self = .external(id: try c.decode(String.self, forKey: .id), label: try c.decode(String.self, forKey: .label), form: try c.decodeIfPresent([FormField].self, forKey: .form))
            case "command":
                self = .command(id: try c.decode(String.self, forKey: .id), label: try c.decode(String.self, forKey: .label))
            case "env":
                self = .environment(names: try c.decodeIfPresent([String].self, forKey: .names) ?? [])
            default:
                self = .other(type: type)
            }
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .oauth(let id, let label, let form):
                try c.encode("oauth", forKey: .type); try c.encode(id, forKey: .id); try c.encode(label, forKey: .label); try c.encodeIfPresent(form, forKey: .form)
            case .key(let label, let form):
                try c.encode("key", forKey: .type); try c.encodeIfPresent(label, forKey: .label); try c.encodeIfPresent(form, forKey: .form)
            case .external(let id, let label, let form):
                try c.encode("external", forKey: .type); try c.encode(id, forKey: .id); try c.encode(label, forKey: .label); try c.encodeIfPresent(form, forKey: .form)
            case .command(let id, let label):
                try c.encode("command", forKey: .type); try c.encode(id, forKey: .id); try c.encode(label, forKey: .label)
            case .environment(let names):
                try c.encode("env", forKey: .type); try c.encode(names, forKey: .names)
            case .other(let type):
                try c.encode(type, forKey: .type)
            }
        }
    }

    /// A stored credential, or an environment variable the engine found.
    public struct Connection: Codable, Sendable, Hashable, Identifiable {
        public var type: String
        /// The credential id, for `credential` connections.
        public var credentialID: String?
        public var label: String?
        /// `key`, `oauth` or `external`.
        public var method: String?
        /// The variable name, for `env` connections.
        public var name: String?
        public var status: Status?

        public var id: String { credentialID ?? name ?? type }

        public struct Status: Codable, Sendable, Hashable {
            public var status: String
            public var message: String
            public var url: String?
        }

        private enum CodingKeys: String, CodingKey {
            case type, credentialID = "id", label, method, name, status
        }
    }
}

/// A credential the engine stores. The list endpoint includes the secret, so the
/// app only keeps the parts it shows.
public struct Credential: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var integrationID: String
    public var label: String
    public var active: Bool
}

/// A stored credential with its secret, for features that call a provider directly
/// (the usage panel). Kept in memory only.
public struct CredentialSecret: Decodable, Sendable {
    public var id: String
    public var integrationID: String
    public var active: Bool
    public var value: Value

    public struct Value: Decodable, Sendable {
        public var type: String
        public var methodID: String?
        public var access: String?
        public var key: String?
        /// Milliseconds since 1970; 0 when it doesn't expire.
        public var expires: Double?
        public var metadata: JSONValue?
    }
}

/// A stored credential as the engine keeps it, its value untouched (for an OAuth one: its
/// method, access and refresh tokens, and when it expires), to store in another engine.
public struct CredentialEntry: Decodable, Sendable {
    public var id: String
    public var integrationID: String
    public var label: String
    public var active: Bool
    public var value: JSONValue

    /// An OAuth sign-in's expiry, in milliseconds since 1970 (later is newer).
    public var expires: Double { value["expires"]?.number ?? 0 }
    public var isOAuth: Bool { value["type"]?.string == "oauth" }
}

/// A started OAuth sign-in. Open `url`; with `mode == .auto` the engine finishes
/// on its own and the app polls for the result.
public struct OAuthAttempt: Codable, Sendable, Hashable {
    public var attemptID: String
    public var url: String
    public var instructions: String
    public var mode: Mode
    /// With `.auto`: the page may end on a code to paste instead, when it couldn't come back by
    /// itself (Claude Code's sign-in, through the coding agents).
    public var acceptsCode: Bool?
    public var time: Window

    public enum Mode: String, Codable, Sendable {
        /// The engine catches the redirect or polls the device code itself.
        case auto
        /// The user pastes a code back.
        case code
    }

    public struct Window: Codable, Sendable, Hashable {
        public var created: Milliseconds
        public var expires: Milliseconds
    }

    /// The code a device-login page asks for ("Enter code: ABCD-1234"), if there is one.
    public var userCode: String? {
        if let components = URLComponents(string: url), let code = components.queryItems?.first(where: { $0.name == "user_code" })?.value {
            return code
        }
        let pattern = /[A-Z0-9]{4}-[A-Z0-9]{4,5}/
        if let match = instructions.firstMatch(of: pattern) { return String(match.output) }
        if let range = instructions.range(of: "code:", options: [.caseInsensitive, .backwards]) {
            let code = instructions[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
            return code.isEmpty || code.contains(" ") ? nil : code
        }
        return nil
    }
}

public struct OAuthStatus: Codable, Sendable, Hashable {
    public var status: Status
    public var message: String?
    /// The page to sign in on, when it comes after the attempt started (the agents bridge has an
    /// agent to download first); while pending, `message` says how it's going.
    public var url: String?

    public enum Status: String, Codable, Sendable {
        case pending, complete, failed, expired
    }
}

/// A way of working: `build` (does things), `plan` (read-only), or a custom one.
public struct Agent: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var description: String?
    public var mode: String
    public var hidden: Bool
    public var color: String?
    public var model: ModelRef?

    /// The agents a person picks between; the rest are used by the agent itself.
    public var isPrimary: Bool { mode != "subagent" && !hidden }
}

public struct Command: Codable, Sendable, Hashable, Identifiable {
    public var name: String
    public var description: String?

    public var id: String { name }
}

public struct ServerInfo: Codable, Sendable, Hashable {
    public var version: String
    public var pid: Int
}

public struct VCSInfo: Codable, Sendable, Hashable {
    public var provider: String?
    public var branch: Branch?

    public struct Branch: Codable, Sendable, Hashable {
        public var current: String?
        public var `default`: String?
    }
}
