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
    /// Whether the note on the first Quit was seen ("Kuvo Code keeps working").
    var noteSeen: Bool {
        get { UserDefaults.standard.bool(forKey: Self.noteKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.noteKey); noteChanged.toggle() }
    }
    private var noteChanged = false
    static let noteKey = "backgroundWork.noteSeen"

    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var item: BackgroundWorkItem?
    @ObservationIgnored private var windowWatch: (any NSObjectProtocol)?

    /// Quit taken as going to the background: the windows close, the Dock icon goes, and the usage
    /// item shows the work (the first time, with a note that says so).
    func enter(_ app: AppModel) {
        self.app = app
        watchWindows()
        for window in NSApp.windows where window.isVisible && !(window is NSPanel) { window.close() }
        NSApp.setActivationPolicy(.accessory)
        isOn = true
        HostCard.shared.content = AnyView(BackgroundWorkCard(app: app))
        let showsNote = !noteSeen
        if UsageMenuBar.shared.isRunning, !UsageMenuBar.shared.isWaitingForFirstLaunch {
            if showsNote { UsageMenuBar.shared.open(.dashboard) }
        } else {
            // No usage panel to show it in (never turned on): an item of its own, while it's here.
            let item = item ?? BackgroundWorkItem(app: app)
            self.item = item
            item.show(opening: showsNote)
        }
    }

    /// Back with its window and in the Dock.
    func leave() {
        guard isOn else { return }
        isOn = false
        HostCard.shared.content = nil
        item?.hide()
        NSApp.setActivationPolicy(.regular)
        app?.openMainWindow?()
        NSApp.activate()
    }

    /// Opening Kuvo Code by any way (the Finder, a notification, a folder dropped on it) brings its
    /// window: back from the background as it does.
    private func watchWindows() {
        guard windowWatch == nil else { return }
        windowWatch = NotificationCenter.default.addObserver(forName: NSWindow.didBecomeMainNotification, object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                guard let self, self.isOn, let window = note.object as? NSWindow, !(window is NSPanel) else { return }
                self.leave()
            }
        }
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

/// The menu bar item while Kuvo Code is in the background and the usage panel isn't on: the usage
/// item's bars, whose panel is only the working card.
@MainActor
final class BackgroundWorkItem {
    private let app: AppModel
    private var statusItem: NSStatusItem?
    private let popover = NSPopover()

    init(app: AppModel) {
        self.app = app
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: BackgroundWorkCard(app: app).padding(12).frame(width: 280))
    }

    func show(opening: Bool) {
        if statusItem == nil {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            item.button?.image = NSImage(systemSymbolName: "chart.bar.fill", accessibilityDescription: "Kuvo Code, working in the background")
            item.button?.target = self
            item.button?.action = #selector(toggle)
            statusItem = item
        }
        if opening { open() }
    }

    func hide() {
        popover.performClose(nil)
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
    }

    @objc private func toggle() {
        popover.isShown ? popover.performClose(nil) : open()
    }

    private func open() {
        guard let button = statusItem?.button else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }
}
