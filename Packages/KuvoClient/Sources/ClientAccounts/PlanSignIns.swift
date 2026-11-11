/// The engine's providers whose plan Kuvo Code signs in to through a coding agent instead: a
/// ChatGPT plan through Codex, a SuperGrok plan through Grok. Accounts offers the engine only a key
/// for them, so a conversation on one of their engine models (one from before, say) can't be
/// helped by signing in to the plan: it needs a key, or a model under the plan's agent.
public enum PlanSignIns {
    /// The plan and the agent it's used through, by the engine's provider.
    static let plans = ["openai": (plan: "ChatGPT", agent: "Codex"), "xai": (plan: "SuperGrok", agent: "Grok")]

    /// Why `model`, of the engine's `provider` (called `providerName`), can't run where it is
    /// (`there`: " on Studio Mac", or nothing for this Mac), and what to do, for a provider whose
    /// plan goes through an agent; nil for any other. `accounts`: where keys are added
    /// ("Settings › Accounts" on the Mac).
    public static func needsKey(model: String, provider: String, providerName: String, there: String = "", accounts: String) -> String? {
        guard let way = plans[provider] else { return nil }
        return "\(model) needs an \(providerName) key\(there): add one in \(accounts), or choose another model (for your \(way.plan) plan, one under \(way.agent))."
    }
}
