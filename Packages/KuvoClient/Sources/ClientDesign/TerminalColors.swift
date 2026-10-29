import SwiftUI

/// A command's output colored as a terminal shows it, in the code palette: a search's files, line
/// numbers and what it found; a diff's added and removed lines; errors and warnings. Everything
/// else stays as it was printed.
@MainActor
public enum TerminalColors {
    public static func colored(_ text: String, command: String, dark: Bool) -> AttributedString {
        var hasher = Hasher()
        hasher.combine(text)
        hasher.combine(command)
        hasher.combine(dark)
        let key = hasher.finalize()
        if let cached = cache[key] { return cached }
        let result = color(text, command: command, dark: dark)
        // A few outputs at a time are open; the oldest go.
        if cache.count >= 48 { cache.removeAll(keepingCapacity: true) }
        cache[key] = result
        return result
    }

    private static var cache: [Int: AttributedString] = [:]

    private static func color(_ text: String, command: String, dark: Bool) -> AttributedString {
        var result = AttributedString(text)
        let source = text as NSString
        func paint(_ range: NSRange, _ type: String, bold: Bool = false) {
            guard range.length > 0, let span = Range(range, in: result) else { return }
            if let color = CodeColors.color(for: type, dark: dark) { result[span].foregroundColor = color }
            if bold { result[span].inlinePresentationIntent = .stronglyEmphasized }
        }
        var lines: [NSRange] = []
        source.enumerateSubstrings(in: NSRange(location: 0, length: source.length), options: [.byLines, .substringNotRequired]) { _, range, _, _ in
            lines.append(range)
        }
        let isDiff = command.range(of: #"(^|[\s|;&(])(git\s+(diff|show|log\s.*-p|stash\s+show)|diff)\s"#, options: .regularExpression) != nil
            || text.hasPrefix("diff --git ") || text.contains("\ndiff --git ")
        let isSearch = isSearch(command)
        let search = isSearch ? pattern(in: command) : nil
        var found = 0
        func line(_ index: Int) -> String { source.substring(with: lines[index]) }
        /// The number a line under a file starts with ("12:" or "12-").
        func number(_ index: Int) -> Int? {
            let text = line(index)
            guard let match = numbered.firstMatch(in: text, range: NSRange(location: 0, length: lines[index].length)) else { return nil }
            return Int((text as NSString).substring(with: match.range(at: 1)))
        }
        // The files the results name ("path:12:"), for telling "path-12-" from a dash in a name.
        var files: Set<String> = []
        if isSearch {
            for index in lines.indices.prefix(5000) {
                let text = line(index)
                if let match = named.firstMatch(in: text, range: NSRange(location: 0, length: lines[index].length)) {
                    files.insert((text as NSString).substring(with: match.range(at: 1)))
                }
            }
        }
        // A file over its lines: first, or after a blank line, with a line of its under it
        // ("12:", not "path:12:"), and not itself one ("10-" then "11:", as grep prints a file's).
        func isHeading(at index: Int) -> Bool {
            guard index + 1 < lines.count, index == 0 || lines[index - 1].length == 0 else { return false }
            let text = line(index)
            guard !text.isEmpty, !text.hasPrefix(" "), Self.located(text, files: files)?.file == nil,
                  let under = Self.located(line(index + 1), files: files), under.file == nil,
                  let next = number(index + 1) else { return false }
            return number(index).map { $0 != next - 1 } ?? true
        }
        for (index, range) in lines.enumerated() {
            let line = source.substring(with: range)
            if isDiff {
                if line.hasPrefix("diff --git ") || line.hasPrefix("commit ") { paint(range, "keyword", bold: true); continue }
                if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("index ") { paint(range, "comment"); continue }
                if line.hasPrefix("@@") { paint(range, "class-name"); continue }
                if line.hasPrefix("+") { paint(range, "inserted"); continue }
                if line.hasPrefix("-") { paint(range, "deleted"); continue }
            }
            if isSearch {
                // The file over its lines (rg's headings); "path:12:text", "path-12-text" for a
                // line around a match, and "12:text" under a file; what it looked for, in what
                // each line says.
                if isHeading(at: index) {
                    paint(range, "keyword", bold: true)
                    continue
                }
                var textStart = 0
                if let spot = located(line, files: files) {
                    if let file = spot.file { paint(NSRange(location: range.location + file.location, length: file.length), "keyword") }
                    paint(NSRange(location: range.location + spot.number.location, length: spot.number.length), "number")
                    textStart = spot.end
                }
                if let search, found < 2000 {
                    // The start of a long line is enough to show where it matched.
                    let span = NSRange(location: textStart, length: min(range.length - textStart, 1000))
                    for hit in search.matches(in: line, range: span) where hit.range.length > 0 {
                        paint(NSRange(location: range.location + hit.range.location, length: hit.range.length), "string", bold: true)
                        found += 1
                    }
                }
                continue
            }
            if line.range(of: #"^(error|fatal|panic)\b|\berror(\[\w+\])?:"#, options: [.regularExpression, .caseInsensitive]) != nil {
                paint(range, "deleted")
            } else if line.range(of: #"^warning\b|\bwarning:"#, options: [.regularExpression, .caseInsensitive]) != nil {
                paint(range, "number")
            }
        }
        return result
    }

    /// "path:12:" or "path:12:3:": a file's line that matched.
    private static let named = try! NSRegularExpression(pattern: #"^([^\s:][^:\n]*?):(\d+):(?:\d+:)?"#)
    /// A line of a search's results under its file: "12:text", "12:3:text" or "12-text".
    private static let numbered = try! NSRegularExpression(pattern: #"^(\d+)(?::(?:\d+:)?|-)"#)
    /// A line number between dashes, "-12-", where a file's name could end.
    private static let contextNumber = try! NSRegularExpression(pattern: #"-(\d+)(?=-)"#)

    /// Where a line of a search's results says its file and line are: "path:12:", "path-12-" for a
    /// file the results name, or "12:" alone. `end` is where what the line says starts.
    private static func located(_ line: String, files: Set<String>) -> (file: NSRange?, number: NSRange, end: Int)? {
        let whole = NSRange(location: 0, length: (line as NSString).length)
        if let match = named.firstMatch(in: line, range: whole) {
            return (match.range(at: 1), match.range(at: 2), match.range.length)
        }
        // "path-12-": a file named before, as long a name as fits ("2026-10-20.sql-12-"). Each
        // "-12-" in the line is a place it could end; the text before it is looked up, so a long
        // search's thousands of lines don't each go through every file.
        if !files.isEmpty {
            var best: NSTextCheckingResult?
            for match in contextNumber.matches(in: line, range: whole) where match.range.location > 0 {
                if files.contains((line as NSString).substring(to: match.range.location)) { best = match }
            }
            if let best {
                return (NSRange(location: 0, length: best.range.location), best.range(at: 1), best.range.location + best.range.length + 1)
            }
        }
        if let match = numbered.firstMatch(in: line, range: whole) {
            return (nil, match.range(at: 1), match.range.length)
        }
        return nil
    }

    private static func isSearch(_ command: String) -> Bool {
        command.range(of: #"(^|[\s|;&(])(rg|grep|egrep|fgrep|ag|git\s+grep)\s"#, options: .regularExpression) != nil
    }

    /// What a search looks for, from its command: `-e PATTERN` or its first word that isn't an
    /// option (nor an option's value), as a regular expression the way it reads it. None for a
    /// search that prints what doesn't match (-v), nor for a pattern that could take this Mac long to
    /// try on every line (a repeated group) or that grep reads its own way (`\(`, `\|`).
    static func pattern(in command: String) -> NSRegularExpression? {
        guard let start = command.range(of: #"(^|[\s|;&(])(rg|grep|egrep|fgrep|ag|git\s+grep)\s"#, options: .regularExpression) else { return nil }
        let words = shellWords(command[start.upperBound...])
        let takesValue: Set<String> = ["-g", "--glob", "-t", "--type", "-T", "--type-not", "-A", "-B", "-C", "-m", "--max-count", "-f", "--file", "--include", "--exclude", "-d", "--max-depth"]
        var found: String?
        var flags: Set<String> = []
        var index = 0
        // Its options, before the pattern and after it, up to `--` (after which the pattern is
        // the next word, even one starting with -).
        var readsOptions = true
        while index < words.count {
            let word = words[index]
            index += 1
            if readsOptions, word == "--" { readsOptions = false; continue }
            if readsOptions, word == "-e" || word == "--regexp" {
                if index < words.count, found == nil { found = words[index] }
                index += 1
            } else if readsOptions, word.hasPrefix("--regexp=") {
                if found == nil { found = String(word.dropFirst("--regexp=".count)) }
            } else if readsOptions, word.hasPrefix("-") && word.count > 1 {
                flags.insert(word)
                if takesValue.contains(word) { index += 1 }
            } else if found == nil {
                found = word
            }
        }
        guard let found, !found.isEmpty else { return nil }
        if flags.contains(where: { $0 == "--invert-match" || (!$0.hasPrefix("--") && $0.contains("v")) }) { return nil }
        let extended = command.range(of: #"(^|[\s|;&(])(rg|egrep|ag)\s"#, options: .regularExpression) != nil
            || flags.contains { $0 == "-E" || $0 == "-P" || $0 == "--extended-regexp" || $0 == "--perl-regexp" }
        if found.range(of: #"\)[*+?{]"#, options: .regularExpression) != nil { return nil }
        if !extended, found.range(of: #"\\[(|{+?]"#, options: .regularExpression) != nil { return nil }
        let fixed = flags.contains { $0 == "-F" || $0 == "--fixed-strings" || ($0.hasPrefix("-") && !$0.hasPrefix("--") && $0.contains("F")) } || command.contains("fgrep")
        let caseless = flags.contains { $0 == "-i" || $0 == "--ignore-case" || ($0.hasPrefix("-") && !$0.hasPrefix("--") && $0.contains("i")) }
            || (flags.contains { $0 == "-S" || $0 == "--smart-case" } && found == found.lowercased())
        let options: NSRegularExpression.Options = caseless ? [.caseInsensitive] : []
        if !fixed, let expression = try? NSRegularExpression(pattern: found, options: options) { return expression }
        return try? NSRegularExpression(pattern: NSRegularExpression.escapedPattern(for: found), options: options)
    }

    /// A command line's words, as a shell splits them (quotes kept together, backslashes taken), up
    /// to where the command ends: a pipe, `;`, `&` or `)` outside quotes.
    private static func shellWords(_ line: Substring) -> [String] {
        var words: [String] = []
        var word = ""
        var quote: Character?
        var inWord = false
        var escaped = false
        for character in line {
            if escaped { word.append(character); escaped = false; continue }
            if character == "\\" && quote != "'" { escaped = true; inWord = true; continue }
            if let open = quote {
                if character == open { quote = nil } else { word.append(character) }
                continue
            }
            if character == "'" || character == "\"" { quote = character; inWord = true; continue }
            if "|;&)".contains(character) { break }
            if character.isWhitespace {
                if inWord { words.append(word); word = ""; inWord = false }
                continue
            }
            word.append(character)
            inWord = true
        }
        if inWord { words.append(word) }
        return words
    }
}
