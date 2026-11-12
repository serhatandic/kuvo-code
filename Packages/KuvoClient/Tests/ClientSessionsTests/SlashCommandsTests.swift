import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// "/" at the start of a message runs a command: the list as you type its name, best matches
/// first; a message that names one runs it with the rest as its arguments, and one that only starts
/// with "/" (a path) is sent as written. (Which of the list Return picks, with the composer's
/// keywords in it, is each app's: the Mac's SlashItemTests.)
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
