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

    private func claimPointer(for event: NSEvent) {
        claim.show(pointer(at: event.locationInWindow))
    }

    // No cursor rectangles: they'd show the I-beam under whatever is drawn over the text.
    override func resetCursorRects() {}

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = PointerClaim.trackingArea(owner: self)
        addTrackingArea(area)
        tracking = area
    }

    // Not AppKit's: it sets the I-beam by the text's frame alone.
    override func cursorUpdate(with event: NSEvent) {
        claimPointer(for: event)
    }

    // The text view's own tracking areas' events still go to AppKit's handling; those of the
    // claim's area are the claim's alone (passed on, they'd reach the views around it twice).
    override func mouseEntered(with event: NSEvent) {
        if event.trackingArea !== tracking { super.mouseEntered(with: event) }
        claimPointer(for: event)
    }

    override func mouseMoved(with event: NSEvent) {
        if event.trackingArea !== tracking { super.mouseMoved(with: event) }
        claimPointer(for: event)
    }

    override func mouseExited(with event: NSEvent) {
        if event.trackingArea !== tracking { super.mouseExited(with: event) }
        claim.show(nil)
    }
}
