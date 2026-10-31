import ClientDesign
import ClientSessions
import ClientText
import OpenCodeKit
import SwiftUI

struct SessionView: View {
    let model: SessionModel
    /// Whether the window shows the conversations at all (not with Settings over them).
    @Environment(\.isConversationShown) private var isInSight
    @Environment(Catalog.self) private var catalog
    @Environment(AppModel.self) private var app
    @LastModel private var lastModel
    @State private var height: CGFloat = 0

    /// The conversations seen last, newest first, kept made (hidden) for going back to them.
    @State private var kept: [SessionModel] = []
    /// The size each kept one had as it went out of view, which it keeps while hidden: resizing
    /// the window lays out only the one in view.
    @State private var hiddenSizes: [String: CGSize] = [:]
    @State private var size: CGSize = .zero

    var body: some View {
        ZStack {
            // One for each session, kept for the few seen last: going back to one shows it as it
            // was, rather than making it again. What's around them (the composer below) stays as
            // you go from one to another: it keeps the keyboard, and isn't made again each time.
            ForEach(Self.shown(model, kept: kept), id: \.id) { each in
                let isShown = each.id == model.id
                let hiddenSize = isShown ? nil : hiddenSizes[each.id]
                TranscriptView(model: each)
                    .frame(width: hiddenSize?.width, height: hiddenSize?.height)
                    // However big that was, the stack is the size it's given.
                    .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .top)
                    .opacity(isShown ? 1 : 0)
                    .allowsHitTesting(isShown)
                    .accessibilityHidden(!isShown)
                    .environment(\.isConversationShown, isShown && isInSight)
                    .zIndex(isShown ? 1 : 0)
                    .environment(\.isOffline, Self.offlineMachine(of: each, in: app) != nil)
            }
        }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
        .onChange(of: model.id, initial: true) { old, new in
            kept = Array(([model] + kept.filter { $0.id != new }).prefix(Self.keptCount))
            hiddenSizes[old] = size
            hiddenSizes[new] = nil
            hiddenSizes = hiddenSizes.filter { id, _ in kept.contains { $0.id == id } }
        }
        .conversationBar {
            BottomStack(model: model, lastModel: $lastModel)
                // Room for the composer, the cards' own buttons and a little conversation.
                .environment(\.cardRoom, max(160, height - 440))
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        // Its machine out of reach: the conversation to read, without what needs the engine.
        .environment(\.isOffline, Self.offlineMachine(of: model, in: app) != nil)
        .navigationTitle(model.session.title ?? "New Session")
        // A conversation as last seen is read once its machine is back.
        // A copy shown while the engine reads (this Mac's) is read too; one waiting for its
        // machine is read once the machine is back.
        .task(id: model.id) { if !model.isLoaded, !model.waitsForEngine { await model.load() } }
        .task(id: model.session.location.directory) { await catalog.loadCommands(in: model.session.location.directory) }
        // What its agent asks of its computer's vault, followed while it's open (VaultAskCards).
        .task(id: Workspace.box(of: model.session.location.directory)) { await Vaults.shared.follow(Workspace.box(of: model.session.location.directory)) }
        // Its wake-ups and watches, read again as each run ends (its agent may have set one,
        // or one went); a bot's are its row's to read.
        .task(id: "\(model.id) \(model.isRunning)") {
            guard !model.isRunning, app.bots.bot(forSession: model.id) == nil else { return }
            await app.wakeUps.read(WakeUps.owner(of: model.session))
        }
    }

    #if DEBUG
    /// KUVO_PERF_KEPT=<n>: that many kept instead (1: none but the one in view), to compare.
    static let keptCount = ProcessInfo.processInfo.environment["KUVO_PERF_KEPT"].flatMap(Int.init) ?? 4
    #else
    static let keptCount = 4
    #endif

    /// The kept conversations, with the one in view among them.
    private static func shown(_ model: SessionModel, kept: [SessionModel]) -> [SessionModel] {
        kept.contains { $0.id == model.id } ? kept : [model] + kept.prefix(keptCount - 1)
    }

    /// The machine a session runs on, while it can't be reached (connecting again), or its
    /// conversation hasn't taken the new connection yet.
    static func offlineMachine(of model: SessionModel, in app: AppModel) -> MachineEngine? {
        guard let id = RemoteFolder.machine(of: model.session.location.directory), let engine = app.machines.engine(id) else { return nil }
        return engine.isReady && engine.isLive && app.workspace.isConnected(id) && !model.isCopy ? nil : engine
    }
}

/// Something that didn't work (a message that didn't go, an undo), over the composer until you
/// dismiss it or send again.
struct FailureBar: View {
    let text: String
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 1) {
                Text("Something went wrong")
                    .font(.system(size: 13, weight: .medium))
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 8)
            Button(action: dismiss) { Image(systemName: "xmark") }
                .buttonStyle(IconButtonStyle())
                .help("Dismiss")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

extension EnvironmentValues {
    /// The conversation's machine is out of reach: what needs its engine (undo, try again) waits.
    @Entry var isOffline = false
    /// The conversation shown takes no messages (a review's part, watched, not steered): nothing
    /// offers to send one, Try Again included.
    @Entry var takesNoMessages = false
}

/// What's over the conversation's end: questions and permission requests as solid cards, then
/// one card holding the bars (a goal, a review, a side question, work out of sight), the messages
/// waiting, and the composer.
private struct BottomStack: View {
    @Bindable var model: SessionModel
    @Binding var lastModel: ModelRef?
    @Environment(Catalog.self) private var catalog
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    @AppStorage(ToolApproval.key) private var defaultApproval = ToolApproval.approveAll
    @Environment(\.takesCardKeys) private var takesCardKeys
    /// Each conversation's card as it was last seen here: which bar is open once it's full
    /// (`BarFolds`), and the bars and news it had, so coming back to it reads what changed
    /// meanwhile. This stack stays as you switch conversations.
    private struct Card {
        var folds = BarFolds<ComposerBar>()
        var bars: [ComposerBar]?
        var news: [ComposerBar: Bool]?
    }
    @State private var cards: [String: Card] = [:]
    /// The waiting messages, open under their line once there are more than two.
    @State private var queueOpen = false

    private var folds: BarFolds<ComposerBar> {
        get { cards[model.id]?.folds ?? BarFolds() }
        nonmutating set { cards[model.id, default: Card()].folds = newValue }
    }

    /// Whether its bars are tucked into one line: as you left them in this conversation, until
    /// you bring them back (nothing does by itself), or none are left.
    private var tucked: Bool { model.tuck.isOn(among: liveBars) }

    /// The bars but those put away, whose Undo shows in their place for a moment: what Hide
    /// tucks away, and what its line names.
    private var liveBars: [ComposerBar] {
        bars.filter { bar in
            switch bar {
            case .goal: model.goal.map { model.putAways.text(.goal(started: $0.started)) == nil } ?? true
            case .review: model.review.map { model.putAways.text(.review($0.id)) == nil } ?? true
            default: true
            }
        }
    }

    /// Each bar in a few words, for the line they're tucked into.
    private func stripItems(now: Date) -> [BarStripItem] {
        liveBars.map { bar in
            switch bar {
            case .goal:
                if let plan = shownPlan?.plan {
                    let words = plan.state == .done ? "Goal met" : plan.state == .stopped ? "Goal stopped" : "Goal · \(GoalPlanWords.progress(plan))"
                    return BarStripItem(bar: bar, symbol: plan.state == .done ? "checkmark.circle.fill" : "scope", isDone: plan.state == .done, words: words)
                }
                let state = model.goal?.state
                let words = state == .met ? "Goal met" : state == .unmet ? "Goal can’t be met" : state == .paused ? "Goal paused" : "Goal"
                return BarStripItem(bar: bar, symbol: state == .met ? "checkmark.circle.fill" : "scope", isDone: state == .met, words: words)
            case .handoff:
                let state = model.handoff?.state
                return BarStripItem(bar: bar, symbol: state == .writing ? nil : Keyword.handoff.symbol, words: state == .writing ? "Handing off…" : state == .failed ? "Couldn’t hand off" : "Handed off")
            case .review:
                guard let review = model.review else { return BarStripItem(bar: bar, symbol: Keyword.review.symbol, words: "Review") }
                switch review.state {
                case .reviewing: return BarStripItem(bar: bar, symbol: nil, words: "Reviewing…")
                case .failed: return BarStripItem(bar: bar, symbol: "exclamationmark.circle", words: "Review couldn’t be done")
                case .done: return review.findings.isEmpty
                    ? BarStripItem(bar: bar, symbol: "checkmark.circle.fill", isDone: true, words: "Nothing to fix")
                    : BarStripItem(bar: bar, symbol: Keyword.review.symbol, words: "Review · \(review.findings.count)")
                }
            case .sideQuestion:
                let answering = model.shownSideThread?.latest.state == .answering
                return BarStripItem(bar: bar, symbol: answering ? nil : Keyword.btw.symbol, words: answering ? "Answering…" : (model.shownSideThread?.questions.count ?? 1) > 1 ? "Side thread" : "Side question")
            case .subagents:
                return BarStripItem(bar: bar, symbol: nil, words: subagentsAtWork.count == 1 ? "A subagent" : "\(subagentsAtWork.count) subagents")
            case .work:
                return BarStripItem(bar: bar, symbol: workReport?.atWork.isEmpty == false ? nil : "checkmark.circle", words: BotWorkBar.title(workReport))
            case .background:
                return BarStripItem(bar: bar, symbol: nil, words: "\(backgroundJobs.count) running")
            case .wakes:
                let owner = wakeOwner
                let wakes = owner.map { app.wakeUps.wakes[$0.key] ?? [] } ?? []
                let watches = owner.map { app.wakeUps.watches[$0.key] ?? [] } ?? []
                let paused = owner.map { app.wakeUps.paused.contains($0.key) } ?? false
                return BarStripItem(bar: bar, symbol: wakes.isEmpty ? "eye" : "alarm", words: WakeBar.headline(paused: paused, wakes: wakes, watches: watches, now: now))
            }
        }
    }

    /// What changed in the card, and in which conversation: another conversation's bars, news or
    /// side question aren't a change in this one's.
    private struct Seen<Value: Equatable>: Equatable {
        var conversation: String
        var value: Value
    }

    /// The bars showing in the card, in its order.
    private var bars: [ComposerBar] {
        var bars: [ComposerBar] = []
        if model.goal != nil || shownPlan != nil { bars.append(.goal) }
        if let handoff = model.handoff, handoff != model.putAwayHandoff { bars.append(.handoff) }
        if model.review != nil { bars.append(.review) }
        if let id = model.shownSideQuestion, model.sideQuestions.contains(where: { $0.id == id }) { bars.append(.sideQuestion) }
        if !subagentsAtWork.isEmpty { bars.append(.subagents) }
        if BotWorkBar.shows(workReport) { bars.append(.work) }
        if !backgroundJobs.isEmpty { bars.append(.background) }
        if wakeOwner != nil { bars.append(.wakes) }
        return bars
    }

    /// A card over the composer asks you something: it's what needs you, and the bars fold.
    private var isAsking: Bool {
        !model.permissions.isEmpty || !forms.isEmpty || !app.browserAsks.asks(for: model.session.id).isEmpty || !app.botAsks.asks(for: model.session.id).isEmpty
            || proposedPlan != nil
    }

    /// A bot's goal whose plan waits for you, for its card.
    private var proposedPlan: (box: String, plan: GoalPlan)? {
        app.goalPlans.plan(for: model.id).flatMap { $0.plan.isProposed ? $0 : nil }
    }

    /// A bot's goal under way (or over, and not put away), in the goal bar's place.
    private var shownPlan: (box: String, plan: GoalPlan)? {
        guard let found = app.goalPlans.plan(for: model.id), [.running, .done, .stopped].contains(found.plan.state),
              !app.goalPlans.putAway.contains(found.plan.id) else { return nil }
        return found
    }

    /// Whether a bar is folded: its own way with fewer than three, the card's with more.
    private func hidden(_ bar: ComposerBar, _ own: Binding<Bool>) -> Binding<Bool> {
        Binding(get: { folds.isHidden(bar, among: bars, asking: isAsking, own: own.wrappedValue) },
                set: { hidden in
                    var left = own.wrappedValue
                    folds.set(bar, hidden: hidden, among: bars, own: &left)
                    if left != own.wrappedValue { own.wrappedValue = left }
                })
    }

    /// What in a bar is worth opening it for: a review that found something, a side question
    /// answered, a goal that's over or that the box paused for you. A bar that only says it's at
    /// work isn't, nor a goal you paused yourself.
    private var news: [ComposerBar: Bool] {
        [.review: model.review.map { $0.state == .done && !$0.findings.isEmpty } ?? false,
         .sideQuestion: model.shownSideThread?.latest.state == .answered,
         .goal: shownPlan.map { !$0.plan.waiting.isEmpty || $0.plan.state != .running } ?? model.goal.map { goal in
             goal.state == .met || goal.state == .unmet || (goal.state == .paused && (goal.pausedBy == .error || goal.pausedBy == .stalled))
         } ?? false]
    }

    /// Each bar's own way, folded or not, for when the card isn't full.
    private func own(_ bar: ComposerBar) -> Binding<Bool> {
        switch bar {
        case .goal: $model.hidesGoal
        case .review: $model.hidesReview
        case .sideQuestion: $model.hidesSideQuestion
        case .subagents: $model.hidesSubagents
        case .work: $model.hidesWork
        case .background: $model.hidesBackgroundJobs
        case .wakes: $model.hidesWakes
        case .handoff: .constant(true)
        }
    }

    /// The bot this conversation is, whose sessions show in a bar over its composer.
    private var workBot: Bot? { app.bots.bot(forSession: model.id) }

    /// Its sessions as its box last told them.
    private var workReport: BotWorkReport? { workBot.flatMap { app.botWork.reports[$0.id] } }

    /// What its work is read again on: a session of it started, at work or asking, or done, and the
    /// bot hearing of one (each wake comes to its conversation). Not each step a session takes.
    private var workChanges: String? {
        guard let bot = workBot else { return nil }
        let changes = workspace.sessions.lazy.filter { WorksFor($0)?.bot == bot.id }
            .map { "\($0.id)\(workspace.isWorking($0.id) ? "w" : "")\(workspace.needsAttention($0.id) ? "a" : "")" }
        return bot.id + "\(workspace.session(bot.sessionID)?.time.updated ?? 0)" + changes.joined(separator: ",")
    }

    /// Commands its agent left running, which the conversation doesn't show as they run: once
    /// they've run a moment (see `Workspace.lastingShellJobs`).
    private var backgroundJobs: [ShellJob] {
        (workspace.shellJobs[model.id] ?? []).filter { workspace.lastingShellJobs.contains($0.id) && !model.inlineShells.contains($0.id) }
    }

    /// Its wake-ups and watches, when it keeps any: not a bot's, which Edit Bot and its row show.
    private var wakeOwner: WakeUps.Owner? {
        guard app.bots.bot(forSession: model.id) == nil else { return nil }
        let owner = WakeUps.owner(of: model.session)
        let waiting = !(app.wakeUps.wakes[owner.key] ?? []).isEmpty || !(app.wakeUps.watches[owner.key] ?? []).isEmpty
        return waiting ? owner : nil
    }

    /// What the composer offers after "/" besides the keywords: the engine's commands and yours,
    /// the engine's own /review as /review-quick where the keyword has the name.
    private var commands: [Command] {
        Keyword.commands(catalog.commands(in: model.session.location.directory), keywords: model.keywords)
    }



    /// Subagents its agent handed work to that are at it now.
    private var subagentsAtWork: [SessionModel.Subagent] {
        model.subagents.filter { workspace.isWorking($0, for: model.id) }
    }

    var body: some View {
        Group {
            VStack(spacing: 12) {
                // What asks you something: solid cards over the composer's, apart from it.
                ForEach(model.permissions) { request in
                    PermissionCard(request: request, command: model.permissionCommands[request.id], directory: model.session.location.directory) { decision in
                        model.reply(to: request, decision)
                    }
                    .disabled(offlineMachine != nil)
                    .modifier(ComposerSurface())
                }
                ForEach(Array(forms.enumerated()), id: \.element.id) { index, form in
                    QuestionCard(form: form, progress: Binding(get: { model.questionProgress[form.id] ?? QuestionProgress() }, set: { model.questionProgress[form.id] = $0 }),
                                 takesKeys: index == 0 && takesCardKeys) { answer in
                        model.answer(form, with: FormFieldsView.payload(form.fields, answer))
                    } dismiss: {
                        model.dismiss(form)
                    }
                    .disabled(offlineMachine != nil)
                    .modifier(ComposerSurface())
                }
                ForEach(app.browserAsks.asks(for: model.session.id)) { ask in
                    BrowserAskCard(ask: ask)
                        .modifier(ComposerSurface())
                }
                // What its agent asks of its computer's vault.
                VaultAskCards(session: model.session.id, box: Workspace.box(of: model.session.location.directory))
                // What its agent asks to run outside its computer's sandbox.
                SandboxAskCards(session: model.session.id, box: Workspace.box(of: model.session.location.directory))
                    .environment(\.takesCardKeys, takesCardKeys && model.permissions.isEmpty && forms.isEmpty)
                    .disabled(offlineMachine != nil)
                ForEach(Array(app.botAsks.asks(for: model.session.id).enumerated()), id: \.element.ask.id) { index, item in
                    WorkAskCard(ask: item.ask, box: item.box) { model.failure = $0 }
                        // Return and Escape answer the first card only.
                        .environment(\.takesCardKeys, takesCardKeys && index == 0 && model.permissions.isEmpty && forms.isEmpty
                                     && Sandboxes.shared.asks(for: model.session.id, on: Workspace.box(of: model.session.location.directory)).isEmpty)
                        .modifier(ComposerSurface())
                }
                if let (box, plan) = proposedPlan {
                    GoalCard(plan: plan, box: box)
                        .environment(\.takesCardKeys, takesCardKeys && model.permissions.isEmpty && forms.isEmpty && app.botAsks.asks(for: model.session.id).isEmpty)
                        .disabled(offlineMachine != nil && box != BoxClient.mac)
                        .modifier(ComposerSurface())
                }
                // What went wrong, over the composer rather than in an alert you must click away.
                if let failure = model.failure, offlineMachine == nil {
                    FailureBar(text: failure) { model.failure = nil }
                        .modifier(ComposerSurface())
                        .transition(.opacity)
                }
                if let engine = offlineMachine {
                    MachineOfflineBar(engine: engine)
                        .modifier(ComposerSurface())
                        .transition(.opacity)
                }
                // Two bars or more: one tab, just over the card's edge (clear of its bars'
                // buttons), tucks them all into a line.
                if liveBars.count >= 2, !tucked {
                    HStack {
                        Spacer()
                        HideBarsTab { model.tuck.hide() }
                    }
                    // Its end over the bars' ✕ itself (narrower than its button).
                    .padding(.trailing, BarEnd.trailing + 8)
                    .padding(.bottom, -8)
                    .transition(.opacity)
                }
                // The bars, what's waiting and the composer: one card.
                VStack(spacing: 0) {
                    if tucked {
                        // Kept current: a wake-up's "in 2 minutes".
                        TimelineView(.periodic(from: .now, by: 30)) { context in
                            BarStrip(items: stripItems(now: context.date), marked: model.tuck.marked) { model.tuck.show() }
                        }
                        .modifier(CardRow())
                        .transition(.fold)
                    } else {
                        if let goal = model.goal, let text = model.putAways.text(.goal(started: goal.started)) {
                            let item = PutAway.goal(started: goal.started)
                            UndoLine(text: text, undo: model.putAways.canUndo(item) ? { model.putAways.undo(item) } : nil)
                                .modifier(CardRow())
                                .transition(.fold)
                        } else if let (box, plan) = shownPlan {
                            GoalPlanBar(plan: plan, box: box, goal: model.goal, isHidden: hidden(.goal, $model.hidesGoal), isChanging: model.isChangingGoal || offlineMachine != nil) {
                                model.changeGoal(.pause)
                            } resume: {
                                model.changeGoal(.resume)
                            } putAway: {
                                app.goalPlans.putAway.insert(plan.id)
                                if model.goal?.isOver == true { model.putAwayGoal() }
                            } failed: { model.failure = $0 }
                            .modifier(CardRow())
                            .transition(.fold)
                        } else if let goal = model.goal {
                            GoalBar(goal: goal, isHidden: hidden(.goal, $model.hidesGoal), isChanging: model.isChangingGoal || offlineMachine != nil, hasWaiting: !model.waiting.isEmpty) {
                                model.changeGoal(.pause)
                            } resume: {
                                model.changeGoal(.resume)
                            } stop: {
                                model.stopGoal()
                            } done: {
                                model.putAwayGoal()
                            }
                            .modifier(CardRow())
                            .transition(.fold)
                        }
                        KeywordBars(model: model, hidden: hidden)
                        if !subagentsAtWork.isEmpty {
                            SubagentsBar(subagents: subagentsAtWork, folder: model.session.location.directory, isHidden: hidden(.subagents, $model.hidesSubagents))
                                .modifier(CardRow())
                                .transition(.fold)
                        }
                        if let bot = workBot, let report = workReport, BotWorkBar.shows(report) {
                            BotWorkBar(bot: bot, report: report, isHidden: hidden(.work, $model.hidesWork))
                                .modifier(CardRow())
                                .transition(.fold)
                        }
                        if !backgroundJobs.isEmpty {
                            BackgroundBar(jobs: backgroundJobs, api: workspace.api(forSession: model.id), directory: model.session.location.directory, isHidden: hidden(.background, $model.hidesBackgroundJobs)) { job in
                                Task { await workspace.stopShellJob(job, in: model.id) }
                            }
                            .modifier(CardRow())
                            .transition(.fold)
                        }
                        if let owner = wakeOwner {
                            WakeBar(owner: owner, isHidden: hidden(.wakes, $model.hidesWakes))
                                .modifier(CardRow())
                                .transition(.fold)
                        }
                    }
                    // What's waiting for the agent (and the message just removed, for Undo).
                    if !model.waiting.isEmpty || model.putAways.isPutAway(.message) {
                        QueueDock(model: model, inCard: true, isOpen: $queueOpen)
                            .modifier(CardRow())
                            .transition(.fold)
                    }
                    Composer(
                        session: model.id,
                        text: $model.draftText,
                        files: $model.draftFiles,
                        quotes: $model.draftQuotes,
                        quoteFocus: model.quoteFocus,
                        agent: model.agent,
                        approval: model.approval,
                        model: model.session.model ?? catalog.startingModel(lastModel),
                        modelInUse: model.modelInUse,
                        isRunning: model.isRunning,
                        hasQueue: !model.waiting.isEmpty,
                        history: { model.sentMessages },
                        folders: [model.session.location.directory] + workspace.extraFolders(model.session.location.directory),
                        commands: commands,
                        keywords: model.keywords,
                        focusRequest: model.composerFocus,
                        isOffline: offlineMachine != nil,
                        blurRequest: model.composerBlur,
                        commentCount: model.reviewComments.count,
                        onDiscardComments: { model.reviewComments = [] },
                        onSelectAgent: model.selectAgent,
                        onSelectApproval: { approval in
                            model.setApproval(approval)
                            defaultApproval = approval
                        },
                        onSelectModel: { ref in
                            // A coding agent's model (or Auto) in a session on the engine: it carries on with them.
                            if !OutsideAgents.isAgentSession(model.session), OutsideAgents.runsInBridge(ref.providerID) {
                                // (A bot's conversation as any: the bot takes the new session.)
                                Task {
                                    do { try await workspace.moveToAgents(model.id, model: ref) } catch { model.failure = error.localizedDescription }
                                }
                            } else {
                                model.selectModel(ref)
                            }
                            lastModel = ref
                        },
                        onSend: { send(queue: false) },
                        onQueue: { send(queue: true) },
                        onEditLast: model.editLast,
                        onStop: model.stop,
                    drawsSurface: false
                    )
                }
                .modifier(ComposerSurface())

            }
            .animation(.ui, value: model.permissions.map(\.id))
            .animation(.ui, value: model.forms.map(\.id))
            .animation(.ui, value: bars)
            .animation(.ui, value: folds)
            .animation(.ui, value: isAsking)
            .animation(.ui, value: tucked)
            // A bot's work read from its box as it changes (a session of it started, at work,
            // asking, done), wherever the bot lives.
            .task(id: workChanges) {
                guard let bot = workBot else { return }
                await app.botWork.read(bot)
            }
            #if DEBUG
            // KUVO_DEMO_TUCKED: the bars tucked into their line once the sample ones are in (`new`:
            // the side question marked).
            .task(id: model.id) {
                guard let demo = ProcessInfo.processInfo.environment["KUVO_DEMO_TUCKED"] else { return }
                try? await Task.sleep(for: .seconds(4))
                model.tuck.hide()
                if demo == "new" { model.tuck.changed(.sideQuestion) }
            }
            #endif
            .animation(.ui, value: model.waiting.count > 2)
            // A goal put away and cleared: its line's record goes.
            .onChange(of: model.goal?.started) { old, _ in
                if let old { model.putAways.gone(.goal(started: old)) }
            }
            // The newest change opens, where the card is full; shown again, what has something to see.
            .onChange(of: Seen(conversation: model.id, value: bars), initial: true) { was, now in
                let new = now.value
                if was.conversation != now.conversation { queueOpen = false }
                // Another conversation shown: what came and went since it was last here (first
                // shown: as it is).
                let old = (was.conversation == now.conversation ? was.value : cards[now.conversation]?.bars) ?? new
                cards[now.conversation, default: Card()].bars = new
                // While tucked, what came is marked; none left, the next ones show.
                model.tuck.bars(from: old, to: new)
                // A handoff has nothing under its line; a review at work, nothing yet.
                folds.update(from: old, to: new, asking: isAsking, own: { own($0).wrappedValue }, keep: { own($0).wrappedValue = $1 },
                             news: { news[$0] == true }, opens: { $0 != .handoff && news[$0] != false })
            }
            .onChange(of: Seen(conversation: model.id, value: news), initial: true) { was, now in
                // Another conversation shown: what it had last time here (none yet: nothing came).
                let old = was.conversation == now.conversation ? was.value : cards[now.conversation]?.news ?? now.value
                cards[now.conversation, default: Card()].news = now.value
                for bar in folds.news(from: old, to: now.value) { model.tuck.changed(bar) }
            }
            // Another side question shown (picked in the sidebar, or just asked): its bar opens, unless a card asks.
            .onChange(of: Seen(conversation: model.id, value: model.shownSideQuestion)) { old, shown in
                if old.conversation == shown.conversation, shown.value != nil, bars.count >= BarFolds<ComposerBar>.full { folds.changed(.sideQuestion) }
            }
            .onChange(of: isAsking) { _, asking in
                if !asking { folds.askingEnded() }
            }
            // Two waiting or fewer: the next time there are more, they start on their line.
            .onChange(of: model.waiting.count > 2) { _, folds in
                if !folds { queueOpen = false }
            }
            // A question came: the keyboard goes to it, after the composer takes it as it shows,
            // unless you're speaking into the composer (Return and Escape are voice's till you're done).
            .onChange(of: forms.first?.id, initial: true) { _, id in
                guard id != nil else { return }
                Task {
                    try? await Task.sleep(for: .milliseconds(150))
                    if !app.dictation.isListening(for: model.id) { model.yieldComposer() }
                }
            }
            .animation(.ui, value: model.waiting.isEmpty)
            .animation(.ui, value: backgroundJobs.map(\.id))
            .animation(.ui, value: subagentsAtWork.map(\.id))
            .animation(.ui, value: offlineMachine == nil)
            .animation(.ui, value: model.failure)
            .animation(.ui, value: model.goal == nil)
            .animation(.ui, value: model.review == nil)
            .animation(.ui, value: model.shownSideQuestion)
            .animation(.ui, value: model.handoff == nil || model.handoff == model.putAwayHandoff)
            .animation(.ui, value: app.browserAsks.asks(for: model.session.id).map(\.id))
            // Its side questions, for the bar's menu and the sidebar's.
            .task(id: model.id) {
                await workspace.agents(forFolder: model.session.location.directory)?.loadSideQuestions(of: model.id)
                #if DEBUG
                if let which = ProcessInfo.processInfo.environment["KUVO_DEMO_BARS"], let bridge = model.goalBridge() {
                    bridge.showDemoBars(which, for: model.id)
                    model.shownSideQuestion = "btw_demo"
                }
                // Undo's lines, held: the goal put away and a message removed (KUVO_DEMO_UNDO=1).
                if ProcessInfo.processInfo.environment["KUVO_DEMO_UNDO"] != nil {
                    if let goal = model.goal { model.putAways.put(.goal(started: goal.started), text: "Goal put away", lingers: true) }
                    model.putAways.put(.message, text: "Message removed")
                }
                #endif
            }
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.bottom, 16)
        .readableColumn()
        #if DEBUG
        .onAppear {
            // KUVO_DEMO_QUOTE=<text>[||<text>…]: replying to those.
            if let quotes = ProcessInfo.processInfo.environment["KUVO_DEMO_QUOTE"] {
                model.draftQuotes = quotes.components(separatedBy: "||").map { Drafts.Quote(text: $0) }
            }
            // KUVO_DEMO_FAILURE=<text>: as if something just failed.
            if let failure = ProcessInfo.processInfo.environment["KUVO_DEMO_FAILURE"] { model.failure = failure }
        }
        #endif
    }

    private var offlineMachine: MachineEngine? { SessionView.offlineMachine(of: model, in: app) }

    private var forms: [FormRequest] {
        #if DEBUG
        return model.forms + Self.demoForms
        #else
        return model.forms
        #endif
    }

    #if DEBUG
    /// KUVO_DEMO_QUESTIONS: the agent asking three questions at once, over the composer.
    private static let demoForms: [FormRequest] = {
        guard ProcessInfo.processInfo.environment["KUVO_DEMO_QUESTIONS"] != nil else { return [] }
        func options(_ items: [(String, String)]) -> String {
            items.map { #"{"value":"\#($0.0)","label":"\#($0.0)","description":"\#($0.1)"}"# }.joined(separator: ",")
        }
        let json = #"{"id":"frm_demo","sessionID":"ses_demo","title":"Questions","metadata":{"kind":"question"},"fields":[{"key":"goal","title":"Goal of the outreach","description":"What should the outreach aim for?","type":"string","required":true,"custom":true,"options":[\#(options([("Early users and feedback", "Get people to try it and say what they think."), ("Paid licenses", "Teams that would need a commercial license."), ("Both, separate lists", "Individuals for feedback, companies for licenses.")]))]},{"key":"who","title":"Who to target","description":"Which kinds of people should I look for?","type":"multiselect","required":true,"custom":true,"options":[\#(options([("Mac developers using agents", "People using coding agents on a Mac."), ("Self-hosters", "People running home servers."), ("Indie hackers", "Builders who'd hand ops and research to bots."), ("Small teams", "Possible license buyers.")]))]},{"key":"where","title":"Where to leave drafts","description":"Where should the finished drafts live?","type":"string","required":true,"custom":true,"options":[\#(options([("A file on the server", "A Markdown list of each lead and a message."), ("Mail drafts", "Drafts in your mail, ready to send."), ("Social drafts", "Typed into each site's compose box, not sent.")]))]}]}"#
        return (try? JSONDecoder().decode(FormRequest.self, from: Data(json.utf8))).map { [$0] } ?? []
    }()
    #endif

    private func send(queue: Bool) {
        guard offlineMachine == nil else {
            Analytics.shared.firstMessageBlocked("machine_offline")
            return
        }
        let machine = RemoteFolder.machine(of: model.session.location.directory).map { id in app.machines.list.first { $0.id == id }?.name ?? id }
        let unavailable = model.session.model.flatMap { catalog.needsSignIn($0) ? catalog.unavailable($0, on: machine) : nil }
        model.submitDraft(for: catalog.model(model.session.model), queue: queue, commands: catalog.commands(in: model.session.location.directory), unavailable: unavailable)
    }
}

/// A new conversation, before its first message creates it on the server.
struct DraftSessionView: View {
    let directory: String
    /// Puts the cursor in the composer when it changes.
    var focusRequest = 0
    /// Each session the message starts (several, for attempts), the first first.
    let created: (Session, String, [URL]) -> Void

    @Environment(Workspace.self) private var workspace
    @Environment(Catalog.self) private var catalog
    @Environment(AppModel.self) private var app
    /// Picked in the composer; until then, the mode Settings starts new sessions in.
    @State private var pickedAgent: String?
    private var agent: String { pickedAgent ?? catalog.startingAgent(chosen: EngineConfig.of(catalog.machine)?.value(at: ["default_agent"])?.string) }
    @AppStorage(ToolApproval.key) private var approval = ToolApproval.approveAll
    /// New sessions in a git repository get a worktree of their own (remembered).
    @AppStorage("newSessionWorktree") private var worktree = false
    /// How many sessions try the task, each in its own worktree; back to one after sending.
    @State private var attempts = 1
    @State private var isCreating = false

    /// What "/" offers a new conversation: a goal where its computer runs them, a loop, and Plan.
    private var newSessionKeywords: [Keyword] {
        let goals = workspace.agents(forFolder: directory).map { $0.api != nil && $0.runsGoals != false } ?? false
        return Keyword.allCases.filter { $0 == .loop || $0 == .plan || ($0 == .goal && goals) }
    }

    /// Worktrees are for git repositories.
    private var isRepository: Bool { workspace.branches[directory] != nil || workspace.defaultBranches[directory] != nil }

    /// The project's new session keeps its draft under this key until it's created.
    private var draftKey: String { SidebarView.draftTag(directory) }
    @State private var failure: String?
    @LastModel private var lastModel

    /// The model picked last, when you can use it on this engine (a machine may not have every
    /// account), or its default.
    private var startingModel: ModelRef? {
        catalog.startingModel(lastModel)
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Text(Workspace.isChat(directory) ? "What's on your mind?" : "What should we work on?")
                .font(.system(size: 30, weight: .semibold))
                .padding(.bottom, 28)

            Composer(
                text: Binding(get: { Drafts.shared[draftKey].text }, set: { Drafts.shared[draftKey].text = $0 }),
                files: Binding(get: { Drafts.shared[draftKey].files }, set: { Drafts.shared[draftKey].files = $0 }),
                agent: agent,
                approval: approval,
                model: startingModel,
                isRunning: isCreating,
                folders: [directory] + workspace.extraFolders(directory),
                commands: Keyword.commands(catalog.commands(in: directory), keywords: newSessionKeywords),
                keywords: newSessionKeywords,
                focusRequest: focusRequest,
                onSelectAgent: { pickedAgent = $0 },
                onSelectApproval: { approval = $0 },
                onSelectModel: { lastModel = $0 },
                worktree: isRepository ? worktree : nil,
                onSelectWorktree: { worktree = $0 },
                attempts: attempts,
                onSelectAttempts: { attempts = $0 },
                onSend: send,
                onStop: {}
            )
            .padding(.horizontal, Metrics.gutter)
            .readableColumn()

            if isCreating, isRepository, worktree {
                Text(attempts > 1 ? "Setting up \(attempts) worktrees…" : "Setting up a worktree…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.top, 12)
            }
            if let failure {
                ErrorCard(message: failure)
                    .padding(.horizontal, Metrics.gutter)
                    .padding(.top, 12)
                    .readableColumn()
            }
            Spacer()
            Spacer()
        }
        .navigationTitle("New Session")
        .task(id: directory) { await catalog.loadCommands(in: directory) }
        .onAppear { Analytics.shared.onboardingStep("composer") }
    }

    private func send() {
        guard !isCreating else { return }
        // What the last try said goes with this one.
        failure = nil
        // "/goal" with nothing to give the agent (alone, pause, resume, clear): a new conversation
        // has no goal to act on, so none is made for it.
        if let goal = GoalCommand(Drafts.shared[draftKey].text), !goal.needsModel {
            if goal == .show { Drafts.shared[draftKey].text = "/goal " } else { failure = "There’s no goal yet. Type /goal and what it should achieve, like “/goal all tests pass”." }
            return
        }
        isCreating = true
        // On its way: the composer empties, as it does for a message, and the message is kept
        // until the session has it (a quit meanwhile puts it back). What's written while the
        // session is made goes on to its composer; if it can't be made, the message comes back.
        let (sending, sent) = Drafts.shared.takeOut(draftKey)
        let inWorktrees = isRepository && worktree
        let count = inWorktrees ? attempts : 1
        Task {
            var sessions: [Session] = []
            do {
                // One after another: each worktree's setup runs on its own.
                for _ in 0..<count {
                    sessions.append(try await workspace.createSession(in: directory, model: startingModel, agent: agent, approval: approval, worktree: inWorktrees))
                }
                if count > 1 { Analytics.shared.track("attempts_started", ["count": count]) }
                let since = Drafts.shared[draftKey]
                Drafts.shared.remove(draftKey)
                if let first = sessions.first, !since.isEmpty { Drafts.shared[first.id] = since }
                for session in sessions { created(session, sent.text, sent.files) }
                // Kept until the engine has it (or it's back in the session's composer): a quit
                // while it's prepared, or while the session's tools start, doesn't lose it.
                for session in sessions { await workspace.model(for: session.id)?.messagesSent() }
                Drafts.shared.sent(sending)
            } catch {
                // Attempts made before one failed go too: they'd never get the message, and
                // sending again makes them all anew.
                for session in sessions {
                    try? await workspace.delete(session.id)
                    if inWorktrees { await workspace.discardWorktree(session.location.directory) }
                }
                Analytics.shared.firstMessageBlocked("session_failed_" + Analytics.trouble(error))
                Drafts.shared.putBack(sending)
                failure = error.localizedDescription
                isCreating = false
            }
        }
    }
}

/// The model picked last, so new sessions start with it. Kept whole, as JSON: a model's ID can
/// have slashes in it (OpenRouter's "anthropic/claude-sonnet-4.5").
@propertyWrapper
struct LastModel: DynamicProperty {
    static let key = "lastModelRef"
    @AppStorage(LastModel.key) private var stored = ""

    var wrappedValue: ModelRef? {
        get { Self.decode(stored) }
        nonmutating set {
            stored = newValue.flatMap { try? JSONEncoder().encode($0) }.map { String(decoding: $0, as: UTF8.self) } ?? ""
            UserDefaults.standard.removeObject(forKey: "lastModel")
        }
    }

    /// The model picked last, outside a view.
    static var current: ModelRef? {
        decode(UserDefaults.standard.string(forKey: key) ?? "")
    }

    private static func decode(_ stored: String) -> ModelRef? {
        if let ref = try? JSONDecoder().decode(ModelRef.self, from: Data(stored.utf8)) { return ref }
        guard stored.isEmpty else { return nil }
        // One picked before it was kept whole: "provider/model/variant".
        let parts = (UserDefaults.standard.string(forKey: "lastModel") ?? "").split(separator: "/", maxSplits: 2).map(String.init)
        guard parts.count >= 2 else { return nil }
        return ModelRef(id: parts[1], providerID: parts[0], variant: parts.count > 2 ? parts[2] : nil)
    }

    var projectedValue: Binding<ModelRef?> {
        Binding(get: { wrappedValue }, set: { wrappedValue = $0 })
    }
}
