import Testing
import ClientAccounts

/// "Bring your subscriptions": which of what a computer has is offered, and how, from its box's
/// list as `kuvo/accounts/found` answers it. The same rows on the Mac and the phone.
@Suite struct OffersTests {
    private func found(agents: [Found.Agent] = [], opencode: [Found.Opencode] = [], shell: [Found.Shell] = []) -> Found {
        Found(agents: agents, opencode: opencode, shell: shell)
    }

    /// The agents as the agents bridge lists them on a Mac with Codex signed in, Claude Code not
    /// installed, and Cursor's and Antigravity's agents (which come with Kuvo Code) not signed in.
    private let bridge: [Found.Agent] = [
        .init(id: "claude-code", name: "Claude Code", installed: false, signedIn: false),
        .init(id: "codex-cli", name: "Codex", installed: true, signedIn: true, label: "you@example.com · Plus"),
        .init(id: "cursor", name: "Cursor", installed: true, signedIn: false),
        .init(id: "grok-cli", name: "Grok", installed: false, signedIn: false),
        .init(id: "antigravity", name: "Antigravity", installed: true, signedIn: false),
    ]

    @Test func aProviderAPlanCoversIsOneRowThePlans() {
        // opencode signed in to ChatGPT and holding an OpenAI key, and OPENAI_API_KEY in the shell:
        // all of it is Codex's, one row.
        let offers = Offers(found: found(agents: bridge, opencode: [
            .init(id: "opencode:openai", integrationID: "openai", name: "OpenAI", kind: .signIn, connected: false),
            .init(id: "opencode:anthropic", integrationID: "anthropic", name: "Anthropic", kind: .key, connected: false),
        ], shell: [.init(integrationID: "openai", name: "OpenAI", variable: "OPENAI_API_KEY")]))
        let everything = offers.plans + offers.keys + offers.more
        #expect(!everything.contains { $0.name == "OpenAI" || $0.name == "Anthropic" })
        #expect(offers.plans.filter { $0.integrationID == "codex-cli" }.map(\.action) == [.ready])
        #expect(offers.plans.first { $0.integrationID == "codex-cli" }?.detail == "Signed in as you@example.com · Plus")
        #expect(offers.plans.first { $0.integrationID == "claude-code" }?.action == .install(integrationID: "claude-code"))
        #expect(offers.keys.isEmpty)
    }

    @Test func theAgentsArentTheModelPickersOnesOnly() {
        // Cursor and Antigravity, there as the picker lists them, sign in here; Grok, which isn't
        // installed, waits among the others to add.
        let offers = Offers(found: found(agents: bridge))
        #expect(offers.plans.map(\.name) == ["Claude Code", "Codex", "Cursor", "Antigravity", "GitHub Copilot"])
        #expect(offers.plans.first { $0.name == "Cursor" }?.action == .signIn(integrationID: "cursor"))
        #expect(offers.plans.first { $0.name == "Cursor" }?.detail == "A Cursor plan")
        #expect(offers.more.map(\.name) == ["Grok", "GitLab Duo", "Poe", "OpenCode"])
        #expect(offers.more.first?.action == .install(integrationID: "grok-cli"))
        #expect(offers.hasSomething, "Codex works")
    }

    @Test func anAccountYouAddedWithAnAgentMakesItYours() {
        let offers = Offers(found: found(agents: [
            .init(id: "claude-code", name: "Claude Code", installed: true, signedIn: false),
            .init(id: "claude-code@work", name: "Claude Code (Work)", installed: true, signedIn: true, label: "work@example.com"),
        ]))
        #expect(offers.plans.filter { $0.integrationID == "claude-code" }.map(\.action) == [.ready], "one row, signed in")
        #expect(offers.plans.first?.detail == "Signed in as work@example.com")
    }

    @Test func keysAreApartAndComeOverWithOneTap() {
        let nvidia = Found.Opencode(id: "opencode:nvidia", integrationID: "nvidia", name: "Nvidia", kind: .key, connected: false)
        let openrouter = Found.Opencode(id: "opencode:openrouter", integrationID: "openrouter", name: "OpenRouter", kind: .key, connected: true)
        let offers = Offers(found: found(opencode: [nvidia, openrouter], shell: [
            .init(integrationID: "openrouter", name: "OpenRouter", variable: "OPENROUTER_API_KEY"),
            .init(integrationID: "zai", name: "Z.ai", variable: "ZAI_API_KEY"),
        ]))
        #expect(offers.keys.map(\.name) == ["Nvidia", "OpenRouter", "Z.ai"], "OpenRouter once")
        #expect(offers.keys.map(\.action) == [.use(nvidia), .ready, .ready])
        #expect(offers.keys.last?.detail == "From ZAI_API_KEY in your shell")
        #expect(!offers.plans.contains { $0.name == "Nvidia" }, "a key isn't a plan")
        // Brought over: it says so.
        #expect(Offers(found: found(opencode: [nvidia]), used: ["opencode:nvidia"]).keys.map(\.action) == [.added])
    }

    @Test func opencodesPlanSignInsAreThePlansRows() {
        let copilot = Found.Opencode(id: "opencode:github-copilot", integrationID: "github-copilot", name: "GitHub Copilot", kind: .signIn, connected: false)
        let offers = Offers(found: found(opencode: [copilot]))
        let rows = offers.plans.filter { $0.integrationID == "github-copilot" }
        #expect(rows.count == 1)
        #expect(rows.first?.detail == "Sign in again to use it here")
        #expect(rows.first?.action == .signIn(integrationID: "github-copilot"))
        #expect(!offers.hasSomething)
    }

    @Test func aFreshComputerIsOfferedTheCommonPlans() {
        let fresh = Offers(found: found())
        #expect(!fresh.hasSomething)
        #expect(fresh.plans.map(\.name) == ["Claude Code", "Codex", "GitHub Copilot"])
        #expect(fresh.plans.map(\.action) == [.install(integrationID: "claude-code"), .install(integrationID: "codex-cli"), .signIn(integrationID: "github-copilot")])
        #expect(fresh.keys.isEmpty)
        #expect(fresh.more.map(\.name) == ["Cursor", "Grok", "Antigravity", "GitLab Duo", "Poe", "OpenCode"])
    }

    @Test func notListedYetIsNotNothingFound() {
        // The box hasn't answered: nothing is offered yet.
        let waiting = Offers(found: nil)
        #expect(waiting.plans.isEmpty && waiting.keys.isEmpty && waiting.more.isEmpty)
    }
}
