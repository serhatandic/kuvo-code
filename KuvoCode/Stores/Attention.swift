import AppKit
import CoreGraphics
import Observation

/// Whether you're using Kuvo Code on this Mac, told to each box it's connected to (KuvoLink's
/// PROTOCOL.md, "kuvo/attention"): this Mac's own, and your machines, so a notice for your phones
/// waits a little while you're here, and doesn't go if you answer it or look at its conversation
/// meanwhile (`NoticeHold`, and the same in each machine's bridge). The Mac's own notifications
/// are unchanged.
///
/// In use: the Mac awake, its screen awake and unlocked, your account in front, input in the last
/// two minutes, and Kuvo Code able to show you things here (its window in front, or its
/// notifications on). Told again every 15 seconds while it is, with the conversations on screen
/// while the window's in front and you've touched something since; told it isn't at once as the
/// Mac or its screen sleeps, the screen locks or another account comes in front, at the next word
/// once you've gone idle, and as the app quits. A lease that isn't renewed runs out by itself, so a
/// Mac that vanishes holds nothing.
final class Attention {
    /// How long each word lasts, and how often it's renewed: renewed well before it runs out, and
    /// before the shortest hold ends, so a conversation you're looking at counts as seen.
    static let lease: TimeInterval = 45
    static let renewEvery: TimeInterval = 15
    /// No input for this long: you're not here.
    static let idleAfter: TimeInterval = 120

    /// What this Mac tells it from: a test's own (its own notification centers, no timer).
    struct Mac {
        /// Seconds since your last input.
        var idle: () -> TimeInterval
        var isLocked: () -> Bool
        /// Kuvo Code's window is in front.
        var windowInFront: () -> Bool
        /// Its notifications are on (Settings › Notifications), so it shows you news while in back.
        var notificationsOn: () -> Bool
        /// Where the Mac and its screen sleeping and waking are posted.
        var workspace: NotificationCenter
        /// Where the screen locking is posted.
        var distributed: NotificationCenter
        /// Where the app coming in front and going behind is posted.
        var app: NotificationCenter
        /// Calls `fire` every so often; what it gives back stops that.
        var every: (_ seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void) -> () -> Void

        static let live = Mac(
            idle: { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!) },
            isLocked: { (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false },
            windowInFront: {
                NSApp.isActive && NSApp.windows.contains { $0.identifier?.rawValue == "main" && $0.isVisible && $0.occlusionState.contains(.visible) }
            },
            notificationsOn: { Notifier.isEnabled },
            workspace: NSWorkspace.shared.notificationCenter,
            distributed: DistributedNotificationCenter.default(),
            app: .default,
            every: { seconds, fire in
                let timer = Timer(timeInterval: seconds, repeats: true) { _ in MainActor.assumeIsolated { fire() } }
                RunLoop.main.add(timer, forMode: .common)
                return { timer.invalidate() }
            })
    }

    private let mac: Mac
    /// The conversations on screen (sessions, and group chats by their id), read while the
    /// window's in front.
    private let onScreen: () -> [String]
    /// Tells each box: in use with these on screen, or not any more (nil).
    private let tell: ([String]?) -> Void

    private var systemAsleep = false
    private var screenAsleep = false
    private var locked = false
    private var switchedAway = false
    /// What was told last: nothing yet, or what it said.
    private var told: [String]?? = .none
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var stopTimer: (() -> Void)?
    private var isRunning = false

    init(mac: Mac = .live, onScreen: @escaping () -> [String], tell: @escaping ([String]?) -> Void) {
        self.mac = mac
        self.onScreen = onScreen
        self.tell = tell
    }

    func start() {
        guard !isRunning else { return }
        isRunning = true
        locked = mac.isLocked()
        let watch: (NotificationCenter, Notification.Name, @escaping @MainActor () -> Void) -> Void = { [weak self] center, name, change in
            // Heard as it's posted (each of these is posted on the main thread), so "not in use" is
            // told before the Mac goes to sleep.
            let observer = center.addObserver(forName: name, object: nil, queue: nil) { _ in
                MainActor.assumeIsolated {
                    change()
                    self?.check()
                }
            }
            self?.observers.append((center, observer))
        }
        watch(mac.workspace, NSWorkspace.willSleepNotification) { [weak self] in self?.systemAsleep = true }
        watch(mac.workspace, NSWorkspace.didWakeNotification) { [weak self] in self?.systemAsleep = false }
        watch(mac.workspace, NSWorkspace.screensDidSleepNotification) { [weak self] in self?.screenAsleep = true }
        watch(mac.workspace, NSWorkspace.screensDidWakeNotification) { [weak self] in self?.screenAsleep = false }
        // Another account in front (fast user switching): you're not at this one.
        watch(mac.workspace, NSWorkspace.sessionDidResignActiveNotification) { [weak self] in self?.switchedAway = true }
        watch(mac.workspace, NSWorkspace.sessionDidBecomeActiveNotification) { [weak self] in self?.switchedAway = false }
        watch(mac.distributed, Self.screenLocked) { [weak self] in self?.locked = true }
        watch(mac.distributed, Self.screenUnlocked) { [weak self] in self?.locked = false }
        watch(mac.app, NSApplication.didBecomeActiveNotification) {}
        watch(mac.app, NSApplication.didResignActiveNotification) {}
        stopTimer = mac.every(Self.renewEvery) { [weak self] in self?.check(renewing: true) }
        followScreen()
        check()
    }

    /// Stops telling (the app quitting, which tells the boxes itself that you've gone).
    func stop() {
        isRunning = false
        for (center, observer) in observers { center.removeObserver(observer) }
        observers = []
        stopTimer?()
        stopTimer = nil
    }

    static let screenLocked = Notification.Name("com.apple.screenIsLocked")
    static let screenUnlocked = Notification.Name("com.apple.screenIsUnlocked")

    /// Whether you're using Kuvo Code here now.
    private var inUse: Bool {
        !systemAsleep && !screenAsleep && !locked && !switchedAway && mac.idle() < Self.idleAfter && (mac.windowInFront() || mac.notificationsOn())
    }

    /// Tells the boxes what's so now, when it changed, or again (`renewing`) while you're here.
    func check(renewing: Bool = false) {
        guard isRunning else { return }
        // On screen counts as seen only with input since the last word: you, not an empty chair
        // in the two minutes before you count as gone.
        let now: [String]? = inUse ? (mac.windowInFront() && mac.idle() < Self.renewEvery ? onScreen() : []) : nil
        let changed = told.map { $0 != now } ?? true
        guard changed || (renewing && now != nil) else { return }
        told = .some(now)
        tell(now)
    }

    /// Tells the boxes as soon as what's on screen changes.
    private func followScreen() {
        guard isRunning else { return }
        withObservationTracking { _ = onScreen() } onChange: { [weak self] in
            Task { @MainActor in
                self?.check()
                self?.followScreen()
            }
        }
    }
}

extension Utilities {
    /// The conversations on screen: the tab's session, the one beside it, and the group chat in
    /// view (by its id), as `Attention` tells the boxes.
    var conversationsOnScreen: [String] {
        [sessionInView, besideInView, groupInView.flatMap(BotGroups.groupID(fromTab:))].compactMap(\.self)
    }
}
