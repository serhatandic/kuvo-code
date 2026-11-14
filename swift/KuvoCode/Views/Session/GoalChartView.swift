import AppKit
import ClientDesign
import ClientSessions
import SwiftUI

/// A goal's steps on a timeline (`GoalChart`), the width of the card: one row per step in order,
/// each a pill from its start that holds its whole name after its mark, a line along its foot as
/// long as its time (grey done, the accent under way, lit as far as now, faint what's planned). Over them an axis with Now, the due date and when
/// it's likely done as flags, the due date at the edge where it's days past the work. Point at a
/// step for lines from what it waits for, the rest dimmed. A long goal opens on the days around
/// now; pinch or ⌘-scroll shows it whole.
struct GoalChartView: View {
    let plan: GoalPlan
    let timeline: GoalTimeline
    @Environment(\.accent) private var accent
    @Environment(\.colorScheme) private var scheme
    @State private var zoomedOut = false
    @State private var pointed: String?
    @State private var zoomKeys = ZoomKeys()

    static let rowHeight: CGFloat = 28
    static let axisHeight: CGFloat = 22
    static let barHeight: CGFloat = 20
    /// The most the rows take before they scroll: about ten.
    static let mostHeight: CGFloat = 10 * rowHeight

    private var now: Date { timeline.now }
    private var isRunning: Bool { plan.state == .running }

    /// Each bar and the top of its row.
    private struct Placed: Identifiable {
        let bar: GoalChart.Bar
        let index: Int
        let y: CGFloat
        var id: String { bar.id }
        var mid: CGFloat { y + GoalChartView.rowHeight / 2 }
    }

    private func placed(_ chart: GoalChart) -> [Placed] {
        var y: CGFloat = 0
        return chart.bars.enumerated().map { index, bar in
            defer { y += Self.rowHeight }
            return Placed(bar: bar, index: index, y: y)
        }
    }

    var body: some View {
        let chart = timeline.chart(whole: zoomedOut)
        let rows = placed(chart)
        let height = (rows.last?.y ?? -Self.rowHeight) + Self.rowHeight
        let shownHeight = min(height, Self.mostHeight)
        let long = chart.whole.duration > chart.shown.duration + 60
        VStack(alignment: .leading, spacing: 6) {
            GeometryReader { measured in
                let x = ChartX(shown: chart.shown, width: measured.size.width, kept: Self.kept(chart, width: measured.size.width))
                VStack(alignment: .leading, spacing: 0) {
                    axis(chart, x: x)
                        .frame(width: x.width, height: Self.axisHeight, alignment: .topLeading)
                    ScrollView(.vertical) {
                        ZStack(alignment: .topLeading) {
                            grid(chart, x: x, height: height)
                            ForEach(rows) { row in
                                self.row(row, chart: chart, x: x)
                                    .frame(width: x.width, height: Self.rowHeight)
                                    .offset(y: row.y)
                                    .opacity(dims(row.bar, chart: chart) ? 0.38 : 1)
                            }
                            if let pointed {
                                links(into: pointed, rows: rows, chart: chart, x: x)
                                    .allowsHitTesting(false)
                            }
                        }
                        .frame(width: x.width, height: height, alignment: .topLeading)
                        .contentShape(.rect)
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let at):
                                let id = rows.last { $0.y <= at.y }?.id
                                if id != pointed { withAnimation(.easeOut(duration: 0.12)) { pointed = id } }
                            case .ended:
                                withAnimation(.easeOut(duration: 0.12)) { pointed = nil }
                            }
                        }
                    }
                    .scrollDisabled(height <= Self.mostHeight)
                    .scrollIndicators(height > Self.mostHeight ? .automatic : .never)
                    .fadingScrollEdges(20)
                    .frame(height: shownHeight)
                }
            }
            .frame(height: Self.axisHeight + shownHeight)
            if !chart.hasBegun, chart.placesAny {
                Text("Placed in order until the steps have times.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.leading, GoalSteps.nameInset)
        .font(.system(size: 12))
        // Pinch, or ⌘-scroll, for the whole goal and back.
        .gesture(MagnifyGesture().onEnded { value in
            guard long || zoomedOut else { return }
            if value.magnification < 0.9, !zoomedOut { withAnimation(.ui) { zoomedOut = true } }
            if value.magnification > 1.1, zoomedOut { withAnimation(.ui) { zoomedOut = false } }
        })
        .onHover { zoomKeys.hovering = $0 }
        .onChange(of: long || zoomedOut, initial: true) { _, zooms in
            if zooms { zoomKeys.start($zoomedOut) } else { zoomKeys.stop() }
        }
        .onDisappear { zoomKeys.stop() }
        .onChange(of: plan.id) {
            // Another goal in the same place: nothing pointed at or zoomed carries over.
            pointed = nil
            zoomedOut = false
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Timeline")
        .accessibilityValue(spokenAxis(chart))
        .accessibilityActions {
            if long || zoomedOut {
                Button(zoomedOut ? "Show the Days Around Today" : "Show the Whole Goal") { zoomedOut.toggle() }
            }
        }
    }

    /// While you point at a step, everything but it and what it waits for steps back.
    private func dims(_ bar: GoalChart.Bar, chart: GoalChart) -> Bool {
        guard let pointed, chart.bars.contains(where: { $0.id == pointed }) else { return false }
        return bar.id != pointed && !chart.waitsFor(pointed).contains(bar.id)
    }

    // MARK: A row

    /// A step's pill: from where it starts, as long as its time or as its name where that's
    /// longer (never past the right edge), and how much of it is its time, which its foot line
    /// shows. A step past the right edge sits against it, one before the left against that.
    struct Pill: Equatable {
        var start: CGFloat
        var width: CGFloat
        var time: CGFloat
        /// Whether its time falls on the axis, for the lines into a step you point at.
        var isOnAxis: Bool
    }

    static func pill(_ bar: GoalChart.Bar, chart: GoalChart, x: ChartX, now: Date) -> Pill {
        let name = nameWidth(bar)
        guard let from = bar.from, from < chart.shown.end else {
            return Pill(start: max(0, x.width - name), width: min(name, x.width), time: 0, isOnAxis: false)
        }
        let to = max(from, bar.kind == .doing ? expectedEnd(bar, chart: chart, now: now) : bar.to ?? now)
        guard to > chart.shown.start else {
            return Pill(start: 0, width: min(name, x.width), time: 0, isOnAxis: false)
        }
        let start = max(0, x(from)), end = min(x.width, x(to))
        return Pill(start: start, width: min(x.width - start, max(end - start, name)), time: end - start, isOnAxis: true)
    }

    /// What a pill's label takes: its number or mark, and its whole name, at the chart's size.
    static func nameWidth(_ bar: GoalChart.Bar) -> CGFloat {
        let weight: NSFont.Weight = bar.kind == .doing || bar.kind == .waiting ? .medium : .regular
        let text = (bar.step.text as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: weight)]).width
        return 4 + (GoalPlanWords.mark(of: bar.step) != nil ? 14 : 15) + 6 + ceil(text) + 8
    }

    /// Where the step under way is likely to end: where the steps waiting on it are placed to
    /// begin, else how long it measured it would take, else now.
    static func expectedEnd(_ bar: GoalChart.Bar, chart: GoalChart, now: Date) -> Date {
        let next = chart.bars.filter { $0.isPlaced && $0.step.after.contains(bar.id) }.compactMap(\.from).min()
        return max(next ?? bar.lane.likelyEnd ?? now, now)
    }

    /// The room at the right the axis leaves: enough that every step's name fits whole from where
    /// it starts (the times drawn closer together where one would run past the edge, down to half
    /// the width), and the
    /// due date said at the edge.
    static func kept(_ chart: GoalChart, width: CGFloat) -> CGFloat {
        let edge = saysDueAtEdge(chart) ? edgeRoom : 0
        let duration = max(1, chart.shown.duration)
        var room = width - edge
        for bar in chart.bars {
            guard let from = bar.from, from > chart.shown.start, from < chart.shown.end else { continue }
            let along = CGFloat(from.timeIntervalSince(chart.shown.start) / duration)
            room = min(room, (width - nameWidth(bar)) / along)
        }
        // Time keeps at least half the width: past that, a late step's long name is cut instead.
        return max(edge, width - max(width / 2, room))
    }

    private func row(_ row: Placed, chart: GoalChart, x: ChartX) -> some View {
        let bar = row.bar
        let pill = Self.pill(bar, chart: chart, x: x, now: now)
        return self.pill(bar, index: row.index, pill: pill, x: x)
            .frame(width: pill.width, height: Self.barHeight)
            .offset(x: pill.start, y: (Self.rowHeight - Self.barHeight) / 2)
            .frame(width: x.width, height: Self.rowHeight, alignment: .topLeading)
            .contentShape(.rect)
            .help(help(bar))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(bar.step.text)
            .accessibilityValue(spoken(bar))
    }

    private func pill(_ bar: GoalChart.Bar, index: Int, pill: Pill, x: ChartX) -> some View {
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        return shape.fill(fill(bar.kind))
            .overlay(alignment: .bottomLeading) {
                // How long it takes: a line along the foot, as far as its time; under way, the
                // accent as far as now.
                ZStack(alignment: .leading) {
                    Rectangle().fill(foot(bar.kind)).frame(width: max(0, min(pill.width, pill.time)))
                    if bar.kind == .doing {
                        Rectangle().fill(accent).frame(width: max(0, min(pill.time, x(now) - pill.start)))
                    }
                }
                .frame(height: bar.kind == .doing ? 3 : 2)
            }
            .clipShape(shape)
            .overlay(alignment: .leading) { label(bar, index: index) }
    }

    private func label(_ bar: GoalChart.Bar, index: Int) -> some View {
        let step = bar.step
        return HStack(spacing: 6) {
            if GoalPlanWords.mark(of: step) != nil {
                StepServiceMark(step: step)
            } else {
                Text("\(index + 1)")
                    .font(.system(size: 9.5, weight: .semibold).monospacedDigit())
                    .foregroundStyle(bar.kind == .doing ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
                    .frame(width: 15, height: 15)
                    .background(Circle().fill(bar.kind == .doing ? accent : Color.primary.opacity(0.08)))
            }
            // Whole where the pill holds it; cut in the middle only where a name is longer than
            // the card, so steps named alike ("…(3 of 9)") still differ.
            Text(step.text)
                .lineLimit(1)
                .truncationMode(.middle)
                .fontWeight(bar.kind == .doing || bar.kind == .waiting ? .medium : .regular)
                .foregroundStyle(ink(bar.kind))
        }
        .padding(.leading, 4)
        .padding(.trailing, 8)
    }

    private func fill(_ kind: GoalChart.Bar.Kind) -> Color {
        switch kind {
        case .doing: accent.opacity(scheme == .dark ? 0.22 : 0.14)
        case .waiting: Color.orange.opacity(0.2)
        case .done: Color.primary.opacity(scheme == .dark ? 0.1 : 0.065)
        case .paused, .planned: Color.primary.opacity(scheme == .dark ? 0.065 : 0.045)
        case .skipped: Color.primary.opacity(0.03)
        }
    }

    private func foot(_ kind: GoalChart.Bar.Kind) -> Color {
        switch kind {
        case .doing: accent.opacity(0.35)
        case .waiting: Color.orange.opacity(0.8)
        case .done: Color.primary.opacity(scheme == .dark ? 0.32 : 0.24)
        case .paused, .planned: Color.primary.opacity(scheme == .dark ? 0.2 : 0.14)
        case .skipped: Color.primary.opacity(0.08)
        }
    }

    private func ink(_ kind: GoalChart.Bar.Kind) -> AnyShapeStyle {
        switch kind {
        case .doing, .waiting: AnyShapeStyle(.primary)
        case .skipped: AnyShapeStyle(.tertiary)
        default: AnyShapeStyle(.secondary)
        }
    }

    /// Under the pointer: the step's name in full, where it stands, and when it ran or is placed.
    private func help(_ bar: GoalChart.Bar) -> String {
        var lines = [bar.step.text]
        if let said = GoalPlanWords.state(of: bar.step, in: plan, now: now).text { lines.append(said) }
        if let when = times(bar) { lines.append(when) }
        return lines.joined(separator: "\n")
    }

    private func spoken(_ bar: GoalChart.Bar) -> String {
        [GoalPlanWords.spokenState(of: bar.step, in: plan, now: now), times(bar)].compactMap { $0 }.joined(separator: ", ")
    }

    /// "10:00 – 10:36", "Since 10:42", "Around 13:20" for one placed.
    private func times(_ bar: GoalChart.Bar) -> String? {
        guard let from = bar.from else { return nil }
        let time = { (date: Date) in GoalSteps.time(date, now: now) }
        if bar.isPlaced { return "Around \(time(from))" }
        if let to = bar.to, bar.kind == .done || bar.kind == .skipped { return "\(time(from)) – \(time(to))" }
        return "Since \(time(from))"
    }

    // MARK: What a step waits for

    /// Thin lines into the step you point at, from each step it waits for: down from under that
    /// one's end, then across to its start.
    private func links(into id: String, rows: [Placed], chart: GoalChart, x: ChartX) -> some View {
        let target = rows.first { $0.id == id }
        let sources = rows.filter { chart.waitsFor(id).contains($0.id) }
        return Canvas { context, _ in
            guard let target else { return }
            let into = Self.pill(target.bar, chart: chart, x: x, now: now)
            guard into.isOnAxis else { return }
            let start = into.start
            for source in sources {
                let from = Self.pill(source.bar, chart: chart, x: x, now: now)
                guard from.isOnAxis else { continue }
                let end = from.start + from.time
                let across = max(2, min(end - 3, start - 8))
                let top = source.mid + Self.barHeight / 2 + 1
                guard target.mid - 4 > top else { continue }
                var path = Path()
                path.move(to: CGPoint(x: across, y: top))
                path.addLine(to: CGPoint(x: across, y: target.mid - 4))
                path.addQuadCurve(to: CGPoint(x: across + 4, y: target.mid), control: CGPoint(x: across, y: target.mid))
                path.addLine(to: CGPoint(x: start, y: target.mid))
                context.stroke(path, with: .color(accent), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                context.fill(Path(ellipseIn: CGRect(x: across - 2, y: top - 2, width: 4, height: 4)), with: .color(accent))
            }
        }
        .frame(width: x.width, height: (rows.last?.y ?? 0) + Self.rowHeight)
    }

    // MARK: The grid and the axis

    /// The unit the axis counts in, for what shows of it.
    private func unit(_ chart: GoalChart) -> GoalTimeline.Unit { GoalTimeline.unit(for: chart.shown.duration) }

    /// The grid's lines: on each hour, or each day.
    private func lines(_ chart: GoalChart) -> [Date] {
        unit(chart) == .hour ? chart.ticks() : Self.days(in: chart.shown)
    }

    private func grid(_ chart: GoalChart, x: ChartX, height: CGFloat) -> some View {
        Canvas { context, _ in
            if isRunning, chart.shown.contains(now) {
                // What's past, faintly, up to now.
                let at = x(now)
                context.fill(Path(CGRect(x: 0, y: 0, width: at, height: height)), with: .color(.primary.opacity(0.025)))
                context.fill(Path(CGRect(x: at - 0.5, y: 0, width: 1, height: height)), with: .color(accent.opacity(0.25)))
            }
            for line in lines(chart) where chart.shown.contains(line) {
                context.fill(Path(CGRect(x: x(line) - 0.5, y: 0, width: 1, height: height)), with: .color(.primary.opacity(0.06)))
            }
        }
        .frame(width: x.width, height: height)
        .allowsHitTesting(false)
    }

    /// Over the rows: a few times, and the flags: Now (Today on a goal counted in days) in the
    /// accent, the due date in red with a short tick, when it's likely done in grey; the due date
    /// at the edge where it's past what shows. No label runs into a flag or off the edge.
    private func axis(_ chart: GoalChart, x: ChartX) -> some View {
        let hours = unit(chart) == .hour
        let showsNow = isRunning && chart.shown.contains(now)
        let nowX = x(now)
        let due = chart.due.flatMap { chart.shown.contains($0) ? $0 : nil }
        let edgeDue = Self.saysDueAtEdge(chart)
        let finish = chart.finish.flatMap { finish -> Date? in
            guard isRunning, chart.shown.contains(finish) else { return nil }
            // Where it would crowd Now or the due date, Now and the due date say enough.
            if abs(x(finish) - nowX) < 70 { return nil }
            if let due, abs(x(finish) - x(due)) < 80 { return nil }
            return finish
        }
        let flags = [showsNow ? nowX : nil, due.map { x($0) }, finish.map { x($0) }].compactMap { $0 }
        let marks = hours ? chart.ticks().filter(chart.shown.contains) : Self.days(in: chart.shown)
        let dayWidth = x.width * 86400 / max(1, chart.shown.duration)
        let hourWidth = marks.count > 1 ? x(marks[1]) - x(marks[0]) : x.width
        // A date's label takes 56 points on this axis; a day 52 wide has room for one of its own.
        let labeled = hours ? GoalChart.labeledHours(marks, hourWidth: hourWidth)
            : GoalChart.labeledDays(marks, dayWidth: dayWidth, week: chart.shown.duration <= 8 * 86400, now: now, room: 56, everyDay: 52)
        let rightRoom: CGFloat = edgeDue ? Self.edgeRoom + 12 : 18
        return ZStack(alignment: .topLeading) {
            ForEach(marks, id: \.self) { mark in
                // A day's label sits over its day; an hour's at its line.
                let at = hours ? x(mark) : x(mark.addingTimeInterval(43200))
                if labeled.contains(mark), at > 16, at < x.width - rightRoom, flags.allSatisfy({ abs($0 - at) >= 40 }) {
                    Text(hours ? mark.formatted(.dateTime.hour().minute()) : mark.formatted(chart.shown.duration <= 8 * 86400 ? .dateTime.weekday(.abbreviated).day() : .dateTime.month(.abbreviated).day()))
                        .font(.system(size: 10.5).monospacedDigit())
                        .foregroundStyle(.tertiary)
                        .fixedSize()
                        .position(x: at, y: 10)
                }
            }
            if let finish {
                flag("Done ~\(Self.when(finish, now: now, hours: hours))", ink: AnyShapeStyle(.secondary), rim: Color.primary.opacity(0.2), at: x(finish), width: x.width)
            }
            if let due {
                flag("Due \(Self.when(due, now: now, hours: hours))", ink: AnyShapeStyle(Color.red), rim: Color.red.opacity(0.55), at: x(due), width: x.width)
                Rectangle().fill(Color.red.opacity(0.7))
                    .frame(width: 1.5, height: 5)
                    .position(x: x(due), y: Self.axisHeight - 2.5)
            }
            if edgeDue, let deadline = chart.deadline {
                Text("Due \(Self.when(deadline, now: now, hours: false)) ›")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(.red)
                    .fixedSize()
                    .frame(width: x.width, height: 20, alignment: .trailing)
            }
            if showsNow {
                Text(hours ? now.formatted(.dateTime.hour().minute()) : "Today")
                    .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(accent))
                    .fixedSize()
                    .position(x: min(max(nowX, 22), x.width - 22), y: 10)
            }
        }
        .accessibilityHidden(true)
    }

    private func flag(_ title: String, ink: AnyShapeStyle, rim: Color, at: CGFloat, width: CGFloat) -> some View {
        Text(title)
            .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
            .foregroundStyle(ink)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Capsule().fill(Color(nsColor: .textBackgroundColor)))
            .overlay(Capsule().strokeBorder(rim, lineWidth: 1))
            .fixedSize()
            .position(x: min(max(at, 36), width - 36), y: 10)
    }

    /// A flag's time: "18:20" today on an axis of hours, "Fri 6" another day this week, "Fri 6 Nov"
    /// further off.
    static func when(_ date: Date, now: Date, hours: Bool) -> String {
        if hours && Calendar.current.isDate(date, inSameDayAs: now) { return date.formatted(.dateTime.hour().minute()) }
        return abs(date.timeIntervalSince(now)) > 6 * 86400
            ? date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
            : date.formatted(.dateTime.weekday(.abbreviated).day())
    }

    /// The room at the axis's right for "Due Fri 6 Nov ›".
    static let edgeRoom: CGFloat = 100

    /// The due date said at the right edge: days past the work, or past the days around now.
    static func saysDueAtEdge(_ chart: GoalChart) -> Bool {
        chart.isDuePastEdge || (chart.due.map { $0 > chart.shown.end } ?? false)
    }

    /// Whether the timeline says when the goal is due, on its axis or at its edge, as it first
    /// opens: where it doesn't (none, or overdue before the days it shows), the bar's line does.
    static func saysDue(_ chart: GoalChart) -> Bool {
        saysDueAtEdge(chart) || (chart.due.map(chart.shown.contains) ?? false)
    }

    /// The axis to VoiceOver, which can't see its flags: "Due Fri 6 Nov, likely done Thu 5".
    private func spokenAxis(_ chart: GoalChart) -> String {
        var said: [String] = []
        if let deadline = chart.deadline, isRunning { said.append("\(deadline < now ? "Was due" : "Due") \(Self.when(deadline, now: now, hours: true))") }
        if let finish = chart.finish, isRunning { said.append("likely done \(Self.when(finish, now: now, hours: true))") }
        return said.joined(separator: ", ")
    }

    /// The days that start within `shown`, each at its start.
    static func days(in shown: DateInterval) -> [Date] {
        let calendar = Calendar.current
        var day = calendar.startOfDay(for: shown.start)
        var days: [Date] = []
        while day < shown.end, days.count < 400 {
            days.append(day)
            day = calendar.date(byAdding: .day, value: 1, to: day) ?? shown.end
        }
        return days
    }
}

/// Where a time falls across the chart, `width` wide, showing `shown` of the goal.
struct ChartX {
    let shown: DateInterval
    let width: CGFloat
    /// Room kept at the right that no time reaches: for the names that run past their steps' time,
    /// and the due date said past the edge, so no flag or bar runs into it.
    var kept: CGFloat = 0

    func callAsFunction(_ date: Date) -> CGFloat {
        guard shown.duration > 0 else { return 0 }
        return CGFloat(date.timeIntervalSince(shown.start) / shown.duration) * max(0, width - kept)
    }
}

/// ⌘-scroll over a long goal's timeline: down for the whole goal, up for the days around today.
@MainActor final class ZoomKeys {
    var hovering = false
    private var monitor: Any?

    func start(_ zoomedOut: Binding<Bool>) {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            let command = event.modifierFlags.contains(.command), delta = event.scrollingDeltaY
            let taken = MainActor.assumeIsolated { () -> Bool in
                guard let self, self.hovering, command, abs(delta) > 0.5 else { return false }
                let out = delta < 0
                if zoomedOut.wrappedValue != out { withAnimation(.ui) { zoomedOut.wrappedValue = out } }
                return true
            }
            return taken ? nil : event
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }
}
