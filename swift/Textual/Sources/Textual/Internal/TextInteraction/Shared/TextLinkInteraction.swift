import SwiftUI

// MARK: - Overview
//
// `TextLinkInteraction` adds lightweight link tapping to a `Text` fragment.
//
// SwiftUI resolves a `Text.Layout` for each fragment and publishes it through the `Text.LayoutKey`
// preference. This modifier reads the anchored layout, converts tap locations to layout-local
// coordinates, and looks for the first run whose typographic bounds contains the tap. When a run
// has a `url`, the modifier invokes the environment’s `openURL` action.

struct TextLinkInteraction: ViewModifier {
  @Environment(\.openURL) private var openURL
  #if TEXTUAL_ENABLE_TEXT_SELECTION && canImport(AppKit) && !targetEnvironment(macCatalyst)
    @Environment(\.textSelection) private var textSelection
  #endif
  /// Whether the text has links: without any, nothing to tap, and no overlay to lay out.
  var isOn = true

  func body(content: Content) -> some View {
    #if TEXTUAL_ENABLE_LINKS
      if isOn, !selectionTakesClicks {
        linked(content)
      } else {
        content
      }
    #else
      content
    #endif
  }

  /// On macOS, selectable text's clicks go to the selection's view over it, which opens links.
  private var selectionTakesClicks: Bool {
    #if TEXTUAL_ENABLE_TEXT_SELECTION && canImport(AppKit) && !targetEnvironment(macCatalyst)
      textSelection.allowsSelection
    #else
      false
    #endif
  }

  #if TEXTUAL_ENABLE_LINKS
  private func linked(_ content: Content) -> some View {
      content
        .overlayPreferenceValue(Text.LayoutKey.self) { value in
          if let anchoredLayout = value.first {
            GeometryReader { geometry in
              Color.clear
                .contentShape(.rect)
                .gesture(
                  tap(
                    origin: geometry[anchoredLayout.origin],
                    layout: anchoredLayout.layout
                  )
                )
            }
          }
        }
  }
  #endif

  #if TEXTUAL_ENABLE_LINKS
    private func tap(origin: CGPoint, layout: Text.Layout) -> some Gesture {
      SpatialTapGesture()
        .onEnded { value in
          let localPoint = CGPoint(
            x: value.location.x - origin.x,
            y: value.location.y - origin.y
          )
          let runs = layout.flatMap(\.self)
          let run = runs.first { run in
            run.typographicBounds.rect.contains(localPoint)
          }
          guard let url = run?.url else {
            return
          }
          openURL(url)
        }
    }
  #endif
}
