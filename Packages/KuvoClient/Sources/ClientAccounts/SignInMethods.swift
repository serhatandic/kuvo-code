import Foundation
import OpenCodeKit

/// The ways to sign in to an account, as its box offers them (`kuvo/sign-in/methods`, PROTOCOL.md
/// "Signing in"): in the order to draw them, each with the words its button says. The box decides
/// which, the order and the words; a client draws them as they come, the legacy ones apart, after
/// the others.
public struct SignInMethods: Decodable, Sendable, Equatable {
    /// One way in: the engine's own (`method`, as a client starts it with), and the box's words.
    public struct Offered: Decodable, Sendable, Hashable, Identifiable {
        public let method: Integration.Method
        public let label: String
        /// Kept by its maker for older setups: offered apart, after the others.
        public let legacy: Bool

        public var id: String { method.id }

        private enum CodingKeys: String, CodingKey { case label, legacy }

        public init(from decoder: Decoder) throws {
            method = try Integration.Method(from: decoder)
            let container = try decoder.container(keyedBy: CodingKeys.self)
            label = try container.decode(String.self, forKey: .label)
            legacy = try container.decodeIfPresent(Bool.self, forKey: .legacy) ?? false
        }
    }

    public let methods: [Offered]
    /// The environment variables that sign in to it too, set in the computer's shell.
    public let environment: [String]

    /// The ways to offer first, in order.
    public var primary: [Offered] { methods.filter { !$0.legacy } }
    /// Those offered apart, after them.
    public var legacy: [Offered] { methods.filter(\.legacy) }

    /// The feature that says a box answers it, and `SignInStatus` (`kuvo/info`).
    public static let feature = "sign-in.methods"
    public static let route = "kuvo/sign-in/methods"

    /// The route that asks it, for `integration`: a coding agent's account (`agents`) on the
    /// agents' bridge, else the engine's.
    public static func path(integration: String, agents: Bool) -> String {
        route + "?" + SignInQuery.encoded([("integration", integration)] + (agents ? [("agents", "1")] : []))
    }
}

/// How a started sign-in is going, as its box says (`kuvo/sign-in/status`): the engine's (or the
/// agents' bridge's) status, with what to say once it ended without signing in (`failure`).
public struct SignInStatus: Decodable, Sendable, Equatable {
    public let status: OAuthStatus.Status
    /// As the engine says it: how it's going while pending; why it failed, in its own words.
    public let message: String?
    /// The page, its words and its device code, when they come after it started.
    public let url: String?
    public let instructions: String?
    public let userCode: String?
    /// What a client shows once it `failed` or `expired`.
    public let failure: String?

    public static let route = "kuvo/sign-in/status"

    public static func path(integration: String, attempt: String, agents: Bool) -> String {
        route + "?" + SignInQuery.encoded([("integration", integration), ("attempt", attempt)] + (agents ? [("agents", "1")] : []))
    }
}

enum SignInQuery {
    /// `name=value&…`, each value escaped whole ("+" and "&" too, which a query would read otherwise).
    static func encoded(_ items: [(String, String)]) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "+&=?/#")
        return items.map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0.1)" }.joined(separator: "&")
    }
}
