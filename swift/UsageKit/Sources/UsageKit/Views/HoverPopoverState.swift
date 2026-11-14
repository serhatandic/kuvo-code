import Foundation

/// Drives a hover-revealed popover (the usage-trend chart on sparkline rows, the model breakdown on
/// spend rows): opens after a short dwell while the inline row is hovered, and closes once the cursor
/// has left BOTH the row and the popover (a brief grace lets the cursor travel between them). An
/// `@Observable` reference type so a SwiftUI `View` can hold it in `@State` and bind `isPresented` to
/// the popover — value-type closure capture can't track this state reliably.
@MainActor
@Observable
final class HoverPopoverState {
    var isPresented = false

    /// Every live coordinator, so the menu-bar panel's close path can dismiss any open hover popover —
    /// the dashboard view tree (and this `@State`) survives the panel's `orderOut`, so `.onDisappear`
    /// alone wouldn't fire and the popover could orphan or re-show on the next open.
    @ObservationIgnored private static let live = NSHashTable<HoverPopoverState>.weakObjects()

    static func dismissAll() {
        for state in live.allObjects { state.dismiss() }
    }

    /// Whether the pointer is over the inline row/value. Unlike the rest of the hover bookkeeping this
    /// is observed and readable, so a view can drive a hover affordance (the value's highlight chip) off
    /// it. Crucially, `dismiss()` clears it, so `dismissAll()` on panel close clears the affordance too —
    /// the dashboard view tree (and a view's own `@State`) survives the panel's `orderOut`, so a plain
    /// `@State` flag would strand `true` and light the chip with no pointer over the value on reopen.
    private(set) var overInline = false
    @ObservationIgnored private var overDetail = false
    /// While pinned, the popover stays open regardless of cursor position — set during a multi-step
    /// interaction inside the popover (the resets claim confirm/in-flight flow) where a cursor slip
    /// outside must not tear the flow down. `dismiss()` still wins (panel close), and clearing it
    /// re-arms the normal hover-out hide. Readable (`isPinned`) so data-driven dismissals — the row's
    /// "credits changed under the popover" onChange — can stand down while the claim flow owns the
    /// popover: the claim itself changes the credits, and dismissing on that change would tear the
    /// popover down before its result ever renders.
    @ObservationIgnored private var pinned = false
    var isPinned: Bool { pinned }
    @ObservationIgnored private var showTask: Task<Void, Never>?
    @ObservationIgnored private var hideTask: Task<Void, Never>?

    /// 400ms reveal matches the app's hover-tooltip dwell (see `HoverTooltip`), so the popover opens on
    /// the same deliberate intent as every other hover affordance; 180ms grace lets the cursor cross
    /// from the row into the popover without it closing. Injectable so tests drive it without sleeps.
    private let revealDelay: Duration
    private let hideGrace: Duration

    init(revealDelay: Duration = .milliseconds(400), hideGrace: Duration = .milliseconds(180)) {
        self.revealDelay = revealDelay
        self.hideGrace = hideGrace
        Self.live.add(self)
    }

    func inlineHover(_ active: Bool) {
        // `onContinuousHover` fires every pointer-move frame; only mutate on a real transition so the
        // now-observed `overInline` doesn't post a change notification on every frame of a hover.
        if overInline != active { overInline = active }
        active ? scheduleShow() : scheduleHide()
    }

    func detailHover(_ inside: Bool) {
        overDetail = inside
        if inside { hideTask?.cancel(); hideTask = nil } else { scheduleHide() }
    }

    /// Pin (or unpin) the popover open across a deliberate in-popover interaction. Pinning cancels any
    /// pending hide; unpinning re-arms the normal hover-out grace so it closes once the cursor is away.
    func setPinned(_ active: Bool) {
        guard pinned != active else { return }
        pinned = active
        if active { hideTask?.cancel(); hideTask = nil } else { scheduleHide() }
    }

    /// Force the popover shut (popover/dashboard teardown), so it can't orphan on screen.
    func dismiss() {
        showTask?.cancel(); showTask = nil
        hideTask?.cancel(); hideTask = nil
        overInline = false
        overDetail = false
        pinned = false
        isPresented = false
    }

    private func scheduleShow() {
        hideTask?.cancel(); hideTask = nil
        guard !isPresented, showTask == nil else { return }
        let delay = revealDelay
        showTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled else { return }
            if overInline { isPresented = true }
            showTask = nil
        }
    }

    private func scheduleHide() {
        guard !pinned else { return }   // a pinned popover ignores hover-out until it's unpinned
        showTask?.cancel(); showTask = nil
        hideTask?.cancel()
        let delay = hideGrace
        hideTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled else { return }
            if !overInline, !overDetail, !pinned { isPresented = false }
            hideTask = nil
        }
    }
}
