import AppKit
import SwiftUI
import WebKit

/// Escape stops the agent at work in the window's conversation, wherever the keyboard is, as the
/// composer's Escape does, once nothing on top takes it: a card's Cancel (its Escape shortcut),
/// then what's open over the content (a picture looked at closer, `OverContent`), then an open
/// Find bar. Not when what has the keyboard takes Escape itself (a text field, a page in the
/// panel, a terminal), nor with a sheet; popovers, menus and other windows have their own keys.
struct EscapeToStop: NSViewRepresentable {
    var canStop: Bool
    var stop: () -> Void

    func makeNSView(context: Context) -> Watcher { Watcher() }

    func updateNSView(_ view: Watcher, context: Context) {
        view.canStop = canStop
        view.stop = stop
    }

    final class Watcher: NSView {
        var canStop = false
        var stop: () -> Void = {}
        private var monitor: Any?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, let window = self.window, self.takes(event) else { return event }
                // On top first: a card's Cancel, then what's open over the content, then Find.
                if window.performKeyEquivalent(with: event) || OverContent.closeTop() || ConversationFind.closeOpen() { return nil }
                guard self.canStop else { return event }
                self.stop()
                return nil
            }
        }

        private func takes(_ event: NSEvent) -> Bool {
            guard event.keyCode == 53,
                  event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.capsLock).isEmpty,
                  let window, event.window === window, window.attachedSheet == nil else { return false }
            // Voice input listening: Escape cancels it, in the composer or the voice field.
            if AgentMail.shared.app?.dictation.voice != nil { return false }
            let responder = window.firstResponder
            // Escape is theirs: an input method composing, a field you type in (the composer
            // closes what's on top and stops on its own), a page, a terminal.
            if let text = responder as? NSTextView, text.isEditable || text.hasMarkedText() { return false }
            if responder is NSTextField || responder is WKWebView { return false }
            if let view = responder as? NSView, String(describing: type(of: view)).contains("Terminal") { return false }
            return canStop || OverContent.isOpen || ConversationFind.hasOpen
        }
    }
}

/// What's open over the window's content (a picture looked at closer), the latest on top: Escape
/// closes it before anything under it takes Escape, also when the keyboard didn't follow it in
/// (it stayed in the composer, which would stop the agent).
@MainActor enum OverContent {
    private static var open: [(id: UUID, close: () -> Void)] = []

    static var isOpen: Bool { !open.isEmpty }

    static func opened(_ id: UUID, close: @escaping () -> Void) {
        open.removeAll { $0.id == id }
        open.append((id, close))
    }

    static func closed(_ id: UUID) {
        open.removeAll { $0.id == id }
    }

    /// Closes the one on top; false when nothing is open.
    static func closeTop() -> Bool {
        guard let top = open.last else { return false }
        top.close()
        closed(top.id)
        return true
    }
}
