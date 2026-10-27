import Foundation
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
