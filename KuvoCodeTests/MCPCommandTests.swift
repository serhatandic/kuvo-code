import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// An MCP server's command as you type it in Settings › MCP Servers, read as a shell would, and
/// written back so it reads the same.
@Suite struct MCPCommandTests {
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

    /// A server switched to "On the web" is never written without a URL, which the engine doesn't
    /// take; given one, it's on; switched back, its command comes back as it was.
    @Test func aServerOnTheWebIsWrittenOnlyWithItsURL() throws {
        let local: [String: JSONValue] = ["type": .string("local"), "command": .array([.string("files")]), "codemode": .bool(false)]
        #expect(MCPSettings.switched(local, to: "remote", putAside: [:]) == nil, "no URL: nothing written")
        let remote = try #require(MCPSettings.switched(local, to: "remote", putAside: [:], url: "https://example.com/mcp"))
        #expect(remote.settings == ["type": .string("remote"), "url": .string("https://example.com/mcp"), "codemode": .bool(false)])
        let back = try #require(MCPSettings.switched(remote.settings, to: "local", putAside: remote.putAside))
        #expect(back.settings == local)
        // Its URL from before comes back with it.
        #expect(MCPSettings.switched(back.settings, to: "remote", putAside: back.putAside)?.settings["url"] == .string("https://example.com/mcp"))
    }

    /// The address you type for a server on the web, as it's saved: one with its scheme as it is;
    /// without, https (http for this computer's own); one that isn't an address, nothing (what was
    /// there stays).
    @Test func aServersAddressAsItsSaved() {
        #expect(MCPSettings.webAddress("https://mcp.example.com/sse") == "https://mcp.example.com/sse")
        #expect(MCPSettings.webAddress("  mcp.example.com/sse ") == "https://mcp.example.com/sse")
        #expect(MCPSettings.webAddress("localhost:3000/mcp") == "http://localhost:3000/mcp")
        #expect(MCPSettings.webAddress("127.0.0.1:8080") == "http://127.0.0.1:8080")
        #expect(MCPSettings.webAddress("") == nil)
        #expect(MCPSettings.webAddress("not an address") == nil)
        #expect(MCPSettings.webAddress("ftp://example.com") == nil)
    }
}
