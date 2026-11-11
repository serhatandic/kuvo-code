import ClientAccounts
import Testing

/// A conversation on the engine's OpenAI or xAI model, which the engine can't run (no key there):
/// it says to add a key or choose another model, and where the plan's models are, rather than to
/// sign in to the plan. A SuperGrok plan goes through Grok, a provider of its own, so signing in to
/// it never makes the engine's xAI models run (#338: "Grok needs a sign-in" while Grok worked).
struct PlanSignInsTests {
    @Test func aPlanThroughAnAgentSaysKeyOrItsAgentsModels() {
        #expect(PlanSignIns.needsKey(model: "grok-4.7", provider: "xai", providerName: "xAI", there: " on Studio Mac", accounts: "Accounts")
            == "grok-4.7 needs an xAI key on Studio Mac: add one in Accounts, or choose another model (for your SuperGrok plan, one under Grok).")
        #expect(PlanSignIns.needsKey(model: "GPT-5", provider: "openai", providerName: "OpenAI", accounts: "Settings › Accounts")
            == "GPT-5 needs an OpenAI key: add one in Settings › Accounts, or choose another model (for your ChatGPT plan, one under Codex).")
    }

    @Test func anyOtherProviderIsSaidAsBefore() {
        #expect(PlanSignIns.needsKey(model: "sonnet", provider: "anthropic", providerName: "Anthropic", accounts: "Accounts") == nil)
        #expect(PlanSignIns.needsKey(model: "grok-4.7", provider: "grok-cli", providerName: "Grok", accounts: "Accounts") == nil, "Grok's own sign-in is the plan")
    }
}
