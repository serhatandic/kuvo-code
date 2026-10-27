import Testing
@testable import OpenCodeKit

/// What you paste into an MCP server's settings from its README fills them in, in each form READMEs
/// give it; anything else stays what you typed.
struct MCPSnippetTests {
    @Test func claudeDesktopsServerList() {
        let pasted = """
        {
          "mcpServers": {
            "github": {
              "command": "npx",
              "args": ["-y", "@modelcontextprotocol/server-github"],
              "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<YOUR_TOKEN>" }
            }
          }
        }
        """
        #expect(MCPSnippet.parse(pasted) == MCPSnippet(name: "github", command: ["npx", "-y", "@modelcontextprotocol/server-github"], environment: ["GITHUB_PERSONAL_ACCESS_TOKEN": "<YOUR_TOKEN>"]))
    }

    @Test func oneEntryAloneWithATrailingCommaAndAComment() {
        let pasted = """
        "filesystem": {
          // Your folders
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Desktop",],
        },
        """
        #expect(MCPSnippet.parse(pasted) == MCPSnippet(name: "filesystem", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Desktop"]))
    }

    @Test func aServerOnTheWebInVSCodesForm() {
        let pasted = #"{"servers": {"linear": {"type": "http", "url": "https://mcp.linear.app/mcp", "headers": {"Authorization": "Bearer ${input:key}"}}}}"#
        #expect(MCPSnippet.parse(pasted) == MCPSnippet(name: "linear", url: "https://mcp.linear.app/mcp", headers: ["Authorization": "Bearer ${input:key}"]))
        #expect(MCPSnippet.parse(pasted)?.isRemote == true)
    }

    @Test func opencodesOwnFormAndABareEntry() {
        #expect(MCPSnippet.parse(#"{"mcp": {"sentry": {"type": "local", "command": ["uvx", "mcp-server-sentry"], "environment": {"SENTRY_TOKEN": "x"}}}}"#)
            == MCPSnippet(name: "sentry", command: ["uvx", "mcp-server-sentry"], environment: ["SENTRY_TOKEN": "x"]))
        #expect(MCPSnippet.parse(#"{"command": "docker", "args": ["run", "-i", "--rm", "mcp/fetch"]}"#) == MCPSnippet(command: ["docker", "run", "-i", "--rm", "mcp/fetch"]))
        // Windsurf names the address serverUrl.
        #expect(MCPSnippet.parse(#"{"deepwiki": {"serverUrl": "https://mcp.deepwiki.com/sse"}}"#)?.url == "https://mcp.deepwiki.com/sse")
    }

    @Test func claudeCodesAddLine() {
        #expect(MCPSnippet.parse("claude mcp add airtable -e AIRTABLE_API_KEY=key -- npx -y airtable-mcp-server")
            == MCPSnippet(name: "airtable", command: ["npx", "-y", "airtable-mcp-server"], environment: ["AIRTABLE_API_KEY": "key"]))
        #expect(MCPSnippet.parse("claude mcp add --transport http notion https://mcp.notion.com/mcp")
            == MCPSnippet(name: "notion", url: "https://mcp.notion.com/mcp"))
        #expect(MCPSnippet.parse(#"claude mcp add --transport sse asana https://mcp.asana.com/sse -H "Authorization: Bearer t""#)?.headers == ["Authorization": "Bearer t"])
    }

    @Test func claudeCodesLinesAsREADMEsWriteThem() {
        // Carried on over lines with a backslash.
        #expect(MCPSnippet.parse("claude mcp add --transport http \\\n  notion https://mcp.notion.com/mcp") == MCPSnippet(name: "notion", url: "https://mcp.notion.com/mcp"))
        // Options written with =, several keys after one -e, and one left empty to fill in.
        #expect(MCPSnippet.parse("claude mcp add --scope=user -e A=1 B=2 KEY= weather -- uvx weather-mcp")
            == MCPSnippet(name: "weather", command: ["uvx", "weather-mcp"], environment: ["A": "1", "B": "2", "KEY": ""]))
        // add-json: the entry, named.
        #expect(MCPSnippet.parse(#"claude mcp add-json -s user github '{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}'"#)
            == MCPSnippet(name: "github", command: ["npx", "-y", "@modelcontextprotocol/server-github"]))
        #expect(MCPSnippet.parse("claude mcp add-from-claude-desktop") == nil)
    }

    @Test func numbersAndSwitchesAreKeptAsWritten() {
        #expect(MCPSnippet.parse(#"{"api": {"command": "node", "args": ["server.js", "--port", 8080], "env": {"PORT": 8080, "DEBUG": true}}}"#)
            == MCPSnippet(name: "api", command: ["node", "server.js", "--port", "8080"], environment: ["PORT": "8080", "DEBUG": "true"]))
    }

    @Test func severalServersAreAllFoundThoughNoneIsChosen() {
        let pasted = #"{"mcpServers": {"b": {"command": "y"}, "a": {"command": "x"}}}"#
        #expect(MCPSnippet.parse(pasted) == nil)
        #expect(MCPSnippet.all(pasted).map(\.name) == ["a", "b"])
    }

    @Test func whatIsntASnippetStaysAsTyped() {
        #expect(MCPSnippet.parse("npx -y @acme/server") == nil)
        #expect(MCPSnippet.parse("{ not json") == nil)
        // Several servers at once: which one is meant isn't clear.
        #expect(MCPSnippet.parse(#"{"mcpServers": {"a": {"command": "x"}, "b": {"command": "y"}}}"#) == nil)
        #expect(MCPSnippet.parse(#"{"name": "nothing to run"}"#) == nil)
    }
}
