import Foundation

/// Something you're replying to, with your answer under it.
public struct Quote: Codable, Hashable, Identifiable, Sendable {
    public var id = UUID()
    public var text: String
    public var response = ""

    public init(id: UUID = UUID(), text: String, response: String = "") {
        self.id = id
        self.text = text
        self.response = response
    }
}

/// Replying to a message, or a part of one, the same in both apps (the Mac also reads what's
/// selected in its window, `Quoting.selection()`): the same Markdown, so a reply written on the
/// phone shows its quotes on the Mac, and the other way round.
public enum Quoting {
    /// The message to send: the quote you're replying to, as Markdown, ahead of your words.
    public static func message(quote: String?, text: String) -> String {
        guard let quote, !quote.isEmpty else { return text }
        let block = quote.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.isEmpty ? ">" : "> " + $0 }
            .joined(separator: "\n")
        return block + "\n\n" + text
    }

    /// The message to send: each quote you're replying to, as Markdown, with your answer to it
    /// under it, then the rest of your words: after a line of their own (`ownWords`) when the last
    /// quote has an answer, so the two stay apart; as its answer when it has none.
    public static func message(quotes: [Quote], text: String) -> String {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lastAnswered = quotes.last.map { !$0.response.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? false
        let parts = quotes.flatMap { quote in
            [message(quote: quote.text, text: ""), quote.response.trimmingCharacters(in: .whitespacesAndNewlines)]
        } + (lastAnswered && !words.isEmpty ? [ownWords] : []) + [words]
        return parts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// The line between your answers to quotes and the words after them: a Markdown rule, which
    /// the model reads as a break.
    public static let ownWords = "---"

    /// A message as what it quotes and what it says: each quote (lines of "> ", as `message`
    /// writes them, starting the message or after a blank line, and ending at one) with the words
    /// after it, in order; the first part's quote is nil when it starts with words, and so is a
    /// last part of words after an answer (after `ownWords`, after a blank line). Lines in a code
    /// block, or like ">>> x" or a merge marker, are words.
    public static func segments(_ message: String) -> [(quote: String?, text: String)] {
        var segments: [(quote: String?, text: String)] = []
        var quote: [String]?
        var words: [String] = []
        func close() {
            let text = words.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            let quoted = quote?.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !(quoted ?? "").isEmpty || !text.isEmpty { segments.append(((quoted ?? "").isEmpty ? nil : quoted, text)) }
            quote = nil
            words = []
        }
        var inCode = false
        var previousBlank = true
        var quoting = false
        for line in message.split(separator: "\n", omittingEmptySubsequences: false) {
            let isQuoteLine = !inCode && (line == ">" || line.hasPrefix("> "))
            if line.hasPrefix("```") { inCode.toggle() }
            if isQuoteLine && (quoting || previousBlank) {
                // A quote starting: the part before is done.
                if !quoting { close() }
                quoting = true
                quote = (quote ?? []) + [line == ">" ? "" : String(line.dropFirst(2))]
            } else if !inCode, line == ownWords, previousBlank, quote != nil, !quoting {
                // The end of the answers: the words after are the message's own.
                close()
            } else {
                // Anything else ends a quote; the words after it are its answer.
                quoting = false
                words.append(String(line))
            }
            previousBlank = line.trimmingCharacters(in: .whitespaces).isEmpty
        }
        close()
        return segments.isEmpty ? [(nil, message)] : segments
    }

    /// A message's own words, without what it quotes.
    public static func words(of message: String) -> String {
        segments(message).map(\.text).filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// A sent message back as a draft (after an undo, say): its quotes, each with its answer, and
    /// the words that came first or last.
    public static func draft(of message: String) -> (quotes: [Quote], text: String) {
        var quotes: [Quote] = []
        var words: [String] = []
        for segment in segments(message) {
            if let quote = segment.quote { quotes.append(Quote(text: quote, response: segment.text)) } else { words.append(segment.text) }
        }
        return (quotes, words.filter { !$0.isEmpty }.joined(separator: "\n\n"))
    }
}
