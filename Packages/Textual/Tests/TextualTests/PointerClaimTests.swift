#if canImport(AppKit) && !targetEnvironment(macCatalyst)
  import AppKit
  import SwiftUI
  import Testing

  @testable import Textual

  /// The pointer over text with a control drawn over part of it: the text claims it (its I-beam)
  /// only where it's what's under the pointer, and lets go under the control, which keeps its own.
  /// In a window of the test's own, never shown; nothing moves the real pointer.
  @MainActor
  @Suite(.serialized) struct PointerClaimTests {
    final class Text: NSView {
      override var isFlipped: Bool { true }
    }

    struct Hosted: NSViewRepresentable {
      let view: Text
      func makeNSView(context: Context) -> Text { view }
      func updateNSView(_ view: Text, context: Context) {}
    }

    let text = Text()
    let window = NSWindow(
      contentRect: NSRect(x: -20_000, y: -20_000, width: 400, height: 200), styleMask: [.titled],
      backing: .buffered, defer: false)

    init() {
      _ = NSApplication.shared
      // A text filling the window, and a button over its middle (as Scroll to the
      // End sits over a reply), centered at (200, 100) in the window.
      let root = ZStack {
        Hosted(view: text).frame(width: 400, height: 200)
        Button {
        } label: {
          Image(systemName: "arrow.down").frame(width: 30, height: 30)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
      }
      .frame(width: 400, height: 200)
      window.isReleasedWhenClosed = false
      window.contentView = NSHostingView(rootView: root)
      window.contentView?.layoutSubtreeIfNeeded()
      WindowServer.over = window.windowNumber
    }

    private let underButton = NSPoint(x: 200, y: 100)
    private let bareText = NSPoint(x: 40, y: 160)

    @Test func textIsTopmostOnlyAwayFromTheControl() {
      #expect(text.convert(text.bounds, to: nil).contains(underButton))
      #expect(PointerClaim.isTopmost(text, at: bareText))
      #expect(!PointerClaim.isTopmost(text, at: underButton))
      window.close()
    }

    /// A menu or a popover open over the text is a window of its own on top: under it the text
    /// is nothing a click reaches, so it claims no pointer there.
    @Test func textUnderAnotherWindowIsNotTopmost() {
      let menu = NSPanel(
        contentRect: window.convertToScreen(NSRect(x: 0, y: 0, width: 200, height: 200)),
        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      menu.level = .popUpMenu
      menu.isReleasedWhenClosed = false
      WindowServer.over = menu.windowNumber
      #expect(!PointerClaim.isTopmost(text, at: bareText))
      WindowServer.over = window.windowNumber
      #expect(PointerClaim.isTopmost(text, at: bareText))
      menu.close()
      window.close()
    }

    @Test func movingOntoTheControlLetsTheIBeamGo() {
      let claim = PointerClaim()
      claim.show(PointerClaim.isTopmost(text, at: bareText) ? .iBeam : nil)
      #expect(NSCursor.current == .iBeam)
      claim.show(PointerClaim.isTopmost(text, at: underButton) ? .iBeam : nil)
      #expect(NSCursor.current == .arrow)
      // And back onto the words, the I-beam again.
      claim.show(PointerClaim.isTopmost(text, at: bareText) ? .iBeam : nil)
      #expect(NSCursor.current == .iBeam)
      claim.show(nil)
      window.close()
    }

    @Test func aControlsOwnPointerStays() {
      let claim = PointerClaim()
      claim.show(.iBeam)
      // The control under the pointer showed its pointing hand before the text heard of the move.
      NSCursor.pointingHand.set()
      claim.show(nil)
      #expect(NSCursor.current == .pointingHand)
      NSCursor.arrow.set()
      window.close()
    }

    @Test func oneTextLettingGoLeavesTheNextOnesPointer() {
      let first = PointerClaim()
      let next = PointerClaim()
      first.show(.iBeam)
      // From one text onto the one under it: the second claims before the first hears it's left.
      next.show(.iBeam)
      first.show(nil)
      #expect(NSCursor.current == .iBeam)
      next.show(nil)
      #expect(NSCursor.current == .arrow)
      window.close()
    }
  }

  /// The window server's answer to which window is under a point on the screen: the test's
  /// window, as the user's is under their pointer (the test's is off the screen, under nothing),
  /// or a menu over it.
  @MainActor enum WindowServer {
    static var over: Int? {
      didSet {
        guard !isStubbed else { return }
        isStubbed = true
        let selector = #selector(NSWindow.windowNumber(at:belowWindowWithWindowNumber:))
        let method = class_getClassMethod(NSWindow.self, selector)!
        typealias Call = @convention(c) (AnyClass, Selector, NSPoint, Int) -> Int
        let real = unsafeBitCast(method_getImplementation(method), to: Call.self)
        // Only within the window: a point anywhere else gets the real answer, as one given in
        // the wrong coordinates would.
        let answer: @convention(block) (AnyClass, NSPoint, Int) -> Int = { type, point, below in
          let window =
            Thread.isMainThread
            ? MainActor.assumeIsolated {
              over.flatMap { NSApp.window(withWindowNumber: $0)?.frame.contains(point) == true ? $0 : nil }
            } : nil
          return window ?? real(type, selector, point, below)
        }
        method_setImplementation(method, imp_implementationWithBlock(answer))
      }
    }
    private static var isStubbed = false
  }
#endif
