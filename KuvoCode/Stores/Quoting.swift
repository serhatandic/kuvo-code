import AppKit

/// Replying to a message, or a part of one: what you selected (else the whole message) goes into
/// the composer as a quote, for you to answer under.
enum Quoting {
    /// The text selected in the window, copied as ⌘C would, with your clipboard put back as it
    /// was; nil when nothing's selected.
    static func selection() -> String? {
        // Asked of what holds it, where that can say: copying through the clipboard and putting
        // it back changes it twice, which clipboard histories keep and password managers notice.
        if let responder = NSApp.keyWindow?.firstResponder {
            if let stack = responder as? RowStackView { return trimmed(stack.selectedText()) }
            if let text = responder as? NSTextView, !text.isEditable {
                // One of its own, let go once read: a named one would keep the words readable.
                let board = NSPasteboard.withUniqueName()
                defer { board.releaseGlobally() }
                guard text.writeSelection(to: board, types: [.string]) else { return nil }
                return trimmed(board.string(forType: .string))
            }
        }
        let board = NSPasteboard.general
        let saved = (board.pasteboardItems ?? []).map { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { copy.setData(data, forType: type) }
            }
            return copy
        }
        let before = board.changeCount
        NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: nil)
        guard board.changeCount != before else { return nil }
        let text = board.string(forType: .string)
        board.clearContents()
        if !saved.isEmpty { board.writeObjects(saved) }
        return trimmed(text)
    }

    private static func trimmed(_ text: String?) -> String? {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The message to send: the quote you're replying to, as Markdown, ahead of your words.
    static func message(quote: String?, text: String) -> String {
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
    static func message(quotes: [Drafts.Quote], text: String) -> String {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lastAnswered = quotes.last.map { !$0.response.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? false
        let parts = quotes.flatMap { quote in
            [message(quote: quote.text, text: ""), quote.response.trimmingCharacters(in: .whitespacesAndNewlines)]
        } + (lastAnswered && !words.isEmpty ? [ownWords] : []) + [words]
        return parts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// The line between your answers to quotes and the words after them: a Markdown rule, which
    /// the model reads as a break.
    static let ownWords = "---"

    /// A message as what it quotes and what it says: each quote (lines of "> ", as `message`
    /// writes them, starting the message or after a blank line, and ending at one) with the words
    /// after it, in order; the first part's quote is nil when it starts with words, and so is a
    /// last part of words after an answer (after `ownWords`, after a blank line). Lines in a code
    /// block, or like ">>> x" or a merge marker, are words.
    static func segments(_ message: String) -> [(quote: String?, text: String)] {
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
    static func words(of message: String) -> String {
        segments(message).map(\.text).filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    /// A sent message back as a draft (after an undo, say): its quotes, each with its answer, and
    /// the words that came first or last.
    static func draft(of message: String) -> (quotes: [Drafts.Quote], text: String) {
        var quotes: [Drafts.Quote] = []
        var words: [String] = []
        for segment in segments(message) {
            if let quote = segment.quote { quotes.append(Drafts.Quote(text: quote, response: segment.text)) } else { words.append(segment.text) }
        }
        return (quotes, words.filter { !$0.isEmpty }.joined(separator: "\n\n"))
    }
}
