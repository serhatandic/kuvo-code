import SwiftUI

/// A message queued for after the current run, at the start of its row: an arrow turning in under
/// two lines of text, as Codex marks its queue. Drawn at a symbol's size and weight for `size` (the
/// row's font size), in the ink it's given, so it sits where an SF Symbol would.
public struct QueuedMark: View {
    let size: CGFloat

    public init(size: CGFloat) { self.size = size }

    public var body: some View {
        Glyph()
            .stroke(style: StrokeStyle(lineWidth: size * 0.085, lineCap: .round, lineJoin: .round))
            .frame(width: size * 0.85, height: size * 0.8)
            .accessibilityElement()
            .accessibilityLabel("Queued")
    }

    /// The arrow down the left side, turning right along the foot, and the two lines in its bend,
    /// the lower one shorter.
    struct Glyph: Shape {
        func path(in rect: CGRect) -> Path {
            let (w, h) = (rect.width, rect.height)
            let inset = w * 0.05
            let (left, top, foot, tip) = (rect.minX + inset, rect.minY + inset, rect.minY + h * 0.82, rect.maxX - inset)
            let corner = h * 0.2, arm = w * 0.14
            var path = Path()
            path.move(to: CGPoint(x: left, y: top))
            path.addLine(to: CGPoint(x: left, y: foot - corner))
            path.addQuadCurve(to: CGPoint(x: left + corner, y: foot), control: CGPoint(x: left, y: foot))
            path.addLine(to: CGPoint(x: tip, y: foot))
            path.move(to: CGPoint(x: tip - arm, y: foot - arm))
            path.addLine(to: CGPoint(x: tip, y: foot))
            path.addLine(to: CGPoint(x: tip - arm, y: foot + arm))
            let text = rect.minX + w * 0.33
            path.move(to: CGPoint(x: text, y: rect.minY + h * 0.13))
            path.addLine(to: CGPoint(x: rect.minX + w * 0.8, y: rect.minY + h * 0.13))
            path.move(to: CGPoint(x: text, y: rect.minY + h * 0.47))
            path.addLine(to: CGPoint(x: rect.minX + w * 0.62, y: rect.minY + h * 0.47))
            return path
        }
    }
}
