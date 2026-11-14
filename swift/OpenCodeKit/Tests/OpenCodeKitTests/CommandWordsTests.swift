import Testing
import OpenCodeKit

/// An MCP server's command as you type it in Settings › MCP Servers, read as a shell would, and
/// written back so it reads the same.
@Suite struct CommandWordsTests {
    @Test(arguments: [
        ("npx -y @acme/server --root \"/Users/me/My Projects\"", ["npx", "-y", "@acme/server", "--root", "/Users/me/My Projects"]),
        ("grep --pattern \"a\\.b\" 'it''s'", ["grep", "--pattern", "a\\.b", "its"]),
        ("echo \"say \\\"hi\\\"\" back\\ slash", ["echo", "say \"hi\"", "back slash"]),
        ("cmd ''  \"\"", ["cmd", "", ""]),
        ("node 'C:\\path\\x'", ["node", "C:\\path\\x"]),
    ])
    func readAsAShellWould(line: String, words: [String]) {
        #expect(CommandWords.split(line) == words)
    }

    /// Written back, a command reads as the same words.
    @Test(arguments: [["npx", "-y", "@acme/server"], ["run", "two words", "it's", "a\\.b", "say \"hi\"", ""]])
    func writtenBackItReadsTheSame(words: [String]) {
        #expect(CommandWords.split(words.map(CommandWords.quoted).joined(separator: " ")) == words)
    }
}
