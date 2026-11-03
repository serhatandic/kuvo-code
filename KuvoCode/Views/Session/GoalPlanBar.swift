import AppKit
import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI

/// A bot's goal under way, in the goal bar's place over its composer: the line names the goal in a
/// few words, how many steps are done and for how long (paused, why, in a word), with its one
/// action, Pause, or Resume once paused; folded, a short track for each step. Open, the goal in
/// full and its steps as rows you read top to bottom (`GoalSteps`), each with its bar on one time
/// axis where the card has room; then what waits for you, each with its button, when it's likely
/// done and due, and Stop, which asks first. Once it's over, ✕ puts it away.
struct GoalPlanBar: View {
    let plan: GoalPlan
    let box: String
    /// The conversation's own goal, which keeps the bot at it: Pause and Resume are its.
    let goal: Goal?
    @Binding var isHidden: Bool
    var isChanging = false
    let pause: () -> Void
    let resume: () -> Void
    let putAway: () -> Void
    let failed: (String) -> Void
    @Environment(AppModel.self) private var app
    @State private var confirmsStop = false
    @State private var showsDone = false
    @State private var showsLater = false

    private var isOver: Bool { plan.state == .done || plan.state == .stopped }
    private var isPaused: Bool { plan.state == .running && goal?.state == .paused }
    /// Paused by its computer (a turn failed, the agent stopped making progress): it needs you.
    private var needsYou: Bool { isPaused && (goal?.pausedBy == .error || goal?.pausedBy == .stalled) }
    private var isBusy: Bool { isChanging || app.goalPlans.answering.contains(plan.id) }

    var body: some View {
        // Kept current while it runs: how long it has been at it, and now on the axis. Once
        // it's over, it stays as it ended.
        TimelineView(.periodic(from: .now, by: isOver ? 365 * 86400 : 30)) { context in
            let now = isOver ? plan.ended.map { Date(timeIntervalSince1970: $0 / 1000) } ?? context.date : context.date
            VStack(alignment: .leading, spacing: 0) {
                BarLine(mark: AnyView(mark), title: GoalPlanWords.name(plan), progress: progress(now: now), status: status,
                        accessory: AnyView(actions), folded: AnyView(strip), showHelp: "Show the goal’s steps", hideHelp: "Hide them: this line stays",
                        isHidden: $isHidden, close: isOver ? putAway : nil, closeHelp: "Put the goal away", stacks: true)
                if !isHidden {
                    details(now: now)
                        .padding(.leading, 14)
                        .padding(.trailing, 16)
                        .padding(.top, 2)
                        .padding(.bottom, 12)
                        .transition(.fold)
                }
            }
        }
        .animation(.ui, value: plan.state)
        .closesWhenKept($confirmsStop)
        .confirmationDialog("Stop the goal?", isPresented: $confirmsStop) {
            Button("Stop the Goal", role: .destructive) {
                guard plan.state == .running else { return }
                Task {
                    do { try await app.goalPlans.answer(plan, on: box, .stop) } catch { failed(error.localizedDescription) }
                }
            }
        } message: {
            Text("\(plan.name) stops working on it, and its sessions for it end. What’s done stays.")
        }
        .onChange(of: plan.state) { _, state in
            if state != .running { confirmsStop = false }
        }
    }

    // MARK: The line

    @ViewBuilder private var mark: some View {
        switch plan.state {
        case .done:
            Image(systemName: "checkmark.circle.fill").font(.system(size: 13)).foregroundStyle(.green)
        case .stopped, .declined:
            Image(systemName: "stop.circle.fill").font(.system(size: 13)).foregroundStyle(.secondary)
        case .running where needsYou:
            Image(systemName: "exclamationmark.circle.fill").font(.system(size: 13)).foregroundStyle(.orange)
        case .running where isPaused:
            Image(systemName: "pause.circle.fill").font(.system(size: 13)).foregroundStyle(.secondary)
        case .running where GoalPlanWords.next(plan) != nil:
            Image(systemName: "clock.fill").font(.system(size: 13)).foregroundStyle(.secondary)
        default:
            Image(systemName: "scope").font(.system(size: 13)).foregroundStyle(.tint)
        }
    }

    /// "2 of 6 · 2 h 22 min", "2 of 6 · Next: Mon 09:00", "Paused · You", "Done · 3 days".
    private func progress(now: Date) -> String {
        GoalPlanWords.line(plan, pausedBy: isPaused ? .some(goal?.pausedBy) : nil, now: now)
    }

    /// Paused, why in a word, stronger: orange where it needs you.
    private var status: Text? {
        guard isPaused else { return nil }
        guard let by = goal?.pausedBy else { return Text("Paused") }
        return Text("Paused · ") + Text(GoalPlanWords.pausedBy(by)).fontWeight(.semibold).foregroundStyle(needsYou ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary))
    }

    /// A short track for each step, while the steps are hidden.
    private var strip: some View {
        let count = max(1, plan.steps.count)
        return GoalTrackStrip(plan.steps.map { (GoalSteps.track($0.state), $0.progress) }, width: count <= 8 ? 14 : max(4, 112 / CGFloat(count)))
            .padding(.horizontal, 2)
    }

    /// The line's one action, a chip: Pause, or Resume once paused. Stop is under it, with the steps.
    @ViewBuilder private var actions: some View {
        if plan.state == .running, let goal {
            Group {
                if goal.state == .working {
                    Button("Pause", action: pause)
                        .buttonStyle(ChipButtonStyle())
                        .help("Stop the turn under way and hold the goal until you resume it")
                } else if goal.state == .paused {
                    Button("Resume", action: resume)
                        .buttonStyle(ChipButtonStyle(tinted: true))
                        .help("Carry on with the plan")
                }
            }
            .font(.system(size: 12, weight: .medium))
            .disabled(isBusy)
        }
    }

    // MARK: Under the line

    private func details(now: Date) -> some View {
        let timeline = GoalTimeline(plan, now: now)
        return VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                // The goal in full: the line has only its name.
                Text(plan.goal)
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if needsYou, let note = goal?.note {
                    Label(note, systemImage: "exclamationmark.circle")
                        .font(.system(size: 12.5))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.leading, GoalSteps.nameInset)
            GoalSteps(plan: plan, timeline: timeline, showsDone: $showsDone, showsLater: $showsLater)
            if !plan.waiting.isEmpty {
                VStack(spacing: 4) {
                    ForEach(plan.waiting) { item in waitingRow(item, now: now) }
                }
                .padding(.leading, GoalSteps.nameInset - 24)
            }
            foot(timeline)
            if isOver, let report = plan.report {
                Text(report)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, GoalSteps.nameInset)
            }
        }
    }

    /// When it's likely done and due, and Stop while it runs.
    @ViewBuilder private func foot(_ timeline: GoalTimeline) -> some View {
        let finish = isOver ? nil : GoalPlanWords.finish(timeline)
        if finish != nil || plan.state == .running {
            HStack(spacing: 10) {
                if let finish {
                    Text(finish)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(finish)
                }
                Spacer(minLength: 8)
                if plan.state == .running {
                    Button("Stop Goal…") { confirmsStop = true }
                        .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
                        .foregroundStyle(.red)
                        .font(.system(size: 12))
                        .fixedSize()
                        .disabled(isBusy)
                        .help("End the goal: \(plan.name) stops working on it")
                }
            }
            .padding(.leading, GoalSteps.nameInset)
            .padding(.top, 6)
            .overlay(alignment: .top) {
                Rectangle().fill(.separator).frame(height: 1).padding(.leading, GoalSteps.nameInset)
            }
        }
    }

    private func waitingRow(_ item: GoalPlan.Waiting, now: Date) -> some View {
        let since = Date(timeIntervalSince1970: item.at / 1000)
        let button: (String, () -> Void)?
        if let url = item.url {
            button = (item.site.map { "Open \(GoalPlanWords.service($0))" } ?? "Open", { NSWorkspace.shared.open(url) })
        } else if let session = item.session {
            button = ("Open", { app.tabs.open(.session(session)) })
        } else {
            button = nil
        }
        return YoursRow(text: item.text, detail: item.detail, aside: "since \(GoalSteps.time(since, now: now))", site: item.site, button: button) {
            Task {
                do { try await app.goalPlans.answer(plan, on: box, .clear(waiting: item.id)) } catch { failed(error.localizedDescription) }
            }
        }
        .disabled(isBusy)
    }
}

/// A goal's steps as rows you read top to bottom (`GoalTimeline.list`): each step's state, its
/// name with the service's mark and where it stands in a few words; the steps done, and many for
/// later, folded to a row each; phases heading their steps. Where the card has room, each row has
/// its bar on one time axis across them, from when the step began to when it ended (or now),
/// with now, the deadline and a dashed likely end where it was measured. A long goal's axis shows
/// the days around today; pinch or ⌘-scroll shows the whole goal. Narrow, it's the list alone.
struct GoalSteps: View {
    let plan: GoalPlan
    let timeline: GoalTimeline
    @Binding var showsDone: Bool
    @Binding var showsLater: Bool
    @Environment(\.accent) private var accent
    /// The whole goal on the axis, rather than the days around today.
    @State private var zoomedOut = false
    /// Whether the card has room for the tracks (and so their axis), as last measured.
    @State private var hasTracks = true
    @State private var zoomKeys = ZoomKeys()

    typealias Row = GoalTimeline.Row

    static let rowHeight: CGFloat = 28
    static let phaseHeight: CGFloat = 24
    static let axisHeight: CGFloat = 18
    /// The state's mark, and the gap after it: names line up with the bar's title.
    static let markWidth: CGFloat = 18
    static let nameInset: CGFloat = markWidth + 10
    /// Narrower than this, the tracks go: rows alone (the pointer and VoiceOver still say when).
    static let tracksFrom: CGFloat = 460
    /// The most the rows take before they scroll: about ten.
    static let mostHeight: CGFloat = 10 * rowHeight

    private var now: Date { timeline.now }
    private var isRunning: Bool { plan.state == .running }

    static func height(_ row: Row) -> CGFloat {
        if case .phase = row { return phaseHeight }
        return rowHeight
    }

    var body: some View {
        let rows = timeline.list(showsDone: showsDone, showsLater: showsLater)
        let long = timeline.window() != nil
        let rowsHeight = rows.reduce(0) { $0 + Self.height($1) }
        // Many rows (a fold opened on a long goal) scroll under the axis, so the card doesn't
        // take over the conversation.
        let shownHeight = min(rowsHeight, Self.mostHeight)
        // Tracks only with steps to draw, and where the card has room: one value for what's drawn
        // and the room it takes, so neither is a pass behind.
        let tracks = hasTracks && !rows.isEmpty
        GeometryReader { measured in
            let trackWidth = tracks ? (measured.size.width * 0.42).rounded() : 0
            let x = AxisX(shown: timeline.shown(whole: zoomedOut), width: trackWidth)
            VStack(alignment: .leading, spacing: 0) {
                if tracks {
                    HStack(spacing: 0) {
                        Spacer(minLength: 0)
                        axisLabels(x: x).frame(width: trackWidth, height: Self.axisHeight)
                    }
                }
                ScrollView(.vertical) {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(rows) { row in
                                name(row, tracks: tracks)
                                    .frame(height: Self.height(row))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if tracks {
                            lanes(rows, x: x, height: rowsHeight)
                                .frame(width: trackWidth, height: rowsHeight)
                                .clipped()
                                .accessibilityHidden(true)
                        }
                    }
                    .frame(height: rowsHeight)
                }
                .scrollDisabled(rowsHeight <= Self.mostHeight)
                .scrollIndicators(rowsHeight > Self.mostHeight ? .automatic : .never)
                // The edge with more past it fades, so a row cut there reads as more to scroll to.
                .fadingScrollEdges(20)
                .frame(height: shownHeight)
            }
        }
        .frame(height: shownHeight + (tracks ? Self.axisHeight : 0))
        .onGeometryChange(for: Bool.self, of: { $0.size.width >= Self.tracksFrom }) { hasTracks = $0 }
        .font(.system(size: 13))
        // Pinch, or ⌘-scroll, for the whole goal and back.
        .gesture(MagnifyGesture().onEnded { value in
            guard long else { return }
            if value.magnification < 0.9, !zoomedOut { withAnimation(.ui) { zoomedOut = true } }
            if value.magnification > 1.1, zoomedOut { withAnimation(.ui) { zoomedOut = false } }
        })
        .onHover { zoomKeys.hovering = $0 }
        .onChange(of: long, initial: true) { _, isLong in
            if isLong { zoomKeys.start($zoomedOut) } else { zoomKeys.stop() }
        }
        .onDisappear { zoomKeys.stop() }
        .accessibilityElement(children: .contain)
        .accessibilityActions {
            if long {
                Button(zoomedOut ? "Show the Days Around Today" : "Show the Whole Goal") { zoomedOut.toggle() }
            }
        }
    }

    // MARK: The rows

    @ViewBuilder private func name(_ row: Row, tracks: Bool) -> some View {
        switch row {
        case .phase(let phase):
            Text(phase.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.4)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .padding(.leading, Self.nameInset)
                .frame(maxHeight: .infinity, alignment: .bottom)
                .padding(.bottom, 4)
                .accessibilityAddTraits(.isHeader)
        case .done(let lanes):
            fold("\(lanes.count) done", shows: $showsDone, mark: AnyView(GoalStepMark(.done)), what: "steps that are done", spoken: lanes.count == 1 ? "1 step done" : "\(lanes.count) steps done")
        case .later(let lanes):
            fold("\(lanes.count) later", shows: $showsLater, mark: AnyView(GoalStepMark(.todo)), what: "steps for later", spoken: lanes.count == 1 ? "1 step for later" : "\(lanes.count) steps for later")
        case .lane(let lane):
            let step = lane.step
            let state = GoalPlanWords.shownState(of: step, in: plan)
            let said = GoalPlanWords.state(of: step, in: plan, now: now)
            HStack(spacing: 10) {
                GoalStepMark(GoalSteps.track(state), progress: step.progress)
                    .frame(width: Self.markWidth)
                HStack(spacing: 5) {
                    if let site = step.site { SiteServiceMark(site: site) }
                    // Cut in the middle: steps named alike ("…(3 of 9)") still differ.
                    Text(step.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .foregroundStyle(ink(state))
                }
                .layoutPriority(1)
                Spacer(minLength: 6)
                if let words = said.text {
                    // A few words, always whole: the name gives way to them.
                    Text(words)
                        .font(.system(size: 12, weight: said.tone == .needsYou ? .semibold : .regular).monospacedDigit())
                        .foregroundStyle(tone(said.tone))
                        .lineLimit(1)
                        .fixedSize()
                        .layoutPriority(2)
                }
            }
            .contentShape(.rect)
            .help(help(step, said: said.text, tracks: tracks))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(step.text)
            .accessibilityValue(GoalPlanWords.spokenState(of: step, in: plan, now: now))
        }
    }

    /// Under the pointer: the step's name in full, where it stands, and when it ran where the
    /// tracks aren't there to show it.
    private func help(_ step: GoalPlan.Step, said: String?, tracks: Bool) -> String {
        var lines = [step.text]
        if let said { lines.append(said) }
        if !tracks, let began = step.began.map({ Date(timeIntervalSince1970: $0 / 1000) }) {
            lines.append(step.ended.map { "\(Self.time(began, now: now)) – \(Self.time(Date(timeIntervalSince1970: $0 / 1000), now: now))" } ?? "Since \(Self.time(began, now: now))")
        }
        return lines.joined(separator: "\n")
    }

    /// A fold's row, which opens its steps and folds them again.
    private func fold(_ title: String, shows: Binding<Bool>, mark: AnyView, what: String, spoken: String) -> some View {
        Button {
            withAnimation(.ui) { shows.wrappedValue.toggle() }
        } label: {
            HStack(spacing: 10) {
                mark.frame(width: Self.markWidth)
                HStack(spacing: 4) {
                    Text(title)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(shows.wrappedValue ? 90 : 0))
                }
                .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .help(shows.wrappedValue ? "Fold the \(what)" : "Show the \(what)")
        .accessibilityLabel(spoken)
        .accessibilityValue(shows.wrappedValue ? "Shown" : "Hidden")
    }

    private func ink(_ state: GoalPlan.Step.State) -> AnyShapeStyle {
        switch state {
        case .done, .skipped, .todo: AnyShapeStyle(.secondary)
        default: AnyShapeStyle(.primary)
        }
    }

    private func tone(_ tone: GoalPlanWords.Said.Tone) -> AnyShapeStyle {
        switch tone {
        case .needsYou: AnyShapeStyle(Color.orange)
        case .plain: AnyShapeStyle(.secondary)
        case .quiet: AnyShapeStyle(.tertiary)
        }
    }

    // MARK: The tracks

    /// Each row's bar, and across them all the deadline and now.
    private func lanes(_ rows: [Row], x: AxisX, height: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                ForEach(rows) { row in
                    track(row, x: x)
                        .frame(width: x.width, height: Self.height(row), alignment: .leading)
                }
            }
            Canvas { context, _ in
                if let deadline = timeline.deadline, x.shows(deadline) {
                    context.stroke(Self.line(x(deadline), height), with: .color(.red.opacity(0.7)), lineWidth: 1.5)
                }
                if isRunning, x.shows(now) {
                    context.stroke(Self.line(x(now), height), with: .color(accent.opacity(0.75)), lineWidth: 1.5)
                }
            }
            .allowsHitTesting(false)
        }
    }

    private static func line(_ x: CGFloat, _ height: CGFloat) -> Path {
        Path { path in
            path.move(to: CGPoint(x: x, y: 0))
            path.addLine(to: CGPoint(x: x, y: height))
        }
    }

    @ViewBuilder private func track(_ row: Row, x: AxisX) -> some View {
        let lanes = timeline.lanes
        ZStack(alignment: .leading) {
            // The line each bar runs along.
            Dashes()
                .stroke(Color.primary.opacity(0.08), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                .frame(height: 1)
            switch row {
            case .phase:
                EmptyView()
            case .done(let steps):
                if let from = steps.compactMap(\.from).min(), let to = steps.compactMap(\.to).max() {
                    span(GoalTrack(.done, height: 6).opacity(showsDone ? 0.4 : 1), from: from, to: to, x: x)
                }
            case .later(let steps):
                let from = steps.compactMap { startsAround($0.step, lanes: lanes) }.min() ?? now
                let end = (lanes.compactMap(\.likelyEnd) + [timeline.deadline ?? timeline.end]).max() ?? now
                span(Hatched().frame(height: 7), from: from, to: max(end, from), x: x)
            case .lane(let lane):
                laneBar(lane, lanes: lanes, x: x)
            }
        }
    }

    /// Something drawn from one time to another along the axis, at least a dot's width.
    private func span(_ content: some View, from: Date, to: Date, x: AxisX) -> some View {
        content
            .frame(width: max(6, x(to) - x(from)))
            .offset(x: x(from))
    }

    @ViewBuilder private func laneBar(_ lane: GoalTimeline.Lane, lanes: [GoalTimeline.Lane], x: AxisX) -> some View {
        let step = lane.step
        let state = GoalPlanWords.shownState(of: step, in: plan)
        if let from = lane.from {
            let to = lane.to ?? now
            span(GoalTrack(Self.track(state), progress: step.progress == nil ? nil : 1, height: 6), from: from, to: to, x: x)
            if state == .paused {
                // Paused at a limit: grey, until it goes on.
                if let resumes = step.resumesDate, resumes > to {
                    Dashes()
                        .stroke(Color.primary.opacity(0.3), style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                        .frame(width: max(0, x(resumes) - x(to) - 2), height: 2)
                        .offset(x: x(to) + 2)
                }
            } else if let likely = lane.likelyEnd, likely > to {
                // Where it's likely to end, only where it was measured.
                Dashes()
                    .stroke(accent.opacity(0.75), style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                    .frame(width: max(0, x(likely) - x(to) - 2), height: 2)
                    .offset(x: x(to) + 2)
            }
        } else if state == .todo, let at = startsAround(step, lanes: lanes) {
            GoalTrack(.todo, height: 6)
                .frame(width: 22)
                .overlay(Capsule().strokeBorder(Color.primary.opacity(0.18), lineWidth: 1))
                .offset(x: x(at))
        }
    }

    /// Where a step not begun is likely to start: once the steps it waits for are likely done.
    /// Nil while one of those hasn't begun either, which can't say.
    private func startsAround(_ step: GoalPlan.Step, lanes: [GoalTimeline.Lane]) -> Date? {
        let before = lanes.filter { step.after.contains($0.id) }
        guard !before.isEmpty, before.allSatisfy({ $0.from != nil }) else { return nil }
        let ends = before.map { $0.likelyEnd ?? $0.to ?? now }
        return max(now, ends.max() ?? now)
    }

    /// Over the tracks: a few times along the axis, and now (Today, on a goal counted in days) in
    /// the accent, with no label running into it or off the edge.
    private func axisLabels(x: AxisX) -> some View {
        let hours = timeline.unit == .hour && x.shown.duration <= 36 * 3600
        let marks = hours ? timeline.ticks().filter(x.shows) : Self.days(in: x.shown)
        let dayWidth = x.width * 86400 / max(1, x.shown.duration)
        let labeled = hours ? Set(marks) : Self.labeledDays(marks, dayWidth: dayWidth, week: x.shown.duration <= 8 * 86400, now: now)
        let nowX = x(now)
        let showsNow = isRunning && x.shows(now)
        return ZStack(alignment: .topLeading) {
            ForEach(marks, id: \.self) { mark in
                // A day's label sits over its day; an hour's at its line.
                let at = hours ? x(mark) : x(mark.addingTimeInterval(43200))
                if labeled.contains(mark), at > 14, at < x.width - 14, !(showsNow && abs(at - nowX) < 40),
                   hours || !(showsNow && Calendar.current.isDate(mark, inSameDayAs: now)) {
                    Text(hours ? mark.formatted(.dateTime.hour().minute()) : mark.formatted(x.shown.duration <= 8 * 86400 ? .dateTime.weekday(.abbreviated) : .dateTime.month(.abbreviated).day()))
                        .font(.system(size: 10.5).monospacedDigit())
                        .foregroundStyle(.tertiary)
                        .fixedSize()
                        .position(x: at, y: Self.axisHeight / 2)
                }
            }
            if showsNow {
                Text(hours ? "Now" : "Today")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(accent)
                    .fixedSize()
                    .position(x: min(max(nowX, 18), x.width - 18), y: Self.axisHeight / 2)
            }
        }
        .frame(width: x.width, height: Self.axisHeight, alignment: .topLeading)
        .accessibilityHidden(true)
    }

    /// The days that start within `shown`, each at its start.
    private static func days(in shown: DateInterval) -> [Date] {
        let calendar = Calendar.current
        var day = calendar.startOfDay(for: shown.start)
        var days: [Date] = []
        while day < shown.end, days.count < 400 {
            days.append(day)
            day = calendar.date(byAdding: .day, value: 1, to: day) ?? shown.end
        }
        return days
    }

    /// The days that get a label of their own: every day across a week or where each has room for
    /// its date; else one every few days, counted out from Today (or the first day) so the labels
    /// keep clear of it and of each other, and a week apart once that's most of a week.
    static func labeledDays(_ days: [Date], dayWidth: CGFloat, week: Bool, now: Date, calendar: Calendar = .current) -> Set<Date> {
        let fit = dayWidth > 0 ? Int((56 / dayWidth).rounded(.up)) : 7
        let step = week || dayWidth >= 52 ? 1 : fit >= 5 ? 7 * Int((Double(fit) / 7).rounded(.up)) : max(fit, 1)
        let origin = calendar.startOfDay(for: days.contains { calendar.isDate($0, inSameDayAs: now) } ? now : days.first ?? now)
        return Set(days.filter { day in
            (calendar.dateComponents([.day], from: origin, to: calendar.startOfDay(for: day)).day ?? 1) % step == 0
        })
    }

    // MARK: Words

    static func track(_ state: GoalPlan.Step.State) -> GoalTrack.State {
        switch state {
        case .todo: .todo
        case .doing: .running
        case .done: .done
        case .waiting: .waiting
        case .paused: .paused
        case .skipped: .skipped
        }
    }

    /// A time as it reads beside a step: "15:20" today, "Nov 3, 15:20" another day.
    static func time(_ date: Date, now: Date) -> String {
        Calendar.current.isDate(date, inSameDayAs: now)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}

/// ⌘-scroll over a long goal's steps: down for the whole goal, up for the days around today.
@MainActor private final class ZoomKeys {
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

/// A short bar for what's later: an outline, hatched.
private struct Hatched: View {
    var body: some View {
        Canvas { context, size in
            var path = Path()
            var x: CGFloat = -size.height
            while x < size.width + size.height {
                path.move(to: CGPoint(x: x, y: size.height))
                path.addLine(to: CGPoint(x: x + size.height, y: 0))
                x += 4
            }
            context.clip(to: Path(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: size.height / 2))
            context.stroke(path, with: .color(.primary.opacity(0.22)), lineWidth: 1)
        }
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.28), lineWidth: 1))
    }
}

/// Where a time falls across the tracks, `width` wide, showing `shown` of the goal (what's
/// outside it is cut at the edges).
private struct AxisX {
    let shown: DateInterval
    let width: CGFloat

    func callAsFunction(_ date: Date) -> CGFloat {
        guard shown.duration > 0 else { return 0 }
        return 3 + CGFloat(date.timeIntervalSince(shown.start) / shown.duration) * (width - 6)
    }

    func shows(_ date: Date) -> Bool { shown.contains(date) }
}

/// A line along the middle, for dashes.
nonisolated private struct Dashes: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        }
    }
}
