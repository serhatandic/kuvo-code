import Foundation
import OpenCodeKit

/// The usage panel's settings as a box keeps them for every computer of yours (`GET
/// kuvo/agents/api/kuvo/usage/settings`, PROTOCOL.md "Usage settings"): which cards and meters show
/// and in what order, what's pinned, the total spend card's settings, Codex's fallback model and
/// which notifications are on. Your own computers' boxes share them, the newest change winning: a
/// client draws them, sends a part it changed whole, and brings what it kept before in once.
public struct BoxUsageSettings: Decodable, Hashable, Sendable {
    /// Each part a box has (`layout`, `providers`, `totalSpend`, `codexFallback`, `notifications`):
    /// one not there was never set, and is the panel's own default.
    public var settings: JSONValue
    /// Whether what a client kept before came in on this box (once, `bridgeImportPath`).
    public var imported: Bool
    /// The parts that came in with an import.
    public var took: [String]

    private enum CodingKeys: String, CodingKey { case settings, imported, took }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        settings = (try? container.decodeIfPresent(JSONValue.self, forKey: .settings)) ?? .object([:])
        imported = (try? container.decodeIfPresent(Bool.self, forKey: .imported)) ?? false
        took = (try? container.decodeIfPresent([String].self, forKey: .took)) ?? []
    }

    /// Where a box's bridge answers them; `PUT` the parts changed, each whole, answered the same.
    public static let bridgePath = "api/kuvo/usage/settings"
    /// `POST` what a client kept before: the parts no box has set come in, once.
    public static let bridgeImportPath = "api/kuvo/usage/settings/import"
    /// The event that says they changed, on the bridge's events: ask again.
    public static let event = "kuvo.usage.settings"
}
