import SwiftUI

/// One step of a bot's goal, as a thin track of its own that fills on its own (PROTOCOL.md, "Work ›
/// Goals"): bright while it runs, filled only as far as the bot measured it, and striped where it
/// can't say how far (never a made-up share); a quiet green once done; faint before it starts; grey
/// and held at its fill while it's paused at a limit; hollow and orange while it waits for you, so
/// it reads apart from a done one without its colour. The stripes stand still:
/// no motion to play or turn off. Tracks side by side show work going on in parallel; a row of short
/// ones (`GoalTrackStrip`) says the same on a folded line.
public struct GoalTrack: View {
    public enum State: Sendable, Hashable {
        case todo, running, done, paused, waiting, skipped
    }

    let state: State
    /// How far along, 0 to 1, only where it was measured.
    let progress: Double?
    let height: CGFloat
    @Environment(\.accent) private var accent
    @Environment(\.colorScheme) private var scheme

    public init(_ state: State, progress: Double? = nil, height: CGFloat = 4) {
        self.state = state
        self.progress = progress.map { min(1, max(0, $0)) }
        self.height = height
    }

    public var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(state == .todo || state == .waiting ? 0.06 : 0.09))
                switch state {
                case .todo:
                    EmptyView()
                case .done:
                    // Quieter than a running track's accent, lighter in light mode and darker in dark.
                    Capsule().fill(Color.green.opacity(scheme == .dark ? 0.5 : 0.7))
                case .skipped:
                    Capsule().fill(Color.primary.opacity(0.14))
                case .waiting:
                    // Hollow: nothing moves until you've answered.
                    Capsule().strokeBorder(Color.orange.opacity(0.9), lineWidth: max(1, height * 0.3))
                case .running:
                    if let progress {
                        Capsule().fill(accent).frame(width: max(height, width * progress))
                    } else {
                        Stripes(color: accent, step: height * 2.5).clipShape(Capsule())
                    }
                case .paused:
                    if let progress {
                        Capsule().fill(Color.primary.opacity(0.35)).frame(width: max(height, width * progress))
                    } else {
                        Stripes(color: Color.primary.opacity(0.3), step: height * 2.5).clipShape(Capsule())
                    }
                }
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

/// A row of short tracks, one for each step (or phase), for a folded line: what runs, what waits,
/// what's paused, at a glance.
public struct GoalTrackStrip: View {
    let tracks: [(state: GoalTrack.State, progress: Double?)]
    let width: CGFloat

    public init(_ tracks: [(state: GoalTrack.State, progress: Double?)], width: CGFloat = 14) {
        self.tracks = tracks
        self.width = width
    }

    public var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(tracks.enumerated()), id: \.offset) { _, track in
                GoalTrack(track.state, progress: track.progress, height: 3).frame(width: width)
            }
        }
        .accessibilityHidden(true)
    }
}

/// A step's state as the mark at the start of its row in a goal's list: a green check once done,
/// orange while it waits for you, an empty circle before it starts, and while it runs a ring
/// with a dot, filled as far as the bot measured (nothing filled where it couldn't say).
public struct GoalStepMark: View {
    let state: GoalTrack.State
    let progress: Double?
    let size: CGFloat
    @Environment(\.accent) private var accent

    public init(_ state: GoalTrack.State, progress: Double? = nil, size: CGFloat = 14) {
        self.state = state
        self.progress = progress.map { min(1, max(0, $0)) }
        self.size = size
    }

    public var body: some View {
        Group {
            switch state {
            case .done:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            case .waiting:
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
            case .paused:
                Image(systemName: "pause.circle").foregroundStyle(.secondary)
            case .skipped:
                Image(systemName: "minus.circle").foregroundStyle(.tertiary)
            case .todo:
                Image(systemName: "circle").foregroundStyle(.tertiary)
            case .running:
                ZStack {
                    Circle().stroke(Color.primary.opacity(0.14), lineWidth: size * 0.115)
                    Circle()
                        .trim(from: 0, to: progress ?? 0)
                        .stroke(accent, style: StrokeStyle(lineWidth: size * 0.13, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    Circle().fill(accent).frame(width: size * 0.32, height: size * 0.32)
                }
                .frame(width: size * 0.9, height: size * 0.9)
            }
        }
        .font(.system(size: size))
        .accessibilityHidden(true)
    }
}

/// Diagonal stripes, still: "at it, but not measured".
private struct Stripes: View {
    let color: Color
    let step: CGFloat

    var body: some View {
        Canvas { context, size in
            var path = Path()
            var x: CGFloat = -size.height
            while x < size.width + size.height {
                path.move(to: CGPoint(x: x, y: size.height))
                path.addLine(to: CGPoint(x: x + size.height, y: 0))
                x += step
            }
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(color.opacity(0.25)))
            context.stroke(path, with: .color(color), lineWidth: step / 2.5)
        }
    }
}
