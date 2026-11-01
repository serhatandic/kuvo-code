import ClientDesign
import OpenCodeKit
import SwiftUI

/// A conversation's goal ("/goal …"), in a bar over the composer like the others that say what
/// goes on out of sight: one line with where it stands (working, being checked, paused, met), and
/// under it the goal and what the last check found. Pause is on the line (Resume once paused),
/// and Stop under it, with the goal; a goal that's over is put away with ✕. The box runs it, so it goes on with the
/// window closed.
struct GoalBar: View {
    let goal: Goal
    @Binding var isHidden: Bool
    /// A change asked for is on its way: the buttons wait for it.
    var isChanging = false
    /// Messages are waiting: stopping the agent holds them, paused, which Stop says.
    var hasWaiting = false
    let pause: () -> Void
    let resume: () -> Void
    /// Takes the goal away, and stops the turn under way.
    let stop: () -> Void
    /// Puts away a goal that's over.
    let done: () -> Void
    /// Stop asked for: it waits for a yes, as it can't be undone.
    @State private var confirmsStop = false

    /// Under way or paused, and free to change.
    private var canStop: Bool { !isChanging && (goal.state == .working || goal.state == .paused) }

    var body: some View {
        // Kept current: how long it has been at it.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 0) {
                BarLine(mark: AnyView(mark), title: title, progress: progress(now: context.date), detail: detail.map { Text($0.replacingOccurrences(of: "\n", with: " ")) },
                        accessory: AnyView(actions), showHelp: "Show the goal, and what the last check found", hideHelp: "Hide them: this line stays", isHidden: $isHidden,
                        close: goal.state == .met || goal.state == .unmet ? done : nil, closeHelp: "Put the goal away")
                if !isHidden {
                    details
                        .padding(.leading, 42)
                        .padding(.trailing, 16)
                        .padding(.bottom, 12)
                        .transition(.fold)
                }
            }
        }
        .animation(.ui, value: goal.state)
        .animation(.ui, value: goal.checking)
        // Stopping it can't be undone: the turn under way ends, and the goal goes.
        .closesWhenKept($confirmsStop)
        .confirmationDialog("Stop the goal?", isPresented: $confirmsStop) {
            Button("Stop the Goal", role: .destructive) {
                // Only a goal still under way: one met meanwhile stays to be read.
                guard canStop else { return }
                stop()
            }
        } message: {
            Text(goal.state == .working
                 ? "The agent stops what it's doing, and the goal is taken away." + (hasWaiting ? " Messages waiting stay paused." : "")
                 : "The goal is taken away.")
        }
        // A goal that ended, or that can't be changed now, has nothing to stop: the question goes.
        .onChange(of: canStop) { _, can in
            if !can { confirmsStop = false }
        }
    }

    // MARK: The line

    /// Paused by the box (a turn failed, the agent stopped making progress): it needs you.
    private var needsYou: Bool {
        goal.state == .paused && (goal.pausedBy == .error || goal.pausedBy == .stalled)
    }

    @ViewBuilder private var mark: some View {
        switch goal.state {
        case .working where goal.checking:
            Spinner(size: 14)
        case .working:
            Image(systemName: "scope")
                .font(.system(size: 13))
                .foregroundStyle(.tint)
        case .paused where needsYou, .unmet:
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 13))
                .foregroundStyle(.orange)
        case .paused:
            Image(systemName: "pause.circle.fill")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
        case .met:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 13))
                .foregroundStyle(.green)
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

    /// Its turns so far, and how long it has been at it (or took). Paused, the clock doesn't
    /// count: only its turns.
    private func progress(now: Date) -> String? {
        let turns = goal.turns == 1 ? "1 turn" : "\(goal.turns) turns"
        switch goal.state {
        case .working:
            let time = Self.duration(from: goal.startedDate, to: now)
            return goal.turns == 0 ? time : "\(turns) · \(time)"
        case .paused:
            return goal.turns == 0 ? nil : turns
        case .met, .unmet:
            return "in \(turns) · \(Self.duration(from: goal.startedDate, to: goal.endedDate ?? now))"
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

    /// The line's one action: Pause, or Resume once paused.
    @ViewBuilder private var actions: some View {
        Group {
            switch goal.state {
            case .working:
                Button("Pause", action: pause)
                    .help("Stop the turn under way and hold the goal until you resume it")
            case .paused:
                Button("Resume", action: resume)
                    .help("Check what it last did, and carry on unless that met the goal")
            case .met, .unmet:
                EmptyView()
            }
        }
        .buttonStyle(TextButtonStyle())
        .font(.system(size: 13))
        .disabled(isChanging)
    }

    // MARK: Under the line

    private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(goal.condition)
                .font(.system(size: 13))
                .lineLimit(6)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(goal.condition)
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
            if goal.state == .working || goal.state == .paused {
                Button("Stop the Goal…") { confirmsStop = true }
                    .buttonStyle(TextButtonStyle(outset: true))
                    .font(.system(size: 13))
                    .disabled(isChanging)
                    .help(goal.state == .working ? "Stop the agent and take the goal away" : "Take the goal away")
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
            return ("pause", goal.note ?? "Paused.")
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
