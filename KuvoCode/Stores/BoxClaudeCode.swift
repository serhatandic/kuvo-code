import Foundation
import OpenCodeKit

/// Settings › Agents' and Settings › Commands' From Claude Code on one box's page (PROTOCOL.md,
/// `kuvo/claude-code`): the subagents and commands in that computer's own ~/.claude, as its box lists
/// them, named as they'd come over. Import writes an item's `settings` at its `path` in that box's
/// settings.
struct ClaudeCodeImports: Decodable {
    var agents: [Item] = []
    var commands: [Item] = []

    struct Item: Decodable, Identifiable, Hashable {
        /// An agent's, as it's shown; a command's, the one it comes over as.
        var name: String
        var description: String
        var path: [String]
        var settings: JSONValue
        var id: String { path.joined(separator: ".") }
    }

    /// The list for `box`'s page, as that box lists its computer's own: none while it can't be
    /// read, or from a box from before it listed them (one not updated yet, which updates as this
    /// Mac connects or starts it).
    static func read(for box: BoxClient) async -> ClaudeCodeImports {
        guard let (status, data) = try? await box.send("GET", "kuvo/claude-code"), status == 200 else { return ClaudeCodeImports() }
        return (try? JSONDecoder().decode(ClaudeCodeImports.self, from: data)) ?? ClaudeCodeImports()
    }
}
