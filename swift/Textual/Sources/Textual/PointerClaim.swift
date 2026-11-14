#if canImport(AppKit) && !targetEnvironment(macCatalyst)
  import AppKit

  /// The pointer a view shows over itself, like text's I-beam or a link's pointing hand, shown
  /// only where that view is what's under the pointer: never under a button, a bar or a card drawn
  /// over it. Cursor rectangles (and `onContinuousHover`) go by a view's frame alone, so text kept
  /// its I-beam under any control on top of it; a view claims the pointer through this instead.
  ///
  /// A view keeps one, and on each move of the pointer over it (`mouseMoved`, `mouseEntered`,
  /// `cursorUpdate`) shows what `isTopmost(_:at:)` allows, or nil, which lets go: the arrow comes
  /// back, unless what's on top set a pointer of its own meanwhile. `mouseExited` lets go too, and
  /// so does the view leaving its window (no `mouseExited` comes then).
  @MainActor public final class PointerClaim {
    /// The claim whose pointer shows now, if any: one that lets go after another took over (from
    /// one text to the next) leaves the other's alone.
    private static weak var holder: PointerClaim?
    private var shown: NSCursor?

    public init() {}

    /// Whether `view`, or a view inside it, is what its window has under `location` (in the
    /// window's coordinates), with that window the one on top there: what a click there would
    /// reach.
    public static func isTopmost(_ view: NSView, at location: NSPoint) -> Bool {
      guard let window = view.window, var root = window.contentView else { return false }
      // From the window's frame view, so a title bar over the content counts too. It has no
      // superview, so it takes points in the window's coordinates.
      while let parent = root.superview { root = parent }
      guard let hit = root.hitTest(location), hit === view || hit.isDescendant(of: view) else { return false }
      return isOnTop(window, at: location)
    }

    /// Whether `window` is the one on top at `location` (in its coordinates): under another
    /// window, nothing in this one is. A menu, a popover or a sheet open over it is a window of its
    /// own, and so is another app's. The window server's answer, which AppKit's own text views ask
    /// too.
    public static func isOnTop(_ window: NSWindow, at location: NSPoint) -> Bool {
      let onScreen = window.convertPoint(toScreen: location)
      return NSWindow.windowNumber(at: onScreen, belowWindowWithWindowNumber: 0) == window.windowNumber
    }

    /// Shows `cursor`; nil lets go of the one this showed, for `otherwise` (the arrow, or the
    /// I-beam of a selectable text it lies on), unless what's on top showed its own already (a
    /// button's pointing hand) or another claim took over.
    public func show(_ cursor: NSCursor?, otherwise: NSCursor = .arrow) {
      if let cursor {
        if NSCursor.current != cursor { cursor.set() }
        shown = cursor
        Self.holder = self
      } else {
        guard let shown else { return }
        self.shown = nil
        guard Self.holder === self else { return }
        Self.holder = nil
        if NSCursor.current == shown { otherwise.set() }
      }
    }

    /// The tracking area a view claims through: moves, entering and leaving, wherever it's in view,
    /// in any window of the app you're using (as SwiftUI's hover). Its `owner` gets the events: the
    /// view, or an object of its own when the view's handlers are AppKit's to keep (a text view's).
    public static func trackingArea(owner: AnyObject, in view: NSView) -> NSTrackingArea {
      NSTrackingArea(
        rect: view.bounds,
        options: [.mouseMoved, .mouseEnteredAndExited, .cursorUpdate, .inVisibleRect, .activeInActiveApp],
        owner: owner
      )
    }
  }
#endif
