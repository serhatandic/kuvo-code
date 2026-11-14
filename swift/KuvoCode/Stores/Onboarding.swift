import AppKit
import ClientAccounts
import Foundation
import UsageKit

/// Kuvo Code's first launch: the bots get it ready (the engine's download and start), you bring
/// over the subscriptions this computer already has, and you allow screen access for agents. Each
/// step can be skipped; where you are is kept, so quitting partway (Screen Recording asks you to
/// quit and reopen) opens on the same step again. Shown once, and never to a copy that's run before.
@Observable
final class Onboarding {
    enum Step: String, CaseIterable {
        /// The bots, while the engine downloads and starts.
        case loader
        case subscriptions
        case screenAccess
        case done
    }

    private(set) var step: Step

    /// What this computer has that Kuvo Code can use, as its box lists it (`kuvo/accounts/found`).
    private(set) var found: Found?
    /// Counts the looks: only the latest one's answer counts.
    @ObservationIgnored private var looks = 0
    /// The list came while the coding agents' bridge was up: an empty one is all there is.
    private(set) var lookedWithAgents = false
    /// Why the list couldn't be read, in words.
    private(set) var lookFailure: String?
    /// opencode keys brought over just now, by id, and ones on their way.
    private(set) var used: Set<String> = []
    private(set) var using: Set<String> = []
    private(set) var useFailure: String?
    /// Agents' installs from this step that didn't work, by integration, until you've seen them.
    private(set) var installFailures: [String: InstallFailure] = [:]
    /// The one to say next.
    var installFailure: InstallFailure? { installFailures.values.min { $0.name < $1.name } }
    /// Where they were taken from, to give back unseen when the step goes.
    @ObservationIgnored private weak var installingAgents: OutsideAgents?

    struct InstallFailure: Equatable {
        var integrationID: String
        var name: String
        /// What went wrong, in the installer's words.
        var message: String
    }

    /// The usage panel in the menu bar: off until it's turned on here (or by a click on it).
    private(set) var usage = Usage.off(nil)

    let screen: ScreenAccess
    private let usagePanel: UsagePanel

    static let stepKey = "onboarding.step"
    private let defaults: UserDefaults

    /// `launchedBefore`: this copy has run before (an update, not a first launch).
    init(defaults: UserDefaults = .standard, launchedBefore: Bool, screen: ScreenAccess = ScreenAccess(), usage: UsagePanel = .menuBar) {
        self.defaults = defaults
        self.screen = screen
        usagePanel = usage
        if let saved = defaults.string(forKey: Self.stepKey).flatMap(Step.init(rawValue:)) {
            step = saved
        } else {
            step = launchedBefore ? .done : .loader
        }
        #if DEBUG
        // KUVO_DEMO_ONBOARDING=<step>: shows the first launch from that step (`loader` while the
        // engine starts, `subscriptions`, `screenAccess`), for a look at it in a demo copy.
        if let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_ONBOARDING"], let shown = Step(rawValue: demo) { step = shown }
        #endif
        // Kept from the start, so a quit during the loader opens on it again.
        defaults.set(step.rawValue, forKey: Self.stepKey)
        // Opened again on screen access (Screen Recording asks you to quit and reopen): followed
        // again, and done once both are allowed.
        if step == .screenAccess { arrive(at: .screenAccess) }
    }

    var isActive: Bool { step != .done }

    /// On to the next step (or the one after, when there's nothing to do in it).
    func advance() {
        screen.refresh()
        guard let index = Step.allCases.firstIndex(of: step), index + 1 < Step.allCases.count else { return }
        var next = Step.allCases[index + 1]
        // Screen access already allowed (a copy you've run, a Mac set up before): nothing to ask.
        if next == .screenAccess, screen.allAllowed { next = .done }
        move(to: next)
    }

    /// Leaves the first launch for the workspace.
    func finish() { move(to: .done) }

    private func move(to next: Step) {
        if step == .subscriptions, next != .subscriptions { giveBackInstallFailures() }
        step = next
        defaults.set(next.rawValue, forKey: Self.stepKey)
        Analytics.shared.onboardingStep(next == .screenAccess ? "screen_access" : next.rawValue)
        arrive(at: next)
    }

    /// What a step follows while it shows: screen access, the permissions.
    private func arrive(at step: Step) {
        guard step == .screenAccess else { return screen.stopWatching() }
        screen.watch { [weak self] in self?.screenChanged() }
        screenChanged()
    }

    /// The engine's ready: from the loader, on to the subscriptions.
    func engineReady() {
        if step == .loader { advance() }
    }

    // MARK: Subscriptions

    /// Reads the list from this computer's box. Again after a sign-in or an install changes it.
    func look(in box: BoxClient, agentsUp: Bool = false) async {
        looks += 1
        let look = looks
        do {
            let answer = try await box.value(Found.self, "GET", "kuvo/accounts/found")
            guard look == looks else { return }
            // What the box couldn't read just now (this Mac's engine restarting) as it last was.
            found = answer.keeping(found)
            lookedWithAgents = agentsUp
            lookFailure = nil
        } catch {
            // Given up for a newer look (the box came up meanwhile), or the box still starting (it's
            // looked for again once it's up): not a failure.
            guard look == looks, !Task.isCancelled, (error as? BoxRefusal)?.status != 503 else { return }
            if found == nil { lookFailure = error.localizedDescription }
        }
    }

    /// Brings an opencode key over into the engine. True once it's there.
    @discardableResult
    func use(_ item: Found.Opencode, in box: BoxClient) async -> Bool {
        guard !using.contains(item.id) else { return false }
        using.insert(item.id)
        defer { using.remove(item.id) }
        struct Body: Encodable { var id: String }
        do {
            let (status, data) = try await box.send("POST", "kuvo/accounts/found/use", body: JSONEncoder().encode(Body(id: item.id)))
            if (200..<300).contains(status) {
                used.insert(item.id)
                useFailure = nil
                return true
            }
            useFailure = BoxRefusal(status: status, data: data).message
        } catch {
            useFailure = error.localizedDescription
        }
        return false
    }

    /// Runs an agent's installer from this step (`OutsideAgents.install`). Why one didn't work is
    /// this step's to say while it shows, rather than Settings › Accounts' the next time it opens;
    /// one that fails after you've gone on, or that you haven't seen yet, is Settings' to say. So
    /// is the sign-in that follows one installed after you've gone on: `refresh` gets whether to
    /// sign in here.
    func install(_ row: Offers.Row, with agents: OutsideAgents, then refresh: @escaping (_ signInHere: Bool) async -> Void) {
        guard case .install(let id) = row.action else { return }
        installFailures[id] = nil
        installingAgents = agents
        agents.install(id) { [weak self] installed in
            let here = self?.step == .subscriptions
            if let self, here, let message = agents.installFailures.removeValue(forKey: id) {
                installFailures[id] = InstallFailure(integrationID: id, name: row.name, message: message)
            }
            if installed, !here { agents.signInsAfterInstall.insert(id) }
            await refresh(installed && here)
        }
    }

    private func giveBackInstallFailures() {
        for failure in installFailures.values { installingAgents?.installFailures[failure.integrationID] = failure.message }
        installFailures = [:]
    }

    func seenInstallFailure(_ integrationID: String) { installFailures[integrationID] = nil }

    /// Whether the usage panel's row shows: while it waits to be turned on, and once it's on.
    var offersUsage: Bool {
        if case .off = usage { usagePanel.isWaiting() } else { true }
    }

    /// Turns the usage panel on, for the plans whose sign-ins are on this Mac (macOS may ask to let
    /// Kuvo Code read each one).
    func turnOnUsage() async {
        guard case .off = usage else { return }
        usage = .turningOn
        guard let result = await usagePanel.turnOn() else {
            usage = .off("The usage panel is still starting. Try again in a moment.")
            return
        }
        usage = .on(following: result.following, failure: result.failure)
    }

    /// The coding agents, as the step looks for them.
    enum AgentsLookup: Equatable {
        case listed, looking
        /// They can't be listed, and why.
        case failed(String)
    }

    /// Whether the coding agents are listed, still being looked for, or can't be: their bridge
    /// didn't start (`failure`), or was up and listed none.
    func agents(failure: String?) -> AgentsLookup {
        guard offers.agentsPending else { return .listed }
        if let failure { return .failed(failure) }
        return lookedWithAgents ? .failed("The coding agents didn’t answer.") : .looking
    }

    /// What the screen offers, from what was found.
    var offers: Offers { Offers(found: found, used: used) }

    // MARK: Screen access

    private func screenChanged() {
        // Both allowed: on into the workspace, by itself.
        if step == .screenAccess, screen.allAllowed { finish() }
    }
}

extension Onboarding {
    enum Usage: Equatable {
        /// Not turned on, with why it couldn't be just now.
        case off(String?)
        case turningOn
        /// On, following these plans; `failure`: why one couldn't be read.
        case on(following: [String], failure: String?)
    }

    /// The usage panel, as the first launch turns it on: UsageKit's in the menu bar, or a test's.
    struct UsagePanel {
        var isWaiting: () -> Bool
        var turnOn: @MainActor () async -> UsageMenuBar.FirstLaunchResult?

        static let menuBar = UsagePanel(
            isWaiting: { UsageMenuBar.shared.isWaitingForFirstLaunch },
            turnOn: { await UsageMenuBar.shared.turnOnFirstLaunch() })
    }
}
