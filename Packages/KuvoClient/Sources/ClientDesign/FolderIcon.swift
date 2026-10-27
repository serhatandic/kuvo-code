import SwiftUI

/// A folder outline that opens when its project is open. SF Symbols has no open folder,
/// so both states are drawn here, with the same stroke over a faint fill of the same ink,
/// so the folder has a body instead of being only a wire outline.
public struct FolderIcon: View {
    let isOpen: Bool
    var size: CGFloat = 16

    public init(isOpen: Bool, size: CGFloat = 16) {
        self.isOpen = isOpen
        self.size = size
    }

    public var body: some View {
        let shape = FolderShape(open: isOpen)
        ZStack {
            shape.fill(.foreground.opacity(0.2))
            shape.stroke(style: StrokeStyle(lineWidth: size / 11.5, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size * 13 / 16)
    }
}

/// Drawn on a 16 × 13 grid, inset for the stroke.
nonisolated private struct FolderShape: Shape {
    let open: Bool

    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 16, sy = rect.height / 13
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy) }
        var path = Path()
        if open {
            // The back, with its tab, down to where the front flap starts.
            path.move(to: p(1.2, 11))
            path.addLine(to: p(1.2, 2.3))
            path.addQuadCurve(to: p(2.3, 1.2), control: p(1.2, 1.2))
            path.addLine(to: p(5.4, 1.2))
            path.addLine(to: p(6.9, 2.7))
            path.addLine(to: p(12.3, 2.7))
            path.addQuadCurve(to: p(13.4, 3.8), control: p(13.4, 2.7))
            path.addLine(to: p(13.4, 5.4))
            // The front flap, tipped forward.
            path.move(to: p(1.2, 11))
            path.addLine(to: p(3.2, 6.2))
            path.addQuadCurve(to: p(4.2, 5.4), control: p(3.5, 5.4))
            path.addLine(to: p(14.6, 5.4))
            path.addQuadCurve(to: p(15.2, 6.2), control: p(15.5, 5.4))
            path.addLine(to: p(13.2, 11.2))
            path.addQuadCurve(to: p(12.2, 11.8), control: p(12.9, 11.8))
            path.addLine(to: p(2.0, 11.8))
            path.addQuadCurve(to: p(1.2, 11), control: p(1.2, 11.8))
        } else {
            path.move(to: p(1.2, 10.7))
            path.addLine(to: p(1.2, 2.3))
            path.addQuadCurve(to: p(2.3, 1.2), control: p(1.2, 1.2))
            path.addLine(to: p(5.4, 1.2))
            path.addLine(to: p(6.9, 2.7))
            path.addLine(to: p(13.7, 2.7))
            path.addQuadCurve(to: p(14.8, 3.8), control: p(14.8, 2.7))
            path.addLine(to: p(14.8, 10.7))
            path.addQuadCurve(to: p(13.7, 11.8), control: p(14.8, 11.8))
            path.addLine(to: p(2.3, 11.8))
            path.addQuadCurve(to: p(1.2, 10.7), control: p(1.2, 11.8))
            path.closeSubpath()
            // The line under the tab, like the system folder.
            path.move(to: p(1.2, 4.6))
            path.addLine(to: p(14.8, 4.6))
        }
        return path
    }
}
