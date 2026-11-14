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
    /// The way in its card names under its name ("Sign in with ChatGPT", "API key", "Connect").
    public let hint: String

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

/// Every account a computer's engine (or its coding agents' bridge) lists, with its ways in, as its
/// box says them (`kuvo/sign-in/accounts`): what Accounts' Sign In buttons and each card's hint go by.
public struct SignInAccounts: Decodable, Sendable, Equatable {
    /// By account.
    public let accounts: [String: SignInMethods]

    private struct Entry: Decodable {
        let id: String
        let ways: SignInMethods
        private enum CodingKeys: String, CodingKey { case id }
        init(from decoder: Decoder) throws {
            id = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .id)
            ways = try SignInMethods(from: decoder)
        }
    }

    private enum CodingKeys: String, CodingKey { case accounts }

    /// None said yet.
    public static let none = SignInAccounts(accounts: [:])

    public init(accounts: [String: SignInMethods]) {
        self.accounts = accounts
    }

    public init(from decoder: Decoder) throws {
        let entries = try decoder.container(keyedBy: CodingKeys.self).decode([Entry].self, forKey: .accounts)
        accounts = Dictionary(entries.map { ($0.id, $0.ways) }) { first, _ in first }
    }

    /// Whether `id` has a way in a client can offer; false where its box hasn't said.
    public func offersSignIn(_ id: String) -> Bool {
        accounts[id].map { !$0.methods.isEmpty } ?? false
    }

    public static let route = "kuvo/sign-in/accounts"

    public static func path(agents: Bool) -> String {
        agents ? route + "?agents=1" : route
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

    /// `wait`: seconds its box may wait for a change before it answers a sign-in still going, for
    /// a box asked through a process run each time (a machine's, over SSH).
    public static func path(integration: String, attempt: String, agents: Bool, wait: Int? = nil) -> String {
        route + "?" + SignInQuery.encoded([("integration", integration), ("attempt", attempt)] + (agents ? [("agents", "1")] : []) + (wait.map { [("wait", String($0))] } ?? []))
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
