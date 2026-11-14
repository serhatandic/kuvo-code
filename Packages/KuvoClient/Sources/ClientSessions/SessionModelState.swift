import ClientAccounts
import Foundation
import OpenCodeKit

/// What a session's box says of its model (`kuvo/sessions/models`, KuvoLink's PROTOCOL.md, "A
/// session's model"): the model it runs on, whether that can run now, what's missing if not, and
/// what that means for a composer, decided and worded by the box (`refusal`, `choose`, `action`), so
/// every client shows the same and none decides or words it; a client draws it: the model button's
/// name (or "Choose a Model"), Send (`ComposerSend`), what a message refused says, and a sign-in
/// card's button and help. Held to Packages/KuvoLink/Vectors/model-readiness.json.
public struct SessionModelState: Decodable, Equatable, Sendable {
    /// What a model that can't run needs.
    public enum Missing: Equatable, Sendable {
        /// None chosen, and no default: choose one.
        case model
        /// A sign-in to `account`.
        case signIn
        /// A key for `account`, the only way Accounts offers to sign in to it.
        case key
        /// `account`'s coding agent installed.
        case install
        /// Gone from its provider's (or its agent's) list: choose another.
        case gone
        /// One a newer box says that this client doesn't know.
        case other(String)
    }

    /// An account, as Accounts names it ("Claude Code · Work", with `label` "Work").
    public struct Account: Decodable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var label: String?

        public init(id: String, name: String, label: String? = nil) {
            self.id = id
            self.name = name
            self.label = label
        }
    }

    /// A plan that goes through a coding agent of its own (SuperGrok through Grok), for a key the
    /// engine's provider needs.
    public struct Plan: Decodable, Equatable, Sendable {
        public var name: String
        public var agent: String
        public var provider: String

        public init(name: String, agent: String, provider: String) {
            self.name = name
            self.agent = agent
            self.provider = provider
        }
    }

    /// What to offer doing about a model that can't run, as its box words it: `label` a button's
    /// words ("Sign In", "Add Key", "Install", "Choose a Model"), `help` what it does ("Sign in to
    /// Anthropic").
    public struct Action: Decodable, Equatable, Sendable {
        public enum Kind: Equatable, Sendable {
            /// Signing in to its `account`.
            case signIn
            /// Adding its `account`'s key.
            case addKey
            /// Installing its `account`'s coding agent.
            case install
            /// Choosing a model.
            case choose
            /// One a newer box says that this client doesn't know.
            case other(String)
        }

        public var kind: Kind
        public var label: String
        public var help: String

        public init(kind: Kind, label: String, help: String) {
            self.kind = kind
            self.label = label
            self.help = help
        }

        private enum CodingKeys: String, CodingKey { case kind = "do", label, help }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let word = try container.decode(String.self, forKey: .kind)
            kind = switch word {
            case "signIn": .signIn
            case "addKey": .addKey
            case "install": .install
            case "choose": .choose
            default: .other(word)
            }
            label = try container.decode(String.self, forKey: .label)
            help = try container.decode(String.self, forKey: .help)
        }

        /// It's about the model's account: signing in, adding a key, or installing its agent.
        public var isAccount: Bool {
            switch kind {
            case .signIn, .addKey, .install: true
            default: false
            }
        }
    }

    /// The model it runs on: its own, else the engine's default; nil for none.
    public var model: ModelRef?
    /// Its name, as its provider or agent lists it (nil for one gone from the list).
    public var name: String?
    public var runs: Bool
    public var missing: Missing?
    /// The account to sign in to, add a key for or install; for one gone, its provider.
    public var account: Account?
    public var plan: Plan?
    /// Why a message on it can't go, and what to do, in its box's words; nil for one that can go.
    public var refusal: String?
    /// The model button asks for a model ("Choose a Model") and Send waits for one: one gone, or
    /// none to run on.
    public var choose: Bool
    /// What to offer doing about it; nil for one that runs.
    public var action: Action?

    public init(model: ModelRef?, name: String? = nil, runs: Bool, missing: Missing? = nil, account: Account? = nil, plan: Plan? = nil, refusal: String? = nil, choose: Bool = false, action: Action? = nil) {
        self.model = model
        self.name = name
        self.runs = runs
        self.missing = missing
        self.account = account
        self.plan = plan
        self.refusal = refusal
        self.choose = choose
        self.action = action
    }

    private enum CodingKeys: String, CodingKey { case model, name, runs, missing, account, plan, refusal, choose, action }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        model = try container.decodeIfPresent(ModelRef.self, forKey: .model)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        runs = try container.decode(Bool.self, forKey: .runs)
        missing = try container.decodeIfPresent(String.self, forKey: .missing).map { word in
            switch word {
            case "model": .model
            case "signIn": .signIn
            case "key": .key
            case "install": .install
            case "gone": .gone
            default: .other(word)
            }
        }
        account = try container.decodeIfPresent(Account.self, forKey: .account)
        plan = try container.decodeIfPresent(Plan.self, forKey: .plan)
        refusal = try container.decodeIfPresent(String.self, forKey: .refusal)
        choose = try container.decodeIfPresent(Bool.self, forKey: .choose) ?? false
        action = try container.decodeIfPresent(Action.self, forKey: .action)
    }

    /// The route a box answers it on, `sessions=<id>,<id>…` its query.
    public static let route = "kuvo/sessions/models"

    /// The route that asks it for `sessions`, as a link request's path (query and all).
    public static func path(_ sessions: [String]) -> String {
        route + "?sessions=" + sessions.joined(separator: ",")
    }

    /// Whether this is said of `ref`, the model a composer shows (nil: a session with none of its
    /// own, which runs on the box's default): until the box is asked again after another is
    /// picked, what it said is of the one before.
    public func isAbout(_ ref: ModelRef?) -> Bool {
        guard let ref else { return true }
        return ref.sameModel(as: model)
    }

    /// The model button names the model, and Send sends with it, unless its box says to choose
    /// one (`choose`): one that runs, or one whose account needs something (a message on it says
    /// what, instead of going).
    public var namesModel: Bool { !choose }

    /// What a failed turn's card button says for the model the turn `failed` on: its box's
    /// `action.label` (Add Key, Install, Sign In), or Sign In Again for a sign-in that `ended`.
    /// Only where this is said of that model (the conversation's now) and its account: nil for
    /// another model or account, or one that needs none of those, which the app's own words say then.
    public func cardButton(for failed: ModelRef, ended: Bool) -> String? {
        guard isAbout(failed), account?.id == failed.providerID, let action, action.isAccount else { return nil }
        return ended && action.kind == .signIn ? "Sign In Again" : action.label
    }

    /// Its account needs something before it runs: a sign-in, a key, or its agent installed.
    public var needsAccount: Bool { action?.isAccount == true }

    /// What a sign-in card's button for `provider` does, as its box words it ("Add an xAI key
    /// (…)"), where it's this model's account. Nil for another account, or one that needs nothing.
    public func signInHelp(_ provider: String) -> String? {
        guard account?.id == provider, let action, action.isAccount else { return nil }
        return action.help
    }
}

/// What a box answers `kuvo/sessions/models` with: each session asked for that it could say about.
public struct SessionModelStates: Decodable, Sendable {
    public var sessions: [String: SessionModelState]
}
