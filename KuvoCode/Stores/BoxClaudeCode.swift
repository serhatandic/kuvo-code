import Foundation
import OpenCodeKit

/// Settings › Agents' and Settings › Commands' From Claude Code on one box's page (PROTOCOL.md,
/// `kuvo/claude-code`): the subagents and commands in this Mac's ~/.claude, as its box lists them,
/// named as they'd come over. Import writes an item's `settings` at its `path` in that box's
/// settings.
nonisolated struct ClaudeCodeImports: Decodable, Sendable {
    var agents: [Item] = []
    var commands: [Item] = []

    struct Item: Decodable, Identifiable, Hashable, Sendable {
        /// An agent's, as it's shown; a command's, the one it comes over as.
        var name: String
        var description: String
        var path: [String]
        var settings: JSONValue
        var id: String { path.joined(separator: ".") }
    }

    /// The list for `box`'s page, or none while it can't be read. This Mac's, as its box lists it.
    /// `others`: the commands that box's engine has that aren't yours, for what the app reads itself.
    static func read(for box: BoxClient, others: Set<String>) async -> ClaudeCodeImports {
        if box.box == BoxClient.mac {
            guard let (status, data) = try? await box.send("GET", "kuvo/claude-code") else { return ClaudeCodeImports() }
            if status == 200 { return (try? JSONDecoder().decode(ClaudeCodeImports.self, from: data)) ?? ClaudeCodeImports() }
            // Old-box path: a box from before it listed them (a route it doesn't have) gets them as
            // the app read them itself. Goes once no box is older.
            guard status == 404 else { return ClaudeCodeImports() }
        }
        // A machine's page offers this Mac's commands, as it always has, though its box lists its
        // own: which computer's ~/.claude a machine's page offers is the user's to decide (#341).
        return await Task.detached { ClaudeCodeImports(here: box.box == BoxClient.mac, others: others) }.value
    }

    /// This Mac's ~/.claude, read here: its agents on this Mac's page only.
    private init(here isMac: Bool, others: Set<String>) {
        agents = isMac ? ClaudeAgents.load().map { Item(name: $0.name, description: $0.description, path: ["agents", $0.id], settings: $0.settings) } : []
        commands = ClaudeCommands.load().map { command in
            let name = ClaudeCommands.importedName(command, others: others)
            return Item(name: name, description: command.description, path: ["commands", name], settings: command.settings)
        }
    }

    init() {}
}
