import Foundation
import OpenCodeKit

/// What Claude Code keeps in ~/.claude that the engine doesn't read on its own (it does read
/// skills): its subagents and slash commands, to bring over. Each is a Markdown file with a
/// header of fields (a name, a description) and its instructions or prompt.
nonisolated enum ClaudeCode {
    static let folder = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claude")

    /// The header's fields and what comes after it.
    static func parse(_ text: String) -> (fields: [String: String], body: String) {
        guard text.hasPrefix("---"), let end = text.range(of: "\n---", range: text.index(text.startIndex, offsetBy: 3)..<text.endIndex) else {
            return ([:], text.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        var fields: [String: String] = [:]
        let lines = text[text.index(text.startIndex, offsetBy: 3)..<end.lowerBound].components(separatedBy: "\n")
        var index = 0
        while index < lines.count {
            let line = lines[index]
            index += 1
            guard let colon = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces)
            var value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            // A block (| or >): the indented lines after it.
            if ["|", ">", "|-", ">-"].contains(value) {
                var block: [String] = []
                while index < lines.count, lines[index].hasPrefix(" ") || lines[index].isEmpty {
                    block.append(lines[index].trimmingCharacters(in: .whitespaces))
                    index += 1
                }
                value = block.joined(separator: value.hasPrefix("|") ? "\n" : " ").trimmingCharacters(in: .whitespacesAndNewlines)
            }
            fields[key] = unquote(value)
        }
        var body = String(text[end.upperBound...])
        if let newline = body.firstIndex(of: "\n") { body = String(body[body.index(after: newline)...]) }
        return (fields, body.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// A name the engine takes: lowercase, with hyphens for anything else.
    static func id(_ name: String) -> String {
        String(name.lowercased().map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "-" })
    }

    /// The Markdown files in a folder, read. `nested`: in its folders too, each named with them
    /// ("frontend/component" for frontend/component.md), as Claude Code names its commands.
    static func files(in folder: URL, nested: Bool = false) -> [(name: String, text: String)] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        return urls.flatMap { url -> [(name: String, text: String)] in
            if nested, (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true, !url.lastPathComponent.hasPrefix(".") {
                return files(in: url, nested: true).map { (url.lastPathComponent + "/" + $0.name, $0.text) }
            }
            guard url.pathExtension == "md", let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
            return [(url.deletingPathExtension().lastPathComponent, text)]
        }
    }

    private static func unquote(_ text: String) -> String {
        guard text.count >= 2, let first = text.first, first == text.last, first == "\"" || first == "'" else { return text }
        let inner = String(text.dropFirst().dropLast())
        return first == "\"" ? inner.replacingOccurrences(of: "\\\"", with: "\"") : inner.replacingOccurrences(of: "''", with: "'")
    }
}

/// The engine's own agents, on every computer whether its settings name them or not: the ones
/// people pick and hand work to, and the hidden ones that write titles, summaries and compactions.
nonisolated enum BuiltInAgents {
    static let shown = ["build", "plan", "general", "explore"]
    static let hidden: Set = ["compaction", "title", "summary"]

    static func contains(_ id: String) -> Bool { shown.contains(id) || hidden.contains(id) }
}

/// Claude Code's subagents (~/.claude/agents), to bring over as the engine's subagents.
nonisolated enum ClaudeAgents {
    struct Agent: Identifiable, Sendable {
        /// Its name in the engine's settings.
        var id: String
        var name: String
        var description: String
        var instructions: String
    }


    static func load(from folder: URL = ClaudeCode.folder.appending(path: "agents")) -> [Agent] {
        ClaudeCode.files(in: folder).compactMap { parse($0.text, fallbackName: $0.name) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    static func parse(_ text: String, fallbackName: String) -> Agent? {
        let (fields, body) = ClaudeCode.parse(text)
        let name = fields["name"].flatMap { $0.isEmpty ? nil : $0 } ?? fallbackName
        var id = ClaudeCode.id(name)
        guard !id.isEmpty else { return nil }
        // Not in place of one of the engine's own.
        if BuiltInAgents.contains(id) { id += "-claude" }
        // Claude Code writes "\n" for line breaks in a one-line description.
        let description = (fields["description"] ?? "").replacingOccurrences(of: "\\n", with: "\n")
        return Agent(id: id, name: name, description: description, instructions: body)
    }
}

extension ClaudeAgents.Agent {
    /// What Import writes at `agents.<id>` in the engine's settings: a subagent.
    var settings: JSONValue {
        .object(["mode": .string("subagent"), "description": .string(description), "system": .string(instructions)])
    }
}

/// Claude Code's slash commands (~/.claude/commands), to bring over as the engine's. Both fill
/// $ARGUMENTS with what's typed after the name.
nonisolated enum ClaudeCommands {
    struct Command: Identifiable, Sendable {
        var id: String
        var description: String
        var template: String
    }

    /// Those in its folders too, by both names ("frontend-component"): Claude Code's /frontend:component.
    static func load(from folder: URL = ClaudeCode.folder.appending(path: "commands")) -> [Command] {
        ClaudeCode.files(in: folder, nested: true).compactMap { file in
            let (fields, body) = ClaudeCode.parse(file.text)
            let id = ClaudeCode.id(file.name)
            guard !id.isEmpty, !body.isEmpty else { return nil }
            return Command(id: id, description: fields["description"] ?? "", template: body)
        }
        .sorted { $0.id < $1.id }
    }

    /// The engine's own commands, taken also before its list has loaded.
    static let engineOwn: Set<String> = ["init", "review"]

    /// The name `command` comes over as: its own, or with "-claude" where it's one of the
    /// engine's (/init, /review) or another that isn't yours (a plugin's, an MCP server's), which
    /// it would take the place of. `others`: those other commands' names.
    static func importedName(_ command: Command, others: Set<String>) -> String {
        others.contains(command.id) || engineOwn.contains(command.id) ? command.id + "-claude" : command.id
    }
}

extension ClaudeCommands.Command {
    /// What Import writes at `commands.<name>` in the engine's settings.
    var settings: JSONValue {
        .object(["template": .string(template), "description": .string(description)])
    }
}
