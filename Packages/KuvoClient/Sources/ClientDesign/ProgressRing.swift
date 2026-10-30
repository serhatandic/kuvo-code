import SwiftUI

/// How far a wait has come where there's room only for a mark: a thin ring over a faint track,
/// filling clockwise from the top in the accent and easing to each new value. The working ring's
/// size, so it takes that ring's place in a row once there's a share to tell (a machine's engine
/// being copied there). VoiceOver hears the percent.
public struct ProgressRing: View {
    let fraction: Double
    let size: CGFloat
    @Environment(\.accent) private var accent

    /// `fraction`, 0 to 1.
    public init(_ fraction: Double, size: CGFloat = 11) {
        self.fraction = min(1, max(0, fraction))
        self.size = size
    }

    public var body: some View {
        let line = max(1.2, size * 0.13)
        ZStack {
            Circle()
                .stroke(Color.primary.opacity(0.14), lineWidth: line)
            Circle()
                // A sliver from the start, so it never looks empty while it's under way.
                .trim(from: 0, to: max(0.03, fraction))
                .stroke(accent, style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeOut(duration: 0.3), value: fraction)
        }
        .padding(line / 2)
        .frame(width: size, height: size)
        .alignmentGuide(.firstTextBaseline) { $0.height * 0.85 }
        .alignmentGuide(.lastTextBaseline) { $0.height * 0.85 }
        .accessibilityElement()
        .accessibilityLabel("\(Int((fraction * 100).rounded())) percent")
    }
}
