import Foundation

/// A question for the user: from the agent's question tool, from an MCP server,
/// or a sign-in method that needs details first. One schema serves them all.
public struct FormRequest: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var sessionID: String
    public var title: String
    public var metadata: JSONValue?
    public var fields: [FormField]

    /// Set when the agent's question tool asked it.
    public var isQuestion: Bool { metadata?["kind"]?.string == "question" }

    /// Where the engine files what MCP servers ask: a server can't say which session it's
    /// answering, so its forms belong to no session, only to the project folder. Listing and
    /// answering them takes that folder.
    public static let anySession = "global"

    /// The MCP server asking, for a form one asked for.
    public var server: String? { metadata?["kind"]?.string == "mcp-elicitation" ? metadata?["server"]?.string : nil }

    /// What the server says with its form.
    public var message: String? { server == nil ? nil : metadata?["message"]?.string }

    /// What the agent's question asks, when it asks one thing with an answer in words or one of
    /// its choices (a notification can take that); nil for anything more.
    public var single: Single? {
        guard isQuestion else { return nil }
        let fields = fields.filter { !$0.isHidden && $0.isActive(given: [:]) }
        guard fields.count == 1, let field = fields.first, case .string(let options, let allowsCustom, _, _, _, _) = field.kind else { return nil }
        let choices = options ?? []
        // The question tool puts its header in the title and the question in the description.
        return Single(key: field.key, text: field.description ?? field.title ?? title, choices: choices, allowsText: allowsCustom || choices.isEmpty)
    }

    public struct Single: Sendable, Hashable {
        public let key: String
        public let text: String
        public let choices: [FormField.Option]
        public let allowsText: Bool
    }
}

public struct FormField: Codable, Sendable, Hashable, Identifiable {
    public var key: String
    public var title: String?
    public var description: String?
    public var required: Bool?
    public var hidden: Bool?
    /// Shown only when every condition holds.
    public var when: [Condition]?
    public var kind: Kind

    public var id: String { key }

    public struct Condition: Codable, Sendable, Hashable {
        public var key: String
        public var op: String
        public var value: FormValue
    }

    public struct Option: Codable, Sendable, Hashable, Identifiable {
        public var value: String
        public var label: String
        public var description: String?

        public var id: String { value }
    }

    public enum Kind: Sendable, Hashable {
        case string(options: [Option]?, allowsCustom: Bool, placeholder: String?, defaultValue: String?, format: String?, pattern: String?)
        case number(isInteger: Bool, minimum: Double?, maximum: Double?, defaultValue: Double?)
        case boolean(defaultValue: Bool?)
        case multiselect(options: [Option], allowsCustom: Bool, minItems: Int?, maxItems: Int?, defaultValue: [String]?)
        /// "Go to this page" — answered with `true` once the user acknowledges it.
        case external(url: String)
        case other(type: String)
    }

    private enum CodingKeys: String, CodingKey {
        case key, title, description, required, hidden, when, type, options, custom, placeholder, format, pattern, minimum, maximum, minItems, maxItems, url
        case defaultValue = "default"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        required = try c.decodeIfPresent(Bool.self, forKey: .required)
        hidden = try c.decodeIfPresent(Bool.self, forKey: .hidden)
        when = try c.decodeIfPresent([Condition].self, forKey: .when)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "string":
            kind = .string(
                options: try c.decodeIfPresent([Option].self, forKey: .options),
                allowsCustom: try c.decodeIfPresent(Bool.self, forKey: .custom) ?? false,
                placeholder: try c.decodeIfPresent(String.self, forKey: .placeholder),
                defaultValue: try c.decodeIfPresent(String.self, forKey: .defaultValue),
                format: try c.decodeIfPresent(String.self, forKey: .format),
                pattern: try c.decodeIfPresent(String.self, forKey: .pattern)
            )
        case "number", "integer":
            kind = .number(
                isInteger: type == "integer",
                minimum: try c.decodeIfPresent(Double.self, forKey: .minimum),
                maximum: try c.decodeIfPresent(Double.self, forKey: .maximum),
                defaultValue: try c.decodeIfPresent(Double.self, forKey: .defaultValue)
            )
        case "boolean":
            kind = .boolean(defaultValue: try c.decodeIfPresent(Bool.self, forKey: .defaultValue))
        case "multiselect":
            kind = .multiselect(
                options: try c.decodeIfPresent([Option].self, forKey: .options) ?? [],
                allowsCustom: try c.decodeIfPresent(Bool.self, forKey: .custom) ?? false,
                minItems: try c.decodeIfPresent(Int.self, forKey: .minItems),
                maxItems: try c.decodeIfPresent(Int.self, forKey: .maxItems),
                defaultValue: try c.decodeIfPresent([String].self, forKey: .defaultValue)
            )
        case "external":
            kind = .external(url: try c.decode(String.self, forKey: .url))
        default:
            kind = .other(type: type)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(key, forKey: .key)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(description, forKey: .description)
        try c.encodeIfPresent(required, forKey: .required)
        try c.encodeIfPresent(hidden, forKey: .hidden)
        try c.encodeIfPresent(when, forKey: .when)
        switch kind {
        case .string(let options, let custom, let placeholder, let defaultValue, let format, let pattern):
            try c.encode("string", forKey: .type)
            try c.encodeIfPresent(options, forKey: .options)
            try c.encode(custom, forKey: .custom)
            try c.encodeIfPresent(placeholder, forKey: .placeholder)
            try c.encodeIfPresent(defaultValue, forKey: .defaultValue)
            try c.encodeIfPresent(format, forKey: .format)
            try c.encodeIfPresent(pattern, forKey: .pattern)
        case .number(let isInteger, let minimum, let maximum, let defaultValue):
            try c.encode(isInteger ? "integer" : "number", forKey: .type)
            try c.encodeIfPresent(minimum, forKey: .minimum)
            try c.encodeIfPresent(maximum, forKey: .maximum)
            try c.encodeIfPresent(defaultValue, forKey: .defaultValue)
        case .boolean(let defaultValue):
            try c.encode("boolean", forKey: .type)
            try c.encodeIfPresent(defaultValue, forKey: .defaultValue)
        case .multiselect(let options, let custom, let minItems, let maxItems, let defaultValue):
            try c.encode("multiselect", forKey: .type)
            try c.encode(options, forKey: .options)
            try c.encode(custom, forKey: .custom)
            try c.encodeIfPresent(minItems, forKey: .minItems)
            try c.encodeIfPresent(maxItems, forKey: .maxItems)
            try c.encodeIfPresent(defaultValue, forKey: .defaultValue)
        case .external(let url):
            try c.encode("external", forKey: .type)
            try c.encode(url, forKey: .url)
        case .other(let type):
            try c.encode(type, forKey: .type)
        }
    }

    public var isRequired: Bool { required ?? false }
    public var isHidden: Bool { hidden ?? false }

    public var defaultValue: FormValue? {
        switch kind {
        case .string(_, _, _, let value, _, _): value.map(FormValue.string)
        case .number(_, _, _, let value): value.map(FormValue.number)
        case .boolean(let value): value.map(FormValue.bool)
        case .multiselect(_, _, _, _, let value): value.map(FormValue.list)
        case .external, .other: nil
        }
    }

    /// Whether the field applies, given the answers so far.
    public func isActive(given answers: [String: FormValue]) -> Bool {
        (when ?? []).allSatisfy { condition in
            let value = answers[condition.key]
            return condition.op == "neq" ? value != condition.value : value == condition.value
        }
    }
}

/// An answer to one field.
public enum FormValue: Codable, Sendable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case list([String])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let value = try? c.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? c.decode(Double.self) {
            self = .number(value)
        } else if let value = try? c.decode([String].self) {
            self = .list(value)
        } else {
            self = .string(try c.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let value): try c.encode(value)
        case .number(let value): try c.encode(value)
        case .bool(let value): try c.encode(value)
        case .list(let value): try c.encode(value)
        }
    }
}

public typealias FormAnswer = [String: FormValue]
