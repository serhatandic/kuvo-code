import Foundation
import Testing
@testable import KuvoCode

/// Replying to parts of a message: each part quoted, with your answer under it, sent as Markdown,
/// and back as the same quotes and answers when the message returns to the composer (an undo, a
/// send that didn't go). A quote-looking line in code, or ">>>", is words.
@Suite struct QuotingTests {
    @Test func quotesAndAnswersComeBackAsTheyWere() {
        let quotes = [Drafts.Quote(text: "Use Postgres for the queue?", response: "Yes, with SKIP LOCKED."),
                      Drafts.Quote(text: "Line one\n\nLine three", response: "Both fine.")]
        let message = Quoting.message(quotes: quotes, text: "")
        #expect(message == "> Use Postgres for the queue?\n\nYes, with SKIP LOCKED.\n\n> Line one\n>\n> Line three\n\nBoth fine.")
        let back = Quoting.draft(of: message)
        #expect(back.quotes.map(\.text) == quotes.map(\.text))
        #expect(back.quotes.map(\.response) == quotes.map(\.response))
        #expect(back.text == "")
    }

    /// Your answers to quotes, then words of your own after them (a few paragraphs): the last
    /// answer and your words are each shown as they were written, apart, and come back so.
    @Test func yourWordsAfterTheAnswersStayApart() {
        let quotes = [Drafts.Quote(text: "the terminal didn't die.", response: "there are lots of people still using the terminal."),
                      Drafts.Quote(text: "they were coping mechanisms.", response: "this doesn't even make sense")]
        let main = "I only liked this one and posted it:\n\ncode review didn't die."
        let message = Quoting.message(quotes: quotes, text: main)
        let shown = Quoting.segments(message)
        #expect(shown.map(\.quote) == ["the terminal didn't die.", "they were coping mechanisms.", nil])
        #expect(shown.map(\.text) == ["there are lots of people still using the terminal.", "this doesn't even make sense", main])
        let back = Quoting.draft(of: message)
        #expect(back.quotes.map(\.response) == quotes.map(\.response))
        #expect(back.text == main)
        // A last quote with no answer: your words are its answer, as written.
        let unanswered = Quoting.message(quotes: [Drafts.Quote(text: "the cache", response: "")], text: "Drop it.")
        #expect(unanswered == "> the cache\n\nDrop it.")
        #expect(Quoting.segments(unanswered).map(\.text) == ["Drop it."])
    }

    /// Words before the first quote are the message's own; a message with no quote is all words.
    @Test func wordsBeforeAQuote() {
        let back = Quoting.draft(of: "Two things:\n\n> the cache\n\nDrop it.")
        #expect(back.text == "Two things:")
        #expect(back.quotes.map(\.text) == ["the cache"])
        #expect(back.quotes.map(\.response) == ["Drop it."])
        #expect(Quoting.draft(of: "Just a question").text == "Just a question")
    }

    /// What only looks like a quote is words: in a code block, ">>>", or a ">" inside a line.
    @Test(arguments: ["```\n> not a quote\n```", ">>> python prompt", "a > b and c", "text\n> right after words"])
    func whatOnlyLooksLikeAQuote(message: String) {
        let back = Quoting.draft(of: message)
        #expect(back.quotes.isEmpty)
        #expect(Quoting.words(of: message) == message)
    }

    /// The words a title or a preview takes: without the quotes.
    @Test func theMessagesOwnWords() {
        #expect(Quoting.words(of: "> long quoted text\n\nMy answer") == "My answer")
    }
}
