import ClientDesign
import ClientSessions
import ClientText
import Foundation
import OpenCodeKit
import Textual

/// One session, live: its transcript, what's pending, and the actions on it.
@Observable
final class SessionModel {
    var session: Session
    /// The conversation as it shows. Words stream in a few at a time: they gather in `live` and
    /// show together, a few times a second (see `apply`), instead of the conversation being drawn
    /// again for every few words. More words of the reply being written go in quietly, and only
    /// its view, which watches `writing`, is drawn again.
    private(set) var transcript: Transcript {
        get {
            access(keyPath: \.transcript)
            return storedTranscript
        }
        set {
            withMutation(keyPath: \.transcript) { storedTranscript = newValue }
            transcriptChanged()
        }
        _modify {
            access(keyPath: \.transcript)
            _$observationRegistrar.willSet(self, keyPath: \.transcript)
            defer {
                _$observationRegistrar.didSet(self, keyPath: \.transcript)
                transcriptChanged()
            }
            yield &storedTranscript
        }
    }
    @ObservationIgnored private var storedTranscript: Transcript
    /// The reply being written, its words as they stream in.
    let writing = WritingBlock()
    /// What gathered in `live` is only more words of one reply: its step and which of its texts.
    @ObservationIgnored private var liveWords: (step: String, ordinal: Int?)?
    @ObservationIgnored private var liveIsWordsOnly = true
    /// The transcript with what streamed in since it last showed, until it shows.
    @ObservationIgnored private var live: Transcript?
    @ObservationIgnored private var showsLive: Task<Void, Never>?
    @ObservationIgnored private var lastShown = ContinuousClock.now
    /// How often streamed words show, at most.
    private static let streamInterval = Duration.milliseconds(50)
    /// Goes up with each change to the transcript, so what's made from it (the conversation's
    /// rows) is made again only then.
    private(set) var transcriptVersion = 0

    // What the views around the conversation read (the composer, the queue, the cards over it,
    // the sidebar and tabs), kept apart from the transcript so that streaming words don't draw
    // them again: each changes only when it does.
    private(set) var isRunning = false
    private(set) var pending: [Transcript.Pending] = []
    private(set) var permissions: [PermissionRequest] = []
    /// Each command permission's command line as the agent wrote it, by request: the engine asks
    /// about the commands in it one by one, without the pipes and `&&` between them.
    private(set) var permissionCommands: [String: String] = [:]
    /// The shell commands the conversation shows as they run: a step waiting on one, or one you
    /// ran with !. The session's others (see `Workspace.shellJobs`) run in the background.
    private(set) var inlineShells: Set<String> = []
    /// The background commands' bar shows only its line, which still says they run.
    var hidesBackgroundJobs = false
    /// The bar of its wake-ups and watches shows only its line.
    var hidesWakes = false
    /// The bar of the sessions its bot runs shows only its line.
    var hidesWork = false
    /// The goal's bar shows only its line.
    var hidesGoal = false
    /// The bars over the composer tucked into one line (`BarStrip`), as you left them here.
    var tuck = BarTuck<ComposerBar>()
    /// What the card's ✕ put away, with Undo for a moment (`PutAways`).
    let putAways = PutAways<PutAway> { await SessionModel.undoMoment($0) }

    /// Undo's moment; with KUVO_DEMO_UNDO it never passes, to look at its lines.
    private nonisolated static func undoMoment(_ moment: Duration) async {
        #if DEBUG
        if ProcessInfo.processInfo.environment["KUVO_DEMO_UNDO"] != nil {
            await withUnsafeContinuation { (_: UnsafeContinuation<Void, Never>) in }
        }
        #endif
        try? await Task.sleep(for: moment)
    }
    /// The side question's and the review's bars show only their lines.
    var hidesSideQuestion = false
    var hidesReview = false
    /// The handoff whose bar was put away (its new conversation's ID, or "" for one that failed).
    var putAwayHandoff: Handoff?
    /// A change to its goal is on its way to its computer.
    var isChangingGoal = false
    /// The subagents' bar shows only its line, which still says they work.
    var hidesSubagents = false
    private(set) var forms: [FormRequest] = []
    /// Asks whose answer is on its way, or has gone and waits for the engine to say so: answered
    /// once (a second click, or Return again, sends nothing).
    private(set) var answering: Set<String> = []
    /// How much of the context window the last step used.
    private(set) var contextUsed: Int?
    /// The model its latest reply came from: on Auto, the one in your list at work now.
    private(set) var modelInUse: ModelRef?
    /// The subagents its agent handed work to, in the order it did, once each has a session.
    private(set) var subagents: [Subagent] = []

    /// A subagent this conversation's agent handed a task to: its own session, which you can
    /// watch, message, stop and give another model.
    struct Subagent: Equatable, Identifiable {
        /// Its session.
        var id: String
        /// The step that handed it the task.
        var call: String
        var task: String
        var agent: String?
        /// Sent off to work on its own while the agent goes on (the step is done at once).
        var isBackground: Bool
        /// The step that waits on it is done: it is too, unless it was sent off in the background.
        var isStepDone: Bool
    }

    private func transcriptChanged() {
        transcriptVersion &+= 1
        writing.show(WritingBlock.Writing(in: storedTranscript))
        if isRunning != transcript.isRunning { isRunning = transcript.isRunning }
        if pending != transcript.pending { pending = transcript.pending }
        if permissions != transcript.permissions {
            permissions = transcript.permissions
            permissionCommands = Self.commands(of: permissions, in: transcript.messages)
        } else if permissions.contains(where: { $0.action == "shell" && permissionCommands[$0.id] == nil }) {
            // Asked before the step's word of its command came (a step read again): once it has.
            let commands = Self.commands(of: permissions, in: transcript.messages)
            if commands != permissionCommands { permissionCommands = commands }
        }
        if forms != transcript.forms { forms = transcript.forms }
        // Settled: answered here or elsewhere, or gone with its run.
        if !answering.isEmpty {
            let asking = Set(permissions.map(\.id) + forms.map(\.id))
            if !answering.isSubset(of: asking) { answering.formIntersection(asking) }
        }
        let inline = Self.inlineShells(in: transcript.messages)
        if inlineShells != inline { inlineShells = inline }
        let used = Self.contextUsed(in: transcript.messages)
        if contextUsed != used { contextUsed = used }
        let inUse = Self.modelInUse(in: transcript.messages)
        if modelInUse != inUse { modelInUse = inUse }
        let helpers = subagentsNow(in: transcript.messages)
        if subagents != helpers { subagents = helpers }
        findUnnamedSubagents()
        // Answers in progress go once their question has (answered, or dismissed).
        if !questionProgress.isEmpty {
            var open = Set(forms.map(\.id))
            #if DEBUG
            // KUVO_DEMO_QUESTIONS' questions, which aren't the engine's.
            open.formUnion(questionProgress.keys.filter { $0.hasPrefix("frm_demo") })
            #endif
            let kept = questionProgress.filter { open.contains($0.key) }
            if kept.count != questionProgress.count { questionProgress = kept }
        }
    }

    /// Subagents' sessions by the step that started them, for a step under way that the engine
    /// gave back without its session (read again from the engine mid-step, its stored copy has
    /// none: only its live events say).
    @ObservationIgnored private var foundSubagents: [String: String] = [:]
    /// Steps being looked for, and when a look that found nothing ended (another waits a while:
    /// a step can wait minutes, for your approval, before its session exists).
    @ObservationIgnored private var lookingFor: [String: ContinuousClock.Instant?] = [:]
    private static let lookAgainAfter = Duration.seconds(20)

    /// Looks for the session of each subagent step under way that hasn't said which it is: the
    /// newest of this session's subagents named after its task (the engine names it so), made
    /// since the step began, and not another step's.
    private func findUnnamedSubagents() {
        guard let last = transcript.messages.last, case .assistant(let step) = last else { return }
        for case .tool(let call) in step.content where call.name == "subagent" && !call.state.isFinished
            && call.state.metadata?["sessionID"]?.string == nil && foundSubagents[call.id] == nil {
            guard let task = call.state.input?["description"]?.string, !task.isEmpty else { continue }
            if let looked = lookingFor[call.id] {
                // Under way, or ended a moment ago.
                guard let ended = looked, ContinuousClock.now - ended > Self.lookAgainAfter else { continue }
            }
            lookingFor[call.id] = .some(nil)
            // The engine's clock and this Mac's may differ a little.
            let since = (call.time?.created ?? 0) - 5000
            Task {
                for attempt in 0..<5 where foundSubagents[call.id] == nil {
                    if attempt > 0 { try? await Task.sleep(for: .seconds(2)) }
                    let taken = Set(foundSubagents.values).union(subagents.map(\.id))
                    if let child = try? await api.children(of: id).first(where: { $0.title == task && $0.time.created >= since && !taken.contains($0.id) }) {
                        foundSubagents[call.id] = child.id
                        earlierSubagents = nil
                        transcriptChanged()
                    }
                }
                lookingFor[call.id] = foundSubagents[call.id] == nil ? .some(.now) : nil
            }
        }
    }

    /// The subagents in all but the last message, by the message before it: while a reply
    /// streams, only the last one changes, so only it is read again.
    @ObservationIgnored private var earlierSubagents: (before: String, found: [Subagent])?

    private func subagentsNow(in messages: [Message]) -> [Subagent] {
        guard let last = messages.last else { return [] }
        let earlier = messages.dropLast()
        let found: [Subagent]
        if let cache = earlierSubagents, cache.before == earlier.last?.id ?? "" {
            found = cache.found
        } else {
            found = Self.subagents(in: earlier, adding: [], known: foundSubagents)
            // Kept only while none of them has a subagent's step that can change yet: one under
            // way in a message still being written (a message of yours came after it). A message
            // that ended, or failed, has all it will have.
            let isSettled = earlier.allSatisfy { message in
                guard case .assistant(let step) = message, step.time.completed == nil, step.error == nil else { return true }
                return !step.content.contains { if case .tool(let call) = $0 { call.name == "subagent" && !call.state.isFinished } else { false } }
            }
            earlierSubagents = isSettled ? (earlier.last?.id ?? "", found) : nil
        }
        return Self.subagents(in: [last], adding: found, known: foundSubagents)
    }

    private static func subagents(in messages: some Sequence<Message>, adding found: [Subagent], known: [String: String]) -> [Subagent] {
        var found = found
        for message in messages {
            guard case .assistant(let step) = message else { continue }
            for case .tool(let call) in step.content where call.name == "subagent" {
                guard let session = call.state.metadata?["sessionID"]?.string ?? known[call.id] else { continue }
                let input = call.state.input
                let subagent = Subagent(id: session, call: call.id, task: input?["description"]?.string ?? "", agent: input?["agent"]?.string,
                                        // Sent off in the background, or moved there as it worked (its call
                                        // done, the subagent still running).
                                        isBackground: input?["background"]?.bool == true || call.state.metadata?["status"]?.string == "running",
                                        isStepDone: call.state.isFinished)
                // One the agent picked up again (by its session) is where it was first, as it is now.
                if let index = found.firstIndex(where: { $0.id == session }) { found[index] = subagent } else { found.append(subagent) }
            }
        }
        return found
    }

    /// Only the last messages: what runs now is at the end.
    private static func inlineShells(in messages: [Message]) -> Set<String> {
        var shells = Set<String>()
        for message in messages.suffix(30) {
            switch message {
            case .shell(let shell) where shell.isRunning:
                shells.insert(shell.shellID)
            case .assistant(let step):
                // A step sent to the background is done at once; one still running waits on its command.
                for case .tool(let call) in step.content {
                    if case .running(_, let metadata) = call.state, let shell = metadata?["shellID"]?.string { shells.insert(shell) }
                }
            default:
                break
            }
        }
        return shells
    }

    private static func commands(of requests: [PermissionRequest], in messages: [Message]) -> [String: String] {
        var commands: [String: String] = [:]
        for request in requests where request.action == "shell" {
            guard let source = request.source,
                  case .assistant(let step)? = messages.last(where: { $0.id == source.messageID }) else { continue }
            for case .tool(let call) in step.content where call.id == source.id {
                commands[request.id] = call.state.input?["command"]?.string
            }
        }
        return commands
    }

    /// What the last step sent and got back is what's in the window now.
    private static func modelInUse(in messages: [Message]) -> ModelRef? {
        for message in messages.reversed() {
            if case .assistant(let assistant) = message { return assistant.model }
        }
        return nil
    }

    private static func contextUsed(in messages: [Message]) -> Int? {
        for message in messages.reversed() {
            // Summarized since: how much is left shows at its next step, not what it was before.
            if case .compaction(let summary) = message, summary.status == "completed" { return nil }
            if case .assistant(let assistant) = message, let tokens = assistant.tokens {
                return tokens.input + tokens.cache.read + tokens.cache.write + tokens.output
            }
        }
        return nil
    }
    private(set) var isLoaded = false
    /// Your answers to the agent's questions so far, by form: kept while you look elsewhere.
    var questionProgress: [String: QuestionProgress] = [:]
    /// Showing the conversation as last seen (its machine is connecting, or this Mac's engine
    /// starting), not the engine's.
    private(set) var isCopy = false
    /// Made from a copy: no engine to read from until its machine is back.
    private(set) var waitsForEngine = false
    /// Whether its engine can be reached (a machine's is connected); set by the workspace.
    @ObservationIgnored var isReachable: () -> Bool = { true }
    /// Its computer's agents bridge, which runs goals there (the workspace sets it).
    @ObservationIgnored var goalBridge: () -> OutsideAgents? = { nil }
    /// An ask found settled with no event for it (the workspace sets it).
    @ObservationIgnored var askSettled: (String) -> Void = { _ in }
    /// What's done here waits while its engine can't be reached: it would only fail.
    var canReach: Bool { !waitsForEngine && isReachable() }
    private(set) var changes: [FileDiff] = []
    /// The files its agent's edits changed, from the edits themselves: what the Changes tab shows
    /// in a folder outside a git repository, where `changes` stays empty (the engine keeps no
    /// snapshots there).
    private(set) var editedFiles: [FileDiff] = []
    /// Comments on lines of the changes, sent with the next message: with the composer's draft,
    /// so a quit or an update keeps them too.
    var reviewComments: [ReviewComment] {
        get { Drafts.shared[id].comments }
        set { Drafts.shared[id].comments = newValue }
    }
    /// What's in the composer, kept while you look at other sessions and across launches.
    var draftText: String {
        get { Drafts.shared[id].text }
        set { Drafts.shared[id].text = newValue }
    }

    var draftFiles: [URL] {
        get { Drafts.shared[id].files }
        set {
            Drafts.shared[id].files = newValue
            if newValue.isEmpty, failure == Self.sideTakesNoFiles { failure = nil }
        }
    }

    /// What you're replying to, over the composer, each with your answer to it.
    var draftQuotes: [Drafts.Quote] {
        get { Drafts.shared[id].quotes }
        set {
            Drafts.shared[id].quotes = newValue
            Drafts.shared[id].quote = nil
        }
    }

    /// The quote whose answer takes the keyboard: the one just added, or quoted again.
    private(set) var quoteFocus: Drafts.QuoteFocus?

    /// Messages you sent here, oldest first, for going back through with ↑.
    var sentMessages: [String] {
        var texts: [String] = []
        for message in transcript.messages {
            let text: String
            switch message {
            // Not what the box told the agent.
            case .user(let user) where BoxNote.of(user) != nil: continue
            // A goal comes back as one (`SentWithKeyword.draft`).
            case .user(let user):
                let sent = CommandMessages.shared.text(of: user)
                text = SentWithKeyword.draft(SentMessage.words(of: sent), keyword: SentMessage.keyword(of: sent))
            // Commands you ran come back as you typed them.
            case .shell(let shell): text = "!" + shell.command
            default: continue
            }
            if !text.isEmpty, text != texts.last { texts.append(text) }
        }
        return texts
    }
    /// Goes up to put the cursor in the composer (after a message comes back to it for editing).
    private(set) var composerFocus = 0
    /// Goes up to open the composer's model picker (a failed turn's Switch Model).
    private(set) var modelMenuRequest = 0
    /// Goes up to open the find bar on the conversation (⌘F).
    private(set) var findRequest = 0
    /// Goes up with each message you send, so the conversation goes back to its end.
    private(set) var sent = 0
    /// What the find bar should look for when it opens, from a search in the sidebar.
    var findPreset: String?

    func showFind(_ query: String? = nil) {
        findPreset = query
        findRequest += 1
    }

    /// Started by another session's agent to do part of its task.
    var isSubagent: Bool { session.parentID != nil }

    /// The project's folders as they're set now, the primary one first.
    func folders() -> [String] {
        [session.location.directory] + projectFolders()
    }

    func focusComposer() { composerFocus += 1 }
    func openModelMenu() { modelMenuRequest += 1 }


    /// Replies to all of a message: it goes over the composer as a quote, to answer under.
    func reply(to text: String) {
        addQuote(text, how: "message")
    }

    /// Adds a quote to answer (all of a message, or a part you selected), after those there are,
    /// and its answer takes the keyboard.
    func addQuote(_ text: String, how: String) {
        let count = draftQuotes.count
        guard let id = Drafts.shared.addQuote(text, to: self.id) else { return }
        quoteFocus = Drafts.QuoteFocus(id)
        if draftQuotes.count > count { Analytics.shared.track("message_replied", ["how": how]) }
    }
    /// Queued messages wait for Resume: after Stop, a failed run, or when its box found them
    /// waiting as its engine started. The session's box carries the queue (PROTOCOL.md, "The
    /// queue"), with or without this Mac: this is what it says, read again as the queue changes.
    private(set) var isQueuePaused = false {
        didSet { if isQueuePaused != oldValue { followWhilePaused() } }
    }
    /// What Stop held for the agent's next step, in the order it goes, as its box says.
    private var heldByBox: [String] = []
    /// What waits on the box itself while the queue is paused, first come first: another agent's
    /// letter, a wake-up, a bot's work news, a message of yours held for Resume (PROTOCOL.md, "The
    /// queue"). It goes once the queue goes on, after what the engine holds.
    private var onBox: [BoxQueue.Waiting] = []
    /// Yours held on the box from here, as you wrote them and with the files picked here (Edit).
    @ObservationIgnored private var yoursOnBox: [String: (text: String, files: [URL])] = [:]
    /// Ones Undo is putting back on the box, on their way there (Resume waits for them).
    @ObservationIgnored private var puttingBack: [String: Task<Void, Never>] = [:]
    /// Ones taken away from what waits on the box: each as it was, once the box says (Undo puts it back).
    @ObservationIgnored private var removedFromBox: [String: Task<BoxQueue.Removed?, Never>] = [:]
    /// Ones Undo is putting back while the queue is paused, on their way to the box, by what they go
    /// ahead of (what came after them), shown there meanwhile.
    private var placesBack: [String: String] = [:]
    /// What waits on a machine's box, followed while the queue is paused there (`followWhilePaused`).
    @ObservationIgnored private var queueFollow: Task<Void, Never>?
    /// The session's box (this Mac's, or its machine's).
    @ObservationIgnored var box: () -> BoxClient? = { nil }
    /// Its approval as its box shows it (`readApproval`); nil until read.
    var approvalShown: ApprovalShown?
    /// Auto's reviewer's decisions here, as its box keeps them (`readDecisions`); nil until read.
    var decisions: ReviewDecisions?
    /// Its box couldn't be asked for them, with none read yet: Decisions says so, not a loader.
    var decisionsUnread = false
    /// Auto's Decisions are open over the composer.
    var showsDecisions = false
    /// Full Access was picked on a computer where it isn't confirmed yet: the composer asks.
    var confirmsFullAccess = false
    /// The held-back decisions you've seen in Decisions: the bar over the composer names only newer ones.
    var decisionsSeen: Set<String> = []
    @ObservationIgnored var decisionsRead: Task<Void, Never>?
    /// Reads and changes of Auto's decisions asked for so far (`readDecisions`).
    @ObservationIgnored var decisionsAsked = 0
    @ObservationIgnored var approvalChanges = 0
    /// Its Autopilot as its box shows it (`readAutopilot`); nil until read.
    var autopilotShown: AutopilotShown?
    /// Its box is from before Autopilot: the Mode menu says so instead of offering it.
    var autopilotUnavailable = false
    /// Switches of Autopilot asked for so far, and still on their way to its box.
    @ObservationIgnored var autopilotChanges = 0
    @ObservationIgnored var autopilotPending = 0
    /// Picks of its approval still on their way to its box, and how many were made since none was.
    @ObservationIgnored var approvalsPending = 0
    @ObservationIgnored var approvalBurst = 0
    @ObservationIgnored private var queueRead: Task<Void, Never>?
    /// Changes asked of the box's queue so far (`queueRoute`).
    @ObservationIgnored private var queueChanges = 0
    /// Whether its box carries the queue (`carriesQueue`); unknown until read.
    @ObservationIgnored private var boxCarriesQueue: Bool?
    /// The next waiting message started here a moment from now, on a box that doesn't carry the
    /// queue (`drainHere`).
    @ObservationIgnored private var drainTask: Task<Void, Never>?
    /// Stops asked for so far (`stop`): a Resume that waited meanwhile doesn't go.
    @ObservationIgnored private var stops = 0
    var failure: String?

    /// Its engine: a machine's changes with each connection to it.
    private var api: OpenCodeAPI
    private var reloadTask: Task<Void, Never>?
    /// Reads in a row that found nothing where the copy has a conversation.
    private var emptyReads = 0
    private var changesTask: Task<Void, Never>?
    /// The last message on its way out; each waits for the one before, so the engine gets
    /// (and queues) them in the order they were written.
    private var sending: Task<Void, Never>?
    /// Messages on their way to the agent, by ID: each sent from here, and one from elsewhere that
    /// Stop held or that you're taking back to edit. What the queue shows is made from these and
    /// the engine's inbox (see `waiting`). Their states change in `send` and `retry`, as the
    /// engine's word comes (`apply`, `load`), in `holdOnTheirWay`, `cancelPending` and `edit`.
    private var outgoing: [String: Outgoing] = [:]

    private struct Outgoing {
        enum State: Equatable {
            /// On its way to the engine: being made ready (its files, its folder's tools), then
            /// asked for (see `request`).
            case sending
            /// The engine has it, in its inbox, as `transcript.pending` shows it (its word of it
            /// may still be on its way).
            case waiting
            /// Being taken back for editing: the cancel asked, the engine's word of which won not
            /// here yet.
            case takingBack
            /// The agent has it.
            case delivered
            /// It doesn't go: removed, taken back, or it couldn't be sent.
            case cancelled
        }

        var state: State
        /// How it asked to go, while its request is on its way to the engine: until `requestDone`,
        /// whatever happens to it meanwhile (it's removed, the engine's word of it comes).
        var request: InboxItem.Delivery?
        /// Sent from here: a command's message, or one from elsewhere, is told from it.
        var isOurs: Bool
        /// Sent while nothing ran, until the agent has it: it starts a run, and the run begins a
        /// moment before the agent takes it, which isn't waiting.
        var startsRun = false
        /// Meant for the agent's next step, and held in the queue by Stop while its request was
        /// still on its way: it waits ahead of what the box holds, the lowest first (the latest
        /// Stop's). Once it's there, the box holds it.
        var heldAt: Int?
    }

    /// Those waiting for a message's record to change (see `wait`), by message.
    @ObservationIgnored private var waiters: [String: [UUID: CheckedContinuation<Void, Never>]] = [:]

    /// Changes a message's record, and what waits on it hears.
    private func update(_ message: String, _ change: (inout Outgoing) -> Void) {
        guard outgoing[message] != nil else { return }
        change(&outgoing[message]!)
        waiters.removeValue(forKey: message)?.values.forEach { $0.resume() }
    }

    private func move(_ message: String, to state: Outgoing.State) {
        update(message) { $0.state = state }
    }

    /// While `ongoing` holds for a message's record, until `deadline` at most: woken as it changes.
    private func wait(for message: String, until deadline: ContinuousClock.Instant, while ongoing: (Outgoing) -> Bool) async {
        let token = UUID()
        let timer = Task {
            try? await Task.sleep(until: deadline)
            waiters[message]?.removeValue(forKey: token)?.resume()
        }
        defer { timer.cancel() }
        while let record = outgoing[message], ongoing(record), ContinuousClock.now < deadline {
            await withCheckedContinuation { waiters[message, default: [:]][token] = $0 }
        }
    }

    /// Commands run from here whose messages haven't arrived yet, oldest first.
    private var runningCommands: [RunningCommand] = []

    private struct RunningCommand {
        var id = UUID()
        /// What its message shows: "/review main".
        var command: String
        var started: Date
        /// The messages there were already, sent or waiting.
        var before: Set<String>
    }

    /// The project's other folders, as they're set now.
    private let projectFolders: () -> [String]

    init(session: Session, api: OpenCodeAPI, projectFolders: @escaping () -> [String] = { [] }) {
        self.session = session
        self.api = api
        self.projectFolders = projectFolders
        storedTranscript = Transcript(sessionID: session.id)
        storedTranscript.asksEndWithRuns = !OutsideAgents.isAgentSession(session)
    }

    var id: String { session.id }

    /// The agent and model the next message goes to.
    var agent: String { session.agent ?? "build" }

    /// Messages waiting for the agent, in the order it gets them: those for its next step, then
    /// the queue. A message sent while it's idle goes straight to the transcript instead, and
    /// stays there while the run it starts gets going.
    var waiting: [Transcript.Pending] {
        let pending = pending.filter { outgoing[$0.id]?.startsRun != true }
        // What Stop held back was meant for the work under way: it stays ahead of the queue, and
        // shows while it's still on its way there too.
        // Held on its way here (the latest Stop's, first), then as the box holds them.
        let rank = { (item: Transcript.Pending) -> Int? in
            self.outgoing[item.id]?.heldAt.map { $0 - 1_000_000 } ?? self.heldByBox.firstIndex(of: item.id)
        }
        // What waits on the box, by where the box holds it (one Undo put back where it was), else
        // after what the engine has.
        let onBox = waitingOnBox
        let heldOnBox = { (item: Transcript.Pending) -> Int? in self.heldByBox.firstIndex(of: item.id) }
        let held = (pending.compactMap { item in rank(item).map { (item, $0) } } + onBox.compactMap { item in heldOnBox(item).map { (item, $0) } })
            .sorted { $0.1 < $1.1 }.map(\.0)
        let others = pending.filter { rank($0) == nil }
        let list = (isRunning ? others.filter { $0.delivery == .steer } : []) + held + others.filter { $0.delivery == .queue } + onBox.filter { heldOnBox($0) == nil }
        // One Undo is putting back, on its way to the box: where it was already.
        return placesBack.reduce(into: list) { list, back in
            guard let from = list.firstIndex(where: { $0.id == back.key }), list.contains(where: { $0.id == back.value }) else { return }
            let item = list.remove(at: from)
            list.insert(item, at: list.firstIndex { $0.id == back.value } ?? list.endIndex)
        }
    }

    /// What comes after `item` in the queue as it's shown (what Undo puts it back ahead of); nil
    /// when it's last.
    func next(after item: Transcript.Pending) -> String? {
        let shown = waiting
        return shown.firstIndex { $0.id == item.id }.flatMap { $0 + 1 < shown.count ? shown[$0 + 1].id : nil }
    }

    /// What waits on the box, after what the engine holds (once the engine has one, it's shown there).
    private var waitingOnBox: [Transcript.Pending] {
        onBox.filter { item in !transcript.pending.contains { $0.id == item.id } }.map { item in
            let yours = yoursOnBox[item.id]
            let files = item.files ?? []
            return Transcript.Pending(id: item.id, text: yours?.text ?? (item.text.isEmpty ? files.joined(separator: ", ") : item.text), delivery: .queue, isLocal: false, files: yours?.files ?? [])
        }
    }

    /// Whether `item` waits on the box rather than in the engine.
    func isOnBox(_ item: Transcript.Pending) -> Bool { onBox.contains { $0.id == item.id } }

    /// Who a waiting message is from: an agent's name, "Wake-up", "Goal"…; nil for one of yours.
    func sender(of item: Transcript.Pending) -> String? {
        onBox.first { $0.id == item.id }?.from ?? BoxNote.of(text: item.text, metadata: item.metadata)?.from
    }

    private var hasQueue: Bool { transcript.pending.contains { $0.delivery == .queue } || !waitingOnBox.isEmpty }

    /// Running, or about to: a message for the next step starts a run as soon as it lands.
    private var isBusy: Bool { transcript.isRunning || transcript.pending.contains { $0.delivery == .steer } }

    private var isRetrying = false

    /// Shows the conversation as last seen while `load` reads the engine's, unless it's read
    /// already. The engine's takes its place, rather than being added to it.
    func preview(_ copy: [Message]) {
        guard !isLoaded, transcript.messages.isEmpty, !copy.isEmpty else { return }
        transcript.load(messages: copy, inbox: [], permissions: [], forms: [], isRunning: false)
        isCopy = true
    }

    /// Shows the conversation as last seen, until `load` reads the engine's.
    func show(_ copy: [Message]) {
        discardLive()
        transcript.load(messages: copy, inbox: [], permissions: [], forms: [], isRunning: false)
        isCopy = true
        waitsForEngine = true
    }

    /// A session keeps its conversation as last seen, to show while its engine can't answer yet
    /// (its machine is out of reach, or this Mac's engine is starting; see `SessionCopies`).
    private func keepCopy() {
        guard !isSubagent, !transcript.messages.isEmpty else { return }
        // The latest, as opening it reads them: earlier ones are read again as you scroll up.
        SessionCopies.save(.init(session: session, messages: Array(transcript.messages.suffix(Self.pageSize))))
    }

    /// How many messages one read takes: the latest on opening, then as many earlier ones each
    /// time the conversation's top comes into view.
    #if DEBUG
    /// KUVO_DEMO_PAGE: fewer, to measure scrolling up through pages of a conversation.
    static let pageSize = ProcessInfo.processInfo.environment["KUVO_DEMO_PAGE"].flatMap(Int.init) ?? 200
    #else
    static let pageSize = 200
    #endif
    /// Where the messages not read yet end, while there are earlier ones.
    private(set) var earlierCursor: String?
    /// The read of earlier messages on its way, if there is one.
    private var earlierRead: Task<Void, Never>?
    var isLoadingEarlier: Bool { earlierRead != nil }
    var hasEarlier: Bool { earlierCursor != nil }

    /// The page's way back to earlier messages, when it was full (so there may be more).
    private static func cursor(before page: Page<Message>) -> String? {
        page.data.count >= pageSize ? (page.cursor?.next ?? page.cursor?.previous) : nil
    }

    /// Reads every earlier message there is (to search them), up to a great many.
    func loadAllEarlier() async {
        while hasEarlier, transcript.messages.count < 20_000 {
            // After one already on its way (scrolling up).
            await earlierRead?.value
            let before = transcript.messages.count
            await loadEarlier()
            if transcript.messages.count == before { return }
        }
    }

    /// Reads the messages before those on screen, and puts them ahead of them; with one on its
    /// way already, once it's in.
    func loadEarlier() async {
        if let read = earlierRead { return await read.value }
        guard let cursor = earlierCursor, !waitsForEngine else { return }
        let read = Task {
            defer { earlierRead = nil }
            guard let page = try? await api.messages(session: id, limit: Self.pageSize, before: cursor) else { return }
            let known = Set(transcript.messages.map(\.id))
            let older = page.data.filter { !known.contains($0.id) }
            guard !older.isEmpty else {
                earlierCursor = nil
                return
            }
            editTranscript { $0.messages = older + $0.messages }
            earlierCursor = Self.cursor(before: page)
            prepareCode(in: older)
        }
        earlierRead = read
        await read.value
    }

    /// The code in replies read, colored ahead of time, so it shows colored as it's scrolled to
    /// rather than plain for a moment first.
    private func prepareCode(in messages: [Message]) {
        let texts = messages.flatMap { message -> [String] in
            guard case .assistant(let step) = message, step.time.completed != nil else { return [] }
            return step.content.compactMap { if case .text(let text) = $0 { text.text } else { nil } }
        }
        guard !texts.isEmpty else { return }
        Task { await CodeHighlighting.prepare(markdown: texts) }
    }

    /// Its engine (a machine's, or this Mac's started again) connected again, through `api`. What
    /// failed on the old connection is past.
    func reconnect(_ api: OpenCodeAPI) {
        self.api = api
        // Its box may have been updated meanwhile: whether it carries the queue is read again.
        boxCarriesQueue = nil
        readFeatures = nil
        waitsForEngine = false
        failure = nil
    }

    /// Events that came while a read was on its way, by read: it may have been made before them, so
    /// they're applied again on top of it (what it has already, they leave as it is).
    @ObservationIgnored private var cameDuringRead: [UUID: [ServerEvent]] = [:]

    /// Its bridge (the coding agents') stopped for good: nothing it asked waits on you, and it isn't
    /// at work.
    func bridgeStopped() {
        live?.permissions = []
        live?.forms = []
        live?.isRunning = false
        transcript.permissions = []
        transcript.forms = []
        transcript.isRunning = false
    }

    func load() async {
        guard !waitsForEngine else { return }
        let read = UUID()
        cameDuringRead[read] = []
        defer { cameDuringRead[read] = nil }
        async let inbox = api.inbox(session: id)
        async let permissions = api.permissions(session: id)
        async let forms = api.forms(session: id)
        // What MCP servers ask here: the transcript takes those its tools are waiting on.
        async let shared = api.forms(session: FormRequest.anySession, directory: session.location.directory)
        async let active = api.activeSessions()
        do {
            // The queue before the conversation: a message delivered between the two reads is in
            // the second, rather than in neither.
            let waiting = (try? await inbox) ?? []
            let page = try await api.messages(session: id, limit: Self.pageSize)
            // Nothing, where its copy has a conversation: an engine just started (a new version
            // setting itself up) can answer that for a moment. The copy stays; read again soon.
            if page.data.isEmpty, isCopy, !transcript.messages.isEmpty, emptyReads < 4 {
                emptyReads += 1
                Task {
                    try? await Task.sleep(for: .seconds(3))
                    await load()
                }
                return
            }
            emptyReads = 0
            // All of the read is in before anything changes: what streams in meanwhile goes to the
            // copy on screen, and must not land between that copy going and the read replacing it.
            // What's asked as it was, for a read that failed (over SSH, say): no card goes for
            // one the agent still waits on, which no event would bring back.
            // Its subagents at work ask here too (nothing else shows what they ask): theirs are
            // read with its own, as each read replaces what's shown. Those at work, and those
            // whose asks show (one a subagent of a subagent started); finished ones aren't read.
            let atWork = Self.subagents(in: page.data, adding: [], known: foundSubagents).filter { !$0.isStepDone || $0.isBackground }.map(\.id)
            let showing = (transcript.permissions.map(\.sessionID) + transcript.forms.map(\.sessionID)).filter { transcript.helpers.contains($0) }
            let helpers = Set(atWork + showing)
            let theirs = await Self.asks(of: helpers, api: api)
            // One that couldn't be read keeps the asks it showed: it still waits on them.
            let helperAsks = theirs.permissions + transcript.permissions.filter { theirs.unread.contains($0.sessionID) }
            let helperForms = theirs.forms + transcript.forms.filter { theirs.unread.contains($0.sessionID) }
            let asked = (try? await permissions).map { $0 + helperAsks } ?? transcript.permissions
            let readForms = try? await forms
            let readShared = try? await shared
            let open = readForms.flatMap { own in readShared.map { own + $0 + helperForms } } ?? transcript.forms
            let running = (try? await active).map { $0.contains(id) }
            // Earlier messages read as you scrolled up stay, ahead of the latest: only those this
            // read, not a saved copy's (whose start it doesn't know), and only when they reach the
            // latest page; after a gap (many messages while it was away), it starts again from it.
            let earlier = transcript.messages
            let reaches = page.data.first.map { first in earlier.last.map { $0.id >= first.id } ?? false } ?? false
            let kept = !isCopy && reaches ? page.data.first.map { first in earlier.filter { $0.id < first.id } } ?? [] : []
            if kept.isEmpty { earlierCursor = Self.cursor(before: page) }
            // The read, with what came while it was made.
            var fresh = transcript
            fresh.helpers.formUnion(helpers)
            // Unknown (the engine didn't answer): as it was, not stopped.
            fresh.load(messages: kept + page.data, inbox: waiting, permissions: asked, forms: open, isRunning: running ?? transcript.isRunning)
            fresh.catchUp(on: cameDuringRead[read] ?? [], shown: live ?? transcript)
            // It has what streamed in so far.
            discardLive()
            transcript = fresh
            // What the read no longer has waiting went meanwhile, without a word of it here: the
            // agent has it, or it was taken back.
            for (message, record) in outgoing where [.waiting, .takingBack].contains(record.state) && !transcript.pending.contains(where: { $0.id == message }) {
                move(message, to: transcript.messages.contains { $0.id == message } ? .delivered : .cancelled)
            }
            prepareCode(in: page.data)
            if transcript.isStale { scheduleReload() }
            // Whether its queue waits for Resume, and what's held, as its box says.
            readQueue(then: isLoaded ? .read : .opened)
            // A subagent's session is the engine's to set up; it only gets shown.
            if !isLoaded, !isSubagent { await syncFolders() }
            isLoaded = true
            isCopy = false
            keepCopy()
            quietReads = 0
        } catch let error where isLoaded && Reach.isTransient(error) {
            // Its computer was slow to answer or its link went, not the read: what shows stays, with
            // no failure said, and it's read again quietly in a moment (then less often while it
            // stays slow), or once its link is back (KuvoClient's `Reach`, as on the phone).
            readAgainSoon()
        } catch {
            fail(error)
            // Its machine is back but this one couldn't be read: no longer waiting, so the
            // failure shows (and what you do goes to the engine, which may answer now).
            if !waitsForEngine { isCopy = false }
        }
        refreshChanges()
    }

    /// A read its computer was too slow or too far to answer, tried again a moment later (then less
    /// often, `Reach.readAgain`), while it can be reached; a newer read takes its place.
    private func readAgainSoon() {
        quietReads += 1
        let wait = Reach.readAgain(after: quietReads)
        quietRead?.cancel()
        quietRead = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard let self, !Task.isCancelled, canReach else { return }
            await load()
        }
    }
    @ObservationIgnored private var quietRead: Task<Void, Never>?
    @ObservationIgnored private var quietReads = 0

    func apply(_ event: ServerEvent) {
        if !cameDuringRead.isEmpty, Transcript.changes(with: event.type) {
            for read in Array(cameDuringRead.keys) { cameDuringRead[read]?.append(event) }
        }
        if Transcript.isStreamed(event.type) {
            // Gathered, to show with what comes in the next moment.
            if live == nil { live = transcript }
            live?.apply(event)
            noteStreamed(event)
            if live?.isStale == true { scheduleReload() }
            showLiveSoon()
            return
        }
        // Anything else shows at once, after what streamed in before it.
        if Transcript.changes(with: event.type) {
            if live != nil {
                live?.apply(event)
                liveIsWordsOnly = false
                showLive()
            } else {
                transcript.apply(event)
            }
        }
        if !runningCommands.isEmpty { noteCommandMessages() }
        if transcript.isStale { scheduleReload() }
        switch event.type {
        case "session.tool.success", "session.execution.succeeded", "session.execution.failed", "session.revert.committed":
            refreshChanges()
        default:
            break
        }
        switch event.type {
        case "session.execution.succeeded", "session.execution.interrupted", "session.execution.failed":
            keepCopy()
            // The box decides a moment after (whether it was a Stop, a failed run pausing it).
            let ended: QueueMoment = event.type == "session.execution.failed" ? .runFailed : .runEnded
            if boxCarriesQueue == false { carryHere(ended) } else { readQueue(after: .seconds(2), then: ended) }
        case "session.inbox.enqueued", "session.inbox.delivery.changed":
            let moment: QueueMoment = event.type == "session.inbox.enqueued" ? .queued : .other
            if boxCarriesQueue == false { carryHere(moment) } else { readQueue(after: .milliseconds(300), then: moment) }
        case "session.inbox.cancelled", "session.inbox.delivered":
            if let id = try? event.payload(as: EventPayload.InboxChanged.self).inboxID {
                move(id, to: event.type == "session.inbox.delivered" ? .delivered : .cancelled)
            }
            if boxCarriesQueue != false { readQueue(after: .milliseconds(300)) }
        case "session.execution.started":
            drainTask?.cancel()
        case "session.revert.committed":
            // Final: there's nothing left to redo, and the conversation no longer ends at the undo.
            session.revert = nil
            undone = nil
        default:
            break
        }
        // Auto's reviewer decides as tools are called, and a pause ends the run; another client
        // may pick another approval.
        switch event.type {
        case "session.tool.success", "session.tool.failed", "session.execution.succeeded", "session.execution.interrupted", "session.execution.failed":
            if approval == .auto || decisions?.paused != nil { readDecisions() }
            // A question it went ahead on, on Autopilot, ends as a tool call: its line shows there.
            if event.type == "session.tool.success", isAutopilot { Task { await readAutopilot() } }
        case "session.updated", "session.metadata.updated":
            Task {
                await readApproval()
                await readAutopilot()
            }
        default:
            break
        }
        // (A box that carries the queue says when it's paused: a Stop holds it though nothing waits.)
        if boxCarriesQueue == false, transcript.pending.isEmpty { isQueuePaused = false }
    }

    /// Shows what streamed in: in a moment, with what comes meanwhile, or after `streamInterval`
    /// since it last showed.
    private func showLiveSoon() {
        guard showsLive == nil else { return }
        let due = lastShown + Self.streamInterval
        showsLive = Task {
            if due > .now { try? await Task.sleep(until: due) }
            // As a frame begins, so drawing it has the whole frame (see `FrameClock`).
            await FrameClock.shared.nextFrame()
            guard !Task.isCancelled else { return }
            showLive()
        }
    }

    /// What streamed in shows now.
    private func showLive() {
        showsLive?.cancel()
        showsLive = nil
        guard let shown = live else { return }
        live = nil
        defer {
            liveWords = nil
            liveIsWordsOnly = true
            lastShown = .now
        }
        // Only more words of the reply being written, which its view already shows as written:
        // in quietly, and to that view alone.
        if liveIsWordsOnly, let words = liveWords, let block = WritingBlock.Writing(in: shown),
           block.key.step == words.step, words.ordinal.map({ $0 == block.ordinal }) != false, writing.onlyGrows(to: block) {
            storedTranscript = shown
            writing.show(block)
            return
        }
        transcript = shown
    }

    /// Notes what streamed in: more words of one text, or anything else.
    private func noteStreamed(_ event: ServerEvent) {
        guard liveIsWordsOnly else { return }
        guard event.type == "session.text.delta", let delta = try? event.payload(as: EventPayload.Delta.self) else {
            liveIsWordsOnly = false
            return
        }
        if let words = liveWords, words.step != delta.assistantMessageID || words.ordinal != delta.ordinal {
            liveIsWordsOnly = false
        }
        liveWords = (delta.assistantMessageID, delta.ordinal)
    }

    /// What streamed in won't show: the engine's copy, read again, replaces it.
    private func discardLive() {
        showsLive?.cancel()
        showsLive = nil
        live = nil
        liveWords = nil
        liveIsWordsOnly = true
    }

    /// Changes the transcript once what streamed in has shown, so the change isn't lost under it.
    private func editTranscript(_ change: (inout Transcript) -> Void) {
        showLive()
        change(&transcript)
    }

    // MARK: Actions

    /// Sends a message with `files`, as `model` can take them (see `Attachments`). While the
    /// agent works, it gets the message at its next step, ahead of the queue. With `queue`, the
    /// message waits for the run, and everything queued before it, to finish.
    /// The first message in a folder the engine has just opened can come before its tools (the
    /// browser's, the integrations') are connected, and the model would go without them, to the
    /// browser for a service it has an integration for: it waits for them, once.
    @ObservationIgnored private var toolsChecked = false

    private func waitForTools() async {
        // The coding agents bring their own tools.
        guard !toolsChecked, !OutsideAgents.isAgentSession(session) else { return }
        // Done once it got an answer: a check the engine didn't answer is tried again next time.
        toolsChecked = await api.waitForTools(in: session.location.directory)
    }

    /// Where a conversation is, for anonymous usage: a bot's own folder (here or on a machine), a
    /// chat, or a project.
    private static func place(of directory: String) -> String {
        if Workspace.isBotFolder(directory) { return "bot" }
        return Workspace.isChat(directory) ? "chat" : "project"
    }

    /// `withComments`: your review comments go with it; a message the app writes for you leaves
    /// them for yours.
    /// `typed`: the keyword it's sent with, as typed ("/plan"), which its bubble shows.
    func send(_ text: String, files: [URL] = [], for model: Model?, queue: Bool = false, withComments: Bool = true, typed: String? = nil) {
        let written = text
        let comments = withComments ? reviewComments : []
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // The keyword it came with, the agents named with "&" said who they are, then the comments.
        let named = AgentReferences.text(typed.map { SentWithKeyword.message(words, typed: $0) } ?? words, excluding: session.id, here: RemoteFolder.machine(of: session.location.directory))
        let text = ReviewComments.text(named, adding: comments)
        guard !text.isEmpty || !files.isEmpty else { return }
        if withComments { reviewComments = [] }
        commitUndo()
        let delivery = post(text, files: files, for: model, queue: queue, written: written, comments: comments)
        var props = Analytics.model(provider: model?.providerID ?? session.model?.providerID, model: model?.id ?? session.model?.id)
        props["mode"] = Analytics.mode(agent)
        props["queued"] = delivery == .queue
        props["files"] = !files.isEmpty
        props["comments"] = !comments.isEmpty
        Analytics.shared.track("message_sent", props)
        Analytics.shared.noteMessage(in: session.id, chars: text.count)
        Analytics.shared.messageSent(path: Self.place(of: session.location.directory))
    }

    /// Undo for a removed message: back in the queue as it went (its words, what it names and its
    /// files, attached again); paused as the queue was, after a Stop, and then where it was, ahead of
    /// `before` (what came after it), as its box puts it; else at the queue's end.
    func requeue(_ item: Transcript.Pending, for model: Model?, paused: Bool, before: String? = nil) {
        // The agent took it before the removal reached it: it went, and doesn't go twice.
        guard !transcript.messages.contains(where: { $0.id == item.id }) else { return }
        // Taken from what waited on the box: back there as it was.
        if removedFromBox[item.id] != nil { return putBackOnBox(item) }
        guard canReach else {
            failure = "The message couldn't come back: its computer can't be reached."
            return
        }
        let (text, paths) = Attachments.split(item.text)
        if paused { isQueuePaused = true }
        post(text, files: Attachments.restored(item.files + Attachments.writeCarried(item.inlineFiles), noting: paths), for: model, queue: true, holds: paused, before: paused ? before : nil, written: text, comments: [])
    }

    /// The goal's ✕ once it's over: cleared once Undo's moment passes, unless another goal took
    /// its place meanwhile.
    func putAwayGoal() {
        guard let goal, goal.isOver else { return }
        let item = PutAway.goal(started: goal.started)
        putAways.put(item, text: "Goal put away", lingers: true, done: { [weak self] in
            guard let self, self.goal?.started == goal.started else { return }
            changeGoal(.clear) { [weak self] in
                self?.putAways.gone(item)
                if self?.failure == nil { self?.failure = "The goal couldn't be put away. Try again." }
            }
        })
    }

    /// What `submit` sends now is kept on disk elsewhere until it's gone (`submit`'s `keptElsewhere`).
    private var sendsKeptElsewhere = false

    /// Sends `text` as it is, with `files` attached: what's shown waiting at once, and what goes
    /// back to the composer if it can't go. Says how it was sent. `holds`: queued, whatever the
    /// agent is doing, to wait for Resume; `before`, Undo's, where it was (`requeue`).
    @discardableResult
    private func post(_ text: String, files: [URL], for model: Model?, queue: Bool, holds: Bool = false, before: String? = nil, written: String, comments: [ReviewComment]) -> InboxItem.Delivery {
        // Kept with this session from now on, so they go with it.
        let files = Attachments.claim(files, for: self.id)
        let id = Identifier.message()
        if let before { placesBack[id] = before }
        // With nothing running (or about to) and nothing queued, there's nothing to wait for.
        let delivery: InboxItem.Delivery = holds || queue && (isBusy || hasQueue) ? .queue : .steer
        if delivery == .steer { isQueuePaused = false }
        outgoing[id] = Outgoing(state: .sending, isOurs: true, startsRun: delivery == .steer && !isBusy)
        // To wait for Resume (put back after a Stop): the box holds it once it's there.
        if holds {
            // (Read before the write: `outgoing` can't be read while it's being written.)
            let first = outgoing.values.compactMap(\.heldAt).min() ?? 0
            outgoing[id]?.heldAt = first - 1
        }
        editTranscript { $0.addLocal(id: id, text: text, delivery: delivery, files: files) }
        // Kept on disk until the engine has it, it's back in the composer, or it's taken away: a
        // quit meanwhile (its tools starting, a slow engine) puts it back in the composer.
        let (quotes, words) = Quoting.draft(of: WidgetAnswer.split(written).text)
        var kept = Drafts.Draft(text: words, files: files, quotes: quotes)
        kept.comments = comments
        let onItsWay = sendsKeptElsewhere ? nil : Drafts.shared.onItsWay(kept, to: self.id)
        let previous = sending
        sending = Task {
            defer { if let onItsWay { Drafts.shared.sent(onItsWay) } }
            // Where the box put it, or not put back (it went, or didn't): as the queue shows.
            defer { placesBack[id] = nil }
            await previous?.value
            do {
                // Converting a photo takes a moment; keep it off the main thread. A machine's engine
                // can't read this Mac's files: they go to its box with their contents.
                let machine = RemoteFolder.machine(of: session.location.directory)
                let folder = Attachments.folder(for: self.id)
                let prepared = await Task.detached { machine != nil ? Attachments.prepareForMachine(files) : Attachments.prepare(files, for: model, in: folder) }.value
                let message = Attachments.text(text, for: prepared)
                await waitForTools()
                // Removed meanwhile: it doesn't go.
                guard outgoing[id]?.state == .sending else { return }
                // Moving to another computer: back in the composer, to send once it's there.
                try Moves.checkNotMoving(self.id)
                // Held while it was on its way: to the queue, not the next step.
                let asked: InboxItem.Delivery = outgoing[id]?.heldAt != nil ? .queue : delivery
                // For after this run: to the box, which holds it while the queue is paused, as anything
                // arriving then (the engine would run all it holds the moment it had one more), and
                // decides that itself: a Stop from another client may not have reached here yet.
                if asked == .queue, await holdsOnBox() {
                    try await holdOnBox(id, text: message, files: prepared.files, written: (text, files), before: placesBack[id])
                    restoredFailed = ""
                    return
                }
                update(id) { $0.request = asked }
                if let machine, !prepared.files.isEmpty {
                    try await MachineBox.prompt(session: self.id, id: id, text: message, files: prepared.files, delivery: asked,
                                                withAgents: OutsideAgents.isAgentSession(session), folder: RemoteFolder.parse(session.location.directory)?.path,
                                                on: SSHConnection(destination: machine))
                } else {
                    try await api.prompt(session: self.id, id: id, text: message, files: prepared.files, delivery: asked)
                }
                restoredFailed = ""
                await requestDone(id)
            } catch {
                update(id) {
                    $0.state = .cancelled
                    $0.request = nil
                }
                editTranscript { $0.removeLocal(id: id) }
                // It didn't go: back in the composer as it was, ahead of anything written since
                // (after one sent before it that didn't go either, in the order they were sent).
                let (quotes, text) = Quoting.draft(of: WidgetAnswer.split(written).text)
                restoreFailed(text: text, files: files, quotes: quotes, comments: comments)
                fail(error)
            }
        }
        return delivery
    }

    /// A message's request went: the engine has it. Moved to the queue if Stop held it as it went,
    /// and taken back if it was removed meanwhile, before Stop's wait for it ends.
    private func requestDone(_ message: String) async {
        guard let asked = outgoing[message]?.request else { return }
        let state = outgoing[message]?.state
        // Held as it went: the box holds it now, ahead of what was queued (not reached, it's in
        // the queue at least).
        if outgoing[message]?.heldAt != nil, state != .delivered, state != .cancelled {
            let boxHeld = await carriesQueue() ? await queueRoute("queue/hold", items: [message]) != nil : false
            if !boxHeld, asked == .steer { try? await api.setDelivery(session: id, item: message, delivery: .queue) }
        }
        if outgoing[message]?.state == .cancelled { try? await api.cancelInbox(session: id, item: message) }
        update(message) {
            $0.request = nil
            if $0.state == .sending { $0.state = .waiting }
        }
    }

    /// Once the messages on their way have gone to the engine, or come back to the composer.
    func messagesSent() async {
        await sending?.value
    }

    /// Sends the composer's draft as it is (its text, files and what it replies to), emptying it
    /// first: what can't be sent comes back to it. `unavailable`: why the session's model can't
    /// run (its account signed out of, or the model gone from it: `Catalog.refusal`), said
    /// instead, the draft kept: the engine would take the message and drop it without a word. A
    /// "!" command needs no model.
    func submitDraft(for model: Model?, queue: Bool, commands: [Command], unavailable: String? = nil) {
        failure = nil
        // Carrying on with the coding agents: it stays in the composer, and goes along with it.
        if Moves.toAgents.contains(id) {
            failure = Moves.Failure.movingToAgents.localizedDescription
            return
        }
        // (Nor does pausing, resuming or taking away a goal.)
        if let unavailable, Self.shellCommand(in: draftText) == nil, GoalCommand(draftText)?.needsModel ?? true {
            failure = unavailable
            return
        }
        // A "!" or "/" command runs as typed; what you were replying to waits for a message.
        let commands = Keyword.commands(commands, keywords: keywords)
        let isCommand = Self.runsAsTyped(draftText, commands: commands, keywords: keywords)
        // The side thread's tag on the composer: a follow-up there, answered with the thread so
        // far, not a message to the agent. A keyword or command still runs as typed; what's
        // attached stops it: a side question takes none.
        if asksSideThread, !isCommand {
            // One at a time: it waits in the composer while the last is answered.
            guard !sideThreadAnswering else { return }
            // Nothing goes with a file attached: a picture's "[Image 1]" would go without it.
            guard draftFiles.isEmpty else {
                failure = Self.sideTakesNoFiles
                return
            }
            let question = Quoting.message(quotes: draftQuotes, text: draftText)
            guard !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            draftText = ""
            draftQuotes = []
            askFollowUp(question)
            return
        }
        let text = isCommand ? draftText : Quoting.message(quotes: draftQuotes, text: draftText)
        let files = draftFiles
        draftText = ""
        draftFiles = []
        restoredGoal = ""
        if !isCommand { draftQuotes = [] }
        submit(text, files: files, for: model, queue: queue, commands: commands)
    }

    /// Sends what's in the composer: a message, or a command for "/name arguments". What can't
    /// be sent goes back there.
    /// `keptElsewhere`: what's sent is kept on disk until it's gone already (a new session's first
    /// message, kept by its new-session composer), so it isn't kept twice.
    /// `commands`: the engine's commands and yours, as the catalog has them; the engine's own
    /// /review goes by /review-quick here where the keyword has the name, as "/" lists it.
    func submit(_ text: String, files: [URL], for model: Model?, queue: Bool, commands: [Command], keptElsewhere: Bool = false) {
        let commands = Keyword.commands(commands, keywords: keywords)
        sendsKeptElsewhere = keptElsewhere
        defer { sendsKeptElsewhere = false }
        sent += 1
        if let goal = GoalCommand(text) {
            // For its computer's box, not the agent.
            runGoal(goal, written: text, files: files)
        } else if let (keyword, rest) = typedKeyword(text) {
            runKeyword(keyword, rest: rest, written: text, files: files, for: model, queue: queue)
        } else if let arguments = Self.quickReview(in: text, commands: commands) {
            // The engine's own /review, which ours took the name of.
            runCommand("review", arguments: arguments, files: files, for: model, queue: queue, written: text)
        } else if let command = Self.shellCommand(in: text) {
            // A "!" command takes no files: they wait in the composer for a message.
            if !files.isEmpty { draftFiles = files + draftFiles.filter { file in !files.contains { $0.path == file.path } } }
            runShell(command, written: text)
        } else if let (name, arguments) = SlashCommands.parse(text, commands: commands) {
            runCommand(name, arguments: arguments, files: files, for: model, queue: queue, written: text)
        } else {
            send(text, files: files, for: model, queue: queue)
        }
    }

    // MARK: Keywords

    /// The keywords "/" offers here, as its computer's box runs them: a subagent's conversation
    /// has none (its work is the conversation it works for's).
    var keywords: [Keyword] {
        guard session.parentID == nil else { return [] }
        let keywordsRun = goalBridge().map { $0.api != nil && $0.runsKeywords == true } ?? false
        return Keyword.allCases.filter { keyword in
            switch keyword {
            case .goal: takesGoals
            case .review, .btw, .handoff: keywordsRun
            case .loop, .plan: true
            // Where its box has it.
            case .autopilot: autopilotShown != nil
            // Every conversation: an agent that can't says why when asked.
            case .compact: true
            }
        }
    }

    /// What runs as typed even while the side thread's tag shows: a "!" command, or a keyword or
    /// command offered here (`commands` with the keywords' names taken). The composer's tag follows
    /// it too, so a mistyped path goes to the thread with the tag in sight.
    static func runsAsTyped(_ text: String, commands: [Command], keywords: [Keyword]) -> Bool {
        if shellCommand(in: text) != nil || SlashCommands.parse(text, commands: commands) != nil || GoalCommand(text) != nil { return true }
        guard let (keyword, _) = Keyword.parse(text) else { return false }
        return keyword != .goal && keywords.contains(keyword)
    }

    static let sideTakesNoFiles = "A side question can’t include pictures or files. Remove them, or close Side question to send it all to the agent."

    static func quickReview(in text: String, commands: [Command]) -> String? {
        guard let (name, arguments) = SlashCommands.split(text), name == Keyword.quickReview, commands.contains(where: { $0.name == Keyword.quickReview }) else { return nil }
        return arguments
    }

    /// The keyword a message starts with, of those offered here ("/goal" is the goal's own, above).
    private func typedKeyword(_ text: String) -> (keyword: Keyword, rest: String)? {
        guard let (keyword, rest) = Keyword.parse(text), keyword != .goal, keywords.contains(keyword) else { return nil }
        return (keyword, rest)
    }

    /// A keyword sent: what it asks for, rather than a message to the agent. What can't be done
    /// goes back to the composer as `written`, and says why. Only /plan and /loop's messages take
    /// files: the others leave them in the composer.
    private func runKeyword(_ keyword: Keyword, rest: String, written: String, files: [URL], for model: Model?, queue: Bool) {
        if !files.isEmpty, keyword != .plan, keyword != .loop, keyword != .autopilot { restore(text: "", files: files) }
        switch keyword {
        case .goal:
            break
        case .plan:
            // Alone, it turns Plan on or off; with words, it plans them.
            if rest.isEmpty && files.isEmpty { togglePlan() } else { selectAgent("plan") }
            if !rest.isEmpty { send(rest, files: files, for: model, queue: queue, typed: Keyword.plan.typed) } else if !files.isEmpty { restore(text: "", files: files) }
        case .autopilot:
            // Alone, it turns Autopilot on or off; with words, it does them on Autopilot (set on
            // its box first, so its agent works that way from the first word).
            if rest.isEmpty && files.isEmpty {
                setAutopilot(!isAutopilot)
            } else {
                Task {
                    guard await switchAutopilot(true) else { return restore(text: written, files: files) }
                    if rest.isEmpty { restore(text: "", files: files) } else { send(rest, files: files, for: model, queue: queue, typed: Keyword.autopilot.typed) }
                }
            }
        case .compact:
            compact()
        case .loop:
            startLoop(LoopCommand(rest), written: written, files: files, for: model)
        case .btw:
            guard !rest.isEmpty else { return restore(text: Keyword.btw.typed + " ") }
            askSideQuestion(rest, written: written)
        case .handoff:
            startHandoff(next: rest, written: written)
        case .review:
            // A coding agent's conversation is read by its own agent: "with" names no other.
            let readers = OutsideAgents.isAgentSession(session) ? [] : catalog()?.reviewReaders ?? []
            startReview(ReviewCommand(rest, readers: readers, preferring: Catalog.lastReviewer), written: written)
        }
        Analytics.shared.track("keyword_run", ["keyword": keyword.rawValue])
    }

    /// "/loop <how often> <what to do>": the message sent now for one every so long (and then
    /// each time), and a wake-up on its computer that sends it again, by its clock.
    private func startLoop(_ command: LoopCommand, written: String, files: [URL], for model: Model?) {
        guard let schedule = command.schedule else {
            restore(text: written, files: files)
            failure = "Can’t tell how often from that. Start with one like “every 30 min” or “weekdays at 9”, or pick one from the list after /loop."
            return
        }
        guard !command.message.isEmpty else {
            restore(text: written, files: files)
            failure = "Write what to do each time after how often, like “/loop every morning at 9 sum up the new issues”."
            return
        }
        guard let wakeUps = AgentMail.shared.app?.wakeUps else {
            restore(text: written, files: files)
            failure = "Wake-ups can’t be set from here now. Try again in a moment."
            return
        }
        // A wake-up sends words: what's attached goes with the message sent now, or stays here.
        if schedule.keepsTimeOfDay, !files.isEmpty { restore(text: "", files: files) }
        let owner = WakeUps.owner(of: session)
        let now = Date.now
        Task {
            do {
                try await wakeUps.add(to: owner, at: schedule.firstWake(now: now), every: schedule.every, note: command.message)
                if !schedule.keepsTimeOfDay { send(command.message, files: files, for: model, queue: false, typed: Keyword.loop.typed + " " + command.scheduleText) }
            } catch {
                restoreWritten(written, files: files)
                fail(error)
            }
        }
    }

    /// The side questions asked about it ("/btw"), oldest first, as its computer's box keeps them.
    var sideQuestions: [SideQuestion] { goalBridge()?.sideQuestions[id] ?? [] }
    /// Those as side threads, in the order they were started.
    var sideThreads: [SideThread] { SideThread.threads(sideQuestions) }
    /// A question of the side thread that shows over the composer: the latest asked here, until
    /// it's put away. Another one showing puts the composer on its thread.
    var shownSideQuestion: String? {
        didSet {
            // Another thread: the composer asks it. A follow-up in the same one leaves the tag as
            // it is (its × may have been clicked while it was asked).
            guard let shown = shownSideQuestion, shown != oldValue else { return }
            let thread = { (id: String?) in self.sideQuestions.first { $0.id == id }?.threadID }
            if oldValue == nil || thread(shown) != thread(oldValue) { composerAsksSide = true }
        }
    }

    /// The composer asks the side thread rather than the conversation: from when a side question
    /// is asked or shown, until its tag's × puts the composer back on the conversation.
    var composerAsksSide = false {
        didSet { if !composerAsksSide, failure == Self.sideTakesNoFiles { failure = nil } }
    }
    /// Whether what's sent now is a follow-up in the side thread: while it shows, folded too
    /// (the tag says so either way).
    var asksSideThread: Bool { composerAsksSide && shownSideThread != nil }
    /// A follow-up on its way to the box, before its question is in the thread.
    private var sendsFollowUp = false
    /// The side thread's last question is still being answered: the next waits in the composer.
    var sideThreadAnswering: Bool { sendsFollowUp || shownSideThread?.latest.state == .answering }

    /// The side thread that shows over the composer.
    var shownSideThread: SideThread? {
        guard let id = shownSideQuestion, let question = sideQuestions.first(where: { $0.id == id }) else { return nil }
        return sideThreads.first { $0.id == question.threadID }
    }

    /// A side question: a new side thread, or a follow-up in `thread`. One that can't be asked
    /// comes back to the composer as it was written.
    private func askSideQuestion(_ question: String, written: String, thread: String? = nil) {
        guard let bridge = goalBridge(), let api = bridge.api else { return keywordUnavailable(written) }
        let session = id
        if thread != nil { sendsFollowUp = true }
        Task {
            do {
                // Its list read first if it isn't yet (the conversation just opened), so the answer's
                // event, which can come at once, has it to go into.
                if bridge.sideQuestions[session] == nil { await bridge.loadSideQuestions(of: session) }
                let asked = try await api.askSideQuestion(question, about: session, thread: thread)
                bridge.took(asked)
                sendsFollowUp = false
                shownSideQuestion = asked.id
            } catch {
                sendsFollowUp = false
                restoreWritten(written)
                fail(error)
            }
        }
    }

    /// A follow-up in the side thread that shows: answered with the thread so far.
    func askFollowUp(_ question: String) {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let thread = shownSideThread else { return }
        askSideQuestion(text, written: question, thread: thread.id)
    }

    /// Takes a side thread away, all of it.
    func removeSideThread(_ thread: SideThread) {
        guard let bridge = goalBridge(), let api = bridge.api else { return }
        let session = id
        if shownSideThread?.id == thread.id { shownSideQuestion = nil }
        Task {
            do {
                try await api.removeSideThread(thread.id, of: session)
                for question in thread.questions { bridge.dropSideQuestion(question.id, of: session) }
            } catch { fail(error) }
        }
    }

    /// Shows a side question's answer over the composer, the latest asked (`id` nil) or the one
    /// picked, its list read first if it isn't yet (opened from the sidebar).
    func showSideQuestion(_ id: String?) async {
        guard let bridge = goalBridge() else { return }
        await bridge.loadSideQuestions(of: self.id)
        shownSideQuestion = id ?? bridge.sideQuestions[self.id]?.last?.id
        hidesSideQuestion = false
        // Opened again: the composer asks it, also when it was showing.
        composerAsksSide = true
    }

    /// The side thread's New Side Thread: "/btw " in the composer, ready to finish.
    func askAnotherSideQuestion() {
        draftText = Keyword.btw.typed + " "
        composerFocus += 1
    }

    /// Its handoff ("/handoff") while the note is written, or why it couldn't be.
    var handoff: Handoff? { goalBridge()?.handoffs[id] }

    private func startHandoff(next: String, written: String) {
        guard let bridge = goalBridge(), let api = bridge.api else { return keywordUnavailable(written) }
        let session = id
        Task {
            do {
                bridge.startedHandoff(try await api.handoff(session: session, next: next.isEmpty ? nil : next))
            } catch {
                restoreWritten(written)
                fail(error)
            }
        }
    }

    /// Its latest review with fresh eyes ("/review"), until it's put away.
    var review: Review? { goalBridge()?.reviews[id] }

    /// The catalog of the engine it runs on, whose models can read a review: the app's (a test
    /// gives its own).
    @ObservationIgnored var reviewCatalog: (() -> Catalog?)?
    /// Its models, by which a review's line names who read it.
    var reviewCatalogNow: Catalog? { catalog() }
    private func catalog() -> Catalog? {
        if let reviewCatalog { return reviewCatalog() }
        guard let app = AgentMail.shared.app else { return nil }
        return RemoteFolder.machine(of: session.location.directory).flatMap { app.machines.engine($0)?.catalog } ?? app.catalog
    }

    /// "/review [what it reads] [for what] [with <model>] [what to look at]": what it names (the
    /// changes not committed yet without), read by that model (the conversation's own without
    /// one), looking especially there. A name or a commit or folder it can't read comes back to
    /// the composer.
    private func startReview(_ command: ReviewCommand, written: String) {
        if let searching = command.searching {
            restore(text: written)
            failure = searching.isEmpty ? "Pick who reads it from the list, or write a model’s name after “with”." : "Finish the model’s name, or pick it from the list."
            return
        }
        if let unfinished = ReviewList.unfinished(command) {
            restore(text: written)
            failure = unfinished
            return
        }
        guard let bridge = goalBridge(), let api = bridge.api else { return keywordUnavailable(written) }
        let session = id
        Task {
            do {
                bridge.took(try await api.startReview(session: session, model: command.reader?.ref, focus: command.focusAsked, scope: command.scopeAsked == .uncommitted ? nil : command.scopeAsked))
            } catch {
                restoreWritten(written)
                fail(error)
            }
        }
    }

    /// Ends the review under way where it is, keeping what it found so far.
    func stopReview() {
        guard let bridge = goalBridge(), let api = bridge.api else { return }
        let session = id
        Task {
            do {
                bridge.took(try await api.stopReview(session: session))
            } catch {
                fail(error)
            }
        }
    }

    func dismissReview() {
        guard let bridge = goalBridge(), let api = bridge.api else { return }
        let session = id
        bridge.dropReview(session)
        dismissingReview = Task { try? await api.dismissReview(session: session) }
    }

    /// Putting the review away on its computer, while it goes (what a test waits on).
    @ObservationIgnored private(set) var dismissingReview: Task<Void, Never>?

    /// The review's findings, sent to the agent as your message.
    func fixReview() {
        guard let fix = review?.fix else { return }
        dismissReview()
        sendReviewFix(fix)
    }

    /// What the box wrote to fix a review's findings, sent here: the app's words, so the review
    /// comments you're writing stay for your own message.
    func sendReviewFix(_ text: String) {
        send(text, files: [], for: nil, queue: false, withComments: false)
    }

    /// What to send an agent to fix the review's findings, all or those of `findings` (their ids),
    /// as its computer's box writes it; nil, saying why, when it can't be had.
    func reviewFixText(_ findings: [String]?) async -> String? {
        guard let bridge = goalBridge(), let api = bridge.api else {
            failure = "The review’s computer can’t be reached now. Try again in a moment."
            return nil
        }
        do {
            return try await api.reviewFix(session: id, findings: findings)
        } catch {
            fail(error)
            return nil
        }
    }

    /// The review the card shows: not one put away, waiting out its Undo.
    var shownReview: Review? {
        guard let review, !putAways.isPutAway(.review(review.id)) else { return nil }
        return review
    }

    /// A finished review put away with ✕: its line says so, with Undo, for a moment; then it's
    /// put away on its computer too.
    func putAwayReview() {
        guard let review, review.state != .reviewing else { return }
        let item = PutAway.review(review.id)
        putAways.put(item, text: "Review put away", lingers: true, done: { [weak self] in
            // Only that one: a review asked for since has taken its place on its computer.
            if self?.review?.id == review.id { self?.dismissReview() }
            self?.putAways.gone(item)
        })
    }

    private func keywordUnavailable(_ written: String) {
        restore(text: written)
        failure = "This runs in the agents bridge beside the engine on this conversation’s computer, and it isn’t running now. Try again in a moment."
    }

    // MARK: Goals

    /// The goal it works toward, or the one it met, until it's put away: as its computer's box has it.
    var goal: Goal? { goalBridge()?.goals[id] }

    /// Whether its computer runs goals now (its agents bridge is up, and new enough) for it (not a
    /// subagent's, whose goal is the conversation it works for): "/goal" is offered then.
    var takesGoals: Bool { session.parentID == nil && (goalBridge().map { $0.api != nil && $0.runsGoals != false } ?? false) }

    /// "/goal <words>" in a bot's conversation: its box has the bot plan it and put it to you on a
    /// card (PROTOCOL.md, "Work › Goals"); false for a conversation that isn't a bot's (set by the app).
    @ObservationIgnored static var askBotForGoal: ((_ session: String, _ words: String) async throws -> Bool)?

    /// "/goal …" sent: its computer's box sets the goal and starts the agent on it, or pauses,
    /// resumes or takes away the one there. "/goal" alone shows it; with none, what to type is
    /// left ready to finish. A goal is words: files wait in the composer. What can't be done comes
    /// back to the composer as `written`, and says why.
    private func runGoal(_ command: GoalCommand, written: String, files: [URL]) {
        if !files.isEmpty { restore(text: "", files: files) }
        if command == .show {
            if goal == nil { restore(text: "/goal ") }
            hidesGoal = false
            return
        }
        // A bot's goal starts from its plan: the bot is asked for one, and puts it to you.
        if case .set(let words) = command, let ask = Self.askBotForGoal {
            let session = id
            Task {
                do {
                    if try await ask(session, words) { return }
                    runGoalHere(command, written: written)
                } catch {
                    restoreWritten(written)
                    failure = error.localizedDescription
                }
            }
            return
        }
        runGoalHere(command, written: written)
    }

    private func runGoalHere(_ command: GoalCommand, written: String) {
        guard takesGoals else {
            restoreWritten(written)
            failure = session.parentID != nil
                ? "A subagent’s conversation can’t have a goal of its own. Set it in the conversation it works for."
                : goalBridge()?.api != nil
                ? "This computer’s agents bridge is from before goals. Set it up again in Settings › Machines to update it."
                : Self.goalsNotRunning
            return
        }
        changeGoal(command) { [weak self] in self?.restoreWritten(written) }
    }

    private static let goalsNotRunning = "Goals run in the agents bridge beside the engine on this conversation’s computer, and it isn’t running now. Try again in a moment."

    /// The goal bar's Stop: the goal taken away, and, while it's at work, the turn under way
    /// stopped. A paused goal's turn under way is yours (or the one Pause let finish): it goes on.
    func stopGoal() {
        let stopsTurn = goal?.state == .working && isRunning
        guard changeGoal(.clear) else { return }
        if stopsTurn { stop() }
    }

    /// Changes the goal on its computer's box (the goal bar's buttons too); what can't be done is
    /// said over the composer. Whether it was sent.
    @discardableResult
    func changeGoal(_ command: GoalCommand, failed: @escaping () -> Void = {}) -> Bool {
        guard !isChangingGoal else {
            failed()
            return false
        }
        guard let bridge = goalBridge(), let api = bridge.api else {
            failure = Self.goalsNotRunning
            failed()
            return false
        }
        let session = id
        failure = nil
        isChangingGoal = true
        Task {
            defer { isChangingGoal = false }
            do {
                // Shown as the box answered, before its event comes.
                switch command {
                case .set(let condition):
                    bridge.took(try await api.setGoal(session: session, condition: condition))
                    hidesGoal = false
                case .pause: bridge.took(try await api.pauseGoal(session: session))
                case .resume: bridge.took(try await api.resumeGoal(session: session))
                case .clear:
                    try await api.clearGoal(session: session)
                    bridge.dropGoal(session)
                case .show: break
                }
            } catch {
                failed()
                fail(error)
            }
        }
        return true
    }

    /// "!" at the start of a message: the rest is a command to run in the session's folder.
    static func shellCommand(in text: String) -> String? {
        guard text.hasPrefix("!") else { return nil }
        let command = text.dropFirst().trimmingCharacters(in: .whitespacesAndNewlines)
        return command.isEmpty ? nil : command
    }

    /// Runs a command in the session's folder (on its machine, for a project on one) as you,
    /// right away, without waking the agent; it and its output join the conversation, and the
    /// agent gets them with your next message. `written` is what the composer had: it goes back
    /// there if the command can't run.
    func runShell(_ command: String, written: String? = nil) {
        guard canReach else { return notRun(written) }
        Analytics.shared.track("shell_run")
        let previous = sending
        sending = Task {
            await previous?.value
            do {
                // Moving to another computer: back in the composer, to run once it's there.
                try Moves.checkNotMoving(id)
                try await api.runShell(session: id, command: command)
            } catch {
                notRun(written, because: error)
            }
        }
    }

    /// Runs a command, with files as a message would carry them. With `queue`, it waits for the
    /// run, as a queued message does. `written` is what the composer had: it goes back there,
    /// with the files, if the command can't run.
    func runCommand(_ name: String, arguments: String, files: [URL] = [], for model: Model? = nil, queue: Bool = false, written: String? = nil) {
        guard canReach else { return notRun(written, files: files) }
        let files = Attachments.claim(files, for: id)
        let running = RunningCommand(
            command: arguments.isEmpty ? "/\(name)" : "/\(name) \(arguments)",
            started: Date(),
            before: Set(userMessageIDs + transcript.pending.map(\.id))
        )
        runningCommands.append(running)
        // The engine's own commands by name; yours (named by you) as "custom".
        Analytics.shared.track("command_run", ["command": ["init", "review"].contains(name) ? name : "custom"])
        let delivery: InboxItem.Delivery = queue && (isBusy || hasQueue) ? .queue : .steer
        let previous = sending
        sending = Task {
            await previous?.value
            do {
                let machine = RemoteFolder.machine(of: session.location.directory)
                let folder = Attachments.folder(for: id)
                let prepared = await Task.detached { machine != nil ? Attachments.prepareForMachine(files) : Attachments.prepare(files, for: model, in: folder) }.value
                try Moves.checkNotMoving(id)
                if let machine, !prepared.files.isEmpty {
                    try await MachineBox.command(session: id, name: name, text: Attachments.text(arguments, for: prepared), files: prepared.files, delivery: delivery,
                                                 withAgents: OutsideAgents.isAgentSession(session), folder: RemoteFolder.parse(session.location.directory)?.path,
                                                 on: SSHConnection(destination: machine))
                } else {
                    try await api.runCommand(session: id, name: name, arguments: Attachments.text(arguments, for: prepared), files: prepared.files, delivery: delivery)
                }
            } catch {
                runningCommands.removeAll { $0.id == running.id }
                notRun(written, files: files, because: error)
            }
        }
    }

    /// A command from the composer that didn't run goes back there as you wrote it, ahead of
    /// anything written since, and says why. One from elsewhere (Retry) only says why.
    private func notRun(_ written: String?, files: [URL] = [], because error: Error? = nil) {
        if let written { restore(text: written, files: files) }
        if let error {
            fail(error)
        } else if written != nil {
            failure = RemoteFolder.isRemote(session.location.directory)
                ? "It didn't run: this session's machine can't be reached now."
                : "It didn't run: the engine is still starting. Send it again in a moment."
        }
    }

    private var userMessageIDs: [String] {
        transcript.messages.compactMap { if case .user(let user) = $0 { user.id } else { nil } }
    }

    /// Gives each command its message: the first new one, oldest command first, that wasn't
    /// sent from here or waiting already, and came after the command was run. A command that
    /// runs elsewhere (as a subagent's task) never gets one here, so it's let go after a while.
    private func noteCommandMessages() {
        runningCommands.removeAll { Date().timeIntervalSince($0.started) > 600 }
        while let running = runningCommands.first {
            // By the engine's clock, as the messages' times are (a machine's can differ from this Mac's).
            let since = running.started.timeIntervalSince1970 * 1000 - storedTranscript.clockOffset - 2000
            let message = transcript.messages.lazy.compactMap { if case .user(let user) = $0 { user } else { nil } }.first {
                !running.before.contains($0.id) && outgoing[$0.id]?.isOurs != true && CommandMessages.shared[$0.id] == nil && $0.time.created >= since
            }
            guard let message else { return }
            CommandMessages.shared.note(message.id, command: running.command)
            runningCommands.removeFirst()
        }
    }

    /// Stops the agent. Waiting messages stay, queued and paused until Resume: its box holds them
    /// and stops the run.
    func stop() {
        stops += 1
        Task {
            let inFlight = holdOnTheirWay()
            // A held message whose request for the next step is already on its way: there before
            // the stop (ten seconds at most), so the box holds it rather than it landing after the
            // stop on an idle session and starting the agent again. One not sent yet goes to the
            // queue anyway (see `send`).
            let deadline = ContinuousClock.now + .seconds(10)
            for message in inFlight {
                await wait(for: message, until: deadline) { $0.request != nil }
            }
            // Its box not reached: the run stopped here all the same, and the box, hearing it, holds
            // what waits. One that doesn't carry the queue: held here.
            if await carriesQueue() {
                guard await queueRoute("stop") == nil else { return }
            } else {
                await holdHere()
            }
            try? await api.interrupt(session: id)
        }
    }

    /// What's waiting, held where it is (paused) before the session is stopped from elsewhere: it
    /// isn't started as the run ends (undo, or moving the session to a coding agent).
    func holdQueue() async {
        _ = holdOnTheirWay()
        if await carriesQueue() { _ = await queueRoute("queue/hold") } else { await holdHere() }
    }

    /// Before a Stop: messages for the agent's next step still on their way from here are held,
    /// ahead of what the box holds, and sent to the queue (see `send`, `requestDone`); those whose
    /// request is on its way: what it gives back. What the engine has, the box holds.
    private func holdOnTheirWay() -> [String] {
        // Not one sent from here to start a run, still on its way: it goes as it is.
        let held = transcript.pending.filter { item in
            guard item.delivery == .steer, let record = outgoing[item.id], !(item.isLocal && record.startsRun) else { return false }
            return record.state == .sending || record.request == .steer
        }
        if hasQueue || !transcript.pending.filter({ $0.delivery == .steer }).isEmpty { isQueuePaused = true }
        // Ahead of those held before.
        let first = (outgoing.values.compactMap(\.heldAt).min() ?? 0) - held.count
        var inFlight: [String] = []
        for (index, item) in held.enumerated() {
            guard var record = outgoing[item.id] else { continue }
            record.heldAt = first + index
            // It waits for Resume now, shown with the rest.
            record.startsRun = false
            outgoing[item.id] = record
            if record.request == .steer { inFlight.append(item.id) }
        }
        return inFlight
    }

    /// The session's queue as its box has it now.
    struct BoxQueue: Decodable {
        var paused: Bool
        var held: [String]
        var waiting: [Waiting]?
        /// Whether a message added (`queue/add`) waits on the box.
        var waits: Bool?
        /// The one a `DELETE` took away, as it was.
        var removed: Removed?

        /// A message waiting on the box: who it's from (none: yours), what it says, its files' names.
        struct Waiting: Decodable, Hashable {
            var id: String
            var from: String?
            var text: String
            var files: [String]?
        }

        /// One taken away from what waits on the box, whole, to add back as it was (`kept`), where
        /// it was: ahead of `before`, what came after it.
        struct Removed: Codable {
            var id: String
            var text: String
            var files: [JSONValue]?
            var delivery: InboxItem.Delivery
            var from: String?
            var words: String?
            var before: String?
            /// Added back as it was (`queue/add`).
            var kept: Bool?
        }
    }

    /// One of the queue's routes on the session's box (`kuvo/sessions/<id>/<action>`), and what it
    /// says the queue is now; nil when the box can't take it (an older one, or not there now).
    @discardableResult
    private func queueRoute(_ action: String, method: String = "POST", items: [String]? = nil) async -> BoxQueue? {
        struct Held: Encodable { var items: [String] }
        return try? await changeQueue(action, method: method, body: items.map { Held(items: $0) })
    }

    /// `queueRoute`, saying why the box didn't take it.
    private func changeQueue(_ action: String, method: String = "POST", body: (any Encodable)? = nil) async throws -> BoxQueue {
        // A change asked for: a read from before it says nothing now.
        if method != "GET" {
            queueChanges += 1
            queueRead?.cancel()
        }
        let asked = queueChanges
        guard let box = box() else { throw CancellationError() }
        let state = try await box.value(BoxQueue.self, method, "kuvo/sessions/\(id)/\(action)", body: body)
        // Another change asked for since: its answer is the one to show.
        if asked == queueChanges { takeQueue(paused: state.paused, held: state.held, waiting: state.waiting ?? []) }
        return state
    }

    /// The queue as its box says it is now (a read, a change's answer, or this Mac's box following
    /// its queues).
    func takeQueue(paused: Bool, held: [String], waiting: [BoxQueue.Waiting] = []) {
        #if DEBUG
        // (KUVO_DEMO_WAITING_FROM's, whatever the box says.)
        if let demoOnBox { return (isQueuePaused, onBox) = (true, demoOnBox) }
        #endif
        isQueuePaused = paused
        heldByBox = held
        if onBox != waiting { onBox = waiting }
        yoursOnBox = yoursOnBox.filter { item in waiting.contains { $0.id == item.key } || outgoing[item.key]?.state == .sending }
        // Held by the box now: in its order.
        for message in held where outgoing[message]?.heldAt != nil { outgoing[message]?.heldAt = nil }
    }

    /// Whether its box keeps what arrives while the queue is paused (`queue.waits`): this Mac's
    /// does, and a machine's says so.
    private func holdsOnBox() async -> Bool {
        guard await carriesQueue() else { return false }
        return await boxFeatures().contains("queue.waits")
    }

    /// `message` (with `files`, as the engine takes them) for after this run, to the box: held there
    /// for Resume while the queue is paused, shown in the queue as the box lists it, `written` kept
    /// for Edit; otherwise the box sends it to the engine, as asked. `before`: Undo's, put back ahead
    /// of what came after it.
    private func holdOnBox(_ message: String, text: String, files: [OpenCodeAPI.PromptFile], written: (text: String, files: [URL]), before: String? = nil) async throws {
        struct Add: Encodable { var id: String; var text: String; var files: [OpenCodeAPI.PromptFile]?; var delivery: InboxItem.Delivery; var words: String; var before: String? }
        yoursOnBox[message] = written
        let state: BoxQueue
        do {
            // Shown as you wrote it, without its files' notes for the agent.
            state = try await changeQueue("queue/add", body: Add(id: message, text: text, files: files.isEmpty ? nil : files, delivery: .queue, words: written.text, before: before))
        } catch {
            yoursOnBox[message] = nil
            throw error
        }
        if state.waits == true {
            // Its row now the box's.
            update(message) { $0.state = .waiting }
            editTranscript { $0.removeLocal(id: message) }
        } else {
            yoursOnBox[message] = nil
            update(message) { $0.request = .queue }
            await requestDone(message)
        }
    }

    /// One waiting on the box taken away (Remove): Undo puts it back as it was (`putBackOnBox`).
    func removeFromBox(_ item: Transcript.Pending) {
        guard canReach, let index = onBox.firstIndex(where: { $0.id == item.id }) else { return }
        onBox.remove(at: index)
        removedFromBox[item.id] = Task {
            // (Gone already, sent or taken away elsewhere: as the box says.)
            guard let state = try? await changeQueue("queue/\(item.id)", method: "DELETE") else {
                readQueue()
                return nil
            }
            return state.removed
        }
    }

    /// Undo for one taken away from what waits on the box: back as it was, where it was (the box
    /// said what came after it).
    func putBackOnBox(_ item: Transcript.Pending) {
        guard canReach else { return }
        puttingBack[item.id] = Task {
            defer { puttingBack[item.id] = nil }
            guard var removed = await removedFromBox.removeValue(forKey: item.id)?.value else { return }
            removed.kept = true
            do {
                _ = try await changeQueue("queue/add", body: removed)
            } catch {
                failure = "The message couldn't come back: its computer didn't answer."
            }
        }
    }

    /// One of yours waiting on the box back in the composer, with the files picked for it here.
    private func editOnBox(_ item: Transcript.Pending) {
        let written = yoursOnBox[item.id]
        removeFromBox(item)
        restoreDraft(written?.text ?? item.text, files: written?.files ?? [])
    }

    /// While the queue is paused on a machine's box: what arrives there meanwhile shows as it comes
    /// (another agent's letter, a wake-up), as this Mac's box's queues do (`Workspace.followQueues`).
    private func followWhilePaused() {
        guard isQueuePaused else {
            queueFollow?.cancel()
            queueFollow = nil
            return
        }
        guard queueFollow == nil, let box = box(), box.box != BoxClient.mac else { return }
        struct Listed: Decodable { var queues: [String: BoxQueue] }
        let id = id
        queueFollow = Task { [weak self] in
            do {
                for try await line in box.follow("kuvo/sessions/queues/events") {
                    guard let self, !Task.isCancelled else { return }
                    guard let listed = try? JSONDecoder().decode(Listed.self, from: line) else { continue }
                    let queue = listed.queues[id]
                    takeQueue(paused: queue?.paused ?? false, held: queue?.held ?? [], waiting: queue?.waiting ?? [])
                }
            } catch {}
            self?.queueFollow = nil
        }
    }

    /// The queue read again from the box, `after` a moment (what it does on an event comes then);
    /// on a box that doesn't carry it, what `moment` does here (`carryHere`).
    private func readQueue(after delay: Duration = .zero, then moment: QueueMoment = .other) {
        queueRead?.cancel()
        queueRead = Task {
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            guard await carriesQueue() else { return carryHere(moment) }
            await queueRoute("queue", method: "GET")
        }
    }

    /// Whether its box carries the queue: this Mac's does, and a machine's says so (`queue` in its
    /// `kuvo/info`). One whose update to this version didn't get through doesn't: this Mac carries
    /// its queue then, as it did before (`carryHere`). True when it can't be read: its routes say why.
    private func carriesQueue() async -> Bool {
        if let boxCarriesQueue { return boxCarriesQueue }
        guard let box = box() else { return true }
        guard box.box != BoxClient.mac else {
            boxCarriesQueue = true
            return true
        }
        let features = await boxFeatures()
        guard !features.isEmpty else { return true }
        boxCarriesQueue = features.contains("queue")
        return boxCarriesQueue ?? true
    }

    /// What its box answers (`kuvo/info`'s `features`), once read; this Mac's has all of them.
    @ObservationIgnored private var readFeatures: Set<String>?
    /// Whether its box answers `feature` (`kuvo/info`'s `features`); this Mac's answers them all.
    func boxHas(_ feature: String) async -> Bool {
        guard let box = box() else { return false }
        guard box.box != BoxClient.mac else { return true }
        return await boxFeatures().contains(feature)
    }

    private func boxFeatures() async -> Set<String> {
        if let readFeatures { return readFeatures }
        guard let box = box() else { return [] }
        if box.box == BoxClient.mac { return ["queue", "queue.waits"] }
        struct Info: Decodable { var features: [String]? }
        guard let info = try? await box.value(Info.self, "GET", "kuvo/info") else { return [] }
        readFeatures = Set(info.features ?? [])
        return readFeatures ?? []
    }

    // A box that doesn't carry the queue: this Mac carries it, as before. Once a run ends, a moment
    // later, the next one goes; a failed run pauses it, holding what was for the next step; a queue
    // found waiting as the session opens waits for Resume, and goes on when read again later.

    /// What happened, as the queue a Mac carries reads it.
    private enum QueueMoment {
        /// The session read as it opens, or again later.
        case opened, read
        /// A run that ended (well, or stopped), or failed.
        case runEnded, runFailed
        /// A message queued.
        case queued
        case other
    }

    /// What `moment` does to the queue here.
    private func carryHere(_ moment: QueueMoment) {
        switch moment {
        case .runEnded, .read:
            if !transcript.isRunning, !transcript.pending.isEmpty { drainHere() }
        case .runFailed:
            Task { await holdHere() }
        case .queued:
            // Queued while nothing runs: the engine waits for a run to end, so it's nudged.
            if !transcript.isRunning, hasQueue { drainHere() }
        case .opened:
            // Left waiting (the app quit mid-run, say): it waits for Resume, what was for the next
            // step held ahead of it.
            if !transcript.isRunning, !transcript.pending.filter({ !$0.isLocal }).isEmpty { Task { await holdHere() } }
        case .other:
            break
        }
    }

    /// What's for the agent's next step moved to the queue, ahead of it, and the queue paused:
    /// before a Stop, after a failed run. (One whose request is on its way: see `requestDone`.)
    private func holdHere() async {
        drainTask?.cancel()
        let steering = transcript.pending.filter { $0.delivery == .steer && !$0.isLocal && outgoing[$0.id]?.request == nil }
        if hasQueue || !steering.isEmpty { isQueuePaused = true }
        let first = (outgoing.values.compactMap(\.heldAt).min() ?? 0) - steering.count
        for (index, item) in steering.enumerated() {
            outgoing[item.id, default: Outgoing(state: .waiting, isOurs: false)].heldAt = first + index
            try? await api.setDelivery(session: id, item: item.id, delivery: .queue)
        }
    }

    /// The next waiting message, `after` a moment, unless the queue's paused or a run started
    /// meanwhile: a queued one steered in (which starts a run), one for the next step by resuming.
    private func drainHere(after delay: Duration = .seconds(1.5)) {
        drainTask?.cancel()
        drainTask = Task {
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, !isQueuePaused, !transcript.isRunning,
                  let next = waiting.first(where: { !$0.isLocal }) ?? transcript.pending.first(where: { !$0.isLocal }) else { return }
            if next.delivery == .queue {
                try? await api.setDelivery(session: id, item: next.id, delivery: .steer)
            } else {
                try? await api.interrupt(session: id, resume: true)
            }
        }
    }

    func cancelPending(_ item: Transcript.Pending) {
        guard canReach else { return }
        if isOnBox(item) { return removeFromBox(item) }
        guard item.isLocal else {
            Task { try? await api.cancelInbox(session: id, item: item.id) }
            return
        }
        // On its way: it doesn't go (see `send`), or it's taken back as the engine has it (see
        // `requestDone`); one the engine has already, before its word of it came, now.
        let isThere = outgoing[item.id]?.state == .waiting
        move(item.id, to: .cancelled)
        editTranscript { $0.removeLocal(id: item.id) }
        if isThere { Task { try? await api.cancelInbox(session: id, item: item.id) } }
    }

    #if DEBUG
    /// KUVO_DEMO_WAITING: messages shown waiting, without sending them; `onBox`, what came while it
    /// was stopped (KUVO_DEMO_WAITING_FROM), paused.
    func showWaiting(_ items: [Transcript.Pending], onBox: [BoxQueue.Waiting] = []) {
        editTranscript { $0.pending = items }
        if !onBox.isEmpty {
            demoOnBox = onBox
            takeQueue(paused: true, held: [])
        }
    }
    @ObservationIgnored private var demoOnBox: [BoxQueue.Waiting]?
    #endif

    /// Steers a queued message in: the agent takes it at its next step, without waiting for the
    /// run to end (and without stopping the step it's on).
    func steer(_ item: Transcript.Pending) {
        // One waiting on the box goes as Send Now sends it.
        if isOnBox(item) { return sendNow(item) }
        guard canReach, !item.isLocal, item.delivery == .queue else { return }
        Analytics.shared.track("message_steered")
        Task {
            do {
                try await api.setDelivery(session: id, item: item.id, delivery: .steer)
            } catch {
                fail(error)
            }
        }
    }

    /// Gives a waiting message to the agent right away: its current step stops, and it carries
    /// on from there with this message.
    func sendNow(_ item: Transcript.Pending) {
        guard canReach else { return }
        Analytics.shared.track("message_sent_now")
        guard !item.isLocal else { return }
        isQueuePaused = false
        let running = transcript.isRunning
        Task {
            guard await carriesQueue() else {
                // Steering wakes an idle session; a running one gets it once the step stops.
                do {
                    if item.delivery == .queue { try await api.setDelivery(session: id, item: item.id, delivery: .steer) }
                    if running || item.delivery == .steer { try await api.interrupt(session: id, resume: true) }
                } catch {
                    fail(error)
                }
                return
            }
            guard await queueRoute("queue/\(item.id)/now") == nil else { return }
            // Not reached (or it went meanwhile): as it was.
            readQueue()
            failure = "It couldn't be sent now. Try again in a moment."
        }
    }

    /// Takes a waiting message back into the composer, with its files and comments, ahead of
    /// anything already there.
    func edit(_ item: Transcript.Pending) {
        guard canReach else { return }
        // (Only yours: another's letter isn't yours to rewrite.)
        if isOnBox(item) { return sender(of: item) == nil ? editOnBox(item) : () }
        guard !item.isLocal, outgoing[item.id]?.state != .takingBack else { return }
        if outgoing[item.id] == nil { outgoing[item.id] = Outgoing(state: .waiting, isOurs: false) }
        move(item.id, to: .takingBack)
        Task {
            do {
                try await api.cancelInbox(session: id, item: item.id)
            } catch {
                // Still waiting, unless its word came meanwhile.
                if outgoing[item.id]?.state == .takingBack { move(item.id, to: .waiting) }
                fail(error)
                return
            }
            // The engine says which won: the cancel, or the agent taking it first (a cancel
            // that comes too late changes nothing, and says nothing).
            // Waited for while it's still waiting (thirty seconds at most): a slow answer isn't a lost
            // message.
            await wait(for: item.id, until: .now + .seconds(30)) { $0.state == .takingBack }
            // No word at all (its events lost, a machine's feed dropped): the engine's queue and
            // conversation say, so the text isn't lost.
            if outgoing[item.id]?.state == .takingBack {
                let queued = try? await api.inbox(session: id), recent = try? await api.messages(session: id, limit: 40).data
                // Unless its word came meanwhile, which says.
                if outgoing[item.id]?.state == .takingBack {
                    if let queued, let recent {
                        move(item.id, to: queued.contains { $0.id == item.id } ? .waiting : recent.contains { $0.id == item.id } ? .delivered : .cancelled)
                    } else {
                        move(item.id, to: .waiting)
                    }
                }
            }
            guard outgoing[item.id]?.state == .cancelled else { return }
            restoreDraft(item.text, files: item.files + Attachments.writeCarried(item.inlineFiles))
        }
    }

    /// Puts a message back in the composer, ahead of anything already there: its text, its
    /// attached files (each once, and only those on this Mac), its comments on the changes and
    /// what it replied to; a goal as one (`SentWithKeyword.draft`), into an empty composer: beside
    /// your words, "/goal" in front would make them the goal too. Returns the text it put.
    @discardableResult private func restoreDraft(_ message: String, files picked: [URL] = []) -> String {
        let (quoted, comments, paths, _) = SentMessage.split(message)
        let (quotes, words) = Quoting.draft(of: quoted)
        let text = draftText.isEmpty ? SentWithKeyword.draft(words, keyword: SentMessage.keyword(of: message)) : words
        restore(text: text, files: Attachments.restored(picked, noting: paths), quotes: quotes, comments: comments)
        if text != words { restoredGoal = text }
        return text
    }

    /// A goal put back in the composer, as it was put: kept until the composer is sent, as Redo
    /// can bring it back after something went ahead of it.
    @ObservationIgnored private var restoredGoal = ""

    /// The text of sends that didn't go, put back at the start of the composer one after another.
    @ObservationIgnored private var restoredFailed = ""

    private func restoreFailed(text: String, files: [URL], quotes: [Drafts.Quote], comments: [ReviewComment]) {
        guard !restoredFailed.isEmpty, draftText == restoredFailed || draftText.hasPrefix(restoredFailed + "\n\n") else {
            restore(text: text, files: files, quotes: quotes, comments: comments)
            restoredFailed = text
            return
        }
        // After the ones before it.
        let rest = String(draftText.dropFirst(restoredFailed.count))
        restoredFailed = [restoredFailed, text].filter { !$0.isEmpty }.joined(separator: "\n\n")
        draftText = restoredFailed + rest
        draftFiles += files.filter { file in !draftFiles.contains { $0.path == file.path } }
        draftQuotes += quotes
        reviewComments += comments
        composerFocus += 1
    }

    /// Puts these in the composer, ahead of anything already there.
    private func restore(text: String, files: [URL] = [], quotes: [Drafts.Quote] = [], comments: [ReviewComment] = []) {
        if !text.isEmpty { dropRestoredGoal() }
        draftQuotes = quotes + draftQuotes
        draftText = [text, draftText].filter { !$0.isEmpty }.joined(separator: "\n\n")
        draftFiles = files + draftFiles.filter { file in !files.contains { $0.path == file.path } }
        reviewComments = comments + reviewComments
        composerFocus += 1
    }

    /// What was written for a keyword that couldn't be done ("/goal …", "/loop …") put back: as
    /// written into an empty composer, ready to send again (a goal kept one, as `restoreDraft`
    /// keeps it); beside words typed meanwhile, its words alone in front of them, which the
    /// keyword would take in. A goal's pause, resume or clear has no words of yours to put back
    /// there ("pause" would go as a message): the failure says it didn't happen.
    private func restoreWritten(_ written: String, files: [URL] = []) {
        let goal = GoalCommand(written)
        let isSet = if case .set = goal { true } else { false }
        guard !draftText.isEmpty, let (_, words) = Keyword.parse(written) else {
            restore(text: written, files: files)
            if isSet { restoredGoal = written }
            return
        }
        restore(text: goal == nil || isSet ? words : "", files: files)
    }

    /// A goal put back (Undo, Edit), still at the composer's start as it was put, goes on as its
    /// words once something is put ahead of it: "/goal" in the middle would go as plain words. One
    /// you typed stays as you wrote it.
    private func dropRestoredGoal() {
        guard !restoredGoal.isEmpty, draftText == restoredGoal || draftText.hasPrefix(restoredGoal + "\n\n") else { return }
        draftText.removeFirst("/goal ".count)
    }

    /// What was in the composer before an undo, and after it: Redo puts the first back if the
    /// second is still there untouched.
    private struct ComposerState: Equatable {
        var text: String
        var files: [URL]
        var comments: [ReviewComment]
        var quotes: [Drafts.Quote]
    }

    private var composerState: ComposerState {
        get { ComposerState(text: draftText, files: draftFiles, comments: reviewComments, quotes: draftQuotes) }
        set {
            draftText = newValue.text
            draftFiles = newValue.files
            reviewComments = newValue.comments
            draftQuotes = newValue.quotes
        }
    }

    private var undone: (before: ComposerState, after: ComposerState, put: String)?

    /// A sent message's attached files that are still on this Mac, and those it carries in
    /// itself, written out.
    static func files(of message: Message.User) -> [URL] {
        let files = message.files ?? []
        return files.compactMap { file in
            guard let url = file.fileURL, FileManager.default.fileExists(atPath: url.path) else { return nil }
            return url
        } + Attachments.writeCarried(files)
    }

    /// The same, as they were picked when the message was seen going out, else as the engine
    /// keeps them (`stored`): it has converted copies, or, from a machine, none on this Mac.
    static func files(of message: Message.User, stored: Message.User) -> [URL] {
        let picked = files(of: message)
        return picked.isEmpty ? files(of: stored) : picked
    }

    /// The engine's copy of a message, with its attachments as the engine keeps them.
    private func stored(_ message: Message.User) async -> Message.User {
        let recent = (try? await api.messages(session: id, limit: 100).data) ?? []
        for case .user(let user) in recent where user.id == message.id { return user }
        return message
    }

    /// Takes the session back to before `message`: the agent stops, the conversation and the
    /// files it changed since go back, and the message returns to the composer to edit or
    /// send again. Redo brings it all back, until the next message makes it final.
    func undo(from message: Message.User) {
        guard canReach else { return }
        Analytics.shared.track("undo_used")
        Task {
            do {
                if isRunning {
                    await holdQueue()
                    try await api.interrupt(session: id)
                    try await api.wait(session: id)
                }
                let copy = await stored(message)
                session.revert = try await api.stageRevert(session: id, messageID: copy.id)
                // Undone further back before Redo: Redo takes them all back, so it puts back the
                // composer as it was before the first undo (with each undo's text gone, rather
                // than left to be sent again). Written in since the last undo, it's yours: Redo
                // puts it back as it is now, as it would have left it, less the last undo's text
                // if that's still at its start as it was put there.
                let now = composerState
                var before = now
                if let undone, undone.after == now {
                    before = undone.before
                } else if let undone, !undone.put.isEmpty, now.text == undone.put || now.text.hasPrefix(undone.put + "\n\n") {
                    before.text = String(now.text.dropFirst(min(now.text.count, undone.put.count + 2)))
                }
                // The text this undo put ahead of what was there.
                let put = restoreDraft(CommandMessages.shared.text(of: copy), files: Self.files(of: message, stored: copy))
                let after = composerState
                undone = (before, after, put)
            } catch {
                fail(error)
            }
        }
    }

    /// Sends a message again after its run failed. Its turn is taken back first, so the
    /// conversation reads as if it had gone through the first time.
    func retry(_ message: Message.User) {
        guard canReach else { return }
        guard !isRunning, !isRetrying else { return }
        isRetrying = true
        Task {
            defer { isRetrying = false }
            var sentID: String?
            var user = message
            do {
                try Moves.checkNotMoving(self.id)
                user = await stored(message)
                // Each as the engine kept it: by where it is, or (sent inline: a machine's, a photo
                // from the phone) with what's in it.
                let files = (user.files ?? []).compactMap { file -> OpenCodeAPI.PromptFile? in
                    if case .uri(let uri) = file.source { return .init(uri: uri, name: file.name) }
                    guard let data = file.data else { return nil }
                    return .init(uri: "data:\(file.mime);base64,\(data)", name: file.name)
                }
                if !transcript.messages.summarized(since: user.id) { _ = try await api.stageRevert(session: id, messageID: user.id) }
                if let command = CommandMessages.shared[user.id], let (name, arguments) = SlashCommands.split(command) {
                    runCommand(name, arguments: arguments, files: Self.files(of: user))
                    return
                }
                let id = Identifier.message()
                sentID = id
                outgoing[id] = Outgoing(state: .sending, request: .steer, isOurs: true, startsRun: true)
                editTranscript { $0.addLocal(id: id, text: user.text, delivery: .steer) }
                try await api.prompt(session: self.id, id: id, text: user.text, files: files)
                await requestDone(id)
            } catch {
                // Its turn was taken back, and it didn't go again: back in the composer, as a
                // message that couldn't be sent is.
                if let id = sentID {
                    update(id) {
                        $0.state = .cancelled
                        $0.request = nil
                    }
                    editTranscript { $0.removeLocal(id: id) }
                    restoreDraft(user.text, files: Self.files(of: user))
                }
                fail(error)
            }
        }
    }

    /// A message after an undo makes it final: the undone part goes now, in the same moment the
    /// message appears, rather than as the engine's word of it comes in.
    private func commitUndo() {
        guard let revert = session.revert else { return }
        editTranscript { $0.commitRevert(to: revert.messageID) }
        session.revert = nil
        undone = nil
    }

    /// Takes back an undo: the conversation and the files come back as they were.
    func redo() {
        guard canReach else { return }
        Analytics.shared.track("redo_used")
        Task {
            do {
                try await api.clearRevert(session: id)
                session.revert = nil
                if let undone, composerState == undone.after { composerState = undone.before }
                undone = nil
            } catch {
                fail(error)
            }
        }
    }

    /// Says what went wrong, over the composer; not a request that was called off (the engine
    /// started over meanwhile, say), which isn't something that went wrong: shown, it said only
    /// "cancelled", the next time you opened the conversation.
    private func fail(_ error: any Error) {
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
        failure = error.localizedDescription
    }

    /// Edits the message that would go last, if there is one.
    @discardableResult
    func editLast() -> Bool {
        guard canReach else { return false }
        guard let item = waiting.last(where: { !$0.isLocal && outgoing[$0.id]?.state != .takingBack }) else { return false }
        edit(item)
        return true
    }

    /// After Plan mode's answer: switches to Build, then has the agent carry the plan out.
    func buildPlan() {
        guard canReach else { return }
        session.agent = "build"
        Task {
            do { try await api.selectAgent(session: id, agent: "build") } catch {
                fail(error)
                return
            }
            send("Go ahead and build it, as planned.", for: nil, withComments: false)
        }
    }

    /// Summarizes the conversation so far, to make room in the context window.
    func compact() {
        guard canReach else { return }
        Task {
            do { try await api.compact(session: id) } catch { fail(error) }
        }
    }

    /// Picks the queue up again after Stop or a failed run: its box starts the next one. Its
    /// answer: false when its computer didn't answer (the conversation says so).
    @discardableResult
    func resumeQueue() -> Task<Bool, Never> {
        guard canReach else { return Task { false } }
        isQueuePaused = false
        let stopped = stops
        let puttingBack = puttingBack.values
        return Task {
            // A message held as it went (put back after a Stop) held by the box first: its hold
            // after the Resume would pause the queue again. One Undo is putting back there too: the
            // queue going on without it, it would go to the agent as it arrived, at once. Stopped
            // meanwhile: no Resume.
            let holding = outgoing.values.contains(where: { $0.heldAt != nil && ($0.state == .sending || $0.request != nil) })
            if holding || !puttingBack.isEmpty {
                if holding { await sending?.value }
                for each in puttingBack { await each.value }
                guard stops == stopped else { return true }
            }
            guard await carriesQueue() else {
                drainHere(after: .zero)
                return true
            }
            guard await queueRoute("queue/resume") == nil else { return true }
            isQueuePaused = true
            failure = "The queue couldn't be resumed: its computer didn't answer. Try again in a moment."
            return false
        }
    }

    func selectModel(_ model: ModelRef) {
        guard canReach else { return }
        // (One that's the model already on, by another name, is the same: a session on Claude Code's `default`.)
        let isSame = catalog().map { $0.isSameModel(model, session.model) } ?? model.sameModel(as: session.model)
        guard !isSame || model.variant != session.model?.variant else { return }
        // Another model while it works: the step under way stops and the run goes on with the new
        // one at once (or says why it can't), rather than the switch waiting for the next step,
        // which a stalled step never reaches. Not while it waits on you: that would lose the ask.
        // A subagent's model changes from its next step: stopping its step, even to resume, ends
        // the wait of the agent that started it, which then gives up on it.
        let switchesNow = !isSubagent && transcript.isRunning && !isSame && permissions.isEmpty && forms.isEmpty
        let previous = session.model
        session.model = model
        Task {
            do {
                do {
                    try await api.selectModel(session: id, model: model)
                } catch {
                    // Not switched: the picker shows the model it still has.
                    if session.model == model { session.model = previous }
                    throw error
                }
                // The note starts a turn of its own: only when there was a run to stop, as there
                // may not be by now (it ended while the model was being set); and not if it has
                // asked you something meanwhile.
                if switchesNow, permissions.isEmpty, forms.isEmpty, try await api.interrupt(session: id) {
                    try await api.addSynthetic(session: id, text: Self.switchedModelNote)
                }
            } catch {
                fail(error)
            }
        }
    }

    /// When the model was last heard, and how far this Mac's clock is ahead of the engine's, as of
    /// now (new words move the first on without the conversation's rows being made again).
    func heard() -> (last: Milliseconds?, offset: Milliseconds) {
        (storedTranscript.lastHeard, storedTranscript.clockOffset)
    }

    /// What the agent hears when you switch its model mid-run (the conversation doesn't show it).
    static let switchedModelNote = "<system-reminder>The user switched the model while you were working. Carry on with the task from where you left off.</system-reminder>"

    var approval: ToolApproval { approvalShown?.approval ?? ToolApproval.of(session) }

    func failApproval(_ error: any Error) { fail(error) }

    /// Gives the agent the project's folders as they're set now, if it doesn't have them yet:
    /// allowed in its permissions, and named in its instructions.
    func syncFolders() async {
        // As the engine knows them: a machine's folders are plain paths there.
        let folders = projectFolders().map(api.enginePath)
        let machine = RemoteFolder.machine(of: session.location.directory)
        // Its computer's rules not known yet: once they are (they're read as it's reached).
        guard EngineConfig.knowsRules(on: machine) else { return }
        let current = session.permissions ?? []
        // Its folders only: its box makes the rest from its approval and Settings › Permissions,
        // and keeps these as it does.
        let rules = ProjectFolders.permissions(current, folders: folders)
        guard rules != current else { return }
        do {
            try await api.setPermissions(session: id, rules: rules)
            session.permissions = rules
            if folders.isEmpty {
                try await api.removeInstruction(session: id, key: ProjectFolders.instructionKey)
            } else {
                try await api.setInstruction(session: id, key: ProjectFolders.instructionKey, text: ProjectFolders.instructions(primary: api.enginePath(session.location.directory), folders: folders))
            }
        } catch {
            fail(error)
        }
    }

    /// Plan on, or off again: back to the agent a new session starts with (Build).
    func togglePlan() {
        selectAgent(session.agent == "plan" ? catalog()?.startingAgent(chosen: nil) ?? "build" : "plan")
    }

    func selectAgent(_ agent: String) {
        guard canReach else { return }
        guard agent != session.agent else { return }
        session.agent = agent
        Task {
            do { try await api.selectAgent(session: id, agent: agent) } catch { fail(error) }
        }
    }

    func reply(to request: PermissionRequest, _ decision: PermissionRequest.Decision, message: String? = nil) {
        guard canReach, answering.insert(request.id).inserted else { return }
        Analytics.shared.track("permission_answered", ["action": Analytics.action(request.action), "decision": decision.rawValue])
        Task {
            // In the session that asked: a subagent's own, for one of its asks shown here.
            do { try await api.reply(session: request.sessionID, permission: request.id, decision: decision, message: message) } catch {
                await answerFailed(request.id, error) { api in try await api.permissions(session: request.sessionID).contains { $0.id == request.id } }
            }
        }
    }

    /// An answer that didn't go: an ask gone meanwhile (answered elsewhere, its run ended) just
    /// goes; one still waiting says why, and can be answered again.
    private func answerFailed(_ ask: String, _ error: any Error, waits: (OpenCodeAPI) async throws -> Bool) async {
        // Answered once still, while it's read: it goes with the ask if it's gone.
        guard (try? await waits(api)) == false else {
            answering.remove(ask)
            return fail(error)
        }
        dropAsk(ask)
    }

    /// An ask no longer asked (answered elsewhere, or gone): its card goes, and it from the Dock.
    func dropAsk(_ ask: String) {
        transcript.permissions.removeAll { $0.id == ask }
        transcript.forms.removeAll { $0.id == ask }
        live?.permissions.removeAll { $0.id == ask }
        live?.forms.removeAll { $0.id == ask }
        askSettled(ask)
    }

    /// What some subagents ask now, read side by side; one that can't be read asks nothing here.
    /// What subagents ask, and those that couldn't be read.
    private static func asks(of helpers: Set<String>, api: OpenCodeAPI) async -> (permissions: [PermissionRequest], forms: [FormRequest], unread: Set<String>) {
        guard !helpers.isEmpty else { return ([], [], []) }
        return await withTaskGroup(of: (String, [PermissionRequest]?, [FormRequest]?).self) { group in
            for helper in helpers {
                group.addTask {
                    async let permissions = api.permissions(session: helper)
                    async let forms = api.forms(session: helper)
                    return (helper, try? await permissions, try? await forms)
                }
            }
            var all: (permissions: [PermissionRequest], forms: [FormRequest], unread: Set<String>) = ([], [], [])
            for await (helper, permissions, forms) in group {
                guard let permissions, let forms else {
                    all.unread.insert(helper)
                    continue
                }
                all.permissions += permissions
                all.forms += forms
            }
            return all
        }
    }

    /// Something a subagent of this conversation asks or settles (a permission, a question): it
    /// shows here, as nothing else shows a subagent's.
    func applyHelper(_ event: ServerEvent, from helper: String) {
        if !transcript.helpers.contains(helper) { transcript.helpers.insert(helper) }
        if live?.helpers.contains(helper) == false { live?.helpers.insert(helper) }
        // Its run ending: only what it asked goes, not this session's own run (and not from a
        // read under way, which may still have it).
        if Self.runEnds.contains(event.type) {
            for read in Array(cameDuringRead.keys) { cameDuringRead[read]?.append(event) }
            transcript.apply(event)
            live?.apply(event)
            return
        }
        apply(event)
    }

    static let runEnds: Set<String> = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]

    func answer(_ form: FormRequest, with answer: FormAnswer) {
        guard canReach, answering.insert(form.id).inserted else { return }
        Analytics.shared.track("question_answered", ["kind": form.isQuestion ? "question" : "form"])
        Task {
            do { try await api.reply(session: form.sessionID, form: form.id, answer: answer, directory: folder(of: form)) } catch {
                await answerFailed(form.id, error) { [folder = folder(of: form)] api in try await api.forms(session: form.sessionID, directory: folder).contains { $0.id == form.id } }
            }
        }
    }

    /// The folder an MCP server's form is filed under; nil for this session's own.
    private func folder(of form: FormRequest) -> String? {
        form.sessionID == FormRequest.anySession ? session.location.directory : nil
    }

    func dismiss(_ form: FormRequest, message: String? = nil) {
        guard canReach, answering.insert(form.id).inserted else { return }
        Analytics.shared.track("question_dismissed", ["kind": form.isQuestion ? "question" : "form"])
        Task {
            do { try await api.dismiss(session: form.sessionID, form: form.id, message: message, directory: folder(of: form)) } catch {
                await answerFailed(form.id, error) { [folder = folder(of: form)] api in try await api.forms(session: form.sessionID, directory: folder).contains { $0.id == form.id } }
            }
        }
    }

    // MARK: Background refreshes

    private func scheduleReload() {
        guard reloadTask == nil else { return }
        reloadTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            await load()
            reloadTask = nil
        }
    }

    private func refreshChanges() {
        guard !isSubagent else { return }
        changesTask?.cancel()
        changesTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, let diff = try? await api.diff(session: id) else { return }
            changes = diff
            let messages = transcript.messages, directory = session.location.directory
            let edits = diff.isEmpty ? await Task.detached { SessionEdits.files(in: messages, directory: directory) }.value : []
            if !Task.isCancelled, editedFiles != edits { editedFiles = edits }
        }
    }
}

extension OpenCodeAPI {
    /// Until the MCP servers of `directory` are connected (the engine connects them after it
    /// opens a folder; an integration's server can take a while the first time, as it's
    /// fetched), twenty seconds at most, and a moment more if they only just did: a message sent
    /// sooner reaches a model without their tools.
    /// Whether the engine answered.
    @discardableResult
    func waitForTools(in directory: String) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(20)
        // A folder it has only just opened lists no servers at first, for a moment, before they're
        // pending: none for a while more means it has none.
        let listed = ContinuousClock.now + .seconds(3)
        var waited = false
        while ContinuousClock.now < deadline {
            guard let servers = try? await mcpServers(directory: directory) else { return false }
            if servers.isEmpty, ContinuousClock.now < listed {
                waited = true
                try? await Task.sleep(for: .milliseconds(100))
                continue
            }
            if !servers.contains(where: { $0.status.status == "pending" }) {
                // Connected only just now: the engine takes a moment more to hand its tools out.
                if waited, !servers.isEmpty { try? await Task.sleep(for: .milliseconds(1500)) }
                return true
            }
            waited = true
            try? await Task.sleep(for: .milliseconds(250))
        }
        return true
    }
}

/// The reply being written, as its words stream in: the text the step under way ends in. Its view
/// watches this, so a few more words draw only it, not the conversation (see `SessionModel`).
@Observable
final class WritingBlock {
    /// Which text: its step, and where it is among the step's blocks.
    struct Key: Equatable {
        var step: String
        var part: Int
    }

    /// The text being written in a conversation, and its pieces as the conversation shows them
    /// (see `MarkdownChunks`).
    struct Writing {
        var key: Key
        /// Which of the step's texts it is, as the engine counts them.
        var ordinal: Int
        var text: String
        var pieces: [MarkdownChunks.Chunk]

        /// The row of its last piece, as `TranscriptView` names it.
        var pieceRow: String {
            key.step + "#\(key.part)" + (pieces.count == 1 ? "" : ".\(pieces.count - 1)")
        }

        /// The text being written in `transcript`: the last block of its last step, while that
        /// step is under way and the text has words.
        init?(in transcript: Transcript) {
            guard case .assistant(let step)? = transcript.messages.last, step.time.completed == nil,
                  case .text(let text)? = step.content.last,
                  text.text.contains(where: { !$0.isWhitespace }) else { return nil }
            key = Key(step: step.id, part: step.content.count - 1)
            ordinal = step.content.dropLast().filter { if case .text = $0 { true } else { false } }.count
            self.text = text.text
            pieces = MarkdownChunks.split(text.text, isWriting: true)
        }
    }

    private(set) var key: Key?
    /// All of it, as written so far.
    private(set) var text = ""
    /// The row of its last piece, and that piece's words.
    private(set) var pieceRow: String?
    private(set) var piece = ""
    @ObservationIgnored private var pieces: [MarkdownChunks.Chunk] = []

    func show(_ writing: Writing?) {
        if key != writing?.key { key = writing?.key }
        if pieceRow != writing?.pieceRow { pieceRow = writing?.pieceRow }
        let text = writing?.text ?? ""
        if self.text != text { self.text = text }
        let piece = writing?.pieces.last?.text ?? ""
        if self.piece != piece { self.piece = piece }
        pieces = writing?.pieces ?? []
    }

    /// `writing` is what shows already with more words at its end: the same text, in as many
    /// pieces, all but the last as they were.
    func onlyGrows(to writing: Writing) -> Bool {
        writing.key == key && writing.pieces.count == pieces.count && writing.pieces.dropLast() == pieces.dropLast()
    }

    /// The words of a row's text, as they are now, while it's the one being written: the last
    /// piece's row (`row`, in pieces), or the step's (`row`, with all its blocks) and its `part`.
    func text(row: String, part: Int) -> String? {
        if row == pieceRow { return piece }
        if let key, key.step == row, key.part == part { return text }
        return nil
    }
}
