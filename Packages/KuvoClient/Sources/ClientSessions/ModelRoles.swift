import Foundation
import OpenCodeKit

/// A box's model roles (PROTOCOL.md, "Model roles"), as `GET kuvo/models/roles` answers: which
/// models do the work (Power), the chores (Chore) and a goal step's rerun (Rescue) there, who set
/// each, and why the box picked it.
public struct ModelRoles: Decodable, Sendable, Hashable {
    public var roles: [Role]

    public init(roles: [Role]) { self.roles = roles }

    public struct Role: Decodable, Sendable, Hashable, Identifiable {
        public var id: String
        public var entries: [Entry]
        /// "you", or "box" where the box picked it from the models that answer there.
        public var setBy: String
        public var why: String?
        /// The box has asked you about it once (a goal's card), whatever you answered.
        public var asked: Bool

        public init(id: String, entries: [Entry], setBy: String, why: String? = nil, asked: Bool = false) {
            self.id = id
            self.entries = entries
            self.setBy = setBy
            self.why = why
            self.asked = asked
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            entries = try container.decodeIfPresent([Entry].self, forKey: .entries) ?? []
            setBy = try container.decodeIfPresent(String.self, forKey: .setBy) ?? "box"
            why = try container.decodeIfPresent(String.self, forKey: .why)
            asked = try container.decodeIfPresent(Bool.self, forKey: .asked) ?? false
        }

        private enum CodingKeys: String, CodingKey { case id, entries, setBy, why, asked }

        /// Its first model, as a model to pick.
        public var model: ModelRef? { entries.first.map { ModelRef(id: $0.modelID, providerID: $0.providerID, variant: $0.variant) } }
    }

    public struct Entry: Codable, Sendable, Hashable {
        public var providerID: String
        public var modelID: String
        public var name: String?
        public var variant: String?
        public var held: Bool?

        public init(providerID: String, modelID: String, name: String? = nil, variant: String? = nil, held: Bool? = nil) {
            self.providerID = providerID
            self.modelID = modelID
            self.name = name
            self.variant = variant
            self.held = held
        }
    }

    /// Power, the role a goal's work runs on.
    public var power: Role? { roles.first { $0.id == "power" } }

    /// A goal's card asks once which model does the work, while the box picked it and hasn't asked.
    public var asksOnGoalCard: Bool {
        guard let power else { return false }
        return power.setBy == "box" && !power.asked
    }

    /// `PUT kuvo/models/roles`: Power on `model`, as yours, box-wide from then on.
    public struct Set: Encodable, Sendable {
        public var id = "power"
        public var entries: [Entry]

        public init(_ model: ModelRef) {
            entries = [Entry(providerID: model.providerID, modelID: model.id, variant: model.variant)]
        }
    }

    /// `PUT kuvo/models/roles`: you were asked on a goal's card and kept the box's pick. It's
    /// never asked again.
    public struct Asked: Encodable, Sendable {
        public var id = "power"
        public var asked = true
        public init() {}
    }
}
