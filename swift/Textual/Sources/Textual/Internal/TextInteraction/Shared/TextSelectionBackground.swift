import SwiftUI

// MARK: - Overview
//
// `TextSelectionBackground` draws selection highlights behind a `Text` fragment.
//
// The platform selection interaction stores a `TextSelectionModel` in the environment at fragment
// scope. This modifier reads the fragment’s anchored `Text.Layout` and forwards it to the AppKit
// selection view so it can convert the current selected range into highlight rectangles.

struct TextSelectionBackground: ViewModifier {
  #if TEXTUAL_ENABLE_TEXT_SELECTION && canImport(AppKit) && !targetEnvironment(macCatalyst)
    @Environment(TextSelectionModel.self) private var model: TextSelectionModel?
  #endif

  func body(content: Content) -> some View {
    #if TEXTUAL_ENABLE_TEXT_SELECTION && canImport(AppKit) && !targetEnvironment(macCatalyst)
      // Read, which has SwiftUI lay the text out once more to tell it, only once selecting is
      // on: until then the text is drawn as it is.
      if let model, model.isActive {
        let isSelecting = model.selectedRange != nil
        content
          .backgroundPreferenceValue(Text.LayoutKey.self) { value in
            ZStack {
              // Only while something is selected: a view to draw the selection in, for each
              // fragment of text, cost a lot to lay out for nothing the rest of the time.
              if isSelecting, let anchoredLayout = value.first {
                GeometryReader { geometry in
                  AppKitTextSelectionView(
                    layout: anchoredLayout.layout,
                    origin: geometry[anchoredLayout.origin]
                  )
                }
              }
              Color.clear
                .preference(key: TextLayoutsKey.self, value: value)
            }
          }
      } else {
        content
      }
    #else
      content
    #endif
  }
}
