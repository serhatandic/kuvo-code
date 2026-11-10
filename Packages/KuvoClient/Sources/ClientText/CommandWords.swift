import Foundation

/// A shell command in a few words, as a line about it says it ("heavy.sh phone", "swift test",
/// "npm run build"), the same in both apps: what it runs, not the `cd`, the variables, the
/// `timeout` around it or what reads its output. A command whose every part is one of those says
/// its first part.
public enum CommandWords {
    /// At most this many characters.
    static let longest = 40

    public static func short(_ command: String) -> String {
        let line = command.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let part = chosen(segments(of: line).map(program).filter { !$0.isEmpty })
        guard let name = part.first else { return line.trimmingCharacters(in: .whitespaces) }
        var words = [name]
        // What it's asked to do: the next word or two, never an option or where its output goes.
        let takes = twoWords.contains(name) ? 2 : 1
        for word in part.dropFirst().prefix(takes) {
            guard !word.hasPrefix("-"), !word.contains(">"), !word.contains("<"), !word.contains("=") else { break }
            words.append(shortened(word))
        }
        let said = words.joined(separator: " ")
        return said.count > longest ? String(said.prefix(longest - 1)) + "…" : said
    }

    // Parts that only set up for the work or read what it printed.
    private static let quiet: Set<String> = [
        "cd", "pushd", "popd", "rm", "mkdir", "cp", "mv", "touch", "export", "set", "unset", "source", ".", "echo", "printf",
        "sleep", "true", "false", "cat", "ls", "head", "tail", "grep", "egrep", "rg", "wc", "sort", "uniq", "tee", "tr", "cut",
        "awk", "sed", "test", "[", "exit", "wait", "kill", "date", "pwd", "which",
    ]
    // Ones whose first word is only "run" or "exec": the next says what.
    private static let twoWords: Set<String> = ["npm", "pnpm", "yarn", "bun", "npx", "uv", "uvx", "cargo", "go", "docker", "kubectl"]
    // What runs another command: the command it runs is the one.
    private static let wrappers: Set<String> = ["timeout", "gtimeout", "nice", "nohup", "env", "time", "exec", "command", "sudo", "caffeinate", "xcrun"]
    private static let shells: Set<String> = ["sh", "bash", "zsh"]

    /// The part that does the work: the first that isn't only setting up or reading output.
    private static func chosen(_ parts: [[String]]) -> [String] {
        parts.first { !quiet.contains($0[0]) } ?? parts.first ?? []
    }

    /// A path as its last part: "../kuvo-ai/scripts/heavy.sh" is "heavy.sh".
    private static func shortened(_ word: String) -> String {
        guard word.contains("/") else { return word }
        let trimmed = word.hasSuffix("/") ? String(word.dropLast()) : word
        return trimmed.split(separator: "/").last.map(String.init) ?? word
    }

    /// The line's parts, split where `&&`, `||`, `;` or `|` end one, outside quotes.
    private static func segments(of line: String) -> [[String]] {
        var segments: [[String]] = [[]]
        var word = ""
        var quote: Character?
        var escaped = false
        let chars = Array(line)
        var index = 0
        func endWord() {
            if !word.isEmpty { segments[segments.count - 1].append(word) }
            word = ""
        }
        while index < chars.count {
            let char = chars[index]
            defer { index += 1 }
            if escaped { word.append(char); escaped = false; continue }
            if char == "\\" && quote != "'" { escaped = true; continue }
            if let open = quote {
                if char == open { quote = nil } else { word.append(char) }
                continue
            }
            switch char {
            case "\"", "'": quote = char
            case " ", "\t": endWord()
            case ";", "|", "&":
                // ">&1", "2>&1": where output goes, not a new part.
                if char == "&", word.hasSuffix(">") { word.append(char); continue }
                if char == "&", index + 1 < chars.count, chars[index + 1] == ">" { word.append(char); continue }
                endWord()
                if index + 1 < chars.count, chars[index + 1] == char { index += 1 }
                if !(segments.last?.isEmpty ?? true) { segments.append([]) }
            default: word.append(char)
            }
        }
        endWord()
        return segments.filter { !$0.isEmpty }
    }

    /// A part's words from the program it runs: no variables set before it, no wrappers, a script
    /// run by its shell as the script.
    private static func program(_ words: [String]) -> [String] {
        var rest = ArraySlice(words)
        while let first = rest.first {
            if first.range(of: #"^[A-Za-z_][A-Za-z0-9_]*="#, options: .regularExpression) != nil {
                rest = rest.dropFirst()
            } else if wrappers.contains(shortened(first)) {
                let wrapper = shortened(first)
                rest = rest.dropFirst()
                // Its own options (and theirs), then a timeout's length.
                while let option = rest.first, option.hasPrefix("-") {
                    rest = rest.dropFirst()
                    if ["-k", "-s", "-n", "-u"].contains(option), !rest.isEmpty { rest = rest.dropFirst() }
                }
                if wrapper == "timeout" || wrapper == "gtimeout", let length = rest.first, length.first?.isNumber == true { rest = rest.dropFirst() }
            } else if shells.contains(shortened(first)), rest.dropFirst().first == "-c", let inner = rest.dropFirst(2).first {
                // `sh -c "…"`: what it runs.
                return chosen(segments(of: inner).map(program).filter { !$0.isEmpty })
            } else if shells.contains(shortened(first)), rest.dropFirst().first.map({ !$0.hasPrefix("-") }) == true {
                rest = rest.dropFirst()
            } else {
                break
            }
        }
        guard let first = rest.first else { return [] }
        return [shortened(first)] + rest.dropFirst()
    }
}
