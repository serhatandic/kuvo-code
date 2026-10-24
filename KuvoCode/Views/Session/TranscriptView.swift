import AppKit
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
    @AppStorage(StepsDetail.key) private var stepsDetail = StepsDetail.summary
    @State private var scroller = ConversationScroller()
    @State private var rowCache = RowCache()
    /// Find in the conversation (⌘F).
    @State private var find = ConversationFind()

    /// The thinking under way at the end, if any.
    private static func thinking(in rows: [Row]) -> Thinking? {
        for row in rows.reversed() {
            guard case .steps(let id, let blocks, let isLive) = row else { continue }
            guard isLive, case .reasoning = blocks.last else { return nil }
            return Thinking(row: id, step: blocks.count)
        }
        return nil
    }

    var body: some View {
        let rows = rows
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
        }
        // The reply being written draws its words from it.
        .environment(model.writing)
        // What a widget writes back goes to this conversation's agent, as yours.
        .environment(\.answerAgent) { text in model.submit(text, files: [], for: nil, queue: false, commands: []) }
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
                 space: { row, index in index == 0 ? 0 : row.spacing(after: rows[index - 1]) }) { row, index in
            RowView(row: row, directory: model.session.location.directory, folders: model.folders, heard: model.heard, cancel: model.cancelPending, undo: model.undo(from:), redo: model.redo, fork: fork, retry: model.retry(_:), buildPlan: model.agent == "plan" && !isOffline ? { model.buildPlan() } as () -> Void : nil, reply: model.reply(to:))
                .equatable()
                .environment(\.findHighlight, find.highlight(for: row.id))
                .padding(.top, index == 0 ? 0 : row.spacing(after: rows[index - 1]))
        }
    }

    #if DEBUG
    /// The rows, in the lazy stack (KUVO_PERF_LAZY).
    @ViewBuilder private func stackRows(_ rows: [Row]) -> some View {
        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
            RowView(row: row, directory: model.session.location.directory, folders: model.folders, heard: model.heard, cancel: model.cancelPending, undo: model.undo(from:), redo: model.redo, fork: fork, retry: model.retry(_:), buildPlan: model.agent == "plan" && !isOffline ? { model.buildPlan() } as () -> Void : nil, reply: model.reply(to:))
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
        let key = RowCache.Key(version: model.transcriptVersion, detail: stepsDetail, revert: model.session.revert?.messageID, waiting: model.waiting.map(\.id))
        if rowCache.key == key { return rowCache.rows }
        let rows = buildRows()
        // A whole history arriving at once (opening, loading more) comes without its rows fading in.
        rowCache.isBulk = abs(rows.count - rowCache.rows.count) > 3
        rowCache.key = key
        rowCache.rows = rows
        return rows
    }

    private func buildRows() -> [Row] {
        var rows: [Row] = []
        var turn = TurnStats()
        // An undo waiting to be kept ends the conversation at its message: by where it is, as a
        // message queued during a run is older than that run's later steps.
        let boundary = model.session.revert?.messageID
        let all = model.transcript.messages
        let cut = boundary.map { boundary in all.firstIndex { $0.id == boundary } ?? all.firstIndex { $0.id >= boundary } ?? all.count }
        let messages = cut.map { Array(all[..<$0]) } ?? all
        // Summed up: the agent's steps between its replies, gathered into one row.
        var steps: [Message.Content] = []
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
        let last = messages.lastIndex { message in
            switch message {
            case .modelSwitched, .agentSwitched: false
            default: true
            }
        }
        func flushSteps(live: Bool) {
            guard !steps.isEmpty else { return }
            rows.append(.steps(stepsID, steps, isLive: live))
            steps = []
        }
        for (index, message) in messages.enumerated() {
            if case .assistant = message {} else { flushSteps(live: false) }
            switch message {
            case .user(let user):
                turn = TurnStats(started: user.time.created, message: user)
                rows.append(.user(user))
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
                        rows.append(.picture(call))
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
                rows.append(.turnEnd(idle, turn, isLast: index == last))
                turn = TurnStats()
            case .modelSwitched(let change):
                // By its name, as the model menu shows it ("Big Pickle", not big-pickle).
                rows.append(.notice(change.id, "cpu", "Switched to \(catalog.model(change.model)?.name ?? change.model.id)" + (change.model.variant.map { " · \(EffortLevel.title($0))" } ?? "")))
            case .agentSwitched(let change):
                rows.append(.notice(change.id, change.agent == "plan" ? "list.bullet.clipboard" : "hammer", "\(change.agent.capitalized) mode"))
            case .compaction(let compaction):
                let words = switch compaction.status {
                case "running": "Summarizing the conversation…"
                case "failed": "Couldn’t summarize the conversation"
                default: "Summarized the conversation to save space"
                }
                rows.append(.notice(compaction.id, "rectangle.compress.vertical", words))
            case .shell(let shell):
                rows.append(.shell(shell))
            case .synthetic(let notice), .system(let notice):
                // A turn the app or the engine started (a model switched mid-run carries on), timed
                // from it as one you started is from your message.
                if turn.started == nil { turn.started = notice.time.created }
                let sources = notice.instructionSources
                if !sources.isEmpty, sources.allSatisfy({ $0.contains(ProjectFolders.instructionKey) }) {
                    rows.append(.notice(notice.id, "folder", "Project folders updated"))
                } else if !sources.isEmpty, sources.allSatisfy({ $0.hasPrefix("core/") || $0.contains(Workspace.worktreeInstructionKey) || $0.contains(Bots.instructionKey) }) {
                    // The engine's own guidance (for the browser tools, say), or what Kuvo Code
                    // adds for a worktree or a bot: nothing you set.
                    break
                } else if notice.metadata?["source"]?.string == "shell" {
                    // A command the agent left running in the background ended, which wakes it.
                    rows.append(.notice(notice.id, "terminal", Self.backgroundEnd(notice)))
                } else if notice.text.hasPrefix("<system-reminder>") {
                    // The engine's word to the model, not to you. Plan mode's rules say the mode,
                    // for a session that starts in it (a switch says so itself); not the one that
                    // says it's left ("You are NO LONGER in Plan mode", after Build It).
                    if notice.text.contains("Plan mode"), notice.text.range(of: "no longer in Plan mode", options: .caseInsensitive) == nil {
                        if case .notice(_, "list.bullet.clipboard", _)? = rows.last {} else {
                            rows.append(.notice(notice.id, "list.bullet.clipboard", "Plan mode: it explores and plans, without changing files"))
                        }
                    }
                } else if notice.text.hasPrefix("Your last response hit the output token limit") {
                    // The engine asking the model to go on after a reply ran out of room.
                    rows.append(.notice(notice.id, "arrow.turn.down.right", "Hit the length limit for one reply, so it carried on"))
                } else {
                    rows.append(.notice(notice.id, "info.circle", notice.description ?? notice.text))
                }
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
        rows += model.transcript.pending.filter { !waiting.contains($0.id) }.map(Row.pending)
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
            default: break
            }
            rows.append(.working(since: turn.started, quiet: quiet, followsHeard: followsHeard))
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
    /// What the agent wrote, for copying the reply.
    var text: [String] = []
    /// The mode that answered: a plan can be built from its end.
    var agent: String?
    /// The files the agent changed, in the order first changed, with their lines.
    var files: [TurnFile] = []

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
    case steps(String, [Message.Content], isLive: Bool)
    /// Something the agent made with show_widget, drawn in the conversation.
    case widget(Message.ToolCall)
    /// An image it made.
    case picture(Message.ToolCall)
    /// What it wrote to another agent (send_message).
    case sent(Message.ToolCall)
    /// A subagent it handed part of the work to.
    case subagent(Message.ToolCall)
    /// `isLast`: the conversation ends here, so a failed run can be tried again.
    case turnEnd(Message.Idle, TurnStats, isLast: Bool)
    case notice(String, String, String)
    /// A command you ran with "!".
    case shell(Message.Shell)
    case pending(Transcript.Pending)
    /// An undo that the next message makes final, with how many messages it took back.
    case undone(Int)
    /// The agent at work, since the time of your message.
    /// `quiet`: since when nothing has come back from the model.
    /// `followsHeard`: quiet since the model last sent anything, which new words move on without
    /// the rows being made again (see `RowView.heard`).
    case working(since: Milliseconds?, quiet: Milliseconds?, followsHeard: Bool)

    /// The words Find looks in, as the row shows them: messages, replies, and commands you ran
    /// with what they printed.
    var findParts: [ConversationFind.Part] {
        switch self {
        case .user(let message):
            let text = CommandMessages.shared.text(of: message)
            if let mail = AgentMail.parse(text) { return [.markdown(mail.text)] }
            if text.hasPrefix(Wakes.marker) { return [.plain(String(text.dropFirst(Wakes.marker.count)))] }
            if let work = GroupWork.parse(text) { return [.markdown(work.task)] }
            return UserBubble.findParts(UserBubble.words(of: text)).map(ConversationFind.Part.plain)
        case .pending(let item):
            return UserBubble.findParts(UserBubble.words(of: item.text)).map(ConversationFind.Part.plain)
        case .assistant(let message, _), .more(let message, _):
            return message.content.compactMap { if case .text(let part) = $0 { .markdown(part.text) } else { nil } }
        case .shell(let shell):
            return [.plain(shell.command), .plain(ShellRow.output(of: shell))]
        default:
            return []
        }
    }

    /// Its words as a selection across the conversation copies it whole: as it reads (Markdown
    /// as shown), a line of steps as its summary.
    func copiedText(folders: [String]) -> String {
        switch self {
        case .steps(_, let blocks, _):
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
        case (_, .widget), (.widget, _), (_, .sent), (.sent, _): 14
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
        case .steps(let id, _, _): id
        case .widget(let call): call.id
        case .picture(let call): call.id
        case .sent(let call): call.id
        case .subagent(let call): call.id
        case .turnEnd(let m, _, _): m.id
        case .notice(let id, _, _): id
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
    let directory: String
    let folders: () -> [String]
    /// When the model was last heard, and how far this Mac's clock is ahead of the engine's, as of
    /// now: the working line reads them each second.
    let heard: () -> (last: Milliseconds?, offset: Milliseconds)
    let cancel: (Transcript.Pending) -> Void
    let undo: (Message.User) -> Void
    let redo: () -> Void
    let fork: (Message.User) -> Void
    let retry: (Message.User) -> Void
    /// While the session is in Plan mode: build what the last answer planned.
    let buildPlan: (() -> Void)?
    /// Quotes a reply (or the part of it you selected) in the composer.
    let reply: (String) -> Void
    @Environment(\.answerAgent) private var answerAgent
    @Environment(\.isOffline) private var isOffline
    @Environment(\.isSubagentConversation) private var isSubagent

    static func sentAt(_ created: Milliseconds) -> String {
        MessageTime.sentAt(Date(timeIntervalSince1970: created / 1000))
    }

    /// "Working… 12s · Esc to stop"; once the model has said nothing for a while, that it's
    /// waiting for it, which a provider that never answers can make last many minutes.
    static func working(since: Milliseconds?, quiet: Milliseconds?, now: Date) -> String {
        if let quiet, now.timeIntervalSince1970 - quiet / 1000 >= 20 {
            return "Waiting for the model to answer…" + elapsed(since: quiet, now: now)
        }
        return "Working…" + elapsed(since: since, now: now)
    }

    /// " 12s", " 1m 5s" after a few seconds, then " · Esc to stop".
    static func elapsed(since: Milliseconds?, now: Date) -> String {
        guard let since else { return "" }
        let seconds = Int(now.timeIntervalSince1970 - since / 1000)
        guard seconds >= 2 else { return "" }
        return " \(MessageTime.duration(seconds)) · Esc to stop"
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
        case .user(let message) where isSubagent && SubagentTask.parse(CommandMessages.shared.text(of: message)) != nil:
            // A subagent's task, in its own tab: the agent's words, not yours.
            AgentMessageRow(id: message.id, from: "the main agent", session: "", text: SubagentTask.parse(CommandMessages.shared.text(of: message)) ?? "", at: message.time.created)
        case .user(let message) where CommandMessages.shared.text(of: message).hasPrefix(Wakes.marker):
            WakeRow(note: String(CommandMessages.shared.text(of: message).dropFirst(Wakes.marker.count)), at: message.time.created)
        case .user(let message):
            let written = CommandMessages.shared.text(of: message)
            let (text, comments, paths, references) = SentMessage.split(written)
            let stored = (message.files ?? []).enumerated().map { AttachmentItem.stored($1, id: "\(message.id)#\($0)") }
            YourMessage(text: text, references: references, folders: folders(), attachments: stored + Attachments.paths(paths, besides: (message.files ?? []).compactMap(\.fileURL)).map(AttachmentItem.path), comments: comments, sent: Date(timeIntervalSince1970: message.time.created / 1000),
                        fromPhone: FromPhone.isFromPhone(written),
                        fork: { fork(message) }, undo: { undo(message) },
                        undoNote: YourMessage.undoNote(in: directory),
                        isOffline: isOffline)
        case .pending(let item):
            let (text, comments, paths, references) = SentMessage.split(item.text)
            UserBubble(text: text, references: references, folders: folders(), attachments: item.files.map(AttachmentItem.local) + Attachments.paths(paths, besides: item.files).map(AttachmentItem.path), comments: comments,
                       status: item.isLocal ? "Sending" : item.delivery == .queue ? "Queued" : "Sending")
                .contextMenu { Button("Cancel", role: .destructive) { cancel(item) }.disabled(isOffline) }
        case .assistant(let message, let showsError):
            AssistantStepView(message: message, directory: directory, folders: folders, showsError: showsError)
        case .more(let message, _):
            AssistantStepView(message: message, directory: directory, folders: folders, showsError: false)
        case .steps(_, let blocks, let isLive):
            StepsRow(blocks: blocks, isLive: isLive, directory: directory)
        case .widget(let call):
            WidgetCard(call: call, send: answerAgent)
        case .picture(let call):
            MadePictureRow(call: call, directory: directory)
        case .sent(let call):
            AgentSentRow(call: call)
        case .subagent(let call):
            SubagentRow(call: call, directory: directory)
        case .turnEnd(let idle, let stats, let isLast):
            TurnEndView(idle: idle, stats: stats, directory: directory, retry: isLast && !isOffline ? stats.message.map { message in { retry(message) } } : nil,
                        build: isLast && stats.agent == "plan" ? buildPlan : nil, reply: reply)
        case .shell(let shell):
            ShellRow(shell: shell)
        case .notice(_, let symbol, let text):
            Label(text, systemImage: symbol)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(.quaternary.opacity(0.5), in: .capsule)
                .frame(maxWidth: .infinity)
        case .undone(let count):
            HStack(spacing: 10) {
                Label("Undid " + count.counting("message"), systemImage: "arrow.uturn.backward")
                Button("Redo", action: redo)
                    .buttonStyle(.borderless)
                    .disabled(isOffline)
                    .fontWeight(.semibold)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.quaternary.opacity(0.5), in: .capsule)
            .frame(maxWidth: .infinity)
            .help("Sending a message makes the undo final")
        case .working(let since, let quiet, let followsHeard):
            HStack(spacing: 8) {
                // A bot shows itself at work.
                if let bot {
                    BotAvatar(look: bot.look, size: 18, mood: .working)
                        .frame(width: 16)
                }
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let latest = heard()
                    // Against the engine's clock, as its times are: a machine's may be behind.
                    ShimmerText(text: Self.working(since: since, quiet: followsHeard ? latest.last ?? quiet : quiet, now: context.date.addingTimeInterval(-latest.offset / 1000)))
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
    var status: String?
    @Environment(\.findHighlight) private var highlight
    @Environment(AppModel.self) private var app

    /// A part of its words with its own styling, and what it names standing out.
    private func styled(_ part: String, agents: [MessageMentions.Agent]) -> AttributedString? {
        let own = style?(part)
        guard part.contains(AgentReferences.trigger) || (!folders.isEmpty && part.contains("@")) else { return own }
        var text = own ?? AttributedString(part)
        MessageMentions.apply(to: &text, agents: agents, folders: folders)
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

    /// What Find reads in the bubble, in the order it's shown.
    static func findParts(_ text: String) -> [String] {
        parts(text).map(\.text)
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if !attachments.isEmpty {
                MessageAttachments(items: attachments)
                    .padding(.bottom, text.isEmpty ? 0 : 2)
            }
            ForEach(comments) { comment in
                CommentReference(comment: comment)
            }
            // What it replied to, each part above the words that answer it.
            let parts = Self.parts(text)
            let marks = highlight?.spread(over: parts.map(\.text))
            let agents = MessageMentions.agents(references, bots: app.bots)
            ForEach(parts.indices, id: \.self) { index in
                Group {
                    if parts[index].isQuote {
                        QuoteBlock(text: parts[index].text)
                            .frame(maxWidth: 420, alignment: .trailing)
                            .padding(.top, index == 0 ? 0 : 6)
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
        // A named agent opens its conversation; a named file, in the side panel.
        .environment(\.openURL, OpenURLAction { url in
            if let session = MessageMentions.session(in: url) {
                if app.workspace.session(session) != nil { app.open(.session(session)) }
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
    @State private var isExpanded = false
    @State private var shownHeight: CGFloat = 0
    @State private var fullHeight: CGFloat = 0
    private static let lines = 12

    /// Short messages can't reach the limit, so they aren't measured twice.
    private var mayBeLong: Bool {
        text.count > 300 || text.utf8.count { $0 == 10 } >= Self.lines
    }

    private var isCut: Bool { isExpanded || fullHeight > shownHeight + 1 }

    /// The words, with Find's marks.
    private var shown: AttributedString {
        FindText.marked(styled ?? AttributedString(text), highlight)
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            MessageMentions.text(shown, size: messageFont.size * 1.1)
                .transcriptFont()
                .lineLimit(isExpanded ? nil : Self.lines)
                .modifier(LinkPointer(isOn: styled?.runs.contains { $0.link != nil } == true))
                .textSelection(.enabled)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { if mayBeLong { shownHeight = $0 } }
                .background(alignment: .top) {
                    // The whole text, unseen, to tell whether the limit cuts anything.
                    if mayBeLong, !isExpanded {
                        MessageMentions.text(shown, size: messageFont.size * 1.1)
                            .transcriptFont()
                            .fixedSize(horizontal: false, vertical: true)
                            .hidden()
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
                    }
                }
                // Faded at the cut; a mask only then (each is drawn off screen first).
                .modifier(CutFade(isOn: isCut && !isExpanded))
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                // Your words in accent glass, apart from the agent's on the card.
                .modifier(BubbleSurface())
            if mayBeLong, isCut {
                Button(isExpanded ? "Show Less" : "Show More") {
                    withAnimation(.ui) { isExpanded.toggle() }
                }
                .buttonStyle(TextButtonStyle(outset: true))
                .font(.system(size: 12, weight: .medium))
                .padding(.trailing, 6)
            }
        }
        // Find on a place in it: all of it shows, as the place may be past the cut.
        .onChange(of: highlight?.current) { if highlight?.current != nil, mayBeLong { isExpanded = true } }
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
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(message.content.enumerated()), id: \.offset) { index, block in
                Group {
                    switch block {
                    case .text(let text):
                        // The last of a step under way: its words as they stream in. The same view
                        // once it's done, so finishing doesn't make the reply's views again (a
                        // frame of a tenth of a second at the end of each reply).
                        WritingText(row: message.id, part: index, text: text.text, folders: folders,
                                    isWriting: message.time.completed == nil && index == message.content.count - 1)
                    case .reasoning(let reasoning):
                        ReasoningView(block: reasoning)
                    case .tool(let call):
                        ToolCallView(call: call, directory: directory)
                    case .other:
                        EmptyView()
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
                ErrorCard(message: error.message)
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
        ReplyView(markdown: text, parser: FileLinkingParser(folders: folders, mentions: mentions, agents: agents, highlight: highlight)) { url in
            // A file opens in the side panel, a named agent its conversation; web links in the browser.
            if let session = MessageMentions.session(in: url) {
                if app.workspace.session(session) != nil { app.open(.session(session)) }
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
                    if app.workspace.session(session) != nil { app.open(.session(session)) }
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
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.ui) { isExpanded.toggle() }
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
                    .transition(.opacity)
            }
        }
        #if DEBUG
        // KUVO_DEMO_OPEN_STEPS: the thinking shows, opened.
        .onAppear { if ProcessInfo.processInfo.environment["KUVO_DEMO_OPEN_STEPS"] != nil { isExpanded = true } }
        #endif
    }

    private var duration: String? {
        guard let start = block.time?.created, let end = block.time?.completed else { return nil }
        return MessageTime.duration(max(1, Int((end - start) / 1000)))
    }
}

/// The end of a turn: how long it took and what it cost, or what went wrong.
private struct TurnEndView: View {
    let idle: Message.Idle
    let stats: TurnStats
    /// The session's folder, where the files the turn changed are.
    let directory: String
    /// Sends the turn's message again; offered on the last turn when it failed.
    var retry: (() -> Void)?
    /// Builds what a plan described; offered under Plan mode's last answer.
    var build: (() -> Void)?
    var reply: ((String) -> Void)?
    @Environment(AppModel.self) private var app

    /// The model's account was refused because its sign-in couldn't be renewed: the engine says only
    /// "Request failed: 400" then (a key refused, the service says why itself).
    private var signInEnded: Bool {
        idle.error?.type == "provider.auth" && idle.error?.message.hasPrefix("Request failed") == true
    }

    /// What went wrong; an ended sign-in said plainly, with the service's words after it.
    /// A provider that turned the request down for want of a sign-in, whatever the engine calls it.
    private var refused: Bool {
        idle.error.map { $0.type == "provider.auth" || Catalog.isSignInRefusal($0.message) } == true
    }

    private var message: String {
        guard let error = idle.error else { return "The run failed." }
        guard signInEnded else {
            guard refused, error.type != "provider.auth" else { return error.message }
            let there = RemoteFolder.machine(of: directory).map { " on \($0)" } ?? ""
            return "This model’s account isn’t signed in\(there), so the request was refused (\(error.message)). Sign in to it again in Accounts, or choose another model."
        }
        let ended = "This model's sign-in has ended and couldn't be renewed, so the request was refused (\(error.message))."
        // A machine signs in on its own, to its plans, or to a plan's coding agent there.
        if let machine = RemoteFolder.machine(of: directory) {
            return ended + " Sign in to it on \(machine) in Accounts, or use its plan's coding agent there (Codex for ChatGPT)."
        }
        return ended + " Sign in to its account again."
    }

    var body: some View {
        switch idle.outcome {
        case .failed:
            VStack(alignment: .leading, spacing: 8) {
                ErrorCard(message: message)
                HStack(spacing: 8) {
                    // The model's account to sign in to again: in Accounts, where this conversation
                    // runs (a machine signs in on its own).
                    if refused {
                        let machine = RemoteFolder.machine(of: directory)
                        Button(signInEnded ? "Sign In Again" : "Open Accounts", systemImage: "person.crop.circle") { app.openAccounts(on: machine) }
                            .buttonStyle(.glass)
                            .controlSize(.small)
                            .help(machine.map { "Accounts, on \($0)" } ?? "Accounts")
                    }
                    // A coding agent to sign in to: where this conversation runs (a machine signs in
                    // on its own), Accounts open on it.
                    if idle.error?.type == "signin" {
                        let machine = RemoteFolder.machine(of: directory)
                        Button(machine.map { "Sign In on \($0)" } ?? "Open Accounts", systemImage: "person.crop.circle") { app.openAccounts(on: machine) }
                            .buttonStyle(.glass)
                            .controlSize(.small)
                            .help(machine.map { "Sign in to the coding agents on \($0): its sign-ins are its own" } ?? "Sign in to the coding agents")
                    }
                    if let retry {
                        Button("Try Again", systemImage: "arrow.clockwise", action: retry)
                            .buttonStyle(.glass)
                            .controlSize(.small)
                            .help("Send your last message again")
                    }
                    // What it changed and said before failing.
                    if !stats.files.isEmpty {
                        TurnFiles(files: stats.files, directory: directory)
                    }
                    replyButtons
                }
            }
        case .interrupted:
            HStack(spacing: 6) {
                Label("Stopped", systemImage: "stop.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !stats.files.isEmpty {
                    TurnFiles(files: stats.files, directory: directory)
                }
                replyButtons
            }
        case .succeeded:
            HStack(spacing: 6) {
                if !parts.isEmpty {
                    Text(parts.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                if !stats.files.isEmpty {
                    TurnFiles(files: stats.files, directory: directory)
                }
                replyButtons
                if let build {
                    Button("Build It", systemImage: "hammer", action: build)
                        .buttonStyle(.glass)
                        .controlSize(.small)
                        .help("Switch to Build mode and have the agent carry out this plan")
                        .padding(.leading, 4)
                }
            }
        }
    }

    /// Copy and Reply, for what it said, however the turn ended.
    @ViewBuilder private var replyButtons: some View {
        if !stats.text.isEmpty {
            CopyButton(text: stats.text.joined(separator: "\n\n"), help: "Copy the Reply")
            if let reply {
                MessageActionButton(symbol: "arrowshape.turn.up.left", help: "Reply: quotes the part you selected (or the whole reply) in the composer") {
                    reply(stats.text.joined(separator: "\n\n"))
                }
            }
        }
    }

    private var parts: [String] {
        var parts: [String] = []
        if let started = stats.started {
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
                Label("Updated its memory", systemImage: "brain")
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
            Label("Edited " + files.count.counting("file"), systemImage: "plus.forwardslash.minus")
                .font(.caption)
        }
        .buttonStyle(TextButtonStyle(outset: true))
        .help("What this turn changed")
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
        if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday " + date.formatted(date: .omitted, time: .shortened) }
        return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
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
        .help(copied ? "Copied" : help)
    }
}

struct ErrorCard: View {
    let message: String

    var body: some View {
        Label {
            Text(message)
                .textSelection(.enabled)
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
        // As it may have been named: "&Mira".
        let to = input?["to"]?.string.map { $0.hasPrefix("&") ? String($0.dropFirst()) : $0 } ?? "another agent"
        let address = AgentMail.shared.directory().first { $0.session == to || $0.name.caseInsensitiveCompare(to) == .orderedSame }
        let text = input?["text"]?.string ?? ""
        let answer = said.flatMap { said in said.range(of: " answered:\n\n").map { String(said[$0.upperBound...]) } }
        FoldingCard(id: call.id, summary: text, startsOpen: FoldingCard<EmptyView, EmptyView, EmptyView>.isShort(text + (answer ?? "")), help: "A message this agent sent another") {
            Image(systemName: "paperplane.fill")
                .foregroundStyle(.tint)
                .frame(width: 16)
            Text("To \(Text(address?.name ?? to).fontWeight(.semibold).foregroundStyle(.primary))")
                .foregroundStyle(.secondary)
            if case .running = call.state, input?["wait"]?.bool == true {
                Spinner(size: 11)
                Text("Waiting for its answer")
                    .foregroundStyle(.secondary)
            }
            if case .failed = call.state {
                Text("Didn't go")
                    .foregroundStyle(.orange)
            }
        } accessory: {
            if let session = address?.session, app.workspace.session(session) != nil {
                Button("Open") { app.open(.session(session)) }
                    .buttonStyle(TextButtonStyle())
                    .help("Open \(address?.name ?? to)'s conversation")
            }
        } content: {
            if !text.isEmpty {
                MarkdownText(text: text, agents: MarkdownText.agents(namedIn: text))
                    .padding(.leading, 24)
            }
            // What it answered, when it was waited for.
            if let answer {
                Divider().padding(.leading, 24)
                Text("\(Text(address?.name ?? to).fontWeight(.semibold)) answered")
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
    @ViewBuilder var header: Header
    @ViewBuilder var accessory: Accessory
    @ViewBuilder var content: Content
    @State private var isHoveringHeader = false

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
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Button {
                    withAnimation(.ui) { folds.set(id, open: !open) }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        header
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(open ? 90 : 0))
                        if !open, !firstLine.isEmpty {
                            Text(firstLine)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }
                    // A fill under the pointer that reaches past the words without moving them,
                    // and the pointing hand, which the conversation's selection layer on top
                    // would otherwise turn into an I-beam.
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(isHoveringHeader ? Pressable.hoverFill : .clear, in: .rect(cornerRadius: 6))
                    .background(HoverTracker { isHoveringHeader = $0 })
                    .padding(.horizontal, -6)
                    .padding(.vertical, -3)
                    .contentShape(.rect)
                    .animation(.easeOut(duration: 0.12), value: isHoveringHeader)
                }
                .buttonStyle(.plain)
                .help(open ? "Fold it to its first line" : "Show all of it")
                Spacer(minLength: 8)
                accessory
            }
            .font(.callout)
            if open {
                content
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .recessedWell(RoundedRectangle(cornerRadius: 10))
        // The well reaches past the column, so its icon and text line up with the steps'.
        .padding(.horizontal, -10)
        .help(help)
    }
}

/// A message another agent sent this one: who from, and what; it folds, as the others do.
private struct AgentMessageRow: View {
    let id: String
    let from: String
    let session: String
    let text: String
    let at: Milliseconds
    @Environment(AppModel.self) private var app

    var body: some View {
        FoldingCard(id: id, summary: text, startsOpen: FoldingCard<EmptyView, EmptyView, EmptyView>.isShort(text), help: "A message another agent sent this one") {
            Image(systemName: "paperplane")
                .foregroundStyle(.tint)
                .frame(width: 16)
            Text("From \(Text(from).fontWeight(.semibold).foregroundStyle(.primary))")
                .foregroundStyle(.secondary)
        } accessory: {
            Text(Date(timeIntervalSince1970: at / 1000), format: .dateTime.hour().minute())
                .font(.caption)
                .foregroundStyle(.tertiary)
            if app.workspace.session(session) != nil {
                Button("Open") { app.open(.session(session)) }
                    .buttonStyle(TextButtonStyle())
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
                Button("Open") { app.open(.session(BotGroups.tabKey(chatID))) }
                    .buttonStyle(TextButtonStyle())
                    .help("Open \(chat)")
            }
        } content: {
            MarkdownText(text: task)
                .padding(.leading, 24)
        }
    }
}

/// A bot woke itself up, as it planned: its note to itself, in place of a message from you.
private struct WakeRow: View {
    let note: String
    let at: Milliseconds
    @Environment(\.findHighlight) private var highlight

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "alarm")
                .foregroundStyle(.tint)
                .frame(width: 16)
            Text("\(Text("Woke up").fontWeight(.semibold).foregroundStyle(.primary))  \(Text(FindText.marked(AttributedString(note), highlight)).foregroundStyle(.secondary))")
                // Room for what a watch saw, after its note.
                .lineLimit(6)
                .textSelection(.enabled)
            Spacer(minLength: 8)
            Text(Date(timeIntervalSince1970: at / 1000), format: .dateTime.hour().minute())
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .recessedWell(RoundedRectangle(cornerRadius: 10))
        // The well reaches past the column, so its icon and text line up with the steps'.
        .padding(.horizontal, -10)
        .help("A wake-up the bot scheduled for itself")
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

/// The end of a message that's cut short, fading out.
private struct CutFade: ViewModifier {
    let isOn: Bool

    func body(content: Content) -> some View {
        if isOn {
            content.mask {
                LinearGradient(stops: [.init(color: .black, location: 0.7), .init(color: .black.opacity(0.15), location: 1)], startPoint: .top, endPoint: .bottom)
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
