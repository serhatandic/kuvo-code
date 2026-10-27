import Testing
import ClientAccounts

/// "Bring your subscriptions": which of what a computer has is offered, and how, from its box's
/// list as `kuvo/accounts/found` answers it. The same rows on the Mac and the phone.
@Suite struct OffersTests {
    private func found(agents: [Found.Agent] = [], opencode: [Found.Opencode] = [], shell: [Found.Shell] = []) -> Found {
        Found(agents: agents, opencode: opencode, shell: shell)
    }

    @Test func signedInAgentsAreReadyAndSignedOutOnesSignIn() {
        let offers = Offers(found: found(agents: [
            .init(id: "claude-code", name: "Claude Code", installed: true, signedIn: true, label: "you@example.com · Max plan"),
            .init(id: "grok-cli", name: "Grok", installed: true, signedIn: false),
            .init(id: "codex-cli", name: "Codex", installed: false, signedIn: false),
            // Cursor's comes with Kuvo Code: there on every Mac, so not something you brought.
            .init(id: "cursor", name: "Cursor", installed: true, signedIn: false),
        ]))
        #expect(offers.agents.map(\.name) == ["Claude Code", "Grok"], "an agent that isn't installed, or comes with Kuvo Code, isn't something you have")
        #expect(offers.agents[0].action == .ready)
        #expect(offers.agents[0].detail == "Signed in as you@example.com · Max plan")
        #expect(offers.agents[1].action == .signIn(integrationID: "grok-cli"))
        #expect(offers.hasSomething)
    }

    @Test func opencodeKeysComeOverWithOneTapAndItsSignInsSignInAgain() {
        let key = Found.Opencode(id: "opencode:anthropic", integrationID: "anthropic", name: "Anthropic", kind: .key, connected: false)
        let signIn = Found.Opencode(id: "opencode:github-copilot", integrationID: "github-copilot", name: "GitHub Copilot", kind: .signIn, connected: false)
        let had = Found.Opencode(id: "opencode:openrouter", integrationID: "openrouter", name: "OpenRouter", kind: .key, connected: true)
        let offers = Offers(found: found(opencode: [key, signIn, had]))
        #expect(offers.opencode.map(\.action) == [.use(key), .signIn(integrationID: "github-copilot"), .ready])
        // Brought over: it says so, and isn't offered again.
        #expect(Offers(found: found(opencode: [key]), used: ["opencode:anthropic"]).opencode.map(\.action) == [.added])
    }

    @Test func aShellKeyIsReadyAndNotOfferedTwice() {
        let offers = Offers(found: found(
            opencode: [.init(id: "opencode:openai", integrationID: "openai", name: "OpenAI", kind: .key, connected: true)],
            shell: [.init(integrationID: "openai", name: "OpenAI", variable: "OPENAI_API_KEY"), .init(integrationID: "zai", name: "Z.ai", variable: "ZAI_API_KEY")]))
        #expect(offers.shell.map(\.name) == ["Z.ai"])
        #expect(offers.shell.first?.detail == "From ZAI_API_KEY in your shell")
        #expect(offers.shell.first?.action == .ready)
    }

    @Test func nothingSignedInOffersTheCommonSubscriptions() {
        // A fresh Mac: nothing at all.
        let fresh = Offers(found: found())
        #expect(!fresh.hasSomething)
        #expect(fresh.suggestions.map(\.name) == ["Claude Code", "Codex", "GitHub Copilot"])
        #expect(fresh.suggestions.map(\.action) == [.install(integrationID: "claude-code"), .install(integrationID: "codex-cli"), .signIn(integrationID: "github-copilot")])

        // Grok and Claude Code installed but signed out, and opencode signed in to Copilot: they
        // sign in, first, and Copilot isn't offered twice.
        let signedOut = Offers(found: found(agents: [
            .init(id: "grok-cli", name: "Grok", installed: true, signedIn: false),
            .init(id: "claude-code", name: "Claude Code", installed: true, signedIn: false),
        ], opencode: [.init(id: "opencode:github-copilot", integrationID: "github-copilot", name: "GitHub Copilot", kind: .signIn, connected: false)]))
        #expect(!signedOut.hasSomething)
        #expect(signedOut.suggestions.map(\.name) == ["Grok", "Claude Code", "GitHub Copilot", "Codex"])
        #expect(signedOut.suggestions[1].action == .signIn(integrationID: "claude-code"))
        #expect(signedOut.suggestions[2].detail == "Sign in again to use it here")
    }

    @Test func notListedYetIsNotNothingFound() {
        // The box hasn't answered: nothing is offered, and it isn't the "nothing to bring over" screen.
        let waiting = Offers(found: nil)
        #expect(waiting.suggestions.isEmpty && waiting.agents.isEmpty)
    }
}
