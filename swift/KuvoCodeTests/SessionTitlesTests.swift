import ClientSessions
import Foundation
import Testing
@testable import KuvoCode

/// A new session's title, until a model names it: your first words, to the end of the first
/// sentence or about 48 characters, without the comments and files the app added; and a model's
/// title as you'd write it.
@Suite struct SessionTitlesTests {
    @Test(arguments: [
        ("Fix the login bug. Then deploy it to staging and tell me.", "Fix the login bug"),
        ("Update README.md with the new install steps for macOS users please", "Update README.md with the new install steps for…"),
        ("Hi", "Hi"),
        ("Check   the\n\nlogs", "Check the logs"),
        ("Why? It broke after the last change", "Why? It broke after the last change"),
    ])
    func fromYourFirstWords(message: String, title: String) {
        #expect(Workspace.title(from: MessageParts(words: message)) == title)
    }

    /// Only comments on the changes: the first comment names it. Its files never do.
    @Test func fromACommentWhenThereAreNoWords() {
        let comment = MessageParts.Comment(file: "a.swift", line: 1, side: .new, snippet: "x", text: "Rename this variable")
        #expect(Workspace.title(from: MessageParts(words: "", comments: [comment])) == "Rename this variable")
        #expect(Workspace.title(from: MessageParts(words: "Look at this log", paths: ["/x/log.txt"])) == "Look at this log")
        #expect(Workspace.title(from: MessageParts(words: "", paths: ["/x/log.txt"])) == nil)
    }

    @Test(arguments: [
        ("\"Fix login redirect.\"", "Fix login redirect"),
        ("Title: Deploy to staging", "Deploy to staging"),
        ("**Refactor the parser**\nThis conversation is about…", "Refactor the parser"),
        ("\n\n  Weekly report  \n", "Weekly report"),
        ("# Release notes", "Release notes"),
    ])
    func aModelsTitleAsYoudWriteIt(answer: String, title: String) {
        #expect(Workspace.cleanTitle(answer) == title)
    }

    @Test func anEmptyAnswerIsNoTitle() {
        #expect(Workspace.cleanTitle("  \n \"\" ") == nil)
        #expect((Workspace.cleanTitle(String(repeating: "word ", count: 40)) ?? "").count <= 80)
    }
}
