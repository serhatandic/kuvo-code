import Foundation

/// The words that start a message and ask Kuvo Code, or the conversation's computer, for something
/// other than a message to the agent: "/goal", "/loop", "/plan", "/review", "/handoff", "/btw" and
/// "/compact". One list for every client, with what each says as you type it.
public enum Keyword: String, CaseIterable, Sendable, Hashable {
    case goal, loop, plan, review, btw, handoff, compact

    /// "/goal".
    public var typed: String { "/" + rawValue }

    /// What it's called where a list shows it.
    public var title: String {
        switch self {
        case .goal: "Goal"
        case .loop: "Loop"
        case .plan: "Plan"
        case .review: "Review"
        case .handoff: "Handoff"
        case .btw: "Side Question"
        case .compact: "Compact"
        }
    }

    /// What it does, in a line, as the list of commands says it.
    public var summary: String {
        switch self {
        case .goal: "Keep working until a condition is met"
        case .loop: "Repeat a message on a schedule"
        case .plan: "Explore and plan first, without changing files"
        case .review: "A second model reviews your uncommitted changes"
        case .handoff: "Go on in a fresh conversation from a summary"
        case .btw: "A side question, kept out of this conversation"
        case .compact: "Summarize the conversation to free up context"
        }
    }

    /// What follows it, in grey after it until something's written: nil for one that takes nothing.
    public var argument: String? {
        switch self {
        case .goal: "what should be true when it’s done, like “all tests pass”"
        case .loop: "what to do each time"
        case .plan: "what to plan (or nothing, to switch to Plan)"
        case .review: nil
        case .handoff: "what to do next (or nothing)"
        case .btw: "your question"
        case .compact: nil
        }
    }

    /// What it will do, in the line under the field as it's typed. /loop's says its schedule
    /// (`LoopCommand`), /review's its reviewer, so theirs are the client's.
    public var hint: String {
        switch self {
        case .goal: "Checked after each turn. The agent keeps going until it’s met."
        case .loop: "Repeats on a schedule."
        case .plan: "Switches to Plan: the agent explores and plans, and changes no files."
        case .review: "Reads the changes not committed yet with fresh eyes, and lists what it finds."
        case .handoff: "Writes a handoff note, then carries on in a fresh conversation from it."
        case .btw: "Answered on the side: nothing is added to this conversation."
        case .compact: "Summarizes the conversation so far to make room in its context."
        }
    }

    /// Its mark, an SF Symbol: in the list, in place of its "/" as it's typed, and in the bubble.
    public var symbol: String {
        switch self {
        case .goal: "scope"
        case .loop: "arrow.clockwise"
        case .plan: "list.bullet.clipboard"
        case .review: "text.magnifyingglass"
        case .handoff: "arrow.forward.square"
        case .btw: "bubble.left.and.bubble.right"
        case .compact: "arrow.down.and.line.horizontal.and.arrow.up"
        }
    }

    /// Drawn in Plan's orange, as the mode chip is, rather than the accent.
    public var isPlan: Bool { self == .plan }

    /// The box feature it needs (`features` in `kuvo/info`): nil for one made of what every
    /// engine does (Plan mode, summarizing).
    public var feature: String? {
        switch self {
        case .goal: "goals"
        case .btw: "btw"
        case .handoff: "handoff"
        case .review: "reviews"
        case .loop: "wakes.edit"
        case .plan, .compact: nil
        }
    }

    /// As the composer's list of commands shows it.
    public var command: Command { Command(name: rawValue, description: summary) }

    /// "/review-quick": the engine's own review, where ours has the name.
    public static let quickReview = "review-quick"

    /// What "/" offers besides `keywords`: the engine's commands and yours, its own /review as
    /// /review-quick where the keyword has the name, and none a keyword hides.
    public static func commands(_ own: [Command], keywords: [Keyword]) -> [Command] {
        own.compactMap { command in
            guard keywords.contains(where: { $0.rawValue == command.name }) else { return command }
            return command.name == Keyword.review.rawValue ? Command(name: quickReview, description: "The engine’s own review, in this conversation") : nil
        }
    }

    /// The keyword a message starts with, and what follows it ("/btw why?" is (.btw, "why?")); nil
    /// for any other message.
    public static func parse(_ text: String) -> (keyword: Keyword, rest: String)? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix("/") else { return nil }
        let name = text.dropFirst().prefix { !$0.isWhitespace }
        guard let keyword = Keyword(rawValue: name.lowercased()) else { return nil }
        return (keyword, text.dropFirst(1 + name.count).trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

// MARK: Side questions, handoffs and reviews (PROTOCOL.md, "Side questions, handoffs and reviews")

/// A side question about a conversation ("/btw …"), answered from what it knows and kept out of it.
public struct SideQuestion: Codable, Sendable, Hashable, Identifiable {
    public enum State: String, Codable, Sendable, Hashable { case answering, answered, failed }
    public var id: String
    public var session: String
    public var question: String
    public var state: State
    public var answer: String?
    public var error: String?
    /// In ms since 1970.
    public var asked: Double
    public var answered: Double?

    public var askedDate: Date { Date(timeIntervalSince1970: asked / 1000) }
}

/// Every conversation on a box that has side questions: how many, and the latest.
public struct SideQuestionSummary: Codable, Sendable, Hashable {
    public var session: String
    public var count: Int
    public var latest: SideQuestion
}

/// A conversation carried on in a fresh one ("/handoff").
public struct Handoff: Codable, Sendable, Hashable {
    public enum State: String, Codable, Sendable, Hashable { case writing, done, failed }
    public var from: String
    public var state: State
    /// The new conversation, once it's started.
    public var to: String?
    public var title: String?
    /// Why it couldn't be, when it failed.
    public var error: String?

    public init(from: String, state: State, to: String? = nil, title: String? = nil, error: String? = nil) {
        self.from = from
        self.state = state
        self.to = to
        self.title = title
        self.error = error
    }
}

/// What a review reads: the changes not committed yet, the branch's against its base (with those
/// not committed yet), the commits after `from` up to `to` (git's `from..to`), or the files of a
/// folder in the project or all of it.
public enum ReviewScope: Codable, Sendable, Hashable {
    case uncommitted
    case branch(base: String?)
    case commits(from: String, to: String?)
    case folder(String)
    case project

    private enum Keys: String, CodingKey { case kind, base, from, to, path }

    public init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: Keys.self)
        switch try keys.decode(String.self, forKey: .kind) {
        case "branch": self = .branch(base: try keys.decodeIfPresent(String.self, forKey: .base))
        case "commits": self = .commits(from: try keys.decode(String.self, forKey: .from), to: try keys.decodeIfPresent(String.self, forKey: .to))
        case "folder": self = .folder(try keys.decode(String.self, forKey: .path))
        case "project": self = .project
        default: self = .uncommitted
        }
    }

    public func encode(to encoder: Encoder) throws {
        var keys = encoder.container(keyedBy: Keys.self)
        switch self {
        case .uncommitted: try keys.encode("uncommitted", forKey: .kind)
        case .branch(let base):
            try keys.encode("branch", forKey: .kind)
            try keys.encodeIfPresent(base, forKey: .base)
        case .commits(let from, let to):
            try keys.encode("commits", forKey: .kind)
            try keys.encode(from, forKey: .from)
            try keys.encodeIfPresent(to, forKey: .to)
        case .folder(let path):
            try keys.encode("folder", forKey: .kind)
            try keys.encode(path, forKey: .path)
        case .project: try keys.encode("project", forKey: .kind)
        }
    }
}

/// How much a review of a scope would read: its files, and the parts it reads them in.
public struct ReviewSize: Codable, Sendable, Hashable {
    public var files: Int
    public var parts: Int
    /// Files past what a review reads, left out.
    public var leftOut: Int
}

/// A review of a conversation's changes with fresh eyes ("/review").
public struct Review: Codable, Sendable, Hashable, Identifiable {
    public enum State: String, Codable, Sendable, Hashable { case reviewing, done, failed }
    public enum Severity: String, Codable, Sendable, Hashable { case bug, risk, nit }
    /// Where a finding is: a file, a line in it, or lines `line` to `endLine`.
    public struct Place: Codable, Sendable, Hashable {
        public var file: String
        public var line: Int?
        public var endLine: Int?

        public init(file: String, line: Int? = nil, endLine: Int? = nil) {
            self.file = file
            self.line = line
            self.endLine = endLine
        }

        /// As people write it: `src/timer.ts:88-92`.
        public var text: String {
            file + (line.map { ":\($0)" } ?? "") + (endLine.map { "-\($0)" } ?? "")
        }
    }
    public struct Finding: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        /// What's wrong, in a line.
        public var title: String
        /// Why, and how to fix it ("" when the title says it all).
        public var explanation: String
        public var severity: Severity
        /// Every place it's in; none when it's about the change as a whole.
        public var locations: [Place]

        public init(id: String, title: String, explanation: String, severity: Severity, locations: [Place]) {
            self.id = id
            self.title = title
            self.explanation = explanation
            self.severity = severity
            self.locations = locations
        }
    }
    public var id: String
    public var session: String
    public var state: State
    public var model: ModelRef?
    public var summary: String?
    /// What it reads; nil for the changes not committed yet.
    public var scope: ReviewScope?
    /// What it was asked to look at especially (or `security`, `performance`, `accessibility`).
    public var focus: String?
    /// How far along one read in parts is, while it's under way.
    public var progress: Progress?
    public struct Progress: Codable, Sendable, Hashable {
        public var read: Int
        public var of: Int
    }
    public var findings: [Finding]
    public var error: String?
    /// What to send the agent, as your message, to fix them.
    public var fix: String?
    public var started: Double
    public var ended: Double?
}

/// `kuvo.btw.updated`, `kuvo.review.updated` (null once put away) and `kuvo.handoff`.
public struct SideQuestionUpdate: Decodable, Sendable { public var sessionID: String; public var question: SideQuestion }
public struct ReviewUpdate: Decodable, Sendable { public var sessionID: String; public var review: Review? }
public struct HandoffUpdate: Decodable, Sendable { public var sessionID: String; public var handoff: Handoff }

extension OpenCodeAPI {
    // On a box's agents bridge, as goals are (`kuvo/agents/api/kuvo/…` from a phone).

    public func sideQuestions(of session: String) async throws -> [SideQuestion] {
        try await client.send(try client.request("GET", "api/kuvo/btw/\(session.pathEscaped)"), as: DataEnvelope<[SideQuestion]>.self).data
    }

    public func sideQuestionSummary() async throws -> [SideQuestionSummary] {
        try await client.send(try client.request("GET", "api/kuvo/btw"), as: DataEnvelope<[SideQuestionSummary]>.self).data
    }

    @discardableResult
    public func askSideQuestion(_ question: String, about session: String) async throws -> SideQuestion {
        struct Body: Encodable { var question: String }
        return try await client.send(try client.request("POST", "api/kuvo/btw/\(session.pathEscaped)", body: Body(question: question)), as: DataEnvelope<SideQuestion>.self).data
    }

    /// The words voice input listens for in a conversation: its project's own names, most useful
    /// first. None from a box that doesn't give them yet.
    public func voiceWords(for session: String) async throws -> [String] {
        struct Words: Decodable { var words: [String] }
        return try await client.send(try client.request("GET", "api/kuvo/voice/words/\(session.pathEscaped)"), as: DataEnvelope<Words>.self).data.words
    }

    /// One side question taken away, or all of a conversation's (`id` nil).
    public func removeSideQuestion(_ id: String?, of session: String) async throws {
        _ = try await client.send(try client.request("DELETE", "api/kuvo/btw/\(session.pathEscaped)" + (id.map { "/\($0.pathEscaped)" } ?? "")), as: Empty.self)
    }

    /// Carries a conversation on in a fresh one, with what to do next. Starts one: it answers while the note is written, and says when it's done (`kuvo.handoff`).
    @discardableResult
    public func handoff(session: String, next: String?) async throws -> Handoff {
        struct Body: Encodable { var next: String? }
        return try await client.send(try client.request("POST", "api/kuvo/handoff/\(session.pathEscaped)", body: Body(next: next)), as: DataEnvelope<Handoff>.self).data
    }

    /// A new conversation with `session`'s words before `before` ("Branch from here"), marked by
    /// its box as branched from it (`kuvo.branchedFrom`), on the engine or with the coding agents.
    public func branch(session: String, before: String) async throws -> Session {
        struct Body: Encodable { var before: String }
        return appSession(try await client.send(try client.request("POST", "api/kuvo/branch/\(session.pathEscaped)", body: Body(before: before)), as: DataEnvelope<Session>.self).data)
    }

    /// A conversation's latest handoff, while its box runs; nil when it has none.
    public func handoff(session: String) async throws -> Handoff? {
        do {
            return try await client.send(try client.request("GET", "api/kuvo/handoff/\(session.pathEscaped)"), as: DataEnvelope<Handoff>.self).data
        } catch let error as ServerError where error.status == 404 {
            return nil
        }
    }

    @discardableResult
    /// Starts a review of what `scope` names in `session`'s folder (its changes not committed yet
    /// when left out), read by `model` (its own when left out), looking especially at `focus`.
    public func startReview(session: String, model: ModelRef? = nil, focus: String? = nil, scope: ReviewScope? = nil) async throws -> Review {
        struct Body: Encodable { var model: ModelRef?; var focus: String?; var scope: ReviewScope? }
        return try await client.send(try client.request("POST", "api/kuvo/reviews/\(session.pathEscaped)", body: Body(model: model, focus: focus.flatMap { $0.isEmpty ? nil : $0 }, scope: scope)), as: DataEnvelope<Review>.self).data
    }

    /// How much a review of `scope` would read, to show before starting a big one.
    public func measureReview(session: String, scope: ReviewScope) async throws -> ReviewSize {
        struct Body: Encodable { var scope: ReviewScope }
        return try await client.send(try client.request("POST", "api/kuvo/reviews/\(session.pathEscaped)/measure", body: Body(scope: scope)), as: DataEnvelope<ReviewSize>.self).data
    }

    /// Ends a review under way where it is, keeping what it found so far.
    @discardableResult
    public func stopReview(session: String) async throws -> Review {
        try await client.send(try client.request("POST", "api/kuvo/reviews/\(session.pathEscaped)/stop"), as: DataEnvelope<Review>.self).data
    }

    /// What to send an agent, as your message, to fix a review's findings: all of them, or those
    /// of `findings` (their ids).
    public func reviewFix(session: String, findings: [String]? = nil) async throws -> String {
        struct Body: Encodable { var findings: [String]? }
        struct Fix: Decodable { var text: String }
        return try await client.send(try client.request("POST", "api/kuvo/reviews/\(session.pathEscaped)/fix", body: Body(findings: findings)), as: DataEnvelope<Fix>.self).data.text
    }

    public func reviews() async throws -> [Review] {
        try await client.send(try client.request("GET", "api/kuvo/reviews"), as: DataEnvelope<[Review]>.self).data
    }

    public func dismissReview(session: String) async throws {
        _ = try await client.send(try client.request("DELETE", "api/kuvo/reviews/\(session.pathEscaped)"), as: Empty.self)
    }
}
