import AppKit
import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI

/// The plan a bot puts to you for a goal, over its composer like the other cards that ask you
/// something: what only you can do first, each with its button, then what's ready; the plan in a
/// line; the limits as sentences you can change (what it may spend, when it ends, how often you
/// hear); a switch for each step that goes public, and whether what needs you wakes you. Not Now,
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

    @State private var switches: [String: Bool] = [:]
    @State private var wake = false
    @State private var digest: GoalPlan.Cadence = .none
    @State private var deadline: Deadline = .none
    @State private var caps: [Double] = []
    @State private var periods: [GoalPlan.Spend.Period] = []
    @State private var sandbox: GoalSandbox.Reading?
    @State private var sandboxBusy = false
    @State private var failure: String?
    @State private var sent: GoalPlanAnswer.Action?
    /// How tall what's between its header and its buttons can be before it scrolls.
    @Environment(\.cardRoom) private var room
    @State private var middleHeight: CGFloat = 0
    /// Bumped to read the sandbox again (after its fix ran).
    @State private var sandboxRound = 0

    private var isAnswering: Bool { app.goalPlans.answering.contains(plan.id) }
    private var onThisMac: Bool { box == BoxClient.mac }
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
                    .keyboardShortcut(takesKeys ? .cancelAction : nil)
                    .help("Put the plan away: \(plan.name) doesn’t start it")
                Spacer()
                if isAnswering, sent == .start {
                    Spinner()
                        .accessibilityLabel("Starting the goal")
                }
                Button(plan.alone ? "Start Goal" : "Start With Me Here") { send(.start) }
                    .buttonStyle(.glassProminent)
                    .keyboardShortcut(takesKeys ? .defaultAction : nil)
                    .help(plan.alone ? "\(plan.name) works through the plan on \(computer.lowercasedThisMac), with the window closed too"
                                     : "\(plan.name) works through the plan while you’re here")
            }
            .buttonStyle(.glass)
            .controlSize(.large)
            .disabled(isAnswering)
        }
        .padding(16)
        .onAppear(perform: takeIn)
        .onChange(of: plan.id) { takeIn() }
        .task(id: "\(plan.id)|\(box)|\(plan.alone)|\(sandboxRound)") {
            guard !plan.alone else { return }
            // Read again while it's being checked, less often each time.
            var wait = 2.0
            while !Task.isCancelled {
                sandbox = await app.goalPlans.sandbox(on: box)
                guard case .status(let status) = sandbox, status.reason == "checking" else { return }
                try? await Task.sleep(for: .seconds(wait))
                wait = min(wait * 2, 60)
            }
        }
    }

    /// The checks and the limits, between the header and the buttons.
    private var middle: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !plan.alone, let row = sandboxRow {
                sandboxView(row)
            }
            if !yours.isEmpty {
                VStack(spacing: 4) {
                    ForEach(yours) { check in
                        YoursRow(text: check.text, detail: check.detail, site: check.site, failed: check.state == .failed, button: check.action.map { action in
                            (action.label, { open(action) })
                        })
                    }
                }
            }
            if !plan.ready.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(plan.ready) { check in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.green)
                                .accessibilityHidden(true)
                            Text("\(ServiceText.text(check.text, site: check.site, scheme: scheme))\(check.detail.map { Text("  \($0)").foregroundStyle(.secondary) } ?? Text(""))")
                                .font(.callout)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.horizontal, 6)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Ready: \(check.text)\(check.detail.map { ", \($0)" } ?? "")")
                    }
                }
            }
            limits
            if let failure {
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .symbolRenderingMode(.multicolor)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: The header

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Group {
                if let bot {
                    BotAvatar(look: bot.look, size: 24, animates: false)
                } else {
                    Image(systemName: "scope").font(.title3).foregroundStyle(.tint)
                }
            }
            .frame(width: 24, height: 24)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(plan.title ?? plan.goal)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                Text(subtitle)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// "Pixel’s plan. Two things are yours first; the rest is ready."
    private var subtitle: String {
        let count = yours.count
        let first = count == 0 ? "" : count == 1 ? " One thing is yours first" : " \(Self.spelled(count).capitalized) things are yours first"
        let rest = plan.ready.isEmpty ? (count == 0 ? "" : ".") : (count == 0 ? " Everything’s ready." : "; the rest is ready.")
        return "\(plan.name)’s plan.\(first)\(rest)"
    }

    static func spelled(_ count: Int) -> String {
        count < 10 ? (NumberFormatter.localizedString(from: count as NSNumber, number: .spellOut)) : "\(count)"
    }

    // MARK: The sandbox row

    private var sandboxRow: GoalSandbox.Row? {
        GoalSandbox.row(sandbox, computer: computer, onThisMac: onThisMac, bot: plan.name,
                        agent: bot?.agents == true ? OutsideAgents.name(bot?.model?.providerID) : nil)
    }

    private func sandboxView(_ row: GoalSandbox.Row) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Group {
                if row.checking || sandboxBusy {
                    Spinner(size: 14)
                } else {
                    Image(systemName: "checkmark.shield")
                        .font(.system(size: 15))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 18)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.title)
                    .font(.callout.weight(.semibold))
                if !row.text.isEmpty {
                    Text(row.text)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                ForEach(row.buttons, id: \.label) { button in
                    Button(button.label) { act(button.action) }
                        .buttonStyle(GoalPillButtonStyle(bordered: true))
                        .disabled(sandboxBusy)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Color.primary.opacity(scheme == .dark ? 0.06 : 0.045), in: .rect(cornerRadius: 10))
        .animation(.ui, value: row)
    }

    private func act(_ action: GoalSandbox.Action) {
        switch action {
        case .open(let url): NSWorkspace.shared.open(url)
        case .reportProblem: app.reportProblem()
        case .updateMachine: app.openSettings(.machines)
        case .checkForUpdates: updates.check()
        case .editBot: if let bot { app.tabs.openBotEditor(bot: bot) }
        case .readAgain, .route:
            sandboxBusy = true
            Task {
                defer { sandboxBusy = false }
                if case .route(let method, let path) = action {
                    do { try await app.goalPlans.sandboxRoute(method, path, on: box) } catch { failure = error.localizedDescription }
                    // Fixed, the plan may run alone now: its box says.
                    await app.goalPlans.read(box)
                }
                sandboxRound += 1
            }
        }
    }

    // MARK: Limits and switches

    private var limits: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Plan")
                    Spacer(minLength: 8)
                    Text(GoalPlanWords.summary(plan))
                        .foregroundStyle(.secondary)
                }
                Text(GoalPlanWords.outline(plan))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 10)
            .accessibilityElement(children: .combine)
            ForEach(Array(plan.spend.enumerated()), id: \.offset) { index, line in
                Divider()
                LimitRow(label: plan.spend.count == 1 ? "Spending" : "Spending on \(line.what)") {
                    Text("up to")
                        .foregroundStyle(.secondary)
                    Picker("Most it may spend", selection: capBinding(index)) {
                        ForEach(Self.capChoices(line.cap), id: \.self) { cap in
                            Text(GoalPlanWords.money(cap, line.currency)).tag(cap)
                        }
                    }
                    Picker("Per", selection: periodBinding(index)) {
                        ForEach(GoalPlan.Spend.Period.allCases, id: \.self) { period in
                            Text(Self.words(period)).tag(period)
                        }
                    }
                }
            }
            Divider()
            LimitRow(label: "Deadline") {
                Picker("Deadline", selection: $deadline) {
                    ForEach(deadlineChoices, id: \.self) { choice in
                        Text(choice.words).tag(choice)
                    }
                }
            }
            Divider()
            LimitRow(label: "Updates") {
                Picker("Updates", selection: $digest) {
                    Text("When it’s done").tag(GoalPlan.Cadence.none)
                    Text("Daily").tag(GoalPlan.Cadence.day)
                    Text("Weekly").tag(GoalPlan.Cadence.week)
                    if plan.phases.count > 1 || digest == .milestones {
                        Text("After each phase").tag(GoalPlan.Cadence.milestones)
                    }
                }
            }
            ForEach(plan.public) { item in
                Divider()
                SwitchRow(label: item.text, isOn: Binding(get: { switches[item.id] ?? item.on }, set: { switches[item.id] = $0 }))
            }
            Divider()
            SwitchRow(label: "Wake me if something needs me", isOn: $wake)
                .help("Notifications from this goal make a sound and show while you’re away")
        }
        .font(.callout)
        .padding(.horizontal, 14)
        .padding(.vertical, 2)
        .background(Color.primary.opacity(scheme == .dark ? 0.06 : 0.045), in: .rect(cornerRadius: 10))
        .disabled(isAnswering)
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
        switches = Dictionary(uniqueKeysWithValues: plan.public.map { ($0.id, $0.on) })
        wake = plan.wake
        digest = plan.digest
        deadline = plan.ends.map(Deadline.at) ?? .none
        caps = plan.spend.map(\.cap)
        periods = plan.spend.map(\.per)
    }

    /// A check's button: its page, or where new projects go (Settings › Worktrees, on its computer).
    private func open(_ action: GoalPlan.Check.Action) {
        switch action.kind {
        case .open: if let url = action.url { NSWorkspace.shared.open(url) }
        case .projectsFolder: app.openSettings(.worktrees, on: SidebarBox(machine: onThisMac ? nil : box))
        }
    }

    private func send(_ action: GoalPlanAnswer.Action) {
        sent = action
        failure = nil
        let answer: GoalPlanAnswer = action == .start
            ? Self.start(plan, switches: switches, wake: wake, digest: digest, deadline: deadline, caps: caps, periods: periods)
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
    /// What Start Goal sends: each public step's switch, Wake me, how often you hear, the end
    /// you picked, and each spend line's cap and period as you set them.
    static func start(_ plan: GoalPlan, switches: [String: Bool], wake: Bool, digest: GoalPlan.Cadence, deadline: Deadline,
                      caps: [Double], periods: [GoalPlan.Spend.Period], now: Date = .now, calendar: Calendar = .current) -> GoalPlanAnswer {
        .start(public: Dictionary(uniqueKeysWithValues: plan.public.map { ($0.id, switches[$0.id] ?? $0.on) }), wake: wake, digest: digest,
               ends: deadline.date(now: now, calendar: calendar),
               // None where the bot had proposed an end: no end.
               clearsEnd: deadline == .none && plan.ends != nil,
               spend: plan.spend.indices.map { index in
                   GoalPlanAnswer.SpendChange(cap: caps.indices.contains(index) ? caps[index] : plan.spend[index].cap,
                                              per: periods.indices.contains(index) ? periods[index] : plan.spend[index].per)
               })
    }
}

private extension String {
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
    var site: String?
    var failed = false
    var button: (String, () -> Void)?
    /// Puts it away (what waits for you while it runs).
    var clear: (() -> Void)?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if failed {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                } else {
                    Circle().fill(.orange).frame(width: 7, height: 7)
                }
            }
            .frame(width: 12)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(ServiceText.text(text, site: site, scheme: scheme).fontWeight(aside == nil ? nil : .medium))\(aside.map { Text(" · \($0)").foregroundStyle(.secondary) } ?? Text(""))")
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
            Spacer(minLength: 8)
            if let (label, action) = button {
                Button(action: action) {
                    HStack(spacing: 5) {
                        if let site { SiteServiceMark(site: site) }
                        Text(label)
                    }
                }
                .buttonStyle(GoalPillButtonStyle())
            }
            if let clear {
                Button("Put Away", systemImage: "xmark", action: clear)
                    .font(.system(size: 10, weight: .semibold))
                    .buttonStyle(IconButtonStyle(width: 22, height: 22))
                    .foregroundStyle(.secondary)
                    .help("Put it away: it no longer waits for you")
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .padding(.vertical, 9)
        .background(Color.orange.opacity(scheme == .dark ? 0.13 : 0.08), in: .rect(cornerRadius: 10))
    }
}

/// A row of the card's limits: what it is, and its controls at the end, as a sentence.
private struct LimitRow<Controls: View>: View {
    let label: String
    @ViewBuilder let controls: () -> Controls

    var body: some View {
        // On one line where it fits; in a narrow card, its controls under its name.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                Text(label)
                    .fixedSize()
                Spacer(minLength: 8)
                choices
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(label)
                HStack(spacing: 8) { choices }
            }
            .padding(.vertical, 8)
        }
        .frame(minHeight: 36)
    }

    private var choices: some View {
        controls()
            .pickerStyle(.menu)
            .labelsHidden()
            .fixedSize()
    }
}

private struct SwitchRow: View {
    let label: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            Text(label)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.switch)
        .controlSize(.small)
        .frame(minHeight: 36)
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
