import Foundation

/// One entry in a session's transcript.
///
/// An assistant message is one model step (one request to the model); a turn
/// is everything between two `idle` markers.
public enum Message: Codable, Sendable, Hashable, Identifiable {
    case user(User)
    case assistant(Assistant)
    /// Text the engine or a plugin added on the user's behalf.
    case synthetic(Notice)
    /// Engine notices, like "Instructions updated".
    case system(Notice)
    case shell(Shell)
    case agentSwitched(AgentSwitch)
    case modelSwitched(ModelSwitch)
    case compaction(Compaction)
    /// The end of a turn, and how it went.
    case idle(Idle)
    /// A message type this version of the app doesn't know.
    case other(id: String, type: String, created: Milliseconds)

    public var id: String {
        switch self {
        case .user(let m): m.id
        case .assistant(let m): m.id
        case .synthetic(let m), .system(let m): m.id
        case .shell(let m): m.id
        case .agentSwitched(let m): m.id
        case .modelSwitched(let m): m.id
        case .compaction(let m): m.id
        case .idle(let m): m.id
        case .other(let id, _, _): id
        }
    }

    public var created: Milliseconds {
        switch self {
        case .user(let m): m.time.created
        case .assistant(let m): m.time.created
        case .synthetic(let m), .system(let m): m.time.created
        case .shell(let m): m.time.created
        case .agentSwitched(let m): m.time.created
        case .modelSwitched(let m): m.time.created
        case .compaction(let m): m.time.created
        case .idle(let m): m.time.created
        case .other(_, _, let created): created
        }
    }

    public struct Time: Codable, Sendable, Hashable {
        public var created: Milliseconds
        public var streamed: Milliseconds?
        public var completed: Milliseconds?

        public init(created: Milliseconds, streamed: Milliseconds? = nil, completed: Milliseconds? = nil) {
            self.created = created
            self.streamed = streamed
            self.completed = completed
        }
    }

    public struct User: Codable, Sendable, Hashable {
        public var id: String
        public var time: Time
        public var text: String
        public var files: [Attachment]?
        /// What the engine keeps with it: for one the box wrote to the agent, its mark
        /// (`kuvo.note`, KuvoClient's BoxNote).
        public var metadata: JSONValue?

        public init(id: String, time: Time, text: String, files: [Attachment]? = nil, metadata: JSONValue? = nil) {
            self.id = id
            self.time = time
            self.text = text
            self.files = files
            self.metadata = metadata
        }

        /// A file sent with the message. The engine keeps its contents (`data`, base64),
        /// so it shows even after the original moves.
        public struct Attachment: Codable, Sendable, Hashable {
            public var mime: String
            public var name: String?
            public var data: String?
            public var source: Source?

            public init(mime: String, name: String? = nil, data: String? = nil, source: Source? = nil) {
                self.mime = mime
                self.name = name
                self.data = data
                self.source = source
            }

            /// Where it came from: a file, or pasted (inline).
            public enum Source: Codable, Sendable, Hashable {
                case inline
                case uri(String)

                private enum CodingKeys: String, CodingKey { case type, uri }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    if let uri = try container.decodeIfPresent(String.self, forKey: .uri) {
                        self = .uri(uri)
                    } else {
                        self = .inline
                    }
                }

                public func encode(to encoder: Encoder) throws {
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    switch self {
                    case .inline:
                        try container.encode("inline", forKey: .type)
                    case .uri(let uri):
                        try container.encode("uri", forKey: .type)
                        try container.encode(uri, forKey: .uri)
                    }
                }
            }

            /// The original file, when it was one.
            public var fileURL: URL? {
                // A `data:` URL can be megabytes: it isn't parsed only to find it's not a file.
                guard case .uri(let uri) = source, uri.prefix(5).lowercased() == "file:", let url = URL(string: uri), url.isFileURL else { return nil }
                return url
            }

            /// What's in it: the engine's copy, or what the `data:` URL it came as carries (a
            /// photo sent from the phone, a picture a tool returned).
            public var bytes: Data? {
                if let data { return Data(base64Encoded: data) }
                guard case .uri(let uri) = source else { return nil }
                return Self.contents(ofDataURL: uri)
            }

            /// About how many bytes it has, without decoding them.
            public var size: Int? {
                if let data { return data.utf8.count * 3 / 4 }
                guard case .uri(let uri) = source, let (payload, isBase64) = Self.dataURLParts(uri) else { return nil }
                return isBase64 ? payload.utf8.count * 3 / 4 : payload.utf8.count
            }

            /// What a `data:` URL carries, base64 ("data:image/png;base64,iVBOR…") or
            /// percent-encoded ("data:,Hello%2C%20there"); nil when it isn't one, or is malformed.
            public static func contents(ofDataURL uri: String) -> Data? {
                guard let (payload, isBase64) = dataURLParts(uri), let bytes = percentDecoded(payload) else { return nil }
                return isBase64 ? Data(base64Encoded: bytes) : bytes
            }

            /// A `data:` URL's payload, after the comma, and whether its header ends in `;base64`.
            private static func dataURLParts(_ uri: String) -> (payload: Substring, isBase64: Bool)? {
                guard uri.prefix(5).lowercased() == "data:", let comma = uri.firstIndex(of: ",") else { return nil }
                let parameters = uri[uri.index(uri.startIndex, offsetBy: 5)..<comma].split(separator: ";", omittingEmptySubsequences: false)
                let isBase64 = parameters.count > 1 && parameters.last?.trimmingCharacters(in: .whitespaces).lowercased() == "base64"
                return (uri[uri.index(after: comma)...], isBase64)
            }

            /// The bytes of `text` with its `%XX` escapes decoded; nil for a broken escape.
            private static func percentDecoded(_ text: Substring) -> Data? {
                let utf8 = text.utf8
                guard utf8.contains(UInt8(ascii: "%")) else { return Data(utf8) }
                func digit(_ byte: UInt8) -> UInt8? {
                    switch byte {
                    case UInt8(ascii: "0")...UInt8(ascii: "9"): byte - UInt8(ascii: "0")
                    case UInt8(ascii: "a")...UInt8(ascii: "f"): byte - UInt8(ascii: "a") + 10
                    case UInt8(ascii: "A")...UInt8(ascii: "F"): byte - UInt8(ascii: "A") + 10
                    default: nil
                    }
                }
                var bytes = Data(capacity: utf8.count)
                var iterator = utf8.makeIterator()
                while let byte = iterator.next() {
                    guard byte == UInt8(ascii: "%") else { bytes.append(byte); continue }
                    guard let high = iterator.next().flatMap(digit), let low = iterator.next().flatMap(digit) else { return nil }
                    bytes.append(high << 4 | low)
                }
                return bytes
            }
        }
    }

    public struct Assistant: Codable, Sendable, Hashable {
        public var id: String
        public var time: Time
        public var agent: String
        public var model: ModelRef
        public var content: [Content]
        public var finish: String?
        /// Cost of this step, in US dollars.
        public var cost: Double?
        public var tokens: TokenUsage?
        public var error: StructuredError?
        public var retry: Retry?

        public init(id: String, time: Time, agent: String, model: ModelRef, content: [Content] = []) {
            self.id = id
            self.time = time
            self.agent = agent
            self.model = model
            self.content = content
        }

        public struct Retry: Codable, Sendable, Hashable {
            public var attempt: Int
            public var at: Milliseconds
            public var error: StructuredError
        }
    }

    public struct Notice: Codable, Sendable, Hashable {
        public var id: String
        public var time: Time
        public var text: String
        public var description: String?
        public var metadata: JSONValue?

        /// For "Instructions updated": which instructions changed (`core/mcp-guidance`, an
        /// entry's key, …).
        public var instructionSources: [String] {
            metadata?["instructionSources"]?.array?.compactMap(\.string) ?? []
        }
    }

    /// A command you ran yourself in the session's folder; the agent gets it and its output with
    /// your next message.
    public struct Shell: Codable, Sendable, Hashable {
        public var id: String
        public var time: Time
        public var shellID: String
        public var command: String
        public var status: String
        public var exit: Int?
        /// What it printed (stdout and stderr together), once it's done.
        public var output: Output? = nil

        public struct Output: Codable, Sendable, Hashable {
            public var output: String
            /// Cut short by the engine: it was longer than it keeps.
            public var truncated: Bool
        }

        public var isRunning: Bool { status == "running" }
    }

    public struct AgentSwitch: Codable, Sendable, Hashable {
        public var id: String
        public var time: Time
        public var agent: String
        public var previous: String?
    }

    public struct ModelSwitch: Codable, Sendable, Hashable {
        public var id: String
        public var time: Time
        public var model: ModelRef
        public var previous: ModelRef?
    }

    public struct Compaction: Codable, Sendable, Hashable {
        public var id: String
        public var time: Time
        public var status: String
        public var reason: String?
        public var summary: String?
    }

    public struct Idle: Codable, Sendable, Hashable {
        public var id: String
        public var time: Time
        public var outcome: Session.Outcome
        public var error: StructuredError?

        public init(id: String, time: Time, outcome: Session.Outcome, error: StructuredError? = nil) {
            self.id = id
            self.time = time
            self.outcome = outcome
            self.error = error
        }
    }

    private enum CodingKeys: String, CodingKey { case type, id, time }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "user": self = .user(try User(from: decoder))
        case "assistant": self = .assistant(try Assistant(from: decoder))
        case "synthetic": self = .synthetic(try Notice(from: decoder))
        case "system": self = .system(try Notice(from: decoder))
        case "shell": self = .shell(try Shell(from: decoder))
        case "agent-switched": self = .agentSwitched(try AgentSwitch(from: decoder))
        case "model-switched": self = .modelSwitched(try ModelSwitch(from: decoder))
        case "compaction": self = .compaction(try Compaction(from: decoder))
        case "idle": self = .idle(try Idle(from: decoder))
        default:
            let time = try container.decode(Time.self, forKey: .time)
            self = .other(id: try container.decode(String.self, forKey: .id), type: type, created: time.created)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .user(let m): try container.encode("user", forKey: .type); try m.encode(to: encoder)
        case .assistant(let m): try container.encode("assistant", forKey: .type); try m.encode(to: encoder)
        case .synthetic(let m): try container.encode("synthetic", forKey: .type); try m.encode(to: encoder)
        case .system(let m): try container.encode("system", forKey: .type); try m.encode(to: encoder)
        case .shell(let m): try container.encode("shell", forKey: .type); try m.encode(to: encoder)
        case .agentSwitched(let m): try container.encode("agent-switched", forKey: .type); try m.encode(to: encoder)
        case .modelSwitched(let m): try container.encode("model-switched", forKey: .type); try m.encode(to: encoder)
        case .compaction(let m): try container.encode("compaction", forKey: .type); try m.encode(to: encoder)
        case .idle(let m): try container.encode("idle", forKey: .type); try m.encode(to: encoder)
        case .other(let id, let type, let created):
            try container.encode(type, forKey: .type)
            try container.encode(id, forKey: .id)
            try container.encode(Time(created: created), forKey: .time)
        }
    }
}

extension Message {
    /// One block of an assistant step's output.
    public enum Content: Codable, Sendable, Hashable {
        case text(Text)
        case reasoning(Text)
        case tool(ToolCall)
        case other(type: String)

        public struct Text: Codable, Sendable, Hashable {
            public var text: String
            public var time: Time?

            public init(text: String, time: Time? = nil) {
                self.text = text
                self.time = time
            }

            /// Reasoning is finished once it has a completion time.
            public var isComplete: Bool { time?.completed != nil }
        }

        private enum CodingKeys: String, CodingKey { case type }

        public init(from decoder: Decoder) throws {
            let type = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .type)
            switch type {
            case "text": self = .text(try Text(from: decoder))
            case "reasoning": self = .reasoning(try Text(from: decoder))
            case "tool": self = .tool(try ToolCall(from: decoder))
            default: self = .other(type: type)
            }
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .text(let block): try container.encode("text", forKey: .type); try block.encode(to: encoder)
            case .reasoning(let block): try container.encode("reasoning", forKey: .type); try block.encode(to: encoder)
            case .tool(let call): try container.encode("tool", forKey: .type); try call.encode(to: encoder)
            case .other(let type): try container.encode(type, forKey: .type)
            }
        }
    }

    /// A tool the model called, and where it's up to.
    public struct ToolCall: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var name: String
        /// True when the provider ran it on its side (like hosted web search).
        public var executed: Bool?
        public var state: ToolState

        /// A question its box turned down on Autopilot, with its words (`LEFT_UNDONE_WORDS`): nobody
        /// was asked and nothing broke. Only a question: any other step that quotes those words failed.
        public var isSetAsideOnAutopilot: Bool {
            guard name == "question", case .failed(_, let error, _, _) = state else { return false }
            return error.message.contains("This is on Autopilot:")
        }

        /// What a question step asks, a line each.
        public var questionsAsked: String {
            let input: JSONValue? = switch state {
            case .running(let input, _), .completed(let input, _, _), .failed(let input, _, _, _): input
            case .streaming: nil
            }
            return (input?["questions"]?.array ?? []).compactMap { $0["question"]?.string }.joined(separator: "\n")
        }
        public var time: Time?

        public init(id: String, name: String, state: ToolState, time: Time? = nil) {
            self.id = id
            self.name = name
            self.state = state
            self.time = time
        }

        private enum CodingKeys: String, CodingKey { case id, name, executed, state, time }

        /// A command's call as the engine recorded it: `shell`, as the engine has named the tool
        /// since the rename, and `bash` in a conversation it recorded before (or a call by that
        /// name, which 2.2.6 runs as `shell`). Every row reads it as `shell`.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            let recorded = try c.decode(String.self, forKey: .name)
            name = recorded == "bash" ? "shell" : recorded
            executed = try c.decodeIfPresent(Bool.self, forKey: .executed)
            state = try c.decode(ToolState.self, forKey: .state)
            time = try c.decodeIfPresent(Time.self, forKey: .time)
        }

        public struct Time: Codable, Sendable, Hashable {
            public var created: Milliseconds?
            public var ran: Milliseconds?
            public var completed: Milliseconds?
        }
    }

    public enum ToolState: Codable, Sendable, Hashable {
        /// The model is still writing the arguments. `input` is partial JSON.
        case streaming(input: String)
        case running(input: JSONValue, metadata: JSONValue?)
        case completed(input: JSONValue, output: [ToolOutput], metadata: JSONValue?)
        case failed(input: JSONValue, error: StructuredError, output: [ToolOutput]?, metadata: JSONValue?)

        private enum CodingKeys: String, CodingKey { case status, input, metadata, content, error }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            switch try c.decode(String.self, forKey: .status) {
            case "streaming":
                self = .streaming(input: (try? c.decode(String.self, forKey: .input)) ?? "")
            case "running":
                self = .running(input: try c.decode(JSONValue.self, forKey: .input), metadata: try c.decodeIfPresent(JSONValue.self, forKey: .metadata))
            case "completed":
                self = .completed(
                    input: try c.decode(JSONValue.self, forKey: .input),
                    output: try c.decodeIfPresent([ToolOutput].self, forKey: .content) ?? [],
                    metadata: try c.decodeIfPresent(JSONValue.self, forKey: .metadata)
                )
            default:
                self = .failed(
                    input: (try? c.decode(JSONValue.self, forKey: .input)) ?? .null,
                    error: try c.decodeIfPresent(StructuredError.self, forKey: .error) ?? StructuredError(type: "unknown", message: "The tool failed."),
                    output: try c.decodeIfPresent([ToolOutput].self, forKey: .content),
                    metadata: try c.decodeIfPresent(JSONValue.self, forKey: .metadata)
                )
            }
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .streaming(let input):
                try c.encode("streaming", forKey: .status); try c.encode(input, forKey: .input)
            case .running(let input, let metadata):
                try c.encode("running", forKey: .status); try c.encode(input, forKey: .input); try c.encodeIfPresent(metadata, forKey: .metadata)
            case .completed(let input, let output, let metadata):
                try c.encode("completed", forKey: .status); try c.encode(input, forKey: .input)
                try c.encode(output, forKey: .content); try c.encodeIfPresent(metadata, forKey: .metadata)
            case .failed(let input, let error, let output, let metadata):
                try c.encode("error", forKey: .status); try c.encode(input, forKey: .input); try c.encode(error, forKey: .error)
                try c.encodeIfPresent(output, forKey: .content); try c.encodeIfPresent(metadata, forKey: .metadata)
            }
        }

        public var input: JSONValue? {
            switch self {
            case .streaming: nil
            case .running(let input, _), .completed(let input, _, _), .failed(let input, _, _, _): input
            }
        }

        public var metadata: JSONValue? {
            switch self {
            case .streaming: nil
            case .running(_, let metadata), .completed(_, _, let metadata), .failed(_, _, _, let metadata): metadata
            }
        }

        public var isFinished: Bool {
            switch self {
            case .completed, .failed: true
            case .streaming, .running: false
            }
        }
    }

    public enum ToolOutput: Codable, Sendable, Hashable {
        case text(String)
        case file(uri: String, mime: String, name: String?)

        private enum CodingKeys: String, CodingKey { case type, text, uri, mime, name }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            if try c.decode(String.self, forKey: .type) == "file" {
                self = .file(uri: try c.decode(String.self, forKey: .uri), mime: try c.decode(String.self, forKey: .mime), name: try c.decodeIfPresent(String.self, forKey: .name))
            } else {
                self = .text((try? c.decode(String.self, forKey: .text)) ?? "")
            }
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .text(let text): try c.encode("text", forKey: .type); try c.encode(text, forKey: .text)
            case .file(let uri, let mime, let name):
                try c.encode("file", forKey: .type); try c.encode(uri, forKey: .uri); try c.encode(mime, forKey: .mime); try c.encodeIfPresent(name, forKey: .name)
            }
        }

        public var text: String? {
            if case .text(let text) = self { text } else { nil }
        }
    }
}

public extension Array where Element == Message {
    /// Whether the message at `index` is a summary you asked for that ran on its own: what came
    /// before it had ended. One asked for during a run on the engine is taken at a step of that
    /// run, and the end after it is the end of that run's real work (as the box's
    /// `shared/summaries.ts`).
    private func isSummaryOnItsOwn(at index: Int) -> Bool {
        guard case .compaction(let summary) = self[index], summary.reason == "manual" else { return false }
        var before = index - 1
        while before >= startIndex, isBetweenTurns(self[before]) { before -= 1 }
        guard before >= startIndex else { return true }
        if case .idle = self[before] { return true }
        return false
    }

    /// What's written between turns: notes, a model or mode picked, a command you ran.
    private func isBetweenTurns(_ message: Message) -> Bool {
        switch message {
        case .synthetic, .system, .modelSwitched, .agentSwitched, .shell: true
        default: false
        }
    }

    /// The summary you asked for that ended with the end at `index`, if one did.
    private func summaryEnded(at index: Int) -> Int? {
        var before = index - 1
        while before >= startIndex, isBetweenTurns(self[before]) { before -= 1 }
        return before >= startIndex && isSummaryOnItsOwn(at: before) ? before : nil
    }

    /// The summary being made now, if one is: one you asked for, or one the agent began by itself
    /// as the conversation filled up (its row comes partway through a turn, and what you send
    /// meanwhile comes after it). Its row says so, and so does the line under the conversation.
    var summaryUnderWay: Message.Compaction? {
        for message in reversed() {
            switch message {
            case .compaction(let summary): return summary.status == "running" ? summary : nil
            case .idle: return nil
            default: continue
            }
        }
        return nil
    }

    /// The summary a session did last, if that's all it did since its last turn. How it went is its
    /// `status`: the engine's run says it succeeded even for one that failed.
    var summaryAtEnd: Message.Compaction? {
        var at = endIndex - 1
        // Past what's been written since (a message waiting its turn, a note), and its end.
        while at >= startIndex, isBetweenTurns(self[at]) || { if case .user = self[at] { true } else { false } }() { at -= 1 }
        while at >= startIndex, case .idle = self[at] { at -= 1 }
        while at >= startIndex, isBetweenTurns(self[at]) { at -= 1 }
        guard at >= startIndex, isSummaryOnItsOwn(at: at), case .compaction(let summary) = self[at] else { return nil }
        return summary
    }

    /// Where the last turn of work ended, past any summaries you asked for after it.
    var lastTurnEndIndex: Int? {
        var index = endIndex - 1
        while index >= startIndex {
            if case .idle = self[index] {
                guard let summary = summaryEnded(at: index) else { return index }
                index = summary
            }
            index -= 1
        }
        return nil
    }

    /// That end, which says how that work went: a summary after it says how the summary did.
    var lastTurnEnd: Message.Idle? {
        guard let index = lastTurnEndIndex, case .idle(let idle) = self[index] else { return nil }
        return idle
    }

    /// Where the conversation ends for Try Again: past a model or mode picked after a failed run,
    /// and past a summary you asked for after it, neither of which takes it away.
    var whereItEnds: Int? {
        var index = endIndex - 1
        while index >= startIndex {
            switch self[index] {
            case .modelSwitched, .agentSwitched: index -= 1
            case .compaction where isSummaryOnItsOwn(at: index): index -= 1
            case .idle:
                guard let summary = summaryEnded(at: index) else { return index }
                index = summary - 1
            default: return index
            }
        }
        return nil
    }

    /// A message is sent again as it is after this, rather than its turn taken back first: that
    /// would throw the summary away with it, and fail for the same reason as before.
    func summarized(since message: String) -> Bool {
        guard let from = firstIndex(where: { $0.id == message }) else { return false }
        return indices[from...].contains { index in
            if case .compaction(let summary) = self[index] { summary.status == "completed" && isSummaryOnItsOwn(at: index) } else { false }
        }
    }
}
