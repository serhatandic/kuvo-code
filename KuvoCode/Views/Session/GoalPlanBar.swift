import AppKit
import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI

/// A bot's goal under way, in the goal bar's place over its composer: the line names the goal in a
/// few words, how many steps are done and for how long (paused, why, in a word), and in the list
/// when it's due; then the List | Timeline switch and Pause | Stop… (Resume once paused; Stop asks
/// first); folded, a short track for each step. Open, the goal's own words, two lines until Show
/// More, and its steps as a list (`GoalSteps`) or on a timeline (`GoalChartView`): the list until a
/// step begins, then the timeline, unless you picked one for this goal. Then what waits for you,
/// each with its button. Once it's over, ✕ puts it away.
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
    /// The view you picked for this goal, on this Mac; nil until you pick one.
    @State private var picked: GoalPaneView?

    private var isOver: Bool { plan.state == .done || plan.state == .stopped }
    private var isPaused: Bool { plan.state == .running && goal?.state == .paused }
    /// Paused by its computer (a turn failed, the agent stopped making progress): it needs you.
    private var needsYou: Bool { isPaused && (goal?.pausedBy == .error || goal?.pausedBy == .stalled) }
    private var isBusy: Bool { isChanging || app.goalPlans.answering.contains(plan.id) }
    private var view: GoalPaneView { picked ?? (GoalPlanWords.opensOnTimeline(plan) ? .timeline : .list) }

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
        .onChange(of: plan.id, initial: true) { _, id in picked = GoalPaneView.kept(for: id) }
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

    /// "2 of 6 · 2 h 22 min", "2 of 6 · Next: Mon 09:00", "Paused · You", "Done · 3 days"; and when
    /// it's due wherever the timeline isn't showing it: in the list, with the steps hidden, or
    /// overdue before the days the timeline opens on.
    private func progress(now: Date) -> String {
        let saysDue = view == .timeline && !isHidden && GoalChartView.saysDue(GoalTimeline(plan, now: now).chart())
        return GoalPlanWords.line(plan, pausedBy: isPaused ? .some(goal?.pausedBy) : nil, due: !saysDue, now: now)
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

    /// The line's controls: which view shows the steps, and while it runs Pause | Stop… (Resume |
    /// Stop… once paused), one pair.
    @ViewBuilder private var actions: some View {
        HStack(spacing: 6) {
            if !plan.steps.isEmpty {
                GoalViewSwitch(selection: Binding(get: { view }, set: { picked = $0; GoalPaneView.keep($0, for: plan.id) }))
            }
            if plan.state == .running {
                ChipPair(first: firstAction, second: .init(title: "Stop…", help: "End the goal: \(plan.name) stops working on it", isRed: true) { confirmsStop = true })
                    .disabled(isBusy)
            }
        }
    }

    private var firstAction: ChipPair.Half? {
        switch goal?.state {
        case .working: .init(title: "Pause", help: "Stop the turn under way and hold the goal until you resume it", action: pause)
        case .paused: .init(title: "Resume", help: "Carry on with the plan", isTinted: true, action: resume)
        default: nil
        }
    }

    // MARK: Under the line

    private func details(now: Date) -> some View {
        let timeline = GoalTimeline(plan, now: now)
        return VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                // The goal in its own words: the line has only its name.
                GoalText(text: plan.goal)
                if needsYou, let note = goal?.note {
                    Label(note, systemImage: "exclamationmark.circle")
                        .font(.system(size: 12.5))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.leading, GoalSteps.nameInset)
            switch view {
            case .list: GoalSteps(plan: plan, timeline: timeline, showsDone: $showsDone, showsLater: $showsLater)
            case .timeline: GoalChartView(plan: plan, timeline: timeline)
            }
            if !plan.waiting.isEmpty {
                VStack(spacing: 4) {
                    ForEach(plan.waiting) { item in waitingRow(item, now: now) }
                }
                .padding(.leading, GoalSteps.nameInset - 24)
            }
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

    private func waitingRow(_ item: GoalPlan.Waiting, now: Date) -> some View {
        let since = Date(timeIntervalSince1970: item.at / 1000)
        let onThisMac = box == BoxClient.mac
        let button: (String, () -> Void)?
        var help: String?
        if let url = item.url {
            // In the bot's browser, not yours: a sign-in there is one it can use.
            button = (item.site.map { "Open \(GoalPlanWords.service($0))" } ?? "Open", {
                app.utilities.openForAgent(url, bot: plan.bot, machine: onThisMac ? nil : box)
            })
            help = GoalPlanWords.opensIn(bot: plan.name, computer: onThisMac ? nil : app.machines.engine(box)?.machine.name ?? box)
        } else if let session = item.session {
            button = ("Open", { app.tabs.open(.session(session)) })
        } else {
            button = nil
        }
        return YoursRow(text: item.text, detail: item.detail, aside: "since \(GoalSteps.time(since, now: now))", site: item.site, button: button, help: help) {
            Task {
                do { try await app.goalPlans.answer(plan, on: box, .clear(waiting: item.id)) } catch { failed(error.localizedDescription) }
            }
        }
        .disabled(isBusy)
    }
}

/// A goal's steps as a list you read top to bottom (`GoalTimeline.list`): each step's state, its
/// name with the service's mark and where it stands in a few words; the steps done, and many for
/// later, folded to a row each. Many rows scroll.
struct GoalSteps: View {
    let plan: GoalPlan
    let timeline: GoalTimeline
    @Binding var showsDone: Bool
    @Binding var showsLater: Bool

    typealias Row = GoalTimeline.Row

    static let rowHeight: CGFloat = 28
    /// The state's mark, and the gap after it: names line up with the goal's words.
    static let markWidth: CGFloat = 18
    static let nameInset: CGFloat = markWidth + 10
    /// The most the rows take before they scroll: about ten.
    static let mostHeight: CGFloat = 10 * rowHeight

    private var now: Date { timeline.now }

    var body: some View {
        let rows = timeline.list(showsDone: showsDone, showsLater: showsLater)
        let rowsHeight = CGFloat(rows.count) * Self.rowHeight
        // Many rows (a fold opened on a long goal) scroll, so the card doesn't take over the
        // conversation.
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    name(row).frame(height: Self.rowHeight)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDisabled(rowsHeight <= Self.mostHeight)
        .scrollIndicators(rowsHeight > Self.mostHeight ? .automatic : .never)
        // The edge with more past it fades, so a row cut there reads as more to scroll to.
        .fadingScrollEdges(20)
        .frame(height: min(rowsHeight, Self.mostHeight))
        .font(.system(size: 13))
        .accessibilityElement(children: .contain)
    }

    // MARK: The rows

    @ViewBuilder private func name(_ row: Row) -> some View {
        switch row {
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
                    if GoalPlanWords.mark(of: step) != nil { StepServiceMark(step: step) }
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
            .help(help(step, said: said.text))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(step.text)
            .accessibilityValue(GoalPlanWords.spokenState(of: step, in: plan, now: now))
        }
    }

    /// Under the pointer: the step's name in full, where it stands, and when it ran.
    private func help(_ step: GoalPlan.Step, said: String?) -> String {
        var lines = [step.text]
        if let said { lines.append(said) }
        if let began = step.began.map({ Date(timeIntervalSince1970: $0 / 1000) }) {
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

/// Which view a goal's steps show in: a pick for each goal, kept on this Mac (the phone keeps its
/// own).
enum GoalPaneView: String {
    case list, timeline

    private static func key(_ goal: String) -> String { "goalView." + goal }

    static func kept(for goal: String) -> GoalPaneView? {
        UserDefaults.standard.string(forKey: key(goal)).flatMap(GoalPaneView.init)
    }

    static func keep(_ view: GoalPaneView, for goal: String) {
        UserDefaults.standard.set(view.rawValue, forKey: key(goal))
    }
}

/// List | Timeline on the goal's line: a small track with the one chosen raised.
struct GoalViewSwitch: View {
    @Binding var selection: GoalPaneView
    @Namespace private var pill

    var body: some View {
        HStack(spacing: 0) {
            segment(.list, "List")
            segment(.timeline, "Timeline")
        }
        .padding(2)
        .background(Capsule().fill(Color.primary.opacity(0.05)))
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Show the Steps As")
    }

    private func segment(_ value: GoalPaneView, _ title: String) -> some View {
        let isOn = selection == value
        return Button {
            withAnimation(.ui) { selection = value }
        } label: {
            Text(title)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(isOn ? .primary : .secondary)
                .padding(.horizontal, 8)
                .frame(height: 18)
                .contentShape(.capsule)
                .hoverHighlight(in: Capsule(), mutesInk: true)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .background {
            if isOn { ActivePill().matchedGeometryEffect(id: "pill", in: pill) }
        }
        .help(value == .list ? "The steps as a list" : "The steps on a timeline")
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// Two chips as one, side by side with a line between: a goal's Pause | Stop….
struct ChipPair: View {
    struct Half {
        let title: String
        let help: String
        var isTinted = false
        var isRed = false
        let action: () -> Void
    }

    let first: Half?
    let second: Half

    var body: some View {
        HStack(spacing: 0) {
            if let first {
                half(first)
                Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 1, height: 12)
            }
            half(second)
        }
        .background(Capsule().fill(Color.primary.opacity(0.04)))
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
        .clipShape(Capsule())
        .fixedSize()
    }

    private func half(_ half: Half) -> some View {
        Button(half.title, action: half.action)
            .buttonStyle(HalfStyle(ink: half.isRed ? AnyShapeStyle(Color.red) : half.isTinted ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary)))
            .help(half.help)
    }

    private struct HalfStyle: ButtonStyle {
        let ink: AnyShapeStyle

        func makeBody(configuration: Configuration) -> some View {
            Label(configuration: configuration, ink: ink)
        }

        private struct Label: View {
            let configuration: ButtonStyleConfiguration
            let ink: AnyShapeStyle
            @State private var isHovering = false
            @Environment(\.isEnabled) private var isEnabled

            var body: some View {
                let deeper = configuration.isPressed ? 0.1 : isHovering ? 0.05 : 0
                configuration.label
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ink)
                    .opacity(isEnabled ? 1 : 0.5)
                    .padding(.horizontal, 9)
                    .frame(height: 22)
                    .background(Color.primary.opacity(deeper))
                    .contentShape(.rect)
                    .onHover { isHovering = $0 }
                    .clickablePointer()
                    .animation(.easeOut(duration: 0.12), value: isHovering)
            }
        }
    }
}

/// A goal's own words, as its bot wrote them (bold, code, links): two lines, and Show More where
/// there's more.
struct GoalText: View {
    let text: String
    @State private var isOpen = false
    @State private var shownHeight: CGFloat = 0
    @State private var wholeHeight: CGFloat = 0

    var body: some View {
        let words = Self.markdown(text)
        VStack(alignment: .leading, spacing: 2) {
            Text(words)
                .lineLimit(isOpen ? nil : 2)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .onGeometryChange(for: CGFloat.self, of: \.size.height) { shownHeight = $0 }
                .background(alignment: .topLeading) {
                    // The words whole, unseen, to know whether two lines cut them.
                    Text(words)
                        .fixedSize(horizontal: false, vertical: true)
                        .hidden()
                        .onGeometryChange(for: CGFloat.self, of: \.size.height) { wholeHeight = $0 }
                        .accessibilityHidden(true)
                }
            if isOpen || wholeHeight > shownHeight + 1 {
                Button(isOpen ? "Show Less" : "Show More") {
                    withAnimation(.ui) { isOpen.toggle() }
                }
                .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
                .foregroundStyle(.tint)
                .font(.system(size: 12, weight: .medium))
            }
        }
        .font(.system(size: 12.5))
        .foregroundStyle(.secondary)
    }

    /// Its Markdown inline (bold, code, links), its paragraphs kept.
    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}
