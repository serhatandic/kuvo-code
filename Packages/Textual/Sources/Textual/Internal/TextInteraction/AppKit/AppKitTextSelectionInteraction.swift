#if TEXTUAL_ENABLE_TEXT_SELECTION && canImport(AppKit) && !targetEnvironment(macCatalyst)
  import SwiftUI

  // MARK: - Overview
  //
  // `AppKitTextSelectionInteraction` presents the platform-specific text selection overlay for macOS.
  //
  // The modifier receives a `TextSelectionModel` and places it in the environment so selection highlights
  // and attachment dimming can access it. An overlay hosts `AppKitTextInteractionOverlay`, which wraps an
  // `NSView` that handles selection gestures and context menus, and shows the I-beam or a link's
  // pointing hand where it's what's under the pointer (`PointerClaim`).

  typealias PlatformTextSelectionInteraction = AppKitTextSelectionInteraction

  /// When something last scrolled, to tell the pointer resting on text from text moving under
  /// it: scroll wheel events, and scroll views' live scrolling (a trackpad's, and its momentum).
  @MainActor enum ScrollWatch {
    private static var last: TimeInterval = 0
    private static var watchers: [Any] = []

    static var isIdle: Bool {
      if watchers.isEmpty {
        watchers.append(
          NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            last = ProcessInfo.processInfo.systemUptime
            return event
          } as Any)
        for name in [NSScrollView.willStartLiveScrollNotification, NSScrollView.didLiveScrollNotification, NSScrollView.didEndLiveScrollNotification] {
          watchers.append(
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
              MainActor.assumeIsolated { last = ProcessInfo.processInfo.systemUptime }
            })
        }
      }
      return ProcessInfo.processInfo.systemUptime - last > 0.25
    }
  }

  struct AppKitTextSelectionInteraction: ViewModifier {
    private let model: TextSelectionModel

    init(model: TextSelectionModel) {
      self.model = model
    }

    func body(content: Content) -> some View {
      content
        // We need the selection model at text fragment level for the
        // text selection background and selected attachment dimming
        .environment(model)
        .overlayPreferenceValue(OverflowFrameKey.self) { frames in
          // It shows the pointer itself (I-beam, a link's hand), where it's on top.
          AppKitTextInteractionOverlay(model: model, overflowFrames: frames)
        }
    }
  }
#endif
