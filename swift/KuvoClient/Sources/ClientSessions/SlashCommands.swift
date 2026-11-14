import Foundation
import OpenCodeKit

/// "/" at the start of a message runs one of the engine's commands ("/init", "/review main"),
/// or a project's own, read the same in both apps.
public enum SlashCommands {
    /// The command name being typed: what follows a "/" that starts the message, until a space.
    public static func query(in text: String) -> String? {
        guard text.hasPrefix("/"), !text.contains(where: \.isWhitespace) else { return nil }
        return String(text.dropFirst())
    }

    /// Names starting with `query` first, then names containing it.
    public static func matches(_ query: String, in commands: [Command]) -> [Command] {
        let query = query.lowercased()
        let starting = commands.filter { $0.name.lowercased().hasPrefix(query) }
        let containing = commands.filter { !$0.name.lowercased().hasPrefix(query) && $0.name.lowercased().contains(query) }
        return (starting + containing).sorted { ($0.name.lowercased().hasPrefix(query) ? 0 : 1, $0.name) < ($1.name.lowercased().hasPrefix(query) ? 0 : 1, $1.name) }
    }

    /// A message that runs one of `commands`: "/review main" is ("review", "main").
    public static func parse(_ text: String, commands: [Command]) -> (name: String, arguments: String)? {
        guard let (name, arguments) = split(text), commands.contains(where: { $0.name == name }) else { return nil }
        return (name, arguments)
    }

    /// "/name arguments", whatever the name.
    public static func split(_ text: String) -> (name: String, arguments: String)? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix("/") else { return nil }
        let body = text.dropFirst()
        let name = body.prefix { !$0.isWhitespace }
        guard !name.isEmpty else { return nil }
        return (String(name), body.dropFirst(name.count).trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
