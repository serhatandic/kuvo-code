import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// An MCP server as you set it in Settings › MCP Servers: on the web, and its address. (Its command
/// read as a shell would, and written back so it reads the same: OpenCodeKit's CommandWordsTests.)
@Suite struct MCPCommandTests {
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
        // A name on your network or a container's, with its scheme: as it is.
        #expect(MCPSettings.webAddress("http://homeserver:8080/mcp") == "http://homeserver:8080/mcp")
        #expect(MCPSettings.webAddress("http://LOCALHOST:3000") == "http://LOCALHOST:3000")
        #expect(MCPSettings.webAddress("LOCALHOST:3000") == "http://LOCALHOST:3000")
        #expect(MCPSettings.webAddress("homeserver") == nil, "a word alone isn't taken for one")
    }
}
