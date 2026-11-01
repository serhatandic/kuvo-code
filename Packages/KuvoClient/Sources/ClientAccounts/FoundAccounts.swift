import Foundation

// "Bring your subscriptions": what a computer has that Kuvo Code can use, as its box answers
// `kuvo/accounts/found`, and the rows both apps offer from it, each with the one thing it needs.
// Shared so the Mac's first launch and the phone's sheet after pairing offer the same.

/// What a computer has that Kuvo Code can use, as its box answers `kuvo/accounts/found`.
public struct Found: Decodable, Equatable, Sendable {
    public var agents: [Agent]
    public var opencode: [Opencode]
    public var shell: [Shell]
    /// The engine's providers signed in to already (a plan, a key), by integration.
    public var connected: [String]
    /// The parts the box couldn't read just now, their server not running or not answering (the
    /// engine restarting, slow): theirs are empty for now, not signed out.
    public var unread: Set<Part>

    public enum Part: String, Sendable { case engine, agents }

    public init(agents: [Agent], opencode: [Opencode], shell: [Shell], connected: [String] = [], unread: Set<Part> = []) {
        self.agents = agents
        self.opencode = opencode
        self.shell = shell
        self.connected = connected
        self.unread = unread
    }

    private enum CodingKeys: String, CodingKey { case agents, opencode, shell, connected, unread }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agents = try c.decode([Agent].self, forKey: .agents)
        opencode = try c.decode([Opencode].self, forKey: .opencode)
        shell = try c.decode([Shell].self, forKey: .shell)
        // A box from before bridge 0.9.91 doesn't say.
        connected = try c.decodeIfPresent([String].self, forKey: .connected) ?? []
        // Before bridge 0.9.150 a box doesn't say (and its empty parts may be unread).
        unread = Set((try c.decodeIfPresent([String].self, forKey: .unread) ?? []).compactMap(Part.init(rawValue:)))
    }

    /// This list, with what the box couldn't read now as `before` had it: an engine restarting or
    /// slow to answer, or the agents' bridge, isn't everything signed out.
    public func keeping(_ before: Found?) -> Found {
        guard let before else { return self }
        var kept = self
        if unread.contains(.engine) {
            kept.connected = before.connected
            kept.shell = before.shell
            // opencode's own are read without the engine; only their names and whether the engine
            // has them come from it.
            kept.opencode = opencode.map { item in
                guard let known = before.opencode.first(where: { $0.id == item.id }) else { return item }
                var item = item
                item.name = known.name
                item.connected = known.connected
                return item
            }
        }
        if unread.contains(.agents), agents.isEmpty { kept.agents = before.agents }
        return kept
    }

    public struct Agent: Decodable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var installed: Bool
        public var signedIn: Bool
        public var label: String?

        public init(id: String, name: String, installed: Bool, signedIn: Bool, label: String? = nil) {
            self.id = id
            self.name = name
            self.installed = installed
            self.signedIn = signedIn
            self.label = label
        }
    }

    public struct Opencode: Decodable, Equatable, Identifiable, Sendable {
        public var id: String
        public var integrationID: String
        public var name: String
        public var kind: Kind
        public var connected: Bool

        public enum Kind: String, Decodable, Sendable { case key, signIn }

        public init(id: String, integrationID: String, name: String, kind: Kind, connected: Bool) {
            self.id = id
            self.integrationID = integrationID
            self.name = name
            self.kind = kind
            self.connected = connected
        }
    }

    public struct Shell: Decodable, Equatable, Sendable {
        public var integrationID: String
        public var name: String
        public var variable: String

        public init(integrationID: String, name: String, variable: String) {
            self.integrationID = integrationID
            self.name = name
            self.variable = variable
        }
    }
}

/// The plans Kuvo Code signs in to, in the order it offers them, the same in the model picker,
/// Settings › Accounts and the first launch: the coding agents' (each run as its maker built it),
/// then the plans the engine signs in to.
public enum Plans {
    /// The coding agents, by their own sign-in's provider.
    public static let agents = ["claude-code", "codex-cli", "cursor", "grok-cli", "antigravity"]
    /// The plans the engine signs in to with an account, as you do an agent.
    public static let engine = ["github-copilot", "gitlab", "poe", "opencode"]
    /// The agents most people bring, offered to install when they're not there.
    public static let common: Set = ["claude-code", "codex-cli"]
    /// The agents whose programs are your own, installed by their makers' installers (Cursor's and
    /// Antigravity's come with Kuvo Code).
    public static let ownPrograms: Set = ["claude-code", "codex-cli", "grok-cli"]

    /// The engine's provider whose plan an agent signs in to, by agent: ChatGPT's plan is used
    /// through Codex, Claude's through Claude Code. One way to sign in to a plan, the agent's (a
    /// key for the provider is something else, and stays one).
    public static let providers = ["claude-code": "anthropic", "codex-cli": "openai", "grok-cli": "xai", "antigravity": "google"]

    /// The agent that signs in to `provider`'s plan, if one does.
    public static func agent(for provider: String) -> String? {
        providers.first { $0.value == provider }?.key
    }

    /// An agent's own sign-in, from one of its accounts' providers (`codex-cli@work`).
    public static func base(_ providerID: String) -> String {
        providerID.split(separator: "@", maxSplits: 1).first.map(String.init) ?? providerID
    }

    /// An account you added with an agent, beside its own sign-in.
    public static func isAddedAccount(_ providerID: String) -> Bool {
        providerID.contains("@") && agents.contains(base(providerID))
    }

    /// Whether an agent's account is offered (in the picker, and the first launch): one you don't
    /// have, haven't signed in to and didn't add stays out of the way.
    public static func shows(installed: Bool, signedIn: Bool, providerID: String) -> Bool {
        installed || signedIn || isAddedAccount(providerID)
    }

    /// What each plan is, in a few words, for one you haven't signed in to.
    public static func plan(_ id: String) -> String {
        switch base(id) {
        case "claude-code": "Claude Pro or Max"
        case "codex-cli": "ChatGPT Plus or Pro"
        case "cursor": "A Cursor plan"
        case "grok-cli": "SuperGrok or X Premium"
        case "antigravity": "A Google AI plan"
        case "github-copilot": "A Copilot plan"
        case "gitlab": "A GitLab Duo plan"
        case "poe": "A Poe subscription"
        case "opencode": "OpenCode Zen or Go"
        default: "A plan"
        }
    }
}

/// The rows of "Bring your subscriptions", from what was found: each with the one thing it needs.
/// Plans first, one way to sign in to each (an agent's plan wins over opencode's sign-in to it); keys
/// found on the computer apart, offered on demand; and the plans not shown, to add another.
public struct Offers: Equatable, Sendable {
    public struct Row: Equatable, Identifiable, Sendable {
        public enum Action: Equatable, Sendable {
            /// Works as it is.
            case ready
            /// An opencode key brought over.
            case added
            /// Sign in to it here (an agent signed out, a sign-in that can't be copied).
            case signIn(integrationID: String)
            /// Copy this opencode key in.
            case use(Found.Opencode)
            /// Run its maker's installer.
            case install(integrationID: String)
        }

        public var id: String
        /// The engine's or the agents bridge's integration, for its logo.
        public var integrationID: String
        public var name: String
        public var detail: String
        public var action: Action
    }

    /// The coding agents the model picker lists (and Claude Code and Codex, to install), then the
    /// plans the engine signs in to that you have, and GitHub Copilot.
    public var plans: [Row] = []
    /// API keys found on the computer (opencode's, the shell's).
    public var keys: [Row] = []
    /// The plans not in `plans`, to add another.
    public var more: [Row] = []
    /// The coding agents haven't been listed yet (their bridge is starting): none is offered, nor
    /// installed again, until they are.
    public var agentsPending = false

    public init(found: Found?, used: Set<String> = []) {
        guard let found else { return }
        func opencodeRow(_ item: Found.Opencode) -> Row {
            let action: Row.Action = item.connected ? .ready : used.contains(item.id) ? .added : item.kind == .key ? .use(item) : .signIn(integrationID: item.integrationID)
            let detail = item.kind == .key ? "API key" : item.connected ? "Signed in" : "Sign in again to use it here"
            return Row(id: item.id, integrationID: item.integrationID, name: item.name, detail: detail, action: action)
        }
        agentsPending = found.agents.isEmpty
        for id in Plans.agents where !agentsPending {
            let accounts = found.agents.filter { Plans.base($0.id) == id }
            let own = accounts.first { $0.id == id }
            let name = own?.name ?? accounts.first?.name ?? Self.names[id] ?? id
            if let signedIn = accounts.first(where: \.signedIn) {
                plans.append(Row(id: id, integrationID: id, name: name, detail: signedIn.label.map { "Signed in as \($0)" } ?? "Signed in", action: .ready))
            } else if let own, Plans.shows(installed: own.installed, signedIn: false, providerID: own.id) {
                let detail = Plans.ownPrograms.contains(id) ? "Installed · \(Plans.plan(id))" : Plans.plan(id)
                plans.append(Row(id: id, integrationID: id, name: name, detail: detail, action: .signIn(integrationID: id)))
            } else {
                let row = Row(id: id, integrationID: id, name: name, detail: Plans.plan(id), action: Plans.ownPrograms.contains(id) ? .install(integrationID: id) : .signIn(integrationID: id))
                if Plans.common.contains(id) { plans.append(row) } else { more.append(row) }
            }
        }
        let opencode = Dictionary(found.opencode.map { ($0.integrationID, $0) }, uniquingKeysWith: { first, _ in first })
        // The plans the engine signs in to. Some sign in with a key (OpenCode Zen, Poe): one found
        // is that plan's way in, on its row, never a second one.
        for id in Plans.engine {
            if found.connected.contains(id) {
                plans.append(Row(id: id, integrationID: id, name: opencode[id]?.name ?? Self.names[id] ?? id, detail: "Signed in", action: .ready))
            } else if let shell = found.shell.first(where: { $0.integrationID == id }) {
                plans.append(Row(id: id, integrationID: id, name: shell.name, detail: "From \(shell.variable) in your shell", action: .ready))
            } else if let item = opencode[id] {
                var row = opencodeRow(item)
                if item.kind == .key, !item.connected { row.detail = "Your key from opencode" }
                plans.append(row)
            } else {
                let row = Row(id: id, integrationID: id, name: Self.names[id] ?? id, detail: Plans.plan(id), action: .signIn(integrationID: id))
                if id == "github-copilot" { plans.append(row) } else { more.append(row) }
            }
        }
        // The rest of opencode's: its keys apart, a sign-in with the plans. Never two ways to sign in
        // to one plan: opencode's sign-in to a plan an agent signs in to (ChatGPT's, Codex's) is
        // that agent's row. A key is a key, even for a provider a plan covers.
        let covered = Set(Plans.providers.values)
        // A key the shell gives the engine already is that row, ready (below), not this one too.
        let shelled = Set(found.shell.map(\.integrationID))
        for item in found.opencode where !Plans.engine.contains(item.integrationID) && !(item.kind == .key && shelled.contains(item.integrationID)) {
            if item.kind == .key { keys.append(opencodeRow(item)) } else if !covered.contains(item.integrationID) { plans.append(opencodeRow(item)) }
        }
        // A key in the shell the engine uses already.
        for key in found.shell where !Plans.engine.contains(key.integrationID) {
            keys.append(Row(id: "shell:" + key.variable, integrationID: key.integrationID, name: key.name, detail: "From \(key.variable) in your shell", action: .ready))
        }
    }

    /// The plans' names before the box has listed them.
    private static let names = ["claude-code": "Claude Code", "codex-cli": "Codex", "cursor": "Cursor", "grok-cli": "Grok", "antigravity": "Antigravity",
                                "github-copilot": "GitHub Copilot", "gitlab": "GitLab Duo", "poe": "Poe", "opencode": "OpenCode"]
}
