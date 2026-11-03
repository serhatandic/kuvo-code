import Foundation

/// A goal's timeline view, as both apps draw it (round 4's "names on their bars"): one row per step
/// in the plan's order, its bar from when it began to when it ended (or now). A step not begun is
/// placed after what it waits for, at the pace of the steps done so far, until it has times of its
/// own; before any has begun, the plan fills the time up to the due date. The due date sits on the
/// axis, or past its edge where it's days beyond the work. No phases, even an old goal's.
public struct GoalChart: Sendable {
    public struct Bar: Sendable, Identifiable {
        public enum Kind: Sendable, Equatable {
            case done, doing, waiting, paused, skipped, planned
        }

        public let lane: GoalTimeline.Lane
        public let kind: Kind
        /// Where it's drawn; nil for a step with no time, set aside once the goal is over.
        public let from: Date?
        public let to: Date?
        /// Placed in order at the pace so far, not run: until it begins.
        public let isPlaced: Bool
        public var id: String { lane.id }
        public var step: GoalPlan.Step { lane.step }
    }

    public let bars: [Bar]
    public let lanes: [GoalTimeline.Lane]
    /// What of the axis shows: a long goal's days around now, unless `whole`.
    public let shown: DateInterval
    /// The whole axis.
    public let whole: DateInterval
    public let unit: GoalTimeline.Unit
    public let now: Date
    public let isOver: Bool
    /// Whether any step has begun: before then, the steps are only placed.
    public let hasBegun: Bool
    /// The due date where it's on the axis; nil where there's none or it's past the edge.
    public let due: Date?
    /// Due days beyond the work: said at the axis's edge instead.
    public let isDuePastEdge: Bool
    /// The due date itself, on the axis or past it.
    public let deadline: Date?
    /// When it's likely done, only where every step left was measured.
    public let finish: Date?
    /// Some step is placed rather than run, which the chart says under it.
    public let placesAny: Bool

    /// The steps `id` waits for, by id, in the plan's order.
    public func waitsFor(_ id: String) -> [String] {
        guard let step = lanes.first(where: { $0.id == id })?.step else { return [] }
        return lanes.map(\.id).filter(step.after.contains)
    }

    init(_ timeline: GoalTimeline, whole showsWhole: Bool, calendar: Calendar) {
        let lanes = timeline.lanes
        let now = timeline.now
        let deadline = timeline.deadline
        self.lanes = lanes
        self.now = now
        isOver = timeline.isOver
        finish = timeline.finish
        self.deadline = deadline
        hasBegun = lanes.contains { $0.from != nil }

        // The pace so far: the middle of how long the steps done took, leaving out those marked done
        // in one go (they began as they ended). With none done yet, the time left to the due date
        // shared by the levels still to finish, the step under way's included, or an hour each.
        let durations = lanes.compactMap { lane -> TimeInterval? in
            guard lane.step.state == .done, let from = lane.from, let to = lane.to, to.timeIntervalSince(from) >= 300 else { return nil }
            return to.timeIntervalSince(from)
        }.sorted()
        let depth = Self.depths(lanes)
        let finished = { (lane: GoalTimeline.Lane) in lane.step.state == .done || lane.step.state == .skipped }
        let left = lanes.filter { $0.from == nil && !finished($0) }
        let unfinished = lanes.filter { $0.step.state != .done && $0.step.state != .skipped && ($0.from == nil || $0.likelyEnd == nil) }
        let levels = Set(unfinished.map { depth[$0.id] ?? 0 }).count
        let pace: TimeInterval
        if !durations.isEmpty {
            let middle = durations.count / 2
            pace = durations.count % 2 == 1 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2
        } else if let deadline, deadline > now, levels > 0 {
            pace = deadline.timeIntervalSince(now) * 0.96 / Double(levels)
        } else {
            pace = 3600
        }

        // Where each step ends, for what waits on it: its end, its likely end, or under way at least
        // the pace from when it began.
        var ends: [String: Date] = [:]
        var placed: [String: (Date, Date)] = [:]
        for lane in lanes where lane.from != nil || finished(lane) {
            let from = lane.from ?? now
            ends[lane.id] = finished(lane)
                ? lane.to ?? now
                : max(lane.likelyEnd ?? from.addingTimeInterval(pace), lane.step.resumesDate ?? now, now)
        }
        if !timeline.isOver {
            func place(_ lane: GoalTimeline.Lane, seen: Set<String>) -> Date {
                if let end = ends[lane.id] { return end }
                let before = lane.step.after.compactMap { id in lanes.first { $0.id == id } }.filter { !seen.contains($0.id) }
                let begins = (before.map { place($0, seen: seen.union([lane.id])) } + [now]).max() ?? now
                let end = begins.addingTimeInterval(pace)
                placed[lane.id] = (begins, end)
                ends[lane.id] = end
                return end
            }
            for lane in left { _ = place(lane, seen: []) }
        }
        placesAny = !placed.isEmpty

        bars = lanes.map { lane in
            let state = timeline.isOver && lane.step.state != .done && lane.step.state != .skipped && lane.from == nil ? .skipped : lane.step.state
            let kind: Bar.Kind = switch state {
            case .done: .done
            case .doing: timeline.isOver ? .skipped : .doing
            case .waiting: .waiting
            case .paused: .paused
            case .skipped: .skipped
            case .todo: .planned
            }
            if let (from, to) = placed[lane.id] {
                return Bar(lane: lane, kind: .planned, from: from, to: to, isPlaced: true)
            }
            return Bar(lane: lane, kind: kind, from: lane.from, to: lane.to, isPlaced: false)
        }

        // The axis: from the start to the end of the work, with the due date on it where it's not
        // far beyond (twice the work, at most), and a little room after.
        let start = min(timeline.start, now)
        let work = ([now] + [finish].compactMap { $0 } + bars.compactMap(\.to) + lanes.compactMap(\.likelyEnd)).max() ?? now
        let onAxis = deadline.map { $0 <= work || $0.timeIntervalSince(start) <= 2 * max(3600, work.timeIntervalSince(start)) } ?? false
        due = onAxis ? deadline : nil
        isDuePastEdge = deadline != nil && !onAxis
        let furthest = max(work, onAxis ? deadline ?? work : work)
        let span = max(3600, furthest.timeIntervalSince(start))
        let end = furthest.addingTimeInterval(span * 0.06)
        unit = GoalTimeline.unit(for: span)
        whole = DateInterval(start: start, end: end)
        shown = (showsWhole ? nil : GoalTimeline.window(start: start, end: end, now: now, unit: unit, isOver: timeline.isOver, calendar: calendar)) ?? whole
    }

    /// How many steps come before each, along what it waits for: the first are 0.
    static func depths(_ lanes: [GoalTimeline.Lane]) -> [String: Int] {
        var depth: [String: Int] = [:]
        func of(_ lane: GoalTimeline.Lane, seen: Set<String>) -> Int {
            if let known = depth[lane.id] { return known }
            let before = lane.step.after.compactMap { id in lanes.first { $0.id == id } }.filter { !seen.contains($0.id) }
            let value = (before.map { of($0, seen: seen.union([lane.id])) + 1 }.max()) ?? 0
            depth[lane.id] = value
            return value
        }
        for lane in lanes { _ = of(lane, seen: []) }
        return depth
    }

    /// Where the grid's lines go across what shows: whole hours, days or weeks (Mondays), about 6
    /// to 10 of them.
    public func ticks(calendar: Calendar = .current) -> [Date] {
        GoalTimeline.ticks(start: shown.start, end: shown.end, unit: GoalTimeline.unit(for: shown.duration), calendar: calendar)
    }
}

extension GoalTimeline {
    /// The goal as its timeline view draws it: `whole` for the whole goal rather than the days
    /// around now.
    public func chart(whole: Bool = false, calendar: Calendar = .current) -> GoalChart {
        GoalChart(self, whole: whole, calendar: calendar)
    }
}

extension GoalPlanWords {
    /// Which view a goal opens in, until you pick one: the list until a step begins, then the
    /// timeline.
    public static func opensOnTimeline(_ goal: GoalPlan) -> Bool {
        goal.steps.contains { $0.began != nil }
    }
}
