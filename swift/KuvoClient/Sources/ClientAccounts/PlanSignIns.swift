import OpenCodeKit

/// The engine's providers whose plan Kuvo Code signs in to through a coding agent instead: a
/// ChatGPT plan through Codex, a SuperGrok plan through Grok. Accounts offers the engine only a key
/// for them, so a conversation on one of their engine models (one from before, say) can't be
/// helped by signing in to the plan: it needs a key, or a model under the plan's agent.
public enum PlanSignIns {
    /// The plan and the agent it's used through, by the engine's provider. (The box's
    /// `kuvo/sessions/models` has the same, held to the same cases:
    /// protocol/vectors/plan-sign-ins.json.)
    static let plans = ["openai": (plan: "ChatGPT", agent: "Codex"), "xai": (plan: "SuperGrok", agent: "Grok")]

    /// Whether the engine's sign-in `method` (an oauth method's id) for `provider` is its plan's,
    /// which goes through the plan's coding agent instead.
    static func isPlans(_ method: String, of provider: String) -> Bool {
        switch provider {
        case "openai": method.hasPrefix("chatgpt")
        case "xai": method == "device"
        default: false
        }
    }

    /// Why `model`, of the engine's `provider` (called `providerName`), can't run where it is
    /// (`there`: " on Studio Mac", or nothing for this Mac), and what to do, for a provider whose
    /// plan goes through an agent; nil for any other. `accounts`: where keys are added
    /// ("Settings › Accounts" on the Mac).
    public static func needsKey(model: String, provider: String, providerName: String, there: String = "", accounts: String) -> String? {
        guard let way = plans[provider] else { return nil }
        return "\(model) needs an \(providerName) key\(there): add one in \(accounts), or choose another model (with a \(way.plan) plan, one under \(way.agent))."
    }

    /// What signing in to `provider` (called `providerName`) does where only its key is offered
    /// (`there`: " on devbox", or nothing for this Mac), as a Sign In button's help says it; nil for
    /// any other provider.
    public static func keyHelp(provider: String, providerName: String, there: String = "") -> String? {
        guard let way = plans[provider] else { return nil }
        return "Add an \(providerName) key\(there) (with a \(way.plan) plan, choose a model under \(way.agent) instead)"
    }
}

extension Integration {
    /// The ways to sign in a box from before `sessions.models` is judged by (the old-box path; a box
    /// says them itself now, `SignInAccounts`): a ChatGPT plan is used through Codex and
    /// a SuperGrok plan through Grok (Subscriptions), so the engine's own sign-ins with those plans
    /// aren't offered: two ways to one plan read as two accounts. One made before still works,
    /// shows as connected, and can be signed in to again.
    public var offeredSignInMethods: [Method] {
        if connections.contains(where: { $0.method == "oauth" }) { return signInMethods }
        return signInMethods.filter { method in
            guard case .oauth(let id, _, _) = method else { return true }
            return !PlanSignIns.isPlans(id, of: self.id)
        }
    }
}
