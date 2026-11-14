import Foundation
import Testing
@testable import KuvoCode

/// What every call of an agent carries of Kuvo Code's own tools (#213): their names, descriptions and
/// arguments, and the instructions that come with them. Each agent kind has a budget, the size these
/// came to once trimmed and a little more, so they can't creep back unnoticed. The box's own words
/// (its vault and sandbox tools, the sandbox note, what a bot is told) are held to theirs in
/// Packages/Box/test/agents/tool-copy-budget.test.ts. Tokens are counted as a UTF-8 byte in four.
///
/// Grown past one on purpose? Trim something else first; if it can't be, raise that budget here and
/// say why in the commit.
@MainActor
struct ToolCopyBudgetTests {
    private func tokens(_ text: String) -> Int { (text.utf8.count + 3) / 4 }

    @Test func whatEachAgentKindCarriesOfKuvoCodesToolsStaysWithinItsBudget() throws {
        // The most any agent is given: every tool, the vault's fills among them, and the longer
        // instructions (this Mac's or a machine's), with the vault's line.
        let tools = BrowserTools.definitions
        // Each as a model gets it, under the server's name; and only their names, as Claude Code
        // lists a deferred one until it looks it up.
        let asModelsSee = tools.map { ["name": "kuvo-browser_" + ($0["name"] as? String ?? ""), "description": $0["description"] ?? "", "input_schema": $0["inputSchema"] ?? [:]] }
        let schemas = String(decoding: try JSONSerialization.data(withJSONObject: asModelsSee, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
        let names = tools.map { "mcp__kuvo-browser__" + ($0["name"] as? String ?? "") }.joined(separator: "\n")
        let instructions = [true, false].map { BrowserTools.instructions(machine: $0, vault: true) }.max { $0.utf8.count < $1.utf8.count } ?? ""

        // The engine sends every schema and the server's instructions with each call, as Codex does
        // and (as far as is known) Cursor, Grok and Antigravity. Claude Code defers the schemas behind
        // its tool search, on by default; where it's off (models before Opus 4 and Sonnet 4,
        // ENABLE_TOOL_SEARCH set to false or auto, experimental betas turned off), it sends them all,
        // as the others do.
        let carried = [
            "the engine, Codex, Cursor, Grok and Antigravity": tokens(schemas) + tokens(instructions),
            "Claude Code": tokens(names) + tokens(instructions),
        ]
        let budget = [
            "the engine, Codex, Cursor, Grok and Antigravity": 9_400,
            "Claude Code": 1_600,
        ]
        for (kind, limit) in budget {
            let size = try #require(carried[kind])
            #expect(size <= limit, "\(kind) carries \(size) tokens of Kuvo Code's tools on every call, past its budget of \(limit)")
        }
    }
}
