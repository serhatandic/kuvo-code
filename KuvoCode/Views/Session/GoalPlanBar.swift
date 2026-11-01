import AppKit
import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI

/// A bot's goal under way, in the goal bar's place over its composer: the line says it's working
/// toward a goal, how many steps are done and for how long, with Stop (Pause and Resume while the
/// conversation keeps the goal); folded, a short track for each step. Open, each step is a lane on
/// one time axis, whatever the goal's length (hours, days or weeks along it): when it ran, where it's
/// likely to end where that's measured, now, the finish and the deadline; then what waits for
/// you, each with its button. Once it's over, ✕ puts it away.
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

    private var isOver: Bool { plan.state == .done || plan.state == .stopped }
    private var isPaused: Bool { plan.state == .running && goal?.state == .paused }
    private var isBusy: Bool { isChanging || app.goalPlans.answering.contains(plan.id) }

    var body: some View {
        // Kept current while it runs: how long it has been at it, and now on the axis. Once
        // it's over, it stays as it ended.
        TimelineView(.periodic(from: .now, by: isOver ? 365 * 86400 : 30)) { context in
            VStack(alignment: .leading, spacing: 0) {
                BarLine(mark: AnyView(mark), title: title, progress: progress(now: context.date), detail: Text(plan.title ?? plan.goal),
                        accessory: AnyView(actions), folded: AnyView(strip), showHelp: "Show each step on the plan’s time line", hideHelp: "Hide them: this line stays",
                        isHidden: $isHidden, close: isOver ? putAway : nil, closeHelp: "Put the goal away")
                if !isHidden {
                    VStack(alignment: .leading, spacing: 10) {
                        // A goal that's over, as it was when it ended.
                        GoalLanes(plan: plan, now: isOver ? plan.ended.map { Date(timeIntervalSince1970: $0 / 1000) } ?? context.date : context.date, showsDone: $showsDone)
                        if !plan.waiting.isEmpty {
                            VStack(spacing: 4) {
                                ForEach(plan.waiting) { item in waitingRow(item, now: context.date) }
                            }
                        }
                        if plan.state == .running {
                            Button("Stop the Goal…") { confirmsStop = true }
                                .buttonStyle(TextButtonStyle(outset: true))
                                .font(.system(size: 13))
                                .disabled(isBusy)
                                .help("End the goal: \(plan.name) stops working on it")
                        }
                        if isOver, let report = plan.report {
                            Text(report)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.leading, 42)
                    .padding(.trailing, 16)
                    .padding(.top, 2)
                    .padding(.bottom, 12)
                    .transition(.fold)
                }
            }
        }
        .animation(.ui, value: plan.state)
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
        case .running where isPaused:
            Image(systemName: "pause.circle.fill").font(.system(size: 13)).foregroundStyle(.secondary)
        case .running where GoalPlanWords.next(plan) != nil:
            Image(systemName: "clock.fill").font(.system(size: 13)).foregroundStyle(.secondary)
        default:
            Image(systemName: "scope").font(.system(size: 13)).foregroundStyle(.tint)
        }
    }

    private var title: String {
        switch plan.state {
        case .done: "Goal met"
        case .stopped, .declined: "Goal stopped"
        case .running where isPaused: "Goal paused"
        default: GoalPlanWords.next(plan) ?? "Working toward a goal"
        }
    }

    /// "2 of 6 · 2 h 22 min".
    private func progress(now: Date) -> String {
        guard let started = plan.started else { return GoalPlanWords.progress(plan) }
        let end = plan.ended.map { Date(timeIntervalSince1970: $0 / 1000) } ?? now
        let from = Date(timeIntervalSince1970: started / 1000)
        // A long goal counts its days.
        let days = Int(end.timeIntervalSince(from) / 86400)
        return "\(GoalPlanWords.progress(plan)) · \(days >= 2 ? "\(days) days" : GoalBar.duration(from: from, to: end))"
    }

    /// A short track for each step, while the lanes are hidden.
    private var strip: some View {
        let count = max(1, plan.steps.count)
        return GoalTrackStrip(plan.steps.map { (GoalLanes.track($0.state), $0.progress) }, width: count <= 8 ? 14 : max(4, 112 / CGFloat(count)))
            .padding(.horizontal, 2)
    }

    /// The line's one action: Pause, or Resume once paused. Stop is under it, with the plan.
    private var actions: some View {
        Group {
            if plan.state == .running {
                if let goal, goal.state == .working {
                    Button("Pause", action: pause)
                        .help("Stop the turn under way and hold the goal until you resume it")
                } else if let goal, goal.state == .paused {
                    Button("Resume", action: resume)
                        .help("Carry on with the plan")
                }
            }
        }
        .buttonStyle(TextButtonStyle())
        .font(.system(size: 13))
        .disabled(isBusy)
    }

    // MARK: What waits for you

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
        return YoursRow(text: item.text, detail: item.detail, aside: "since \(GoalLanes.time(since, now: now))", site: item.site, button: button) {
            Task {
                do { try await app.goalPlans.answer(plan, on: box, .clear(waiting: item.id)) } catch { failed(error.localizedDescription) }
            }
        }
        .disabled(isBusy)
    }
}

/// A goal's steps on one time axis, a lane each (`GoalTimeline`), whatever its length: its name
/// with the service's mark, its bar from when it began to when it ended (or now) coloured as its
/// track, a dashed likely end only where it was measured, and what it's at in words; now, the
/// finish and the deadline across them. A few hours show whole, in hours. A week or a month opens
/// on the days around today (today shaded), with the steps done and those for later folded to
/// short bars at its edges, a chip that scrolls to a deadline out of sight, and the rest a scroll
/// away; pinch or ⌘-scroll shows the whole goal. Phases head their steps; a fold opens its steps.
struct GoalLanes: View {
    let plan: GoalPlan
    let now: Date
    @Binding var showsDone: Bool
    @Environment(\.accent) private var accent
    @State private var showsLater = false
    /// The whole goal, rather than the days around today.
    @State private var zoomedOut = false
    @State private var position = ScrollPosition(edge: .leading)
    /// What of the axis shows, in its own points.
    @State private var visible: CGRect = .zero
    @State private var zoomKeys = ZoomKeys()

    typealias Row = GoalTimeline.Row

    static let headerHeight: CGFloat = 22
    static let laneHeight: CGFloat = 26
    static let phaseHeight: CGFloat = 20
    static let footerHeight: CGFloat = 20
    /// Under the lanes of a goal that scrolls, for its bar.
    static let scrollRoom: CGFloat = 10
    static let chipHeight: CGFloat = 28
    static let wordsWidth: CGFloat = 186
    /// Narrower than this, the words beside the lanes go (VoiceOver and the pointer still have them).
    static let wordsFrom: CGFloat = 520

    /// Scrolled by you (or to the deadline): resizing keeps where it is.
    @State private var moved = false

    static func height(_ row: Row) -> CGFloat {
        if case .phase = row { return phaseHeight }
        return laneHeight
    }

    var body: some View {
        let timeline = GoalTimeline(plan, now: now)
        // A long goal: one that opens on the days around now.
        let opens = timeline.window()
        let long = opens != nil
        let window = zoomedOut ? nil : opens
        let rows = timeline.rows(showsDone: showsDone, showsLater: showsLater)
        // A long goal's deadline has its chip; its finish, its line here.
        let footer = timeline.finish != nil || (window == nil && timeline.deadline != nil)
        let lanesHeight = rows.reduce(0) { $0 + Self.height($1) }
        // Only the days around now scroll; a goal shown whole fits.
        let height = Self.headerHeight + lanesHeight + (footer ? Self.footerHeight : 0) + (window != nil ? Self.scrollRoom : 0)
        let chip = window != nil && timeline.deadline != nil
        // As wide as the room, measured in the same pass, so it opens where it should.
        GeometryReader { measured in
            lanes(timeline, window: window, long: long, rows: rows, footer: footer, lanesHeight: lanesHeight, height: height, total: measured.size.width)
        }
        .frame(height: height + (chip ? Self.chipHeight + 2 : 0))
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

    private func lanes(_ timeline: GoalTimeline, window: DateInterval?, long: Bool, rows: [Row], footer: Bool, lanesHeight: CGFloat, height: CGFloat, total: CGFloat) -> some View {
        let showsWords = total >= Self.wordsFrom
        let nameWidth: CGFloat = total < 420 ? 84 : 112
        let room = max(40, total - nameWidth - 12 - (showsWords ? Self.wordsWidth + 12 : 0))
        let width = Self.width(timeline, window: window, room: room)
        let x = AxisX(timeline: timeline, width: width)
        let scrolls = width > room + 1
        return VStack(alignment: .trailing, spacing: 2) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 0) {
                    Color.clear.frame(height: Self.headerHeight)
                    ForEach(rows) { row in name(row, words: !showsWords).frame(height: Self.height(row)) }
                }
                .frame(width: nameWidth, alignment: .leading)
                ScrollView(.horizontal) {
                    axis(timeline, window: window, rows: rows, x: x, height: height, lanesHeight: lanesHeight, footer: footer)
                }
                .scrollPosition($position)
                .scrollIndicators(.never)
                .overlay(alignment: .bottomLeading) {
                    if scrolls { indicator(content: width, room: room) }
                }
                .scrollDisabled(!scrolls)
                .onScrollGeometryChange(for: CGRect.self, of: { $0.visibleRect }) { _, rect in visible = rect }
                // Opens on the days around now (and back there from the whole goal), and keeps
                // them in view as the window's resized, until you scroll it yourself.
                .onScrollPhaseChange { _, phase in
                    if phase == .interacting { moved = true }
                }
                .task(id: "\(zoomedOut)|\(Int(width))") {
                    guard let window else { return position.scrollTo(edge: .leading) }
                    guard !moved else { return }
                    position.scrollTo(x: max(0, x(window.start)))
                }
                .onChange(of: zoomedOut) { moved = false }
                .frame(width: room, height: height)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(summary(timeline))
                if showsWords {
                    VStack(alignment: .leading, spacing: 0) {
                        Color.clear.frame(height: Self.headerHeight)
                        ForEach(rows) { row in
                            words(row, long: long)
                                .frame(height: Self.height(row))
                                .accessibilityHidden(true)
                        }
                    }
                    .frame(width: Self.wordsWidth, alignment: .leading)
                }
            }
            if window != nil, let deadline = timeline.deadline {
                deadlineChip(deadline, x: x, showsWords: showsWords)
                    .frame(height: Self.chipHeight)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The axis as VoiceOver reads it: now, the finish and the deadline (each lane reads itself).
    private func summary(_ timeline: GoalTimeline) -> String {
        let format: Date.FormatStyle = timeline.unit == .hour ? .dateTime.hour().minute() : .dateTime.weekday(.wide).month(.wide).day()
        var said = ["Time line"]
        if plan.state == .running { said.append("now \(now.formatted(format))") }
        if let finish = timeline.finish { said.append("likely done around \(finish.formatted(format))") }
        if let deadline = timeline.deadline { said.append("due \(deadline.formatted(format))") }
        return said.joined(separator: ", ")
    }

    /// A thin bar under lanes that scroll: where along the goal what shows is.
    private func indicator(content: CGFloat, room: CGFloat) -> some View {
        let share = content > 0 ? room / content : 1
        return Capsule()
            .fill(Color.primary.opacity(0.06))
            .frame(width: room, height: 3)
            .overlay(alignment: .leading) {
                Capsule()
                    .fill(Color.primary.opacity(0.25))
                    .frame(width: max(12, room * share), height: 3)
                    .offset(x: content > 0 ? visible.minX / content * room : 0)
            }
            .padding(.bottom, 2)
            .allowsHitTesting(false)
    }

    /// How wide the axis is drawn: the days around now across the room, the rest a scroll away;
    /// a goal shown whole across the room.
    static func width(_ timeline: GoalTimeline, window: DateInterval?, room: CGFloat) -> CGFloat {
        guard let window, window.duration > 0 else { return room }
        return room * timeline.end.timeIntervalSince(timeline.start) / window.duration
    }

    /// `words`: what the step is at goes in its help, where there's no room beside the lanes.
    @ViewBuilder private func name(_ row: Row, words: Bool) -> some View {
        switch row {
        case .phase(let phase):
            Text(phase.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.4)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
        case .done(let lanes):
            fold("\(lanes.count) done", shows: $showsDone, ink: AnyShapeStyle(Color.green), what: "steps that are done")
        case .later(let lanes):
            fold("\(lanes.count) later", shows: $showsLater, ink: AnyShapeStyle(.secondary), what: "steps for later")
        case .lane(let lane):
            HStack(spacing: 5) {
                // The mark's slot kept where another lane has one, so the names line up.
                if let site = lane.step.site {
                    SiteServiceMark(site: site)
                } else if hasMarks {
                    ServiceMark(icon: nil, name: "").hidden()
                }
                Text(lane.step.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .foregroundStyle(ink(lane.step.state))
            .help(words ? "\(lane.step.text): \(status(lane.step).text)" : lane.step.text)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(GoalPlanWords.spoken(lane.step, now: now))
            .accessibilityValue(status(lane.step).text)
        }
    }

    /// A fold's name, which opens its steps and folds them again.
    private func fold(_ title: String, shows: Binding<Bool>, ink: AnyShapeStyle, what: String) -> some View {
        Button {
            withAnimation(.ui) { shows.wrappedValue.toggle() }
        } label: {
            HStack(spacing: 4) {
                Text(title)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .rotationEffect(.degrees(shows.wrappedValue ? 90 : 0))
            }
            .foregroundStyle(ink)
        }
        .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
        .help(shows.wrappedValue ? "Fold the \(what)" : "Show the \(what)")
        .accessibilityLabel(title.replacingOccurrences(of: " done", with: " steps done").replacingOccurrences(of: " later", with: " steps for later"))
        .accessibilityValue(shows.wrappedValue ? "Shown" : "Hidden")
    }

    @ViewBuilder private func words(_ row: Row, long: Bool) -> some View {
        switch row {
        case .phase:
            Color.clear
        case .done(let lanes):
            let recent = lanes.filter { lane in lane.to.map { $0 >= Calendar.current.startOfDay(for: now).addingTimeInterval(-86400) } ?? false }.count
            Text(long && recent > 0 ? "\(recent) since yesterday" : outline(lanes))
                .foregroundStyle(Color.green)
                .lineLimit(1)
        case .later(let lanes):
            Text(outline(lanes))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        case .lane(let lane):
            // Once the goal is met, "Done" is the header's to say: a lane keeps only its note.
            let said = plan.state == .done && lane.step.state == .done ? (text: lane.step.note ?? "", style: AnyShapeStyle(.secondary)) : status(lane.step)
            Text(said.text)
                .foregroundStyle(said.style)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(said.text)
        }
    }

    /// Whether any lane has a service's mark before its name.
    private var hasMarks: Bool { plan.steps.contains { $0.site != nil } }

    /// What a fold holds, in a few words: its phases, or its steps.
    private func outline(_ lanes: [GoalTimeline.Lane]) -> String {
        let phases = plan.phases.filter { phase in lanes.contains { $0.step.phase == phase } }
        return (phases.count > 1 || (plan.phases.count > 1 && !phases.isEmpty) ? phases : lanes.map(\.step.text)).joined(separator: ", ")
    }

    private func ink(_ state: GoalPlan.Step.State) -> AnyShapeStyle {
        switch state {
        case .done, .skipped: AnyShapeStyle(.secondary)
        case .todo: AnyShapeStyle(.tertiary)
        default: AnyShapeStyle(.primary)
        }
    }

    /// What a step is at, in words, beside its lane.
    private func status(_ step: GoalPlan.Step) -> (text: String, style: AnyShapeStyle) {
        switch step.state {
        case .done:
            return (["Done", step.note].compactMap { $0 }.joined(separator: " · "), AnyShapeStyle(Color.green))
        case .skipped:
            return ("Set aside", AnyShapeStyle(.tertiary))
        case .waiting:
            return ("Waits for you", AnyShapeStyle(Color.orange))
        case .paused:
            let until = resumes(step)
            let why = pause(of: step)?.why ?? step.note
            let words = [until.map { "Until \(Self.time($0, now: now))" }, why].compactMap { $0 }
            return (words.isEmpty ? "Paused" : words.joined(separator: " · "), AnyShapeStyle(.secondary))
        case .todo:
            let after = step.after.compactMap { id in plan.steps.first { $0.id == id }?.text }
            return (after.isEmpty ? "Not started" : "After \(after.formatted(.list(type: .and)))", AnyShapeStyle(.tertiary))
        case .doing:
            return (GoalPlanWords.underWay(step), AnyShapeStyle(.secondary))
        }
    }

    // MARK: The axis

    private func axis(_ timeline: GoalTimeline, window: DateInterval?, rows: [Row], x: AxisX, height: CGFloat, lanesHeight: CGFloat, footer: Bool) -> some View {
        let days = window != nil ? Self.days(timeline) : []
        let ticks = window != nil ? days : timeline.ticks()
        let nowX = x(now)
        let today = Calendar.current.dateInterval(of: .day, for: now)
        return ZStack(alignment: .topLeading) {
            // Today shaded, the grid, now, the finish and the deadline, across the lanes.
            Canvas { context, _ in
                let top = Self.headerHeight, bottom = Self.headerHeight + lanesHeight + (footer ? 4 : 0)
                if window != nil, let today {
                    context.fill(Path(CGRect(x: x(today.start), y: top, width: x(today.end) - x(today.start), height: lanesHeight)), with: .color(accent.opacity(0.08)))
                }
                for tick in ticks {
                    context.stroke(Self.line(x(tick), top, bottom), with: .color(.primary.opacity(0.08)), lineWidth: 1)
                }
                if let finish = timeline.finish {
                    context.stroke(Self.line(x(finish), top, bottom), with: .color(.secondary.opacity(0.7)), style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                }
                if let deadline = timeline.deadline {
                    context.stroke(Self.line(x(deadline), top, bottom), with: .color(.red.opacity(0.7)), lineWidth: 1.5)
                }
                if plan.state == .running {
                    context.stroke(Self.line(nowX, top - 2, top + lanesHeight), with: .color(accent), lineWidth: 1.5)
                }
            }
            VStack(alignment: .leading, spacing: 0) {
                if window != nil {
                    dayHeader(days, x: x, width: x.width, window: window, shown: visible)
                } else {
                    header(timeline, ticks: ticks, x: x, width: x.width)
                }
                ForEach(rows) { row in
                    bar(row, window: window, timeline: timeline, x: x)
                        .frame(width: x.width, height: Self.height(row), alignment: .leading)
                }
                if footer {
                    footerLabel(timeline, x: x, width: x.width)
                        .frame(width: x.width, height: Self.footerHeight, alignment: .leading)
                }
            }
        }
        .frame(width: x.width, height: height, alignment: .topLeading)
    }

    private static func line(_ x: CGFloat, _ top: CGFloat, _ bottom: CGFloat) -> Path {
        Path { path in
            path.move(to: CGPoint(x: x, y: top))
            path.addLine(to: CGPoint(x: x, y: bottom))
        }
    }

    /// The days along a long goal's axis, each at its start.
    private static func days(_ timeline: GoalTimeline) -> [Date] {
        let calendar = Calendar.current
        var day = calendar.startOfDay(for: timeline.start)
        var days: [Date] = []
        while day < timeline.end, days.count < 400 {
            if day > timeline.start { days.append(day) }
            day = calendar.date(byAdding: .day, value: 1, to: day) ?? timeline.end
        }
        return days
    }

    /// A few hours' labels: the ticks, and now's in its own color.
    private func header(_ timeline: GoalTimeline, ticks: [Date], x: AxisX, width: CGFloat) -> some View {
        let nowX = x(now)
        let running = plan.state == .running
        return ZStack(alignment: .topLeading) {
            ForEach(ticks, id: \.self) { tick in
                // Clear of now's label, and of the edges.
                if !(running && abs(x(tick) - nowX) < 48), x(tick) > 16, x(tick) < width - 16 {
                    Text(Self.label(tick, unit: timeline.unit))
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(.tertiary)
                        .fixedSize()
                        .position(x: x(tick), y: Self.headerHeight / 2)
                }
            }
            if running {
                Text(timeline.unit == .hour ? now.formatted(.dateTime.hour().minute()) : "Today")
                    .font(.system(size: 11, weight: .semibold).monospacedDigit())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(accent, in: .rect(cornerRadius: 4))
                    .fixedSize()
                    .position(x: min(max(nowX, 22), width - 22), y: Self.headerHeight / 2)
            }
        }
        .frame(width: width, height: Self.headerHeight, alignment: .topLeading)
    }

    /// The days' labels, each over its day: every day's name across a week ("Tue"), every day's
    /// date where the days have room ("Tue 3"), else Mondays ("Mon 26"); and Today, with no label
    /// running into it.
    private func dayHeader(_ days: [Date], x: AxisX, width: CGFloat, window: DateInterval?, shown: CGRect) -> some View {
        let calendar = Calendar.current
        let week = (window?.duration ?? 0) <= 7 * 86400
        let roomy = days.first.map { x($0.addingTimeInterval(86400)) - x($0) } ?? 0 >= 52
        let everyDay = week || roomy
        let todayX = days.first { calendar.isDate($0, inSameDayAs: now) }.map { (x($0) + x($0.addingTimeInterval(86400))) / 2 }
        return ZStack(alignment: .topLeading) {
            ForEach(days, id: \.self) { day in
                let center = (x(day) + x(day.addingTimeInterval(86400))) / 2
                // Clear of the edges of what shows, where it would be cut, and of Today.
                let clear = shown.width == 0 || (center > shown.minX + 22 && center < shown.maxX - 22)
                let isToday = calendar.isDate(day, inSameDayAs: now)
                if !clear || (!isToday && todayX.map { abs($0 - center) < 46 } == true) {
                    EmptyView()
                } else if isToday {
                    Text("Today")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(accent)
                        .fixedSize()
                        .position(x: center, y: Self.headerHeight / 2)
                } else if everyDay || calendar.component(.weekday, from: day) == 2 {
                    Text(day.formatted(week ? .dateTime.weekday(.abbreviated) : .dateTime.weekday(.abbreviated).day()))
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(.tertiary)
                        .fixedSize()
                        .position(x: center, y: Self.headerHeight / 2)
                }
            }
        }
        .frame(width: width, height: Self.headerHeight, alignment: .topLeading)
    }

    @ViewBuilder private func bar(_ row: Row, window: DateInterval?, timeline: GoalTimeline, x: AxisX) -> some View {
        let lanes = timeline.lanes
        switch row {
        case .phase:
            Color.clear
        case .done(let steps):
            Group {
                if window != nil {
                    // Short, at the window's left edge, with since when.
                    HStack(spacing: 6) {
                        Capsule()
                            .fill(LinearGradient(colors: [Color.green.opacity(0.08), Color.green.opacity(0.4)], startPoint: .leading, endPoint: .trailing))
                            .frame(width: 26, height: 7)
                        if let since = steps.compactMap(\.from).min() {
                            Text("‹ since \(Self.day(since, now: now))")
                                .font(.system(size: 11))
                                .foregroundStyle(Color.green)
                                .fixedSize()
                        }
                    }
                    .offset(x: visible.minX + 4)
                } else if let from = steps.compactMap(\.from).min(), let to = steps.compactMap(\.to).max() {
                    GoalTrack(.done, height: 5)
                        .frame(width: max(6, x(to) - x(from)))
                        .offset(x: x(from))
                        .opacity(showsDone ? 0.4 : 1)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .contentShape(.rect)
            .onTapGesture { withAnimation(.ui) { showsDone.toggle() } }
        case .later(let steps):
            let from = steps.compactMap { startsAround($0.step, lanes: lanes) }.min()
            Group {
                if window != nil {
                    // Short, at the window's right edge, with from when.
                    HStack(spacing: 6) {
                        Text(from.map { "from \(Self.day($0, now: now)) ›" } ?? "later ›")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .fixedSize()
                        Hatched().frame(width: 30, height: 7)
                    }
                    .fixedSize()
                    .frame(width: max(0, visible.maxX - 4), alignment: .trailing)
                } else {
                    let start = from ?? now
                    let end = (lanes.compactMap(\.likelyEnd) + [timeline.deadline ?? timeline.end]).max() ?? now
                    Hatched()
                        .frame(width: max(12, x(end) - x(start)), height: 7)
                        .offset(x: x(start))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .contentShape(.rect)
            .onTapGesture { withAnimation(.ui) { showsLater.toggle() } }
        case .lane(let lane):
            laneBar(lane, lanes: lanes, x: x)
        }
    }

    private func laneBar(_ lane: GoalTimeline.Lane, lanes: [GoalTimeline.Lane], x: AxisX) -> some View {
        let step = lane.step
        return ZStack(alignment: .leading) {
            if let from = lane.from {
                let to = lane.to ?? now
                GoalTrack(Self.track(step.state), progress: step.progress == nil ? nil : 1, height: 5)
                    .frame(width: max(6, x(to) - x(from)))
                    .offset(x: x(from))
                // Where it's likely to end, only where it was measured.
                if let likely = lane.likelyEnd, likely > to {
                    Dashes()
                        .stroke(accent.opacity(0.75), style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                        .frame(width: max(0, x(likely) - x(to) - 2), height: 2)
                        .offset(x: x(to) + 2)
                }
                // Paused: held until it carries on.
                if step.state == .paused, let resumes = resumes(step), resumes > to {
                    Dashes()
                        .stroke(Color.secondary.opacity(0.6), style: StrokeStyle(lineWidth: 3, dash: [1.5, 2.5]))
                        .frame(width: max(0, x(resumes) - x(to) - 2), height: 3)
                        .offset(x: x(to) + 2)
                }
            } else if step.state == .todo, let at = startsAround(step, lanes: lanes) {
                GoalTrack(.todo, height: 5)
                    .frame(width: 22)
                    .overlay(Capsule().strokeBorder(Color.primary.opacity(0.18), lineWidth: 1))
                    .offset(x: x(at))
            }
        }
    }

    /// What holds a paused step: its session's pause, or the bot's own.
    private func pause(of step: GoalPlan.Step) -> GoalPlan.Paused? {
        plan.paused.first { $0.session.map(step.sessions.contains) ?? false } ?? plan.paused.first { $0.session == nil }
    }

    private func resumes(_ step: GoalPlan.Step) -> Date? {
        step.resumesDate ?? pause(of: step)?.untilDate
    }

    /// Where a step not begun is likely to start: once the steps it waits for are likely done.
    private func startsAround(_ step: GoalPlan.Step, lanes: [GoalTimeline.Lane]) -> Date? {
        let before = lanes.filter { step.after.contains($0.id) }
        guard !before.isEmpty else { return nil }
        let ends = before.map { $0.likelyEnd ?? $0.to ?? now }
        return max(now, ends.max() ?? now)
    }

    /// Under the lanes: "Done around 15:50" at the finish, the deadline at its line.
    private func footerLabel(_ timeline: GoalTimeline, x: AxisX, width: CGFloat) -> some View {
        let format: Date.FormatStyle = timeline.unit == .hour ? .dateTime.hour().minute() : .dateTime.month(.abbreviated).day()
        var marks: [(at: CGFloat, symbol: String, words: String, tone: Color?)] = []
        if let finish = timeline.finish {
            marks.append((x(finish), "flag", "Done around \(finish.formatted(format))", nil))
        }
        if let deadline = timeline.deadline {
            let words = "Due \(deadline.formatted(format))"
            if let first = marks.first, abs(first.at - x(deadline)) < 150 {
                marks[0].words += " · \(words.lowercased())"
            } else {
                marks.append((x(deadline), "flag.fill", words, .red))
            }
        }
        return ZStack(alignment: .leading) {
            ForEach(Array(marks.enumerated()), id: \.offset) { _, mark in
                let label = Label(mark.words, systemImage: mark.symbol)
                    .font(.system(size: 11))
                    .foregroundStyle(mark.tone.map { AnyShapeStyle($0.opacity(0.85)) } ?? AnyShapeStyle(.secondary))
                    .labelStyle(TightLabel())
                    .fixedSize()
                if mark.at < width - 150 {
                    label.offset(x: mark.at - 1)
                } else {
                    label.frame(width: mark.at + 1, alignment: .trailing)
                }
            }
        }
    }

    /// A deadline out of sight: a chip under the lanes that scrolls there.
    @ViewBuilder private func deadlineChip(_ deadline: Date, x: AxisX, showsWords: Bool) -> some View {
        if visible.width > 0, !(visible.minX...visible.maxX).contains(x(deadline)) {
            let later = x(deadline) > visible.maxX
            Button {
                moved = true
                withAnimation(.ui) { position.scrollTo(x: max(0, x(deadline) - visible.width * (later ? 0.8 : 0.2))) }
            } label: {
                HStack(spacing: 4) {
                    if !later { Image(systemName: "chevron.left").font(.system(size: 9, weight: .semibold)) }
                    Image(systemName: "flag")
                    Text("Due \(Self.day(deadline, now: now))")
                    if later { Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)) }
                }
                .font(.system(size: 12, weight: .medium))
            }
            .buttonStyle(GoalPillButtonStyle(bordered: true))
            .controlSize(.small)
            .help("Scroll to the deadline")
            .padding(.trailing, showsWords ? Self.wordsWidth + 12 : 0)
        }
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

    /// A tick's label: "13:00", "Oct 23".
    static func label(_ date: Date, unit: GoalTimeline.Unit) -> String {
        unit == .hour ? date.formatted(.dateTime.hour().minute()) : date.formatted(.dateTime.month(.abbreviated).day())
    }

    /// A day as it reads on a fold or the deadline: its name within the week ahead or behind
    /// ("Sunday", "Mon"), its date further ("Nov 19").
    static func day(_ date: Date, now: Date) -> String {
        abs(date.timeIntervalSince(now)) < 6 * 86400 ? date.formatted(.dateTime.weekday(.wide)) : date.formatted(.dateTime.month(.abbreviated).day())
    }

    /// A time as it reads beside a step: "15:20" today, "Nov 3, 15:20" another day.
    static func time(_ date: Date, now: Date) -> String {
        Calendar.current.isDate(date, inSameDayAs: now)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}

/// ⌘-scroll over a long goal's lanes: down for the whole goal, up for the days around today.
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

/// Where a time falls across an axis `width` wide.
private struct AxisX {
    let timeline: GoalTimeline
    let width: CGFloat

    func callAsFunction(_ date: Date) -> CGFloat { 4 + timeline.position(of: date) * (width - 8) }
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

/// An icon and its words, close.
private struct TightLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon
            configuration.title
        }
    }
}
