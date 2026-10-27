import AppKit
import ApplicationServices
import CoreGraphics
import SwiftUI

/// Screen Recording and Accessibility for Kuvo Code. Agents run their commands as Kuvo Code, so when
/// one takes a screenshot or works another app, macOS asks about Kuvo Code; the first launch asks
/// for both once. Allow… opens System Settings on the right page, with Kuvo Code's icon in a small
/// window beside it, to drag into the list; once macOS says it's allowed, that window goes and Kuvo
/// Code comes back to the front.
@Observable
final class ScreenAccess {
    enum Permission: String, CaseIterable, Identifiable {
        case screenRecording, accessibility
        var id: String { rawValue }

        /// System Settings' page for it.
        var settingsURL: URL {
            switch self {
            case .screenRecording: URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
            case .accessibility: URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
            }
        }
    }

    /// What macOS says now, asked without a prompt.
    struct Source {
        var allowed: (Permission) -> Bool

        static let system = Source { permission in
            #if DEBUG
            // KUVO_DEMO_SCREEN_ACCESS=<allowed, comma-separated, or none>: what macOS says, for a
            // look at the screen that asks in a demo copy.
            if let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_SCREEN_ACCESS"] {
                return demo.split(separator: ",").contains { $0 == permission.rawValue }
            }
            #endif
            return switch permission {
            case .screenRecording: CGPreflightScreenCaptureAccess()
            case .accessibility: AXIsProcessTrusted()
            }
        }
    }

    private(set) var allowed: Set<Permission> = []
    /// Asked for in System Settings and come back without it: said once, quietly, under the list.
    private(set) var refused: Set<Permission> = []
    /// The one System Settings is open for, with the drag window beside it.
    private(set) var asking: Permission?

    private let source: Source
    @ObservationIgnored private var changed: (() -> Void)?
    @ObservationIgnored private var observers: [any NSObjectProtocol] = []
    @ObservationIgnored private var poll: Timer?
    @ObservationIgnored private lazy var tile = DragTile()

    init(source: Source = .system) {
        self.source = source
        refresh()
    }

    var allAllowed: Bool { Permission.allCases.allSatisfy(allowed.contains) }

    /// Reads what macOS says again; tells `watch`'s listener when something changed.
    func refresh() {
        let now = Set(Permission.allCases.filter(source.allowed))
        guard now != allowed else { return }
        allowed = now
        refused.subtract(now)
        if let asking, now.contains(asking) { granted(asking) }
        changed?()
    }

    /// Follows the permissions while the screen that asks for them shows: when Kuvo Code comes back
    /// to the front, as Accessibility's list changes, and every second while System Settings is open
    /// for one (Screen Recording says nothing when it changes).
    func watch(_ listener: @escaping () -> Void) {
        changed = listener
        guard observers.isEmpty else { return }
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.cameBack() }
        })
        // Posted whenever an app's Accessibility is switched on or off.
        observers.append(DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.accessibility.api"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        })
        refresh()
    }

    func stopWatching() {
        changed = nil
        observers.forEach { NotificationCenter.default.removeObserver($0); DistributedNotificationCenter.default().removeObserver($0) }
        observers = []
        stopAsking()
    }

    /// Opens System Settings for `permission`, with the drag window beside it.
    func ask(_ permission: Permission) {
        asking = permission
        refused.remove(permission)
        // No prompt of macOS's own (it would cover System Settings with one more dialog): you drag
        // Kuvo Code into the list.
        NSWorkspace.shared.open(permission.settingsURL)
        tile.show(for: permission) { [weak self] in self?.closedWithout(permission) }
        poll?.invalidate()
        poll = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    /// Kuvo Code in front again: what macOS says now; if it's still not allowed, that's said.
    private func cameBack() {
        refresh()
        guard let asking, !allowed.contains(asking) else { return }
        // Back from System Settings without it.
        if !SystemSettings.isRunning || NSWorkspace.shared.frontmostApplication?.bundleIdentifier == Bundle.main.bundleIdentifier {
            refused.insert(asking)
            stopAsking()
        }
    }

    /// The drag window closed (by you, or with System Settings) before macOS said it's allowed.
    private func closedWithout(_ permission: Permission) {
        refresh()
        if !allowed.contains(permission) { refused.insert(permission) }
        stopAsking()
    }

    private func granted(_ permission: Permission) {
        stopAsking()
        // Back to Kuvo Code, where the row is checked now.
        NSApp.activate()
    }

    private func stopAsking() {
        asking = nil
        poll?.invalidate()
        poll = nil
        tile.hide()
    }
}

/// System Settings, as another app on screen: whether it runs, and where its window is.
enum SystemSettings {
    static let bundleID = "com.apple.systempreferences"

    static var isRunning: Bool { !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty }

    /// Its frontmost window's frame, in AppKit's screen coordinates (from the bottom left), if one
    /// is on screen. Window frames are given without Screen Recording; their titles aren't needed.
    static var windowFrame: NSRect? {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for window in windows where (window[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier && (window[kCGWindowLayer as String] as? Int) == 0 {
            guard let bounds = window[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: bounds), rect.width > 200 else { continue }
            // Quartz counts from the top of the main screen; AppKit from its bottom.
            let height = NSScreen.screens.first?.frame.height ?? 0
            return NSRect(x: rect.minX, y: height - rect.maxY, width: rect.width, height: rect.height)
        }
        return nil
    }
}
