import Foundation

/// Which of the engine's integrations (`GET api/integration`) Accounts lists as providers, the same
/// in both apps: in Connected, in its search and in the lists to add one.
public enum EngineProviders {
    /// Web search services, whose keys Settings › Engine keeps: the engine lists them among its
    /// sign-ins, but they're not providers.
    public static let searchServices: Set = ["exa", "firecrawl", "parallel", "tavily", "tinyfish"]

    /// The engine's own way to a coding agent's plan ("Claude Agent", through Claude Code): Kuvo
    /// Code brings the agent through its coding agents' bridge, so it isn't offered to add. One
    /// added already stays listed.
    public static let agentDuplicates: Set = ["claude-agent"]

    /// Whether Accounts lists the engine's integration `id` as a provider, `connected` (signed in)
    /// or not.
    public static func lists(_ id: String, connected: Bool) -> Bool {
        !searchServices.contains(id) && (connected || !agentDuplicates.contains(id))
    }
}
