import Foundation
import Testing
import ClientAccounts

/// "Bring your subscriptions": which of what a computer has is offered, and how, from its box's
/// list as `kuvo/accounts/found` answers it. The same rows on the Mac and the phone.
@Suite struct OffersTests {
    private func found(agents: [Found.Agent] = [], opencode: [Found.Opencode] = [], shell: [Found.Shell] = [], connected: [String] = []) -> Found {
        Found(agents: agents, opencode: opencode, shell: shell, connected: connected)
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

    @Test func aPlanHasOneWayToSignInAndKeysStayKeys() {
        // opencode signed in to ChatGPT and holding an Anthropic key, and OPENAI_API_KEY in the
        // shell: ChatGPT's sign-in is Codex's row, and the keys are keys.
        let anthropic = Found.Opencode(id: "opencode:anthropic", integrationID: "anthropic", name: "Anthropic", kind: .key, connected: false)
        let offers = Offers(found: found(agents: bridge, opencode: [
            .init(id: "opencode:openai", integrationID: "openai", name: "OpenAI", kind: .signIn, connected: false),
            anthropic,
        ], shell: [.init(integrationID: "openai", name: "OpenAI", variable: "OPENAI_API_KEY")]))
        #expect(!(offers.plans + offers.more).contains { $0.name == "OpenAI" || $0.name == "Anthropic" }, "no second way to sign in to a plan")
        #expect(offers.plans.filter { $0.integrationID == "codex-cli" }.map(\.action) == [.ready])
        #expect(offers.plans.first { $0.integrationID == "codex-cli" }?.detail == "Signed in as you@example.com · Plus")
        #expect(offers.plans.first { $0.integrationID == "claude-code" }?.action == .install(integrationID: "claude-code"))
        #expect(offers.keys.map(\.name) == ["Anthropic", "OpenAI"])
        #expect(offers.keys.map(\.action) == [.use(anthropic), .ready])
        #expect(offers.keys.last?.detail == "From OPENAI_API_KEY in your shell")
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

    @Test func aPlanTheEngineSignsInToIsReadyOnceSignedIn() {
        // opencode's Copilot sign-in, to do again here; then signed in here.
        let copilot = Found.Opencode(id: "opencode:github-copilot", integrationID: "github-copilot", name: "GitHub Copilot", kind: .signIn, connected: false)
        let before = Offers(found: found(agents: bridge, opencode: [copilot])).plans.filter { $0.integrationID == "github-copilot" }
        #expect(before.map(\.detail) == ["Sign in again to use it here"])
        #expect(before.map(\.action) == [.signIn(integrationID: "github-copilot")])

        let after = Offers(found: found(agents: bridge, opencode: [copilot], connected: ["github-copilot", "gitlab"]))
        #expect(after.plans.filter { $0.integrationID == "github-copilot" }.map(\.action) == [.ready])
        // GitLab Duo, signed in to from Add Another: on the list now, not among the others.
        #expect(after.plans.first { $0.integrationID == "gitlab" }?.detail == "Signed in")
        #expect(!after.more.contains { $0.integrationID == "gitlab" })
    }

    @Test func aFreshMacIsOfferedTheCommonPlans() {
        // The bridge lists every agent: none installed but the ones that come with Kuvo Code.
        let fresh = Offers(found: found(agents: [
            .init(id: "claude-code", name: "Claude Code", installed: false, signedIn: false),
            .init(id: "codex-cli", name: "Codex", installed: false, signedIn: false),
            .init(id: "cursor", name: "Cursor", installed: true, signedIn: false),
            .init(id: "grok-cli", name: "Grok", installed: false, signedIn: false),
            .init(id: "antigravity", name: "Antigravity", installed: false, signedIn: false),
        ]))
        #expect(fresh.plans.map(\.name) == ["Claude Code", "Codex", "Cursor", "GitHub Copilot"])
        #expect(fresh.plans.map(\.action) == [.install(integrationID: "claude-code"), .install(integrationID: "codex-cli"), .signIn(integrationID: "cursor"), .signIn(integrationID: "github-copilot")])
        #expect(fresh.keys.isEmpty)
        #expect(fresh.more.map(\.name) == ["Grok", "Antigravity", "GitLab Duo", "Poe", "OpenCode"])

        // Signed in to GitHub Copilot from its row: the engine has it now, and so does the row,
        // though opencode never listed it.
        let signedIn = Offers(found: found(agents: [
            .init(id: "claude-code", name: "Claude Code", installed: false, signedIn: false),
            .init(id: "codex-cli", name: "Codex", installed: false, signedIn: false),
            .init(id: "cursor", name: "Cursor", installed: true, signedIn: false),
        ], connected: ["github-copilot"]))
        let copilot = signedIn.plans.first { $0.integrationID == "github-copilot" }
        #expect(copilot?.detail == "Signed in")
        #expect(copilot?.action == .ready)
    }

    @Test func agentsNotListedYetArentOfferedToInstall() {
        // The agents' bridge is still starting: Claude Code may well be there and signed in, so
        // it isn't offered to install; the rest is.
        let starting = Offers(found: found(opencode: [.init(id: "opencode:nvidia", integrationID: "nvidia", name: "Nvidia", kind: .key, connected: false)]))
        #expect(starting.agentsPending)
        #expect(!(starting.plans + starting.more).contains { Plans.agents.contains($0.integrationID) })
        #expect(starting.plans.map(\.name) == ["GitHub Copilot"])
        #expect(starting.keys.map(\.name) == ["Nvidia"])
    }

    @Test func aKeyForAPlanTheEngineSignsInToIsThatPlansWayIn() {
        // OpenCode Zen and Poe sign in with a key: one found is the plan's row, never a second one.
        let poe = Found.Opencode(id: "opencode:poe", integrationID: "poe", name: "Poe", kind: .key, connected: false)
        let offers = Offers(found: found(agents: bridge, opencode: [poe], shell: [.init(integrationID: "opencode", name: "OpenCode", variable: "OPENCODE_API_KEY")]))
        let poeRows = (offers.plans + offers.keys + offers.more).filter { $0.integrationID == "poe" }
        #expect(poeRows.map(\.action) == [.use(poe)])
        #expect(offers.plans.first { $0.integrationID == "poe" }?.detail == "Your key from opencode")
        // A key in the shell the engine uses already: that plan's ready.
        let zen = (offers.plans + offers.keys + offers.more).filter { $0.integrationID == "opencode" }
        #expect(zen.map(\.action) == [.ready])
        #expect(zen.first?.detail == "From OPENCODE_API_KEY in your shell")
        #expect(offers.plans.contains { $0.integrationID == "opencode" })
    }

    @Test func aKeyTheShellAlreadyGivesIsReadyOnceNotOfferedAgain() {
        // OpenCode Zen's key in opencode and in the shell, and Nvidia's too: the engine uses the
        // shell's already, so each is one row, ready.
        let zen = Found.Opencode(id: "opencode:opencode", integrationID: "opencode", name: "OpenCode", kind: .key, connected: false)
        let nvidia = Found.Opencode(id: "opencode:nvidia", integrationID: "nvidia", name: "Nvidia", kind: .key, connected: false)
        let offers = Offers(found: found(agents: bridge, opencode: [zen, nvidia], shell: [
            .init(integrationID: "opencode", name: "OpenCode", variable: "OPENCODE_API_KEY"),
            .init(integrationID: "nvidia", name: "Nvidia", variable: "NVIDIA_API_KEY"),
        ]))
        let all = offers.plans + offers.keys + offers.more
        #expect(all.filter { $0.integrationID == "opencode" }.map(\.detail) == ["From OPENCODE_API_KEY in your shell"])
        #expect(all.filter { $0.integrationID == "nvidia" }.map(\.detail) == ["From NVIDIA_API_KEY in your shell"])
        #expect(all.filter { ["opencode", "nvidia"].contains($0.integrationID) }.allSatisfy { $0.action == .ready })
    }

    @Test func aPlansKeyBroughtOverStillSaysWhatItIs() {
        let poe = Found.Opencode(id: "opencode:poe", integrationID: "poe", name: "Poe", kind: .key, connected: false)
        let row = Offers(found: found(agents: bridge, opencode: [poe]), used: ["opencode:poe"]).plans.first { $0.integrationID == "poe" }
        #expect(row?.action == .added)
        #expect(row?.detail == "Your key from opencode")
    }

    @Test func everyPlanAnAgentSignsInToHasOnlyThatWayIn() {
        // opencode signed in to Anthropic, xAI and Google too: each is its agent's row.
        let offers = Offers(found: found(agents: bridge, opencode: ["anthropic", "xai", "google", "openai"].map {
            Found.Opencode(id: "opencode:" + $0, integrationID: $0, name: $0, kind: .signIn, connected: false)
        }))
        let providers = Set(Plans.providers.values)
        #expect(!(offers.plans + offers.keys + offers.more).contains { providers.contains($0.integrationID) })
    }

    @Test func aBoxFromBeforeConnectedStillReadsAndNothingIsReadyByIt() throws {
        // A box before bridge 0.9.91 says nothing of what's signed in through the engine.
        let json = #"{"agents":[],"opencode":[],"shell":[]}"#
        let older = try JSONDecoder().decode(Found.self, from: Data(json.utf8))
        #expect(older.connected.isEmpty)
        #expect(Offers(found: older).plans.first { $0.integrationID == "github-copilot" }?.action == .signIn(integrationID: "github-copilot"))
    }

    @Test func notListedYetIsNotNothingFound() {
        // The box hasn't answered: nothing is offered yet.
        let waiting = Offers(found: nil)
        #expect(waiting.plans.isEmpty && waiting.keys.isEmpty && waiting.more.isEmpty)
    }
}
