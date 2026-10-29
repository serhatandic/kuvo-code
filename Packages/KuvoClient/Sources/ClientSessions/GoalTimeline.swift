import Foundation

/// A goal laid out in time, as both apps draw it under way (PROTOCOL.md, "Work › Goals"): one view
/// for a goal of any length, its axis counting hours for a few hours' work, days for a week or more,
/// weeks for months. Each step spans from when it began to when it ended (or now), with where it's
/// likely to end only where the bot measured how far it is; the finish line only where every step
/// left can say; the deadline where you set one. The phone's day view stacks steps that run at the
/// same time side by side, in columns.
public struct GoalTimeline: Sendable {
    public enum Unit: Sendable, Equatable {
        case hour, day, week
    }

    /// A step on the axis.
    public struct Lane: Sendable, Identifiable {
        public let step: GoalPlan.Step
        /// When it began, and ended (now, for one still under way); nil before it begins.
        public let from: Date?
        public let to: Date?
        /// Where it's likely to end, from how far along it was measured; nil where it wasn't.
        public let likelyEnd: Date?
        /// Its column among the steps at the same time (the phone's day view), from 0.
        public let column: Int
        public var id: String { step.id }
    }

    public let start: Date
    public let end: Date
    public let now: Date
    public let unit: Unit
    /// When it's likely done, where every step left says how far along it is.
    public let finish: Date?
    /// The end you set, if any.
    public let deadline: Date?
    public let lanes: [Lane]
    /// How many columns the steps at the same time need at most.
    public let columns: Int

    public init(_ plan: GoalPlan, now: Date = .now) {
        let ms = { (value: Double) in Date(timeIntervalSince1970: value / 1000) }
        self.now = now
        start = ms(plan.started ?? plan.proposed)
        deadline = plan.ends.map(ms)
        var lanes: [Lane] = []
        var likely: [Date] = []
        var unmeasured = false
        for step in plan.steps {
            let from = step.began.map(ms)
            let to = step.ended.map(ms) ?? (from == nil ? nil : now)
            var likelyEnd: Date?
            if step.state != .done, step.state != .skipped {
                if let from, let progress = step.progress, progress > 0.02 {
                    likelyEnd = from.addingTimeInterval(max(0, now.timeIntervalSince(from)) / progress)
                }
                if let likelyEnd { likely.append(likelyEnd) } else { unmeasured = true }
            }
            lanes.append(Lane(step: step, from: from, to: to, likelyEnd: likelyEnd, column: 0))
        }
        finish = unmeasured || likely.isEmpty ? nil : likely.max()
        // Columns: each step that ran takes the first column free at its start.
        var columnEnds: [Date] = []
        var placed: [String: Int] = [:]
        for lane in lanes.filter({ $0.from != nil }).sorted(by: { $0.from! < $1.from! }) {
            let from = lane.from!, to = max(lane.to ?? now, lane.likelyEnd ?? from)
            if let free = columnEnds.firstIndex(where: { $0 <= from }) {
                columnEnds[free] = to
                placed[lane.id] = free
            } else {
                placed[lane.id] = columnEnds.count
                columnEnds.append(to)
            }
        }
        self.lanes = lanes.map { Lane(step: $0.step, from: $0.from, to: $0.to, likelyEnd: $0.likelyEnd, column: placed[$0.id] ?? 0) }
        columns = max(1, columnEnds.count)
        // The axis runs from the start to the furthest of now, the finish, the deadline and the
        // likely ends, with a little room after.
        let furthest = ([now, finish, deadline].compactMap { $0 } + likely + lanes.compactMap(\.to)).max() ?? now
        let span = max(3600, furthest.timeIntervalSince(start))
        end = furthest.addingTimeInterval(span * 0.06)
        unit = Self.unit(for: span)
    }

    /// The unit an axis spanning `span` counts in.
    public static func unit(for span: TimeInterval) -> Unit {
        switch span {
        case ..<(36 * 3600): .hour
        case ..<(35 * 86400): .day
        default: .week
        }
    }

    /// Where the grid's lines go: on whole hours, days or weeks (Mondays), about 6 to 10 of them.
    public func ticks(calendar: Calendar = .current) -> [Date] {
        let span = end.timeIntervalSince(start)
        let (component, size): (Calendar.Component, TimeInterval) = switch unit {
        case .hour: (.hour, 3600)
        case .day: (.day, 86400)
        case .week: (.weekOfYear, 7 * 86400)
        }
        let every = max(1, Int((span / size / 8).rounded(.up)))
        var first: Date
        switch unit {
        case .hour: first = calendar.dateInterval(of: .hour, for: start)?.end ?? start
        case .day: first = calendar.dateInterval(of: .day, for: start)?.end ?? start
        case .week:
            var monday = calendar
            monday.firstWeekday = 2
            first = monday.dateInterval(of: .weekOfYear, for: start)?.end ?? start
        }
        var ticks: [Date] = []
        while first < end, ticks.count < 40 {
            ticks.append(first)
            first = calendar.date(byAdding: component, value: every, to: first) ?? end
        }
        return ticks
    }

    /// Where `date` falls along the axis, 0 at its start and 1 at its end.
    public func position(of date: Date) -> Double {
        let span = end.timeIntervalSince(start)
        return span > 0 ? min(1, max(0, date.timeIntervalSince(start) / span)) : 0
    }
}
