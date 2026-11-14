import AppKit

/// Trackpad haptics via the Force Touch Taptic Engine (`NSHapticFeedbackManager`). Silent no-op on
/// hardware without one (regular mice, older trackpads). Per the HIG these fire only in direct
/// response to a user-driven gesture — the system only delivers them while fingers are on the
/// trackpad anyway, so a drag is exactly the sanctioned moment.
///
/// Drags only — never fire a haptic from a mouse-click action. A Force Touch click is itself
/// simulated by the Taptic Engine (press pulse at mouse-down, release pulse at mouse-up), and a
/// button action runs at mouse-up, so an app pulse there lands milliseconds after the release
/// click. The two don't fuse (same hardware finding as the reverted 30ms double pulse below):
/// every pin click read as a double vibration (tried, reverted). The click is its own feedback.
@MainActor
enum Haptics {
    /// The "snapped into place" tap — fire when a drag actually commits a new order, never on
    /// plain drag movement.
    ///
    /// Exactly one `.levelChange` pulse per commit. A double pulse ~30ms apart was tried to
    /// render a firmer thunk, but on hardware the pulses don't fuse — every action read as two
    /// distinct vibrations (reverted). `.alignment` is imperceptible (also tried, reverted);
    /// stronger than a single `.levelChange` means private APIs, which we don't do.
    /// Minimum spacing between taps: rapid slot-crossings during a fast drag would otherwise
    /// run pulses together into a buzz. With the floor, every snap renders identically
    /// everywhere — reorder on the dashboard, reorder in Customize.
    private static let minimumSnapInterval: TimeInterval = 0.12
    private static var lastSnapAt: TimeInterval = 0

    static func snap() {
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastSnapAt >= minimumSnapInterval else { return }
        lastSnapAt = now

        NSHapticFeedbackManager.defaultPerformer.perform(.levelChange, performanceTime: .now)
    }
}
