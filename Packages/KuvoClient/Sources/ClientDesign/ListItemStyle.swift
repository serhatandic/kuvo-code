import SwiftUI
import Textual

/// A list item with its number or bullet on the middle of the item's first line. Textual's own
/// works that line out from the item's last baseline, so an item ending in a code block, a quote
/// or a table (padded below their last line) had its marker pushed down beside that, and the
/// item's first words looked like the end of the item before.
public struct FirstLineListItemStyle: StructuredText.ListItemStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstLineCenter, spacing: 0) {
            configuration.marker
                .textual.padding(.trailing, .fontScaled(0.5))
            configuration.block
        }
    }
}

extension StructuredText.ListItemStyle where Self == FirstLineListItemStyle {
    /// Its marker on the middle of the item's first line, whatever comes after it.
    public static var firstLine: Self { .init() }
}

extension VerticalAlignment {
    /// The middle of a view's first line, from its first baseline alone: a line's middle is about
    /// 0.62 of the way down to its baseline (what's below the baseline is about a quarter of
    /// what's above it), so what comes after the first line doesn't move it. For a picture (a
    /// bullet), whose baseline is its bottom, it's a little below its middle.
    private enum FirstLineCenter: AlignmentID {
        static func defaultValue(in context: ViewDimensions) -> CGFloat {
            context[.firstTextBaseline] * 0.62
        }
    }

    public static let firstLineCenter = Self(FirstLineCenter.self)
}
