import SwiftUI

extension StructuredText {
  /// The spacing a block's style sets, as a preference (upstream's way, which nothing here reads
  /// any more: see `DeclaredBlockSpacingKey`).
  struct BlockSpacingKey: PreferenceKey, LayoutValueKey {
    static let defaultValue = BlockSpacing()

    static func reduce(value: inout BlockSpacing, nextValue: () -> BlockSpacing) {
      value = value.union(nextValue())
    }
  }

  /// The spacing a block's style sets, read by the block stack from the block itself as it lays
  /// it out.
  struct DeclaredBlockSpacingKey: LayoutValueKey {
    static let defaultValue: BlockSpacing? = nil
  }

  /// A list item's spacing, the list's, which takes the place of what its blocks set.
  struct ResolvedBlockSpacingKey: LayoutValueKey {
    static let defaultValue: BlockSpacing? = nil
  }
}
