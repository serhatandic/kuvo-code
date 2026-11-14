import Foundation

/// The words that start a message and ask Kuvo Code, or the conversation's computer, for something
/// other than a message to the agent: "/goal", "/loop", "/plan", "/autopilot", "/review",
/// "/handoff", "/btw" and "/compact". One list for every client, with what each says as you type it.
public enum Keyword: String, CaseIterable, Sendable, Hashable {
    case goal, loop, plan, autopilot, review, btw, handoff, compact

    /// "/goal".
    public var typed: String { "/" + rawValue }

    /// What it's called where a list shows it.
    public var title: String {
        switch self {
        case .goal: "Goal"
        case .loop: "Loop"
        case .plan: "Plan"
        case .autopilot: "Autopilot"
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
        case .autopilot: "Decide for itself; stop only for what needs you"
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
        case .plan: "what to plan (or nothing, to turn Plan on or off)"
        case .autopilot: "what to do (or nothing, to turn Autopilot on or off)"
        case .review: nil
        case .handoff: "what to do next (or nothing)"
        case .btw: "your question"
        case .compact: nil
        }
    }

    /// Its mark, an SF Symbol: in the list, in place of its "/" as it's typed, and in the bubble.
    public var symbol: String {
        switch self {
        case .goal: "scope"
        case .loop: "arrow.clockwise"
        case .plan: "list.bullet.clipboard"
        case .autopilot: "airplane"
        case .review: "text.magnifyingglass"
        case .handoff: "arrow.forward.square"
        case .btw: "bubble.left.and.bubble.right"
        case .compact: "arrow.down.and.line.horizontal.and.arrow.up"
        }
    }

    /// The box feature it needs (`features` in `kuvo/info`): nil for one made of what every
    /// engine does (Plan mode, summarizing).
    public var feature: String? {
        switch self {
        case .goal: "goals"
        case .btw: "btw"
        case .handoff: "handoff"
        case .review: "reviews"
        case .loop: "wakes.edit"
        case .autopilot: "autopilot"
        case .plan, .compact: nil
        }
    }

    /// As the composer's list of commands shows it.
    public var command: Command { Command(name: rawValue, description: summary) }

    /// "/review-quick": the engine's own review, where ours has the name.
    public static let quickReview = "review-quick"

    /// What "/" offers besides `keywords`: the engine's commands and yours, its own /review as
    /// /review-quick where the keyword has the name, and none a keyword hides. The engine's own
    /// /goal (since 2.2.1) is never offered: a message that starts with "/goal" is always the
    /// composer's, which runs goals on the conversation's computer, so the engine's couldn't run.
    public static func commands(_ own: [Command], keywords: [Keyword]) -> [Command] {
        own.compactMap { command in
            if command.name == Keyword.goal.rawValue { return nil }
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
    /// The side thread it's in: the id of the question that started it.
    public var thread: String?
    public var question: String
    public var state: State
    public var answer: String?
    public var error: String?
    /// In ms since 1970.
    public var asked: Double
    public var answered: Double?

    public var askedDate: Date { Date(timeIntervalSince1970: asked / 1000) }
    /// Its thread's id (its own, for one from before threads).
    public var threadID: String { thread ?? id }
}

/// A conversation's side questions as side threads: each with its questions, oldest first, the
/// threads in the order they were started.
public struct SideThread: Identifiable, Hashable, Sendable {
    public var id: String
    public var questions: [SideQuestion]

    /// What it started with.
    public var first: SideQuestion { questions[0] }
    public var latest: SideQuestion { questions[questions.count - 1] }

    /// `questions` (oldest first) by thread.
    public static func threads(_ questions: [SideQuestion]) -> [SideThread] {
        var order: [String] = []
        var byThread: [String: [SideQuestion]] = [:]
        for question in questions {
            if byThread[question.threadID] == nil { order.append(question.threadID) }
            byThread[question.threadID, default: []].append(question)
        }
        return order.map { SideThread(id: $0, questions: byThread[$0]!) }
    }
}

/// Every conversation on a box that has side questions: how many, and the latest.
public struct SideQuestionSummary: Codable, Sendable, Hashable {
    public var session: String
    public var count: Int
    /// How many side threads they're in (nil from a box from before threads).
    public var threads: Int?
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
    /// When it was asked for, in ms since 1970: which handoff this is (nil from a box from before).
    public var started: Double?

    public init(from: String, state: State, to: String? = nil, title: String? = nil, error: String? = nil, started: Double? = nil) {
        self.from = from
        self.state = state
        self.to = to
        self.title = title
        self.error = error
        self.started = started
    }
}

/// What a review reads: the changes not committed yet, the branch's against its base (with those
/// not committed yet), the commits after `from` up to `to` (git's `from..to`), or the files of a
/// folder in the project, all of it, or those your words describe ("the auth module and its
/// tests"), which the box finds: `paths` once it has.
public enum ReviewScope: Codable, Sendable, Hashable {
    case uncommitted
    case branch(base: String?)
    case commits(from: String, to: String?)
    case folder(String)
    case project
    case described(String, paths: [String]? = nil)

    private enum Keys: String, CodingKey { case kind, base, from, to, path, words, paths }

    public init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: Keys.self)
        switch try keys.decode(String.self, forKey: .kind) {
        case "branch": self = .branch(base: try keys.decodeIfPresent(String.self, forKey: .base))
        case "commits": self = .commits(from: try keys.decode(String.self, forKey: .from), to: try keys.decodeIfPresent(String.self, forKey: .to))
        case "folder": self = .folder(try keys.decode(String.self, forKey: .path))
        case "project": self = .project
        case "described": self = .described(try keys.decode(String.self, forKey: .words), paths: try keys.decodeIfPresent([String].self, forKey: .paths))
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
        case .described(let words, _):
            // Only the words: the files they mean are the box's to find.
            try keys.encode("described", forKey: .kind)
            try keys.encode(words, forKey: .words)
        }
    }
}

extension ReviewScope {
    /// As the review's line and its footnote say it: "The whole project", "Commits since abc1234".
    public var title: String {
        switch self {
        case .uncommitted: "Changes not committed yet"
        case .branch(let base): base.map { "This branch against \($0)" } ?? "This branch"
        case .commits(let from, let to):
            from.hasSuffix("^") && to == nil ? "Commits since \(from.dropLast())" : "Commits \(from)..\(to ?? "HEAD")"
        case .folder(let path): path
        case .project: "The whole project"
        case .described(let words, _): "“\(words)”"
        }
    }
}

extension ReviewScope {
    /// It reads files as they are (a folder, the whole project), not changes.
    public var readsFiles: Bool {
        switch self {
        case .folder, .project, .described: true
        default: false
        }
    }

    /// In a sentence, as what a model reads: "the whole project", "the files in src/auth".
    public var said: String {
        switch self {
        case .uncommitted: "the changes not committed yet"
        case .branch: "this branch’s changes"
        case .commits(let from, let to):
            from.hasSuffix("^") && to == nil ? "the commits since \(from.dropLast())" : "the commits \(from)..\(to ?? "HEAD")"
        case .folder(let path): "the files in \(path)"
        case .project: "the whole project"
        case .described: "the files that fit what you wrote"
        }
    }
}

extension ReviewCommand.Preset {
    /// As "Look for" lists it.
    public var title: String {
        switch self {
        case .security: "Security"
        case .performance: "Performance"
        case .accessibility: "Accessibility"
        }
    }
}

/// How much a review of a scope would read: its files, and the parts it reads them in.
public struct ReviewSize: Codable, Sendable, Hashable {
    public var files: Int
    public var parts: Int
    /// Files past what a review reads, left out.
    public var leftOut: Int
    /// A branch's or a range's commits.
    public var commits: Int?

    public init(files: Int, parts: Int, leftOut: Int = 0, commits: Int? = nil) {
        self.files = files
        self.parts = parts
        self.leftOut = leftOut
        self.commits = commits
    }
}

/// What "What to review" offers in a conversation's folder: the branch it's on (none on its base
/// itself), its latest commits and its folders.
public struct ReviewChoices: Codable, Sendable, Hashable {
    public var repository: Bool
    public var branch: Branch?
    public var commits: [Commit]
    public var folders: [Folder]
    /// It reads the files your words describe (`described`); nil from a box from before.
    public var describes: Bool?

    public struct Branch: Codable, Sendable, Hashable {
        public var name: String
        /// What it's compared with ("main").
        public var base: String
        /// Its own, since it left `base`.
        public var commits: Int

        public init(name: String, base: String, commits: Int) {
            self.name = name
            self.base = base
            self.commits = commits
        }
    }

    public struct Commit: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var short: String
        public var title: String
        /// In ms since 1970.
        public var time: Double

        public var date: Date { Date(timeIntervalSince1970: time / 1000) }

        public init(id: String, short: String, title: String, time: Double) {
            self.id = id
            self.short = short
            self.title = title
            self.time = time
        }
    }

    public struct Folder: Codable, Sendable, Hashable, Identifiable {
        public var path: String
        /// At any depth.
        public var files: Int

        public var id: String { path }

        public init(path: String, files: Int) {
            self.path = path
            self.files = files
        }
    }

    public init(repository: Bool, branch: Branch? = nil, commits: [Commit] = [], folders: [Folder] = [], describes: Bool? = nil) {
        self.repository = repository
        self.branch = branch
        self.commits = commits
        self.folders = folders
        self.describes = describes
    }
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
            file + lines
        }

        /// Its file's name and lines, for where there's no room for the path: `timer.ts:88-92`.
        public var shortText: String {
            (file.split(separator: "/").last.map(String.init) ?? file) + lines
        }

        private var lines: String {
            (line.map { ":\($0)" } ?? "") + (endLine.map { "-\($0)" } ?? "")
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
    /// Where Stop ended one read in parts.
    public var stopped: Progress?
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
    /// Its parts, each read by a reviewer of its own (nil from a box from before parts).
    public var parts: [Part]?

    /// A part of it, read by a reviewer of its own: what it reads, how it's going, and the
    /// session it reads in, to watch it (none with the coding agents).
    public struct Part: Codable, Sendable, Hashable, Identifiable {
        public enum State: String, Codable, Sendable, Hashable {
            case waiting, reading, done, failed, stopped
            /// One a box from after this one says: as if it were done.
            public init(from decoder: Decoder) throws {
                self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .done
            }
        }

        public var n: Int
        public var of: Int
        /// Its first files (a box names 200 at most).
        public var files: [String]
        /// How many it reads, all of them.
        public var fileCount: Int?
        public var state: State
        /// What it found.
        public var found: Int
        public var session: String?
        /// What it's doing now, while it reads ("Reading src/a.ts").
        public var now: String?

        public var id: Int { n }

        public init(n: Int, of: Int, files: [String], fileCount: Int? = nil, state: State, found: Int = 0, session: String? = nil, now: String? = nil) {
            self.n = n
            self.of = of
            self.files = files
            self.fileCount = fileCount
            self.state = state
            self.found = found
            self.session = session
            self.now = now
        }
    }
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

    /// Asks a side question about `session`: a new side thread, or a follow-up in `thread`.
    @discardableResult
    public func askSideQuestion(_ question: String, about session: String, thread: String? = nil) async throws -> SideQuestion {
        struct Body: Encodable { var question: String; var thread: String? }
        return try await client.send(try client.request("POST", "api/kuvo/btw/\(session.pathEscaped)", body: Body(question: question, thread: thread)), as: DataEnvelope<SideQuestion>.self).data
    }

    /// Takes a side thread away, all of it.
    public func removeSideThread(_ thread: String, of session: String) async throws {
        _ = try await client.send(try client.request("DELETE", "api/kuvo/btw/\(session.pathEscaped)/threads/\(thread.pathEscaped)"), as: Empty.self)
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
        do {
            return try await client.send(try client.request("POST", "api/kuvo/reviews/\(session.pathEscaped)", body: Body(model: model, focus: focus.flatMap { $0.isEmpty ? nil : $0 }, scope: scope)), as: DataEnvelope<Review>.self).data
        } catch let error as ServerError where error.status == 400 {
            // A box from before described scopes: your words are what it looks at in the changes
            // not committed yet, as they were.
            guard case .described(let words, _)? = scope else { throw error }
            return try await startReview(session: session, model: model, focus: [focus, words].compactMap { $0 }.joined(separator: ": "), scope: nil)
        }
    }

    /// How much a review of `scope` would read, to show before starting a big one.
    public func measureReview(session: String, scope: ReviewScope) async throws -> ReviewSize {
        struct Body: Encodable { var scope: ReviewScope }
        return try await client.send(try client.request("POST", "api/kuvo/reviews/\(session.pathEscaped)/measure", body: Body(scope: scope)), as: DataEnvelope<ReviewSize>.self).data
    }

    /// What "What to review" offers in `session`'s folder.
    public func reviewChoices(session: String) async throws -> ReviewChoices {
        try await client.send(try client.request("GET", "api/kuvo/reviews/\(session.pathEscaped)/choices"), as: DataEnvelope<ReviewChoices>.self).data
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
