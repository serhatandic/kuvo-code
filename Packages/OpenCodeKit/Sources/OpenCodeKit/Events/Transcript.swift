import Foundation
import UniformTypeIdentifiers

/// Everything a session view shows, kept current by applying events.
///
/// Mirrors the engine's own projection (and opencode's official client): the
/// server stores the same messages, but streams them as fine-grained events.
public struct Transcript: Sendable, Equatable {
    public let sessionID: String
    public var messages: [Message] = []
    /// Inputs queued or sent but not yet handed to the agent.
    public var pending: [Pending] = []
    public var permissions: [PermissionRequest] = []
    public var forms: [FormRequest] = []
    public var isRunning = false
    /// When the model last sent anything in this session (a step starting, its words, its
    /// thinking, a tool's input): for telling a reply that stalled partway from one being written.
    /// By the engine's clock, as its messages' times are (see `clockOffset`).
    public var lastHeard: Milliseconds?
    /// How far this computer's clock is ahead of the engine's, from when its events arrived: a machine's
    /// can be behind or ahead. Take it from this computer's time to compare it with the engine's
    /// times (a message's, `lastHeard`). Not part of what two transcripts compare: it differs
    /// between two reads of the same events.
    public var clockOffset: Milliseconds {
        get { offset.value }
        set { offset.value = newValue }
    }
    private var offset = Unequated<Milliseconds>(value: 0)
    /// The engine's own notices waiting to go in, like a background command's end: shown when
    /// they do, as a read would have them.
    var waitingNotices: [String: Message.Notice] = [:]
    /// Set when an event referred to something this copy doesn't have (it was
    /// loaded mid-step, say). The owner should reload from the server.
    public var isStale = false

    public struct Pending: Sendable, Hashable, Identifiable {
        public var id: String
        public var text: String
        public var delivery: InboxItem.Delivery
        /// Shown before the server confirmed it.
        public var isLocal: Bool
        /// What was attached, for showing a local message before the server has it.
        public var files: [URL]
        /// Files the message carries in itself (a photo sent from a phone), with no copy picked
        /// here: they go on the message once it's delivered.
        public var inlineFiles: [Message.User.Attachment]
        /// What the engine keeps with it (`Message.User.metadata`).
        public var metadata: JSONValue?

        public init(id: String, text: String, delivery: InboxItem.Delivery, isLocal: Bool, files: [URL] = [], inlineFiles: [Message.User.Attachment] = [], metadata: JSONValue? = nil) {
            self.id = id
            self.text = text
            self.delivery = delivery
            self.isLocal = isLocal
            self.files = files
            self.inlineFiles = inlineFiles
            self.metadata = metadata
        }
    }

    /// The sessions of subagents working for this one: what they ask (a permission, a question)
    /// shows here, as this conversation's, and is answered in their session.
    public var helpers: Set<String> = []
    /// Whether what a run asks goes with it, unanswered: the engine's, which lets an ask go without
    /// a word when its run is stopped. The coding agents' bridge says itself when one goes (a
    /// subagent of theirs at work in the background still asks once the session's turn is over).
    public var asksEndWithRuns = false

    public init(sessionID: String) {
        self.sessionID = sessionID
    }

    /// Replaces the state with a fresh read from the server.
    public mutating func load(messages: [Message], inbox: [InboxItem], permissions: [PermissionRequest], forms: [FormRequest], isRunning: Bool) {
        self.messages = messages
        let local = pending.filter { item in item.isLocal && !inbox.contains { $0.id == item.id } && !messages.contains { $0.id == item.id } }
        // A copy shown before knows the files as they were picked: the server's names only files
        // on this Mac (not one sent inline, to a machine), and none before any conversion.
        let picked = Dictionary(pending.map { ($0.id, $0.files) }, uniquingKeysWith: { first, _ in first })
        pending = inbox.filter { $0.type == "user" }.map { item in
            let read = Pending(id: item.id, text: item.text ?? "", delivery: item.delivery, isLocal: false, files: item.files,
                               inlineFiles: InboxItem.inlineFiles(in: item.payload), metadata: item.payload["metadata"])
            // Those picked here were what it carries inline, if any.
            if let files = picked[item.id], Self.keepsLocalFiles(files, over: read) {
                return Pending(id: item.id, text: item.text ?? "", delivery: item.delivery, isLocal: false, files: files, metadata: read.metadata)
            }
            return read
        } + local
        // The engine's own notices waiting too, for when they go in: those known already as they
        // were (with when they were queued), and those the read adds (it doesn't say when: 0 until
        // then). One the read has in already goes.
        for item in inbox where item.type == "synthetic" && waitingNotices[item.id] == nil {
            waitingNotices[item.id] = Message.Notice(id: item.id, time: Message.Time(created: 0), text: item.text ?? "",
                                                     description: item.payload["description"]?.string, metadata: item.payload["metadata"])
        }
        waitingNotices = waitingNotices.filter { id, _ in !messages.contains { $0.id == id } }
        self.permissions = permissions
        self.forms = forms.filter(isOurs)
        self.isRunning = isRunning
        isStale = false
    }

    /// After `load`, the events that came while the read was on its way. A block still being
    /// written takes the words `shown` (the copy on screen, which had each piece as it came) has
    /// for it, when they go on from the read's: the engine keeps a block's words only once it
    /// ends, so its read has none of them, and the coding agents' bridge keeps them as they come,
    /// so its read has some of these pieces already (which say where they go, so they're left out
    /// by that too). Those pieces are left out for such a block. Only steps still being written are
    /// looked at: a finished one's read has its words whole.
    public mutating func catchUp(on events: [ServerEvent], shown: Transcript) {
        var caughtUp: Set<Block> = []
        for index in messages.indices.reversed() {
            guard case .assistant(var step) = messages[index] else { continue }
            guard step.time.completed == nil else { break }
            guard let at = shown.assistantIndex(step.id), case .assistant(let shownStep) = shown.messages[at] else { continue }
            for block in Self.blocks(in: step) {
                guard let words = Self.words(of: block, in: step), let shownWords = Self.words(of: block, in: shownStep),
                      shownWords.hasPrefix(words) else { continue }
                caughtUp.insert(block)
                if shownWords.count > words.count { Self.write(shownWords, to: block, in: &step) }
            }
            messages[index] = .assistant(step)
        }
        for event in events {
            if !caughtUp.isEmpty, let block = block(of: event), caughtUp.contains(block) { continue }
            apply(event)
        }
    }

    /// What of a piece isn't in a block's `words` yet, by where it says it goes (`at`): nil when
    /// all of it is (a read since has it). Without `at` (the engine's pieces), all of it.
    private static func newPart(of piece: String, at: Int?, after words: String) -> String? {
        guard let at else { return piece }
        let have = words.utf16.count
        guard have < at + piece.utf16.count else { return nil }
        guard have > at else { return piece }
        return String(decoding: piece.utf16.dropFirst(have - at), as: UTF16.self)
    }

    /// A block a step's pieces go to: its words or thinking (the `ordinal`th of its kind), or a
    /// tool call's input.
    private enum Block: Hashable {
        case text(message: String, ordinal: Int)
        case reasoning(message: String, ordinal: Int)
        case toolInput(message: String, tool: String)
    }

    private static func blocks(in step: Message.Assistant) -> [Block] {
        var texts = 0, thoughts = 0
        return step.content.compactMap { content in
            switch content {
            case .text:
                defer { texts += 1 }
                return .text(message: step.id, ordinal: texts)
            case .reasoning:
                defer { thoughts += 1 }
                return .reasoning(message: step.id, ordinal: thoughts)
            case .tool(let call):
                return .toolInput(message: step.id, tool: call.id)
            default:
                return nil
            }
        }
    }

    /// What a block has so far, while it's being written: none for thinking or a tool's input done.
    private static func words(of block: Block, in step: Message.Assistant) -> String? {
        guard let index = contentIndex(of: block, in: step) else { return nil }
        switch step.content[index] {
        case .text(let text): return text.text
        case .reasoning(let text): return text.isComplete ? nil : text.text
        case .tool(let call): if case .streaming(let input) = call.state { return input } else { return nil }
        default: return nil
        }
    }

    private static func write(_ words: String, to block: Block, in step: inout Message.Assistant) {
        guard let index = contentIndex(of: block, in: step) else { return }
        switch step.content[index] {
        case .text(var text): text.text = words; step.content[index] = .text(text)
        case .reasoning(var text): text.text = words; step.content[index] = .reasoning(text)
        case .tool(var call): call.state = .streaming(input: words); step.content[index] = .tool(call)
        default: break
        }
    }

    private static func contentIndex(of block: Block, in step: Message.Assistant) -> Int? {
        switch block {
        case .text(_, let ordinal): blockIndex(ordinal, kind: \.isText, in: step.content)
        case .reasoning(_, let ordinal): blockIndex(ordinal, kind: \.isReasoning, in: step.content)
        case .toolInput(_, let tool): step.content.lastIndex { $0.isTool(tool) }
        }
    }

    /// The block a piece of words, thinking or a tool's input goes to.
    private func block(of event: ServerEvent) -> Block? {
        guard event.sessionID == sessionID else { return nil }
        switch event.type {
        case "session.text.delta", "session.reasoning.delta":
            guard let delta = try? event.payload(as: EventPayload.Delta.self) else { return nil }
            let text = event.type == "session.text.delta"
            let ordinal = delta.ordinal ?? assistantIndex(delta.assistantMessageID).flatMap { index -> Int? in
                guard case .assistant(let step) = messages[index] else { return nil }
                return step.content.count(where: text ? \.isText : \.isReasoning) - 1
            }
            guard let ordinal else { return nil }
            return text ? .text(message: delta.assistantMessageID, ordinal: ordinal) : .reasoning(message: delta.assistantMessageID, ordinal: ordinal)
        case "session.tool.input.delta":
            guard let delta = try? event.payload(as: EventPayload.ToolInputDelta.self) else { return nil }
            return .toolInput(message: delta.assistantMessageID, tool: delta.id)
        default:
            return nil
        }
    }

    /// Whether a local copy's files stand for the engine's: files picked on this Mac, or ones the
    /// engine's copy doesn't name at all.
    private static func keepsLocalFiles(_ local: [URL], over item: Pending) -> Bool {
        local.contains(where: \.isFileURL) || (!local.isEmpty && item.files.isEmpty && item.inlineFiles.isEmpty)
    }

    /// Shows a message right away, before the server echoes it back: `metadata`, what it will keep
    /// (its parts, which its box writes it from).
    public mutating func addLocal(id: String, text: String, delivery: InboxItem.Delivery, files: [URL] = [], metadata: JSONValue? = nil) {
        var item = Pending(id: id, text: text, delivery: delivery, isLocal: true, files: files)
        item.metadata = metadata
        pending.append(item)
    }

    /// Makes an undo final: the conversation from `to` on goes, from where it is, as the engine
    /// takes it back (a message that waited in the queue is older than the steps before it, which
    /// stay). One not here is either before every message read, which all go, or gone already:
    /// the engine's word of an undo this Mac made final as you sent comes after it, as does a
    /// read made since, and what's left is from before it. What's waiting to be sent stays,
    /// newer as it is: sending a message is what makes an undo final, and that message is among it.
    public mutating func commitRevert(to: String) {
        guard to != committedRevert else { return }
        committedRevert = to
        if let index = messages.firstIndex(where: { $0.id == to }) {
            messages.removeSubrange(index...)
        } else if let first = messages.lazy.map(\.id).min(), to < first {
            messages.removeAll()
        }
    }

    /// The undo made final last, so the engine's word of one made final here finds it done.
    public var committedRevert: String?

    public mutating func removeLocal(id: String) {
        pending.removeAll { $0.id == id && $0.isLocal }
    }

    /// Drops waiting input the owner cancelled, ahead of the server's word.
    public mutating func removePending(id: String) {
        pending.removeAll { $0.id == id }
    }

    /// Events that carry a piece of something streaming in (words, thinking, a tool's input or
    /// progress): many a second, each changing only the end of the transcript.
    public static func isStreamed(_ type: String) -> Bool {
        streamed.contains(type)
    }

    /// Whether an event of this type can change a transcript (`apply` ignores the rest).
    public static func changes(with type: String) -> Bool {
        streamed.contains(type) || applied.contains(type)
    }

    private static let streamed: Set<String> = ["session.text.delta", "session.reasoning.delta", "session.tool.input.delta", "session.tool.progress"]
    /// What the model sends as it answers (a tool's progress is the tool's, not the model's).
    private static let heard: Set<String> = [
        "session.step.started", "session.text.started", "session.text.delta", "session.reasoning.started",
        "session.reasoning.delta", "session.tool.input.started", "session.tool.input.delta",
    ]
    private static let applied: Set<String> = [
        "permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled",
        "session.inbox.enqueued", "session.inbox.delivered", "session.inbox.cancelled", "session.inbox.delivery.changed",
        "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
        "session.step.started", "session.step.streamed", "session.step.ended", "session.step.failed", "session.retry.scheduled",
        "session.text.started", "session.text.ended", "session.reasoning.started", "session.reasoning.ended",
        "session.tool.input.started", "session.tool.input.ended", "session.tool.called", "session.tool.success", "session.tool.failed",
        "session.agent.selected", "session.model.selected", "session.synthetic", "session.instructions.updated",
        "session.shell.started", "session.shell.ended", "session.compaction.started", "session.compaction.ended", "session.compaction.failed", "session.revert.committed",
    ]

    /// Applies one event. Events for other sessions are ignored. One that a read since has already
    /// (it came while the read was made, or waited out a reconnect) changes nothing again.
    public mutating func apply(_ event: ServerEvent) {
        do {
            try reduce(event)
        } catch {
            // A payload this version can't read: the server's copy is the truth.
            isStale = true
        }
        // What an MCP server asked goes once nothing here waits on it: its tool finished.
        if forms.contains(where: { $0.sessionID != sessionID }) { forms = forms.filter(isOurs) }
    }

    /// Whether a tool of MCP server `server` is running here, so what it asks is this
    /// conversation's. One run through Code Mode counts when its code names the server.
    public func isWaiting(on server: String) -> Bool {
        Self.isWaiting(on: server, in: messages)
    }

    /// The same, for messages read from the engine.
    public static func isWaiting(on server: String, in messages: [Message]) -> Bool {
        let name = toolName(server)
        // A running tool is in the latest steps.
        for message in messages.suffix(8) {
            guard case .assistant(let step) = message else { continue }
            for case .tool(let call) in step.content {
                guard case .running(let input, _) = call.state else { continue }
                if call.name.hasPrefix(name + "_") { return true }
                if call.name == "execute", input["code"]?.string?.contains(server) == true { return true }
            }
        }
        return false
    }

    /// A server's name as its tools start: what a tool's name can't have becomes `_`.
    private static func toolName(_ server: String) -> String {
        String(server.map { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" ? $0 : "_" })
    }

    /// This session's own forms, and what an MCP server asks while a tool of it runs here.
    private func isOurs(_ form: FormRequest) -> Bool {
        if form.sessionID == sessionID || helpers.contains(form.sessionID) { return true }
        guard form.sessionID == FormRequest.anySession, let server = form.server else { return false }
        return isWaiting(on: server)
    }

    private mutating func reduce(_ event: ServerEvent) throws {
        let now = event.created ?? Date().timeIntervalSince1970 * 1000
        let messageID = "msg_" + event.id.dropFirst("evt_".count)
        // When it came, not when it's applied: one applied again after a read would add the read's time.
        if let created = event.created { clockOffset = event.received - created }
        if event.sessionID == sessionID, Self.heard.contains(event.type) { lastHeard = now }

        switch event.type {
        case "permission.asked":
            let request = try event.payload(as: PermissionRequest.self)
            guard request.sessionID == sessionID || helpers.contains(request.sessionID) else { return }
            permissions.removeAll { $0.id == request.id }
            permissions.append(request)
            return
        case "permission.replied":
            let reply = try event.payload(as: EventPayload.PermissionReplied.self)
            permissions.removeAll { $0.id == reply.requestID }
            return
        case "form.created":
            let form = try event.payload(as: EventPayload.FormCreated.self).form
            guard isOurs(form) else { return }
            forms.removeAll { $0.id == form.id }
            forms.append(form)
            return
        case "form.replied", "form.cancelled":
            let settled = try event.payload(as: EventPayload.FormSettled.self)
            forms.removeAll { $0.id == settled.id }
            return
        case "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted":
            // What a run asked goes with it: this session's, or a subagent's when its own run ends.
            if asksEndWithRuns, let ended = event.sessionID { permissions.removeAll { $0.sessionID == ended } }
        default:
            break
        }

        guard event.sessionID == sessionID else { return }

        switch event.type {
        // Inputs
        case "session.inbox.enqueued":
            let enqueued = try event.payload(as: EventPayload.InboxEnqueued.self)
            if enqueued.item.type == "synthetic", !hasMessage(enqueued.inboxID) {
                let payload = enqueued.item.payload
                waitingNotices[enqueued.inboxID] = Message.Notice(id: enqueued.inboxID, time: Message.Time(created: now), text: payload["text"]?.string ?? "",
                                                                  description: payload["description"]?.string, metadata: payload["metadata"])
                return
            }
            guard enqueued.item.type == "user" else { return }
            // Delivered already: a read since has it as a message.
            guard !hasMessage(enqueued.inboxID) else { return }
            var item = Pending(id: enqueued.inboxID, text: enqueued.item.payload["text"]?.string ?? "", delivery: enqueued.item.delivery, isLocal: false,
                               files: InboxItem.files(in: enqueued.item.payload), inlineFiles: InboxItem.inlineFiles(in: enqueued.item.payload),
                               metadata: enqueued.item.payload["metadata"])
            if let index = pending.firstIndex(where: { $0.id == item.id }) {
                // A local copy knows the files on this Mac as they were picked, before any
                // conversion: the same ones it carries inline, if it does. One that only carries
                // them inline (a phone's) keeps the engine's, which have their names, if it has any.
                if Self.keepsLocalFiles(pending[index].files, over: item) {
                    item.files = pending[index].files
                    item.inlineFiles = []
                }
                pending[index] = item
            } else {
                pending.append(item)
            }
        case "session.inbox.delivered":
            let id = try event.payload(as: EventPayload.InboxChanged.self).inboxID
            guard let index = pending.firstIndex(where: { $0.id == id }) else {
                if var notice = waitingNotices.removeValue(forKey: id) {
                    if notice.time.created == 0 { notice.time = Message.Time(created: now) }
                    append(.synthetic(notice))
                }
                // Otherwise not ours to show (a compaction input), or we missed it.
                return
            }
            let item = pending.remove(at: index)
            // With the files it was sent with, as they were picked: the engine's copy has them,
            // but the event that delivers it doesn't, and they'd vanish from the message.
            let files = item.files.map { Message.User.Attachment(mime: Self.mime(of: $0), name: $0.isFileURL ? $0.lastPathComponent : nil, source: .uri($0.absoluteString)) }
                + item.inlineFiles
            append(.user(Message.User(id: item.id, time: Message.Time(created: now), text: item.text, files: files.isEmpty ? nil : files, metadata: item.metadata)))
        case "session.inbox.cancelled":
            let id = try event.payload(as: EventPayload.InboxChanged.self).inboxID
            pending.removeAll { $0.id == id }
        case "session.inbox.delivery.changed":
            struct Changed: Decodable { var inboxID: String; var delivery: InboxItem.Delivery }
            let changed = try event.payload(as: Changed.self)
            if let index = pending.firstIndex(where: { $0.id == changed.inboxID }) {
                pending[index].delivery = changed.delivery
            }

        // Runs
        case "session.execution.started":
            isRunning = true
        case "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted":
            let ended = try event.payload(as: EventPayload.ExecutionEnded.self)
            isRunning = false
            // An end a read since has: the steps open there are a later run's.
            guard !hasMessage(messageID) else { return }
            closeOpenSteps(at: now)
            if messages.contains(where: Self.hasUnfinishedTool) { isStale = true }
            if ended.reason == "shutdown" { return }
            let outcome: Session.Outcome = switch event.type {
            case "session.execution.succeeded": .succeeded
            case "session.execution.failed": .failed
            default: .interrupted
            }
            messages.append(.idle(Message.Idle(id: messageID, time: Message.Time(created: now), outcome: outcome, error: ended.error)))

        // Steps
        case "session.step.started":
            // At work: whatever said otherwise (a read that missed the run) was wrong.
            isRunning = true
            let step = try event.payload(as: EventPayload.Step.self)
            if let index = assistantIndex(step.assistantMessageID), case .assistant(var message) = messages[index] {
                message.retry = nil
                message.error = nil
                message.finish = nil
                message.time.completed = nil
                messages[index] = .assistant(message)
            } else {
                closeOpenSteps(at: now)
                messages.append(.assistant(Message.Assistant(
                    id: step.assistantMessageID,
                    time: Message.Time(created: step.started ?? now),
                    agent: step.agent ?? "build",
                    model: step.model ?? ModelRef(id: "", providerID: "")
                )))
            }
        case "session.step.streamed":
            let step = try event.payload(as: EventPayload.BlockStarted.self)
            editAssistant(step.assistantMessageID) { $0.time.streamed = now }
        case "session.step.ended", "session.step.failed":
            let step = try event.payload(as: EventPayload.Step.self)
            editAssistant(step.assistantMessageID) { message in
                message.time.completed = now
                message.finish = step.finish ?? (step.error != nil ? "error" : message.finish)
                message.cost = step.cost ?? message.cost
                message.tokens = step.tokens ?? message.tokens
                message.error = step.error
                message.retry = nil
            }
        case "session.retry.scheduled":
            let retry = try event.payload(as: EventPayload.Retry.self)
            editAssistant(retry.assistantMessageID) { $0.retry = Message.Assistant.Retry(attempt: retry.attempt, at: retry.at, error: retry.error) }

        // Text and reasoning
        case "session.text.started":
            // At work: whatever said otherwise (a read that missed the run) was wrong.
            isRunning = true
            let block = try event.payload(as: EventPayload.BlockStarted.self)
            startBlock(.text(Message.Content.Text(text: "")), block.ordinal, in: block.assistantMessageID, kind: \.isText)
        case "session.text.delta":
            let delta = try event.payload(as: EventPayload.Delta.self)
            editBlock(delta.ordinal, kind: \.isText, in: delta.assistantMessageID) { content in
                guard case .text(var block) = content, let new = Self.newPart(of: delta.delta, at: delta.at, after: block.text) else { return }
                content = Self.emptyBlock
                block.text += new
                content = .text(block)
            }
        case "session.text.ended":
            let ended = try event.payload(as: EventPayload.BlockEnded.self)
            let text = Message.Content.text(Message.Content.Text(text: ended.text))
            let found = editBlock(ended.ordinal, kind: \.isText, in: ended.assistantMessageID) { $0 = text }
            // Its start was missed: the words show now, and the read puts them in their place.
            if !found { editAssistant(ended.assistantMessageID) { $0.content.append(text) } }
        case "session.reasoning.started":
            // At work: whatever said otherwise (a read that missed the run) was wrong.
            isRunning = true
            let block = try event.payload(as: EventPayload.BlockStarted.self)
            startBlock(.reasoning(Message.Content.Text(text: "", time: Message.Time(created: now))), block.ordinal, in: block.assistantMessageID, kind: \.isReasoning)
        case "session.reasoning.delta":
            let delta = try event.payload(as: EventPayload.Delta.self)
            editBlock(delta.ordinal, kind: \.isReasoning, in: delta.assistantMessageID) { content in
                // Done already (a read since has it whole): what this adds is in it.
                guard case .reasoning(var block) = content, !block.isComplete,
                      let new = Self.newPart(of: delta.delta, at: delta.at, after: block.text) else { return }
                content = Self.emptyBlock
                block.text += new
                content = .reasoning(block)
            }
        case "session.reasoning.ended":
            let ended = try event.payload(as: EventPayload.BlockEnded.self)
            let found = editBlock(ended.ordinal, kind: \.isReasoning, in: ended.assistantMessageID) { content in
                guard case .reasoning(var block) = content else { return }
                block.text = ended.text
                block.time = Message.Time(created: block.time?.created ?? now, completed: now)
                content = .reasoning(block)
            }
            if !found {
                let block = Message.Content.reasoning(Message.Content.Text(text: ended.text, time: Message.Time(created: now, completed: now)))
                editAssistant(ended.assistantMessageID) { $0.content.append(block) }
            }

        // Tools
        case "session.tool.input.started":
            // At work: whatever said otherwise (a read that missed the run) was wrong.
            isRunning = true
            let started = try event.payload(as: EventPayload.ToolInputStarted.self)
            editAssistant(started.assistantMessageID) { message in
                // There already (a read since has it, or the agent named it again once it knew what
                // it was, as Antigravity does for Kuvo Code's tools): its name as it is now.
                if let index = message.content.lastIndex(where: { $0.isTool(started.id) }) {
                    guard case .tool(var call) = message.content[index], call.name != started.name else { return }
                    message.content[index] = Self.emptyBlock
                    call.name = started.name
                    message.content[index] = .tool(call)
                    return
                }
                let call = Message.ToolCall(id: started.id, name: started.name, state: .streaming(input: ""), time: .init(created: now))
                message.content.append(.tool(call))
            }
        case "session.tool.input.delta":
            let delta = try event.payload(as: EventPayload.ToolInputDelta.self)
            editTool(delta.assistantMessageID, delta.id) { call in
                guard case .streaming(var input) = call.state, let new = Self.newPart(of: delta.delta, at: delta.at, after: input) else { return }
                call.state = .streaming(input: "")
                input += new
                call.state = .streaming(input: input)
            }
        case "session.tool.input.ended":
            let ended = try event.payload(as: EventPayload.ToolInputEnded.self)
            editTool(ended.assistantMessageID, ended.id) { call in
                if case .streaming = call.state { call.state = .streaming(input: ended.text) }
            }
        case "session.tool.called":
            let called = try event.payload(as: EventPayload.ToolCalled.self)
            editTool(called.assistantMessageID, called.id) { call in
                // Done already: a read since has its result.
                guard !call.state.isFinished else { return }
                call.state = .running(input: called.input, metadata: nil)
                call.time?.ran = now
            }
        case "session.tool.progress":
            let progress = try event.payload(as: EventPayload.ToolProgress.self)
            editTool(progress.assistantMessageID, progress.id) { call in
                if case .running(let input, _) = call.state { call.state = .running(input: input, metadata: progress.metadata) }
            }
        case "session.tool.success":
            let success = try event.payload(as: EventPayload.ToolSucceeded.self)
            editTool(success.assistantMessageID, success.id) { call in
                guard case .running(let input, _) = call.state else { return }
                call.state = .completed(input: input, output: success.content, metadata: success.metadata)
                call.time?.completed = now
            }
        case "session.tool.failed":
            let failure = try event.payload(as: EventPayload.ToolFailed.self)
            editTool(failure.assistantMessageID, failure.id) { call in
                guard !call.state.isFinished else { return }
                call.state = .failed(input: call.state.input ?? .object([:]), error: failure.error, output: failure.content, metadata: failure.metadata)
                call.time?.completed = now
            }

        // Notices
        case "session.agent.selected":
            let selected = try event.payload(as: EventPayload.AgentSelected.self)
            append(.agentSwitched(Message.AgentSwitch(id: messageID, time: Message.Time(created: now), agent: selected.agent, previous: selected.previous)))
        case "session.model.selected":
            let selected = try event.payload(as: EventPayload.ModelSelected.self)
            append(.modelSwitched(Message.ModelSwitch(id: messageID, time: Message.Time(created: now), model: selected.model, previous: selected.previous)))
        case "session.synthetic":
            struct Synthetic: Decodable { var text: String; var description: String?; var metadata: JSONValue? }
            let synthetic = try event.payload(as: Synthetic.self)
            append(.synthetic(Message.Notice(id: messageID, time: Message.Time(created: now), text: synthetic.text,
                                             description: synthetic.description, metadata: synthetic.metadata)))
        case "session.instructions.updated":
            // Only a change the model is told of has words, and a notice, as the engine keeps it.
            struct Updated: Decodable { var delta: [String: JSONValue]; var text: String? }
            struct Head: Decodable { var metadata: [String: JSONValue]? }
            let updated = try event.payload(as: Updated.self)
            guard let text = updated.text else { break }
            let sources = updated.delta.keys.sorted()
            var metadata = (try? HTTPClient.decoder.decode(Head.self, from: event.raw).metadata) ?? [:]
            metadata["notice"] = .string("instructions")
            metadata["instructionSources"] = .array(sources.map(JSONValue.string))
            append(.system(Message.Notice(id: messageID, time: Message.Time(created: now), text: text,
                                          description: "Instructions updated: \(sources.joined(separator: ", "))", metadata: .object(metadata))))
        case "session.shell.started":
            struct Started: Decodable { var shell: ShellInfo }
            let shell = try event.payload(as: Started.self).shell
            append(.shell(Message.Shell(id: messageID, time: Message.Time(created: now), shellID: shell.id, command: shell.command, status: shell.status, exit: shell.exit)))
        case "session.shell.ended":
            struct Ended: Decodable { var shell: ShellInfo; var output: Message.Shell.Output? }
            let ended = try event.payload(as: Ended.self)
            let shell = ended.shell
            if let index = messages.lastIndex(where: { if case .shell(let m) = $0 { m.shellID == shell.id } else { false } }),
               case .shell(var message) = messages[index] {
                message.status = shell.status
                message.exit = shell.exit
                message.output = ended.output
                message.time.completed = now
                messages[index] = .shell(message)
            }
        case "session.compaction.started":
            struct Started: Decodable { var reason: String?; var inputID: String? }
            let started = try event.payload(as: Started.self)
            // Named as the engine names it: after the input that asked for it, if one did.
            append(.compaction(Message.Compaction(id: started.inputID ?? messageID, time: Message.Time(created: now), status: "running", reason: started.reason, summary: nil)))
        case "session.compaction.ended", "session.compaction.failed":
            struct Ended: Decodable { var text: String? }
            let ended = try event.payload(as: Ended.self)
            let failed = event.type.hasSuffix("failed")
            // The summary under way. One whose start was missed isn't an earlier summary's (that
            // stays as it was): the engine's copy has it, a failed one too, and a read brings it;
            // unless a read since has it whole already.
            if let index = messages.lastIndex(where: { if case .compaction(let summary) = $0 { summary.status == "running" } else { false } }),
               case .compaction(var message) = messages[index] {
                message.status = failed ? "failed" : "completed"
                message.summary = ended.text
                messages[index] = .compaction(message)
            } else if failed || !messages.contains(where: { if case .compaction(let summary) = $0 { summary.summary == ended.text } else { false } }) {
                isStale = true
            }

        // History edits
        case "session.revert.committed":
            commitRevert(to: try event.payload(as: EventPayload.RevertCommitted.self).to)

        default:
            break
        }
    }

    // MARK: Helpers

    private func assistantIndex(_ id: String) -> Int? {
        messages.lastIndex { $0.id == id }
    }

    private func hasMessage(_ id: String) -> Bool {
        messages.lastIndex { $0.id == id } != nil
    }

    /// Adds a message an event makes, unless a read since has it: the engine names it the same.
    private mutating func append(_ message: Message) {
        guard !hasMessage(message.id) else { return }
        messages.append(message)
    }

    /// Adds a block to a step: the `ordinal`th of its kind, from 0. One there already (a read since
    /// has it) stays as it is; one after a gap (the blocks before it were missed) makes the copy stale.
    private mutating func startBlock(_ block: Message.Content, _ ordinal: Int?, in messageID: String, kind: (Message.Content) -> Bool) {
        var missed = false
        editAssistant(messageID) { message in
            if let ordinal {
                let count = message.content.count(where: kind)
                guard ordinal >= count else { return }
                missed = ordinal > count
            }
            message.content.append(block)
        }
        if missed { isStale = true }
    }

    /// Changes the step's block of a kind that the events call `ordinal` (without one, the last of
    /// its kind). When it isn't here (its start was missed), the copy is stale; false then.
    @discardableResult
    private mutating func editBlock(_ ordinal: Int?, kind: (Message.Content) -> Bool, in messageID: String, _ edit: (inout Message.Content) -> Void) -> Bool {
        var found = false
        editAssistant(messageID) { message in
            guard let index = Self.blockIndex(ordinal, kind: kind, in: message.content) else { return }
            found = true
            edit(&message.content[index])
        }
        if !found { isStale = true }
        return found
    }

    /// Where the `ordinal`th block of a kind is, or without one, the last.
    private static func blockIndex(_ ordinal: Int?, kind: (Message.Content) -> Bool, in content: [Message.Content]) -> Int? {
        guard let ordinal else { return content.lastIndex(where: kind) }
        var count = 0
        for index in content.indices where kind(content[index]) {
            if count == ordinal { return index }
            count += 1
        }
        return nil
    }

    private mutating func editAssistant(_ id: String, _ edit: (inout Message.Assistant) -> Void) {
        guard let index = assistantIndex(id), case .assistant(var message) = messages[index] else {
            isStale = true
            return
        }
        // Out of the list while it's changed, so the change is made in place: a reply grows a
        // few words at a time, and copying all of it for each would cost more the longer it got.
        messages[index] = Self.emptyMessage
        edit(&message)
        messages[index] = .assistant(message)
    }

    private static let emptyMessage = Message.other(id: "", type: "", created: 0)
    private static let emptyBlock = Message.Content.other(type: "")

    /// Changes a tool call. When it isn't here (its start was missed), the copy is stale.
    private mutating func editTool(_ messageID: String, _ toolID: String, _ edit: (inout Message.ToolCall) -> Void) {
        var found = false
        editAssistant(messageID) { message in
            guard let index = message.content.lastIndex(where: { $0.isTool(toolID) }),
                  case .tool(var call) = message.content[index] else { return }
            found = true
            message.content[index] = Self.emptyBlock
            edit(&call)
            message.content[index] = .tool(call)
        }
        if !found { isStale = true }
    }

    /// A new step or the end of a run closes any step still marked open, and a retry it waited on
    /// goes with it (as the engine's own reading has it).
    private mutating func closeOpenSteps(at time: Milliseconds) {
        for index in messages.indices.reversed() {
            guard case .assistant(var message) = messages[index] else { continue }
            guard message.time.completed == nil else { break }
            message.time.completed = time
            message.retry = nil
            messages[index] = .assistant(message)
        }
    }

    /// A picked file's type, as the engine names it.
    /// A file's type: by its extension, or for one in the message itself, as its `data:` header
    /// says ("data:image/jpeg;base64,…").
    private static func mime(of file: URL) -> String {
        if file.scheme == "data" { return InboxItem.dataType(file.absoluteString) }
        return UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }

    private static func hasUnfinishedTool(_ message: Message) -> Bool {
        guard case .assistant(let assistant) = message else { return false }
        return assistant.content.contains { if case .tool(let call) = $0 { !call.state.isFinished } else { false } }
    }
}

private struct ShellInfo: Decodable {
    var id: String
    var command: String
    var status: String
    var exit: Int?
}

extension Message.Content {
    var isText: Bool {
        if case .text = self { true } else { false }
    }

    var isReasoning: Bool {
        if case .reasoning = self { true } else { false }
    }

    func isTool(_ id: String) -> Bool {
        if case .tool(let call) = self { call.id == id } else { false }
    }
}

/// A value two of what holds it don't compare: when something happened by this computer's clock.
struct Unequated<Value: Sendable>: Sendable, Equatable {
    var value: Value
    static func == (_: Self, _: Self) -> Bool { true }
}
