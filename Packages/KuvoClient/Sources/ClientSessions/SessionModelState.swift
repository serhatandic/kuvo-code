import ClientAccounts
import Foundation
import OpenCodeKit

/// What a session's box says of its model (`kuvo/sessions/models`, KuvoLink's PROTOCOL.md, "A
/// session's model"): the model it runs on, whether that can run now, and what's missing if not.
/// The box decides it, from what its engine and coding agents list, so every client shows the
/// same; a client draws it: the model button's name (or "Choose a Model"), Send (`ComposerSend`),
/// what a message refused says, and a sign-in card's help.
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

    /// The model it runs on: its own, else the engine's default; nil for none.
    public var model: ModelRef?
    /// Its name, as its provider or agent lists it (nil for one gone from the list).
    public var name: String?
    public var runs: Bool
    public var missing: Missing?
    /// The account to sign in to, add a key for or install; for one gone, its provider.
    public var account: Account?
    public var plan: Plan?

    public init(model: ModelRef?, name: String? = nil, runs: Bool, missing: Missing? = nil, account: Account? = nil, plan: Plan? = nil) {
        self.model = model
        self.name = name
        self.runs = runs
        self.missing = missing
        self.account = account
        self.plan = plan
    }

    private enum CodingKeys: String, CodingKey { case model, name, runs, missing, account, plan }

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

    /// The model button names the model, and Send sends with it: one that runs, or one whose
    /// account needs something (a message on it says what, instead of going). For one gone, or
    /// none chosen, the button says "Choose a Model" and Send waits for one.
    public var namesModel: Bool {
        switch missing {
        case nil: runs
        case .model, .gone: false
        case .signIn, .key, .install, .other: true
        }
    }

    /// What a sign-in card's button does for its account, which it's labelled by.
    public enum AccountStep: Equatable, Sendable {
        case signIn, addKey, install

        /// The button's words: what it does, not "Sign In" for a sheet that takes a key.
        public var title: String {
            switch self {
            case .signIn: "Sign In"
            case .addKey: "Add Key"
            case .install: "Install"
            }
        }
    }

    /// What its account needs done: signing in, adding a key, or installing its agent; nil for one
    /// that needs none of those.
    public var accountStep: AccountStep? {
        switch missing {
        case .signIn: .signIn
        case .key: .addKey
        case .install: .install
        default: nil
        }
    }

    /// The same, for a card about `provider`'s account: nil for another's.
    public func accountStep(for provider: String) -> AccountStep? {
        account?.id == provider ? accountStep : nil
    }

    /// What a failed turn's card button says for the model the turn `failed` on, labelled by what
    /// it does: Add Key, Install, Sign In, or Sign In Again for a sign-in that `ended`. Only where
    /// this is said of that model (the conversation's now): nil for another model, or one that
    /// needs none of those, which the app's own words say then.
    public func cardButton(for failed: ModelRef, ended: Bool) -> String? {
        guard isAbout(failed), let step = accountStep(for: failed.providerID) else { return nil }
        return ended && step == .signIn ? "Sign In Again" : step.title
    }

    /// Its account needs something before it runs: a sign-in, a key, or its agent installed.
    public var needsAccount: Bool {
        switch missing {
        case .signIn, .key, .install: true
        default: false
        }
    }

    /// Why a message on it can't go, and what to do (`there`: " on Studio Mac", or nothing for the
    /// computer it's on; `accounts`: where accounts are, "Settings › Accounts" on the Mac);
    /// `shownName` names it where the box has no name for it (one gone from its list). Nil for one
    /// that runs.
    public func refusal(there: String = "", accounts: String, shownName: String? = nil) -> String? {
        guard !runs || missing != nil else { return nil }
        let name = self.name ?? shownName ?? model?.id ?? "This model"
        let account = self.account?.name ?? model?.providerID ?? "its account"
        switch missing {
        case .model, nil:
            return "Choose a model to send it."
        case .signIn:
            return "\(name) needs a sign-in\(there): sign in to \(account) in \(accounts), or choose another model."
        case .key:
            if let plan {
                return "\(name) needs \(Self.article(account)) \(account) key\(there): add one in \(accounts), or choose another model (with \(Self.article(plan.name)) \(plan.name) plan, one under \(plan.agent))."
            }
            return "\(name) needs \(Self.article(account)) \(account) key\(there): add one in \(accounts), or choose another model."
        case .install:
            return "\(name) needs \(account) installed\(there): install it in \(accounts), or choose another model."
        case .gone:
            if let provider = self.account?.name { return "\(name) is no longer among \(provider)’s models\(there): choose another model." }
            return "\(name) is no longer available\(there): choose another model."
        case .other:
            return "\(name) can’t run\(there) now: choose another model."
        }
    }

    /// What a sign-in card's Sign In for `provider` does, as its help says it, where it's this
    /// model's account (`there`: " on devbox"): adds a key where that's the only way offered, signs
    /// in, or installs its agent. Nil for another account, or one that needs nothing.
    public func signInHelp(_ provider: String, there: String = "") -> String? {
        guard let account, account.id == provider else { return nil }
        switch missing {
        case .key:
            if let plan { return "Add \(Self.article(account.name)) \(account.name) key\(there) (with \(Self.article(plan.name)) \(plan.name) plan, choose a model under \(plan.agent) instead)" }
            return "Add \(Self.article(account.name)) \(account.name) key\(there)"
        case .signIn:
            return "Sign in to \(account.name)\(there)"
        case .install:
            return "Install \(account.name)\(there)"
        default:
            return nil
        }
    }

    /// "an" before a name said starting with a vowel ("an OpenAI key", "an xAI key", said "ex-A-I"),
    /// else "a" ("a Xiaomi key").
    static func article(_ word: String) -> String {
        guard let first = word.lowercased().first else { return "a" }
        return "aeiou".contains(first) || word.hasPrefix("xA") ? "an" : "a"
    }
}

/// What a box answers `kuvo/sessions/models` with: each session asked for that it could say about.
public struct SessionModelStates: Decodable, Sendable {
    public var sessions: [String: SessionModelState]
}
