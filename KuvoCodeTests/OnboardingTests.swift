import Foundation
import Testing
import UsageKit
@testable import KuvoCode

/// The first launch: which of what a computer has is offered, and how (its box's list, as
/// `kuvo/accounts/found` answers it; the Box package's found tests check the list itself); screen
/// access moving on once macOS says it's allowed; and where you are kept across a quit and reopen.
/// macOS's permissions are a stand-in (what `CGPreflightScreenCaptureAccess` and
/// `AXIsProcessTrusted` would say), switched as you'd switch them in System Settings.
@MainActor
@Suite final class OnboardingTests {
    let defaults: UserDefaults
    let suite = "onboarding-tests-\(UUID().uuidString)"

    init() {
        TestEnvironment.prepare()
        defaults = UserDefaults(suiteName: suite)!
    }

    deinit { UserDefaults().removePersistentDomain(forName: suite) }

    /// What macOS says, as System Settings would change it.
    final class Permissions {
        var allowed: Set<ScreenAccess.Permission> = []
        lazy var source = ScreenAccess.Source { [self] in allowed.contains($0) }
    }

    private func found(agents: [Found.Agent] = [], opencode: [Found.Opencode] = [], shell: [Found.Shell] = []) -> Found {
        Found(agents: agents, opencode: opencode, shell: shell)
    }

    // MARK: Which sign-ins are offered

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

    // MARK: Moving on once a permission is granted

    @Test func bothAllowedMovesOnByItself() {
        let permissions = Permissions()
        let onboarding = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: permissions.source))
        onboarding.engineReady()
        #expect(onboarding.step == .subscriptions)
        onboarding.advance()
        #expect(onboarding.step == .screenAccess)

        // Screen Recording switched on in System Settings, then Kuvo Code checks (it came back to
        // the front, or the second's check while System Settings is open): still one to go.
        permissions.allowed.insert(.screenRecording)
        onboarding.screen.refresh()
        #expect(onboarding.screen.allowed == [.screenRecording])
        #expect(onboarding.step == .screenAccess)

        permissions.allowed.insert(.accessibility)
        onboarding.screen.refresh()
        #expect(onboarding.step == .done)
        #expect(!onboarding.isActive)
    }

    @Test func alreadyAllowedSkipsScreenAccess() {
        let permissions = Permissions()
        let onboarding = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: permissions.source))
        onboarding.engineReady()
        // Allowed in System Settings while the subscriptions showed.
        permissions.allowed = [.screenRecording, .accessibility]
        onboarding.advance()
        #expect(onboarding.step == .done)
    }

    @Test func notNowLeavesWithoutThem() {
        let permissions = Permissions()
        let onboarding = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: permissions.source))
        onboarding.engineReady()
        onboarding.advance()
        onboarding.finish()
        #expect(onboarding.step == .done)
        // Allowed later, in System Settings: nothing comes back.
        permissions.allowed = [.screenRecording, .accessibility]
        onboarding.screen.refresh()
        #expect(onboarding.step == .done)
    }

    // MARK: The usage panel's row

    /// The usage panel as UsageKit's would answer: waiting until it's turned on.
    final class Panel {
        var waiting = true
        var result: UsageMenuBar.FirstLaunchResult? = .init(following: ["Claude", "Codex"])
        lazy var panel = Onboarding.UsagePanel(
            isWaiting: { [self] in waiting },
            turnOn: { [self] in waiting = result == nil; return result })
    }

    @Test func turningUsageOnSaysWhatItFollows() async {
        let usage = Panel()
        let onboarding = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: Permissions().source), usage: usage.panel)
        onboarding.engineReady()
        #expect(onboarding.offersUsage)
        await onboarding.turnOnUsage()
        #expect(onboarding.usage == .on(following: ["Claude", "Codex"], failure: nil))
        #expect(onboarding.offersUsage, "it stays, checked")
    }

    @Test func leavingWithoutTurningUsageOnLeavesItWaiting() {
        let usage = Panel()
        let onboarding = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: Permissions().source), usage: usage.panel)
        onboarding.engineReady()
        onboarding.advance()
        onboarding.finish()
        #expect(usage.waiting, "it reads no plan's sign-in until you turn it on (a click on it does)")
    }

    @Test func usageStillStartingCanBeTriedAgain() async {
        let usage = Panel()
        usage.result = nil
        let onboarding = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: Permissions().source), usage: usage.panel)
        await onboarding.turnOnUsage()
        #expect(onboarding.usage == .off("The usage panel is still starting. Try again in a moment."))
        usage.result = .init(following: [])
        await onboarding.turnOnUsage()
        #expect(onboarding.usage == .on(following: [], failure: nil))
    }

    // MARK: Where you are, kept

    @Test func reopeningContinuesWhereYouWere() {
        let permissions = Permissions()
        let first = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: permissions.source))
        first.engineReady()
        first.advance()
        #expect(first.step == .screenAccess)
        // Screen Recording asks you to quit and reopen; Kuvo Code opens on the same step, allowed.
        permissions.allowed = [.screenRecording]
        let reopened = Onboarding(defaults: defaults, launchedBefore: true, screen: ScreenAccess(source: permissions.source))
        #expect(reopened.step == .screenAccess)
        #expect(reopened.screen.allowed == [.screenRecording])
    }

    @Test func reopenedOnScreenAccessItStillMovesOnByItself() {
        let permissions = Permissions()
        let first = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: permissions.source))
        first.engineReady()
        first.advance()
        // Screen Recording, then Quit & Reopen; then Accessibility switched on in System Settings.
        permissions.allowed = [.screenRecording]
        let reopened = Onboarding(defaults: defaults, launchedBefore: true, screen: ScreenAccess(source: permissions.source))
        permissions.allowed.insert(.accessibility)
        reopened.screen.refresh()
        #expect(reopened.step == .done)
    }

    @Test func reopenedWithBothAllowedGoesStraightIn() {
        let permissions = Permissions()
        let first = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: permissions.source))
        first.engineReady()
        first.advance()
        permissions.allowed = [.screenRecording, .accessibility]
        #expect(!Onboarding(defaults: defaults, launchedBefore: true, screen: ScreenAccess(source: permissions.source)).isActive)
    }

    @Test func quitWhileGettingReadyOpensOnTheBotsAgain() {
        // The download failed, or was slow, and Kuvo Code was quit; opened again later, it has run before.
        _ = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: Permissions().source))
        let reopened = Onboarding(defaults: defaults, launchedBefore: true, screen: ScreenAccess(source: Permissions().source))
        #expect(reopened.step == .loader)
    }

    @Test func aCopyThatRanBeforeNeverShowsIt() {
        let updated = Onboarding(defaults: defaults, launchedBefore: true, screen: ScreenAccess(source: Permissions().source))
        #expect(!updated.isActive)
        // And it stays that way.
        #expect(!Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: Permissions().source)).isActive)
    }
}
