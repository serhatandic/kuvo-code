import Foundation
import Testing
@testable import KuvoCode

/// A message you send goes to the agent with what the app adds to it (the agents you named with
/// &, your comments on the changes, the note of attached files), and comes back from the engine
/// that way. Wherever it shows again (its bubble, Edit, the export, a title), it's what you wrote,
/// with its comments and files as cards.
@MainActor
@Suite struct SentMessageTests {
    let comments = [
        ReviewComment(file: "Sources/App.swift", line: 124, side: .new, snippet: "let limit = 10", text: "Make this configurable."),
        ReviewComment(file: "notes.md", line: 3, side: .old, snippet: "- old step", text: "Why did this go?\nIt was the only place that said so."),
    ]

    /// As the composer sends it: the words with the named agents' block, then the comments, then
    /// the note of files (SessionModel.send).
    private func sent(_ words: String, comments: [ReviewComment] = [], prepared: Attachments.Prepared = .init(), agents: [AgentMail.Agent] = []) -> String {
        var text = words
        if let note = AgentReferences.note(naming: agents, here: nil) { text += "\n\n" + note }
        return Attachments.text(ReviewComments.text(text, adding: comments), for: prepared)
    }

    @Test func wordsCommentsAndFilesComeBackAsWritten() {
        var prepared = Attachments.Prepared()
        prepared.included = ["/tmp/a/screenshot.png"]
        prepared.paths = ["/Users/me/Desktop/big-archive.zip"]
        prepared.unsent = ["/Users/me/secret.key"]
        let words = "Please fix the limit.\n\nAlso check the notes."
        let back = SentMessage.split(sent(words, comments: comments, prepared: prepared))
        #expect(back.text == words)
        #expect(back.comments.map(\.location) == ["Sources/App.swift:124", "notes.md:3 (removed)"])
        #expect(back.comments.map(\.snippet) == ["let limit = 10", "- old step"])
        #expect(back.comments.map(\.text) == comments.map(\.text))
        // The files sent with the message are its own; those sent as paths, or left behind, are named.
        #expect(back.paths == ["/Users/me/Desktop/big-archive.zip", "/Users/me/secret.key"])
    }

    /// Text you paste that looks like the app's blocks (a message copied from another chat, a
    /// closing tag) stays your words, and isn't read as comments or files.
    @Test func pastedTagsStayWords() {
        let copied = """
        Here's what the other session got:

        <review-comments>
        Comments on lines of the current changes:

        [b.swift:10]
        > let x = 1
        Rename this.
        </review-comments>
        """
        let back = SentMessage.split(sent(copied))
        #expect(back.comments.isEmpty)
        #expect(back.text.contains("[b.swift:10]"))
        #expect(back.text.contains("Rename this."))

        let withFiles = SentMessage.split(sent("The tag is </attached-files>", prepared: { var p = Attachments.Prepared(); p.paths = ["/x/y.txt"]; return p }()))
        #expect(withFiles.text == "The tag is </attached-files>")
        #expect(withFiles.paths == ["/x/y.txt"])
    }

    /// A comment's own lines that look like a comment's start are part of it.
    @Test func aCommentQuotingAnotherLocationStaysWhole() {
        let comment = ReviewComment(file: "a.swift", line: 1, side: .new, snippet: "import Foo", text: "Like in\n[b.swift:10]\nabove.")
        let back = SentMessage.split(sent("See comments", comments: [comment]))
        #expect(back.comments.count == 1)
        #expect(back.comments.first?.text == "Like in\n[b.swift:10]\nabove.")
    }

    @Test func onlyFilesHasNoWords() {
        var prepared = Attachments.Prepared()
        prepared.paths = ["/x/report.pdf"]
        let back = SentMessage.split(sent("", prepared: prepared))
        #expect(back.text == "")
        #expect(back.paths == ["/x/report.pdf"])
    }

    /// The agents named with & come back as references, with the words as written, ahead of the
    /// comments and files.
    @Test func namedAgentsComeBack() {
        let agents = [AgentMail.Agent(session: "ses_abc123", name: "Ada Lovelace", kind: "bot", about: "Reviews math"),
                      AgentMail.Agent(session: "ses_def456", name: "Build (main)", kind: "session", project: "kuvo")]
        let words = "Ask &Ada Lovelace and &Build (main) about it"
        var prepared = Attachments.Prepared()
        prepared.paths = ["/x/log.txt"]
        let back = SentMessage.split(sent(words, comments: [comments[0]], prepared: prepared, agents: agents))
        #expect(back.text == words)
        #expect(back.references == [.init(name: "Ada Lovelace", session: "ses_abc123"), .init(name: "Build (main)", session: "ses_def456")])
        #expect(back.comments.count == 1)
        #expect(back.paths == ["/x/log.txt"])
        #expect(SentMessage.words(of: sent(words, agents: agents)) == words)
    }

    /// A plain message is left alone.
    @Test func plainMessageIsUntouched() {
        let words = "Just a question: what does `<named-agents>` do?"
        #expect(SentMessage.split(sent(words)).text == words)
        #expect(SentMessage.split(words).references.isEmpty)
    }

    /// What you click in a widget goes to the agent naming the widget it came from, and your
    /// bubble shows your words with the widget over them.
    @Test func whatAWidgetSendsNamesTheWidget() {
        let answer = WidgetAnswer.message("Show it in minutes", from: "Build times\nthis week")
        #expect(answer.contains("<from-widget>") && answer.contains("Build times this week"))
        let back = SentMessage.split(answer)
        #expect(back.text == "Show it in minutes")
        #expect(SentMessage.widget(of: answer) == "Build times this week")
        // One without a title is still from a widget.
        #expect(SentMessage.widget(of: WidgetAnswer.message("Yes", from: nil)) == "")
        #expect(WidgetAnswer.name("") == "Made for you")
        // Its title names no agents, whatever it says; its words still can.
        let mira = AgentMail.Agent(session: "ses_mira", name: "Mira", kind: "bot", about: "Plans")
        #expect(AgentReferences.named(in: [WidgetAnswer.message("A", from: "Ask &Mira")], agents: [mira]).isEmpty)
        #expect(AgentReferences.named(in: [WidgetAnswer.message("Ask &Mira", from: "Plans")], agents: [mira]).map(\.session) == ["ses_mira"])
        // What you typed yourself isn't, even naming the tag.
        let typed = "What does <from-widget> do?"
        #expect(SentMessage.split(sent(typed)).text == typed)
        #expect(SentMessage.widget(of: typed) == nil)
    }
}
