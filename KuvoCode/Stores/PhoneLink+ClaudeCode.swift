import Foundation
import KuvoLink
import OpenCodeKit

/// Settings › Agents' and Settings › Commands' From Claude Code for a phone, through an older box of
/// this Mac's (PROTOCOL.md, "For released Macs"): the subagents and commands in this Mac's ~/.claude,
/// each with what Import writes in its settings through `kuvo/config`, named, and said to be there,
/// as this Mac's page has them. (Every box lists its own computer's now: `kuvo/claude-code`.)
extension PhoneLink {
    /// COMPAT(0.7 claude-code): this Mac's ~/.claude, read here for an older box. Goes 3 months after 0.8.0.
    /// `folder`: Claude Code's (a test's own).
    func claudeCodeJSON(folder: URL = ClaudeCode.folder) async -> (Int, Data) {
        guard let app = bots?.app else { return (503, Self.message("Kuvo Code isn't ready yet. Try again in a moment.")) }
        let box = SidebarBox.mac
        let (agents, commands) = await Task.detached {
            (ClaudeAgents.load(from: folder.appending(path: "agents")), ClaudeCommands.load(from: folder.appending(path: "commands")))
        }.value
        let config = app.config(for: box)
        let yours = Set(config.value(at: ["commands"])?.object?.keys.map { $0 } ?? [])
        let others = Set(app.catalog(for: box).commands.map(\.name).filter { !yours.contains($0) })
        func entry(name: String, description: String, path: [String], settings: JSONValue) -> [String: Any] {
            let value = (try? JSONEncoder().encode(settings)).flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? [:]
            return ["name": name, "description": description, "path": path, "settings": value, "imported": config.value(at: path) != nil]
        }
        return (200, Self.json([
            "agents": agents.map { entry(name: $0.name, description: $0.description, path: ["agents", $0.id], settings: $0.settings) },
            "commands": commands.map { command in
                let name = ClaudeCommands.importedName(command, others: others)
                return entry(name: name, description: command.description, path: ["commands", name], settings: command.settings)
            },
        ]))
    }
}
