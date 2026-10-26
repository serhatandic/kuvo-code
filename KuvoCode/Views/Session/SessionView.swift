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
    /// A list open over the composer (see `ComposerListShown`).
    @State private var listShown = false

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
        .scrollEdgeEffectHidden(listShown, for: .bottom)
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
        .onChange(of: model.id, initial: true) { old, new in
            kept = Array(([model] + kept.filter { $0.id != new }).prefix(Self.keptCount))
            hiddenSizes[old] = size
            hiddenSizes[new] = nil
            hiddenSizes = hiddenSizes.filter { id, _ in kept.contains { $0.id == id } }
        }
        // A bar, not just an inset: the conversation scrolls on under the composer, softly
        // blurred there by the scroll view's edge effect.
        .safeAreaBar(edge: .bottom, spacing: 0) {
            BottomStack(model: model, lastModel: $lastModel)
                // Room for the composer, the cards' own buttons and a little conversation.
                .environment(\.cardRoom, max(160, height - 440))
        }
        .onPreferenceChange(ComposerListShown.self) { shown in listShown = shown }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        // Its machine out of reach: the conversation to read, without what needs the engine.
        .environment(\.isOffline, Self.offlineMachine(of: model, in: app) != nil)
        .navigationTitle(model.session.title ?? "New Session")
        // A conversation as last seen is read once its machine is back.
        // A copy shown while the engine reads (this Mac's) is read too; one waiting for its
        // machine is read once the machine is back.
        .task(id: model.id) { if !model.isLoaded, !model.waitsForEngine { await model.load() } }
        .task(id: model.session.location.directory) { await catalog.loadCommands(in: model.session.location.directory) }
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
}

/// Questions and permission requests, stacked on the composer in one glass
/// container so they grow out of it and melt back in when answered.
private struct BottomStack: View {
    @Bindable var model: SessionModel
    @Binding var lastModel: ModelRef?
    @Environment(Catalog.self) private var catalog
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app
    @AppStorage(ToolApproval.key) private var defaultApproval = ToolApproval.approveAll
    @Environment(\.takesCardKeys) private var takesCardKeys
    @Namespace private var glass

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
        GlassEffectContainer(spacing: 12) {
            VStack(spacing: 12) {
                ForEach(model.permissions) { request in
                    PermissionCard(request: request, command: model.permissionCommands[request.id], directory: model.session.location.directory) { decision in
                        model.reply(to: request, decision)
                    }
                    .disabled(offlineMachine != nil)
                    .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
                    .glassEffectID(request.id, in: glass)
                }
                ForEach(Array(forms.enumerated()), id: \.element.id) { index, form in
                    QuestionCard(form: form, progress: Binding(get: { model.questionProgress[form.id] ?? QuestionProgress() }, set: { model.questionProgress[form.id] = $0 }),
                                 takesKeys: index == 0 && takesCardKeys) { answer in
                        model.answer(form, with: FormFieldsView.payload(form.fields, answer))
                    } dismiss: {
                        model.dismiss(form)
                    }
                    .disabled(offlineMachine != nil)
                    .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
                    .glassEffectID(form.id, in: glass)
                }
                ForEach(app.browserAsks.asks(for: model.session.id)) { ask in
                    BrowserAskCard(ask: ask)
                        .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
                        .glassEffectID(ask.id, in: glass)
                }
                // What went wrong, over the composer rather than in an alert you must click away.
                if let failure = model.failure, offlineMachine == nil {
                    FailureBar(text: failure) { model.failure = nil }
                        .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
                        .glassEffectID("failure", in: glass)
                        .transition(.opacity)
                }
                if let engine = offlineMachine {
                    MachineOfflineBar(engine: engine)
                        .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
                        .glassEffectID("offline", in: glass)
                        .transition(.opacity)
                }
                if let goal = model.goal {
                    GoalBar(goal: goal, isHidden: $model.hidesGoal, isChanging: model.isChangingGoal || offlineMachine != nil) {
                        model.changeGoal(.pause)
                    } resume: {
                        model.changeGoal(.resume)
                    } stop: {
                        model.stopGoal()
                    } done: {
                        model.changeGoal(.clear)
                    }
                    .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
                    .glassEffectID("goal", in: glass)
                    .transition(.opacity)
                }
                KeywordBars(model: model, glass: glass)
                if !subagentsAtWork.isEmpty {
                    SubagentsBar(subagents: subagentsAtWork, folder: model.session.location.directory, isHidden: $model.hidesSubagents)
                        .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
                        .glassEffectID("subagents", in: glass)
                        .transition(.opacity)
                }
                if !backgroundJobs.isEmpty {
                    BackgroundBar(jobs: backgroundJobs, api: workspace.api(forSession: model.id), directory: model.session.location.directory, isHidden: $model.hidesBackgroundJobs) { job in
                        Task { await workspace.stopShellJob(job, in: model.id) }
                    }
                    .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
                    .glassEffectID("background", in: glass)
                    .transition(.opacity)
                }
                if let owner = wakeOwner {
                    WakeBar(owner: owner, isHidden: $model.hidesWakes)
                        .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
                        .glassEffectID("wakes", in: glass)
                        .transition(.opacity)
                }
                // What's waiting, tucked behind the composer's top edge.
                VStack(spacing: -QueueDock.overlap) {
                if !model.waiting.isEmpty {
                    QueueDock(model: model)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
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
                    onStop: model.stop
                )
                .glassEffectID("composer", in: glass)
                }
            }
            .animation(.ui, value: model.permissions.map(\.id))
            .animation(.ui, value: model.forms.map(\.id))
            // A question came: the keyboard goes to it, after the composer takes it as it shows.
            .onChange(of: forms.first?.id, initial: true) { _, id in
                guard id != nil else { return }
                Task {
                    try? await Task.sleep(for: .milliseconds(150))
                    model.yieldComposer()
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
            .task(id: model.id) { await workspace.agents(forFolder: model.session.location.directory)?.loadSideQuestions(of: model.id) }
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
                Label(attempts > 1 ? "Setting up \(attempts) worktrees…" : "Setting up a worktree…", systemImage: "arrow.triangle.branch")
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
                    await workspace.delete(session.id)
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

/// What the keywords started, in bars over the composer: a handoff under way, a review's
/// findings and a side question's answer (`KeywordBars.swift`).
private struct KeywordBars: View {
    @Bindable var model: SessionModel
    let glass: Namespace.ID
    @Environment(Workspace.self) private var workspace
    @Environment(AppModel.self) private var app

    /// The side question whose answer shows over the composer.
    private var shownSideQuestion: SideQuestion? {
        guard let id = model.shownSideQuestion else { return nil }
        return model.sideQuestions.first { $0.id == id }
    }

    /// The handoff to show: under way, failed, or done, until it's put away.
    private var shownHandoff: Handoff? {
        guard let handoff = model.handoff, handoff != model.putAwayHandoff else { return nil }
        return handoff
    }

    var body: some View {
                if let handoff = shownHandoff {
                    HandoffBar(handoff: handoff) {
                        Task { await workspace.openHandoff(handoff) }
                    } done: {
                        model.putAwayHandoff = handoff
                    }
                    .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
                    .glassEffectID("handoff", in: glass)
                    .transition(.opacity)
                    // Done: the work goes on in the new conversation, opened.
                    .onChange(of: handoff.state) { old, new in
                        if old == .writing, new == .done, let done = model.handoff { Task { await workspace.openHandoff(done) } }
                    }
                }
                if let review = model.review {
                    ReviewBar(review: review, isHidden: $model.hidesReview) {
                        model.fixReview()
                    } done: {
                        model.dismissReview()
                    } open: { finding in
                        if let url = FileLinks.file(named: finding.file, folders: [model.session.location.directory]), url.isFileURL { app.utilities.show(url) }
                    }
                    .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
                    .glassEffectID("review", in: glass)
                    .transition(.opacity)
                }
                if let question = shownSideQuestion {
                    SideQuestionBar(question: question, all: model.sideQuestions, show: { model.shownSideQuestion = $0.id }, isHidden: $model.hidesSideQuestion) {
                        model.askAnotherSideQuestion()
                    } remove: {
                        model.removeSideQuestion(question.id)
                    } done: {
                        model.shownSideQuestion = nil
                    }
                    .glassEffect(.regular, in: .rect(cornerRadius: Metrics.composerRadius))
                    .glassEffectID("btw", in: glass)
                    .transition(.opacity)
                }
    }
}
