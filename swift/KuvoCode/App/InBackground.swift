import AppKit
import SwiftUI
import UsageKit

/// Quit, while this Mac's keeper runs its box (`BackgroundWork`): every window closes and Kuvo Code
/// leaves the Dock, but stays in the menu bar, where the usage item's panel says what's still
/// working (`BackgroundWorkCard`), with Open Kuvo Code and Stop. **Stop Background Work** (⌥⌘Q, or
/// the card's Stop) stops the work and quits for real. Opening Kuvo Code again (from the card, the
/// Finder, a notification) brings it back to the Dock with its window.
@MainActor @Observable
final class InBackground {
    static let shared = InBackground()

    /// Its window closed and out of the Dock, still in the menu bar.
    private(set) var isOn = false
    /// Quitting for real (Stop Background Work, an update installing): the next Quit isn't taken.
    @ObservationIgnored var quitsForReal = false
    /// Whether the note on the first Quit was dismissed ("Kuvo Code keeps working").
    var noteSeen = UserDefaults.standard.bool(forKey: InBackground.noteKey) {
        didSet { UserDefaults.standard.set(noteSeen, forKey: Self.noteKey) }
    }
    /// Whether the panel was opened once on its own to show the note: closed without dismissing it,
    /// the note waits in the panel, and a later Quit doesn't open it again.
    @ObservationIgnored private var noteOpened = UserDefaults.standard.bool(forKey: InBackground.noteOpenedKey) {
        didSet { UserDefaults.standard.set(noteOpened, forKey: Self.noteOpenedKey) }
    }
    static let noteKey = "backgroundWork.noteSeen"
    static let noteOpenedKey = "backgroundWork.noteOpened"

    /// When an update installing on Quit was started (`installWaitingUpdate`): the relaunch after
    /// it goes straight to the background, as Kuvo Code was.
    static let relaunchKey = "backgroundWork.relaunchInBackground"
    /// What this Mac's keeper opens Kuvo Code with when an agent needs its browser while it's
    /// closed (`AppOpener`, hidden and not activated): straight to the background, quietly.
    nonisolated static let launchArgument = "--in-background"
    /// This launch is the keeper's, for an agent's browser: in the background with nothing shown,
    /// not even the note (you didn't quit it; it opened by itself).
    @ObservationIgnored private(set) lazy var openedQuietly: Bool = CommandLine.arguments.contains(Self.launchArgument)
    /// This launch goes straight to the background: the relaunch after an update installed from
    /// the background (read once, as it starts, and forgotten: a launch after it opens as usual),
    /// or the keeper's (`openedQuietly`).
    @ObservationIgnored private(set) lazy var relaunchesInBackground: Bool = {
        let defaults = UserDefaults.standard
        var updated = false
        if let started = defaults.object(forKey: Self.relaunchKey) as? Date {
            defaults.removeObject(forKey: Self.relaunchKey)
            // An install that never relaunched leaves it behind: a launch much later is one of yours.
            updated = abs(started.timeIntervalSinceNow) < 10 * 60
        }
        return updated || openedQuietly
    }()
    /// An update Sparkle downloaded to install on Quit (`UpdateSteps`): Quit no longer quits while
    /// the work goes on, so it's installed as Kuvo Code goes to the background.
    @ObservationIgnored var waitingUpdate: (() -> Void)? {
        didSet { if waitingUpdate != nil, isOn { installWaitingUpdate() } }
    }

    /// Whether Quit goes to the background now (`AppModel.keepsWorkingAfterQuit`), for those
    /// without the app at hand (`UpdateSteps`).
    @ObservationIgnored var keepsWorking: () -> Bool = { false }

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var item: BackgroundWorkItem?
    @ObservationIgnored private var windowWatch: (any NSObjectProtocol)?
    /// Relaunched into the background: the main window SwiftUI opens with the app closes again
    /// instead of bringing Kuvo Code back.
    @ObservationIgnored private var launching = false

    /// Quit taken as going to the background: the windows close, the Dock icon goes, and the usage
    /// item shows the work (the first time, with a note that says so). `usageStarting`: the usage
    /// item is on its way (at launch, before it's up), so no item of its own. `quietly`: nothing
    /// opens to show the note, and Kuvo Code doesn't take focus.
    func enter(_ app: AppModel, usageStarting: Bool = false, quietly: Bool = false) {
        self.app = app
        watchWindows()
        // Minimized ones too. Not the menu bar's own windows, popovers or panels.
        for window in NSApp.windows where !(window is NSPanel) && window.canBecomeMain && (window.isVisible || window.isMiniaturized) {
            window.close()
        }
        NSApp.setActivationPolicy(.accessory)
        isOn = true
        HostCard.shared.content = AnyView(BackgroundWorkCard(app: app))
        // The panel's own Quit stops the work too: Quit would only bring it here again.
        HostCard.shared.quitItem = HostQuitItem(title: "Stop Background Work…") { [weak app] in
            guard let app else { return }
            Task { await InBackground.shared.stop(app) }
        }
        let opensNote = !quietly && !noteSeen && !noteOpened
        let usage = UsageMenuBar.shared
        if (usage.isRunning || usageStarting), !usage.isWaitingForFirstLaunch {
            if opensNote, usage.isRunning {
                // Once the app has left the Dock (opened as it does, it would close at once), and
                // active, so its buttons take clicks.
                DispatchQueue.main.async { [weak self] in
                    guard let self, isOn else { return }
                    NSApp.activate()
                    usage.open(.dashboard)
                    noteOpened = true
                }
            }
        } else {
            // No usage panel to show it in (never turned on): an item of its own, while it's here.
            let item = item ?? BackgroundWorkItem(app: app)
            self.item = item
            item.show()
            if opensNote {
                DispatchQueue.main.async { [weak self] in
                    guard let self, isOn else { return }
                    if item.open() { noteOpened = true }
                }
            }
        }
        installWaitingUpdate()
    }

    /// Relaunched after an update installed from the background, or opened by the keeper for an
    /// agent's browser: there again at once, the window SwiftUI opens with the app closed as it
    /// shows.
    func enterAtLaunch(_ app: AppModel, usageStarting: Bool) {
        launching = true
        enter(app, usageStarting: usageStarting, quietly: openedQuietly)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.launching = false }
    }

    /// Back with its window and in the Dock.
    func leave() {
        guard isOn else { return }
        isOn = false
        launching = false
        HostCard.shared.content = nil
        HostCard.shared.quitItem = nil
        item?.hide()
        NSApp.setActivationPolicy(.regular)
        // Opened hidden by the keeper (`AppOpener`): shown again.
        if NSApp.isHidden { NSApp.unhide(nil) }
        app?.openMainWindow?()
        NSApp.activate()
    }

    /// Whether `window` is Kuvo Code's own main window (the `Window` scene with the ID "main"),
    /// rather than an update's, an alert's or a panel's.
    static func isMainWindow(_ window: NSWindow) -> Bool {
        guard let id = window.identifier?.rawValue else { return false }
        return id == "main" || id.hasPrefix("main-")
    }

    /// Opening Kuvo Code's window by any way (a notification, Help, Settings, the usage menu's Open)
    /// brings it back from the background. Other windows (an update's, an alert) leave it there.
    private func watchWindows() {
        guard windowWatch == nil else { return }
        windowWatch = NotificationCenter.default.addObserver(forName: NSWindow.didBecomeMainNotification, object: nil, queue: .main) { [weak self] note in
            let window = note.object as? NSWindow
            MainActor.assumeIsolated {
                guard let self, self.isOn, let window, Self.isMainWindow(window) else { return }
                if self.launching {
                    window.close()
                } else {
                    self.leave()
                }
            }
        }
    }

    /// An update waiting to install on Quit, installed now: Sparkle quits Kuvo Code, installs it,
    /// and opens it again, straight into the background.
    @discardableResult
    func installWaitingUpdate() -> Bool {
        guard let install = waitingUpdate else { return false }
        waitingUpdate = nil
        quitsForReal = true
        UserDefaults.standard.set(Date.now, forKey: Self.relaunchKey)
        install()
        return true
    }

    /// Stop Background Work: asked first only while something works, then stopped, and Kuvo Code
    /// quits for real.
    func stop(_ app: AppModel) async {
        let working = app.workspace.runningHere.count
        let busy = working > 0 ? true : await BackgroundWork.shared.isBusy()
        if busy {
            NSApp.activate()
            let alert = NSAlert()
            alert.messageText = "Stop the work in the background?"
            let what = switch working {
            case 0: "Something is working."
            case 1: "A session is working."
            default: "\(working) sessions are working."
            }
            alert.informativeText = "\(what) It stops now and picks up where it was when you open Kuvo Code again. Wake-ups due meanwhile come when you do."
            let stop = alert.addButton(withTitle: "Stop")
            stop.hasDestructiveAction = true
            alert.addButton(withTitle: "Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        quitsForReal = true
        do {
            try await app.stopBackgroundWork()
        } catch {
            quitsForReal = false
            NSApp.activate()
            let alert = NSAlert()
            alert.messageText = "The work in the background didn’t stop"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }

    /// Whether macOS is quitting it (logging out, restarting, shutting down): then it quits.
    static var systemIsQuitting: Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent, event.eventID == kAEQuitApplication else { return false }
        return event.attributeDescriptor(forKeyword: kAEQuitReason) != nil
    }
}

/// The menu bar item while Kuvo Code is in the background and the usage panel isn't on: its panel
/// is only the working card.
@MainActor
final class BackgroundWorkItem {
    private let app: AppModel
    private var statusItem: NSStatusItem?
    private let popover = NSPopover()

    init(app: AppModel) {
        self.app = app
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: BackgroundWorkCard(app: app).padding(12).frame(width: 300))
    }

    func show() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let image = NSImage(systemSymbolName: "chevron.left.forwardslash.chevron.right", accessibilityDescription: "Kuvo Code, in the background")
        image?.isTemplate = true
        item.button?.image = image
        item.button?.toolTip = "Kuvo Code is in the background"
        item.button?.target = self
        item.button?.action = #selector(toggle)
        statusItem = item
    }

    func hide() {
        popover.performClose(nil)
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
    }

    @objc private func toggle() {
        if popover.isShown {
            popover.performClose(nil)
        } else {
            open()
        }
    }

    /// Its panel, shown: active, so its buttons take clicks, and in the app's own appearance.
    /// Whether it shows.
    @discardableResult
    func open() -> Bool {
        guard let button = statusItem?.button else { return false }
        NSApp.activate()
        popover.appearance = NSApp.appearance
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
        return popover.isShown
    }
}
