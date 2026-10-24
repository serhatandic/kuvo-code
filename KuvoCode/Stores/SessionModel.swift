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
    /// The subagents' bar shows only its line, which still says they work.
    var hidesSubagents = false
    private(set) var forms: [FormRequest] = []
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
            let open = Set(forms.map(\.id))
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
                                        isBackground: input?["background"]?.bool == true, isStepDone: call.state.isFinished)
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
            if case .assistant(let assistant) = message, let tokens = assistant.tokens {
                return tokens.input + tokens.cache.read + tokens.cache.write + tokens.output
            }
        }
        return nil
    }
    private(set) var isLoaded = false
    /// Your answers to the agent's questions so far, by form: kept while you look elsewhere.
    var questionProgress: [String: QuestionProgress] = [:]
    /// Goes up when the agent asks something while the composer is empty: it lets go of the
    /// keyboard, for the question.
    private(set) var composerBlur = 0
    /// Showing the conversation as last seen (its machine is connecting, or this Mac's engine
    /// starting), not the engine's.
    private(set) var isCopy = false
    /// Made from a copy: no engine to read from until its machine is back.
    private(set) var waitsForEngine = false
    /// Whether its engine can be reached (a machine's is connected); set by the workspace.
    @ObservationIgnored var isReachable: () -> Bool = { true }
    /// What's done here waits while its engine can't be reached: it would only fail.
    private var canReach: Bool { !waitsForEngine && isReachable() }
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
        set { Drafts.shared[id].files = newValue }
    }

    /// What you're replying to, over the composer, each with your answer to it.
    var draftQuotes: [Drafts.Quote] {
        get { Drafts.shared[id].quotes }
        set {
            Drafts.shared[id].quotes = newValue
            Drafts.shared[id].quote = nil
        }
    }

    /// The quote whose answer takes the keyboard: the one just added.
    private(set) var quoteFocus: UUID?

    /// Messages you sent here, oldest first, for going back through with ↑.
    var sentMessages: [String] {
        var texts: [String] = []
        for message in transcript.messages {
            let text: String
            switch message {
            case .user(let user): text = SentMessage.words(of: CommandMessages.shared.text(of: user))
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

    /// A question came: the composer lets go of the keyboard for it, unless you're writing.
    func yieldComposer() {
        if draftText.isEmpty, draftQuotes.allSatisfy({ $0.response.isEmpty }) { composerBlur += 1 }
    }

    /// Replies to all of a message: it goes over the composer as a quote, to answer under.
    func reply(to text: String) {
        addQuote(text, how: "message")
    }

    /// Adds a quote to answer (all of a message, or a part you selected), after those there are,
    /// and its answer takes the keyboard.
    func addQuote(_ text: String, how: String) {
        let count = draftQuotes.count
        guard let id = Drafts.shared.addQuote(text, to: self.id) else { return }
        quoteFocus = id
        if draftQuotes.count > count { Analytics.shared.track("message_replied", ["how": how]) }
    }
    /// Queued messages wait for Resume: after Stop, a failed run, or when the app finds them
    /// waiting at launch.
    private(set) var isQueuePaused = false
    var failure: String?

    /// Its engine: a machine's changes with each connection to it.
    private var api: OpenCodeAPI
    private var reloadTask: Task<Void, Never>?
    /// Reads in a row that found nothing where the copy has a conversation.
    private var emptyReads = 0
    private var changesTask: Task<Void, Never>?
    private var drainTask: Task<Void, Never>?
    /// The last message on its way out; each waits for the one before, so the engine gets
    /// (and queues) them in the order they were written.
    private var sending: Task<Void, Never>?
    /// Messages sent from here, so a command's message can be told from them.
    private var sentIDs: Set<String> = []
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
    }

    var id: String { session.id }

    /// The agent and model the next message goes to.
    var agent: String { session.agent ?? "build" }

    /// Messages waiting for the agent, in the order it gets them: those for its next step, then
    /// the queue. A message sent while it's idle goes straight to the transcript instead, and
    /// stays there while the run it starts gets going.
    var waiting: [Transcript.Pending] {
        let pending = pending.filter { !starters.contains($0.id) }
        // What Stop held back was meant for the work under way: it stays ahead of the queue, and
        // shows while it's still on its way there too.
        let held = heldBack.compactMap { id in pending.first { $0.id == id } }
        let heldIDs = Set(held.map(\.id))
        let queued = pending.filter { $0.delivery == .queue && !heldIDs.contains($0.id) }
        return (isRunning ? pending.filter { $0.delivery == .steer && !heldIDs.contains($0.id) } : []) + held + queued
    }

    /// Messages for the agent's next step that Stop moved to the queue, in their order.
    @ObservationIgnored private var heldBack: [String] = []

    /// Messages sent while the agent was idle, until it has them: each starts a run, and the run
    /// begins a moment before the agent takes it, which isn't waiting.
    private var starters: Set<String> = []
    /// Messages cancelled while still on their way to the engine: they don't go, or are taken
    /// back if they went meanwhile.
    @ObservationIgnored private var cancelledLocal: Set<String> = []

    private var hasQueue: Bool { transcript.pending.contains { $0.delivery == .queue } }

    /// Running, or about to: a message for the next step starts a run as soon as it lands.
    private var isBusy: Bool { transcript.isRunning || transcript.pending.contains { $0.delivery == .steer } }

    /// Waiting messages being taken back for editing, and what the engine said about each:
    /// true when the cancel won, false when the agent got it first.
    private var editing: Set<String> = []
    private var settledEdits: [String: Bool] = [:]
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
            for event in cameDuringRead[read] ?? [] { fresh.apply(event) }
            // It has what streamed in so far.
            discardLive()
            transcript = fresh
            prepareCode(in: page.data)
            if transcript.isStale { scheduleReload() }
            // A queue left waiting (the app quit mid-run, say) waits for Resume rather than
            // starting on its own. Read again later (a reconnect), it carries on.
            // One for the next step of a run that ended with the app is held too, ahead of the
            // queue, as Stop holds one: it showed nowhere, and Resume went past it. Not one you've
            // just sent from here (as the session was read), nor while it's unknown whether the
            // engine runs it, mid-run on a machine say: the agent would miss it at its next step.
            let leftForNextStep = running != nil && transcript.pending.contains { $0.delivery == .steer && !$0.isLocal && !sentIDs.contains($0.id) }
            if !isLoaded, !isRunning, hasQueue || leftForNextStep {
                isQueuePaused = true
                if leftForNextStep { await holdWaiting() }
            } else if isLoaded, !isRunning, hasQueue, !isQueuePaused {
                scheduleDrain()
            }
            // A subagent's session is the engine's to set up; it only gets shown.
            if !isLoaded, !isSubagent { await syncFolders() }
            isLoaded = true
            isCopy = false
            keepCopy()
        } catch {
            fail(error)
            // Its machine is back but this one couldn't be read: no longer waiting, so the
            // failure shows (and what you do goes to the engine, which may answer now).
            if !waitsForEngine { isCopy = false }
        }
        refreshChanges()
    }

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
        case "session.execution.started":
            drainTask?.cancel()
        case "session.execution.succeeded", "session.execution.interrupted":
            scheduleDrain()
            keepCopy()
        case "session.execution.failed":
            // Don't run the rest of the queue into the same error; a message for its next step,
            // which won't come, waits in the queue with them (it would wait unseen otherwise).
            if hasQueue { isQueuePaused = true }
            if transcript.pending.contains(where: { $0.delivery == .steer }) { Task { await holdWaiting() } }
            keepCopy()
        case "session.inbox.enqueued":
            // Queued while nothing runs: the engine waits for a run to end, so nudge it.
            if !transcript.isRunning, !isQueuePaused, hasQueue { scheduleDrain() }
        case "session.inbox.cancelled", "session.inbox.delivered":
            if let id = try? event.payload(as: EventPayload.InboxChanged.self).inboxID {
                starters.remove(id)
                if editing.contains(id) { settledEdits[id] = event.type == "session.inbox.cancelled" }
            }
        case "session.revert.committed":
            // Final: there's nothing left to redo, and the conversation no longer ends at the undo.
            session.revert = nil
            undone = nil
        default:
            break
        }
        if transcript.pending.isEmpty { isQueuePaused = false }
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
    func send(_ text: String, files: [URL] = [], for model: Model?, queue: Bool = false, withComments: Bool = true) {
        let written = text
        let comments = withComments ? reviewComments : []
        // The agents named with "&" said who they are, then the comments.
        let named = AgentReferences.text(text.trimmingCharacters(in: .whitespacesAndNewlines), excluding: session.id, here: RemoteFolder.machine(of: session.location.directory))
        let text = ReviewComments.text(named, adding: comments)
        guard !text.isEmpty || !files.isEmpty else { return }
        if withComments { reviewComments = [] }
        let id = Identifier.message()
        sentIDs.insert(id)
        // With nothing running (or about to) and nothing queued, there's nothing to wait for.
        let delivery: InboxItem.Delivery = queue && (isBusy || hasQueue) ? .queue : .steer
        if delivery == .steer { isQueuePaused = false }
        if delivery == .steer, !isBusy { starters.insert(id) }
        commitUndo()
        editTranscript { $0.addLocal(id: id, text: text, delivery: delivery, files: files) }
        var props = Analytics.model(provider: model?.providerID ?? session.model?.providerID, model: model?.id ?? session.model?.id)
        props["mode"] = Analytics.mode(agent)
        props["queued"] = delivery == .queue
        props["files"] = !files.isEmpty
        props["comments"] = !comments.isEmpty
        Analytics.shared.track("message_sent", props)
        Analytics.shared.noteMessage(in: session.id, chars: text.count)
        Analytics.shared.messageSent(path: Self.place(of: session.location.directory))
        let previous = sending
        sending = Task {
            await previous?.value
            do {
                // Converting a photo takes a moment; keep it off the main thread. A machine's engine
                // can't read this Mac's files: they go to it inline, or copied there.
                let machine = RemoteFolder.machine(of: session.location.directory)
                let prepared = await Task.detached { machine.map { Attachments.prepare(files, for: model, machine: $0) } ?? Attachments.prepare(files, for: model) }.value
                let message = Attachments.text(text, for: prepared)
                await waitForTools()
                guard !wasCancelled(id) else {
                    holdOnArrival.remove(id)
                    return
                }
                // Moving to another computer: back in the composer, to send once it's there.
                if Moves.isFrozen(self.id) { throw Moves.Failure.moving }
                // Held while it was on its way: to the queue, not the next step.
                let held = holdOnArrival.remove(id) != nil
                let steering = !held && delivery == .steer
                if steering { steerInFlight.insert(id) }
                defer { steerInFlight.remove(id) }
                try await api.prompt(session: self.id, id: id, text: message, files: prepared.files, delivery: held ? .queue : delivery)
                restoredFailed = ""
                if steering { sentSteer.insert(id) }
                if wasCancelled(id) { try? await api.cancelInbox(session: self.id, item: id) }
                // Or held as it went: moved before Stop's wait ends (it waits on this).
                if !held, holdOnArrival.contains(id) {
                    try? await api.setDelivery(session: self.id, item: id, delivery: .queue)
                    holdOnArrival.remove(id)
                    sentSteer.remove(id)
                }
            } catch {
                editTranscript { $0.removeLocal(id: id) }
                // It didn't go: back in the composer as it was, ahead of anything written since
                // (after one sent before it that didn't go either, in the order they were sent).
                let (quotes, text) = Quoting.draft(of: written)
                restoreFailed(text: text, files: files, quotes: quotes, comments: comments)
                fail(error)
            }
        }
    }

    /// Once the messages on their way have gone to the engine, or come back to the composer.
    func messagesSent() async {
        await sending?.value
    }

    /// Sends the composer's draft as it is (its text, files and what it replies to), emptying it
    /// first: what can't be sent comes back to it. `unavailable`: why the session's model can't
    /// run (its account signed out of, `Catalog.unavailable`), said instead, the draft kept: the
    /// engine would take the message and drop it without a word. A "!" command needs no model.
    func submitDraft(for model: Model?, queue: Bool, commands: [Command], unavailable: String? = nil) {
        failure = nil
        if let unavailable, Self.shellCommand(in: draftText) == nil {
            failure = unavailable
            return
        }
        // A "!" or "/" command runs as typed; what you were replying to waits for a message.
        let isCommand = Self.shellCommand(in: draftText) != nil || SlashCommands.parse(draftText, commands: commands) != nil
        let text = isCommand ? draftText : Quoting.message(quotes: draftQuotes, text: draftText)
        let files = draftFiles
        draftText = ""
        draftFiles = []
        if !isCommand { draftQuotes = [] }
        submit(text, files: files, for: model, queue: queue, commands: commands)
    }

    /// Sends what's in the composer: a message, or a command for "/name arguments". What can't
    /// be sent goes back there.
    func submit(_ text: String, files: [URL], for model: Model?, queue: Bool, commands: [Command]) {
        sent += 1
        if let command = Self.shellCommand(in: text) {
            // A "!" command takes no files: they wait in the composer for a message.
            if !files.isEmpty { draftFiles = files + draftFiles.filter { file in !files.contains { $0.path == file.path } } }
            runShell(command, written: text)
        } else if let (name, arguments) = SlashCommands.parse(text, commands: commands) {
            runCommand(name, arguments: arguments, files: files, for: model, queue: queue, written: text)
        } else {
            send(text, files: files, for: model, queue: queue)
        }
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
                if Moves.isFrozen(id) { throw Moves.Failure.moving }
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
                let prepared = await Task.detached { machine.map { Attachments.prepare(files, for: model, machine: $0) } ?? Attachments.prepare(files, for: model) }.value
                if Moves.isFrozen(id) { throw Moves.Failure.moving }
                try await api.runCommand(session: id, name: name, arguments: Attachments.text(arguments, for: prepared), files: prepared.files, delivery: delivery)
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
                !running.before.contains($0.id) && !sentIDs.contains($0.id) && CommandMessages.shared[$0.id] == nil && $0.time.created >= since
            }
            guard let message else { return }
            CommandMessages.shared.note(message.id, command: running.command)
            runningCommands.removeFirst()
        }
    }

    /// Stops the agent. Waiting messages stay, queued and paused until Resume.
    func stop() {
        Task {
            await holdWaiting()
            // A held message whose request for the next step is already on its way: in before the
            // stop (ten seconds at most), so it can't land after it on an idle session and start
            // the agent again. One not sent yet goes to the queue anyway (see `send`).
            for _ in 0..<100 where !holdOnArrival.isDisjoint(with: steerInFlight) {
                try? await Task.sleep(for: .milliseconds(100))
            }
            try? await api.interrupt(session: id)
        }
    }

    /// What's waiting, held where it is (paused) before the session is stopped from elsewhere: it
    /// isn't started as the run ends (moving the session to a coding agent carries it over).
    func holdQueue() async {
        await holdWaiting()
    }

    /// Before an interrupt: what's waiting stays where it is, paused, instead of being handed
    /// over as the step ends or started by the nudge after it.
    private func holdWaiting() async {
        drainTask?.cancel()
        let steering = transcript.pending.filter { $0.delivery == .steer && !$0.isLocal }
        // Ones still on their way go to the queue as they arrive (see `send`); one already there,
        // not yet shown as there, is moved here.
        let arriving = transcript.pending.filter { $0.delivery == .steer && $0.isLocal && !starters.contains($0.id) }
        let arrived = arriving.filter { sentSteer.contains($0.id) }
        holdOnArrival.formUnion(arriving.filter { !sentSteer.contains($0.id) }.map(\.id))
        for item in arrived {
            sentSteer.remove(item.id)
            try? await api.setDelivery(session: id, item: item.id, delivery: .queue)
        }
        sentSteer.formIntersection(transcript.pending.filter(\.isLocal).map(\.id))
        if hasQueue || !steering.isEmpty || !arriving.isEmpty { isQueuePaused = true }
        let newlyHeld = (steering + arriving).map(\.id)
        heldBack = newlyHeld + heldBack.filter { id in !newlyHeld.contains(id) && transcript.pending.contains { $0.id == id } }
        for item in steering { try? await api.setDelivery(session: id, item: item.id, delivery: .queue) }
    }

    /// Messages for the agent's next step still on their way when Stop (or Undo) held the others:
    /// they go to the queue too, rather than starting it again.
    @ObservationIgnored private var holdOnArrival: Set<String> = []
    /// Messages for the next step whose request is on its way to the engine now, and those whose
    /// request went but that aren't shown as the engine's yet.
    @ObservationIgnored private var steerInFlight: Set<String> = []
    @ObservationIgnored private var sentSteer: Set<String> = []

    /// Whether a message on its way was cancelled meanwhile (and forgets it).
    private func wasCancelled(_ id: String) -> Bool {
        guard cancelledLocal.contains(id) else { return false }
        cancelledLocal.remove(id)
        starters.remove(id)
        return true
    }

    func cancelPending(_ item: Transcript.Pending) {
        guard canReach else { return }
        if item.isLocal {
            cancelledLocal.insert(item.id)
            editTranscript { $0.removeLocal(id: item.id) }
            return
        }
        Task { try? await api.cancelInbox(session: id, item: item.id) }
    }

    #if DEBUG
    /// KUVO_DEMO_WAITING: messages shown waiting, without sending them.
    func showWaiting(_ items: [Transcript.Pending]) {
        editTranscript { $0.pending = items }
    }
    #endif

    /// Steers a queued message in: the agent takes it at its next step, without waiting for the
    /// run to end (and without stopping the step it's on).
    func steer(_ item: Transcript.Pending) {
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
            do {
                // Steering wakes an idle session; a running one gets it once the step stops.
                if item.delivery == .queue { try await api.setDelivery(session: id, item: item.id, delivery: .steer) }
                if running || item.delivery == .steer { try await api.interrupt(session: id, resume: true) }
            } catch {
                fail(error)
            }
        }
    }

    /// Takes a waiting message back into the composer, with its files and comments, ahead of
    /// anything already there.
    func edit(_ item: Transcript.Pending) {
        guard canReach else { return }
        guard !item.isLocal, !editing.contains(item.id) else { return }
        editing.insert(item.id)
        Task {
            defer {
                editing.remove(item.id)
                settledEdits[item.id] = nil
            }
            do {
                try await api.cancelInbox(session: id, item: item.id)
            } catch {
                fail(error)
                return
            }
            // The engine says which won: the cancel, or the agent taking it first (a cancel
            // that comes too late changes nothing, and says nothing).
            // Waited for while it's still waiting (thirty seconds at most): a slow answer isn't a lost
            // message.
            for _ in 0..<600 where settledEdits[item.id] == nil && transcript.pending.contains(where: { $0.id == item.id }) {
                try? await Task.sleep(for: .milliseconds(50))
            }
            var cancelled = settledEdits[item.id] ?? (!transcript.pending.contains { $0.id == item.id } && !transcript.messages.contains { $0.id == item.id })
            // No word at all (its events lost, a machine's feed dropped): the engine's queue and
            // conversation say, so the text isn't lost.
            if settledEdits[item.id] == nil, !cancelled, let queued = try? await api.inbox(session: id),
               let recent = try? await api.messages(session: id, limit: 40).data {
                cancelled = !queued.contains { $0.id == item.id } && !recent.contains { $0.id == item.id }
            }
            guard cancelled else { return }
            restoreDraft(item.text, files: item.files)
        }
    }

    /// Puts a message back in the composer, ahead of anything already there: its text, its
    /// attached files (each once, and only those on this Mac), its comments on the changes and
    /// what it replied to.
    private func restoreDraft(_ message: String, files picked: [URL] = []) {
        let (quoted, comments, paths, _) = SentMessage.split(message)
        let (quotes, text) = Quoting.draft(of: quoted)
        restore(text: text, files: Attachments.restored(picked, noting: paths), quotes: quotes, comments: comments)
    }

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
        draftQuotes = quotes + draftQuotes
        draftText = [text, draftText].filter { !$0.isEmpty }.joined(separator: "\n\n")
        draftFiles = files + draftFiles.filter { file in !files.contains { $0.path == file.path } }
        reviewComments = comments + reviewComments
        composerFocus += 1
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

    /// A sent message's attached files that are still on this Mac.
    static func files(of message: Message.User) -> [URL] {
        (message.files ?? []).compactMap { file in
            guard case .uri(let uri) = file.source, let url = URL(string: uri), url.isFileURL,
                  FileManager.default.fileExists(atPath: url.path) else { return nil }
            return url
        }
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
                    await holdWaiting()
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
                restoreDraft(CommandMessages.shared.text(of: copy), files: Self.files(of: message, stored: copy))
                let after = composerState
                // The text this undo put ahead of what was there.
                let put = after.text == now.text ? "" : now.text.isEmpty ? after.text : String(after.text.dropLast(now.text.count + 2))
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
                if Moves.isFrozen(self.id) { throw Moves.Failure.moving }
                user = await stored(message)
                // Each as the engine kept it: by where it is, or (sent inline: a machine's, a photo
                // from the phone) with what's in it.
                let files = (user.files ?? []).compactMap { file -> OpenCodeAPI.PromptFile? in
                    if case .uri(let uri) = file.source { return .init(uri: uri, name: file.name) }
                    guard let data = file.data else { return nil }
                    return .init(uri: "data:\(file.mime);base64,\(data)", name: file.name)
                }
                _ = try await api.stageRevert(session: id, messageID: user.id)
                if let command = CommandMessages.shared[user.id], let (name, arguments) = SlashCommands.split(command) {
                    runCommand(name, arguments: arguments, files: Self.files(of: user))
                    return
                }
                let id = Identifier.message()
                sentID = id
                sentIDs.insert(id)
                starters.insert(id)
                editTranscript { $0.addLocal(id: id, text: user.text, delivery: .steer) }
                try await api.prompt(session: self.id, id: id, text: user.text, files: files)
            } catch {
                // Its turn was taken back, and it didn't go again: back in the composer, as a
                // message that couldn't be sent is.
                if let id = sentID {
                    editTranscript { $0.removeLocal(id: id) }
                    starters.remove(id)
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
        guard let item = waiting.last(where: { !$0.isLocal && !editing.contains($0.id) }) else { return false }
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

    /// Picks the queue up again after Stop or a failed run.
    func resumeQueue() {
        guard canReach else { return }
        isQueuePaused = false
        scheduleDrain(after: .zero)
    }

    /// The engine starts each queued message after a run that ends normally, but not after an
    /// interrupt (Stop, or Send Now) or when its run is woken by steering. So once the agent has
    /// been idle a moment, the next waiting message gets a nudge.
    private func scheduleDrain(after delay: Duration = .seconds(1.5)) {
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

    func selectModel(_ model: ModelRef) {
        guard canReach else { return }
        guard !model.sameModel(as: session.model) || model.variant != session.model?.variant else { return }
        // Another model while it works: the step under way stops and the run goes on with the new
        // one at once (or says why it can't), rather than the switch waiting for the next step,
        // which a stalled step never reaches. Not while it waits on you: that would lose the ask.
        // A subagent's model changes from its next step: stopping its step, even to resume, ends
        // the wait of the agent that started it, which then gives up on it.
        let switchesNow = !isSubagent && transcript.isRunning && !model.sameModel(as: session.model) && permissions.isEmpty && forms.isEmpty
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

    var approval: ToolApproval { ToolApproval(rules: session.permissions) }

    func setApproval(_ approval: ToolApproval) {
        guard canReach else { return }
        // The rules for particular things (the project's folders, a bot's folder and its
        // wake-ups) stay, after the approval rules and what Settings › Permissions asks of them.
        let settings = EngineConfig.rules(on: RemoteFolder.machine(of: session.location.directory))
        let rules = approval.rules(settings: settings) + (session.permissions ?? []).filter(ToolApproval.isParticular)
        session.permissions = rules
        Task {
            do { try await api.setPermissions(session: id, rules: rules) } catch { fail(error) }
        }
    }

    /// Gives the agent the project's folders as they're set now, if it doesn't have them yet:
    /// allowed in its permissions, and named in its instructions.
    func syncFolders() async {
        // As the engine knows them: a machine's folders are plain paths there.
        let folders = projectFolders().map(api.enginePath)
        let machine = RemoteFolder.machine(of: session.location.directory)
        // Its computer's rules not known yet: once they are (they're read as it's reached).
        guard EngineConfig.knowsRules(on: machine) else { return }
        var current = session.permissions ?? []
        // Its approval with Settings › Permissions as they are now on its computer, too.
        var rules = ProjectFolders.permissions(ToolApproval.refreshed(current, settings: EngineConfig.rules(on: machine)), folders: folders)
        guard rules != current else { return }
        do {
            try await api.setPermissions(session: id, rules: rules)
            // An approval picked while that went (its own rules sent too): again, from it, so the
            // last word is yours with the folders, not these from before it.
            for _ in 0..<3 where (session.permissions ?? []) != current {
                current = session.permissions ?? []
                rules = ProjectFolders.permissions(ToolApproval.refreshed(current, settings: EngineConfig.rules(on: machine)), folders: folders)
                try await api.setPermissions(session: id, rules: rules)
            }
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

    func selectAgent(_ agent: String) {
        guard canReach else { return }
        guard agent != session.agent else { return }
        session.agent = agent
        Task {
            do { try await api.selectAgent(session: id, agent: agent) } catch { fail(error) }
        }
    }

    func reply(to request: PermissionRequest, _ decision: PermissionRequest.Decision, message: String? = nil) {
        guard canReach else { return }
        Analytics.shared.track("permission_answered", ["action": Analytics.action(request.action), "decision": decision.rawValue])
        Task {
            // In the session that asked: a subagent's own, for one of its asks shown here.
            do { try await api.reply(session: request.sessionID, permission: request.id, decision: decision, message: message) } catch { fail(error) }
        }
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
        apply(event)
    }

    func answer(_ form: FormRequest, with answer: FormAnswer) {
        guard canReach else { return }
        Analytics.shared.track("question_answered", ["kind": form.isQuestion ? "question" : "form"])
        Task {
            do { try await api.reply(session: form.sessionID, form: form.id, answer: answer, directory: folder(of: form)) } catch { fail(error) }
        }
    }

    /// The folder an MCP server's form is filed under; nil for this session's own.
    private func folder(of form: FormRequest) -> String? {
        form.sessionID == FormRequest.anySession ? session.location.directory : nil
    }

    func dismiss(_ form: FormRequest, message: String? = nil) {
        guard canReach else { return }
        Analytics.shared.track("question_dismissed", ["kind": form.isQuestion ? "question" : "form"])
        Task { try? await api.dismiss(session: form.sessionID, form: form.id, message: message, directory: folder(of: form)) }
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
