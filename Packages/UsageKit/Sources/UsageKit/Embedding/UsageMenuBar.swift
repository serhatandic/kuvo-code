import AppKit
import Observation

/// Runs the usage dashboard in the host app's menu bar. (Fork addition: it takes the place of
/// OpenUsage's app delegate, without the parts that belong to a standalone menu-bar app — the
/// single-instance lock, updates, analytics, the local API and activation-policy changes.)
///
/// On first run nothing asks for Keychain access until the user turns the panel on: in the host's
/// own first launch (`turnOnFirstLaunch`), or with a first click on the menu bar item. (Fork change:
/// OpenUsage's welcome window is gone; the host's first launch has its row.)
/// Observable so the host's Settings page shows the panel's settings once they've loaded.
@MainActor
@Observable
public final class UsageMenuBar {
    public static let shared = UsageMenuBar()

    private(set) var container: AppContainer?
    private var statusItemController: StatusItemController?
    @ObservationIgnored private var openHost: (@MainActor () -> Void)?
    @ObservationIgnored private var started = false

    private init() {}

    /// Puts the item in the menu bar and starts refreshing. `openHostApp` brings the host's main
    /// window forward (the menus' "Open Kuvo Code").
    public func start(openHostApp: @escaping @MainActor () -> Void) {
        // A covered provider's reading takes this Mac's own login's limits from the host: drawn
        // again as they change (nothing is asked of its maker).
        HostLimits.shared.onChange = { [weak self] in self?.container?.dataStore.hostLimitsChanged() }
        guard !started else { return }
        started = true
        openHost = openHostApp
        AppLog.bootstrap()
        // Snapshots refreshed during a pass are saved together at its end; save what's pending when
        // the host quits mid-pass (upstream does this in its app delegate's `applicationWillTerminate`).
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated { UsageMenuBar.shared.container?.dataStore.flushPendingSnapshotWork() }
        }

        // The host's settings domain is never empty, so a missing schema stamp is what marks a first
        // run. Stamp it directly: the migrations convert old OpenUsage installs and must not run here.
        let defaults = UserDefaults.standard
        let isFreshInstall = defaults.object(forKey: SettingsMigrator.schemaVersionKey) == nil
        if isFreshInstall {
            defaults.set(SettingsSchema.current, forKey: SettingsMigrator.schemaVersionKey)
            FirstLaunchSetup.markPending()
        } else {
            SettingsMigrator.migrate()
        }
        AppearanceSetting.applyCurrent()

        Task {
            if ShellEnvironmentSnapshotStore.launchSnapshot == nil,
               !LoginShellEnvironment.shared.capturedSuccessfully {
                await Task.detached(priority: .userInitiated) {
                    _ = LoginShellEnvironment.shared.ensureCaptured()
                }.value
            }
            await finishLaunching(isFreshInstall: isFreshInstall)
        }
    }

    /// Refreshes the given providers now, every account card of each, skipping the cache: the host's
    /// accounts changed. Providers that are off stay off.
    func refresh(providerIDs: [String]) {
        guard let container, !FirstLaunchSetup.isPending() else { return }
        let families = Set(providerIDs)
        let cards = container.providers.map(\.provider.id).filter { families.contains(ProviderAccountID.family(of: $0)) }
        Task {
            for id in cards where container.enablement.isEnabled(id) {
                await container.dataStore.refresh(providerID: id, force: true)
            }
        }
    }

    /// The host's accounts, by provider: the panel follows only these, and turns on the ones
    /// newly connected. Before the panel is up, they're kept for when it is.
    func connectedProvidersDidChange(_ providers: Set<String>) {
        guard let container else {
            pendingConnected = providers
            return
        }
        let added = container.availability.setConnected(providers)
        for card in container.providers.map(\.provider.id) where added.contains(ProviderAccountID.family(of: card)) {
            container.enablement.setEnabled(true, for: card)
        }
        // Ones turned on before their account was connected, refreshed now that it is.
        if !added.isEmpty { Task { await container.dataStore.refreshAll() } }
    }

    @ObservationIgnored private var pendingConnected: Set<String>?

    /// Called each time the panel opens, for the host's own records.
    @ObservationIgnored public var onPanelShown: (() -> Void)?

    /// Shows the host's own page for the panel's settings (`UsageSettingsSections`), where they
    /// live; the panel's Settings opens it instead of its own screen. (Fork addition.)
    @ObservationIgnored public var settingsInHost: (@MainActor () -> Void)?

    /// The panel's Settings, in the host when it has a page for them: false when it doesn't.
    func openSettingsInHost() -> Bool {
        guard let settingsInHost else { return false }
        statusItemController?.close()
        Self.openHostApp()
        settingsInHost()
        return true
    }

    /// True once the menu bar item is up.
    public var isRunning: Bool { statusItemController != nil }

    /// Where the panel can open.
    public enum Screen: Sendable {
        case dashboard, customize, settings
    }

    /// Opens the panel on `screen`, or the welcome while it's pending.
    public func open(_ screen: Screen) {
        let target: PopoverScreen = switch screen {
        case .dashboard: .dashboard
        case .customize: .customize
        case .settings: .settings
        }
        statusItemController?.open(target)
    }

    /// The menus' "Open <host>" action.
    static func openHostApp() {
        shared.openHost?()
        NSApp.activate()
    }

    private func finishLaunching(isFreshInstall: Bool) async {
        let showsWelcome = FirstLaunchSetup.isPending()
        // Nothing asks for Keychain access before the user picks providers on the welcome screen.
        if showsWelcome { KeychainAccessGuard.holdPopups() }
        let container = await AppContainer(isFreshInstall: isFreshInstall || showsWelcome)
        self.container = container
        // (Its layout, checked against this Mac's providers, is where a change starts from.)
        HostSettings.shared.panelStarted()
        if let pendingConnected {
            self.pendingConnected = nil
            connectedProvidersDidChange(pendingConnected)
        }
        let controller = StatusItemController(container: container)
        controller.onShow = { [weak self] in self?.onPanelShown?() }
        statusItemController = controller
        if showsWelcome {
            controller.clickInterceptor = { [weak self] in self?.turnOnFromClick() ?? false }
        } else {
            startRefreshing(container)
        }
    }

    /// Refreshing starts once the host has handed over its accounts (`HostAccounts.update`), which
    /// its engine has only once it's up: before, Codex and Grok would read the logins their apps
    /// keep on the Mac in place of the host's sign-ins, and could renew them.
    private func startRefreshing(_ container: AppContainer) {
        if HostAccounts.haveArrived { container.startRefreshing() } else { refreshesOnHostAccounts = true }
    }

    @ObservationIgnored private var refreshesOnHostAccounts = false

    /// The host's accounts are in: refreshing starts, if it was waiting for them.
    func hostAccountsArrived() {
        guard refreshesOnHostAccounts, let container else { return }
        refreshesOnHostAccounts = false
        container.startRefreshing()
    }

    /// Whether the panel waits to be turned on: a fresh install, before the host's first launch or a
    /// click on the menu bar item turned it on.
    public var isWaitingForFirstLaunch: Bool { FirstLaunchSetup.isPending() }

    /// What turning the panel on found: the providers it follows now, by name, or why one couldn't
    /// be read (the first such, in words to show).
    public struct FirstLaunchResult: Sendable, Equatable {
        public var following: [String]
        public var failure: String?

        public init(following: [String], failure: String? = nil) {
            self.following = following
            self.failure = failure
        }
    }

    /// Turns the panel on, as the welcome's Connect did: the providers whose sign-ins are on this
    /// Mac and connected in the host, refreshed one at a time (macOS may ask to let the host read
    /// each one's saved sign-in). Nil while the panel is still starting. Accounts connected later
    /// are turned on as they come, as always. Asked again while it runs, it's the same run.
    public func turnOnFirstLaunch() async -> FirstLaunchResult? {
        guard let container else { return nil }
        guard FirstLaunchSetup.isPending() else { return FirstLaunchResult(following: following(container)) }
        if let turningOn { return await turningOn.value }
        let run = Task { await turnOn(container) }
        turningOn = run
        defer { turningOn = nil }
        return await run.value
    }

    @ObservationIgnored private var turningOn: Task<FirstLaunchResult, Never>?

    private func turnOn(_ container: AppContainer) async -> FirstLaunchResult {
        let setup = FirstLaunchSetup(
            providers: ProviderCatalog.make().map(\.provider),
            cards: container.providers,
            enablement: container.enablement,
            dataStore: container.dataStore,
            isConnected: { [availability = container.availability] in availability.isConnected($0) }
        )
        await setup.detect()
        await setup.connectSelected()
        finishFirstLaunch(container)
        let failure = setup.choices.lazy.compactMap { choice -> String? in
            guard case .failed(let message) = choice.connection else { return nil }
            // Said where there's no Retry beside it.
            return message == FirstLaunchSetup.accessDeniedMessage ? "A sign-in couldn’t be read, so its usage doesn’t show yet." : message
        }.first
        return FirstLaunchResult(following: following(container), failure: failure)
    }

    /// The providers the panel shows, by name.
    private func following(_ container: AppContainer) -> [String] {
        ProviderCatalog.make().map(\.provider)
            .filter { provider in container.providers.contains { ProviderAccountID.family(of: $0.provider.id) == provider.id && container.enablement.isEnabled($0.provider.id) } }
            .map(\.displayName)
    }

    /// A first click on the menu bar item while it waits opens it and turns it on, the bars coming
    /// in as each plan is read.
    private func turnOnFromClick() -> Bool {
        if FirstLaunchSetup.isPending() { Task { _ = await turnOnFirstLaunch() } }
        return false
    }

    private func finishFirstLaunch(_ container: AppContainer) {
        KeychainAccessGuard.allowPopups()
        FirstLaunchSetup.clearPending()
        statusItemController?.clickInterceptor = nil
        // With nothing on, the empty dashboard already points to Customize.
        if container.enablement.enabledIDs?.isEmpty == true {
            container.onboarding.dismissCustomizeHint()
        }
        startRefreshing(container)
    }
}
