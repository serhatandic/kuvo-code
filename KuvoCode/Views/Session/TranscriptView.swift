import AppKit
import ClientDesign
import ClientSandbox
import ClientSessions
import ClientText
import OpenCodeKit
import SwiftUI
import Textual

/// The conversation. Sticks to the bottom while the agent writes, unless you
/// scroll up to read.
struct TranscriptView: View {
    #if DEBUG
    private static let rowTransition: AnyTransition = Perf.noAnimation ? .identity : .opacity.combined(with: .offset(y: 8))
    private static let rowAnimation: Animation? = Perf.noAnimation ? nil : .ui
    #else
    private static let rowTransition: AnyTransition = .opacity.combined(with: .offset(y: 8))
    private static let rowAnimation: Animation? = .ui
    #endif
    let model: SessionModel
    @Environment(Workspace.self) private var workspace
    @Environment(Catalog.self) private var catalog
    @Environment(\.isOffline) private var isOffline
    @Environment(\.picksModel) private var picksModel
    /// A failed turn's Switch Model, where the composer has a model picker.
    private var switchModel: (() -> Void)? {
        guard picksModel else { return nil }
        let model = model
        return { model.openModelMenu() }
    }
    /// The account a failed turn's card is signing in to, in a sheet over the conversation.
    @State private var signingIn: SigningIn?
    private struct SigningIn: Identifiable { let id: String }
    /// A failed turn's Sign In, to its model's account, here.
    private var signIn: ConversationSignIn? {
        guard !isOffline else { return nil }
        return ConversationSignIn(current: model.session.model) { providerID in signingIn = SigningIn(id: providerID) }
    }
    @AppStorage(StepsDetail.key) private var stepsDetail = StepsDetail.summary
    @State private var scroller = ConversationScroller()
    @State private var rowCache = RowCache()
    /// The turn the pointer is over, whose row (its time, Copy and Reply) shows.
    @State private var hover = TurnHover()
    /// Find in the conversation (⌘F).
    @State private var find = ConversationFind()
    @Environment(\.isConversationShown) private var isShown

    /// The thinking under way at the end, if any.
    private static func thinking(in rows: [Row]) -> Thinking? {
        for row in rows.reversed() {
            guard case .steps(let id, let blocks, _, let isLive) = row else { continue }
            guard isLive, case .reasoning = blocks.last else { return nil }
            return Thinking(row: id, step: blocks.count)
        }
        return nil
    }

    /// The answers its bot gave, by the step that asked: kept on the session it is, or (a
    /// subagent's) the one it works for.
    private var workAnswers: [String: WorkAnswer] {
        let root = workspace.root(of: model.id)
        // What you approved after Auto's reviewer held it back, on the step that does it.
        let own = WorkAnswer.byCall(model.session).merging(WorkAnswer.yours(in: model.transcript.messages)) { bot, _ in bot }
        guard root != model.id, let above = workspace.session(root) else { return own }
        return own.merging(WorkAnswer.byCall(above)) { mine, _ in mine }
    }

    /// The conversation that keeps its Autopilot: this one, or the one a subagent works for.
    private var autopilotModel: SessionModel {
        let root = workspace.root(of: model.id)
        return root == model.id ? model : workspace.model(for: root) ?? model
    }

    /// The calls Autopilot made here, by the tool call that asked.
    private var autopilotCalls: [String: [AutopilotShown.Call]] { autopilotModel.autopilotShown?.byCall ?? [:] }

    /// Where its calls show, of those with no step of their own in `rows`.
    private func autopilotPlaces(in rows: [Row]) -> AutopilotShown.Places {
        guard let shown = autopilotModel.autopilotShown, !shown.decided.isEmpty else { return .init() }
        var steps = Set<String>()
        var subagents = Set<String>()
        for row in rows {
            switch row {
            case .steps(_, let blocks, _, _):
                for case .tool(let call) in blocks { steps.insert(call.id) }
            case .subagent(let call):
                if let session = call.state.metadata?["sessionID"]?.string ?? workspace.subagent(forStep: call.id)?.subagent.id { subagents.insert(session) }
            default:
                break
            }
        }
        return shown.places(steps: steps, subagents: subagents, whole: !rows.isEmpty && !model.hasEarlier, subagent: workspace.root(of: model.id) == model.id ? nil : model.id)
    }

    var body: some View {
        let rows = rows
        let places = autopilotPlaces(in: rows)
        // More of a reply, in a row of its own, carries on from the row before rather than coming in.
        let added = rows.filter { !$0.continues }
        ConversationScroll(scroller: scroller, animation: rowCache.isBulk ? nil : Self.rowAnimation, change: RowCache.Change(count: added.count, last: added.last?.id), thinking: Self.thinking(in: rows),
                           nearTop: model.hasEarlier ? { loadEarlier() } : nil, quote: { model.addQuote($0, how: "selection") }) {
            // Its top in view: the messages before, read and put ahead, the view staying put.
            if model.hasEarlier, !rows.isEmpty {
                HStack(spacing: 8) {
                    Spinner(size: 12)
                    Text("Earlier messages…")
                        .foregroundStyle(.secondary)
                }
                .font(.callout)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 20)
                .id("earlier")
                .onAppear { loadEarlier() }
            }
            #if DEBUG
            if Perf.lazy {
                stackRows(rows)
            } else {
                rowStack(rows)
            }
            #else
            rowStack(rows)
            #endif
            // Calls it made with no step here to show at, with what they asked.
            if !places.alone.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(places.alone) { DecidedLine(call: $0, saysQuestion: true) }
                }
                .padding(.top, 10)
            }
        }
        // The reply being written draws its words from it.
        .environment(model.writing)
        .environment(hover)
        // What a widget writes back goes to this conversation's agent, as yours: as words, never
        // a command or keyword the page could run as you, and without your review comments.
        .environment(\.answerAgent) { text in model.send(text, for: nil, withComments: false) }
        // What the bot that runs it answered for it, on the steps that asked; a subagent's are kept
        // on the session it works for.
        .environment(\.workAnswers, workAnswers)
        // The calls it made on Autopilot, where its questions would have waited.
        .environment(\.autopilotCalls, autopilotCalls)
        .environment(\.autopilotCallsOfSubagents, places.bySubagent)
        .environment(\.chooseOnAutopilot) { [autopilotModel] choice, call in autopilotModel.choose(choice, on: call) }
        // The commands its agent asks to run outside the sandbox, whose rows say they were stopped
        // (by the conversation they ask as: the one at the top of its chain).
        .environment(\.sandboxStopped, Sandboxes.shared.stoppedCommands(for: workspace.root(of: model.id), on: Workspace.box(of: model.session.location.directory)))
        .environment(\.sandboxReleased, Sandboxes.shared.releasedCommands(for: workspace.root(of: model.id), on: Workspace.box(of: model.session.location.directory)))
        // What Auto's reviewer did with what its steps asked, beside them.
        .environment(\.askReviews, Sandboxes.shared.reviewMarks(on: Workspace.box(of: model.session.location.directory)))
        .environment(\.conversationSignIn, signIn)
        // Its pictures, which each of them opens among.
        .environment(\.conversationPictures, ConversationPictureSet(model: model))
        // Its sign-in, where this conversation runs (a machine signs in on its own).
        .sheet(item: $signingIn) { item in
            ConnectView(integrationID: item.id, onDone: { signingIn = nil }, onCancel: { signingIn = nil })
                .environment(catalog)
                .frame(width: 480)
                .frame(minHeight: 380)
        }
        .overlay {
            if model.isLoaded && rows.isEmpty {
                EmptyConversationView(directory: model.session.location.directory) { text in
                    model.submit(text, files: [], for: nil, queue: false, commands: [])
                }
            }
        }
        .conversationFind(find, scroller: scroller, version: model.transcriptVersion, isSearchingEarlier: model.isLoadingEarlier,
                          searchEarlier: earlierSearch, folders: model.folders, rows: findRows)
        // What you send shows at the end, wherever you'd scrolled to.
        .onChange(of: model.sent) { scroller.toEnd() }
        // The queue over the composer grows or shrinks: the end stays in view above it.
        .onChange(of: model.waiting.count) {
            guard scroller.followsEnd else { return }
            Task {
                try? await Task.sleep(for: .milliseconds(120))
                scroller.toEnd()
            }
        }
        #if DEBUG
        // KUVO_DEMO_SCROLL=<seconds>: that long after it opens, goes up through the conversation a
        // row at a time (as scrolling makes rows appear), to measure it.
        .task {
            guard let wait = ProcessInfo.processInfo.environment["KUVO_DEMO_SCROLL"].flatMap(Double.init) else { return }
            try? await Task.sleep(for: .seconds(wait))
            let start = ContinuousClock.now
            var last = start
            var worst = Duration.zero
            var late = 0
            ParseClock.total = .zero
            ParseClock.count = 0
            // How tall it is, from AppKit's scroll view (SwiftUI doesn't pass on every change).
            let height = ScrollAnchor.conversationScrollView()?.documentView?.frame.height ?? 0
            var y = height
            for _ in 0..<150 where y > 0 {
                y -= 200
                scroller.scroll(to: max(y, 0))
                try? await Task.sleep(for: .milliseconds(16))
                let now = ContinuousClock.now
                let step = now - last
                worst = max(worst, step)
                if step > .milliseconds(34) { late += 1 }
                last = now
            }
            let line = "scroll up from \(Int(height)) pt by 200 a step: \(ContinuousClock.now - start) for 150 steps (2.4 s at best), worst step \(worst), \(late) late (over 34 ms); parsing \(ParseClock.count) replies took \(ParseClock.total)\n"
            if let path = ProcessInfo.processInfo.environment["KUVO_PERF_LOG"] {
                if let handle = FileHandle(forWritingAtPath: path) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() } else { FileManager.default.createFile(atPath: path, contents: Data(line.utf8)) }
            }
        }
        // Once, whatever happens to this view meanwhile (the test notes it if it's made again).
        .onAppear { PerfRead.start() }
        .onAppear {
            // The session asked for (KUVO_DEMO_SESSION), once it's the one in view.
            guard ProcessInfo.processInfo.environment["KUVO_DEMO_SESSION"].map({ $0 == model.id }) ?? true else { return }
            PerfOpen.start { rowCache.rows.last?.id }
        }
        // KUVO_DEMO_FIND_STEPS=<n>: once Find is open, Next that many times, a second and a half apart.
        .task {
            guard let steps = ProcessInfo.processInfo.environment["KUVO_DEMO_FIND_STEPS"].flatMap(Int.init) else { return }
            try? await Task.sleep(for: .seconds(8))
            for by in Array(repeating: 1, count: steps) + [-1, -1] {
                find.step(by)
                try? await Task.sleep(for: .milliseconds(1500))
            }
        }
        .onDisappear { PerfRead.viewsGone += 1 }
        .task { await PerfRender.run(model: model) }
        .task { await PerfDrag.run() }
        .onAppear { PerfCompare.run() }
        .onAppear { PerfCopyTest.run() }
        .onAppear { PerfSelectTest.run() }
        .onAppear { PerfLayoutCheck.run() }
        // KUVO_DEMO_WANDER=<seconds>: that long after it opens, scrolls up a screen or two and back
        // down, again and again, as you would reading what streams in, for KUVO_DEMO_WANDER_FOR
        // seconds: scroll gestures, as a trackpad sends them, through AppKit.
        .task {
            let environment = ProcessInfo.processInfo.environment
            guard let wait = environment["KUVO_DEMO_WANDER"].flatMap(Double.init) else { return }
            try? await Task.sleep(for: .seconds(wait))
            let end = ContinuousClock.now + .seconds(Double(environment["KUVO_DEMO_WANDER_FOR"] ?? "") ?? 30)
            // The conversation's: the tallest.
            guard let view = ScrollAnchor.conversationScrollView() else { return }
            var step = 0
            while ContinuousClock.now < end {
                // 30 frames up, 30 down, 40 pt a frame, each way a gesture of its own.
                let frame = step % 30
                let phase: CGScrollPhase = frame == 0 ? .began : frame == 29 ? .ended : .changed
                if let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: (step / 30) % 2 == 0 ? 40 : -40, wheel2: 0, wheel3: 0) {
                    event.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase.rawValue))
                    event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                    if let scroll = NSEvent(cgEvent: event) { view.scrollWheel(with: scroll) }
                }
                step += 1
                try? await Task.sleep(for: .milliseconds(16))
            }
            scroller.toEnd()
        }
        #endif
        // (Kept out of view for going back to: its Find isn't Esc's meanwhile.)
        .onChange(of: isShown, initial: true) { find.isShown = isShown }
        .onChange(of: model.findRequest, initial: true) {
            guard model.findRequest > 0 else { return }
            find.open(model.findPreset)
            model.findPreset = nil
        }
    }

    /// While there's more of the conversation than has been read, a way for Find to look there.
    private var earlierSearch: (() -> Void)? {
        guard model.hasEarlier else { return nil }
        return { searchEarlier() }
    }

    /// Find, in what hasn't been read yet: all of it read, then the first match shown.
    private func searchEarlier() {
        Task {
            await model.loadAllEarlier()
            find.look(in: findRows(), folders: model.folders(), showsFirst: true)
        }
    }

    /// The rows' words, for Find.
    private func findRows() -> [ConversationFind.Row] {
        rows.map { ConversationFind.Row(id: $0.id, parts: $0.findParts) }
    }

    /// The rows, laid out by a stack of their own (see `RowStack`).
    private func rowStack(_ rows: [Row]) -> some View {
        // Made again as Find's marks change (each row reads its own as it's laid out).
        _ = find.marksState
        return RowStack(items: rows, id: \.id, same: ==, estimate: Self.estimate, animatesNew: !rowCache.isBulk, text: { $0.copiedText(folders: model.folders()) },
                 whole: \.copiesWhole,
                 space: { row, index in index == 0 ? 0 : row.spacing(after: rows[index - 1]) },
                 pointer: { [hover] in hover.point(at: $0) }) { row, index in
            RowView(row: row, scope: model.session.id, directory: model.session.location.directory, folders: model.folders, heard: model.heard, cancel: model.cancelPending, undo: model.undo(from:), redo: model.redo, fork: fork(_:), retry: model.retry(_:), switchModel: switchModel, buildPlan: model.agent == "plan" && !isOffline ? { model.buildPlan() } as () -> Void : nil, reply: model.reply(to:))
                .equatable()
                .environment(\.findHighlight, find.highlight(for: row.id))
                .padding(.top, index == 0 ? 0 : row.spacing(after: rows[index - 1]))
                .modifier(TurnRow(row: row, hover: hover, reply: model.reply(to:)))
        }
    }

    #if DEBUG
    /// The rows, in the lazy stack (KUVO_PERF_LAZY).
    @ViewBuilder private func stackRows(_ rows: [Row]) -> some View {
        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
            RowView(row: row, scope: model.session.id, directory: model.session.location.directory, folders: model.folders, heard: model.heard, cancel: model.cancelPending, undo: model.undo(from:), redo: model.redo, fork: fork(_:), retry: model.retry(_:), switchModel: switchModel, buildPlan: model.agent == "plan" && !isOffline ? { model.buildPlan() } as () -> Void : nil, reply: model.reply(to:))
                .equatable()
                .environment(\.findHighlight, find.highlight(for: row.id))
                .conversationRow(row.id)
                .id(row.id)
                #if DEBUG
                .onAppear {
                    ScrollFrameMonitor.rowsMade += 1
                    ScrollFrameMonitor.rowsMadeByID[row.id, default: 0] += 1
                }
                .modifier(RowProbe(id: row.id))
                #endif
                .padding(.top, index == 0 ? 0 : row.spacing(after: rows[index - 1]))
                .modifier(TurnRow(row: row, hover: hover, reply: model.reply(to:)))
                .transition(Self.rowTransition)
        }
    }
    #endif

    /// A row's height before it's measured: about what its words take at a column's width.
    private static func estimate(_ row: Row) -> CGFloat {
        switch row {
        case .assistant(let message, _), .more(let message, _):
            let characters = message.content.reduce(0) { if case .text(let part) = $1 { $0 + part.text.count } else { $0 } }
            return 24 + CGFloat(characters / 95 + 1) * 24
        case .user: return 90
        case .steps: return 40
        case .turnEnd: return 34
        default: return 60
        }
    }

    /// The messages before those read, put ahead of them: what you're reading stays where it is.
    private func loadEarlier() {
        // Only once you've scrolled up toward it, not as the conversation opens at its end;
        // unless it all fits, when the top is in view from the start.
        guard model.hasEarlier, !model.isLoadingEarlier, !scroller.followsEnd || scroller.fits else { return }
        Task {
            await model.loadEarlier()
            // Still all in view: the top won't come into view again, so on to the next.
            try? await Task.sleep(for: .milliseconds(300))
            while model.hasEarlier, scroller.fits, !Task.isCancelled {
                await model.loadEarlier()
                try? await Task.sleep(for: .milliseconds(300))
            }
        }
    }

    /// Messages, turned into what's drawn: notices are condensed, each finished
    /// turn gets a summary line, and queued messages come last.
    /// The rows, made again only when what they're made from changes (not as you scroll).
    private var rows: [Row] {
        let key = RowCache.Key(version: model.transcriptVersion, detail: stepsDetail, revert: model.session.revert?.messageID, waiting: model.waiting.map(\.id), model: model.session.model)
        if rowCache.key == key { return rowCache.rows }
        let rows = Self.rows(of: model, catalog: catalog, detail: stepsDetail)
        hover.turns = Self.turns(of: rows)
        // A whole history arriving at once (opening, loading more) comes without its rows fading in.
        rowCache.isBulk = abs(rows.count - rowCache.rows.count) > 3
        rowCache.key = key
        rowCache.rows = rows
        return rows
    }

    /// The turn each row of a reply is part of: the rows from your message to the turn's end,
    /// which shows its row from any of them (your message has its own), and what the turn said,
    /// for Copy Reply. A turn under way has no end yet; what it's said so far is its words.
    static func turns(of rows: [Row]) -> [String: TurnHover.Turn] {
        var turns: [String: TurnHover.Turn] = [:]
        var since: [Row] = []
        for row in rows {
            switch row {
            case .user, .pending, .undone:
                since = []
            case .working:
                continue
            case .turnEnd(let idle, let stats, _, _):
                let turn = TurnHover.Turn(end: idle.id, said: stats.text)
                for each in since { turns[each.id] = turn }
                turns[idle.id] = turn
                since = []
            default:
                since.append(row)
            }
        }
        // Only the turn under way's words are read from its rows: the others' are in their ends.
        let said = since.compactMap(\.words)
        if !said.isEmpty {
            let turn = TurnHover.Turn(end: nil, said: said)
            for each in since { turns[each.id] = turn }
        }
        return turns
    }

    static func rows(of model: SessionModel, catalog: Catalog, detail stepsDetail: StepsDetail) -> [Row] {
        var rows: [Row] = []
        var turn = TurnStats()
        // An undo waiting to be kept ends the conversation at its message: by where it is, as a
        // message queued during a run is older than that run's later steps.
        let boundary = model.session.revert?.messageID
        let all = model.transcript.messages
        let messages = ShownMessages.before(undo: boundary, in: all)
        // Where the undone part starts, if anything's undone.
        let cut = boundary.map { _ in messages.count }
        // The model each turn runs on, for one that fails before any reply says it: the last switch's;
        // before any, the one the first switch left (wherever it is), or the session's. Not a reply's:
        // Auto's are the model it picked for that turn.
        let firstSwitch = all.lazy.compactMap { if case .modelSwitched(let change) = $0 { change } else { nil } }.first
        var current = firstSwitch.map(\.previous) ?? model.session.model
        // What changed since the last reply (the model, the mode, a summary): said in the next
        // reply's footer, never as a pill (KuvoClient's ReplyChanges, the same on the phone).
        var changes = ReplyChanges()
        // Summed up: the agent's steps between its replies, gathered into one row.
        var steps: [Message.Content] = []
        var stepKeys: [String] = []
        var stepsID = ""
        // The end of each message's turn, found in one pass rather than looked for from each.
        var turnEnds: [Message.Idle?] = Array(repeating: nil, count: messages.count)
        var following: Message.Idle?
        for index in messages.indices.reversed() {
            turnEnds[index] = following
            if case .idle(let idle) = messages[index] { following = idle }
        }
        // Where the conversation ends for Try Again: a model or mode picked after a failed run
        // leaves it the last, so it goes again with them.
        let latestEnd = messages.lastTurnEndIndex
        // (While it runs, a summary included, there's nothing to try again yet.)
        let last = model.transcript.isRunning ? nil : messages.whereItEnds
        func flushSteps(live: Bool) {
            guard !steps.isEmpty else { return }
            if !live, StepsRow.saysTime(steps, detail: stepsDetail) { turn.stepsSayTime = true }
            rows.append(.steps(stepsID, steps, keys: stepKeys, isLive: live))
            steps = []
            stepKeys = []
        }
        for (index, message) in messages.enumerated() {
            // Only what shows ends the run of steps: guidance the engine adds partway through a
            // turn, a summary or a switch (said in the next reply's footer) and a note of the box's
            // show nothing, so the turn's steps stay one line around them.
            switch message {
            case .assistant, .synthetic, .system, .other, .compaction, .modelSwitched, .agentSwitched, .user: break
            default: flushSteps(live: false)
            }
            switch message {
            case .user(let user):
                let note = BoxNote.of(user)
                let shown = Row.messages(user, note: note)
                if let note { changes.note(note) }
                // A note of the box's that shows nothing (your answer told late) neither splits the
                // turn's steps nor starts a turn of its own, unless it's what started one.
                if shown.isEmpty {
                    if turn.started == nil { turn = TurnStats(started: user.time.created, message: user, model: current) }
                    break
                }
                flushSteps(live: false)
                turn = TurnStats(started: user.time.created, message: user, model: current)
                rows += shown
            case .assistant(let assistant):
                turn.add(assistant)
                // The run's error shows once, at the end of the turn. A step you stopped isn't an
                // error: the turn's end says "Stopped".
                let nextIdle = turnEnds[index]
                let showsError = assistant.error.map { !$0.isInterruption } == true && assistant.error?.message != nextIdle?.error?.message
                if stepsDetail == .each {
                    if !assistant.content.isEmpty || showsError || assistant.retry != nil {
                        rows.append(.assistant(assistant, showsError: showsError))
                    }
                    break
                }
                // Its words as they are, its thinking and tool calls in the line before them.
                for (part, block) in assistant.content.enumerated() {
                    switch block {
                    case .text(let text):
                        guard !text.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                        flushSteps(live: false)
                        // A long reply in rows of its pieces (see MarkdownChunks): only those near
                        // the view are made, and no row gets so tall that the conversation loses
                        // its place.
                        let chunks = MarkdownChunks.split(text.text, isWriting: assistant.time.completed == nil && part == assistant.content.count - 1)
                        for (index, chunk) in chunks.enumerated() {
                            var words = assistant
                            words.id = assistant.id + "#\(part)" + (index == 0 ? "" : ".\(index)")
                            words.content = [.text(Message.Content.Text(text: String(chunk.text), time: text.time))]
                            words.error = nil
                            words.retry = nil
                            rows.append(index == 0 ? .assistant(words, showsError: false) : .more(words, gap: chunk.gap))
                        }
                    case .tool(let call) where WidgetCard.isWidget(call):
                        // Something it made shows on its own, in the conversation's flow.
                        flushSteps(live: false)
                        rows.append(.widget(call))
                    case .tool(let call) where MadePictureRow.isMade(call):
                        // So does an image it made.
                        flushSteps(live: false)
                        // One after another, with nothing between (in one step or the next), they're
                        // one row of pictures to look through together.
                        if MadePictureRow.isGroupable(call), case .pictures(let previous)? = rows.last {
                            rows.removeLast()
                            rows.append(.pictures(previous + [call]))
                        } else if MadePictureRow.isGroupable(call) {
                            rows.append(.pictures([call]))
                        } else {
                            rows.append(.picture(call))
                        }
                    case .tool(let call) where call.name == "kuvo-browser_send_message":
                        // So does what it wrote to another agent.
                        flushSteps(live: false)
                        rows.append(.sent(call))
                    case .tool(let call) where call.name == "subagent":
                        // And each subagent it handed work to, at work or done.
                        flushSteps(live: false)
                        rows.append(.subagent(call))
                    case .reasoning, .tool:
                        if steps.isEmpty { stepsID = "steps-" + assistant.id + "#\(part)" }
                        steps.append(block)
                        // Where it is in its message: a read says the same, and a tool call's id
                        // is the provider's, which some use again from one reply to the next.
                        if case .tool(let call) = block {
                            stepKeys.append(assistant.id + "#" + call.id)
                        } else {
                            stepKeys.append(assistant.id + "#\(part)")
                        }
                    case .other:
                        break
                    }
                }
                if showsError || assistant.retry != nil {
                    flushSteps(live: false)
                    var end = assistant
                    end.id = assistant.id + "#end"
                    end.content = []
                    rows.append(.assistant(end, showsError: showsError))
                }
            case .idle(let idle):
                turn.changes = changes.replied()
                rows.append(.turnEnd(idle, turn, isLast: index == last, isLatest: index == latestEnd))
                turn = TurnStats()
            case .modelSwitched(let change):
                current = change.model
                // By its name, as the model menu shows it ("Big Pickle", not big-pickle).
                changes.switched(to: change.model, from: change.previous, name: catalog.model(change.model)?.name ?? change.model.id)
            case .agentSwitched(let change):
                changes.switched(toMode: change.agent, from: change.previous)
            case .compaction(let compaction):
                changes.summarized(compaction.status)
            case .shell(let shell):
                rows.append(.shell(shell))
            case .synthetic(let notice), .system(let notice):
                // A turn the app or the engine started (a model switched mid-run carries on), timed
                // from it as one you started is from your message.
                if turn.started == nil { turn.started = notice.time.created }
                // A note of the bridge's for you ("Your hook failed…"): a quiet line.
                if notice.isForYou {
                    flushSteps(live: false)
                    rows.append(.notice(notice.id, "info.circle", notice.text))
                    break
                }
                // Words for the model, never shown: what changed is said in the next reply's footer.
                changes.note(notice)
            case .other:
                break
            }
        }
        // A step still going at the end is under way, whatever the running state says.
        flushSteps(live: model.transcript.isRunning || StepsRow.isUnfinished(steps.last))
        if cut == nil, let step = Self.interruptedStep(in: messages, isRunning: model.transcript.isRunning) {
            rows.append(.notice(step.id + "#interrupted", "pause.circle", "Interrupted before it finished: send a message to carry on"))
        }
        if let cut {
            let undone = all[cut...].count { if case .user = $0 { true } else { false } }
            rows.append(.undone(max(undone, 1)))
        }
        // Messages waiting their turn are listed above the composer instead.
        let waiting = Set(model.waiting.map(\.id))
        rows += model.transcript.pending.filter { !waiting.contains($0.id) }.flatMap(Row.waiting)
        // Always while it works, with the time since your message, so a long step is plainly
        // still going.
        if model.transcript.isRunning {
            // Since when nothing has come back from the model: your message, or a step, with no
            // step writing or running a tool after it (a step stays open while its tools run).
            var quiet: Milliseconds?
            var followsHeard = false
            switch messages.last {
            case .assistant(let step)?:
                // Partway through its reply (not a tool at work): since it last sent anything, so a
                // reply that stalls midway says so as well.
                let toolRuns = step.content.contains { if case .tool(let call) = $0, case .running = call.state { true } else { false } }
                quiet = step.time.completed ?? (step.content.isEmpty ? step.time.created : toolRuns ? nil : model.transcript.lastHeard)
                followsHeard = step.time.completed == nil && !step.content.isEmpty && !toolRuns
            case .user(let message)?: quiet = message.time.created
            case .synthetic(let notice)?, .system(let notice)?: quiet = notice.time.created
            // A summary just done: nothing from the model since.
            case .compaction(let summary)?: quiet = summary.time.completed
            default: break
            }
            // A tool or a subagent at work shows it, moving: this line holds still meanwhile.
            var stepWorks = false
            if case .assistant(let step)? = messages.last {
                stepWorks = step.content.contains { if case .tool(let call) = $0 { !call.state.isFinished } else { false } }
            }
            rows.append(.working(since: turn.started, quiet: quiet, followsHeard: followsHeard, holds: stepWorks, summarizing: messages.summaryUnderWay?.time.created))
        }
        return rows
    }

    private func fork(_ message: Message.User) {
        Task {
            do { try await workspace.fork(model.id, from: message) } catch { model.failure = error.localizedDescription }
        }
    }

}

struct TurnStats: Hashable {
    var started: Milliseconds?
    /// The message that started the turn, for Try Again.
    var message: Message.User?
    var cost: Double = 0
    var outputTokens = 0
    var steps = 0
    /// A line of its steps says how long they took ("Worked for 40s"), so its end doesn't.
    var stepsSayTime = false
    /// What the agent wrote, for copying the reply.
    var text: [String] = []
    /// The mode that answered: a plan can be built from its end.
    var agent: String?
    /// The model that answered: a failed turn signs in to its account.
    var model: ModelRef?
    /// The files the agent changed, in the order first changed, with their lines.
    var files: [TurnFile] = []
    /// What changed since the reply before (the model, the mode, a summary), in a word or two each
    /// (KuvoClient's ReplyChanges): said beside its time.
    var changes: [String] = []

    /// A file a turn changed. A file written whole has no line counts.
    struct TurnFile: Hashable, Identifiable {
        var file: String
        var lines: (additions: Int, deletions: Int)?

        var id: String { file }

        static func == (a: TurnFile, b: TurnFile) -> Bool {
            a.file == b.file && a.lines?.additions == b.lines?.additions && a.lines?.deletions == b.lines?.deletions
        }

        func hash(into hasher: inout Hasher) {
            hasher.combine(file)
            hasher.combine(lines?.additions)
            hasher.combine(lines?.deletions)
        }
    }

    mutating func add(_ message: Message.Assistant) {
        agent = message.agent
        model = message.model
        for block in message.content {
            guard case .tool(let call) = block, case .completed(let input, _, let metadata) = call.state else { continue }
            // Read straight from the JSON: this runs on every update while a reply streams, and
            // the diffs carry whole patches.
            for diff in metadata?["files"]?.array ?? [] {
                guard let file = diff["file"]?.string else { continue }
                note(file, lines: (Int(diff["additions"]?.number ?? 0), Int(diff["deletions"]?.number ?? 0)))
            }
            if call.name == "write", let path = input["path"]?.string {
                note(path, lines: nil)
            }
        }
        cost += message.cost ?? 0
        outputTokens += (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0)
        steps += 1
        for block in message.content {
            if case .text(let part) = block, !part.text.isEmpty { text.append(part.text) }
        }
    }

    private mutating func note(_ file: String, lines: (additions: Int, deletions: Int)?) {
        guard let index = files.firstIndex(where: { $0.file == file }) else {
            files.append(TurnFile(file: file, lines: lines))
            return
        }
        // Once written whole, its lines aren't known.
        if let old = files[index].lines, let lines {
            files[index].lines = (old.additions + lines.additions, old.deletions + lines.deletions)
        } else {
            files[index].lines = nil
        }
    }
}

enum Row: Identifiable, Hashable {
    case user(Message.User)
    case assistant(Message.Assistant, showsError: Bool)
    /// More of a long reply, in a row of its own, this far below the row before it.
    case more(Message.Assistant, gap: CGFloat)
    /// The agent's steps between its replies, summed up (`StepsDetail`); `isLive`, the last of
    /// them is under way.
    case steps(String, [Message.Content], keys: [String], isLive: Bool)
    /// Something the agent made with show_widget, drawn in the conversation.
    case widget(Message.ToolCall)
    /// An image it made.
    case picture(Message.ToolCall)
    /// Pictures it brought one after another (shown, made, of a page), in one row.
    case pictures([Message.ToolCall])
    /// What it wrote to another agent (send_message).
    case sent(Message.ToolCall)
    /// A subagent it handed part of the work to.
    case subagent(Message.ToolCall)
    /// `isLast`: the conversation ends here, so a failed run can be tried again. `isLatest`: the
    /// latest turn's end, whose row (its time, Copy and Reply) stays in view, though notes or a
    /// command you ran may come after it.
    case turnEnd(Message.Idle, TurnStats, isLast: Bool, isLatest: Bool)
    /// A quiet line of where the conversation stands with nothing after it to say it: a run cut
    /// off before it finished. (What changed between replies is said in the next one's footer.)
    case notice(String, String, String)
    /// One of its sessions telling the agent what it did, as a message from it (`SessionNews`);
    /// `at`, when it came, and none while it waits to go in.
    case news(String, SessionNews, at: Milliseconds?)
    /// A command you ran with "!".
    case shell(Message.Shell)
    case pending(Transcript.Pending)
    /// An undo that the next message makes final, with how many messages it took back.
    case undone(Int)
    /// The agent at work, since the time of your message.
    /// `quiet`: since when nothing has come back from the model.
    /// `followsHeard`: quiet since the model last sent anything, which new words move on without
    /// the rows being made again (see `RowView.heard`).
    /// `summarizing`: since when it's been summarizing the conversation, which it says instead.
    case working(since: Milliseconds?, quiet: Milliseconds?, followsHeard: Bool, holds: Bool, summarizing: Milliseconds?)

    /// The line under the conversation at `now` (see `WorkingLine`), with " · Esc to stop" after its
    /// time.
    static func working(since: Milliseconds?, quiet: Milliseconds?, summarizing: Milliseconds? = nil, now: Date) -> String {
        let line = WorkingLine.words(since: since, quiet: quiet, summarizing: summarizing, now: now)
        guard let seconds = WorkingLine.seconds(since: line.since, now: now) else { return line.words }
        return line.words + " \(MessageTime.duration(seconds)) · Esc to stop"
    }

    /// A reply's words in it, on a row of them.
    var words: String? {
        switch self {
        case .assistant(let message, _), .more(let message, _):
            let words = message.content.compactMap { if case .text(let part) = $0 { part.text } else { nil } }.joined(separator: "\n\n")
            return words.isEmpty ? nil : words
        default:
            return nil
        }
    }

    /// A message in the conversation as its rows: yours as your bubble; one the box wrote to the
    /// agent as a message from each session whose news it tells, and otherwise nothing (what it
    /// changed shows in the next reply's footer).
    static func messages(_ user: Message.User) -> [Row] {
        messages(user, note: BoxNote.of(user))
    }

    /// The same, with the note it is already read.
    static func messages(_ user: Message.User, note: BoxNote?) -> [Row] {
        note.map { rows(of: $0, id: user.id, at: user.time.created) } ?? [.user(user)]
    }

    /// A message on its way in, the same way.
    static func waiting(_ item: Transcript.Pending) -> [Row] {
        BoxNote.of(text: item.text, metadata: item.metadata).map { rows(of: $0, id: item.id, at: nil) } ?? [.pending(item)]
    }

    private static func rows(of note: BoxNote, id: String, at: Milliseconds?) -> [Row] {
        note.shown.enumerated().map { index, news in .news(index == 0 ? id : "\(id)#\(index)", news, at: at) }
    }

    /// The words Find looks in, as the row shows them: messages, replies, and commands you ran
    /// with what they printed.
    var findParts: [ConversationFind.Part] {
        switch self {
        case .news(_, let news, _):
            return [.markdown(news.body)]
        case .notice(_, _, let text):
            return [.plain(text)]
        case .user(let message):
            let text = CommandMessages.shared.text(of: message)
            if let mail = AgentMail.parse(text) { return [.markdown(mail.text)] }
            if text.hasPrefix(Wakes.marker) { return [.plain(String(text.dropFirst(Wakes.marker.count)))] }
            if let work = GroupWork.parse(text) { return [.markdown(work.task)] }
            return UserBubble.findParts(UserBubble.words(of: text), keyword: SentMessage.keyword(of: text)).map(ConversationFind.Part.plain)
        case .pending(let item):
            return UserBubble.findParts(UserBubble.words(of: item.text), keyword: SentMessage.keyword(of: item.text)).map(ConversationFind.Part.plain)
        case .assistant(let message, _), .more(let message, _):
            return message.content.compactMap { if case .text(let part) = $0 { .markdown(part.text) } else { nil } }
        case .shell(let shell):
            return [.plain(shell.command), .plain(ShellRow.output(of: shell))]
        default:
            return []
        }
    }

    /// Copied by `copiedText` from a selection that takes all of it, though its view is made: a
    /// command you ran, whose command isn't text to select in (only what it printed is).
    var copiesWhole: Bool {
        if case .shell = self { true } else { false }
    }

    /// Its words as a selection across the conversation copies it whole: as it reads (Markdown
    /// as shown), a line of steps as its summary.
    func copiedText(folders: [String]) -> String {
        switch self {
        case .steps(_, let blocks, _, _):
            return StepsRow.summary(of: blocks)
        default:
            return findParts.map { part in
                switch part {
                case .plain(let text): text
                case .markdown(let text): FindText.shown(markdown: text, folders: folders)
                }
            }.joined(separator: "\n")
        }
    }

    /// More of a reply before it.
    var continues: Bool {
        if case .more = self { true } else { false }
    }

    /// Space above this row: steps of one reply sit close, a new message gets room.
    func spacing(after previous: Row) -> CGFloat {
        switch (previous, self) {
        // The space the Markdown style puts between those paragraphs.
        case (_, .more(_, let gap)): gap
        case (.more, .assistant), (.more, .turnEnd), (.more, .working), (.more, .steps): 10
        case (_, .widget), (.widget, _), (_, .sent), (.sent, _), (_, .news), (.news, _): 14
        case (.assistant, .assistant), (.assistant, .turnEnd), (.assistant, .working),
             (.steps, .assistant), (.assistant, .steps), (.steps, .turnEnd), (.steps, .working),
             (.subagent, .subagent), (.steps, .subagent), (.subagent, .steps), (.assistant, .subagent), (.more, .subagent),
             (.subagent, .assistant), (.subagent, .turnEnd), (.subagent, .working): 10
        case (_, .user), (_, .pending): 28
        case (.shell, .shell): 12
        case (_, .shell): 20
        // A message's buttons already take room under it.
        case (.user, _): 4
        default: 16
        }
    }

    var id: String {
        switch self {
        case .user(let m): m.id
        case .assistant(let m, _), .more(let m, _): m.id
        case .steps(let id, _, _, _): id
        case .widget(let call): call.id
        case .picture(let call): call.id
        case .pictures(let calls): calls.first?.id ?? "pictures"
        case .sent(let call): call.id
        case .subagent(let call): call.id
        case .turnEnd(let m, _, _, _): m.id
        case .notice(let id, _, _): id
        case .news(let id, _, _): id
        case .shell(let m): m.id
        case .pending(let item): item.id
        case .undone: "undone"
        case .working: "working"
        }
    }
}

/// Equal when what it shows is: its actions are the session's own, the same every time, so a
/// change to one row (the reply being written) draws only that row, not every one made so far.
private struct RowView: View, Equatable {
    static func == (lhs: RowView, rhs: RowView) -> Bool {
        lhs.row == rhs.row && lhs.directory == rhs.directory && (lhs.buildPlan == nil) == (rhs.buildPlan == nil)
    }

    let row: Row
    @Environment(\.bot) private var bot
    /// The conversation it's in, which what you open in it is kept under.
    let scope: String
    let directory: String
    let folders: () -> [String]
    /// When the model was last heard, and how far this Mac's clock is ahead of the engine's, as of
    /// now: the working line reads them each second.
    let heard: () -> (last: Milliseconds?, offset: Milliseconds)
    let cancel: (Transcript.Pending) -> Void
    let undo: (Message.User) -> Void
    let redo: () -> Void
    /// New Session From Here.
    let fork: (Message.User) -> Void
    let retry: (Message.User) -> Void
    /// Opens the composer's model picker, when it has one.
    let switchModel: (() -> Void)?
    /// While the session is in Plan mode: build what the last answer planned.
    let buildPlan: (() -> Void)?
    /// Quotes a reply (or the part of it you selected) in the composer.
    let reply: (String) -> Void
    @Environment(\.answerAgent) private var answerAgent
    @Environment(\.isOffline) private var isOffline
    @Environment(\.takesNoMessages) private var takesNoMessages
    @Environment(\.subagentStarter) private var subagentStarter

    static func sentAt(_ created: Milliseconds) -> String {
        MessageTime.sentAt(Date(timeIntervalSince1970: created / 1000))
    }

    var body: some View {
        switch row {
        case .user(let message) where AgentMail.parse(CommandMessages.shared.text(of: message)) != nil:
            if let mail = AgentMail.parse(CommandMessages.shared.text(of: message)) {
                AgentMessageRow(id: message.id, from: mail.name, session: mail.session, text: mail.text, at: message.time.created)
            }
        case .user(let message) where GroupWork.parse(CommandMessages.shared.text(of: message)) != nil:
            if let work = GroupWork.parse(CommandMessages.shared.text(of: message)) {
                GroupWorkRow(id: message.id, chat: work.chat, chatID: work.id, task: work.task, at: message.time.created)
            }
        case .user(let message) where subagentStarter != nil && SubagentTask.parse(CommandMessages.shared.text(of: message)) != nil:
            // A subagent's task, in its own tab: the words of the agent that started it, not yours.
            AgentMessageRow(id: message.id, from: subagentStarter ?? "", session: "", text: SubagentTask.parse(CommandMessages.shared.text(of: message)) ?? "", at: message.time.created)
        case .user(let message) where CommandMessages.shared.text(of: message).hasPrefix(Wakes.marker):
            if let wake = WakeMessage.of(text: CommandMessages.shared.text(of: message), metadata: message.metadata) {
                WakeRow(id: message.id, wake: wake, at: message.time.created)
            }
        case .user(let message):
            let written = CommandMessages.shared.text(of: message)
            let (text, comments, paths, references) = SentMessage.split(written)
            let stored = (message.files ?? []).enumerated().map { AttachmentItem.stored($1, id: ConversationPictures.id(message: message.id, file: $0)) }
            YourMessage(text: text, references: references, folders: folders(), attachments: stored + Attachments.paths(paths, besides: (message.files ?? []).compactMap(\.fileURL)).map(AttachmentItem.path), comments: comments,
                        widget: SentMessage.widget(of: written), keyword: SentMessage.keyword(of: written), sent: Date(timeIntervalSince1970: message.time.created / 1000),
                        fromPhone: FromPhone.isFromPhone(written),
                        // Not in a bot's conversation, which is the bot's one: a session made from
                        // it would be no bot's, in no list you'd look in.
                        fork: bot == nil ? { fork(message) } : nil, undo: { undo(message) },
                        undoNote: YourMessage.undoNote(in: directory),
                        isOffline: isOffline)
        case .pending(let item):
            let (text, comments, paths, references) = SentMessage.split(item.text)
            UserBubble(text: text, references: references, folders: folders(), attachments: item.files.map(AttachmentItem.local) + item.inlineFiles.enumerated().map { AttachmentItem.stored($1, id: "\(item.id)#\(item.files.count + $0)") }
                           + Attachments.paths(paths, besides: item.files).map(AttachmentItem.path), comments: comments,
                       widget: SentMessage.widget(of: item.text), keyword: SentMessage.keyword(of: item.text), status: item.isLocal ? "Sending" : item.delivery == .queue ? "Queued" : "Sending")
                .contextMenu { Button("Cancel", role: .destructive) { cancel(item) }.disabled(isOffline) }
        case .assistant(let message, let showsError):
            AssistantStepView(message: message, directory: directory, folders: folders, showsError: showsError)
        case .more(let message, _):
            AssistantStepView(message: message, directory: directory, folders: folders, showsError: false)
        case .steps(_, let blocks, let keys, let isLive):
            StepsRow(scope: scope, blocks: blocks, keys: keys, isLive: isLive, directory: directory)
        case .widget(let call):
            WidgetCard(call: call, send: answerAgent)
        case .picture(let call):
            MadePictureRow(call: call, directory: directory)
        case .pictures(let calls):
            ShownPictures(calls: calls, directory: directory)
        case .sent(let call):
            AgentSentRow(call: call)
        case .subagent(let call):
            SubagentRow(call: call, directory: directory, scope: scope)
        case .turnEnd(let idle, let stats, let isLast, let isLatest):
            TurnEndView(idle: idle, stats: stats, directory: directory, retry: isLast && !isOffline && !takesNoMessages ? stats.message.map { message in { retry(message) } } : nil,
                        switchModel: isLast && !isOffline && !takesNoMessages ? switchModel : nil,
                        build: isLast && stats.agent == "plan" ? buildPlan : nil, reply: reply, isLatest: isLatest)
        case .shell(let shell):
            ShellRow(shell: shell)
        case .notice(_, _, let text):
            // Quiet, at the conversation's edge, as the steps' line is: no pill.
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .news(let id, let news, let at):
            AgentMessageRow(id: id, from: news.title, session: news.session, text: news.body, at: at, status: news.status)
        case .undone(let count):
            HStack(spacing: 10) {
                Text("Undid " + count.counting("message"))
                Button("Redo", action: redo)
                    .buttonStyle(.borderless)
                    .disabled(isOffline)
                    .fontWeight(.semibold)
            }
            // Quiet, at the conversation's edge: no pill.
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .help("Sending a message makes the undo final")
        case .working(let since, let quiet, let followsHeard, let holds, let summarizing):
            HStack(spacing: 8) {
                // A bot shows itself at work.
                if let bot {
                    BotAvatar(look: bot.look, size: 18, mood: .working)
                        .frame(width: 16)
                }
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let latest = heard()
                    // Against the engine's clock, as its times are: a machine's may be behind.
                    let text = Row.working(since: since, quiet: followsHeard ? latest.last ?? quiet : quiet, summarizing: summarizing, now: context.date.addingTimeInterval(-latest.offset / 1000))
                    Group {
                        if holds {
                            Text(text).foregroundStyle(.secondary)
                        } else {
                            ShimmerText(text: text)
                        }
                    }
                    .font(.callout)
                }
            }
        }
    }
}

struct UserBubble: View {
    let text: String
    /// Words with styling of their own (a group chat's mentions), in place of plain ones.
    var style: ((String) -> AttributedString?)?
    /// The bots and sessions it names with "&", and the project's folders for the files it names
    /// with "@": they stand out (see `MessageMentions`).
    var references: [AgentReferences.Reference] = []
    var folders: [String] = []
    var attachments: [AttachmentItem] = []
    var comments: [ReviewComment] = []
    /// The title of the widget it was sent from (`WidgetAnswer`), which shows over it.
    var widget: String?
    /// The keyword it was sent with, as typed (`SentWithKeyword`), drawn in front of its words (of
    /// its answer, after what it quotes) as the composer drew it: its mark for the "/", the rest
    /// in bold, in the accent.
    var keyword: String?
    var status: String?
    @Environment(\.findHighlight) private var highlight
    @Environment(AppModel.self) private var app
    /// The conversation this is in, where what it opens comes back to.
    @Environment(\.conversationTab) private var here

    /// A part of its words with its own styling, and what it names standing out: agents, files,
    /// web addresses as links, and its pictures' names as the composer showed them.
    private func styled(_ part: String, agents: [MessageMentions.Agent]) -> AttributedString? {
        let own = style?(part)
        let names = part.contains(AgentReferences.trigger) || (!folders.isEmpty && part.contains("@"))
        let marks = part.contains("http") || part.contains("www.") || part.contains("[Image ")
        // The Work Queue items it names, as chips once the box says what they are.
        let refs = part.contains("#") ? app.workQueues.refs(in: part, box: app.utilities.queueBox) : [:]
        guard names || marks || !refs.isEmpty else { return own }
        var text = own ?? AttributedString(part)
        if names { MessageMentions.apply(to: &text, agents: agents, folders: folders) }
        if marks { MessageMentions.applyLinksAndPictures(to: &text, pictures: attachments.count(where: \.isImage)) }
        if !refs.isEmpty { WorkItemChipAttachment.mark(&text, refs: refs) }
        return text
    }

    /// A message as its bubble shows it: its words, the review comments it was sent with, and
    /// the files it names as attached.
    static func split(_ message: String) -> (text: String, comments: [ReviewComment], paths: [String]) {
        let (text, comments, paths, _) = SentMessage.split(message)
        return (text, comments, paths)
    }

    /// A message's words, as its bubble shows them.
    static func words(of message: String) -> String {
        split(message).text
    }

    /// The parts of the words, in order: each quote it answers, then its answer.
    private static func parts(_ text: String) -> [(isQuote: Bool, text: String)] {
        let segments = Quoting.segments(text)
        if segments.count == 1, segments[0].quote == nil { return text.isEmpty ? [] : [(false, text)] }
        return segments.flatMap { segment in
            [segment.quote.map { (true, $0) }, segment.text.isEmpty ? nil : (false, segment.text)].compactMap { $0 }
        }
    }

    /// What Find reads in the bubble, in the order it's shown: the keyword it was sent with in
    /// front of its words, as drawn.
    static func findParts(_ text: String, keyword: String? = nil) -> [String] {
        let parts = parts(text)
        let answer = parts.firstIndex { !$0.isQuote }
        return parts.indices.map { index in
            guard let keyword, index == answer else { return parts[index].text }
            return String(MessageMentions.keyword(keyword, before: AttributedString(parts[index].text)).characters)
        }
    }

    /// Find's marks for each part, counted as Find counts them (`findParts`).
    static func findMarks(_ highlight: FindHighlight?, in text: String, keyword: String?) -> [FindHighlight]? {
        highlight?.spread(over: findParts(text, keyword: keyword))
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if !attachments.isEmpty {
                MessageAttachments(items: attachments)
                    .padding(.bottom, text.isEmpty ? 0 : 2)
            }
            if let widget {
                WidgetAnswerChip(title: widget)
            }
            ForEach(comments) { comment in
                CommentReference(comment: comment)
            }
            // What it replied to, each part above the words that answer it.
            let parts = Self.parts(text)
            let marks = Self.findMarks(highlight, in: text, keyword: keyword)
            let agents = MessageMentions.agents(references, bots: app.bots)
            ForEach(parts.indices, id: \.self) { index in
                Group {
                    if parts[index].isQuote {
                        QuoteBlock(text: parts[index].text)
                            .frame(maxWidth: 420, alignment: .trailing)
                            .padding(.top, index == 0 ? 0 : 6)
                    } else if let keyword, index == parts.firstIndex(where: { !$0.isQuote }) {
                        let part = parts[index].text
                        MessageText(text: keyword + " " + part, styled: MessageMentions.keyword(keyword, before: styled(part, agents: agents) ?? AttributedString(part)))
                    } else {
                        MessageText(text: parts[index].text, styled: styled(parts[index].text, agents: agents))
                    }
                }
                .environment(\.findHighlight, marks?[index])
            }
            if let status {
                Text(status)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .opacity(status == nil ? 1 : 0.7)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 80)
        // A named agent opens its conversation; a named file, in the side panel; a Work Queue
        // item, in the Work Queue.
        .environment(\.openURL, OpenURLAction { url in
            if let ref = WorkItemRefs.ref(in: url) {
                app.openWorkItem(ref)
                return .handled
            }
            if let session = MessageMentions.session(in: url) {
                if app.workspace.session(session) != nil { app.open(.session(session), from: here) }
                return .handled
            }
            guard url.isFileURL else { return .systemAction }
            app.utilities.show(url)
            return .handled
        })
    }
}

/// A message's words in its bubble. A long one (a pasted log, say) shows its first lines,
/// fading out, until you ask for the rest.
private struct MessageText: View {
    let text: String
    var styled: AttributedString?
    @Environment(\.findHighlight) private var highlight
    @Environment(\.messageFont) private var messageFont
    @Environment(\.colorScheme) private var scheme
    @State private var isExpanded = false
    /// The line limit leaves words out.
    @State private var isLimited = false
    /// Whether it does at the widths the words are measured at: Show More's room is in the
    /// message's height from then on (`ShowMoreLayout`).
    @State private var cuts = TextCuts()
    private static let lines = 12
    /// The bubble's room either side of its words.
    private static let inset: CGFloat = 14

    /// Short messages can't reach the limit, so they aren't asked whether it cuts them.
    private var mayBeLong: Bool {
        text.count > 300 || text.utf8.count { $0 == 10 } >= Self.lines
    }

    private var isCut: Bool { isExpanded || (mayBeLong && isLimited) }

    /// The words, with Find's marks, as AppKit's text draws them.
    private var shown: (text: NSAttributedString, faces: TextFaces) {
        MessageMentions.attributed(FindText.marked(styled ?? AttributedString(text), highlight), font: messageFont.field, dark: scheme == .dark)
    }

    var body: some View {
        ShowMoreLayout(cuts: cuts, inset: Self.inset, shows: isCut) {
            let shown = shown
            // AppKit's text, as the composer's: its pointer shows only where nothing's drawn over it.
            // Asked whether the limit cuts it only while there is one: all of it showing says nothing
            // of what Show Less brings back.
            // A short one has no Show More: never cut, however narrow its bubble.
            SelectableText(text: shown.text, faces: shown.faces, lineLimit: isExpanded || !mayBeLong ? nil : Self.lines,
                           cut: mayBeLong && !isExpanded ? { isLimited = $0 } : nil, cuts: mayBeLong ? cuts : nil)
                // Faded at the cut; masked only if it may be long (each mask is drawn off screen
                // first), and then all along, so the fade comes and goes over the same words.
                .modifier(CutFade(isOn: isCut && !isExpanded, isMasked: mayBeLong))
                .padding(.horizontal, Self.inset)
                .padding(.vertical, 10)
                // Your words in accent glass, apart from the agent's on the card.
                .modifier(BubbleSurface())
            if mayBeLong {
                // There, in the room it has once the words are measured cut, from when they say so.
                Button(isExpanded ? "Show Less" : "Show More") {
                    withAnimation(.ui) { isExpanded.toggle() }
                }
                .buttonStyle(TextButtonStyle(outset: true))
                .font(.system(size: 12, weight: .medium))
                .padding(.trailing, 6)
                .opacity(isCut ? 1 : 0)
                .disabled(!isCut)
                .accessibilityHidden(!isCut)
            }
        }
        // Find on a place in it: all of it shows, as the place may be past the cut.
        .onChange(of: highlight?.current) { if highlight?.current != nil, mayBeLong { isExpanded = true } }
    }
}

/// A long message's words over its Show More (or Show Less), at their trailing edge. The button's
/// room is part of the message's height as soon as its words are measured cut, so a conversation
/// measures the message as tall as it shows: it learns they're cut only once they're laid out, a
/// turn later, and the rows under it would slide down from under it then.
private struct ShowMoreLayout: Layout {
    let cuts: TextCuts
    /// How much narrower than the bubble its words are laid out.
    let inset: CGFloat
    /// The button shows: Show Less, or Show More once the words said they're cut.
    let shows: Bool
    private let spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let bubble = subviews.first?.sizeThatFits(proposal) else { return .zero }
        guard let button = button(proposal, subviews) else { return bubble }
        return CGSize(width: max(bubble.width, button.width), height: bubble.height + spacing + button.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let first = subviews.first else { return }
        let bubble = first.sizeThatFits(proposal)
        first.place(at: CGPoint(x: bounds.maxX, y: bounds.minY), anchor: .topTrailing, proposal: ProposedViewSize(width: proposal.width, height: bubble.height))
        // Without its room it doesn't show either: under the rest, out of the way.
        guard subviews.count > 1 else { return }
        let button = subviews[1].sizeThatFits(.unspecified)
        subviews[1].place(at: CGPoint(x: bounds.maxX, y: bounds.minY + bubble.height + spacing), anchor: .topTrailing, proposal: ProposedViewSize(button))
    }

    /// The button's size, if it has room: it shows, or the words are cut at the width they get.
    /// While it shows it keeps its room, so it's never drawn over what's under the message (a
    /// window widened past the cut takes the room back a turn later, as the button goes).
    private func button(_ proposal: ProposedViewSize, _ subviews: Subviews) -> CGSize? {
        guard subviews.count > 1 else { return nil }
        guard shows || proposal.width.flatMap({ cuts.at($0 - 2 * inset) }) == true else { return nil }
        return subviews[1].sizeThatFits(.unspecified)
    }
}

/// One model step: its reasoning, text and tool calls, in order.
private struct AssistantStepView: View {
    let message: Message.Assistant
    let directory: String
    let folders: () -> [String]
    let showsError: Bool

    @Environment(\.findHighlight) private var highlight

    /// Find's marks for each of its words, which Find reads one after another.
    private var marks: [Int: FindHighlight] {
        guard let highlight else { return [:] }
        let texts = message.content.enumerated().compactMap { index, block in
            if case .text(let text) = block { (index, text.text) } else { nil }
        }
        let folders = folders()
        let spread = highlight.spread(over: texts.map { FindText.shown(markdown: $0.1, folders: folders) })
        return Dictionary(uniqueKeysWithValues: zip(texts.map(\.0), spread))
    }

    var body: some View {
        let marks = marks
        let groups = MadePictureRow.groups(in: message.content)
        // A row of pictures that came one after another takes the place of the first; the others
        // are in it.
        let grouped = Set(groups.flatMap { start, calls in start..<(start + calls.count) })
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(message.content.enumerated()), id: \.offset) { index, block in
                Group {
                    if let calls = groups[index] {
                        ShownPictures(calls: calls, directory: directory)
                    } else if grouped.contains(index) {
                        EmptyView()
                    } else {
                        switch block {
                        case .text(let text):
                            // The last of a step under way: its words as they stream in. The same view
                            // once it's done, so finishing doesn't make the reply's views again (a
                            // frame of a tenth of a second at the end of each reply).
                            WritingText(row: message.id, part: index, text: text.text, folders: folders,
                                        isWriting: message.time.completed == nil && index == message.content.count - 1)
                        case .reasoning(let reasoning):
                            ReasoningView(block: reasoning, foldKey: message.id + "#\(index)")
                        case .tool(let call):
                            ToolCallView(call: call, directory: directory, foldKey: message.id + "#" + call.id)
                        case .other:
                            EmptyView()
                        }
                    }
                }
                // Only its words: Find doesn't look in its thinking and steps.
                .environment(\.findHighlight, marks[index])
            }
            if let retry = message.retry {
                Label("Retrying (attempt \(retry.attempt)): \(retry.error.message)", systemImage: "arrow.clockwise")
                    .font(.callout)
                    .foregroundStyle(.orange)
            }
            if showsError, let error = message.error {
                FailureCard(error)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The text a step under way ends in, which may still be being written: its words as they stream
/// in, from the session's `WritingBlock`, so more of them draw only this.
struct WritingText: View {
    /// Its row, and where it is among the step's blocks.
    let row: String
    let part: Int
    /// Its words when the conversation was last drawn.
    let text: String
    var folders: () -> [String] = { [] }
    /// Still being written; once it's done, just its words.
    var isWriting = true
    @Environment(WritingBlock.self) private var writing: WritingBlock?

    var body: some View {
        // Still being written: a code block it ends in is colored once it's done.
        let shown = isWriting ? writing?.text(row: row, part: part) ?? text : text
        MarkdownText(text: shown, folders: folders, agents: MarkdownText.agents(namedIn: shown), isWriting: isWriting)
    }
}

struct MarkdownText: View {
    /// The agents `text` names with "&" (a bot's face and color, as in your messages); none
    /// without an "&", so most replies aren't looked through.
    /// Only for a reply with an "&" before a name: one with "&&" or "& " in its code doesn't look
    /// up (and follow) your sessions.
    static func agents(namedIn text: String) -> [MessageMentions.Agent] {
        text.range(of: #"&[^\s&]"#, options: .regularExpression) != nil ? MessageMentions.agents(namedIn: text) : []
    }

    let text: String
    /// The project's folders: file names written as code in them become links.
    var folders: () -> [String] = { [] }
    /// In a group chat, its bots, for their mentions, and the agents a message names with "&".
    var mentions: [Bot] = []
    var agents: [MessageMentions.Agent] = []
    /// Still being written: a code block it ends in is colored once it's done.
    var isWriting = false
    @Environment(\.findHighlight) private var highlight

    var body: some View {
        #if DEBUG
        if Perf.plain { Text(text).transcriptFont().textSelection(.enabled) } else { pieces }
        #else
        pieces
        #endif
    }

    /// A long reply in pieces (see `MarkdownChunks`), so that as it streams in, only its last
    /// piece is read and laid out again.
    private var pieces: some View {
        let chunks = MarkdownChunks.split(text, isWriting: isWriting)
        // Find's marks, each piece's own.
        let marks = highlight.map { highlight in
            guard chunks.count > 1 else { return [highlight] }
            let folders = folders()
            return highlight.spread(over: chunks.map { FindText.shown(markdown: String($0.text), folders: folders) })
        }
        // The same stack for one piece or several, so the first stays as it is when a reply
        // grows long enough to be split.
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(chunks.indices, id: \.self) { index in
                // Code still being written is colored once it's done.
                MarkdownPiece(text: isWriting ? MarkdownChunks.text(of: chunks[index], marking: CodeLanguage.writing) : String(chunks[index].text),
                              folders: folders, mentions: mentions, agents: agents, highlight: marks?[index])
                    .equatable()
                    .padding(.top, chunks[index].gap)
            }
        }
    }
}

/// Markdown, drawn with TextKit (`ReplyView`). Equal when its words and marks are: a piece that's done isn't read
/// again as the rest of its reply streams in.
private struct MarkdownPiece: View, Equatable {
    let text: String
    let folders: () -> [String]
    let mentions: [Bot]
    let agents: [MessageMentions.Agent]
    let highlight: FindHighlight?
    @Environment(AppModel.self) private var app
    /// The conversation this is in, where what it opens comes back to.
    @Environment(\.conversationTab) private var here

    static func == (a: MarkdownPiece, b: MarkdownPiece) -> Bool {
        a.text == b.text && a.highlight == b.highlight && a.mentions == b.mentions && a.agents == b.agents
    }

    var body: some View {
        #if DEBUG
        if Perf.textual { textual } else { textKit }
        #else
        textKit
        #endif
    }

    /// With TextKit: a few views a piece, where Textual makes several for every block.
    private var textKit: some View {
        // Its ```mermaid blocks drawn as diagrams, as in a Markdown file's preview.
        // The Work Queue items it names, drawn as their chips once the box says what they are.
        let refs = text.contains("#") ? app.workQueues.refs(in: text, box: app.utilities.queueBox) : [:]
        return ReplyView(markdown: text, parser: FileLinkingParser(folders: folders, mentions: mentions, agents: agents, highlight: highlight, refs: refs), diagrams: true) { url in
            // A file opens in the side panel, a named agent its conversation, a Work Queue item
            // the Work Queue; web links in the browser.
            if let ref = WorkItemRefs.ref(in: url) {
                app.openWorkItem(ref)
                return true
            }
            if let session = MessageMentions.session(in: url) {
                if app.workspace.session(session) != nil { app.open(.session(session), from: here) }
                return true
            }
            guard url.isFileURL else { return false }
            app.utilities.show(url)
            return true
        }
        #if DEBUG
        .onAppear { ScrollFrameMonitor.piecesMade += 1 }
        #endif
    }

    private var textual: some View {
        StructuredText(text, parser: FileLinkingParser(folders: folders, mentions: mentions, agents: agents, highlight: highlight))
            // Textual reads it again only when the text changes: made again when the marks do.
            .id(highlight)
            .transcriptFont()
            // Closer to the text than the GitHub style, so they win: code blocks, and, with Find's
            // marks, inline code without its own background (the marks give it one).
            .textual.codeBlockStyle(CopyableCodeBlockStyle())
            .textual.listItemStyle(.firstLine)
            .textual.inlineStyle(highlight == nil ? .gitHub : .findMarks)
            .textual.highlighterTheme(CodeColors.theme)
            .textual.structuredTextStyle(.gitHub)
            .textual.textSelection(.enabled)
            // A file opens in the side panel, a named agent its conversation; web links in the browser.
            .environment(\.openURL, OpenURLAction { url in
                if let session = MessageMentions.session(in: url) {
                    if app.workspace.session(session) != nil { app.open(.session(session), from: here) }
                    return .handled
                }
                guard url.isFileURL else { return .systemAction }
                app.utilities.show(url)
                return .handled
            })
            #if DEBUG
            .onAppear { ScrollFrameMonitor.piecesMade += 1 }
            #endif
    }
}

/// The model's thinking: one quiet line, open it to read.
struct ReasoningView: View {
    let block: Message.Content.Text
    /// What your opening it is kept by, as its view may not last (see `CardFolds`).
    let foldKey: String
    @State private var opened = false
    @Environment(\.scrollAnchor) private var scrollAnchor

    private var isExpanded: Bool { CardFolds.shared.isOpen(foldKey, otherwise: opened) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                // Under way, it's kept in view as it grows, and stays where it is once it ends.
                CardFolds.shared.toggle(foldKey, open: !isExpanded, in: scrollAnchor, holds: block.isComplete)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "brain")
                        .frame(width: 16)
                    if block.isComplete {
                        Text(duration.map { "Thought for \($0)" } ?? "Thought")
                    } else {
                        ShimmerText(text: "Thinking…")
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .font(.callout)
            }
            .buttonStyle(TextButtonStyle(outset: true))
            .disabled(block.text.isEmpty)

            if isExpanded {
                // Thinking runs long, and grows as you read it.
                LongText(text: block.text)
                    .padding(.leading, 24)
                    .overlay(alignment: .topLeading) {
                        // The line down from the icon, beside the thinking, as steps have.
                        Capsule()
                            .fill(.separator)
                            .frame(width: 1)
                            .padding(.leading, 7.5)
                    }
                    // The space above it folds with it.
                    .padding(.top, 6)
                    .transition(.fold)
            }
        }
        .foldOpen(isExpanded)
        // Stays where it is from when it ends, as what's next comes in under it.
        .onChange(of: block.isComplete) { _, ended in
            if ended, CardFolds.shared.isOpen(foldKey, otherwise: false) { scrollAnchor?.reading?(foldKey, true) }
        }
        #if DEBUG
        // KUVO_DEMO_OPEN_STEPS: the thinking shows, opened.
        .onAppear { if ProcessInfo.processInfo.environment["KUVO_DEMO_OPEN_STEPS"] != nil { opened = true } }
        #endif
    }

    private var duration: String? {
        guard let start = block.time?.created, let end = block.time?.completed else { return nil }
        return MessageTime.duration(max(1, Int((end - start) / 1000)))
    }
}

/// The end of a turn: what it did (the files it changed, Stopped, what went wrong) and, under the
/// pointer, when it ended, how long it took and what it cost, with Copy and Reply. The last turn's
/// shows all the time.
private struct TurnEndView: View {
    let idle: Message.Idle
    let stats: TurnStats
    /// The session's folder, where the files the turn changed are.
    let directory: String
    /// Sends the turn's message again; offered on the last turn when it failed.
    var retry: (() -> Void)?
    /// Opens the composer's model picker; offered on the last turn when it failed for its model.
    var switchModel: (() -> Void)?
    /// Builds what a plan described; offered under Plan mode's last answer.
    var build: (() -> Void)?
    var reply: ((String) -> Void)?
    /// The latest turn's end: its row stays in view.
    var isLatest = false
    @Environment(AppModel.self) private var app
    @Environment(Catalog.self) private var catalog
    @Environment(\.conversationSignIn) private var signIn
    @Environment(TurnHover.self) private var hover: TurnHover?
    /// Its Copy or Reply has the keyboard (Tab, with keyboard navigation on): the row shows.
    @FocusState private var focused: Helper?

    private enum Helper { case copy, reply }

    /// Its time, numbers, Copy and Reply show: the last turn's, one under the pointer, and one whose
    /// buttons have the keyboard. KUVO_DEMO_SHOW_HOVER shows every turn's, and
    /// KUVO_DEMO_HOVER_TEXT the one whose reply says that, for screenshots.
    private var isShown: Bool {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if environment["KUVO_DEMO_SHOW_HOVER"] != nil { return true }
        if let text = environment["KUVO_DEMO_HOVER_TEXT"], stats.text.contains(where: { $0.contains(text) }) { return true }
        #endif
        return isLatest || hover?.turn == idle.id || focused != nil
    }

    /// When the turn ended.
    private var ended: Date {
        Date(timeIntervalSince1970: idle.time.created / 1000)
    }

    /// What kind of failure it was, for the card's headline and its way out.
    private var kind: FailureWords.Kind {
        guard let error = idle.error else { return .other }
        let kind = FailureWords.kind(type: error.type, message: error.message)
        // A provider that turned the request down for want of a sign-in, whatever the engine calls
        // it (not its quota, rate limit or content filter).
        if FailureWords.way(kind) != .signIn, Catalog.isSignInRefusal(type: error.type, message: error.message) { return .signIn(ended: false) }
        return kind
    }

    /// What its card offers for a sign-in, from here (none while offline).
    private var actions: SignInCard.Actions? {
        signIn.map { SignInCard.actions(failed: stats.model, current: $0.current, catalog: catalog) }
    }

    /// The engine's words under the headline; for a sign-in that ended, which the engine says only
    /// as "Request failed: 400", what happened and where to sign in again.
    private var detail: String? {
        guard let error = idle.error else { return nil }
        guard kind == .signIn(ended: true) else { return error.message }
        // A machine signs in on its own, to its plans, or to a plan's coding agent there.
        if let machine = RemoteFolder.machine(of: directory) {
            return "It couldn’t be renewed, so the request was refused. Sign in to it on \(machine) in Accounts, or use its plan’s coding agent there (Codex for ChatGPT)."
        }
        return "It couldn’t be renewed, so the request was refused. Sign in to its account again."
    }

    var body: some View {
        switch idle.outcome {
        case .failed:
            VStack(alignment: .leading, spacing: 8) {
                let way = FailureWords.way(kind)
                let actions = way == .signIn ? actions : nil
                // Signed out still: sending it again would only fail the same way, after a while.
                let retry = actions?.tryAgain == false ? nil : retry
                FailureCard(headline: FailureWords.headline(kind), detail: detail, hasActions: retry != nil || switchModel != nil && way == .switchModel || way == .signIn) {
                    switch way {
                    // The model's account, or a coding agent's, to sign in to, from here: where
                    // this conversation runs (a machine signs in on its own). Or another model.
                    case .signIn:
                        let machine = RemoteFolder.machine(of: directory)
                        if let signIn, let account = actions?.signIn {
                            let again = kind == .signIn(ended: true) ? "Sign In Again" : "Sign In"
                            Button(machine.map { "\(again) on \($0)" } ?? again) { signIn.open(account.providerID) }
                                .help("Sign in to \(catalog.signInName(account.providerID))\(machine.map { " on \($0): its sign-ins are its own" } ?? "")")
                            if actions?.switchModel == true, let switchModel {
                                Button("Switch Model", action: switchModel)
                                    .help("Choose another model for this conversation")
                            }
                        } else {
                            // Several to sign in to (a Custom Auto list's), or not known which: Accounts.
                            Button(machine.map { "Open Accounts on \($0)" } ?? "Open Accounts") { app.openAccounts(on: machine) }
                                .help(machine.map { "Accounts, on \($0): its sign-ins are its own" } ?? "Accounts")
                        }
                    case .switchModel:
                        if let switchModel {
                            Button("Switch Model", action: switchModel)
                                .help("Choose another model for this conversation")
                        }
                    case .none:
                        EmptyView()
                    }
                    if let retry {
                        Button("Try Again", action: retry)
                            .help("Send your last message again")
                    }
                }
                .buttonStyle(.glass)
                .controlSize(.small)
                // What it changed and said before failing, and when it ended.
                HStack(spacing: 6) {
                    if !stats.files.isEmpty {
                        TurnFiles(files: stats.files, directory: directory)
                    }
                    helpers
                }
            }
        // (One a newer engine says that this app doesn't know: it stopped.)
        case .interrupted, .unknown:
            HStack(spacing: 6) {
                Text("Stopped")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !stats.files.isEmpty {
                    TurnFiles(files: stats.files, directory: directory)
                }
                helpers
            }
        case .succeeded:
            // What it did first, in view; what shows under the pointer after it, so nothing in
            // view sits after a gap.
            HStack(spacing: 6) {
                if !stats.files.isEmpty {
                    TurnFiles(files: stats.files, directory: directory)
                }
                helpers
                if let build {
                    Button("Build It", action: build)
                        .buttonStyle(.glass)
                        .controlSize(.small)
                        .help("Switch to Build mode and have the agent carry out this plan")
                        .padding(.leading, 4)
                }
            }
        }
    }

    /// When it ended and its numbers, then Copy and Reply for what it said, however the turn
    /// ended: always laid out, shown as `isShown` says, so nothing moves when they appear.
    private var helpers: some View {
        HStack(spacing: 6) {
            // A reply after a change (another model, a summary) says so in view, as on the phone,
            // where a pill used to be; its buttons still wait for the pointer.
            Text(([MessageTime.sentAt(ended)] + stats.changes + parts).joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.tertiary)
                .help(SentTime.full(ended))
                .opacity(isShown || !stats.changes.isEmpty ? 1 : 0)
            if !stats.text.isEmpty {
                HStack(spacing: 6) {
                    CopyButton(text: stats.text.joined(separator: "\n\n"), help: "Copy the Reply")
                        .focused($focused, equals: .copy)
                    if let reply {
                        MessageActionButton(symbol: "arrowshape.turn.up.left", help: "Reply: quotes the whole reply in the composer") {
                            reply(stats.text.joined(separator: "\n\n"))
                        }
                        .focused($focused, equals: .reply)
                    }
                }
                .opacity(isShown ? 1 : 0)
            }
        }
        .animation(.easeOut(duration: 0.12), value: isShown)
        // VoiceOver reads it, and offers its buttons, shown or not: hidden, it would be skipped.
        .accessibilityRepresentation {
            HStack {
                Text(([SentTime.full(ended)] + stats.changes + parts).joined(separator: ", "))
                if !stats.text.isEmpty {
                    Button("Copy the Reply") { Clipboard.copy(stats.text.joined(separator: "\n\n")) }
                    if let reply { Button("Reply") { reply(stats.text.joined(separator: "\n\n")) } }
                }
            }
        }
    }

    private var parts: [String] {
        var parts: [String] = []
        if let started = stats.started, !stats.stepsSayTime {
            let seconds = Int((idle.time.created - started) / 1000)
            if seconds >= 1 { parts.append("Worked for " + MessageTime.duration(seconds)) }
        }
        if stats.outputTokens > 0 { parts.append("\(stats.outputTokens.compactTokens) tokens") }
        if let cost = stats.cost.formattedCost { parts.append(cost) }
        return parts
    }
}


/// "Edited 3 files" under a turn: the files it changed, each a click from the panel.
private struct TurnFiles: View {
    let files: [TurnStats.TurnFile]
    let directory: String
    @Environment(AppModel.self) private var app
    @Environment(\.bot) private var bot
    @State private var isShowing = false

    /// A bot's own memory, which it keeps up to date as it works: not a change to its work.
    private var onlyMemory: Bool {
        guard let bot, !files.isEmpty else { return false }
        let memory = RemoteFolder.parse(bot.memoryFile)?.path ?? bot.memoryFile
        return files.allSatisfy { $0.file == memory || $0.file == bot.memoryFile }
    }

    /// Some of them are in the folder the Changes panel shows (files elsewhere, like a bot's
    /// memory, aren't there).
    private var inChanges: Bool {
        let folder = (RemoteFolder.parse(directory)?.path ?? directory) + "/"
        return files.contains { $0.file.hasPrefix(folder) || !$0.file.hasPrefix("/") }
    }

    var body: some View {
        if onlyMemory, let bot {
            Button {
                app.utilities.show(RemoteFolder.fileURL(bot.memoryFile, in: bot.directory))
            } label: {
                Text("Updated its memory")
                    .font(.caption)
            }
            .buttonStyle(TextButtonStyle(outset: true))
            .help("Show \(bot.name)'s memory in the panel")
        } else {
            filesButton
        }
    }

    private var filesButton: some View {
        Button {
            isShowing.toggle()
        } label: {
            Text("Edited " + files.count.counting("file"))
                .font(.caption)
        }
        .buttonStyle(TextButtonStyle(outset: true))
        .help("What this turn changed")
        .closesWhenKept($isShowing)
        .popover(isPresented: $isShowing, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(files) { file in
                    Button {
                        isShowing = false
                        app.utilities.show(url(of: file))
                    } label: {
                        HStack(spacing: 8) {
                            Image(nsImage: NSWorkspace.shared.icon(of: url(of: file)))
                                .resizable()
                                .frame(width: 16, height: 16)
                            Text(relative(file.file))
                                .lineLimit(1)
                                .truncationMode(.head)
                            Spacer(minLength: 12)
                            if let lines = file.lines {
                                DiffStat(additions: lines.additions, deletions: lines.deletions)
                            } else {
                                Text("Written")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.horizontal, 8)
                        .frame(height: 26)
                        .contentShape(.rect)
                        .hoverHighlight(in: RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                    .help("Open in the Panel")
                }
                if inChanges {
                    Divider().padding(.vertical, 4)
                    Button("Show All Changes") {
                        isShowing = false
                        app.utilities.revealChanges()
                    }
                    .buttonStyle(.link)
                    .font(.callout)
                    .padding(.horizontal, 8)
                }
            }
            .font(.callout)
            .padding(8)
            .frame(width: 320)
            .popoverContent()
        }
    }

    private func url(of file: TurnStats.TurnFile) -> URL {
        RemoteFolder.fileURL(file.file, in: directory)
    }

    private func relative(_ path: String) -> String {
        // A machine's engine names files as they are there, without the ssh:// prefix.
        let directory = RemoteFolder.parse(directory)?.path ?? directory
        return path.hasPrefix(directory + "/") ? String(path.dropFirst(directory.count + 1)) : path
    }
}

/// One of the small buttons under a message, like the copy icon beside it.
/// When a message was sent: the time today, the day and time before that.
enum MessageTime {
    /// How long something took, short: "12s", "1m 5s", "2h 3m".
    static func duration(_ seconds: Int) -> String {
        switch seconds {
        case ..<60: "\(seconds)s"
        case ..<3600: "\(seconds / 60)m \(seconds % 60)s"
        default: "\(seconds / 3600)h \(seconds % 3600 / 60)m"
        }
    }

    static func sentAt(_ date: Date) -> String {
        SentTime.short(date)
    }
}

/// Which turn of the conversation the pointer is over. A reply is rows of its own (its words,
/// steps, what it made, its end), so the row under it (its time, Copy and Reply) shows from any of
/// them, as a message's does from its bubble.
@Observable final class TurnHover {
    /// A turn: its end, and what it said, which its Copy and Reply take.
    struct Turn: Equatable {
        /// None while it's under way.
        let end: String?
        let said: [String]

        var text: String { said.joined(separator: "\n\n") }
    }

    /// Each reply row's turn (see `TranscriptView.turns(of:)`), read as the pointer comes.
    @ObservationIgnored var turns: [String: Turn] = [:]
    /// The turn under the pointer, by its end.
    private(set) var turn: String?

    /// The pointer came to `row` (by its id), or off the rows.
    func point(at row: String?) {
        let turn = row.flatMap { turns[$0]?.end }
        if self.turn != turn { self.turn = turn }
    }
}

/// A row in the conversation, as part of its turn: on a reply's words, a right-click offers Copy
/// Reply and Reply, for all the turn said (what it's said so far, while it's under way).
private struct TurnRow: ViewModifier {
    let row: Row
    let hover: TurnHover
    let reply: ((String) -> Void)?

    /// All the turn said, read as it's asked for: the row isn't made again as its turn goes on.
    private func said(_ words: String) -> String {
        guard let turn = hover.turns[row.id], !turn.said.isEmpty else { return words }
        return turn.text
    }

    func body(content: Content) -> some View {
        if let words = row.words {
            content.contextMenu {
                Button("Copy Reply") { Clipboard.copy(said(words)) }
                if let reply { Button("Reply") { reply(said(words)) } }
            }
        } else {
            content
        }
    }
}

struct MessageActionButton: View {
    let symbol: String
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11))
        }
        .buttonStyle(IconButtonStyle())
        .accessibilityLabel(help)
        .help(help)
    }
}

/// A copy icon that turns into a checkmark for a moment once it's copied.
struct CopyButton: View {
    let text: String
    var help = "Copy"
    @State private var copied = false

    var body: some View {
        Button {
            Clipboard.copy(text)
            withAnimation(.ui) { copied = true }
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                withAnimation(.ui) { copied = false }
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 11))
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(IconButtonStyle())
        .accessibilityLabel(copied ? "Copied" : help)
        .help(copied ? "Copied" : help)
    }
}

/// Something that failed in a conversation, in one design wherever it shows: what happened as
/// the headline (`FailureWords`, the phone's too), the engine's own words under it, and the ways
/// out inside the card.
struct FailureCard<Actions: View>: View {
    let headline: String
    var detail: String?
    /// Whether it offers any (only the last turn does).
    var hasActions = true
    @ViewBuilder var actions: Actions

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(headline)
                        .font(.system(size: 13, weight: .semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = FailureWords.detail(detail, under: headline) {
                        SelectableText(text: NSAttributedString(string: detail, attributes: [.font: NSFont.preferredFont(forTextStyle: .callout), .foregroundColor: NSColor.secondaryLabelColor]))
                    }
                }
                if hasActions {
                    HStack(spacing: 8) { actions }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .recessedWell(RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
    }
}

extension FailureCard where Actions == EmptyView {
    init(headline: String, detail: String?) {
        self.init(headline: headline, detail: detail, hasActions: false) { EmptyView() }
    }

    /// An error the engine named, as its card says it.
    init(_ error: StructuredError) {
        self.init(headline: FailureWords.headline(FailureWords.kind(type: error.type, message: error.message)), detail: error.message)
    }
}

struct ErrorCard: View {
    let message: String

    var body: some View {
        Label {
            SelectableText(text: NSAttributedString(string: message, attributes: [.font: NSFont.preferredFont(forTextStyle: .callout), .foregroundColor: NSColor.labelColor]))
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
        }
        .font(.callout)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.08), in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.red.opacity(0.2)))
    }
}

/// What this agent wrote to another (send_message): to whom, what, and its answer when it
/// waited for one; with a way to that agent's conversation. It folds, as the others do.
private struct AgentSentRow: View {
    let call: Message.ToolCall
    @Environment(AppModel.self) private var app
    /// The conversation this is in, where what it opens comes back to.
    @Environment(\.conversationTab) private var here

    private var input: JSONValue? {
        let input: JSONValue? = switch call.state {
        case .running(let input, _), .completed(let input, _, _), .failed(let input, _, _, _): input
        case .streaming: nil
        }
        // Grok's, sent before the bridge read its arguments out of its own wrapping.
        if let wrapped = input?["tool_input"], wrapped["text"] != nil || wrapped["to"] != nil { return wrapped }
        return input
    }

    /// What the tool said back: the answer it waited for, or that it's sent.
    private var said: String? {
        guard case .completed(_, let output, _) = call.state else { return nil }
        return output.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined()
    }

    var body: some View {
        let to = input?["to"]?.string
        let address = to.flatMap { AgentMail.shared.agent(named: $0) }
        let name = AgentMail.shared.name(of: to)
        let text = input?["text"]?.string ?? ""
        let answer = said.flatMap { said in said.range(of: " answered:\n\n").map { String(said[$0.upperBound...]) } }
        FoldingCard(id: call.id, summary: text, startsOpen: FoldingCard<EmptyView, EmptyView, EmptyView>.isShort(text + (answer ?? "")), help: "A message this agent sent another") {
            Image(systemName: "paperplane.fill")
                .foregroundStyle(.tint)
                .frame(width: 16)
            Text("To \(Text(name).fontWeight(.semibold).foregroundStyle(.primary))")
                .foregroundStyle(.secondary)
            if case .running = call.state, input?["wait"]?.bool == true {
                StepActivity(symbol: nil, running: true, size: 12)
                Text("Waiting for its answer")
                    .foregroundStyle(.secondary)
                if let since = call.time?.created?.date {
                    StepActivity.Elapsed(since: since)
                }
            }
            if case .failed = call.state {
                Text("Didn't go")
                    .foregroundStyle(.orange)
            }
        } accessory: {
            if let session = address?.session, app.workspace.session(session) != nil {
                Button("Open") { app.open(.session(session), from: here) }
                    .opensInNewTab(.session(session))
                    .buttonStyle(TextButtonStyle(outset: true))
                    .help("Open \(name)'s conversation")
            }
        } content: {
            if !text.isEmpty {
                MarkdownText(text: text, agents: MarkdownText.agents(namedIn: text))
                    .padding(.leading, 24)
            }
            // What it answered, when it was waited for.
            if let answer {
                Divider().padding(.leading, 24)
                Text("\(Text(name).fontWeight(.semibold)) answered")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 24)
                MarkdownText(text: answer, agents: MarkdownText.agents(namedIn: answer))
                    .padding(.leading, 24)
            }
        }
    }
}

/// Which of the agents' cards you folded or opened, while the app runs, so one drawn again (as
/// you scroll) stays as you left it.
@MainActor
@Observable
final class CardFolds {
    static let shared = CardFolds()
    private var choices: [String: Bool] = [:]

    func isOpen(_ id: String, otherwise open: Bool) -> Bool { choices[id] ?? open }
    func set(_ id: String, open: Bool) { choices[id] = open }
    func forget(_ id: String) { choices[id] = nil }
    /// What was opened or closed among those kept under this, closed with what they're in.
    func kept(under prefix: String) -> [String] { choices.keys.filter { $0.hasPrefix(prefix) } }

    /// Steps you opened or closed, in their conversation: opened, once they have, the end is no
    /// longer followed, so what comes in next doesn't move what you read (`holds` false: a step
    /// under way, kept in view until it ends); closing what you opened goes back to it (see
    /// `ConversationScroller.reading`). `closes`: what goes with it.
    func toggle(_ id: String, open: Bool, in anchor: ScrollAnchor?, holds: Bool = true, closes: [String] = []) {
        withAnimation(.ui) {
            set(id, open: open)
            closes.forEach(forget)
        } completion: { [weak anchor] in
            // Not if you've changed your mind since. (What's closed with others is forgotten.)
            guard self.isOpen(id, otherwise: closes.contains(id) ? false : !open) == open else { return }
            for closed in closes { anchor?.reading?(closed, false) }
            if !open || holds { anchor?.reading?(id, open) }
        }
    }
}

/// Words between agents, in a well: a header (what it is, from or to whom) whose click folds the
/// words under it to their first line, and opens them again; what's at its end (the time, Open)
/// stays out of the click. Long ones start folded.
private struct FoldingCard<Header: View, Accessory: View, Content: View>: View {
    let id: String
    /// The words, of which the first line shows while it's folded.
    let summary: String
    let startsOpen: Bool
    let help: String
    /// How many lines of `summary` it shows folded.
    var summaryLines = 1
    @ViewBuilder var header: Header
    @ViewBuilder var accessory: Accessory
    @ViewBuilder var content: Content
    @State private var isHoveringHeader = false

    private static var radius: CGFloat { 10 }
    private static var padding: CGSize { CGSize(width: 10, height: 9) }
    /// How far the header's fill under the pointer sits from the card's edge.
    private static var chipInset: CGFloat { 4 }

    /// A few lines at most: shown open from the start.
    static func isShort(_ text: String) -> Bool {
        text.count <= 320 && text.split(whereSeparator: \.isNewline).count <= 4
    }

    private var firstLine: String {
        let line = summary.split(whereSeparator: \.isNewline).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
        // Markdown's marks out of it, but not underscores, which names and addresses have.
        return line.replacingOccurrences(of: #"[*`]+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"^[\s#>-]+"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    var body: some View {
        let folds = CardFolds.shared
        let open = folds.isOpen(id, otherwise: startsOpen)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Button {
                    withAnimation(.ui) { folds.set(id, open: !open) }
                } label: {
                    // Centered, not on the first baseline: the first line leaving as it opens would
                    // slide up out of line with the header while it fades. (Two lines of it keep to the
                    // header's line.)
                    HStack(alignment: summaryLines > 1 ? .firstTextBaseline : .center, spacing: 8) {
                        header
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(open ? 90 : 0))
                        if !open, !firstLine.isEmpty {
                            Text(firstLine)
                                .foregroundStyle(.secondary)
                                .lineLimit(summaryLines)
                                .truncationMode(.tail)
                        }
                    }
                    // A fill under the pointer that reaches past the words without moving them,
                    // as far as the card's padding allows less `Self.chipInset` on every side, so
                    // its corners sit concentric with the card's (the card's radius less that inset).
                    .padding(.horizontal, Self.padding.width - Self.chipInset)
                    .padding(.vertical, Self.padding.height - Self.chipInset)
                    .background(isHoveringHeader ? Pressable.hoverFill : .clear, in: .rect(cornerRadius: Self.radius - Self.chipInset))
                    .background(HoverTracker { isHoveringHeader = $0 })
                    .padding(.horizontal, -(Self.padding.width - Self.chipInset))
                    .padding(.vertical, -(Self.padding.height - Self.chipInset))
                    .contentShape(.rect)
                    .animation(.easeOut(duration: 0.12), value: isHoveringHeader)
                }
                .buttonStyle(.plain)
                .clickablePointer()
                .help(open ? "Fold it to its first line" : "Show all of it")
                Spacer(minLength: 8)
                accessory
            }
            .font(.callout)
            if open {
                // The space above it folds with it.
                content
                    .padding(.top, 6)
                    .transition(.fold)
            }
        }
        .padding(.horizontal, Self.padding.width)
        .padding(.vertical, Self.padding.height)
        .recessedWell(RoundedRectangle(cornerRadius: Self.radius))
        .padding(.horizontal, -Self.padding.width)
        .help(help)
    }
}

/// A message another agent sent this one: who from, and what; it folds, as the others do.
private struct AgentMessageRow: View {
    let id: String
    let from: String
    let session: String
    let text: String
    /// When it came; none while it waits to go in.
    let at: Milliseconds?
    /// What happened, after its name, for one of its sessions' news: "finished", "still working".
    var status: String?
    @Environment(AppModel.self) private var app
    /// The conversation this is in, where what it opens comes back to.
    @Environment(\.conversationTab) private var here

    var body: some View {
        FoldingCard(id: id, summary: text, startsOpen: FoldingCard<EmptyView, EmptyView, EmptyView>.isShort(text),
                    help: status == nil ? "A message another agent sent this one" : "One of the sessions this agent started, telling it what it did") {
            Image(systemName: "paperplane")
                .foregroundStyle(.tint)
                .frame(width: 16)
            Text("From \(Text(from).fontWeight(.semibold).foregroundStyle(.primary))\(status.map { " · \($0)" } ?? "")")
                .foregroundStyle(.secondary)
        } accessory: {
            if let at {
                Text(Date(timeIntervalSince1970: at / 1000), format: .dateTime.hour().minute())
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            if app.workspace.session(session) != nil {
                Button("Open") { app.open(.session(session), from: here) }
                    .opensInNewTab(.session(session))
                    .buttonStyle(TextButtonStyle(outset: true))
                    .help("Open \(from)'s conversation")
            }
        } content: {
            MarkdownText(text: text, agents: MarkdownText.agents(namedIn: text))
                .padding(.leading, 24)
        }
    }
}

/// A part of a group chat's work, handed to this bot: which chat it's from, and what to do; it
/// folds, as the others do.
private struct GroupWorkRow: View {
    let id: String
    let chat: String
    let chatID: String
    let task: String
    let at: Milliseconds
    @Environment(AppModel.self) private var app
    /// The conversation this is in, where what it opens comes back to.
    @Environment(\.conversationTab) private var here

    var body: some View {
        FoldingCard(id: id, summary: task, startsOpen: FoldingCard<EmptyView, EmptyView, EmptyView>.isShort(task),
                    help: "This bot's part of the work agreed in a group chat; it reports back there when it's done") {
            Image(systemName: "person.3")
                .foregroundStyle(.tint)
                .frame(width: 16)
            Text("Work from \(Text(chat).fontWeight(.semibold).foregroundStyle(.primary))")
                .foregroundStyle(.secondary)
        } accessory: {
            Text(Date(timeIntervalSince1970: at / 1000), format: .dateTime.hour().minute())
                .font(.caption)
                .foregroundStyle(.tertiary)
            if app.chats.group(chatID) != nil {
                Button("Open") { app.open(.group(chatID), from: here) }
                    .opensInNewTab(.group(chatID))
                    .buttonStyle(TextButtonStyle(outset: true))
                    .help("Open \(chat)")
            }
        } content: {
            MarkdownText(text: task)
                .padding(.leading, 24)
        }
    }
}

/// A conversation woke itself up, as its agent planned: its note to itself, in place of a message
/// from you. A long one folds to its summary (KuvoClient's WakeMessage: the one its agent gave, or the
/// note's first sentence), two lines at most, and opens to the note its agent read whole.
struct WakeRow: View {
    let id: String
    let wake: WakeMessage
    let at: Milliseconds
    @Environment(\.findHighlight) private var highlight

    private static let help = "A wake-up the agent scheduled for itself"

    /// The note, as the text of a message.
    private func written(_ text: String, color: NSColor) -> NSAttributedString {
        MessageMentions.attributed(FindText.marked(AttributedString(text), highlight), font: NSFont.preferredFont(forTextStyle: .callout), color: color).text
    }

    /// "Woke up", then its note.
    private var words: NSAttributedString {
        let font = NSFont.preferredFont(forTextStyle: .callout)
        let words = NSMutableAttributedString(string: "Woke up  ", attributes: [
            .font: NSFont.systemFont(ofSize: font.pointSize, weight: .semibold), .foregroundColor: NSColor.labelColor,
        ])
        words.append(written(wake.note, color: .secondaryLabelColor))
        return words
    }

    private var time: some View {
        Text(Date(timeIntervalSince1970: at / 1000), format: .dateTime.hour().minute())
            .font(.caption)
            .foregroundStyle(.tertiary)
    }

    var body: some View {
        if wake.folds {
            // Open while you find in the conversation, so what's found shows (one you fold stays so).
            FoldingCard(id: id, summary: wake.summary, startsOpen: highlight != nil, help: Self.help, summaryLines: 2) {
                Image(systemName: "alarm")
                    .foregroundStyle(.tint)
                    .frame(width: 16)
                Text("Woke up")
                    .fontWeight(.semibold)
                    .fixedSize()
            } accessory: {
                time
            } content: {
                SelectableText(text: written(wake.note, color: .labelColor))
                    .padding(.leading, 24)
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "alarm")
                    .foregroundStyle(.tint)
                    .frame(width: 16)
                // Short (WakeMessage.folds): whole.
                SelectableText(text: words)
                Spacer(minLength: 8)
                time
            }
            .font(.callout)
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .recessedWell(RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, -10)
            .help(Self.help)
        }
    }
}

/// A session with nothing in it yet.
struct EmptyConversationView: View {
    let directory: String
    /// Sends a message, for a bot's first start.
    var send: (String) -> Void = { _ in }
    @Environment(\.bot) private var bot
    @State private var isHoveringBot = false

    var body: some View {
        if let bot {
            // A bot, before its first task: who it is and what it's for.
            VStack(spacing: 12) {
                // Still: the bot moves in its sidebar row; pointed at, it notices.
                BotAvatar(look: bot.look, size: 64, mood: .idle, noticed: isHoveringBot, animates: false)
                    .onHover { isHoveringBot = $0 }
                VStack(spacing: 4) {
                    Text(bot.name)
                        .font(.title2.weight(.semibold))
                    if bot.job.isEmpty {
                        // No job yet: it asks for one, and your first message gives it.
                        Text(Self.purposeQuestion)
                            .font(.title3)
                    } else {
                        Text(bot.job)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(bot.job.isEmpty
                    ? "Tell me in a message what you'd like me to do, and I'll keep it as my job. You can change it any time by telling me."
                    : "Start \(bot.name) on its job, or tell it more about it. It keeps its job in its memory, remembers what it learns, and can wake itself up later to carry on.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 340)
                if !bot.job.isEmpty {
                    Button("Start Its Job") { send(Self.kickoff) }
                        .buttonStyle(.glassProminent)
                        .controlSize(.large)
                        .padding(.top, 4)
                        .help("\(bot.name) reads its job, asks you for anything it needs, and starts")
                }
            }
            .padding(.bottom, 120)
        } else {
            plain
        }
    }

    /// A bot's first message: start on the job it was given.
    /// What a bot without a job asks you.
    static let purposeQuestion = "What's my purpose?"

    static let kickoff = "Start on your job now: read your job and the rest of your memory, ask me for anything you need to get going (like what to watch or which topics), do the first round, and if your job repeats or keeps an eye on something, set that up (a repeating wake-up, or a watch)."

    private var plain: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.tertiary)
            Text(Workspace.isChat(directory) ? "What's on your mind?" : "What should we work on in \((directory as NSString).lastPathComponent)?")
                .font(.title3.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .padding(.bottom, 120)
    }
}

/// Your words' bubble: accent glass.
private struct BubbleSurface: ViewModifier {
    func body(content: Content) -> some View {
        #if DEBUG
        if Perf.noGlass {
            content.background(Color.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: Metrics.bubbleRadius))
        } else {
            content.accentGlass(RoundedRectangle(cornerRadius: Metrics.bubbleRadius))
        }
        #else
        content.accentGlass(RoundedRectangle(cornerRadius: Metrics.bubbleRadius))
        #endif
    }
}

#if DEBUG
/// KUVO_PERF_*: parts of the transcript turned off, to measure what scrolling costs.
enum Perf {
    static let plain = ProcessInfo.processInfo.environment["KUVO_PERF_PLAIN"] != nil
    static let noGlass = ProcessInfo.processInfo.environment["KUVO_PERF_NO_GLASS"] != nil
    static let noEdge = ProcessInfo.processInfo.environment["KUVO_PERF_NO_EDGE"] != nil
    static let noAnimation = ProcessInfo.processInfo.environment["KUVO_PERF_NO_ANIM"] != nil
    /// KUVO_PERF_TEXTUAL: replies drawn by Textual, as they were, instead of TextKit (`ReplyView`).
    static let textual = ProcessInfo.processInfo.environment["KUVO_PERF_TEXTUAL"] != nil
    /// KUVO_PERF_LAZY: rows in the lazy stack, as they were, instead of `RowStack`.
    static let lazy = ProcessInfo.processInfo.environment["KUVO_PERF_LAZY"] != nil
}
#endif

/// The conversation's rows as last made, and what they were made from.
final class RowCache {
    struct Key: Equatable {
        var version: Int
        var detail: StepsDetail
        var revert: String?
        var waiting: [String]
        /// The session's model, which a turn that failed before any reply runs on.
        var model: ModelRef?
    }

    /// What changing animates: rows added or taken away at the end.
    struct Change: Hashable {
        var count: Int
        var last: String?
    }

    var key: Key?
    var rows: [Row] = []
    /// The last change came all at once.
    var isBulk = true
}

/// The end of a message or a tool's output that's cut short, fading out.
struct CutFade: ViewModifier {
    let isOn: Bool
    /// Masked whether it fades or not, so turning the fade on and off keeps what's under it (a
    /// text and its selection) rather than drawing it anew. By default, masked only while it fades.
    var isMasked = false

    func body(content: Content) -> some View {
        if isOn || isMasked {
            content.mask {
                LinearGradient(stops: [.init(color: .black, location: 0.7), .init(color: .black.opacity(isOn ? 0.15 : 1), location: 1)], startPoint: .top, endPoint: .bottom)
            }
        } else {
            content
        }
    }
}

extension TranscriptView {
    /// A run cut off with no end of its own (Kuvo Code quit, or its engine stopped, while it
    /// worked): the step it stopped in, which the conversation says was interrupted, rather than
    /// ending on a failed step. None while it runs, or once its run has an end (Stop gives it one).
    static func interruptedStep(in messages: [Message], isRunning: Bool) -> Message.Assistant? {
        let last = messages.last { message in
            switch message {
            case .modelSwitched, .agentSwitched: false
            default: true
            }
        }
        guard !isRunning, case .assistant(let step)? = last, step.error?.isInterruption == true else { return nil }
        return step
    }
}

/// A failed turn's card signs in to its model's account (a provider's ID) from here.
struct ConversationSignIn {
    /// The model the conversation is on now, which Try Again sends with.
    let current: ModelRef?
    let open: (String) -> Void
}

extension EnvironmentValues {
    @Entry var conversationSignIn: ConversationSignIn?
}

enum SignInCard {
    /// What a card for a sign-in offers: Sign In to the account of the model the turn failed on
    /// (one with a sign-in, not Auto's: Accounts lists a Custom Auto list's several), Switch Model
    /// while the conversation is still on that model and it's still signed out, and Try Again
    /// unless the model the conversation is on now is signed out (it sends with that one).
    struct Actions: Equatable {
        var signIn: ModelRef?
        var switchModel = false
        var tryAgain = true
    }

    static func actions(failed: ModelRef?, current: ModelRef?, catalog: Catalog) -> Actions {
        func signedOut(_ ref: ModelRef?) -> Bool {
            guard let ref, ref.providerID != OutsideAgents.autoProvider else { return false }
            return catalog.needsSignIn(ref) || catalog.hasEndedSignIn(ref.providerID)
        }
        guard let failed, failed.providerID != OutsideAgents.autoProvider, catalog.offersSignIn(failed.providerID) else {
            return Actions(tryAgain: !signedOut(current))
        }
        let onIt = current.map { $0.providerID == failed.providerID && $0.id == failed.id } ?? true
        return Actions(signIn: failed, switchModel: onIt && signedOut(failed), tryAgain: !signedOut(current ?? failed))
    }
}
