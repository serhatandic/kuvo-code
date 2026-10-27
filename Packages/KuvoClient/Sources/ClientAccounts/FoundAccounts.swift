import Foundation

// "Bring your subscriptions": what a computer has that Kuvo Code can use, as its box answers
// `kuvo/accounts/found`, and the rows both apps offer from it, each with the one thing it needs.
// Shared so the Mac's first launch and the phone's sheet after pairing offer the same.

/// What a computer has that Kuvo Code can use, as its box answers `kuvo/accounts/found`.
public struct Found: Decodable, Equatable, Sendable {
    public var agents: [Agent]
    public var opencode: [Opencode]
    public var shell: [Shell]

    public init(agents: [Agent], opencode: [Opencode], shell: [Shell]) {
        self.agents = agents
        self.opencode = opencode
        self.shell = shell
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

/// The rows of "Bring your subscriptions", from what was found: each with the one thing it needs.
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

    public var agents: [Row] = []
    public var opencode: [Row] = []
    public var shell: [Row] = []

    /// What a computer with nothing to bring over is offered: the common subscriptions, with the one
    /// thing each needs on it.
    public var suggestions: [Row] = []

    public init(found: Found?, used: Set<String> = []) {
        guard let found else { return }
        // Installed agents: ready when signed in, a sign-in otherwise. One that isn't installed
        // isn't something you have (Settings › Accounts still offers it), and neither is one that
        // comes with Kuvo Code (Cursor's, Antigravity's) until you're signed in to it.
        agents = found.agents.filter { $0.installed && ($0.signedIn || Self.ownPrograms.contains($0.id)) }.map { agent in
            Row(id: agent.id, integrationID: agent.id, name: agent.name,
                detail: agent.signedIn ? (agent.label.map { "Signed in as \($0)" } ?? "Signed in") : "Installed, not signed in",
                action: agent.signedIn ? .ready : .signIn(integrationID: agent.id))
        }
        opencode = found.opencode.map { item in
            let action: Row.Action = item.connected ? .ready : used.contains(item.id) ? .added : item.kind == .key ? .use(item) : .signIn(integrationID: item.integrationID)
            let detail = item.kind == .key ? "API key" : item.connected ? "Signed in" : "Sign in again to use it here"
            return Row(id: item.id, integrationID: item.integrationID, name: item.name, detail: detail, action: action)
        }
        // A provider already used from the shell isn't offered twice.
        let fromOpencode = Set(found.opencode.map(\.integrationID))
        shell = found.shell.filter { !fromOpencode.contains($0.integrationID) }.map { key in
            Row(id: "shell:" + key.variable, integrationID: key.integrationID, name: key.name, detail: "From \(key.variable) in your shell", action: .ready)
        }
        // Nothing that works yet: the agents and opencode's sign-ins you have to sign in to again,
        // and the common subscriptions.
        if !hasSomething {
            let yours = agents + opencode
            suggestions = yours + Self.common(found.agents).filter { row in !yours.contains { $0.integrationID == row.integrationID } }
        }
    }

    /// The agents whose programs are your own, installed by their makers' installers.
    public static let ownPrograms: Set = ["claude-code", "codex-cli", "grok-cli"]

    /// Something works already, or can be brought over with one tap.
    public var hasSomething: Bool {
        (agents + opencode + shell).contains { row in
            switch row.action {
            case .ready, .added, .use: true
            case .signIn, .install: false
            }
        }
    }

    /// Claude Code, Codex and GitHub Copilot, each with what it needs here.
    private static func common(_ agents: [Found.Agent]) -> [Row] {
        func agent(_ id: String, _ name: String, _ plan: String) -> Row {
            let known = agents.first { $0.id == id }
            return Row(id: id, integrationID: id, name: name, detail: plan, action: known?.installed == true ? .signIn(integrationID: id) : .install(integrationID: id))
        }
        return [
            agent("claude-code", "Claude Code", "Claude Pro or Max"),
            agent("codex-cli", "Codex", "ChatGPT Plus or Pro"),
            Row(id: "github-copilot", integrationID: "github-copilot", name: "GitHub Copilot", detail: "A Copilot plan", action: .signIn(integrationID: "github-copilot")),
        ]
    }
}
