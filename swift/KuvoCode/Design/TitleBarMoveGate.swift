import AppKit
import SwiftUI

/// Lets macOS move the window by its title bar only while the pointer is over the title bar.
///
/// A window whose content reaches up under its title bar has macOS work out, each time anything
/// moves, which parts of the title bar strip are content and which drag the window; SwiftUI then
/// walks every view that takes clicks or the keyboard to answer. Scrolling the sidebar spent a
/// third of its time there, and every scroll, reply and animation paid some. Not movable, the
/// window has none of that; it's made movable again as the pointer comes to the title bar, so
/// dragging it (and snapping it to the screen's edges) is as it always was. Movable too while a
/// menu is open and as the tiling keys are pressed: macOS offers Window › Fill, Center and Move &
/// Resize only for a window that can move, and greyed them out.
@MainActor final class TitleBarMoveGate: NSObject {
    private weak var window: NSWindow?
    private var tracking: NSTrackingArea?
    private var observers: [NSObjectProtocol] = []
    private static var gates: [ObjectIdentifier: TitleBarMoveGate] = [:]
    /// Menus open now: the window stays movable meanwhile.
    private static var menusOpen = 0
    /// Until when it's kept movable after a menu or a tiling key, for what they do to finish.
    private var heldUntil: ContinuousClock.Instant?
    private static var keys: Any?

    /// Moves the window with a drag that starts outside the title bar (the gaps around the cards):
    /// movable while the button's down, then as the pointer has it.
    static func drag(_ window: NSWindow, with event: NSEvent) {
        let gate = gates[ObjectIdentifier(window)]
        window.isMovable = true
        window.performDrag(with: event)
        Task { @MainActor in
            while NSEvent.pressedMouseButtons != 0 { try? await Task.sleep(for: .milliseconds(100)) }
            gate?.update()
        }
    }

    static func install(on window: NSWindow) {
        guard gates[ObjectIdentifier(window)] == nil else { return }
        let gate = TitleBarMoveGate(window: window)
        gates[ObjectIdentifier(window)] = gate
        watchMenusAndKeys()
    }

    /// The Window menu's Fill, Center and Move & Resize, and their keys (fn ⌃ and an arrow, F or
    /// C), are only for a window that can move: each window is made movable as any menu opens,
    /// and as those keys go down, then as it was a moment after.
    private static func watchMenusAndKeys() {
        guard keys == nil else { return }
        let center = NotificationCenter.default
        _ = center.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                menusOpen += 1
                for gate in gates.values { gate.hold() }
            }
        }
        _ = center.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                menusOpen = max(0, menusOpen - 1)
                for gate in gates.values { gate.hold() }
            }
        }
        keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags.contains(.function) && flags.contains(.control) {
                event.window.flatMap { gates[ObjectIdentifier($0)] }?.hold()
            }
            return event
        }
    }

    /// Movable now, and for a moment more (the tiling it was for moves the window after the menu
    /// closes or the key goes down).
    private func hold() {
        heldUntil = .now + .seconds(1)
        setMovable(true)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.1))
            self?.update()
        }
    }

    private init(window: NSWindow) {
        self.window = window
        super.init()
        let center = NotificationCenter.default
        for name in [NSWindow.didResizeNotification, NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification] {
            observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.update() }
            })
        }
        observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.remove() }
        })
        update()
    }

    /// The title bar strip, in the content view's coordinates: what the content reaches up under.
    private func strip(in content: NSView, of window: NSWindow) -> NSRect {
        let height = max(0, content.bounds.height - window.contentLayoutRect.height) + 4
        let y = content.isFlipped ? 0 : content.bounds.height - height
        return NSRect(x: 0, y: y, width: content.bounds.width, height: height)
    }

    private func update() {
        guard let window, let content = window.contentView else { return }
        if let tracking { content.removeTrackingArea(tracking) }
        let rect = strip(in: content, of: window)
        let area = NSTrackingArea(rect: rect, options: [.mouseEnteredAndExited, .activeAlways], owner: self)
        content.addTrackingArea(area)
        tracking = area
        // Where the pointer is now decides, as it would have entering or leaving.
        let pointer = content.convert(window.mouseLocationOutsideOfEventStream, from: nil)
        setMovable(rect.contains(pointer) || window.styleMask.contains(.fullScreen) || isHeld)
    }

    private var isHeld: Bool {
        Self.menusOpen > 0 || heldUntil.map { $0 > .now } == true
    }

    private func setMovable(_ movable: Bool) {
        guard let window, window.isMovable != movable else { return }
        window.isMovable = movable
    }

    @objc func mouseEntered(with event: NSEvent) { setMovable(true) }

    @objc func mouseExited(with event: NSEvent) {
        // Not mid-drag (the window moves with the pointer, which can slip out of the strip): once
        // the button's up, if the pointer is still out.
        guard NSEvent.pressedMouseButtons == 0 else {
            Task { [weak self] in
                while NSEvent.pressedMouseButtons != 0 { try? await Task.sleep(for: .milliseconds(100)) }
                self?.update()
            }
            return
        }
        setMovable((window?.styleMask.contains(.fullScreen) ?? false) || isHeld)
    }

    private func remove() {
        if let tracking, let content = window?.contentView { content.removeTrackingArea(tracking) }
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        if let window { Self.gates[ObjectIdentifier(window)] = nil }
    }
}

/// Installs the gate on the window it's in.
struct TitleBarMoveGateInstaller: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { InstallerView() }
    func updateNSView(_ view: NSView, context: Context) {}

    private final class InstallerView: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { TitleBarMoveGate.install(on: window) }
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}
