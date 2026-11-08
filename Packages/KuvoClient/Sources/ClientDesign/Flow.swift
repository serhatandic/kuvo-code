import SwiftUI

/// Lays views out in rows that wrap when the room runs out, each row against the leading edge,
/// or the trailing one (like a sent message's pictures).
public struct Flow: Layout {
    public var alignment: HorizontalAlignment = .leading
    public var spacing: CGFloat

    public init(alignment: HorizontalAlignment = .leading, spacing: CGFloat) {
        self.alignment = alignment
        self.spacing = spacing
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(for: subviews, width: proposal.width ?? .infinity)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: width, height: height)
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(for: subviews, width: bounds.width) {
            var x = alignment == .trailing ? bounds.maxX - row.width : bounds.minX
            for index in row.indices {
                let size = size(of: subviews[index], width: bounds.width)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    /// `.firstRowCenter` is the middle of its first row, to line a label up with it.
    public func explicitAlignment(of guide: VerticalAlignment, in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGFloat? {
        guard guide == .firstRowCenter, let first = rows(for: subviews, width: bounds.width).first else { return nil }
        return bounds.minY + first.height / 2
    }

    private struct Row { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    /// A view's own size, or, wider than the room, the size it takes in that width (a picture
    /// that can shrink does, rather than run past the edge).
    private func size(of subview: LayoutSubview, width: CGFloat) -> CGSize {
        let size = subview.sizeThatFits(.unspecified)
        guard size.width > width, width.isFinite else { return size }
        return subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
    }

    private func rows(for subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = size(of: subviews[index], width: width)
            let next = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if !current.indices.isEmpty, next > width {
                rows.append(current)
                current = Row()
            }
            current.width = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}

extension VerticalAlignment {
    nonisolated private enum FirstRowCenter: AlignmentID {
        static func defaultValue(in context: ViewDimensions) -> CGFloat { context[VerticalAlignment.center] }
    }

    /// A `Flow`'s first row's middle; the middle of anything else.
    nonisolated public static let firstRowCenter = VerticalAlignment(FirstRowCenter.self)
}
