import AppKit

/// Scrolling in a long text field. SwiftUI's multi-line fields (the composer, a quote's answer)
/// stop growing at their line limit, and AppKit then moves what's past it only to follow the
/// caret: the trackpad and the scroll wheel do nothing. With the pointer over the field you're
/// typing in, they scroll it; at its top or bottom, the scroll goes on to what's behind it.
enum FieldScrolling {
    private static var monitor: Any?

    static func start() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            scroll(event) ? nil : event
        }
    }

    /// Whether `event` scrolled the field being typed in.
    private static func scroll(_ event: NSEvent) -> Bool {
        // A field's editor sits in a clip view of its own; a text view in a scroll view scrolls
        // already.
        guard let editor = event.window?.firstResponder as? NSTextView, editor.isFieldEditor,
              editor.enclosingScrollView == nil, let clip = editor.superview as? NSClipView,
              clip.bounds.contains(clip.convert(event.locationInWindow, from: nil)) else { return false }
        let overflow = editor.frame.height - clip.bounds.height
        guard overflow > 0, event.scrollingDeltaY != 0 else { return false }
        // A mouse's wheel goes by lines, a trackpad by points.
        let line = editor.font.map { ceil($0.ascender - $0.descender + $0.leading) } ?? 16
        let delta = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY : event.scrollingDeltaY * line
        let top = clip.bounds.origin.y
        let next = min(max(top - delta, 0), overflow)
        guard next != top else { return false }
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: next))
        return true
    }
}
