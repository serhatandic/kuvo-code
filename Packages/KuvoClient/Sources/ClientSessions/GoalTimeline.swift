import Foundation

/// A goal laid out in time, as both apps draw it under way (PROTOCOL.md, "Work › Goals"): one view
/// for a goal of any length, its axis counting hours for a few hours' work, days for a week or more,
/// weeks for months. Each step spans from when it began to when it ended (or now), with where it's
/// likely to end only where the bot measured how far it is; the finish line only where every step
/// left can say; the deadline where you set one. Both apps lay its steps out as a list (`stages`) or
/// on the axis (`chart`).
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
        public var id: String { step.id }
    }

    public let start: Date
    public let end: Date
    /// Now, or for a goal that's over, when it ended: what's laid out stops there.
    public let now: Date
    /// Done or stopped.
    public let isOver: Bool
    public let unit: Unit
    /// When it's likely done, where every step left says how far along it is.
    public let finish: Date?
    /// The end you set, if any.
    public let deadline: Date?
    public let lanes: [Lane]

    public init(_ plan: GoalPlan, now: Date = .now) {
        let ms = { (value: Double) in Date(timeIntervalSince1970: value / 1000) }
        isOver = plan.state == .done || plan.state == .stopped || plan.state == .declined
        let now = isOver ? plan.ended.map(ms).map { min($0, now) } ?? now : now
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
            if step.state != .done, step.state != .skipped, !isOver {
                if let from, let progress = step.progress, progress > 0.02 {
                    likelyEnd = from.addingTimeInterval(max(0, now.timeIntervalSince(from)) / progress)
                }
                if let likelyEnd { likely.append(likelyEnd) } else { unmeasured = true }
            }
            lanes.append(Lane(step: step, from: from, to: to, likelyEnd: likelyEnd))
        }
        finish = unmeasured || likely.isEmpty ? nil : likely.max()
        self.lanes = lanes
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
        Self.ticks(start: start, end: end, unit: unit, calendar: calendar)
    }

    static func ticks(start: Date, end: Date, unit: Unit, calendar: Calendar) -> [Date] {
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

    /// The days a goal of a week or more opens on, around now, so the steps under way get the
    /// room: about five for a week, about ten for longer, from a few days before today. Nil for a
    /// goal that fits whole (a few hours, a couple of days), which shows whole; zoomed out, a long
    /// one shows whole too.
    public func window(calendar: Calendar = .current) -> DateInterval? {
        Self.window(start: start, end: end, now: now, unit: unit, isOver: isOver, calendar: calendar)
    }

    static func window(start: Date, end: Date, now: Date, unit: Unit, isOver: Bool, calendar: Calendar) -> DateInterval? {
        let span = end.timeIntervalSince(start)
        guard unit != .hour, !isOver else { return nil }
        let long = span > 14 * 86400
        let today = calendar.startOfDay(for: now)
        guard let from = calendar.date(byAdding: .day, value: long ? -3 : -2, to: today),
              let to = calendar.date(byAdding: .day, value: long ? 10 : 5, to: from), to.timeIntervalSince(from) < span else { return nil }
        // Within the axis: a goal with no end yet opens on its last days, now among them.
        let length = to.timeIntervalSince(from)
        let shifted = min(max(from, start), end.addingTimeInterval(-length))
        return DateInterval(start: shifted, duration: length)
    }

    /// What of the axis a step's track shows: a long goal's days around now (`window`), else, or
    /// `whole`, the whole goal.
    public func shown(whole: Bool = false, calendar: Calendar = .current) -> DateInterval {
        (whole ? nil : window(calendar: calendar)) ?? DateInterval(start: start, end: max(start, end))
    }
}
