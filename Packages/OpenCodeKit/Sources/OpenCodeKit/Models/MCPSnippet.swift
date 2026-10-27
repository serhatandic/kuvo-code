import Foundation

/// An MCP server's setup as its README gives it, read from what you paste into its settings, so
/// they fill in by themselves: Claude Desktop's and Cursor's `mcpServers`, VS Code's `servers`,
/// opencode's own `mcp`, one server's entry alone (named or not, comments and trailing commas
/// allowed), or Claude Code's `claude mcp add` line.
public struct MCPSnippet: Equatable, Sendable {
    /// The server's name, where the snippet gives one.
    public var name: String?
    /// To run on the computer: the command and its arguments, as words.
    public var command: [String] = []
    public var environment: [String: String] = [:]
    /// On the web: its address, and the headers it's sent with.
    public var url: String?
    public var headers: [String: String] = [:]

    public var isRemote: Bool { url != nil }

    public init(name: String? = nil, command: [String] = [], environment: [String: String] = [:], url: String? = nil, headers: [String: String] = [:]) {
        self.name = name
        self.command = command
        self.environment = environment
        self.url = url
        self.headers = headers
    }

    /// The server `text` sets up; nil for anything else (a command line typed as it is, say), or
    /// a snippet with several servers.
    public static func parse(_ text: String) -> MCPSnippet? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("claude mcp add") { return claudeCode(trimmed) }
        guard let first = trimmed.first, first == "{" || first == "\"" else { return nil }
        // `"name": { … }` alone, as READMEs often show one entry: an object of its own.
        let wrapped = first == "\"" ? "{\(trimmed.hasSuffix(",") ? String(trimmed.dropLast()) : trimmed)}" : trimmed
        guard let data = wrapped.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: [.json5Allowed]) as? [String: Any] else { return nil }
        // The servers a settings file lists, under the key each app uses.
        for key in ["mcpServers", "servers", "mcp", "context_servers"] {
            if let servers = object[key] as? [String: Any] {
                guard servers.count == 1, let (name, entry) = servers.first, let server = entry as? [String: Any] else { return nil }
                return Self.server(server, name: name)
            }
        }
        if let server = Self.server(object, name: nil) { return server }
        // One named entry: `{"github": { … }}`.
        guard object.count == 1, let (name, entry) = object.first, let server = entry as? [String: Any] else { return nil }
        return Self.server(server, name: name)
    }

    /// One server's entry: a command (a word and its `args`, or opencode's list of words) or a
    /// URL (`url`, or Windsurf's `serverUrl`).
    private static func server(_ entry: [String: Any], name: String?) -> MCPSnippet? {
        let strings = { (value: Any?) -> [String: String] in (value as? [String: Any])?.compactMapValues { $0 as? String } ?? [:] }
        if let url = (entry["url"] ?? entry["serverUrl"]) as? String, !url.isEmpty {
            return MCPSnippet(name: name, url: url, headers: strings(entry["headers"]))
        }
        var command: [String]
        if let words = entry["command"] as? [String] {
            command = words
        } else if let word = entry["command"] as? String, !word.isEmpty {
            command = [word] + ((entry["args"] as? [Any])?.compactMap { $0 as? String } ?? [])
        } else {
            return nil
        }
        guard !command.isEmpty else { return nil }
        if command.count == 1, command[0].contains(" "), entry["args"] == nil { command = CommandWords.split(command[0]) }
        return MCPSnippet(name: name, command: command, environment: strings(entry["env"] ?? entry["environment"]))
    }

    /// `claude mcp add [options] <name> -- <command…>`, or `claude mcp add --transport http
    /// <name> <url>`: its name, environment (`-e KEY=value`), headers (`-H "Key: value"`) and
    /// what it runs or reaches.
    private static func claudeCode(_ line: String) -> MCPSnippet? {
        let words = Array(CommandWords.split(line).dropFirst(3))
        var snippet = MCPSnippet()
        var remote = false
        var rest: [String] = []
        var index = 0
        while index < words.count {
            let word = words[index]
            if word == "--" {
                snippet.command = Array(words[(index + 1)...])
                break
            }
            let value = index + 1 < words.count ? words[index + 1] : nil
            switch word {
            case "-e", "--env":
                if let pair = value?.split(separator: "=", maxSplits: 1), pair.count == 2 { snippet.environment[String(pair[0])] = String(pair[1]) }
                index += 1
            case "-H", "--header":
                if let pair = value?.split(separator: ":", maxSplits: 1), pair.count == 2 {
                    snippet.headers[String(pair[0]).trimmingCharacters(in: .whitespaces)] = String(pair[1]).trimmingCharacters(in: .whitespaces)
                }
                index += 1
            case "-t", "--transport":
                remote = value == "http" || value == "sse"
                index += 1
            case "-s", "--scope":
                index += 1
            default:
                rest.append(word)
            }
            index += 1
        }
        guard let name = rest.first else { return nil }
        snippet.name = name
        if remote {
            guard rest.count > 1 else { return nil }
            snippet.url = rest[1]
        } else if snippet.command.isEmpty {
            // Without `--`, what follows the name is the command.
            snippet.command = Array(rest.dropFirst())
        }
        return snippet.command.isEmpty && snippet.url == nil ? nil : snippet
    }
}

/// A command line, as an MCP server's settings read and write it, on a Mac and a phone alike.
public enum CommandWords {
    /// A command line's words, as a shell splits them: quotes keep spaces in one word, and a
    /// backslash takes the next character as it is (not inside single quotes; inside double ones,
    /// only before ", \, $ or `, as in "a\.b", a pattern pasted from a README).
    public static func split(_ line: String) -> [String] {
        var words: [String] = []
        var current = ""
        var quote: Character?
        var hasWord = false
        var escaped = false
        for character in line {
            if escaped {
                if quote == "\"", !"\"\\$`".contains(character) { current.append("\\") }
                current.append(character)
                escaped = false
            } else if character == "\\", quote != "'" {
                escaped = true
                hasWord = true
            } else if let open = quote {
                if character == open { quote = nil } else { current.append(character) }
            } else if character == "\"" || character == "'" {
                quote = character
                hasWord = true
            } else if character.isWhitespace {
                if hasWord { words.append(current) }
                current = ""
                hasWord = false
            } else {
                current.append(character)
                hasWord = true
            }
        }
        if hasWord { words.append(current) }
        return words
    }

    /// A word as it can be typed back: in double quotes, with quotes and backslashes escaped,
    /// when it has spaces, quotes or backslashes.
    public static func quoted(_ word: String) -> String {
        guard word.isEmpty || word.contains(where: { $0.isWhitespace || $0 == "\"" || $0 == "'" || $0 == "\\" }) else { return word }
        return "\"" + word.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}
