import Foundation
import OpenCodeKit

/// A message's parts (PROTOCOL.md, "A message's parts"): what was written, and what went with it
/// (the keyword it was sent with, the widget it answers, comments on the changes, files it named,
/// agents it named with "&", that it came from a phone, or that another agent wrote it). The box
/// writes the text the agent reads from a client's fields (`Sending`) and keeps the parts with the
/// message (`metadata.kuvo.parts`); for one from before, which has none, it reads them from its text
/// (`read`). A client draws a bubble, a draft, a title or the export from these, and parses nothing.
public struct MessageParts: Codable, Hashable, Sendable {
    /// What a box answers `kuvo/sessions/<id>/send` and `kuvo/messages/parts` with in `kuvo/info`'s
    /// `features` (the update gate requires it).
    public static let feature = "messages.send"

    /// A comment on one line of the changes: its file, the line's number on its side (a removed
    /// line's on the old side), the line as it read, and what was said of it.
    public struct Comment: Codable, Hashable, Sendable {
        public enum Side: String, Codable, Sendable { case new, old }
        public var file: String
        public var line: Int
        public var side: Side
        public var snippet: String
        public var text: String

        public init(file: String, line: Int, side: Side, snippet: String, text: String) {
            self.file = file
            self.line = line
            self.side = side
            self.snippet = snippet
            self.text = text
        }

        /// "Sources/App.swift:124", "notes.md:3 (removed)".
        public var location: String { "\(file):\(line)" + (side == .old ? " (removed)" : "") }
    }

    /// An agent: as it was named, and its address ("unknown" for a message that can't be answered).
    public struct Agent: Codable, Hashable, Sendable {
        public var name: String
        public var session: String

        public init(name: String, session: String) {
            self.name = name
            self.session = session
        }
    }

    /// What was written ("Can you review?"; a command's, as you typed it).
    public var words: String
    /// The keyword it was sent with, as typed ("/loop every hour").
    public var keyword: String?
    /// The title of the widget it answers ("" for one without).
    public var widget: String?
    public var comments: [Comment]
    /// Files its note names that it doesn't carry: sent as paths, or left behind.
    public var paths: [String]
    /// The agents it names with "&".
    public var agents: [Agent]
    /// Sent from a phone.
    public var phone: Bool
    /// Another agent wrote it: who (and how to answer).
    public var mail: Agent?

    public init(words: String, keyword: String? = nil, widget: String? = nil, comments: [Comment] = [], paths: [String] = [], agents: [Agent] = [], phone: Bool = false, mail: Agent? = nil) {
        self.words = words
        self.keyword = keyword
        self.widget = widget
        self.comments = comments
        self.paths = paths
        self.agents = agents
        self.phone = phone
        self.mail = mail
    }

    private enum CodingKeys: String, CodingKey { case words, keyword, widget, comments, paths, agents, phone, mail }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        words = try container.decode(String.self, forKey: .words)
        keyword = try container.decodeIfPresent(String.self, forKey: .keyword)
        widget = try container.decodeIfPresent(String.self, forKey: .widget)
        comments = try container.decodeIfPresent([Comment].self, forKey: .comments) ?? []
        paths = try container.decodeIfPresent([String].self, forKey: .paths) ?? []
        agents = try container.decodeIfPresent([Agent].self, forKey: .agents) ?? []
        phone = try container.decodeIfPresent(Bool.self, forKey: .phone) ?? false
        mail = try container.decodeIfPresent(Agent.self, forKey: .mail)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(words, forKey: .words)
        try container.encodeIfPresent(keyword, forKey: .keyword)
        try container.encodeIfPresent(widget, forKey: .widget)
        if !comments.isEmpty { try container.encode(comments, forKey: .comments) }
        if !paths.isEmpty { try container.encode(paths, forKey: .paths) }
        if !agents.isEmpty { try container.encode(agents, forKey: .agents) }
        if phone { try container.encode(true, forKey: .phone) }
        try container.encodeIfPresent(mail, forKey: .mail)
    }

    // MARK: A message's

    /// The parts kept with a message (`metadata.kuvo.parts`), or nil for one from before. (Read as it
    /// is, not decoded again: a bubble reads its message's each time it's drawn.)
    public static func kept(in metadata: JSONValue?) -> MessageParts? {
        guard case .object(let parts)? = metadata?["kuvo"]?["parts"], case .string(let words)? = parts["words"] else { return nil }
        func string(_ value: JSONValue?) -> String? { if case .string(let text)? = value { text } else { nil } }
        func list(_ value: JSONValue?) -> [JSONValue] { if case .array(let all)? = value { all } else { [] } }
        func agent(_ value: JSONValue?) -> Agent? {
            guard let name = string(value?["name"]), let session = string(value?["session"]) else { return nil }
            return Agent(name: name, session: session)
        }
        let comments = list(parts["comments"]).compactMap { each -> Comment? in
            guard let file = string(each["file"]), case .number(let line)? = each["line"], let snippet = string(each["snippet"]), let text = string(each["text"]) else { return nil }
            return Comment(file: file, line: Int(line), side: string(each["side"]) == "old" ? .old : .new, snippet: snippet, text: text)
        }
        let phone: Bool = if case .bool(true)? = parts["phone"] { true } else { false }
        return MessageParts(words: words, keyword: string(parts["keyword"]), widget: string(parts["widget"]), comments: comments,
                            paths: list(parts["paths"]).compactMap(string), agents: list(parts["agents"]).compactMap(agent), phone: phone, mail: agent(parts["mail"]))
    }

    /// A message's parts: kept with it, else as its box read them (`read`), else (not read yet) its
    /// text as it is.
    public static func of(id: String, text: String, metadata: JSONValue?) -> MessageParts {
        kept(in: metadata) ?? known(id) ?? MessageParts(words: text)
    }

    /// `metadata` with `parts` kept in it, as a box keeps them: for a message shown before its box
    /// has it.
    public static func keeping(_ parts: MessageParts, in metadata: JSONValue? = nil) -> JSONValue? {
        guard let data = try? JSONEncoder().encode(parts), let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return metadata }
        var all: [String: JSONValue] = [:]
        if case .object(let given)? = metadata { all = given }
        var kuvo: [String: JSONValue] = [:]
        if case .object(let given)? = all["kuvo"] { kuvo = given }
        kuvo["parts"] = value
        all["kuvo"] = .object(kuvo)
        return .object(all)
    }

    // MARK: Messages from before

    nonisolated(unsafe) private static var read: [String: MessageParts] = [:]
    private static let lock = NSLock()

    /// What its box read of a message from before, by its id.
    public static func known(_ id: String) -> MessageParts? {
        lock.withLock { read[id] }
    }

    /// The ones of `messages` (by id, with their text and metadata) whose parts are still to be read
    /// from their box: none kept with them, none read yet.
    public static func unread(_ messages: [(id: String, text: String, metadata: JSONValue?)]) -> [(id: String, text: String)] {
        lock.withLock {
            messages.filter { read[$0.id] == nil && kept(in: $0.metadata) == nil }.map { ($0.id, $0.text) }
        }
    }

    /// The messages of yours and other agents' among `messages` whose parts are still to be read
    /// (not the box's own notes, nor those `ranCommand` says ran a command, which show as typed).
    public static func unread(in messages: [Message], ranCommand: (String) -> Bool = { _ in false }) -> [(id: String, text: String)] {
        unread(messages.compactMap { message in
            guard case .user(let user) = message, !ranCommand(user.id), BoxNote.of(user) == nil else { return nil }
            return (user.id, user.text, user.metadata)
        })
    }

    /// The parts of `messages` (from before, as `unread` lists them), read by their box: `ask` sends
    /// `kuvo/messages/parts` a body and gives its answer. Kept by id, for as long as the app runs.
    /// Returns whether any were read; a box that can't say leaves them as they are.
    @discardableResult
    public static func read(_ messages: [(id: String, text: String)], ask: @Sendable (Data) async throws -> (status: Int, body: Data)) async -> Bool {
        var any = false
        var rest = messages[...]
        while !rest.isEmpty {
            let batch = Array(rest.prefix(partsMost))
            rest = rest.dropFirst(batch.count)
            guard let body = try? JSONEncoder().encode(Asked(texts: batch.map(\.text))),
                  let answer = try? await ask(body), answer.status == 200,
                  let told = try? JSONDecoder().decode(Told.self, from: answer.body), told.parts.count == batch.count else { continue }
            lock.withLock {
                if read.count > 20_000 { read.removeAll() }
                for (message, parts) in zip(batch, told.parts) { read[message.id] = parts }
            }
            any = true
        }
        return any
    }

    /// Forgets what was read (a test's own start).
    public static func forgetRead() {
        lock.withLock { read.removeAll() }
    }

    /// How many texts one `kuvo/messages/parts` reads.
    static let partsMost = 500
    public static let partsRoute = "kuvo/messages/parts"
    struct Asked: Encodable { var texts: [String] }
    struct Told: Decodable { var parts: [MessageParts] }

    // MARK: Sending

    /// The route a message (or a command) goes to `session` by (its path part escaped).
    public static func sendRoute(_ session: String) -> String {
        "kuvo/sessions/" + (session.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#+"))) ?? session) + "/send"
    }

    /// Where the files a message sent are, for its note: with their contents (`included`), as paths
    /// for the agent to open, and those left behind (they couldn't be read or sent).
    public struct Notes: Codable, Hashable, Sendable {
        public var included: [String]?
        public var paths: [String]?
        public var unsent: [String]?

        public init(included: [String] = [], paths: [String] = [], unsent: [String] = []) {
            self.included = included.isEmpty ? nil : included
            self.paths = paths.isEmpty ? nil : paths
            self.unsent = unsent.isEmpty ? nil : unsent
        }

        public var isEmpty: Bool { included == nil && paths == nil && unsent == nil }
    }

    /// What a client sends: what was written and what goes with it, as fields; the box writes the
    /// text the agent reads (`kuvo/sessions/<id>/send`, or `queue/add`). `command`: run that command,
    /// `words` its arguments. `named`: sessions picked from the "&" list as it was written.
    public struct Sending: Encodable, Sendable {
        public var id: String?
        public var words: String
        public var files: [OpenCodeAPI.PromptFile]?
        public var delivery: InboxItem.Delivery?
        public var keyword: String?
        public var widget: String?
        public var comments: [Comment]?
        public var named: [String]?
        public var notes: Notes?
        public var command: String?
        /// `queue/add`'s: how it's shown is its words; ahead of `before` (Undo's).
        public var before: String?

        public init(id: String? = nil, words: String, files: [OpenCodeAPI.PromptFile] = [], delivery: InboxItem.Delivery? = nil, keyword: String? = nil, widget: String? = nil,
                    comments: [Comment] = [], named: [String] = [], notes: Notes = Notes(), command: String? = nil, before: String? = nil) {
            self.id = id
            self.words = words
            self.files = files.isEmpty ? nil : files
            self.delivery = delivery
            self.keyword = keyword
            self.widget = widget
            self.comments = comments.isEmpty ? nil : comments
            self.named = named.isEmpty ? nil : named
            self.notes = notes.isEmpty ? nil : notes
            self.command = command
            self.before = before
        }

        /// The parts its message will have, to show it before its box has it: its words trimmed,
        /// as the box writes them, and what goes with them (the agents it names aren't known yet).
        public var parts: MessageParts {
            MessageParts(words: words.trimmingCharacters(in: .whitespacesAndNewlines), keyword: keyword, widget: widget, comments: comments ?? [],
                         paths: (notes?.paths ?? []) + (notes?.unsent ?? []))
        }
    }
}
