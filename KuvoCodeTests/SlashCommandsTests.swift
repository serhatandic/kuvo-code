import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// "/" at the start of a message runs a command: the list as you type its name, best matches
/// first; a message that names one runs it with the rest as its arguments, and one that only starts
/// with "/" (a path) is sent as written.
@Suite struct SlashCommandsTests {
    let commands = ["review", "init", "preview-deploy", "compact"].map { name in
        try! JSONDecoder().decode(Command.self, from: Data(#"{"name":"\#(name)"}"#.utf8))
    }

    @Test func theNameBeingTyped() {
        #expect(SlashCommands.query(in: "/rev") == "rev")
        #expect(SlashCommands.query(in: "/") == "")
        #expect(SlashCommands.query(in: "/review main") == nil)
        #expect(SlashCommands.query(in: "fix /tmp") == nil)
    }

    @Test func namesStartingWithItFirst() {
        #expect(SlashCommands.matches("rev", in: commands).map(\.name) == ["review", "preview-deploy"])
        #expect(SlashCommands.matches("", in: commands).map(\.name) == ["compact", "init", "preview-deploy", "review"])
    }

    /// A project's command typed in full is what Return picks, though a keyword has its name
    /// inside (/review has "view"; /goal starts with "go") and is listed first.
    @MainActor @Test func aCommandTypedInFullIsPickedOverAKeywordThatHasItsName() throws {
        let own = try ["view", "go"].map { try JSONDecoder().decode(Command.self, from: Data(#"{"name":"\#($0)"}"#.utf8)) }
        for name in ["view", "go"] {
            let items = SlashItem.matches(name, keywords: Keyword.allCases, commands: own)
            #expect(items[SlashItem.chosen(name, in: items)] == .command(own.first { $0.name == name }!), "\(name)")
        }
        // Half typed, the first as before.
        let items = SlashItem.matches("vi", keywords: Keyword.allCases, commands: own)
        #expect(SlashItem.chosen("vi", in: items) == 0)
    }

    @Test func aMessageThatRunsOne() throws {
        let run = try #require(SlashCommands.parse("  /review main --strict\n", commands: commands))
        #expect(run.name == "review")
        #expect(run.arguments == "main --strict")
        #expect(SlashCommands.parse("/init", commands: commands)?.arguments == "")
    }

    /// A path, or a command there isn't: the message as written.
    @Test(arguments: ["/usr/bin/env is broken", "/nonexistent do it", "/ alone", "review it"])
    func aMessageThatDoesnt(text: String) {
        #expect(SlashCommands.parse(text, commands: commands) == nil)
    }
}
