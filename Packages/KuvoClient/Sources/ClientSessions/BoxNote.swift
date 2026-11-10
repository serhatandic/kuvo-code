import Foundation
import OpenCodeKit

/// A message the box wrote to an agent in its conversation (a goal starting, its sessions' news,
/// your answer told late): the agent reads it whole, and both apps show it in its place as what
/// happened rather than as a bubble of yours. Every box marks one as it sends it
/// (`metadata.kuvo.note`, the box's `boxNote`); those sent before it did are read from how it
/// wrote them. Its sessions' news reads as messages from those sessions (`news`, each in the
/// To/From design of messages between agents); the rest as a pill or a line (`TranscriptNote`).
public struct BoxNote: Equatable, Sendable {
    /// Who it's from: "Goal", "Its sessions", "Your answer".
    public let from: String
    /// What happened, in a few words: "Goal started", "“Sign-in” finished".
    public let line: String
    /// Its sessions' news, one for each session it tells of: a message from each (none for any
    /// other note).
    public let news: [SessionNews]

    /// The SF Symbol its line shows with: a goal's mark for a goal's, otherwise an info mark.
    public var symbol: String { from == "Goal" ? "scope" : "info.circle" }

    public init(from: String, line: String, news: [SessionNews] = []) {
        self.from = from
        self.line = line
        self.news = news
    }

    /// The note `user` is, or nil for a message of yours.
    public static func of(_ user: Message.User) -> BoxNote? {
        of(text: user.text, metadata: user.metadata)
    }

    /// The note a message with `text` and `metadata` is (one waiting to go in, say).
    public static func of(text: String, metadata: JSONValue?) -> BoxNote? {
        if let note = metadata?["kuvo"]?["note"], let from = note["from"]?.string, let line = note["line"]?.string {
            return BoxNote(from: from, line: line, news: from == sessions ? SessionNews.all(in: text) : [])
        }
        return before(text)
    }

    static let sessions = "Its sessions"

    // How a box wrote them before it marked them: each by the words it opened with.
    private static let goalLines: [(start: String, line: String)] = [
        ("[Goal started] The user approved the plan.", "Goal started"),
        ("[Not now] The user didn't start this goal.", "You said not now"),
        ("[Goal changed] The user changed the goal's limits.", "You changed the goal's limits"),
        ("[Goal's end] The end the user set has come.", "The goal's end came"),
        ("[Goal] Nothing of the goal is at work now.", "Reminded to carry on"),
        ("[Goal resumed] The user resumed the goal you paused.", "Goal resumed"),
    ]
    private static let answered = "[The user answered] "

    private static func before(_ text: String) -> BoxNote? {
        if let found = goalLines.first(where: { text.hasPrefix($0.start) }) { return BoxNote(from: "Goal", line: found.line) }
        if text.hasPrefix(answered) { return BoxNote(from: "Your answer", line: "You answered: \(text.dropFirst(answered.count))") }
        if let why = firstMatch(#"^\[Limit reset\] (.+?) has reset\. Carry on"#, in: text)?.first {
            return BoxNote(from: "Goal", line: "\(why.prefix(1).uppercased())\(why.dropFirst()) reset")
        }
        return sessionNews(text)
    }

    // Its sessions' news, as the box's `wakeLineShown` says it: one session's, or how many.
    private static func sessionNews(_ text: String) -> BoxNote? {
        guard text.hasPrefix("[Session ") else { return nil }
        let news = SessionNews.all(in: text)
        guard let first = news.first else { return nil }
        guard news.count == 1 else { return BoxNote(from: sessions, line: "\(news.count) updates from its sessions", news: news) }
        return BoxNote(from: sessions, line: "“\(first.title)” \(first.kind.words)", news: news)
    }

    static func firstMatch(_ pattern: String, in text: String, options: NSRegularExpression.Options = []) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options),
              let found = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (1..<found.numberOfRanges).map { Range(found.range(at: $0), in: text).map { String(text[$0]) } ?? "" }
    }
}

/// One of a lead's sessions telling it what it did, as the box words it (`wakeLine`, PROTOCOL.md
/// "Messages in a session"): which session, what happened, and what it said. Both apps show it as a
/// message from that session, in the design of a message from another agent, opening it.
public struct SessionNews: Hashable, Sendable {
    public enum Kind: String, Hashable, Sendable {
        case finished, working, failed, asks

        /// What happened, after its name: "finished", "still working".
        public var words: String {
            switch self {
            case .finished: "finished"
            case .working: "still working"
            case .failed: "stopped with an error"
            case .asks: "asks something"
            }
        }
    }

    /// Its address ("ses_…"), to open it.
    public let session: String
    public let title: String
    public let kind: Kind
    /// What it said: its reply (empty for none), why it stopped, or what it asks.
    public let said: String
    /// What it left running, when it's still working: "the command `npm test`".
    public let running: String?

    public init(session: String, title: String, kind: Kind, said: String, running: String? = nil) {
        self.session = session
        self.title = title
        self.kind = kind
        self.said = said
        self.running = running
    }

    /// The message's words, as its card shows them.
    public var body: String {
        switch kind {
        case .finished:
            return said.isEmpty ? "It ended without a reply." : said
        case .working:
            let still = running.map { "Still running in the background: \($0)." }
            return [said.isEmpty ? nil : said, still].compactMap { $0 }.joined(separator: "\n\n").nonEmpty ?? "Still working."
        case .failed, .asks:
            return said
        }
    }

    /// What its card says beside its name, in a word or two: "finished", "still working", "asks".
    public var status: String {
        switch kind {
        case .finished: "finished"
        case .working: "still working"
        case .failed: "stopped"
        case .asks: "asks"
        }
    }

    // `[Session finished] "Title" in place (address ses_1), after 3 min:` and what follows; those
    // gathered into one message go one after the other, a blank line between them.
    private static let header = #"\[Session (finished|still working|failed|asks)\] "([^"\n]*)"[^\n]*?\(address ([A-Za-z0-9_]+)\)"#
    private static let ended = "(It ended without a reply.)"

    /// Each session's news in a message the box wrote, in order.
    static func all(in text: String) -> [SessionNews] {
        guard let regex = try? NSRegularExpression(pattern: "(?m)^" + header) else { return [] }
        let whole = NSRange(text.startIndex..., in: text)
        let found = regex.matches(in: text, range: whole)
        return found.enumerated().compactMap { index, match in
            guard let kindRange = Range(match.range(at: 1), in: text), let titleRange = Range(match.range(at: 2), in: text),
                  let idRange = Range(match.range(at: 3), in: text), let after = Range(match.range, in: text)?.upperBound else { return nil }
            let end = index + 1 < found.count ? Range(found[index + 1].range, in: text)?.lowerBound ?? text.endIndex : text.endIndex
            let rest = String(text[after..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
            let title = text[titleRange].isEmpty ? "New Session" : String(text[titleRange])
            return news(kind: String(text[kindRange]), title: title, session: String(text[idRange]), rest: rest)
        }
    }

    private static func news(kind: String, title: String, session: String, rest: String) -> SessionNews {
        switch kind {
        case "finished", "still working":
            // `, after 3 min:` then its reply on the lines after.
            var said = rest.range(of: ":\n").map { String(rest[$0.upperBound...]) } ?? (rest.hasPrefix(":") ? String(rest.dropFirst()) : "")
            var running: String?
            if let still = said.range(of: #"\n?\(Still running in the background: (.+)\. It may write again once that ends\.\)$"#, options: .regularExpression) {
                let words = String(said[still]).trimmingCharacters(in: .whitespacesAndNewlines)
                running = BoxNote.firstMatch(#"^\(Still running in the background: (.+)\. It may write again"#, in: words, options: .dotMatchesLineSeparators)?.first
                said = String(said[..<still.lowerBound])
            }
            said = said.trimmingCharacters(in: .whitespacesAndNewlines)
            if said == ended { said = "" }
            return SessionNews(session: session, title: title, kind: kind == "finished" ? .finished : .working, said: said, running: running)
        case "failed":
            // `stopped: <why>. Starting it again there fails the same way: …`, or `stopped with an
            // error: <why>. Read it with read_conversation, …`: what it says, not what the lead's told to do.
            var said = rest
            for advice in [". Starting it again there fails the same way", ". Read it with read_conversation"] {
                if let cut = said.range(of: advice) { said = String(said[..<cut.lowerBound]) }
            }
            said = said.trimmingCharacters(in: .whitespaces)
            return SessionNews(session: session, title: title, kind: .failed, said: sentence(said.isEmpty ? "stopped with an error" : said))
        default:
            // `asks to <what> (ask per_1). Answer with …`, or `asks: <question> (ask frm_1). …`
            var said = rest
            if let cut = said.range(of: " (ask ", options: .backwards) { said = String(said[..<cut.lowerBound]) }
            if said.hasPrefix("asks: ") { said = String(said.dropFirst("asks: ".count)) }
            return SessionNews(session: session, title: title, kind: .asks, said: sentence(said.isEmpty ? "asks something" : said))
        }
    }

    /// Words as a sentence: a capital first, a stop at the end.
    private static func sentence(_ words: String) -> String {
        let trimmed = words.trimmingCharacters(in: .whitespacesAndNewlines)
        let capital = trimmed.prefix(1).uppercased() + trimmed.dropFirst()
        return capital.last.map { ".!?…".contains($0) } == true ? capital : capital + "."
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
