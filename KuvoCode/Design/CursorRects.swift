import AppKit
import ObjectiveC
import Textual

/// Every view's cursor rectangles, under the rule text's pointer goes by (`PointerClaim`): a
/// view's cursor shows only where that view is what's under the pointer, never under a button,
/// bar or card drawn over it. AppKit shows a cursor rectangle's cursor wherever the rectangle is
/// in view, whatever is on top of it, and that's how a text field shows its I-beam: SwiftUI's
/// TextField and SecureField, AppKit's fields, and the text a field is edited in. Their classes
/// aren't the app's to change (SwiftUI's are its own), so they all get the rule in the one place
/// AppKit takes their rectangles: `addCursorRect(_:cursor:)` keeps them with the view, which
/// claims the pointer by them in place of AppKit. A field you're typing in shows its I-beam from
/// AppKit's text view (its field editor), which sets it by its frame alone: AppKit's text views
/// that aren't the app's own (`PointerAwareTextView`) get the rule too.
enum CursorRects {
    /// Takes over AppKit's cursor rectangles and its text views' pointer, once, before any window
    /// is made.
    @MainActor static func install() {
        guard !isInstalled else { return }
        isInstalled = true
        takeOverCursorRects()
        takeOverTextViews()
    }

    @MainActor private static var isInstalled = false

    /// The cursor `view`'s rectangles show at `location` (in its window): nil where another view
    /// is on top of it, or it has none there.
    @MainActor static func cursor(of view: NSView, at location: NSPoint) -> NSCursor? {
        ClaimedRects.existing(view)?.cursor(at: location)
    }

    // The replacements are AppKit's to call, on any thread (a view can go away on another): off
    // the main thread they do what AppKit's own did.

    private typealias RectCall = @convention(c) (NSView, Selector, NSRect, NSCursor) -> Void
    private typealias PlainCall = @convention(c) (NSView, Selector) -> Void
    private typealias EventCall = @convention(c) (NSView, Selector, NSEvent) -> Void
    private typealias WindowCall = @convention(c) (NSView, Selector, NSWindow?) -> Void

    private nonisolated static func takeOverCursorRects() {
        let addSelector = #selector(NSView.addCursorRect(_:cursor:))
        let add = class_getInstanceMethod(NSView.self, addSelector)!
        let appKitsAdd = unsafeBitCast(method_getImplementation(add), to: RectCall.self)
        let adding: @convention(block) (NSView, NSRect, NSCursor) -> Void = { view, rect, cursor in
            guard Thread.isMainThread else { return appKitsAdd(view, addSelector, rect, cursor) }
            nonisolated(unsafe) let cursor = cursor
            MainActor.assumeIsolated { ClaimedRects.of(view).add(rect, cursor: cursor) }
        }
        method_setImplementation(add, imp_implementationWithBlock(adding))

        let removeSelector = #selector(NSView.removeCursorRect(_:cursor:))
        let remove = class_getInstanceMethod(NSView.self, removeSelector)!
        let appKitsRemove = unsafeBitCast(method_getImplementation(remove), to: RectCall.self)
        let removing: @convention(block) (NSView, NSRect, NSCursor) -> Void = { view, rect, cursor in
            guard Thread.isMainThread else { return appKitsRemove(view, removeSelector, rect, cursor) }
            nonisolated(unsafe) let cursor = cursor
            MainActor.assumeIsolated { ClaimedRects.existing(view)?.remove(rect, cursor: cursor) }
        }
        method_setImplementation(remove, imp_implementationWithBlock(removing))

        // AppKit's own still runs: it drops any it was given off the main thread.
        let discardSelector = #selector(NSView.discardCursorRects)
        let discard = class_getInstanceMethod(NSView.self, discardSelector)!
        let appKitsDiscard = unsafeBitCast(method_getImplementation(discard), to: PlainCall.self)
        let discarding: @convention(block) (NSView) -> Void = { view in
            appKitsDiscard(view, discardSelector)
            // Every view's, as each goes away: only those with rectangles go further.
            guard Thread.isMainThread, objc_getAssociatedObject(view, ClaimedRects.key) != nil else { return }
            MainActor.assumeIsolated { ClaimedRects.existing(view)?.discard() }
        }
        method_setImplementation(discard, imp_implementationWithBlock(discarding))
    }

    /// AppKit's text views: the pointer they set as it comes onto them (`cursorUpdate`) only where
    /// they're on top, let go of over what's on top as it moves on. The app's own text views
    /// claim theirs themselves.
    private nonisolated static func takeOverTextViews() {
        replace(#selector(NSResponder.cursorUpdate(with:))) { view, event, appKits in
            TextPointer.of(view).cameOn(event) { appKits(view, #selector(NSResponder.cursorUpdate(with:)), event) }
        }
        replace(#selector(NSResponder.mouseMoved(with:))) { view, event, appKits in
            // AppKit's sets the I-beam by the text's frame alone: it runs only where the text is on top.
            if PointerClaim.isTopmost(view, at: event.locationInWindow) { appKits(view, #selector(NSResponder.mouseMoved(with:)), event) }
            TextPointer.of(view).moved(event)
        }
        replace(#selector(NSResponder.mouseEntered(with:))) { view, event, appKits in
            // So does its coming on (a row in under a still pointer): only where it's on top.
            if PointerClaim.isTopmost(view, at: event.locationInWindow) { appKits(view, #selector(NSResponder.mouseEntered(with:)), event) }
        }
        replace(#selector(NSResponder.mouseExited(with:))) { view, event, appKits in
            appKits(view, #selector(NSResponder.mouseExited(with:)), event)
            TextPointer.existing(view)?.letGo()
        }
        // Removed under the pointer (a sheet closed): no `mouseExited` comes.
        let leaveSelector = #selector(NSView.viewWillMove(toWindow:))
        let leave = class_getInstanceMethod(NSTextView.self, leaveSelector)!
        let appKitsLeave = unsafeBitCast(method_getImplementation(leave), to: WindowCall.self)
        let leaving: @convention(block) (NSTextView, NSWindow?) -> Void = { view, window in
            appKitsLeave(view, leaveSelector, window)
            guard window == nil, Thread.isMainThread, objc_getAssociatedObject(view, TextPointer.key) != nil else { return }
            MainActor.assumeIsolated { TextPointer.existing(view)?.letGo() }
        }
        class_replaceMethod(NSTextView.self, leaveSelector, imp_implementationWithBlock(leaving), method_getTypeEncoding(leave))
    }

    /// NSTextView's `selector` (its own, or the one it inherits) as `handle`, given the one it had,
    /// for text views that aren't the app's own, on the main thread.
    private nonisolated static func replace(_ selector: Selector, with handle: @escaping @MainActor (NSTextView, NSEvent, EventCall) -> Void) {
        let method = class_getInstanceMethod(NSTextView.self, selector)!
        let appKits = unsafeBitCast(method_getImplementation(method), to: EventCall.self)
        let block: @convention(block) (NSTextView, NSEvent) -> Void = { view, event in
            guard Thread.isMainThread else { return appKits(view, selector, event) }
            // Only ever on the main thread, where AppKit gave them.
            nonisolated(unsafe) let event = event
            nonisolated(unsafe) let appKits = appKits
            MainActor.assumeIsolated {
                if view is PointerAwareTextView { return appKits(view, selector, event) }
                handle(view, event, appKits)
            }
        }
        class_replaceMethod(NSTextView.self, selector, imp_implementationWithBlock(block), method_getTypeEncoding(method))
    }
}

/// A view's cursor rectangles, kept with it, and the claim it makes by them.
private final class ClaimedRects: NSResponder {
    nonisolated(unsafe) static let key = UnsafeRawPointer(UnsafeMutableRawPointer.allocate(byteCount: 1, alignment: 1))

    private weak var view: NSView?
    private var rects: [(rect: NSRect, cursor: NSCursor)] = []
    private let claim = PointerClaim()
    private var tracking: NSTrackingArea?
    private var isChecking = false

    init(view: NSView) {
        self.view = view
        super.init()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    static func of(_ view: NSView) -> ClaimedRects {
        if let existing = existing(view) { return existing }
        let made = ClaimedRects(view: view)
        objc_setAssociatedObject(view, key, made, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return made
    }

    static func existing(_ view: NSView) -> ClaimedRects? {
        objc_getAssociatedObject(view, key) as? ClaimedRects
    }

    func add(_ rect: NSRect, cursor: NSCursor) {
        // Given again without a discard first, when the window asks for all of them again.
        rects.removeAll { $0.rect == rect && $0.cursor == cursor }
        rects.append((rect, cursor))
        // Its tracking area, again if the view took its areas away (some remake all of theirs).
        // In the key window only, as AppKit's rectangles.
        guard let view else { return }
        if tracking.map({ !view.trackingAreas.contains($0) }) ?? true {
            let area = NSTrackingArea(rect: view.bounds, options: [.mouseMoved, .mouseEnteredAndExited, .cursorUpdate, .inVisibleRect, .activeInKeyWindow], owner: self)
            view.addTrackingArea(area)
            tracking = area
        }
        checkWherePointerIs()
    }

    func remove(_ rect: NSRect, cursor: NSCursor) {
        rects.removeAll { $0.rect == rect && $0.cursor == cursor }
        checkWherePointerIs()
    }

    // Before AppKit asks for them again (the view resized, moved or left its window).
    func discard() {
        rects = []
        checkWherePointerIs()
    }

    /// Once AppKit's done giving them again (no move of the pointer comes): what shows where the
    /// pointer is now, as AppKit's rectangles would; and nothing once the view left its window,
    /// or went away (the claim outlives it to let go).
    private func checkWherePointerIs() {
        guard !isChecking else { return }
        isChecking = true
        DispatchQueue.main.async { [weak self, claim] in
            guard let self else { return claim.show(nil) }
            isChecking = false
            guard NSApp.isActive, let window = view?.window, window.isKeyWindow else { return claim.show(nil) }
            claim.show(cursor(at: window.mouseLocationOutsideOfEventStream))
        }
    }

    func cursor(at location: NSPoint) -> NSCursor? {
        guard let view, PointerClaim.isTopmost(view, at: location) else { return nil }
        let point = view.convert(location, from: nil)
        // The last given wins where they overlap (a link's hand over a text's I-beam).
        return rects.last { $0.rect.contains(point) }?.cursor
    }

    private func moved(_ event: NSEvent) {
        claim.show(cursor(at: event.locationInWindow))
    }

    override func cursorUpdate(with event: NSEvent) { moved(event) }
    override func mouseEntered(with event: NSEvent) { moved(event) }
    override func mouseMoved(with event: NSEvent) { moved(event) }
    override func mouseExited(with event: NSEvent) { claim.show(nil) }
}

/// The pointer one of AppKit's text views shows (a field's while you type in it), claimed: the one
/// its `cursorUpdate` sets where it's on top, kept while the pointer moves over it, let go of over
/// what's on top of it.
private final class TextPointer {
    nonisolated(unsafe) static let key = UnsafeRawPointer(UnsafeMutableRawPointer.allocate(byteCount: 1, alignment: 1))

    private weak var view: NSTextView?
    private let claim = PointerClaim()
    /// What AppKit's `cursorUpdate` showed last (a link's hand, or the I-beam).
    private var shown: NSCursor?

    init(view: NSTextView) {
        self.view = view
    }

    static func of(_ view: NSTextView) -> TextPointer {
        if let existing = existing(view) { return existing }
        let made = TextPointer(view: view)
        objc_setAssociatedObject(view, key, made, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return made
    }

    static func existing(_ view: NSView) -> TextPointer? {
        objc_getAssociatedObject(view, key) as? TextPointer
    }

    func cameOn(_ event: NSEvent, appKits: () -> Void) {
        guard let view, PointerClaim.isTopmost(view, at: event.locationInWindow) else { return claim.show(nil) }
        appKits()
        shown = NSCursor.current
        claim.show(NSCursor.current)
    }

    // Its `cursorUpdate` only comes as the pointer comes onto it, maybe where something's on top.
    func moved(_ event: NSEvent) {
        guard let view else { return }
        // Moves anywhere in the window come to the text you're typing in.
        guard view.visibleRect.contains(view.convert(event.locationInWindow, from: nil)),
              PointerClaim.isTopmost(view, at: event.locationInWindow), view.isSelectable || view.isEditable else { return claim.show(nil) }
        claim.show(shown ?? .iBeam)
    }

    func letGo() {
        claim.show(nil)
    }
}
