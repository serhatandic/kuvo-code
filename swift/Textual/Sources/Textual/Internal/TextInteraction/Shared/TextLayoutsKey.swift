#if TEXTUAL_ENABLE_TEXT_SELECTION && canImport(AppKit) && !targetEnvironment(macCatalyst)
  import SwiftUI

  // MARK: - Overview
  //
  // On macOS, a fragment tells its `Text.Layout` to the selection only once the selection is
  // active (see `TextSelectionModel.isActive`): until then nothing reads `Text.LayoutKey`, which
  // has SwiftUI lay each text out once more to tell it, and that cost most of drawing the text.
  // Once active, each fragment passes its layout on through this key, which the selection reads.

  struct TextLayoutsKey: PreferenceKey {
    static var defaultValue: Text.LayoutKey.Value { [] }

    static func reduce(value: inout Text.LayoutKey.Value, nextValue: () -> Text.LayoutKey.Value) {
      value.append(contentsOf: nextValue())
    }
  }
#endif
