import Foundation
import KuvoLink
import OpenCodeKit

/// Settings › Agents' and Settings › Commands' From Claude Code for a phone (PROTOCOL.md,
/// `kuvo/claude-code`): the subagents and commands in this Mac's ~/.claude, each with what Import
/// writes in a computer's settings, through `kuvo/config` (this Mac's, or a machine's): named,
/// and said to be there, as that computer's page has them.
extension PhoneLink {
    /// `machine`: the computer it's for (nil, this Mac). `folder`: Claude Code's (a test's own).
    func claudeCodeJSON(for machine: String? = nil, folder: URL = ClaudeCode.folder) async -> (Int, Data) {
        guard let app = bots?.app else { return (503, Self.message("Kuvo Code isn't ready yet. Try again in a moment.")) }
        let box = SidebarBox(machine: machine)
        if let machine, app.machines.engine(machine) == nil { return (404, Data("{}".utf8)) }
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
