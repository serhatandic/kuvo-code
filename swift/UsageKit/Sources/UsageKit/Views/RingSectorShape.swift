import SwiftUI

/// One donut sector, styled like Swift Charts' `SectorMark` (hairline angular gaps, rounded sector
/// corners) but with the start/end ring fractions as `animatableData` — the piece SectorMark is
/// missing. Because each sector is its own SwiftUI view with its own fill, a re-ranked period
/// switch morphs every provider's arc to its new position while its color stays put; SectorMark
/// instead matches sectors positionally and smears colors across providers mid-animation.
///
/// Fractions run clockwise from 12 o'clock, 0...1 around the ring.
struct RingSectorShape: Shape {
    var startFraction: Double
    var endFraction: Double
    /// The hole's share of the diameter — the golden-ratio donut from Apple's own charts.
    var innerRadiusRatio: CGFloat = 0.618
    /// Arc length (points, at the outer rim) of the gap between neighboring sectors.
    var gapWidth: CGFloat = 1.6
    var cornerRadius: CGFloat = 3

    var animatableData: AnimatablePair<Double, Double> {
        get { AnimatablePair(startFraction, endFraction) }
        set {
            startFraction = newValue.first
            endFraction = newValue.second
        }
    }

    func path(in rect: CGRect) -> Path {
        let outer = Double(min(rect.width, rect.height) / 2)
        let inner = outer * Double(innerRadiusRatio)
        let center = CGPoint(x: rect.midX, y: rect.midY)

        // Angles in radians; screen y grows downward, so increasing angles read clockwise —
        // exactly the ring's clockwise-from-noon direction.
        let top = -Double.pi / 2
        let halfGap = Double(gapWidth) / outer / 2
        let a0 = top + startFraction * 2 * .pi + halfGap
        let a1 = top + endFraction * 2 * .pi - halfGap
        let width = a1 - a0
        guard width > 0.001 else { return Path() }

        // Rounded corners can't be larger than the band is thick, and a narrow slice shrinks them
        // further so the two corner arcs of one edge never cross (s bounds the corner's angular
        // footprint to the slice's half-width).
        let s = sin(min(width / 2, .pi / 2))
        var corner = min(Double(cornerRadius), (outer - inner) / 2)
        corner = min(corner, outer * s / (1 + s))
        if s < 1 {
            corner = min(corner, inner * s / (1 - s))
        }

        if corner < 0.25 {
            return plainWedge(center: center, inner: inner, outer: outer, a0: a0, a1: a1)
        }
        return roundedWedge(center: center, inner: inner, outer: outer, a0: a0, a1: a1, corner: corner)
    }

    /// The degenerate slice (hairline or squeezed mid-animation): a plain annular wedge, no corners.
    private func plainWedge(center: CGPoint, inner: Double, outer: Double, a0: Double, a1: Double) -> Path {
        var path = Path()
        path.addArc(center: center, radius: outer, startAngle: .radians(a0), endAngle: .radians(a1), clockwise: false)
        path.addArc(center: center, radius: inner, startAngle: .radians(a1), endAngle: .radians(a0), clockwise: true)
        path.closeSubpath()
        return path
    }

    /// The full SectorMark-style wedge: outer arc, four tangent corner arcs, two radial edges, inner arc.
    private func roundedWedge(center: CGPoint, inner: Double, outer: Double, a0: Double, a1: Double, corner: Double) -> Path {
        // A corner circle sits `corner` inside the rim it rounds; `beta` is the angular offset from
        // the sector edge to that circle's center, placing it tangent to both the rim and the edge.
        let betaOuter = asin(min(1, corner / (outer - corner)))
        let betaInner = asin(min(1, corner / (inner + corner)))

        func polar(_ radius: Double, _ angle: Double) -> CGPoint {
            CGPoint(x: center.x + radius * cos(angle), y: center.y + radius * sin(angle))
        }
        func around(_ point: CGPoint, _ radius: Double, _ angle: Double) -> CGPoint {
            CGPoint(x: point.x + radius * cos(angle), y: point.y + radius * sin(angle))
        }

        var path = Path()
        // Outer rim, clockwise.
        path.addArc(
            center: center, radius: outer,
            startAngle: .radians(a0 + betaOuter), endAngle: .radians(a1 - betaOuter), clockwise: false
        )
        // Outer corner into the trailing edge.
        let trailingOuter = polar(outer - corner, a1 - betaOuter)
        path.addArc(
            center: trailingOuter, radius: corner,
            startAngle: .radians(a1 - betaOuter), endAngle: .radians(a1 + .pi / 2), clockwise: false
        )
        // Trailing radial edge, inward.
        let trailingInner = polar(inner + corner, a1 - betaInner)
        path.addLine(to: around(trailingInner, corner, a1 + .pi / 2))
        // Inner corner off the trailing edge.
        path.addArc(
            center: trailingInner, radius: corner,
            startAngle: .radians(a1 + .pi / 2), endAngle: .radians(a1 - betaInner + .pi), clockwise: false
        )
        // Inner rim, counterclockwise (back toward the leading edge).
        path.addArc(
            center: center, radius: inner,
            startAngle: .radians(a1 - betaInner), endAngle: .radians(a0 + betaInner), clockwise: true
        )
        // Inner corner into the leading edge.
        let leadingInner = polar(inner + corner, a0 + betaInner)
        path.addArc(
            center: leadingInner, radius: corner,
            startAngle: .radians(a0 + betaInner + .pi), endAngle: .radians(a0 + 3 * .pi / 2), clockwise: false
        )
        // Leading radial edge, outward.
        let leadingOuter = polar(outer - corner, a0 + betaOuter)
        path.addLine(to: around(leadingOuter, corner, a0 - .pi / 2))
        // Outer corner back onto the rim.
        path.addArc(
            center: leadingOuter, radius: corner,
            startAngle: .radians(a0 + 3 * .pi / 2), endAngle: .radians(a0 + betaOuter), clockwise: false
        )
        path.closeSubpath()
        return path
    }
}
