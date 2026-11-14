import Testing
import ClientAccounts

/// Which of the engine's integrations Accounts lists as providers, the same on the Mac and the
/// phone.
@Suite struct EngineProvidersTests {
    /// Some of what engine 2.2.6 lists at `api/integration` on a box that runs Claude Code, by id,
    /// and whether each is signed in.
    private func listed(claudeAgentConnected: Bool) -> [String] {
        let integrations = [("anthropic", false), ("claude-agent", claudeAgentConnected), ("openai", true), ("tavily", false), ("exa", true)]
        return integrations.filter { EngineProviders.lists($0.0, connected: $0.1) }.map(\.0)
    }

    @Test func claudeAgentIsntOfferedToAdd() {
        // Kuvo Code brings Claude through Claude Code with its own bridge: the engine's "Claude
        // Agent" would be a second Claude to add in Accounts' search.
        #expect(listed(claudeAgentConnected: false) == ["anthropic", "openai"])
    }

    @Test func claudeAgentAddedAlreadyStaysListed() {
        #expect(listed(claudeAgentConnected: true) == ["anthropic", "claude-agent", "openai"])
    }
}
