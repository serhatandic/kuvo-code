import Foundation

/// A goal's list view, as both apps draw it: left to right (top to bottom when narrow) what's done,
/// the step or steps under way, each a card, and what's ahead, the steps that start together on
/// one row. Before it starts, or between steps, the first step that can start stands in the card,
/// grey until it begins. Once it's over there are no cards: what it left follows what's done, in
/// order. Paused, the steps under way show paused.
public struct GoalStages: Sendable {
    public struct Card: Sendable, Identifiable {
        public enum Look: Sendable, Equatable {
            case doing, waiting, paused
            /// It can start next and hasn't yet.
            case ready
        }

        public let lane: GoalTimeline.Lane
        public let look: Look
        public var id: String { lane.id }
        public var step: GoalPlan.Step { lane.step }
    }

    /// The steps done (or set aside along the way), in the plan's order.
    public let done: [GoalTimeline.Lane]
    public let now: [Card]
    /// What's left, a row for each time steps start: two side by side start together.
    public let ahead: [[GoalTimeline.Lane]]
    public let isOver: Bool
    private let numbers: [String: Int]

    /// A step's number in the plan, from 1.
    public func number(_ id: String) -> Int { numbers[id] ?? 0 }

    /// The most cards shown; the rest under way are named on one line under them.
    public static let mostCards = 3

    /// The cards shown, in the plan's order, those waiting for you kept first; and the rest under
    /// way.
    public var cards: (shown: [Card], rest: [Card]) {
        guard now.count > Self.mostCards else { return (now, []) }
        let kept = Set((now.filter { $0.look == .waiting } + now.filter { $0.look != .waiting }).prefix(Self.mostCards).map(\.id))
        return (now.filter { kept.contains($0.id) }, now.filter { !kept.contains($0.id) })
    }

    init(_ timeline: GoalTimeline, chart: GoalChart, paused: Bool) {
        let lanes = timeline.lanes
        numbers = Dictionary(lanes.enumerated().map { ($1.id, $0 + 1) }, uniquingKeysWith: { first, _ in first })
        isOver = timeline.isOver
        let finished = { (lane: GoalTimeline.Lane) in lane.step.state == .done || lane.step.state == .skipped }
        done = lanes.filter(finished)
        let left = lanes.filter { !finished($0) }
        guard !isOver else {
            now = []
            ahead = left.map { [$0] }
            return
        }
        var now: [Card] = left.compactMap { lane in
            switch lane.step.state {
            case .doing: Card(lane: lane, look: paused ? .paused : .doing)
            case .waiting: Card(lane: lane, look: .waiting)
            case .paused: Card(lane: lane, look: .paused)
            default: nil
            }
        }
        if now.isEmpty {
            // Nothing under way: the first that can start, everything it waits for finished (or the
            // first step left, where they wait on each other). The rest that could start too are
            // ahead, together.
            let finishedIDs = Set(done.map(\.id)), known = Set(lanes.map(\.id))
            let ready = left.first { $0.step.after.allSatisfy { finishedIDs.contains($0) || !known.contains($0) } }
            now = (ready ?? left.first).map { [Card(lane: $0, look: .ready)] } ?? []
        }
        self.now = now
        // The rest by when they're placed to start, to the second, in the plan's order within a
        // start; the steps that start when the card's could have, beside it, first.
        let starts = Dictionary(chart.bars.map { ($0.id, $0.from.map { Int($0.timeIntervalSince1970.rounded()) }) }, uniquingKeysWith: { first, _ in first })
        let inCards = Set(now.map(\.id))
        let rest = left.filter { !inCards.contains($0.id) }
        var rows: [(start: Int, lanes: [GoalTimeline.Lane])] = []
        for lane in rest {
            let start = (starts[lane.id] ?? nil) ?? .max
            if let at = rows.firstIndex(where: { $0.start == start }), start != .max {
                rows[at].lanes.append(lane)
            } else {
                rows.append((start, [lane]))
            }
        }
        ahead = rows.enumerated().sorted { ($0.element.start, $0.offset) < ($1.element.start, $1.offset) }.map(\.element.lanes)
    }
}

extension GoalTimeline {
    /// The goal as its list view lays it out (`GoalStages`); `paused` while you have it paused.
    public func stages(paused: Bool = false, calendar: Calendar = .current) -> GoalStages {
        GoalStages(self, chart: chart(calendar: calendar), paused: paused)
    }
}

extension GoalPlanWords {
    /// The plan in a line, in the order its steps start, as the list lays them out: "Pick the
    /// concept → Build the core app → Paywall · Icon and store screenshots → Submit", steps that
    /// start together joined by "·".
    public static func flow(_ goal: GoalPlan, now: Date = .now, calendar: Calendar = .current) -> String {
        let timeline = GoalTimeline(goal, now: now)
        let starts = Dictionary(timeline.chart(calendar: calendar).bars.map { ($0.id, $0.from.map { Int($0.timeIntervalSince1970.rounded()) }) }, uniquingKeysWith: { first, _ in first })
        var rows: [(start: Int, names: [String])] = []
        for lane in timeline.lanes {
            let start = (starts[lane.id] ?? nil) ?? .max
            if start != .max, let at = rows.firstIndex(where: { $0.start == start }) {
                rows[at].names.append(lane.step.text)
            } else {
                rows.append((start, [lane.step.text]))
            }
        }
        return rows.enumerated().sorted { ($0.element.start, $0.offset) < ($1.element.start, $1.offset) }
            .map { $0.element.names.joined(separator: " · ") }.joined(separator: " → ")
    }

    /// About how long a card's step has left, from how far along the bot measured it: "about 1 h
    /// left", "about 25 min left". Nil where it wasn't measured, or for one not under way.
    public static func left(_ card: GoalStages.Card, now: Date) -> String? {
        guard card.look == .doing, let end = card.lane.likelyEnd else { return nil }
        let minutes = max(0, end.timeIntervalSince(now)) / 60
        switch minutes {
        case ..<5: return "a few minutes left"
        case ..<57.5: return "about \(Int((minutes / 5).rounded()) * 5) min left"
        case ..<(48 * 60): return "about \(Int((minutes / 60).rounded())) h left"
        default: return "about \(Int((minutes / 1440).rounded())) days left"
        }
    }
}
