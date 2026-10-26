import OpenCodeKit
import SwiftUI

/// A conversation's goal ("/goal …"), in a bar over the composer like the others that say what
/// goes on out of sight: one line with where it stands (working, being checked, paused, met), and
/// under it the goal and what the last check found. Pause, Resume and Stop are on the line; a goal
/// that's over is put away with Done. The box runs it, so it goes on with the window closed.
struct GoalBar: View {
    let goal: Goal
    @Binding var isHidden: Bool
    let pause: () -> Void
    let resume: () -> Void
    let clear: () -> Void

    var body: some View {
        // Kept current: how long it has been at it.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 0) {
                header(now: context.date)
                if !isHidden {
                    details
                        .padding(.leading, 42)
                        .padding(.trailing, 16)
                        .padding(.bottom, 12)
                        .transition(.opacity)
                }
            }
        }
        .animation(.ui, value: goal.state)
        .animation(.ui, value: goal.checking)
    }

    // MARK: The line

    private func header(now: Date) -> some View {
        HStack(spacing: 0) {
            Button {
                withAnimation(.ui) { isHidden.toggle() }
            } label: {
                HStack(spacing: 10) {
                    mark
                        .frame(width: 18)
                    Text(title)
                        .font(.system(size: 13, weight: .medium))
                    Text(progress(now: now))
                        .font(.system(size: 13).monospacedDigit())
                        .foregroundStyle(.secondary)
                    if isHidden, let detail {
                        Text(detail.replacingOccurrences(of: "\n", with: " "))
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 8)
                }
                .padding(.leading, 14)
                .frame(height: 36)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .clickablePointer()
            .help(isHidden ? "Show the goal, and what the last check found" : "Hide them: this line stays")
            .accessibilityLabel("\(title), \(progress(now: now))")
            .accessibilityValue(isHidden ? "Hidden" : "Shown")
            actions
            Image(systemName: "chevron.down")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .rotationEffect(.degrees(isHidden ? 180 : 0))
                .padding(.leading, 6)
                .padding(.trailing, 16)
                .contentShape(.rect)
                .onTapGesture { withAnimation(.ui) { isHidden.toggle() } }
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder private var mark: some View {
        switch goal.state {
        case .working where goal.checking:
            Spinner(size: 14)
        case .working:
            Image(systemName: "scope")
                .font(.system(size: 13))
                .foregroundStyle(.tint)
        case .paused:
            Image(systemName: "pause.circle")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
        case .met:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 13))
                .foregroundStyle(.green)
        case .unmet:
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 13))
                .foregroundStyle(.orange)
        }
    }

    private var title: String {
        switch goal.state {
        case .working where goal.checking: "Checking the goal…"
        case .working: "Working toward a goal"
        case .paused: "Goal paused"
        case .met: "Goal met"
        case .unmet: "Goal can’t be met"
        }
    }

    /// Its turns so far, and how long it has been at it (or took).
    private func progress(now: Date) -> String {
        let turns = goal.turns == 1 ? "1 turn" : "\(goal.turns) turns"
        let time = Self.duration(from: goal.startedDate, to: goal.endedDate ?? now)
        switch goal.state {
        case .working, .paused: return goal.turns == 0 ? time : "\(turns) · \(time)"
        case .met, .unmet: return "in \(turns) · \(time)"
        }
    }

    /// What it is, beside the title while the rest is hidden.
    private var detail: String? {
        switch goal.state {
        case .working: goal.condition
        case .paused, .unmet: goal.note ?? goal.condition
        case .met: goal.last?.reason ?? goal.condition
        }
    }

    @ViewBuilder private var actions: some View {
        HStack(spacing: 2) {
            switch goal.state {
            case .working:
                Button("Pause", systemImage: "pause", action: pause)
                    .help("Hold the goal: the turn under way ends as it would, and no other starts")
                Button("Stop", systemImage: "xmark.circle", action: clear)
                    .help("Take the goal away: the agent carries on only with what you ask")
            case .paused:
                Button("Resume", systemImage: "play", action: resume)
                    .help("Check what it last did, and carry on unless that met the goal")
                Button("Stop", systemImage: "xmark.circle", action: clear)
                    .help("Take the goal away: the agent carries on only with what you ask")
            case .met, .unmet:
                Button("Done", systemImage: "checkmark", action: clear)
                    .help("Put the goal away")
            }
        }
        .buttonStyle(TextButtonStyle())
        .font(.system(size: 13))
        .labelStyle(.titleOnly)
    }

    // MARK: Under the line

    private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(goal.condition)
                .font(.system(size: 13))
                .lineLimit(6)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let (symbol, words) = finding {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: symbol)
                        .font(.system(size: 11))
                        .accessibilityHidden(true)
                    Text(words)
                        .font(.system(size: 12))
                        .lineLimit(4)
                        .textSelection(.enabled)
                }
                .foregroundStyle(.secondary)
            }
        }
    }

    /// What the last check found, or why it stopped.
    private var finding: (String, String)? {
        switch goal.state {
        case .working where goal.checking:
            return ("scope", "Reading what the agent did to see whether it’s met.")
        case .working:
            if let last = goal.last, last.verdict == .notMet { return ("arrow.turn.down.right", "Not met yet: \(last.reason)") }
            return ("scope", "Checked after each turn. The agent keeps going until it’s met.")
        case .paused:
            return ("pause", goal.note.map { $0 + (goal.pausedBy == .you ? "" : " Resume to carry on.") } ?? "Paused.")
        case .met:
            return goal.last.map { ("checkmark", $0.reason) }
        case .unmet:
            return goal.note.map { ("exclamationmark.circle", $0) }
        }
    }

    /// "under a minute", "12 min", "1 h 5 min".
    static func duration(from start: Date, to end: Date) -> String {
        let minutes = max(0, Int(end.timeIntervalSince(start))) / 60
        if minutes < 1 { return "under a minute" }
        if minutes < 60 { return "\(minutes) min" }
        return minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60) min"
    }
}
