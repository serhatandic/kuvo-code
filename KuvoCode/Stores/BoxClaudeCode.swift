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

    /// The list for `box`'s page, as that box lists its computer's own, or none while it can't be
    /// read. `others`: the commands that box's engine has that aren't yours, for an older box.
    static func read(for box: BoxClient, others: Set<String>) async -> ClaudeCodeImports {
        guard let (status, data) = try? await box.send("GET", "kuvo/claude-code") else { return ClaudeCodeImports() }
        if status == 200 { return (try? JSONDecoder().decode(ClaudeCodeImports.self, from: data)) ?? ClaudeCodeImports() }
        // A machine's box from before it listed them has none to offer: never this Mac's in their
        // place (it updates as this Mac connects).
        guard status == 404, box.box == BoxClient.mac else { return ClaudeCodeImports() }
        // COMPAT(0.7 claude-code): this Mac's own box from before it listed them (a keeper's, still running), so this Mac's ~/.claude read here. Goes 3 months after 0.8.0.
        let (agents, commands) = await Task.detached { (ClaudeAgents.load(), ClaudeCommands.load()) }.value
        return ClaudeCodeImports(agents: agents, commands: commands, others: others)
    }

    /// This Mac's ~/.claude, as read here, named as the app names them.
    private init(agents: [ClaudeAgents.Agent], commands: [ClaudeCommands.Command], others: Set<String>) {
        self.agents = agents.map { Item(name: $0.name, description: $0.description, path: ["agents", $0.id], settings: $0.settings) }
        self.commands = commands.map { command in
            let name = ClaudeCommands.importedName(command, others: others)
            return Item(name: name, description: command.description, path: ["commands", name], settings: command.settings)
        }
    }

    init() {}
}
