import AppKit
import Textual

/// AppKit's text view, showing its pointer (the I-beam, a link's pointing hand) only where it's
/// what's under the pointer (`PointerClaim`), never under a button, bar or card drawn over it.
/// AppKit's own cursor rectangles cover the whole visible text, whatever is on top of it. Every
/// text view the app makes is one: replies, their code, the composer, files in the panel.
class PointerAwareTextView: NSTextView {
    private let claim = PointerClaim()
    private var tracking: NSTrackingArea?

    // As NSTextView's, so subclasses' own (ReplyTextView's) can be too.
    nonisolated deinit {}

    /// The pointer it shows at `location` (in the window), or nil where something else is on top
    /// or it has none (it can't be selected).
    func pointer(at location: NSPoint) -> NSCursor? {
        guard PointerClaim.isTopmost(self, at: location) else { return nil }
        return textCursor(at: convert(location, from: nil))
    }

    /// Its text's pointer at `point` (in its own coordinates), as AppKit's would be: a link's
    /// cursor over a link, else the I-beam, all over it, wherever it can be selected.
    private func textCursor(at point: NSPoint) -> NSCursor? {
        guard isSelectable || isEditable else { return nil }
        if let index = characterIndex(under: point), let storage = textStorage, index < storage.length {
            if let cursor = storage.attribute(.cursor, at: index, effectiveRange: nil) as? NSCursor { return cursor }
            if storage.attribute(.link, at: index, effectiveRange: nil) != nil {
                return linkTextAttributes?[.cursor] as? NSCursor ?? .pointingHand
            }
        }
        return .iBeam
    }

    /// The character drawn under `point`, if one is.
    private func characterIndex(under point: NSPoint) -> Int? {
        // TextKit 2's (asking for `layoutManager` would turn it to TextKit 1).
        guard textLayoutManager == nil, let layout = layoutManager, let container = textContainer else {
            guard let window else { return nil }
            let index = characterIndex(for: window.convertPoint(toScreen: convert(point, to: nil)))
            return index == NSNotFound ? nil : index
        }
        let origin = textContainerOrigin
        let inContainer = NSPoint(x: point.x - origin.x, y: point.y - origin.y)
        let glyph = layout.glyphIndex(for: inContainer, in: container, fractionOfDistanceThroughGlyph: nil)
        guard glyph < layout.numberOfGlyphs,
              layout.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container).contains(inContainer)
        else { return nil }
        return layout.characterIndexForGlyph(at: glyph)
    }

    fileprivate func claimPointer(for event: NSEvent) {
        claim.show(pointer(at: event.locationInWindow))
    }

    fileprivate func letGo() {
        claim.show(nil)
    }

    // No cursor rectangles: they'd show the I-beam under whatever is drawn over the text.
    override func resetCursorRects() {}

    // Nor its scroll view's (the composer's, a file's): AppKit gives it the I-beam over all it
    // shows whenever the text is made selectable or editable in a window.
    // (Nonisolated as NSText's; a view is set up on the main thread, where its scroll view is.)
    nonisolated override var isSelectable: Bool {
        get { super.isSelectable }
        set {
            super.isSelectable = newValue
            if Thread.isMainThread { MainActor.assumeIsolated { clearScrollViewsCursor() } }
        }
    }

    nonisolated override var isEditable: Bool {
        get { super.isEditable }
        set {
            super.isEditable = newValue
            if Thread.isMainThread { MainActor.assumeIsolated { clearScrollViewsCursor() } }
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        clearScrollViewsCursor()
    }

    private func clearScrollViewsCursor() {
        if let scroll = enclosingScrollView, scroll.documentView === self, scroll.documentCursor != nil {
            scroll.documentCursor = nil
        }
    }

    // The claim's moves go to a tracker of its own, so NSTextView's handlers stay as AppKit's
    // (they'd otherwise get each move twice, and a move's event has no tracking area to tell).
    private lazy var tracker = PointerTracker(text: self)

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = PointerClaim.trackingArea(owner: tracker, in: self)
        addTrackingArea(area)
        tracking = area
    }

    // Not AppKit's: it sets the I-beam by the text's frame alone.
    override func cursorUpdate(with event: NSEvent) {
        claimPointer(for: event)
    }

    // AppKit's, from its own tracking area, sets the I-beam by the text's frame alone too: it runs
    // only where the text is on top. Elsewhere what it does besides (a link's or a detected date's
    // hover) is for what's on top, and the claim lets go.
    override func mouseMoved(with event: NSEvent) {
        guard PointerClaim.isTopmost(self, at: event.locationInWindow) else { return }
        super.mouseMoved(with: event)
    }

    // So does its coming on, as a row comes in under a pointer resting on what's over it.
    override func mouseEntered(with event: NSEvent) {
        guard PointerClaim.isTopmost(self, at: event.locationInWindow) else { return }
        super.mouseEntered(with: event)
    }

    // Removed under the pointer (a reply rebuilt, a row let go): no `mouseExited` comes.
    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if newWindow == nil { letGo() }
    }
}

/// The owner of a text view's claim's tracking area.
private final class PointerTracker: NSResponder {
    private weak var text: PointerAwareTextView?

    init(text: PointerAwareTextView) {
        self.text = text
        super.init()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func cursorUpdate(with event: NSEvent) { text?.claimPointer(for: event) }
    override func mouseEntered(with event: NSEvent) { text?.claimPointer(for: event) }
    override func mouseMoved(with event: NSEvent) { text?.claimPointer(for: event) }
    override func mouseExited(with event: NSEvent) { text?.letGo() }
}
