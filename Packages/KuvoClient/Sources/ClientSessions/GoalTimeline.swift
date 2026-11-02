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

    /// What shows of a goal, top to bottom: phases' names over their steps, and on a long goal
    /// the steps done and those for later folded to a row each, unless nothing else would show.
    public enum Row: Sendable, Identifiable {
        case phase(String)
        case done([Lane])
        case later([Lane])
        case lane(Lane)

        public var id: String {
            switch self {
            case .phase(let name): "phase:\(name)"
            case .done: "done"
            case .later: "later"
            case .lane(let lane): lane.id
            }
        }
    }

    public let start: Date
    public let end: Date
    /// Now, or for a goal that's over, when it ended: what's laid out stops there.
    public let now: Date
    /// Done or stopped.
    public let isOver: Bool
    /// The plan's phases, in its order.
    public let phases: [String]
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
        isOver = plan.state == .done || plan.state == .stopped || plan.state == .declined
        let now = isOver ? plan.ended.map(ms).map { min($0, now) } ?? now : now
        self.now = now
        phases = plan.phases
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

    /// The days a goal of a week or more opens on, around now, so the steps under way get the
    /// room: about five for a week, about ten for longer, from a few days before today. Nil for a
    /// goal that fits whole (a few hours, a couple of days), which shows whole; zoomed out, a long
    /// one shows whole too.
    public func window(calendar: Calendar = .current) -> DateInterval? {
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

    /// The rows it shows. A long goal (one with a `window`) folds its steps done to one row and
    /// those not begun (more than two) to another, opened with `showsDone` and `showsLater`; a
    /// fold that would leave nothing else to see doesn't fold. Any goal folds its steps done once
    /// it has more than six steps.
    public func rows(showsDone: Bool = false, showsLater: Bool = false) -> [Row] {
        let long = window() != nil
        let done = lanes.filter { $0.step.state == .done || $0.step.state == .skipped }
        let later = lanes.filter { $0.step.state == .todo }
        return rows(foldsDone: (long && !done.isEmpty) || (lanes.count > 6 && done.count >= 2), foldsLater: long && later.count > 2, showsDone: showsDone, showsLater: showsLater)
    }

    /// The rows the goal bar lists, top to bottom, whatever the goal's length: the steps done
    /// folded to one row (opened with `showsDone`), phases heading their steps, and more than five
    /// steps not begun folded to one row at the end (opened with `showsLater`). A fold that would
    /// leave nothing else to see doesn't fold.
    public func list(showsDone: Bool = false, showsLater: Bool = false) -> [Row] {
        let done = lanes.filter { $0.step.state == .done || $0.step.state == .skipped }
        let later = lanes.filter { $0.step.state == .todo }
        return rows(foldsDone: !done.isEmpty, foldsLater: later.count > 5, showsDone: showsDone, showsLater: showsLater)
    }

    /// What of the axis a step's track shows: a long goal's days around now (`window`), else, or
    /// `whole`, the whole goal.
    public func shown(whole: Bool = false, calendar: Calendar = .current) -> DateInterval {
        (whole ? nil : window(calendar: calendar)) ?? DateInterval(start: start, end: max(start, end))
    }

    private func rows(foldsDone: Bool, foldsLater: Bool, showsDone: Bool, showsLater: Bool) -> [Row] {
        var foldsDone = foldsDone, foldsLater = foldsLater
        let done = lanes.filter { $0.step.state == .done || $0.step.state == .skipped }
        let later = lanes.filter { $0.step.state == .todo }
        let rest = lanes.filter { lane in !(foldsDone && done.contains { $0.id == lane.id }) && !(foldsLater && later.contains { $0.id == lane.id }) }
        if rest.isEmpty {
            // Only folds would show: what's in the bigger stays open.
            if done.count >= later.count { foldsDone = false } else { foldsLater = false }
        }
        var rows: [Row] = []
        var left = lanes
        if foldsDone {
            rows.append(.done(done))
            if showsDone { rows += done.map(Row.lane) }
            left.removeAll { lane in done.contains { $0.id == lane.id } }
        }
        if foldsLater { left.removeAll { lane in later.contains { $0.id == lane.id } } }
        if phases.count > 1 {
            for phase in phases {
                let lanes = left.filter { $0.step.phase == phase }
                guard !lanes.isEmpty else { continue }
                rows.append(.phase(phase))
                rows += lanes.map(Row.lane)
            }
            rows += left.filter { $0.step.phase.map { !phases.contains($0) } ?? true }.map(Row.lane)
        } else {
            rows += left.map(Row.lane)
        }
        if foldsLater {
            rows.append(.later(later))
            if showsLater { rows += later.map(Row.lane) }
        }
        return rows
    }

    /// Where `date` falls along the axis, 0 at its start and 1 at its end.
    public func position(of date: Date) -> Double {
        let span = end.timeIntervalSince(start)
        return span > 0 ? min(1, max(0, date.timeIntervalSince(start) / span)) : 0
    }
}
