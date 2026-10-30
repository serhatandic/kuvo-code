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
    @Test func aFailedInstallSaysWhyThereAndNotLaterInSettings() async throws {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1"])
        defer { StubWeb.stop() }
        let bridge = "http://127.0.0.1:47976"
        let why = "Claude Code isn't installed after `curl -fsSL https://claude.ai/install.sh | bash`.\n\ncurl: (6) Could not resolve host: claude.ai"
        StubWeb.handle(bridge + "/api/integration/claude-code/install") { _, _ in
            StubWeb.json(["data": ["installed": false, "message": why]])
        }
        let agents = OutsideAgents()
        agents.connect(ServerEndpoint(url: URL(string: bridge)!, password: "test"), folderPrefix: "")
        defer { agents.disconnect() }

        let suite = "onboarding-install-\(UUID().uuidString)"
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let onboarding = Onboarding(defaults: UserDefaults(suiteName: suite)!, launchedBefore: false, screen: ScreenAccess(source: OnboardingTests.Permissions().source))
        // This Mac has neither Claude Code nor Codex.
        let box = BoxClient(box: BoxClient.mac, transport: LocalBox { _ in
            AsyncThrowingStream { continuation in
                continuation.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                continuation.yield(.body(Data(#"{"agents":[{"id":"claude-code","name":"Claude Code","installed":false,"signedIn":false},{"id":"codex-cli","name":"Codex","installed":false,"signedIn":false}],"opencode":[],"shell":[],"connected":[]}"#.utf8)))
                continuation.finish()
            }
        })
        await onboarding.look(in: box, agentsUp: true)
        let claude = try #require(onboarding.offers.plans.first { $0.id == "claude-code" })
        #expect(claude.action == .install(integrationID: "claude-code"))

        // Install, as its row's button does.
        let installed = await withCheckedContinuation { done in
            onboarding.install(claude, with: agents) { done.resume(returning: $0) }
        }
        #expect(!installed)
        #expect(onboarding.installFailure == Onboarding.InstallFailure(integrationID: "claude-code", name: "Claude Code", message: why),
                "the step says why, in the installer's words")
        #expect(agents.installFailures["claude-code"] == nil, "nothing left for Settings › Accounts to raise later")

        onboarding.seenInstallFailure()
        #expect(onboarding.installFailure == nil)
    }
}
