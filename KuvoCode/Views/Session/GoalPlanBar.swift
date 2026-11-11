import AppKit
import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI

/// A bot's goal under way, in the goal bar's place over its composer: the line names the goal in a
/// few words, how many steps are done and for how long (paused, why, in a word), and in the list
/// when it's due; then the List | Timeline switch, the bot's sessions as a chip ("2 working") and
/// Pause | Stop… (Resume once paused; Stop asks first); folded, a short track for each step. Open,
/// the goal's own words, two lines until Show More, and its steps as a list (`GoalStagesView`) or
/// on a timeline (`GoalChartView`): the list until a step begins, then the timeline, unless you
/// picked one for this goal. Then what waits for you,
/// each with its button. Once it's over, ✕ puts it away.
struct GoalPlanBar: View {
    let plan: GoalPlan
    let box: String
    /// The conversation's own goal, which keeps the bot at it: Pause and Resume are its.
    let goal: Goal?
    @Binding var isHidden: Bool
    var isChanging = false
    /// The bot's sessions, on the line in the work bar's stead (`BotWorkChip`).
    var work: (bot: Bot, report: BotWorkReport)?
    let pause: () -> Void
    let resume: () -> Void
    let putAway: () -> Void
    let failed: (String) -> Void
    @Environment(AppModel.self) private var app
    /// The conversation this is in, where what it opens comes back to.
    @Environment(\.conversationTab) private var here
    @State private var confirmsStop = false
    /// The view you picked for this goal, on this Mac; nil until you pick one.
    @State private var picked: GoalPaneView?

    private var isOver: Bool { plan.state == .done || plan.state == .stopped }
    private var isPaused: Bool { plan.state == .running && goal?.state == .paused }
    /// Paused by its computer (a turn failed, the agent stopped making progress): it needs you.
    private var needsYou: Bool { isPaused && (goal?.pausedBy == .error || goal?.pausedBy == .stalled) }
    private var isBusy: Bool { isChanging || app.goalPlans.answering.contains(plan.id) }
    private var view: GoalPaneView { picked ?? (GoalPlanWords.opensOnTimeline(plan) ? .timeline : .list) }
    /// Room on the line for the goal's name beside List | Timeline and Pause | Stop…; narrower, the
    /// switch goes over the steps.
    static let switchOnLineWidth: CGFloat = 560
    /// The room either side of what's under the line.
    static let detailsInsets: CGFloat = 30

    var body: some View {
        // Kept current while it runs: how long it has been at it, and now on the axis. Once
        // it's over, it stays as it ended.
        TimelineView(.periodic(from: .now, by: isOver ? 365 * 86400 : 30)) { context in
            let now = isOver ? plan.ended.map { Date(timeIntervalSince1970: $0 / 1000) } ?? context.date : context.date
            content(timeline: GoalTimeline(plan, now: now))
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

    private func content(timeline: GoalTimeline) -> some View {
        let progress = progress(timeline)
        return VStack(alignment: .leading, spacing: 0) {
            // Where List | Timeline goes is chosen from the width the bar is offered as it's laid
            // out, so it's in its place from the first frame; only the line is chosen between, so
            // what's under it (Show More, the timeline's zoom, the list's scroll) stays as it is.
            ViewThatFits(in: .horizontal) {
                line(progress: progress, switchOnLine: true)
                    .frame(idealWidth: Self.switchOnLineWidth, maxWidth: .infinity, alignment: .topLeading)
                line(progress: progress, switchOnLine: false)
            }
            if !isHidden {
                details(timeline: timeline)
                    .padding(.leading, 14)
                    .padding(.trailing, Self.detailsInsets - 14)
                    .padding(.top, 2)
                    .padding(.bottom, 12)
                    .transition(.fold)
            }
        }
    }

    // MARK: The line

    private func line(progress: String, switchOnLine: Bool) -> some View {
        BarLine(mark: AnyView(mark), title: GoalPlanWords.name(plan), progress: progress, status: status(progress), spoken: waitingWords, badge: waitingBadge,
                accessory: AnyView(actions(switchOnLine: switchOnLine)), folded: AnyView(strip), showHelp: "Show the goal’s steps", hideHelp: "Hide them: this line stays",
                isHidden: $isHidden, close: isOver ? putAway : nil, closeHelp: "Put the goal away", stacks: true)
    }

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
    private func progress(_ timeline: GoalTimeline) -> String {
        let saysDue = view == .timeline && !isHidden && GoalChartView.saysDue(timeline.chart())
        return GoalPlanWords.line(plan, pausedBy: isPaused ? .some(goal?.pausedBy) : nil, due: !saysDue, now: timeline.now)
    }

    /// Paused, why in a word, stronger: orange where it needs you; then when it's due, as the line
    /// says it.
    private func status(_ progress: String) -> Text? {
        guard isPaused else { return nil }
        let by = goal?.pausedBy
        let rest = progress.components(separatedBy: " · ").dropFirst(by == nil ? 1 : 2).map { " · " + $0 }.joined()
        guard let by else { return Text("Paused" + rest) }
        return Text("Paused · ") + Text(GoalPlanWords.pausedBy(by)).fontWeight(.semibold).foregroundStyle(needsYou ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary)) + Text(rest)
    }

    /// How many things wait for you, in orange after where it stands, as the phone's line has it:
    /// what the line says of them while a question folds the bar.
    private var waitingBadge: Text? {
        let waiting = plan.waitingInItsConversation.count
        return waiting == 0 ? nil : Text(GoalPlanWords.waiting(waiting)).foregroundStyle(.orange)
    }

    /// What waits for you among the steps, and how many things do, for VoiceOver on the line (the
    /// strip shows the steps by their hollow tracks).
    private var waitingWords: String? {
        let waiting = plan.steps.filter { GoalSteps.track($0.state) == .waiting }.count
        let things = plan.waitingInItsConversation.count
        let words = [waiting == 0 ? nil : waiting == 1 ? "1 step waiting for you" : "\(waiting) steps waiting for you",
                     things == 0 ? nil : GoalPlanWords.waiting(things)].compactMap { $0 }
        return words.isEmpty ? nil : words.joined(separator: ", ")
    }

    /// A short track for each step, while the steps are hidden.
    private var strip: some View {
        let count = max(1, plan.steps.count)
        return GoalTrackStrip(plan.steps.map { (GoalSteps.track($0.state), $0.progress) }, width: count <= 8 ? 14 : max(4, 112 / CGFloat(count)))
            .padding(.horizontal, 2)
    }

    /// The line's controls: which view shows the steps and the bot's sessions (both over the steps
    /// in a narrow card, while they show), and while it runs Pause | Stop… (Resume | Stop… once
    /// paused), one pair.
    @ViewBuilder private func actions(switchOnLine: Bool) -> some View {
        HStack(spacing: 6) {
            if !plan.steps.isEmpty, switchOnLine { viewSwitch }
            if switchOnLine || isHidden || plan.steps.isEmpty { workChip }
            if plan.state == .running {
                ChipPair(first: firstAction, second: .init(title: "Stop…", help: "End the goal: \(plan.name) stops working on it", isRed: true) { confirmsStop = true })
                    .disabled(isBusy)
            }
        }
    }

    @ViewBuilder private var workChip: some View {
        if let work, BotWorkBar.shows(work.report) { BotWorkChip(bot: work.bot, report: work.report) }
    }

    private var viewSwitch: some View {
        GoalViewSwitch(selection: Binding(get: { view }, set: { picked = $0; GoalPaneView.keep($0, for: plan.id) }))
    }

    private var firstAction: ChipPair.Half? {
        switch goal?.state {
        case .working: .init(title: "Pause", help: "Stop the turn under way and hold the goal until you resume it", action: pause)
        case .paused: .init(title: "Resume", help: "Carry on with the plan", isTinted: true, action: resume)
        default: nil
        }
    }

    // MARK: Under the line

    private func details(timeline: GoalTimeline) -> some View {
        let now = timeline.now
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
            VStack(alignment: .leading, spacing: 0) {
                // List | Timeline over the steps where the line has no room for it: the same width
                // as the line's choice, less the room around the details and the names' inset.
                if !plan.steps.isEmpty {
                    ViewThatFits(in: .horizontal) {
                        Color.clear
                            .frame(idealWidth: Self.switchOnLineWidth - Self.detailsInsets - GoalSteps.nameInset, maxWidth: .infinity)
                            .frame(height: 0)
                        HStack(spacing: 6) {
                            viewSwitch
                            workChip
                        }
                        .padding(.bottom, 10)
                    }
                    .padding(.leading, GoalSteps.nameInset)
                }
                switch view {
                case .list where !plan.steps.isEmpty: GoalStagesView(plan: plan, timeline: timeline, isPaused: isPaused).padding(.leading, GoalSteps.nameInset)
                case .list: EmptyView()
                case .timeline: GoalChartView(plan: plan, timeline: timeline)
                }
            }
            if !plan.waitingInItsConversation.isEmpty {
                VStack(spacing: 4) {
                    ForEach(plan.waitingInItsConversation) { item in waitingRow(item, now: now) }
                }
                .padding(.leading, GoalSteps.nameInset - 24)
            }
            if !plan.decided.isEmpty {
                GoalDecidedRows(plan: plan)
                    .environment(\.chooseOnAutopilot) { choice, call in change(call, to: choice) }
                    .disabled(isBusy)
                    .padding(.leading, GoalSteps.nameInset - 21)
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

    /// Your choice on one of its calls; the conversation that asked shows it at its step too.
    private func change(_ call: AutopilotShown.Call, to choice: String) {
        Task {
            do {
                try await app.goalPlans.answer(plan, on: box, .decided(call.id, choice: choice))
                await app.workspace.model(for: call.session ?? plan.session)?.readAutopilot()
            } catch {
                failed(error.localizedDescription)
            }
        }
    }

    /// The app on this Mac what waits for you is in, to open it there: none for a page to open, an
    /// app this Mac doesn't have, or one on a machine, which is out of reach from here.
    static func app(of item: GoalPlan.Waiting, on box: String) -> (name: String, at: URL)? {
        guard box == BoxClient.mac, item.url == nil, let app = item.app, let id = app.id,
              let place = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else { return nil }
        return (app.name, place)
    }

    private func waitingRow(_ item: GoalPlan.Waiting, now: Date) -> some View {
        let since = Date(timeIntervalSince1970: item.at / 1000)
        let onThisMac = box == BoxClient.mac
        let button: (String, () -> Void)?
        var help: String?
        if let url = item.url {
            // In the bot's browser, not yours: a sign-in there is one it can use.
            button = (item.site.map { "Open \(GoalPlanWords.service($0, in: [item.text, item.detail]))" } ?? "Open", {
                app.utilities.openForAgent(url, bot: plan.bot, machine: onThisMac ? nil : box)
            })
            help = GoalPlanWords.opensIn(bot: plan.name, computer: onThisMac ? nil : app.machines.engine(box)?.machine.name ?? box)
        } else if let (name, place) = Self.app(of: item, on: box) {
            button = ("Open \(name)", { NSWorkspace.shared.openApplication(at: place, configuration: NSWorkspace.OpenConfiguration()) })
        } else if let session = item.session {
            button = ("Open", { app.open(.session(session), from: here) })
        } else {
            button = nil
        }
        return YoursRow(text: item.text, detail: item.detail, aside: "since \(GoalSteps.time(since, now: now))", mark: GoalPlanWords.mark(of: item), button: button, help: help) {
            Task {
                do { try await app.goalPlans.answer(plan, on: box, .clear(waiting: item.id)) } catch { failed(error.localizedDescription) }
            }
        }
        .disabled(isBusy)
    }
}

/// What the goal bar's views share: where a step's name lines up, the mark for a step's state,
/// and a time as it reads beside a step.
enum GoalSteps {
    /// The state's mark, and the gap after it: names line up with the goal's words.
    static let markWidth: CGFloat = 18
    static let nameInset: CGFloat = markWidth + 10

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

    var body: some View {
        let words = Self.markdown(text)
        Group {
            if isOpen {
                VStack(alignment: .leading, spacing: 2) {
                    whole(words)
                    toggle
                }
            } else {
                // The words whole where two lines hold them, else two lines and Show More: chosen
                // as it's laid out, against the height of two lines, so Show More is there from
                // the first frame.
                TwoLines {
                    Text(words).lineLimit(2).hidden().accessibilityHidden(true)
                    ViewThatFits(in: .vertical) {
                        whole(words)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(words)
                                .lineLimit(2)
                                .textSelection(.enabled)
                            toggle
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .font(.system(size: 12.5))
        .foregroundStyle(.secondary)
    }

    private func whole(_ words: AttributedString) -> some View {
        Text(words)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    private var toggle: some View {
        Button(isOpen ? "Show Less" : "Show More") {
            withAnimation(.ui) { isOpen.toggle() }
        }
        .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
        .foregroundStyle(.tint)
        .font(.system(size: 12, weight: .medium))
    }

    /// Its Markdown inline (bold, code, links), its paragraphs kept.
    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

/// Offers its second view the height of its first, the words cut to two lines (with half a point
/// to spare for rounding), so a ViewThatFits there knows as it's laid out whether two lines hold
/// the words, whatever is in them (code, emoji, another script).
private struct TwoLines: Layout {
    private func lines(_ width: CGFloat?, _ subviews: Subviews) -> CGFloat {
        subviews[0].sizeThatFits(ProposedViewSize(width: width, height: nil)).height + 0.5
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews[1].sizeThatFits(ProposedViewSize(width: proposal.width, height: lines(proposal.width, subviews)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews[0].place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: nil))
        subviews[1].place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: lines(bounds.width, subviews)))
    }
}
