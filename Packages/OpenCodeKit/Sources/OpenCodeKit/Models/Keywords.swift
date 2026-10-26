import Foundation

/// The words that start a message and ask Kuvo Code, or the conversation's computer, for something
/// other than a message to the agent: "/goal", "/loop", "/plan", "/review", "/handoff", "/btw" and
/// "/compact". One list for every client, with what each says as you type it.
public enum Keyword: String, CaseIterable, Sendable, Hashable {
    case goal, loop, plan, review, handoff, btw, compact

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
        case .goal: "Keep working until a goal is met"
        case .loop: "Send a message again on a schedule"
        case .plan: "Plan first, without changing files"
        case .review: "A second look at the changes, with fresh eyes"
        case .handoff: "Carry on in a fresh conversation"
        case .btw: "Ask on the side, without adding to this conversation"
        case .compact: "Summarize the conversation to make room"
        }
    }

    /// What follows it, as the composer's placeholder says it.
    public var argument: String? {
        switch self {
        case .goal: "what it should achieve, like “all tests pass”"
        case .loop: "what to send each time"
        case .plan: "what to plan"
        case .review: nil
        case .handoff: "what to do next (or nothing)"
        case .btw: "your question"
        case .compact: nil
        }
    }

    /// Its mark, an SF Symbol.
    public var symbol: String {
        switch self {
        case .goal: "scope"
        case .loop: "repeat"
        case .plan: "list.bullet.clipboard"
        case .review: "eyes"
        case .handoff: "arrow.right.doc.on.clipboard"
        case .btw: "bubble.left.and.text.bubble.right"
        case .compact: "rectangle.compress.vertical"
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
        case .plan, .compact: nil
        }
    }

    /// As the composer's list of commands shows it.
    public var command: Command { Command(name: rawValue, description: summary) }

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
    public var from: String
    public var to: String
    public var title: String
}

/// A review of a conversation's changes with fresh eyes ("/review").
public struct Review: Codable, Sendable, Hashable, Identifiable {
    public enum State: String, Codable, Sendable, Hashable { case reviewing, done, failed }
    public enum Severity: String, Codable, Sendable, Hashable { case bug, risk, nit }
    public struct Finding: Codable, Sendable, Hashable {
        public var file: String
        public var line: Int?
        public var severity: Severity
        public var note: String
    }
    public var id: String
    public var session: String
    public var state: State
    public var model: ModelRef?
    public var summary: String?
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

    /// One side question taken away, or all of a conversation's (`id` nil).
    public func removeSideQuestion(_ id: String?, of session: String) async throws {
        _ = try await client.send(try client.request("DELETE", "api/kuvo/btw/\(session.pathEscaped)" + (id.map { "/\($0.pathEscaped)" } ?? "")), as: Empty.self)
    }

    /// Carries a conversation on in a fresh one, with what to do next; answers once it's started.
    public func handoff(session: String, next: String?) async throws -> Handoff {
        struct Body: Encodable { var next: String? }
        return try await client.send(try client.request("POST", "api/kuvo/handoff/\(session.pathEscaped)", body: Body(next: next)), as: DataEnvelope<Handoff>.self, patience: .seconds(240)).data
    }

    @discardableResult
    public func startReview(session: String, model: ModelRef? = nil) async throws -> Review {
        struct Body: Encodable { var model: ModelRef? }
        return try await client.send(try client.request("POST", "api/kuvo/reviews/\(session.pathEscaped)", body: Body(model: model)), as: DataEnvelope<Review>.self).data
    }

    public func reviews() async throws -> [Review] {
        try await client.send(try client.request("GET", "api/kuvo/reviews"), as: DataEnvelope<[Review]>.self).data
    }

    public func dismissReview(session: String) async throws {
        _ = try await client.send(try client.request("DELETE", "api/kuvo/reviews/\(session.pathEscaped)"), as: Empty.self)
    }
}
