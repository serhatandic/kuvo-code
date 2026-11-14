import AppKit
import ClientDesign
import ClientSandbox
import ClientSessions
import OpenCodeKit
import SwiftUI

/// The plan a bot puts to you for a goal, over its composer like the other cards that ask you
/// something, in sections: the plan in a line with Review for its steps; what needs you first,
/// each with its button; Execution settings (when it ends, how often you hear, the model asked
/// once, what it may spend, its projects, Wake me); and the checks that passed, folded. Not Now,
/// or Start Goal, on its box. A box that can't work on it alone says why, with where to fix it,
/// and starts it with you there.
struct GoalCard: View {
    let plan: GoalPlan
    /// Its box: "mac", or a machine's id.
    let box: String
    @Environment(AppModel.self) private var app
    @Environment(Updates.self) private var updates
    @Environment(\.takesCardKeys) private var takesKeys
    @Environment(\.colorScheme) private var scheme

    /// A project's name is being typed: Return and Escape are its, not Start's and Not Now's.
    @State private var renamesProject = false
    @State private var wake = false
    /// On Autopilot: one setting with the bot's conversation.
    @State private var autopilot = false
    @State private var digest: GoalPlan.Cadence = .none
    @State private var deadline: Deadline = .none
    @State private var caps: [Double] = []
    @State private var periods: [GoalPlan.Spend.Period] = []
    @State private var sandbox: GoalSandbox.Reading?
    @State private var sandboxBusy = false
    /// You said to restart the agents started before the sandbox: they do between turns.
    @State private var restartingAgents = false
    /// You said to restart the box's sessions: until they're back.
    @State private var restartingSessions = false
    @State private var failure: String?
    /// What a sandbox button couldn't do, said in its row.
    @State private var sandboxFailure: String?
    @State private var sent: GoalPlanAnswer.Action?
    /// How tall what's between its header and its buttons can be before it scrolls.
    @Environment(\.cardRoom) private var room
    @State private var middleHeight: CGFloat = 0
    /// Bumped to read the sandbox again (after its fix ran).
    @State private var sandboxRound = 0
    /// The plan's steps, shown from Review.
    @State private var reviews = false

    private var isAnswering: Bool { app.goalPlans.answering.contains(plan.id) }
    private var onThisMac: Bool { BoxClient.isThisMac(box) }
    private var computer: String { onThisMac ? "This Mac" : app.machines.engine(box)?.machine.name ?? box }
    private var bot: Bot? { app.bots.list.first { $0.id == plan.bot } }
    /// What only you can do (and what failed), first.
    private var yours: [GoalPlan.Check] { plan.checks.filter { ($0.state == .needs || $0.state == .failed) && !$0.cantWorkAlone } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            // As tall as it is, up to the room there is; then it scrolls, the header and the
            // buttons staying in sight.
            ScrollView {
                middle
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { middleHeight = $0 }
            }
            .frame(height: min(max(middleHeight, 1), room))
            .scrollBounceBehavior(.basedOnSize)
            HStack(spacing: 8) {
                Button("Not Now", role: .cancel) { send(.decline) }
                    .keyboardShortcut(takesKeys && !renamesProject ? .cancelAction : nil)
                    .help("Put the plan away: \(plan.name) doesn’t start it")
                Spacer()
                if isAnswering, sent == .start {
                    Spinner()
                        .accessibilityLabel("Starting the goal")
                }
                Button(plan.alone ? "Start Goal" : "Start With Me Here") { send(.start) }
                    .buttonStyle(.glassProminent)
                    .keyboardShortcut(takesKeys && !renamesProject ? .defaultAction : nil)
                    .help(plan.alone ? "\(plan.name) works through the plan on \(computer.lowercasedThisMac), with the window closed too"
                                     : "\(plan.name) works through the plan while you’re here")
            }
            .buttonStyle(.glass)
            .controlSize(.large)
            .disabled(isAnswering)
        }
        .padding(16)
        .onAppear(perform: takeIn)
        #if DEBUG
        // KUVO_DEMO_GOAL_OPEN=<seconds>: that long after it shows, its first page to open is
        // opened, as its button does.
        .task(id: plan.id) {
            guard let wait = ProcessInfo.processInfo.environment["KUVO_DEMO_GOAL_OPEN"].flatMap(Double.init),
                  let action = yours.compactMap(\.action).first(where: { $0.kind == .open }) else { return }
            await DemoWait.pause(.asked(wait))
            if !Task.isCancelled { open(action) }
        }
        #endif
        .onChange(of: plan.id) {
            // What you started on another plan's box isn't this one's.
            restartingAgents = false
            restartingSessions = false
            sandboxFailure = nil
            takeIn()
        }
        // Switched in its conversation meanwhile: one setting.
        .onChange(of: app.workspace.model(for: plan.session)?.isAutopilot) { _, on in
            if let on { autopilot = on }
        }
        .onChange(of: sandboxFailure) { _, failure in
            if let failure { AccessibilityNotification.Announcement(failure).post() }
        }
        .task(id: "\(plan.id)|\(box)|\(plan.alone)|\(bot?.agents == true)|\(sandboxRound)") {
            guard !plan.alone else { return }
            // Read again while it's being checked (or the agents or sessions restart), less often
            // each time. Sessions get seven reads, about two minutes, to come back.
            var wait = 2.0
            var reads = 0
            // A row showing as this starts (read again, or after a button): its clearing means the
            // plan may run alone now.
            var hadRow = sandboxRow != nil
            while !Task.isCancelled {
                let now = await app.goalPlans.sandbox(on: box)
                guard !Task.isCancelled else { return }
                reads += 1
                // While its sessions restart, a box may not answer for a moment: what it said last
                // stands until they've had their time.
                if !(restartingSessions && now == .unreadable) { sandbox = now }
                // The agents restarted (or none is outside any more), the sessions are back: nothing
                // more to wait for.
                if case .status(let status) = sandbox {
                    if status.outside != true { restartingAgents = false }
                    if !GoalSandbox.sessionsHold(status) { restartingSessions = false }
                }
                if restartingSessions, reads >= 7 {
                    restartingSessions = false
                    sandbox = now
                    sandboxFailure = "Sessions \(onThisMac ? "on this Mac" : "on \(computer)") haven’t restarted yet."
                }
                guard let row = sandboxRow else {
                    // Fixed since: the plan may run alone now, which its box says.
                    if hadRow { await app.goalPlans.read(box) }
                    return
                }
                hadRow = true
                guard row.checking else { return }
                try? await Task.sleep(for: .seconds(wait))
                wait = min(wait * 2, 60)
            }
        }
    }

    /// What's between the header and the buttons, as sections: the plan, what needs you first,
    /// how it runs, and the checks that passed, folded.
    private var middle: some View {
        VStack(alignment: .leading, spacing: 10) {
            planSection
            if !yours.isEmpty || sandboxItem != nil {
                GoalCardSection(symbol: "exclamationmark.triangle", tint: .orange, title: "Needs attention", caption: "Check before starting") {
                    VStack(spacing: 0) {
                        if let row = sandboxItem {
                            sandboxView(row)
                        }
                        ForEach(Array(yours.enumerated()), id: \.element.id) { index, check in
                            if index > 0 || sandboxItem != nil { Divider().padding(.leading, 32 + GoalCardMetrics.markWidth) }
                            GoalAttentionRow(text: check.text, detail: check.detail, mark: check.site.map { .site($0) }, symbol: Self.symbol(of: check),
                                             failed: check.state == .failed, button: check.action.map { action in (action.label, { open(action) }) },
                                             help: check.action?.kind == .open ? opensIn : nil)
                        }
                    }
                }
            }
            settingsSection
            if !plan.ready.isEmpty {
                GoalReadyFold(checks: plan.ready, box: box)
            }
            if let failure {
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .symbolRenderingMode(.multicolor)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.callout)
        .disabled(isAnswering)
    }

    /// A symbol for what the box checks itself, which names no service.
    static func symbol(of check: GoalPlan.Check) -> String? {
        switch check.id {
        case "power": "battery.25percent"
        case "projectsFolder": "folder"
        case "alone": "lock.shield"
        default: nil
        }
    }

    // MARK: The header

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            Group {
                if let bot {
                    BotAvatar(look: bot.look, size: 30, animates: false)
                } else {
                    Image(systemName: "scope").font(.title2).foregroundStyle(.tint)
                }
            }
            .frame(width: 30, height: 30)
            .accessibilityHidden(true)
            Divider()
                .frame(height: 30)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(plan.title ?? plan.goal)
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                // The goal in the bot's own words, under its name for it.
                if plan.title != nil {
                    Text(plan.goal)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .help(plan.goal)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: The sandbox row

    private var sandboxRow: GoalSandbox.Row? {
        // (The box attached in place is updated as a machine is, so it's named as one here.)
        GoalSandbox.row(sandbox, computer: box == BoxClient.mac ? computer : app.name(of: SidebarBox(id: box)), onThisMac: box == BoxClient.mac, bot: plan.name,
                        codingAgent: bot?.agents == true, restarting: restartingAgents, restartingSessions: restartingSessions)
    }

    /// Why the plan can't run alone, as the first thing that's yours: its first fix on the row,
    /// the rest (Report a Problem) in its menu.
    private var sandboxItem: GoalSandbox.Row? { plan.alone ? nil : sandboxRow }

    private func sandboxView(_ row: GoalSandbox.Row) -> some View {
        let first = row.buttons.first
        let detail = [row.text, sandboxFailure].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: "\n")
        return GoalAttentionRow(text: row.title,
                                detail: detail.isEmpty ? nil : detail,
                                symbol: "lock.shield",
                                failed: sandboxFailure != nil,
                                busy: row.checking || sandboxBusy,
                                button: first.map { button in (button.label, { act(button.action) }) },
                                more: row.buttons.dropFirst().map { button in (button.label, { act(button.action) }) })
            .disabled(sandboxBusy)
            .animation(.ui, value: row)
    }

    private func act(_ action: GoalSandbox.Action) {
        switch action {
        case .open(let url): NSWorkspace.shared.open(url)
        case .reportProblem: app.reportProblem()
        case .updateMachine: app.openSettings(.machines)
        case .checkForUpdates: updates.check()
        case .readAgain, .route, .restartAgents, .restartSessions:
            sandboxBusy = true
            sandboxFailure = nil
            Task {
                defer { sandboxBusy = false }
                if action == .restartAgents {
                    do {
                        try await app.goalPlans.sandboxRoute("POST", SandboxRoutes.restart, body: ["restart": true], on: box)
                        restartingAgents = true
                    } catch { sandboxFailure = error.localizedDescription }
                } else if case .restartSessions(let method, let path) = action {
                    do {
                        try await app.goalPlans.sandboxRoute(method, path, on: box)
                        restartingSessions = true
                    } catch { sandboxFailure = error.localizedDescription }
                } else if case .route(let method, let path) = action {
                    do { try await app.goalPlans.sandboxRoute(method, path, on: box) } catch { sandboxFailure = error.localizedDescription }
                    // Fixed, the plan may run alone now: its box says.
                    await app.goalPlans.read(box)
                }
                sandboxRound += 1
            }
        }
    }

    // MARK: The plan and how it runs

    /// The plan in a line, its steps in order (side by side where they start together), how
    /// many, and Review for the list of them.
    private var planSection: some View {
        GoalCardSection(symbol: "square.3.layers.3d", title: "Plan") {
            HStack(spacing: 10) {
                Text(GoalPlanWords.summary(plan))
                    .foregroundStyle(.secondary)
                    .fixedSize()
                Button("Review") { reviews = true }
                    .buttonStyle(GoalPillButtonStyle())
                    .fixedSize()
                    .popover(isPresented: $reviews, arrowEdge: .bottom) {
                        ScrollView {
                            GoalStagesView(plan: plan, timeline: GoalTimeline(plan, now: .now), isPaused: false)
                                .padding(16)
                        }
                        .frame(width: 560)
                        .frame(maxHeight: 520)
                    }
                    .help("The plan’s steps, in order")
            }
        } content: {
            Text(GoalPlanWords.flow(plan))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, GoalCardMetrics.markWidth + 10)
                .padding(.bottom, 10)
                .accessibilityLabel(GoalPlanWords.outline(plan))
        }
    }

    /// How it runs: its deadline, how often you hear, what it may spend, its projects and Wake me,
    /// each a row with its control on the right.
    private var settingsSection: some View {
        GoalCardSection(symbol: "slider.horizontal.3", title: "Execution settings", caption: "How the goal runs") {
            VStack(spacing: 0) {
                // How it runs first: its one setting with the bot's conversation.
                GoalSettingRow(symbol: AutopilotShown.symbol, title: "Autopilot") {
                    Toggle("Autopilot", isOn: $autopilot)
                        .toggleStyle(.switch)
                        .controlSize(.small)
                }
                Divider().padding(.leading, GoalCardMetrics.markWidth + 12)
                GoalSettingRow(symbol: "calendar", title: "Deadline", subtitle: "When it should be done") {
                    Picker("Deadline", selection: $deadline) {
                        ForEach(deadlineChoices, id: \.self) { choice in
                            Text(choice == .none ? "No deadline" : choice.words).tag(choice)
                        }
                    }
                }
                Divider().padding(.leading, GoalCardMetrics.markWidth + 12)
                GoalSettingRow(symbol: "waveform.path.ecg", title: "Progress updates", subtitle: "How often \(plan.name) reports back") {
                    Picker("Progress updates", selection: $digest) {
                        Text("When it’s done").tag(GoalPlan.Cadence.none)
                        Text("Daily").tag(GoalPlan.Cadence.day)
                        Text("Weekly").tag(GoalPlan.Cadence.week)
                        // An old goal's, set to hear after each of its phases: it keeps its pick.
                        if digest == .milestones {
                            Text("After each phase").tag(GoalPlan.Cadence.milestones)
                        }
                    }
                }
                ForEach(Array(plan.spend.enumerated()), id: \.offset) { index, line in
                    Divider().padding(.leading, GoalCardMetrics.markWidth + 12)
                    GoalSettingRow(symbol: "creditcard", title: plan.spend.count == 1 ? "Spending" : "Spending on \(line.what)", subtitle: plan.spend.count == 1 ? "On \(line.what)" : nil) {
                        // Named for its line, where there are several.
                        Picker(plan.spend.count == 1 ? "Most it may spend" : "Most it may spend on \(line.what)", selection: capBinding(index)) {
                            ForEach(Self.capChoices(line.cap), id: \.self) { cap in
                                Text(GoalPlanWords.money(cap, line.currency)).tag(cap)
                            }
                        }
                        Picker(plan.spend.count == 1 ? "Per" : "Per, on \(line.what)", selection: periodBinding(index)) {
                            ForEach(GoalPlan.Spend.Period.allCases, id: \.self) { period in
                                Text(Self.words(period)).tag(period)
                            }
                        }
                    }
                }
                if !plan.projects.isEmpty {
                    Divider().padding(.leading, GoalCardMetrics.markWidth + 12)
                    GoalProjectsRow(plan: plan, box: box, renames: $renamesProject) { projects in
                        failure = nil
                        Task {
                            do { try await app.goalPlans.answer(plan, on: box, .projects(projects)) } catch { failure = error.localizedDescription }
                        }
                    }
                }
                Divider().padding(.leading, GoalCardMetrics.markWidth + 12)
                GoalSettingRow(symbol: "bell", title: "Wake me", subtitle: "When something needs you, with a sound") {
                    Toggle("Wake me", isOn: $wake)
                        .toggleStyle(.switch)
                        .controlSize(.small)
                }
            }
        }
    }

    private func capBinding(_ index: Int) -> Binding<Double> {
        Binding(get: { caps.indices.contains(index) ? caps[index] : plan.spend[index].cap }, set: { if caps.indices.contains(index) { caps[index] = $0 } })
    }

    private func periodBinding(_ index: Int) -> Binding<GoalPlan.Spend.Period> {
        Binding(get: { periods.indices.contains(index) ? periods[index] : plan.spend[index].per }, set: { if periods.indices.contains(index) { periods[index] = $0 } })
    }

    /// The caps offered around the one the bot asked for: round amounts from a quarter of it to
    /// five times it, and itself.
    static func capChoices(_ cap: Double) -> [Double] {
        let round: [Double] = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000, 2500, 5000, 10000]
        let near = round.filter { $0 >= cap / 4 && $0 <= cap * 5 && $0 != cap }
        let below = near.filter { $0 < cap }.suffix(3), above = near.filter { $0 > cap }.prefix(4)
        return Array(below) + [cap] + Array(above)
    }

    static func words(_ period: GoalPlan.Spend.Period) -> String {
        switch period {
        case .goal: "in total"
        case .day: "a day"
        case .week: "a week"
        case .month: "a month"
        }
    }

    /// When it ends: none, or a day from now (the end of it), or the one the bot named.
    enum Deadline: Hashable {
        case none
        case days(Int)
        case at(Double)

        var words: String {
            switch self {
            case .none: "None"
            case .days(1): "Tomorrow"
            case .days(7): "In a week"
            case .days(14): "In 2 weeks"
            case .days(30): "In a month"
            case .days(let days): "In \(days) days"
            case .at(let ms): Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.month(.abbreviated).day())
            }
        }

        /// When it ends: the end of the day picked.
        func date(now: Date = .now, calendar: Calendar = .current) -> Date? {
            switch self {
            case .none: return nil
            case .at(let ms): return Date(timeIntervalSince1970: ms / 1000)
            case .days(let days):
                let day = calendar.date(byAdding: .day, value: days, to: calendar.startOfDay(for: now)) ?? now
                return calendar.date(bySettingHour: 23, minute: 59, second: 0, of: day)
            }
        }
    }

    private var deadlineChoices: [Deadline] {
        [.none] + (plan.ends.map { [Deadline.at($0)] } ?? []) + [.days(1), .days(3), .days(7), .days(14), .days(30)]
    }

    // MARK: Answers

    private func takeIn() {
        wake = plan.wake
        // As its conversation runs now, where it's on Autopilot already.
        autopilot = plan.mode == .autopilot || app.workspace.model(for: plan.session)?.isAutopilot == true
        digest = plan.digest
        deadline = plan.ends.map(Deadline.at) ?? .none
        caps = plan.spend.map(\.cap)
        periods = plan.spend.map(\.per)
    }

    /// "Opens in Pixel’s browser, so it can use your sign-in."
    private var opensIn: String { GoalPlanWords.opensIn(bot: plan.name, computer: onThisMac ? nil : computer) }

    /// A check's button: its page, in the bot's browser (a sign-in there is one it can use), or
    /// where new projects go (Settings › Worktrees, on its computer).
    private func open(_ action: GoalPlan.Check.Action) {
        switch action.kind {
        // (In the bot's browser: the app's own box's is the panel's; any other box's, the one
        // attached in place too, its own.)
        case .open: if let url = action.url { app.utilities.openForAgent(url, bot: plan.bot, machine: box == BoxClient.mac ? nil : box) }
        case .projectsFolder: app.openSettings(.worktrees, on: SidebarBox(id: box))
        }
    }

    private func send(_ action: GoalPlanAnswer.Action) {
        sent = action
        failure = nil
        let answer: GoalPlanAnswer = action == .start
            ? Self.start(plan, wake: wake, digest: digest, deadline: deadline, caps: caps, periods: periods, autopilot: autopilot)
            : .decline
        Task {
            do {
                try await app.goalPlans.answer(plan, on: box, answer)
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}

extension GoalCard {
    /// What Start Goal sends: Wake me, how often you hear, the end you picked, and each spend line's cap and period as you set them.
    static func start(_ plan: GoalPlan, wake: Bool, digest: GoalPlan.Cadence, deadline: Deadline,
                      caps: [Double], periods: [GoalPlan.Spend.Period], autopilot: Bool? = nil, now: Date = .now, calendar: Calendar = .current) -> GoalPlanAnswer {
        .start(wake: wake, digest: digest,
               ends: deadline.date(now: now, calendar: calendar),
               // None where the bot had proposed an end: no end.
               clearsEnd: deadline == .none && plan.ends != nil,
               spend: plan.spend.indices.map { index in
                   GoalPlanAnswer.SpendChange(cap: caps.indices.contains(index) ? caps[index] : plan.spend[index].cap,
                                              per: periods.indices.contains(index) ? periods[index] : plan.spend[index].per)
               },
               // None where the row doesn't show: the conversation stays as it runs.
               mode: autopilot.map { $0 ? .autopilot : .interactive })
    }
}

extension String {
    /// "This Mac" mid-sentence.
    var lowercasedThisMac: String { self == "This Mac" ? "this Mac" : self }
}

/// What only you can do, on a goal's card or under its lanes: an orange dot, what it is (with the
/// service's mark at its name) and why, and its button.
struct YoursRow: View {
    let text: String
    var detail: String?
    /// Said after it on its line, quieter ("since 12:20").
    var aside: String?
    /// The site's or app's mark, before its name and on its button.
    var mark: GoalPlanWords.StepMark?
    var failed = false
    var button: (String, () -> Void)?
    /// What the button does, under the pointer and to VoiceOver, where its words don't say.
    var help: String?
    /// Puts it away (what waits for you while it runs).
    var clear: (() -> Void)?
    /// A check is on its way: a spinner in place of the dot.
    var busy = false
    /// Less common actions, in a menu after the button.
    var more: [(String, () -> Void)] = []
    @Environment(\.colorScheme) private var scheme
    @Environment(\.goalBox) private var box

    var body: some View {
        // On one line where its words have room beside its button; in a narrow card, its button
        // under its words rather than the words squeezed to a word a line.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                dot
                words
                    .frame(minWidth: 180, idealWidth: 180, maxWidth: .infinity, alignment: .leading)
                controls
                clearButton
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 12) {
                    dot.padding(.top, 4)
                    words
                    Spacer(minLength: 0)
                    clearButton
                }
                if button != nil || !more.isEmpty {
                    HStack(spacing: 2) { controls }
                        .padding(.leading, 24)
                }
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .padding(.vertical, 9)
        .background(Color.orange.opacity(scheme == .dark ? 0.13 : 0.08), in: .rect(cornerRadius: 10))
    }

    private var dot: some View {
        Group {
            if busy {
                Spinner(size: 11)
            } else if failed {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(.orange)
            } else {
                Circle().fill(.orange).frame(width: 7, height: 7)
            }
        }
        .frame(width: 12)
        .accessibilityHidden(true)
    }

    private var words: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(ServiceText.text(text, mark: mark, on: box, scheme: scheme).fontWeight(aside == nil ? nil : .medium))\(aside.map { Text(" · \($0)").foregroundStyle(.secondary) } ?? Text(""))")
                .fixedSize(horizontal: false, vertical: true)
            if let detail {
                Text(detail)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.callout)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Yours: \(text)\([detail, aside].compactMap { $0 }.map { ", \($0)" }.joined())")
    }

    @ViewBuilder private var controls: some View {
        if let (label, action) = button {
            Button(action: action) {
                HStack(spacing: 5) {
                    if let mark { GoalServiceMark(mark: mark) }
                    Text(label)
                }
            }
            .buttonStyle(GoalPillButtonStyle())
            // Whole, its row's words wrapping before it: "Open Str…" says nothing.
            .fixedSize()
            .help(help ?? "")
            .accessibilityHint(help ?? "")
        }
        if !more.isEmpty {
            Menu {
                ForEach(more.indices, id: \.self) { index in
                    Button(more[index].0, action: more[index].1)
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 11, weight: .semibold))
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(IconButtonStyle(width: 22, height: 22))
            .foregroundStyle(.secondary)
            .help("More")
            .accessibilityLabel("More for \(text)")
        }
    }

    @ViewBuilder private var clearButton: some View {
        if let clear {
            Button("Put Away", systemImage: "xmark", action: clear)
                .font(.system(size: 10, weight: .semibold))
                .buttonStyle(IconButtonStyle(width: 22, height: 22))
                .foregroundStyle(.secondary)
                .help("Put it away: it no longer waits for you")
        }
    }
}

/// A button on a goal's card or under its lanes (Add, Open Stripe, Turn On Sandbox…): a soft
/// capsule that deepens under the pointer, solid rather than glass.
struct GoalPillButtonStyle: ButtonStyle {
    var bordered = false

    func makeBody(configuration: Configuration) -> some View {
        Pill(configuration: configuration, bordered: bordered)
    }

    private struct Pill: View {
        let configuration: ButtonStyleConfiguration
        let bordered: Bool
        @State private var isHovering = false
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.colorScheme) private var scheme

        var body: some View {
            let rest = scheme == .dark ? 0.1 : 0.06
            configuration.label
                .font(.callout)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .frame(minHeight: 28)
                .background(Capsule().fill(Color.primary.opacity(configuration.isPressed ? rest + 0.08 : isHovering ? rest + 0.04 : rest)))
                .overlay(Capsule().strokeBorder(bordered ? Color.primary.opacity(0.12) : .clear, lineWidth: 1))
                .contentShape(Capsule())
                .opacity(isEnabled ? 1 : 0.5)
                .onHover { isHovering = $0 }
                .clickablePointer()
                .animation(.easeOut(duration: 0.12), value: isHovering)
        }
    }
}
