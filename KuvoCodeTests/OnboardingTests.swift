import ClientAccounts
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
import UsageKit
@testable import KuvoCode

/// The first launch: screen access moving on once macOS says it's allowed, and where you are kept
/// across a quit and reopen. (Which of what a computer has is offered, and how: KuvoClient's
/// ClientAccountsTests; the box's list itself: the Box package's found tests.)
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

    // MARK: Bring your subscriptions

    /// Whether this Mac's box is still starting up.
    nonisolated final class StartingUp: @unchecked Sendable {
        private let lock = NSLock()
        private var value = true
        var isOn: Bool {
            get { lock.withLock { value } }
            set { lock.withLock { value = newValue } }
        }
    }

    /// This Mac's box answering `kuvo/accounts/found`: not yet while it starts, then nothing found.
    private func foundBox(_ starting: StartingUp) -> BoxClient {
        BoxClient(box: BoxClient.mac, transport: LocalBox { _ in
            let now = starting.isOn
            return AsyncThrowingStream { continuation in
                if now {
                    continuation.yield(.head(status: 503, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(Data(#"{"message":"Kuvo Code’s background service on this Mac isn’t answering. Try again in a moment."}"#.utf8)))
                } else {
                    continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                    continuation.yield(.body(Data(#"{"agents":[],"opencode":[],"shell":[],"connected":[]}"#.utf8)))
                }
                continuation.finish()
            }
        })
    }

    /// The first look comes a moment before this Mac's box answers: the step goes on looking, as
    /// it does once the box is up, rather than saying it couldn't.
    @Test func aBoxStillStartingIsStillLooking() async {
        let onboarding = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: Permissions().source))
        let starting = StartingUp()
        let box = foundBox(starting)
        await onboarding.look(in: box)
        #expect(onboarding.lookFailure == nil, "not a failure: it's starting")
        #expect(onboarding.found == nil)
        starting.isOn = false
        await onboarding.look(in: box)
        #expect(onboarding.found != nil)
    }

    /// A box that answers but can't list them says why, with Try Again: only a box still starting
    /// is still looked for.
    @Test func aBoxThatFailsSaysWhy() async {
        let onboarding = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: Permissions().source))
        let box = BoxClient(box: BoxClient.mac, transport: LocalBox { _ in
            AsyncThrowingStream { continuation in
                continuation.yield(.head(status: 500, headers: ["content-type": "application/json"]))
                continuation.yield(.body(Data(#"{"message":"The engine’s list of sign-ins couldn’t be read."}"#.utf8)))
                continuation.finish()
            }
        })
        await onboarding.look(in: box)
        #expect(onboarding.lookFailure == "The engine’s list of sign-ins couldn’t be read.")
        #expect(onboarding.found == nil)
    }

    /// The coding agents' bridge never lists them (it didn't start, or answered with none): the
    /// step stops looking for them and says so, rather than spinning on.
    @Test func codingAgentsNeverListedSayItAndTryAgain() async {
        let onboarding = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: Permissions().source))
        let starting = StartingUp()
        starting.isOn = false
        let box = foundBox(starting)
        // The bridge is still starting: looking.
        await onboarding.look(in: box, agentsUp: false)
        #expect(onboarding.agents(failure: nil) == .looking)
        // It couldn't start: why, to try again.
        #expect(onboarding.agents(failure: "It stopped.") == .failed("It stopped."))
        // Up, and the box still lists none: not looking for ever.
        await onboarding.look(in: box, agentsUp: true)
        guard case .failed = onboarding.agents(failure: nil) else { Issue.record("still looking"); return }
    }

    /// This Mac's box answering `kuvo/accounts/found` with each of `answers` in turn, the last again.
    private func answering(_ answers: [String]) -> BoxClient {
        let given = Given(answers)
        return BoxClient(box: BoxClient.mac, transport: LocalBox { _ in
            let body = given.next()
            return AsyncThrowingStream { continuation in
                continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                continuation.yield(.body(Data(body.utf8)))
                continuation.finish()
            }
        })
    }

    nonisolated final class Given: @unchecked Sendable {
        private let lock = NSLock()
        private var answers: [String]
        init(_ answers: [String]) { self.answers = answers }
        func next() -> String { lock.withLock { answers.count > 1 ? answers.removeFirst() : answers[0] } }
    }

    /// This Mac's engine restarts (or is slow to answer) while the step shows, and the agents'
    /// bridge with it: the box can't read them, and says so. What's signed in stays so, rather than
    /// turning to Sign In… and Use for as long as they're away; once they're back, they're read again.
    @Test func whatsSignedInStaysSoWhileTheEngineIsAway() async {
        let onboarding = Onboarding(defaults: defaults, launchedBefore: false, screen: ScreenAccess(source: Permissions().source))
        let box = answering([
            #"{"agents":[{"id":"claude-code","name":"Claude Code","installed":true,"signedIn":true,"label":"you@example.com"},{"id":"codex-cli","name":"Codex","installed":true,"signedIn":false}],"opencode":[{"id":"opencode:openrouter","integrationID":"openrouter","name":"OpenRouter","kind":"key","connected":true}],"shell":[],"connected":["github-copilot","openrouter"],"unread":[]}"#,
            // As the box answers while neither is running: opencode's keys still listed, by their ids.
            #"{"agents":[],"opencode":[{"id":"opencode:openrouter","integrationID":"openrouter","name":"openrouter","kind":"key","connected":false}],"shell":[],"connected":[],"unread":["engine","agents"]}"#,
            // Back, with Copilot signed out meanwhile.
            #"{"agents":[{"id":"claude-code","name":"Claude Code","installed":true,"signedIn":true,"label":"you@example.com"},{"id":"codex-cli","name":"Codex","installed":true,"signedIn":false}],"opencode":[{"id":"opencode:openrouter","integrationID":"openrouter","name":"OpenRouter","kind":"key","connected":true}],"shell":[],"connected":["openrouter"],"unread":[]}"#,
        ])
        func row(_ id: String) -> Offers.Row? { (onboarding.offers.plans + onboarding.offers.keys).first { $0.integrationID == id } }

        await onboarding.look(in: box, agentsUp: true)
        let before = onboarding.offers
        #expect(row("github-copilot")?.action == .ready)

        await onboarding.look(in: box, agentsUp: true)
        #expect(onboarding.offers == before)
        #expect(row("claude-code")?.detail == "Signed in as you@example.com")
        #expect(row("openrouter")?.name == "OpenRouter")
        #expect(row("openrouter")?.action == .ready)

        await onboarding.look(in: box, agentsUp: true)
        #expect(row("github-copilot")?.action == .signIn(integrationID: "github-copilot"))
        #expect(row("claude-code")?.action == .ready)
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

/// An agent installed from the first launch that doesn't get installed: the step says why, and
/// Settings › Accounts doesn't raise it again the next time it opens. The agents' bridge is stubbed.
@MainActor
@Suite(.serialized) struct OnboardingInstallTests {
    let bridge = "http://127.0.0.1:47976"
    let suite = "onboarding-install-\(UUID().uuidString)"
    let agents = OutsideAgents()
    let onboarding: Onboarding

    init() {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        agents.connect(ServerEndpoint(url: URL(string: bridge)!, password: "test"), folderPrefix: "")
        onboarding = Onboarding(defaults: UserDefaults(suiteName: suite)!, launchedBefore: false, screen: ScreenAccess(source: OnboardingTests.Permissions().source))
        // On "Bring your subscriptions", once the engine's ready.
        onboarding.engineReady()
    }

    private func done() {
        onboarding.finish()
        agents.disconnect()
        StubWeb.stop()
        UserDefaults().removePersistentDomain(forName: suite)
    }

    /// Why `agent`'s installer didn't install it, as the bridge answers.
    private func failing(_ agent: String, _ why: String) {
        StubWeb.handle(bridge + "/api/integration/\(agent)/install") { _, _ in
            StubWeb.json(["data": ["installed": false, "message": why]])
        }
    }

    /// The step's rows, on a Mac with neither Claude Code nor Codex.
    private func rows() async throws -> (claude: Offers.Row, codex: Offers.Row) {
        let box = BoxClient(box: BoxClient.mac, transport: LocalBox { _ in
            AsyncThrowingStream { continuation in
                continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                continuation.yield(.body(Data(#"{"agents":[{"id":"claude-code","name":"Claude Code","installed":false,"signedIn":false},{"id":"codex-cli","name":"Codex","installed":false,"signedIn":false}],"opencode":[],"shell":[],"connected":[]}"#.utf8)))
                continuation.finish()
            }
        })
        await onboarding.look(in: box, agentsUp: true)
        let claude = try #require(onboarding.offers.plans.first { $0.id == "claude-code" })
        let codex = try #require(onboarding.offers.plans.first { $0.id == "codex-cli" })
        #expect(claude.action == .install(integrationID: "claude-code"))
        return (claude, codex)
    }

    /// Install, as its row's button does: whether it's there after.
    private func install(_ row: Offers.Row) async -> Bool {
        await withCheckedContinuation { done in
            onboarding.install(row, with: agents) { done.resume(returning: $0) }
        }
    }

    @Test func aFailedInstallSaysWhyThereAndNotLaterInSettings() async throws {
        defer { done() }
        let why = "Claude Code isn't installed after “curl -fsSL https://claude.ai/install.sh | bash”.\n\ncurl: (6) Could not resolve host: claude.ai"
        failing("claude-code", why)
        let claude = try await rows().claude

        #expect(await !install(claude))
        #expect(onboarding.installFailure == Onboarding.InstallFailure(integrationID: "claude-code", name: "Claude Code", message: why),
                "the step says why, in the installer's words")
        #expect(agents.installFailures["claude-code"] == nil, "nothing left for Settings › Accounts to raise later")

        onboarding.seenInstallFailure("claude-code")
        #expect(onboarding.installFailure == nil)
    }

    /// Two installs that don't work, one soon after the other: each is said, in turn.
    @Test func twoFailedInstallsAreEachSaid() async throws {
        defer { done() }
        failing("claude-code", "curl: (6) Could not resolve host: claude.ai")
        failing("codex-cli", "curl: (6) Could not resolve host: chatgpt.com")
        let (claude, codex) = try await rows()
        async let first = install(claude)
        async let second = install(codex)
        _ = await (first, second)

        #expect(onboarding.installFailure?.name == "Claude Code")
        onboarding.seenInstallFailure("claude-code")
        #expect(onboarding.installFailure?.name == "Codex", "the other is said next, not lost")
        #expect(onboarding.installFailure?.message == "curl: (6) Could not resolve host: chatgpt.com")
        onboarding.seenInstallFailure("codex-cli")
        #expect(onboarding.installFailure == nil)
    }

    /// Install, then Continue while it runs: when it fails, it's Settings › Accounts' to say, as
    /// the step is gone.
    @Test func anInstallThatFailsAfterYouWentOnIsSaidInSettings() async throws {
        defer { done() }
        failing("claude-code", "curl: (6) Could not resolve host: claude.ai")
        let claude = try await rows().claude
        #expect(onboarding.step == .subscriptions)
        let installed = await withCheckedContinuation { finished in
            onboarding.install(claude, with: agents) { finished.resume(returning: $0) }
            onboarding.advance()
        }
        #expect(!installed)
        #expect(onboarding.step != .subscriptions)
        #expect(onboarding.installFailure == nil)
        #expect(agents.installFailures["claude-code"] == "curl: (6) Could not resolve host: claude.ai")
    }

    /// Install, then Continue while it runs: once it's installed, its sign-in opens in Settings ›
    /// Accounts, as the step that would have opened it is gone. Installed while the step shows, it
    /// signs in there.
    @Test func anInstallThatFinishesAfterYouWentOnSignsInFromSettings() async throws {
        defer { done() }
        StubWeb.handle(bridge + "/api/integration/claude-code/install") { _, _ in StubWeb.json(["data": ["installed": true]]) }
        StubWeb.handle(bridge + "/api/integration/codex-cli/install") { _, _ in StubWeb.json(["data": ["installed": true]]) }
        let (claude, codex) = try await rows()

        #expect(await install(codex), "signs in on the step")
        #expect(agents.signInsAfterInstall.isEmpty)

        let signInHere = await withCheckedContinuation { finished in
            onboarding.install(claude, with: agents) { finished.resume(returning: $0) }
            onboarding.advance()
        }
        #expect(!signInHere, "not on a step that's gone")
        #expect(agents.signInsAfterInstall == ["claude-code"], "Settings › Accounts opens it")
    }

    /// One the step had but you hadn't seen yet, when you go on: Settings › Accounts says it.
    @Test func anUnseenFailureGoesToSettingsWithTheStep() async throws {
        defer { done() }
        failing("claude-code", "curl: (6) Could not resolve host: claude.ai")
        let claude = try await rows().claude
        #expect(await !install(claude))
        #expect(onboarding.installFailure != nil)
        onboarding.advance()
        #expect(onboarding.installFailure == nil)
        #expect(agents.installFailures["claude-code"] == "curl: (6) Could not resolve host: claude.ai")
    }
}
