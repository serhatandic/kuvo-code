import Foundation
import OpenCodeKit

/// What a box offers (`kuvo/models/offered`, KuvoLink's PROTOCOL.md, "The models offered"): every
/// model that runs there now, as a picker offers it, and the model a new session there starts on.
/// The box decides both by one rule, from what its engine and coding agents list, so every client's
/// picker offers the same and a new conversation starts on the same model wherever it's begun; a
/// client draws them.
public struct OfferedModels: Decodable, Equatable, Sendable {
    /// A model that runs there now.
    public struct Entry: Decodable, Equatable, Sendable {
        public var providerID: String
        public var id: String
        public var name: String
        /// Its provider is retiring it: a picker leaves it out, though a conversation on it carries on.
        public var retiring: Bool

        public init(providerID: String, id: String, name: String, retiring: Bool = false) {
            self.providerID = providerID
            self.id = id
            self.name = name
            self.retiring = retiring
        }

        private enum CodingKeys: String, CodingKey { case providerID, id, name, retiring }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            providerID = try container.decode(String.self, forKey: .providerID)
            id = try container.decode(String.self, forKey: .id)
            name = try container.decodeIfPresent(String.self, forKey: .name) ?? id
            retiring = try container.decodeIfPresent(Bool.self, forKey: .retiring) ?? false
        }
    }

    /// Whether the engine's models, and the coding agents' (with Custom Auto's lists), could be
    /// said: one that couldn't (not answering, still loading) has none in `models`, rather than none.
    public struct Known: Decodable, Equatable, Sendable {
        public var engine: Bool
        public var agents: Bool

        public init(engine: Bool, agents: Bool) {
            self.engine = engine
            self.agents = agents
        }
    }

    public var models: [Entry] {
        didSet { index = Self.index(models) }
    }
    public var known: Known
    /// The model a new session starts on, for the one asked about: `.some(nil)` for none (nothing
    /// runs there); nil where it wasn't said (the engine can't say yet).
    public var starting: ModelRef??

    /// `models` by provider and id, for `runs` (asked of every model a picker draws).
    private var index: Set<String>

    private static func index(_ models: [Entry]) -> Set<String> {
        Set(models.map { key($0.providerID, $0.id) })
    }

    private static func key(_ providerID: String, _ id: String) -> String { providerID + "\u{0}" + id }

    public init(models: [Entry], known: Known, starting: ModelRef?? = nil) {
        self.models = models
        self.known = known
        self.starting = starting
        index = Self.index(models)
    }

    private enum CodingKeys: String, CodingKey { case models, known, starting }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let models = try container.decode([Entry].self, forKey: .models)
        self.models = models
        index = Self.index(models)
        known = try container.decode(Known.self, forKey: .known)
        starting = container.contains(.starting) ? .some(try container.decodeIfPresent(ModelRef.self, forKey: .starting)) : nil
    }

    /// The route a box answers it on, and the feature that says it does (`kuvo/info`).
    public static let route = "kuvo/models/offered"
    public static let feature = "models.offered"

    /// The route that asks it, as a link request's path (query and all): for a new session that
    /// would start on `wanted` (the model picked last), in `folder` (a project's own settings may
    /// add models there).
    public static func path(wanted: ModelRef? = nil, folder: String? = nil) -> String {
        var query: [URLQueryItem] = []
        if let wanted {
            query.append(URLQueryItem(name: "provider", value: wanted.providerID))
            query.append(URLQueryItem(name: "model", value: wanted.id))
            if let variant = wanted.variant { query.append(URLQueryItem(name: "variant", value: variant)) }
        }
        if let folder { query.append(URLQueryItem(name: "folder", value: folder)) }
        guard !query.isEmpty else { return route }
        var parts = URLComponents()
        parts.queryItems = query
        // ("+" stays as it is in a query; the box would read it as a space.)
        return route + "?" + (parts.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
    }

    /// Whether `providerID`'s models are among the coding agents' (with Custom Auto's lists), as
    /// the box tells them apart: `isAgent` says which providers are a coding agent's.
    private func isKnown(_ providerID: String, isAgent: (String) -> Bool) -> Bool {
        isAgent(providerID) ? known.agents : known.engine
    }

    /// Whether `ref` runs there now: true or false where its side was said, nil where it wasn't.
    /// By its own id (a picker's models are listed by theirs).
    public func runs(_ ref: ModelRef, isAgent: (String) -> Bool) -> Bool? {
        guard isKnown(ref.providerID, isAgent: isAgent) else { return nil }
        return index.contains(Self.key(ref.providerID, ref.id))
    }

    /// This answer, with what `before` said of a side this one couldn't say (the agents' bridge
    /// not answering a moment, say): what was offered stays offered until the box can say again.
    public func keeping(_ before: OfferedModels?, isAgent: (String) -> Bool) -> OfferedModels {
        guard let before, !known.engine || !known.agents else { return self }
        var merged = self
        if !known.engine, before.known.engine {
            merged.models.insert(contentsOf: before.models.filter { !isAgent($0.providerID) }, at: 0)
            merged.known.engine = true
        }
        if !known.agents, before.known.agents {
            merged.models += before.models.filter { isAgent($0.providerID) }
            merged.known.agents = true
        }
        return merged
    }
}
