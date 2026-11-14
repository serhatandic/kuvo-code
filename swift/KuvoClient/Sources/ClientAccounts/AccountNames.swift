/// What both apps call each provider's accounts in a word, the same wherever an account is named
/// (the usage panel's rows, the work bar's): the coding agents by their own names ("Claude" for
/// Claude Code's), the engine's sign-ins by the plan they're for ("Copilot").
public enum AccountNames {
    /// The coding agents, by kind (`claude`, the agent a box's limits name).
    public static let agents = ["claude": "Claude", "codex": "Codex", "grok": "Grok", "cursor": "Cursor", "antigravity": "Antigravity"]
    /// The engine's sign-ins, by what they're the limits of (a box's limits' `service`).
    public static let services = ["codex": "ChatGPT", "grok": "SuperGrok", "copilot": "Copilot", "openrouter": "OpenRouter", "zai": "Z.ai", "ollama": "Ollama", "opencode": "OpenCode Go"]

    /// The usage panel's cards, by service: a card that shows a service's spend alone, with no
    /// account of it to name (OpenCode's Zen use, with no Go plan).
    public static let cards = ["claude": "Claude", "codex": "Codex", "cursor": "Cursor", "antigravity": "Antigravity", "copilot": "Copilot",
                               "grok": "Grok", "opencode": "OpenCode", "openrouter": "OpenRouter", "zai": "Z.ai", "ollama": "Ollama"]

    /// Each coding agent's kind, by its own sign-in's provider.
    static let agentKinds = ["claude-code": "claude", "codex-cli": "codex", "grok-cli": "grok", "cursor": "cursor", "antigravity": "antigravity"]
    /// The engine's plans named apart from their provider's own name, by provider. (Not `openai` or
    /// `xai`: a key for them is no ChatGPT or SuperGrok plan.)
    static let engineServices = ["github-copilot": "copilot", "openrouter": "openrouter", "zai": "zai", "zai-coding-plan": "zai", "opencode-go": "opencode"]

    /// The word for an account with `provider` (`claude-code@work` is Claude Code's): nil for one
    /// that goes by its provider's own name.
    public static func short(provider: String) -> String? {
        let base = provider.split(separator: "@", maxSplits: 1).first.map(String.init) ?? provider
        if let kind = agentKinds[base] { return agents[kind] }
        return engineServices[base].flatMap { services[$0] }
    }
}
